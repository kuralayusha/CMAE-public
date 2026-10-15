#!/usr/bin/env node
/**
 * Sync version-policy.json download URLs to package.json version.
 * Usage: node scripts/bump-version-policy.mjs [notes...]
 */
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const policyPath = path.join(root, "version-policy.json");
const policy = JSON.parse(readFileSync(policyPath, "utf8"));
const version = String(pkg.version).replace(/^v/i, "");
const notes = process.argv.slice(2).join(" ").trim();

const base = "https://github.com/kuralayusha/CMAE/releases";
policy.latest = version;
if (!policy.minSupported) policy.minSupported = version;
policy.releaseUrl = `${base}/latest`;
policy.downloads = {
  ...policy.downloads,
  "darwin-arm64": `${base}/download/v${version}/CMAE-${version}-mac-arm64.dmg`,
  "win32-x64": `${base}/download/v${version}/CMAE-${version}-win-x64.exe`,
};
if (notes) policy.notes = notes;

writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
console.log(`[bump-version-policy] latest=${version}`);
console.log(JSON.stringify(policy, null, 2));
