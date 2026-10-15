#!/usr/bin/env node
/**
 * CI-only: strip `mac.identity: null` from electron-builder.yml so CSC_LINK
 * can codesign. Local builds keep identity: null (avoids ambiguous keychain
 * "Apple Development" identities).
 *
 * With CSC_IDENTITY_AUTO_DISCOVERY=false and no CSC_LINK → still unsigned.
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
