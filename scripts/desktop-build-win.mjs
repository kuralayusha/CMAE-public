#!/usr/bin/env node
/**
 * Local Windows desktop build (always win-x64 artefacts).
 *
 * On ARM64 Windows the system Node is often arm64; prepare-desktop and the
 * public release EXE require x64. This script downloads a portable Node
 * win-x64 under %LOCALAPPDATA%\node-win-x64 and re-runs itself with that
 * binary when needed.
 *
 * Usage:
 *   node scripts/desktop-build-win.mjs
 *   node scripts/desktop-build-win.mjs --upload
 *
 * npm:  desktop:build:win | desktop:publish:win
 */
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "fs";
import http from "http";
import https from "https";
import path from "path";
import { pipeline } from "stream/promises";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const self = fileURLToPath(import.meta.url);
const upload =
  process.argv.includes("--upload") ||
  process.env.CMAE_WIN_UPLOAD === "1" ||
  process.env.CMAE_WIN_UPLOAD === "true";

/** Portable Node used for win-x64 packaging (matches CI Node 22). */
const BUNDLE_NODE_VERSION =
  process.env.CMAE_WIN_NODE_VERSION ||
  process.env.CMAE_BUNDLE_NODE_VERSION ||
  "22.23.2";

const nodeHome = path.join(
  process.env.LOCALAPPDATA || path.join(root, ".tools"),
  "node-win-x64",
  `node-v${BUNDLE_NODE_VERSION}-win-x64`,
);
const nodeX64 = path.join(nodeHome, "node.exe");
const npmCli = path.join(nodeHome, "node_modules", "npm", "bin", "npm-cli.js");

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: node scripts/desktop-build-win.mjs [--upload]

  (default)  Build win-x64 NSIS → dist-desktop/CMAE-*-win-x64.exe
  --upload   After build, upload to kuralayusha/cmae-releases (needs gh auth)

Portable Node (ARM64 hosts): %LOCALAPPDATA%\\node-win-x64\\node-v${BUNDLE_NODE_VERSION}-win-x64\\
Override version: CMAE_WIN_NODE_VERSION=22.23.2

npm:  desktop:build:win | desktop:publish:win`);
  process.exit(0);
}

function fail(msg) {
  console.error(`[desktop-build-win] ${msg}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    env: opts.env || process.env,
    shell: opts.shell ?? false,
  });
  if (result.status !== 0) {
    fail(`${cmd} ${args.join(" ")} exited ${result.status ?? result.signal}`);
  }
}

function download(url) {
  return new Promise((resolve, reject) => {
    const get = url.startsWith("http://") ? http.get : https.get;
    get(url, (res) => {
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        res.resume();
        download(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`Download failed ${res.statusCode}: ${url}`));
        res.resume();
        return;
      }
      resolve(res);
    }).on("error", reject);
  });
}

async function ensureNodeX64() {
  if (existsSync(nodeX64) && existsSync(npmCli)) {
    const probe = spawnSync(nodeX64, ["-p", "process.arch"], {
      encoding: "utf8",
    });
    if (probe.status === 0 && String(probe.stdout).trim() === "x64") {
      console.log(`[desktop-build-win] using ${nodeX64}`);
      return;
    }
  }

  const archiveName = `node-v${BUNDLE_NODE_VERSION}-win-x64.zip`;
  const url = `https://nodejs.org/dist/v${BUNDLE_NODE_VERSION}/${archiveName}`;
  const parent = path.dirname(nodeHome);
  const archivePath = path.join(parent, archiveName);
  mkdirSync(parent, { recursive: true });
  rmSync(nodeHome, { recursive: true, force: true });

  console.log(`[desktop-build-win] downloading ${url}`);
  const res = await download(url);
  await pipeline(res, createWriteStream(archivePath));

  // Prefer tar (Windows 10+); fall back to PowerShell Expand-Archive.
  const tar = spawnSync(
    "tar",
    ["-xf", archivePath, "-C", parent],
    { encoding: "utf8" },
  );
  if (tar.status !== 0) {
    const ps = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${parent.replace(/'/g, "''")}' -Force`,
      ],
      { encoding: "utf8" },
    );
    if (ps.status !== 0) {
      fail(
        `Could not extract Node zip (tar/PowerShell failed). Extract manually to ${nodeHome}`,
      );
    }
  }

  rmSync(archivePath, { force: true });
  if (!existsSync(nodeX64)) {
    fail(`Expected ${nodeX64} after extract`);
  }
  console.log(`[desktop-build-win] installed portable Node → ${nodeHome}`);
}

function x64Env() {
  return {
    ...process.env,
    Path: `${nodeHome};${process.env.Path || process.env.PATH || ""}`,
    PATH: `${nodeHome};${process.env.PATH || process.env.Path || ""}`,
    // prepare-desktop bundles the same major when unset
    CMAE_BUNDLE_NODE_VERSION:
      process.env.CMAE_BUNDLE_NODE_VERSION || BUNDLE_NODE_VERSION,
  };
}

function npmArgs(npmScriptArgs) {
  return [npmCli, ...npmScriptArgs];
}

async function main() {
  if (process.platform !== "win32") {
    fail("Windows desktop build must run on Windows");
  }

  // Re-exec under win-x64 Node when the current process is not x64.
  if (process.arch !== "x64") {
    await ensureNodeX64();
    console.log(
      `[desktop-build-win] re-exec under x64 Node (was ${process.arch})`,
    );
    const args = [self, ...process.argv.slice(2)];
    const result = spawnSync(nodeX64, args, {
      cwd: root,
      stdio: "inherit",
      env: x64Env(),
    });
    process.exit(result.status ?? 1);
  }

  // Already x64 — still prefer portable Node if present so PATH is stable.
  if (existsSync(nodeX64)) {
    const env = x64Env();
    const which = spawnSync(nodeX64, ["-p", "process.arch+' '+process.version"], {
      encoding: "utf8",
      env,
    });
    console.log(
      `[desktop-build-win] node ${String(which.stdout || "").trim()}`,
    );
  } else {
    console.log(
      `[desktop-build-win] node ${process.arch} ${process.version} (system)`,
    );
  }

  const env = existsSync(nodeX64) ? x64Env() : process.env;
  const nodeBin = existsSync(nodeX64) ? nodeX64 : process.execPath;

  // Ensure win32-x64 canvas optional package is present for prepare-desktop.
  const canvasPkg = path.join(
    root,
    "node_modules",
    "@napi-rs",
    "canvas-win32-x64-msvc",
  );
  if (!existsSync(canvasPkg)) {
    let canvasSpec = "@napi-rs/canvas-win32-x64-msvc";
    try {
      const canvasMeta = JSON.parse(
        readFileSync(
          path.join(root, "node_modules", "@napi-rs", "canvas", "package.json"),
          "utf8",
        ),
      );
      const ver =
        canvasMeta.optionalDependencies?.["@napi-rs/canvas-win32-x64-msvc"];
      if (ver) canvasSpec = `@napi-rs/canvas-win32-x64-msvc@${ver}`;
    } catch {
      /* use unpinned */
    }
    console.log(`[desktop-build-win] installing ${canvasSpec}`);
    if (existsSync(npmCli)) {
      run(nodeBin, npmArgs(["install", canvasSpec, "--no-save"]), { env });
    } else {
      run("npm", ["install", canvasSpec, "--no-save"], { env, shell: true });
    }
  }

  // Rebuild native addon for this Node ABI / arch.
  console.log("[desktop-build-win] npm rebuild better-sqlite3");
  if (existsSync(npmCli)) {
    run(nodeBin, npmArgs(["rebuild", "better-sqlite3"]), { env });
  } else {
    run("npm", ["rebuild", "better-sqlite3"], { env, shell: true });
  }

  console.log("[desktop-build-win] next build");
  if (existsSync(npmCli)) {
    run(nodeBin, npmArgs(["run", "build"]), { env });
  } else {
    run("npm", ["run", "build"], { env, shell: true });
  }

  console.log("[desktop-build-win] desktop:prepare");
  if (existsSync(npmCli)) {
    run(nodeBin, npmArgs(["run", "desktop:prepare"]), { env });
  } else {
    run("npm", ["run", "desktop:prepare"], { env, shell: true });
  }

  console.log("[desktop-build-win] electron-builder --win");
  const eb = path.join(
    root,
    "node_modules",
    "electron-builder",
    "cli.js",
  );
  if (!existsSync(eb)) fail(`electron-builder missing: ${eb}`);
  run(
    nodeBin,
    [
      eb,
      "--win",
      "--config",
      "electron-builder.yml",
      "--publish",
      "never",
    ],
    { env },
  );

  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const version = String(pkg.version).replace(/^v/i, "");
  const exe = path.join(root, "dist-desktop", `CMAE-${version}-win-x64.exe`);
  if (!existsSync(exe)) {
    fail(`Expected artefact missing: ${exe}`);
  }
  console.log(`[desktop-build-win] ok → ${exe}`);

  if (upload) {
    console.log("[desktop-build-win] uploading to cmae-releases…");
    run(nodeBin, [
      path.join(root, "scripts", "upload-desktop-github.mjs"),
      "--platform",
      "win",
    ], { env });
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
