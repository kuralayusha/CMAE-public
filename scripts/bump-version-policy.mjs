#!/usr/bin/env node
/**
 * Sync version-policy.json download URLs to package.json version + releases repo.
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

const releasesRepo =
  process.env.CMAE_RELEASES_REPO ||
  policy.releasesRepo ||
  "kuralayusha/cmae-releases";
const downloadBase = `https://github.com/${releasesRepo}/releases/download/v${version}`;

policy.latest = version;
if (!policy.minSupported) policy.minSupported = version;
policy.releasesRepo = releasesRepo;
policy.cdnBase = `https://github.com/${releasesRepo}/releases/download`;
policy.releaseUrl = `https://github.com/${releasesRepo}/releases/latest`;
policy.updateFeedUrl = policy.releaseUrl;
policy.downloads = {
  ...policy.downloads,
  "darwin-arm64": `${downloadBase}/CMAE-${version}-mac-arm64.dmg`,
  "win32-x64": `${downloadBase}/CMAE-${version}-win-x64.exe`,
};
if (notes) policy.notes = notes;

writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
console.log(`[bump-version-policy] latest=${version} repo=${releasesRepo}`);
console.log(JSON.stringify(policy, null, 2));
