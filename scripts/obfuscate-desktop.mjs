#!/usr/bin/env node
/**
 * Copy desktop/ → desktop-pack/ and optionally obfuscate shell scripts.
 * electron-builder packs desktop-pack as `desktop/` inside the app.
 *
 * CMAE_OBFUSCATE=1 → javascript-obfuscator (CI release builds)
 * unset / 0 → plain copy (local / fast builds)
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const srcDir = path.join(root, "desktop");
const outDir = path.join(root, "desktop-pack");

const wantObfuscate = ["1", "true", "yes"].includes(
  String(process.env.CMAE_OBFUSCATE || "")
    .trim()
    .toLowerCase(),
);

const FILES = ["main.cjs", "preload.cjs", "updater.cjs"];

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const name of FILES) {
  const from = path.join(srcDir, name);
  if (!existsSync(from)) {
    throw new Error(`Missing desktop source: ${from}`);
  }
  cpSync(from, path.join(outDir, name));
}

if (!wantObfuscate) {
  console.log("[obfuscate-desktop] copied desktop → desktop-pack (plain)");
  process.exit(0);
}

let JavaScriptObfuscator;
try {
  JavaScriptObfuscator = require("javascript-obfuscator");
} catch {
  console.warn(
    "[obfuscate-desktop] javascript-obfuscator not installed — packing plain copy",
  );
  process.exit(0);
}

// Keep Electron require()/exports and IPC string names intact.
const options = {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  debugProtection: false,
  disableConsoleOutput: false,
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: false,
  selfDefending: false,
  stringArray: true,
  stringArrayThreshold: 0.5,
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
  // Critical for Electron CJS + dynamic require("electron-updater")
  reservedNames: [
    "^require$",
    "^exports$",
    "^module$",
    "^__dirname$",
    "^__filename$",
    "^process$",
    "^Buffer$",
    "^global$",
  ],
  reservedStrings: [
    "electron",
    "electron-updater",
    "cmae:uninstall",
    "cmae:get-version",
    "cmae:open-external",
    "cmae:check-updates",
    "cmae:quit-and-install",
    "cmae:update-event",
    "cmaeDesktop",
  ],
};

for (const name of FILES) {
  const target = path.join(outDir, name);
  const source = readFileSync(target, "utf8");
  const result = JavaScriptObfuscator.obfuscate(source, options);
  writeFileSync(target, result.getObfuscatedCode(), "utf8");
  console.log(`[obfuscate-desktop] obfuscated ${name}`);
}

console.log("[obfuscate-desktop] done → desktop-pack/");
