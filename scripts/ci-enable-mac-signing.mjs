#!/usr/bin/env node
/**
 * CI-only: strip `mac.identity: null` from electron-builder.yml so the
 * imported Developer ID can codesign. Local signed builds use
 * scripts/desktop-build-mac.mjs --sign (temp config; does not mutate this file).
 *
 * With CSC_IDENTITY_AUTO_DISCOVERY=false and no cert → still unsigned.
 */
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "electron-builder.yml");
const before = readFileSync(file, "utf8");
const after = before.replace(/^[ \t]*identity:\s*null[ \t]*\r?\n/m, "");

if (before === after) {
  console.log("[ci-enable-mac-signing] no identity: null found — ok");
} else {
  writeFileSync(file, after, "utf8");
  console.log(
    "[ci-enable-mac-signing] removed mac.identity: null — CSC_LINK may sign",
  );
}
