#!/usr/bin/env node
/**
 * Upload electron-builder artefacts + updater metadata + policy.json to
 * public Vercel Blob. Landing + electron-updater read from the same CDN.
 *
 * Usage:
 *   node scripts/upload-desktop-blob.mjs [--platform mac|win|all]
 *
 * Requires BLOB_READ_WRITE_TOKEN (CI secret or .env.local).
 */
import { createReadStream, existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { put } from "@vercel/blob";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist-desktop");
const platformArg = (
  process.argv.find((a) => a.startsWith("--platform="))?.split("=")[1] ||
  process.argv[process.argv.indexOf("--platform") + 1] ||
  "all"
).toLowerCase();

function loadDotEnvLocal() {
  const p = path.join(root, ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
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

loadDotEnvLocal();

const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token) {
  console.error(
    "[upload-desktop-blob] BLOB_READ_WRITE_TOKEN missing (GitHub secret or .env.local)",
  );
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = String(pkg.version).replace(/^v/i, "");
const policyPath = path.join(root, "version-policy.json");
const policy = JSON.parse(readFileSync(policyPath, "utf8"));

const CDN_BASE = String(
  process.env.CMAE_CDN_BASE ||
    policy.cdnBase ||
    "https://j99zof4rag1z9ajs.public.blob.vercel-storage.com",
).replace(/\/$/, "");

/** @type {{ local: string; remote: string; required?: boolean }[]} */
const macFiles = [
  {
    local: `CMAE-${version}-mac-arm64.dmg`,
    remote: `releases/CMAE-${version}-mac-arm64.dmg`,
    required: true,
  },
  {
    local: `CMAE-${version}-arm64-mac.zip`,
    remote: `releases/CMAE-${version}-arm64-mac.zip`,
    required: true,
  },
  {
    local: `CMAE-${version}-arm64-mac.zip.blockmap`,
    remote: `releases/CMAE-${version}-arm64-mac.zip.blockmap`,
  },
  {
    local: `CMAE-${version}-mac-arm64.dmg.blockmap`,
    remote: `releases/CMAE-${version}-mac-arm64.dmg.blockmap`,
  },
  { local: "latest-mac.yml", remote: "releases/latest-mac.yml", required: true },
];

/** @type {{ local: string; remote: string; required?: boolean }[]} */
const winFiles = [
  {
    local: `CMAE-${version}-win-x64.exe`,
    remote: `releases/CMAE-${version}-win-x64.exe`,
    required: true,
  },
  {
    local: `CMAE-${version}-win-x64.exe.blockmap`,
    remote: `releases/CMAE-${version}-win-x64.exe.blockmap`,
  },
  { local: "latest.yml", remote: "releases/latest.yml", required: true },
];

function pickFiles() {
  if (platformArg === "mac") return macFiles;
  if (platformArg === "win") return winFiles;
  return [...macFiles, ...winFiles];
}

async function uploadOne(localName, remotePath, required) {
  const localPath = path.join(dist, localName);
  if (!existsSync(localPath)) {
    if (required) {
      throw new Error(`Missing required artefact: ${localPath}`);
    }
    console.log(`[upload-desktop-blob] skip (missing): ${localName}`);
    return null;
  }
  console.log(`[upload-desktop-blob] → ${remotePath}`);
  const blob = await put(remotePath, createReadStream(localPath), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    multipart: true,
    token,
  });
  console.log(`[upload-desktop-blob] ok ${blob.url}`);
  return blob.url;
}

async function main() {
  const uploaded = {};
  for (const f of pickFiles()) {
    const url = await uploadOne(f.local, f.remote, f.required);
    if (url) uploaded[f.remote] = url;
  }

  // Merge platform-specific download URLs into policy (CI runs mac/win separately).
  const next = {
    ...policy,
    latest: version,
    minSupported: policy.minSupported || version,
    cdnBase: CDN_BASE,
    releaseUrl: `${CDN_BASE}/releases`,
    updateFeedUrl: `${CDN_BASE}/releases`,
    downloads: {
      ...(policy.downloads || {}),
      "darwin-arm64": `${CDN_BASE}/releases/CMAE-${version}-mac-arm64.dmg`,
      "win32-x64": `${CDN_BASE}/releases/CMAE-${version}-win-x64.exe`,
    },
  };

  // Persist locally so a follow-up commit / Vercel deploy stays in sync.
  writeFileSync(policyPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");

  const policyBlob = await put(
    "releases/policy.json",
    Buffer.from(`${JSON.stringify(next, null, 2)}\n`, "utf8"),
    {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
      token,
    },
  );

  console.log("[upload-desktop-blob] policy →", policyBlob.url);
  console.log(
    JSON.stringify(
      {
        version,
        cdnBase: CDN_BASE,
        uploaded: Object.keys(uploaded),
        downloads: next.downloads,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error("[upload-desktop-blob]", err);
  process.exit(1);
});
