const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require("electron");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const {
  initAutoUpdater,
  checkForUpdates,
  quitAndInstall,
  getVersion,
} = require("./updater.cjs");

const isDev = !app.isPackaged;
const DEV_URL = process.env.CMAE_DEV_URL || "http://127.0.0.1:3000";

/** Application menu without Toggle Developer Tools (macOS + Windows). */
function installAppMenu() {
  const viewSubmenu = [
    { role: "reload" },
    { role: "forceReload" },
    { type: "separator" },
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" },
    { type: "separator" },
    { role: "togglefullscreen" },
  ];

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { label: "View", submenu: viewSubmenu },
    { role: "windowMenu" },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Block common DevTools accelerators even if a role slips through. */
function blockDevToolsShortcuts(webContents) {
  webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;

    const key = String(input.key || "").toLowerCase();
    const code = String(input.code || "").toLowerCase();
    const isF12 = key === "f12" || code === "f12";
    const isI = key === "i" || code === "keyi";
    const isJ = key === "j" || code === "keyj";
    const isC = key === "c" || code === "keyc";
    const isU = key === "u" || code === "keyu";

    // F12
    if (isF12) {
      event.preventDefault();
      return;
    }

    // Ctrl+Shift+I / Cmd+Option+I (and J/C variants), Ctrl+U / Cmd+U
    const mod =
      process.platform === "darwin"
        ? input.meta && input.alt
        : input.control && input.shift;
    if (mod && (isI || isJ || isC)) {
      event.preventDefault();
      return;
    }

    const viewSource =
      process.platform === "darwin" ? input.meta && isU : input.control && isU;
    if (viewSource && !input.alt && !input.shift) {
      event.preventDefault();
    }
  });
}

/** @type {import('child_process').ChildProcess | null} */
let serverProcess = null;
/** @type {BrowserWindow | null} */
let mainWindow = null;
/** Port of the running production Next server (packaged only). */
let serverPort = null;
/** Master key used for the current production server env. */
let serverMasterKey = null;
/** Restart the production server at most once after an unexpected exit. */
let serverRestartUsed = false;
/** True while we intentionally stop the server (quit / uninstall). */
let serverStopping = false;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else if (serverProcess && serverPort) {
      createWindow(`http://127.0.0.1:${serverPort}/`).catch((err) => {
        console.error(err);
      });
    }
  });
}

/**
 * Per-OS user data (never hardcoded to a username):
 * - macOS: ~/Library/Application Support/<app>
 * - Windows: %APPDATA%\\<app>
 * - Linux: ~/.config/<app>
 * Electron resolves the current account; we inject it as CMAE_USER_DATA for Next.
 */
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
  serverStopping = true;
  if (serverProcess && !serverProcess.killed) {
    try {
      serverProcess.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  serverProcess = null;
  serverPort = null;
}

ipcMain.handle("cmae:uninstall", async () => {
  stopServer();
  scheduleUninstallCleanup();
  // exit immediately so locks on db / userData release before rm
  setTimeout(() => app.exit(0), 150);
  return { ok: true };
});

ipcMain.handle("cmae:get-version", async () => getVersion());

ipcMain.handle("cmae:open-external", async (_event, url) => {
  const target = String(url || "").trim();
  if (!/^https?:\/\//i.test(target)) {
    return { ok: false, error: "invalid-url" };
  }
  await shell.openExternal(target);
  return { ok: true };
});

ipcMain.handle("cmae:check-updates", async () => checkForUpdates());

ipcMain.handle("cmae:quit-and-install", async () => quitAndInstall());

function broadcastUpdateEvent(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("cmae:update-event", payload);
  }
}

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
  serverStopping = false;
  serverPort = port;
  serverMasterKey = masterKey;

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
    const wasStopping = serverStopping;
    serverProcess = null;
    if (wasStopping || isDev) return;

    if (!serverRestartUsed && serverPort && serverMasterKey) {
      serverRestartUsed = true;
      const port = serverPort;
      const key = serverMasterKey;
      console.error("[next] restarting server once after unexpected exit");
      try {
        startProductionServer(port, key);
        waitForServer(port)
          .then(() => {
            dialog.showMessageBox({
              type: "warning",
              title: "CMAE",
              message: "The local server restarted after a crash.",
              detail:
                "If the window looks stuck, use View → Reload. If problems continue, quit and reopen CMAE.",
            });
            if (BrowserWindow.getAllWindows().length === 0) {
              return createWindow(`http://127.0.0.1:${port}/`);
            }
          })
          .catch((err) => {
            console.error(err);
            dialog.showErrorBox(
              "CMAE server failed",
              err instanceof Error ? err.message : String(err),
            );
          });
      } catch (err) {
        console.error(err);
        dialog.showErrorBox(
          "CMAE server failed",
          err instanceof Error ? err.message : String(err),
        );
      }
      return;
    }

    dialog.showErrorBox(
      "CMAE server stopped",
      `The local server exited (code=${code}, signal=${signal}). Quit and reopen CMAE.`,
    );
  });
}

function isProductionServerRunning() {
  return Boolean(serverProcess && !serverProcess.killed && serverPort);
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
      // All builds (dev + packaged), macOS + Windows
      devTools: false,
    },
  });

  blockDevToolsShortcuts(mainWindow.webContents);

  // Only http(s) — about:blank from popup-blocker workarounds must not hit
  // shell.openExternal (Windows has no handler for the about: protocol).
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(String(target || ""))) {
      void shell.openExternal(target);
    }
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  return mainWindow.loadURL(url);
}

function writeStickyAppRoot(root) {
  try {
    const home = process.env.HOME || require("os").homedir();
    fs.writeFileSync(path.join(home, ".cmae-app-root"), `${root}\n`, "utf8");
  } catch {
    /* ignore */
  }
}

async function boot() {
  const masterKey = ensureMasterKey();
  const dataRoot = userDataRoot();
  process.env.CMAE_USER_DATA = dataRoot;
  process.env.CMAE_MASTER_KEY = masterKey;
  writeStickyAppRoot(dataRoot);

  if (isDev) {
    await createWindow(DEV_URL);
    return;
  }

  // Server already running (e.g. macOS activate after closing the window) —
  // only recreate the window; never spawn a second Next process on the same DB.
  if (isProductionServerRunning()) {
    await createWindow(`http://127.0.0.1:${serverPort}/`);
    return;
  }

  const port = await getFreePort();
  startProductionServer(port, masterKey);
  await waitForServer(port);
  await createWindow(`http://127.0.0.1:${port}/`);
}

if (gotSingleInstanceLock) {
  app.whenReady().then(() => {
    installAppMenu();
    initAutoUpdater(broadcastUpdateEvent);
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
}

app.on("before-quit", () => {
  stopServer();
});
