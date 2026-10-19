#!/usr/bin/env node
/**
 * Local macOS desktop build.
 *
 * Default: unsigned (`mac.identity: null` — no accidental Apple Development sign).
 * Signed:  `--sign` or `CMAE_MAC_SIGN=1` — temp config without identity:null,
 *          keychain Developer ID + optional notarize via APPLE_* env.
 *
 * Usage:
 *   node scripts/desktop-build-mac.mjs
 *   node scripts/desktop-build-mac.mjs --sign
 *   CMAE_MAC_SIGN=1 npm run desktop:build:mac
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { homedir, tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builderYml = path.join(root, "electron-builder.yml");
const distDesktop = path.join(root, "dist-desktop");
// iCloud-synced folders (e.g. ~/Desktop) keep re-adding FinderInfo/fileprovider
// xattrs to the .app, which codesign rejects. Package outside iCloud.
const buildOut = path.join(homedir(), "Library", "Caches", "cmae-desktop-build");

/**
 * Old packaged trees + Finder “foo 2.ts” copies under .next poison `next build` tsc.
 */
function scrubStaleDesktopOut() {
  for (const name of [
    "dist-desktop",
    "desktop-resources",
    "desktop-pack",
    ".next",
  ]) {
    const p = path.join(root, name);
    if (!existsSync(p)) continue;
    console.log(`[desktop-build-mac] removing stale ${name}/`);
    rmSync(p, { recursive: true, force: true });
  }
  rmSync(buildOut, { recursive: true, force: true });
}

function copyArtefactsBack() {
  mkdirSync(distDesktop, { recursive: true });
  for (const name of readdirSync(buildOut)) {
    const src = path.join(buildOut, name);
    if (!statSync(src).isFile()) continue;
    copyFileSync(src, path.join(distDesktop, name));
  }
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: node scripts/desktop-build-mac.mjs [--sign]

  (default)  Unsigned DMG/ZIP (mac.identity: null)
  --sign     Developer ID from keychain + notarize if APPLE_* set
  env        CMAE_MAC_SIGN=1 same as --sign

npm:  desktop:build:mac | desktop:build:mac:signed
      desktop:publish:mac | desktop:publish:mac:signed`);
  process.exit(0);
}

const sign =
  process.argv.includes("--sign") ||
  process.argv.includes("--signed") ||
  process.env.CMAE_MAC_SIGN === "1" ||
  process.env.CMAE_MAC_SIGN === "true";

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}

loadEnvFile(path.join(root, ".env.local"));
loadEnvFile(path.join(root, ".env"));

function run(cmd, args, env = process.env) {
  const result = spawnSync(cmd, args, {
    cwd: root,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function hasDeveloperId() {
  const result = spawnSync(
    "security",
    ["find-identity", "-v", "-p", "codesigning"],
    { encoding: "utf8", env: process.env },
  );
  const out = `${result.stdout || ""}${result.stderr || ""}`;
  return /Developer ID Application/i.test(out);
}

function writeSignedConfig() {
  const raw = readFileSync(builderYml, "utf8");
  const stripped = raw.replace(/^[ \t]*identity:\s*null[ \t]*\r?\n/m, "");
  if (stripped === raw) {
    console.log(
      "[desktop-build-mac] electron-builder.yml has no identity: null — using as-is",
    );
  }
  const dir = mkdtempSync(path.join(tmpdir(), "cmae-eb-"));
  const cfg = path.join(dir, "electron-builder.yml");
  writeFileSync(cfg, stripped, "utf8");
  return { dir, cfg };
}

console.log(
  sign
    ? "[desktop-build-mac] mode: SIGNED (+ notarize if APPLE_* set)"
    : "[desktop-build-mac] mode: UNSIGNED (pass --sign for Developer ID)",
);

scrubStaleDesktopOut();
run("npm", ["run", "build"]);
run("npm", ["run", "desktop:prepare"]);

let tempDir = null;
try {
  const env = { ...process.env };
  let configPath = builderYml;

  if (sign) {
    if (!hasDeveloperId()) {
      console.error(
        "[desktop-build-mac] No “Developer ID Application” in keychain.\n" +
          "  Import your .p12 (Keychain Access) or set up like CI, then retry with --sign.\n" +
          "  Unsigned build: omit --sign.",
      );
      process.exit(1);
    }
    const appleOk =
      env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID;
    if (!appleOk) {
      console.warn(
        "[desktop-build-mac] APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID missing — will sign but skip notarize (Gatekeeper may still warn on download).",
      );
    }
    const { dir, cfg } = writeSignedConfig();
    tempDir = dir;
    configPath = cfg;
    // Cert already in keychain — do not set CSC_LINK (same as CI).
    env.CSC_IDENTITY_AUTO_DISCOVERY = "true";
    delete env.CSC_LINK;
  } else {
    env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
    // .env.local may have APPLE_* for signed publishes — don't notarize unsigned apps
    delete env.APPLE_ID;
    delete env.APPLE_APP_SPECIFIC_PASSWORD;
    delete env.APPLE_TEAM_ID;
  }

  run(
    "npx",
    [
      "electron-builder",
      "--mac",
      "--config",
      configPath,
      `-c.directories.output=${buildOut}`,
      "--publish",
      "never",
    ],
    env,
  );
  copyArtefactsBack();
} finally {
  if (tempDir) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

console.log(
  `[desktop-build-mac] done → dist-desktop/ (unpacked .app: ${buildOut}/mac-arm64)`,
);
