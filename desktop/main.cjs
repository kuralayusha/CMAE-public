const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");

const isDev = !app.isPackaged;
const DEV_URL = process.env.CMAE_DEV_URL || "http://127.0.0.1:3000";

/** @type {import('child_process').ChildProcess | null} */
let serverProcess = null;
/** @type {BrowserWindow | null} */
let mainWindow = null;

function userDataRoot() {
  return app.getPath("userData");
}

/** Packaged .app bundle path (…/CMAE.app). Null in unpackaged / non-mac. */
function packagedAppBundlePath() {
  if (!app.isPackaged || process.platform !== "darwin") return null;
  const bundle = path.resolve(process.execPath, "..", "..", "..");
  if (!bundle.endsWith(".app")) return null;
  // Never delete the project tree if someone runs a packaged build from dist-desktop
  // while developing — still OK to remove that copy of the .app; just never touch *.dmg.
  return bundle;
}

/** Packaged install folder on Windows (directory containing CMAE.exe). */
function packagedWinInstallDir() {
  if (!app.isPackaged || process.platform !== "win32") return null;
  return path.dirname(process.execPath);
}

/**
 * After quit: remove userData (+ optional app install). Does not touch any .dmg/.exe installer.
 */
function scheduleUninstallCleanup() {
  const roots = new Set([userDataRoot()]);
  const envData = process.env.CMAE_USER_DATA?.trim();
  if (envData) roots.add(path.resolve(envData));

  if (process.platform === "win32") {
    const installDir = packagedWinInstallDir();
    const paths = [...roots];
    if (installDir) paths.push(installDir);
    const rmLines = paths
      .filter(Boolean)
      .map((p) => `rmdir /s /q "${String(p).replace(/"/g, "")}"`)
      .join("\r\n");
    const script = `@echo off\r\ntimeout /t 1 /nobreak >nul\r\n${rmLines}\r\n`;
    const tmp = path.join(
      app.getPath("temp"),
      `cmae-uninstall-${Date.now()}.bat`,
    );
    fs.writeFileSync(tmp, script, { encoding: "utf8" });
    const child = spawn("cmd.exe", ["/c", tmp], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return;
  }

  const appBundle = packagedAppBundlePath();
  const rmLines = [...roots]
    .filter(Boolean)
    .map((p) => `rm -rf ${JSON.stringify(p)}`)
    .join("\n");
  const appLine = appBundle ? `rm -rf ${JSON.stringify(appBundle)}` : "";

  const script = `#!/bin/sh
sleep 1
${rmLines}
${appLine}
`;
  const tmp = path.join(app.getPath("temp"), `cmae-uninstall-${Date.now()}.sh`);
  fs.writeFileSync(tmp, script, { encoding: "utf8", mode: 0o700 });
  const child = spawn("/bin/sh", [tmp], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function stopServer() {
  if (serverProcess && !serverProcess.killed) {
    try {
      serverProcess.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    serverProcess = null;
  }
}

ipcMain.handle("cmae:uninstall", async () => {
  stopServer();
  scheduleUninstallCleanup();
  // exit immediately so locks on db / userData release before rm
  setTimeout(() => app.exit(0), 150);
  return { ok: true };
});

function ensureMasterKey() {
  const keyPath = path.join(userDataRoot(), "master.key");
  if (fs.existsSync(keyPath)) {
    const existing = fs.readFileSync(keyPath, "utf8").trim();
    if (existing.length >= 16) return existing;
  }
  const key = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(userDataRoot(), { recursive: true });
  fs.writeFileSync(keyPath, key, { encoding: "utf8", mode: 0o600 });
  return key;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Could not allocate port"));
        return;
      }
      const { port } = addr;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on("error", reject);
  });
}

function waitForServer(port, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/", timeout: 2000 },
        (res) => {
          res.resume();
          resolve();
        },
      );
      req.on("error", () => {
        if (Date.now() > deadline) {
          reject(new Error("Next server did not become ready in time"));
          return;
        }
        setTimeout(tryOnce, 400);
      });
      req.on("timeout", () => {
        req.destroy();
      });
    };
    tryOnce();
  });
}

function standaloneDir() {
  if (isDev) {
    return path.join(__dirname, "..", ".next", "standalone");
  }
  return path.join(process.resourcesPath, "standalone");
}

function nodeBinary() {
  if (isDev) {
    return process.env.npm_node_execpath || "node";
  }
  const name = process.platform === "win32" ? "node.exe" : "node";
  return path.join(process.resourcesPath, name);
}

/**
 * Env for the packaged Next server.
 * Do NOT inherit developer secrets (.env / shell CURSOR_API_KEY, etc.)
 * so local DMG builds always behave like a clean install for testers.
 */
function buildProductionServerEnv(port, masterKey) {
  const keepExact = new Set([
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "HOME",
    "USERPROFILE",
    "USER",
    "USERNAME",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "SystemRoot",
    "APPDIR",
  ]);

  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value == null || value === "") continue;
    if (keepExact.has(key) || key.startsWith("LC_")) {
      env[key] = value;
    }
  }

  env.NODE_ENV = "production";
  env.PORT = String(port);
  env.HOSTNAME = "127.0.0.1";
  env.CMAE_USER_DATA = userDataRoot();
  env.CMAE_MASTER_KEY = masterKey;
  // Explicitly absent: CURSOR_API_KEY, CMAE_I18N_URL, project .env vars
  return env;
}

function startProductionServer(port, masterKey) {
  const root = standaloneDir();
  const serverJs = path.join(root, "server.js");
  if (!fs.existsSync(serverJs)) {
    throw new Error(`Standalone server missing: ${serverJs}`);
  }

  const nodeBin = nodeBinary();
  if (!isDev && !fs.existsSync(nodeBin)) {
    throw new Error(`Bundled Node binary missing: ${nodeBin}`);
  }

  const env = buildProductionServerEnv(port, masterKey);

  serverProcess = spawn(nodeBin, [serverJs], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  serverProcess.stdout?.on("data", (chunk) => {
    console.log(`[next] ${String(chunk).trimEnd()}`);
  });
  serverProcess.stderr?.on("data", (chunk) => {
    console.error(`[next] ${String(chunk).trimEnd()}`);
  });
  serverProcess.on("exit", (code, signal) => {
    console.error(`[next] exited code=${code} signal=${signal}`);
    serverProcess = null;
  });
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: "CMAE",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  return mainWindow.loadURL(url);
}

async function boot() {
  const masterKey = ensureMasterKey();
  process.env.CMAE_USER_DATA = userDataRoot();
  process.env.CMAE_MASTER_KEY = masterKey;

  if (isDev) {
    await createWindow(DEV_URL);
    return;
  }

  const port = await getFreePort();
  startProductionServer(port, masterKey);
  await waitForServer(port);
  await createWindow(`http://127.0.0.1:${port}/`);
}

app.whenReady().then(() => {
  boot().catch((err) => {
    console.error(err);
    dialog.showErrorBox(
      "CMAE failed to start",
      err instanceof Error ? err.message : String(err),
    );
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    boot().catch((err) => {
      console.error(err);
      dialog.showErrorBox(
        "CMAE failed to start",
        err instanceof Error ? err.message : String(err),
      );
    });
  }
});

app.on("before-quit", () => {
  stopServer();
});
