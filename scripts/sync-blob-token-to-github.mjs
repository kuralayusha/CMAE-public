#!/usr/bin/env node
/**
 * One-time: copy BLOB_READ_WRITE_TOKEN from .env.local into the GitHub Actions secret.
 * Requires: gh auth login (repo admin).
 *
 *   node scripts/sync-blob-token-to-github.mjs
 */
import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env.local");
if (!existsSync(envPath)) {
  console.error("Missing .env.local — run: npx vercel env pull --yes");
  process.exit(1);
}

let token = "";
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^BLOB_READ_WRITE_TOKEN=(.*)$/);
  if (!m) continue;
  token = m[1].trim().replace(/^["']|["']$/g, "");
}
if (!token) {
  console.error("BLOB_READ_WRITE_TOKEN not found in .env.local");
  process.exit(1);
}

const repo =
  process.env.GITHUB_REPOSITORY ||
  (() => {
    const r = spawnSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf8",
    });
    const url = (r.stdout || "").trim();
    const m = url.match(/github\.com[:/](.+?)(?:\.git)?$/);
    return m ? m[1] : "kuralayusha/CMAE";
  })();

console.log(`Setting BLOB_READ_WRITE_TOKEN on ${repo}…`);
const result = spawnSync(
  "gh",
  ["secret", "set", "BLOB_READ_WRITE_TOKEN", "--repo", repo],
  { input: token, encoding: "utf8", stdio: ["pipe", "inherit", "inherit"] },
);
if (result.status !== 0) {
  console.error(
    "Failed. Run `gh auth login` then retry, or add the secret manually in GitHub → Settings → Secrets.",
  );
  process.exit(result.status || 1);
}
console.log("Done. Re-run Desktop Release workflow.");
