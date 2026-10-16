#!/usr/bin/env node
/**
 * Upload electron-builder artefacts to the public releases repo
 * (kuralayusha/cmae-releases) so landing links work while source stays private.
 *
 * Usage:
 *   node scripts/upload-desktop-github.mjs [--platform mac|win|all]
 *
 * Auth: `gh auth login` or GH_TOKEN / GITHUB_TOKEN / RELEASES_GITHUB_TOKEN
 * with contents:write on kuralayusha/cmae-releases.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist-desktop");
const RELEASES_REPO = "kuralayusha/cmae-releases";

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

// Prefer a dedicated releases token when publishing from CI on the private repo.
if (process.env.RELEASES_GITHUB_TOKEN && !process.env.GH_TOKEN) {
  process.env.GH_TOKEN = process.env.RELEASES_GITHUB_TOKEN;
}
if (process.env.GITHUB_TOKEN && !process.env.GH_TOKEN) {
  process.env.GH_TOKEN = process.env.GITHUB_TOKEN;
}

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = String(pkg.version).replace(/^v/i, "");
const tag = `v${version}`;
const policyPath = path.join(root, "version-policy.json");
const policy = JSON.parse(readFileSync(policyPath, "utf8"));

const downloadBase = `https://github.com/${RELEASES_REPO}/releases/download/${tag}`;
const releaseUrl = `https://github.com/${RELEASES_REPO}/releases/latest`;

/** @type {{ local: string; required?: boolean }[]} */
const macFiles = [
  { local: `CMAE-${version}-mac-arm64.dmg`, required: true },
  { local: `CMAE-${version}-arm64-mac.zip`, required: true },
  { local: `CMAE-${version}-arm64-mac.zip.blockmap` },
  { local: `CMAE-${version}-mac-arm64.dmg.blockmap` },
  { local: "latest-mac.yml", required: true },
];

/** @type {{ local: string; required?: boolean }[]} */
const winFiles = [
  { local: `CMAE-${version}-win-x64.exe`, required: true },
  { local: `CMAE-${version}-win-x64.exe.blockmap` },
  { local: "latest.yml", required: true },
];

function pickFiles() {
  if (platformArg === "mac") return macFiles;
  if (platformArg === "win") return winFiles;
  return [...macFiles, ...winFiles];
}

function gh(args, opts = {}) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    stdio: opts.stdio || ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || "").trim();
    throw new Error(`gh ${args.join(" ")} failed: ${err || result.status}`);
  }
  return (result.stdout || "").trim();
}

function releaseExists() {
  const result = spawnSync(
    "gh",
    ["release", "view", tag, "--repo", RELEASES_REPO],
    { encoding: "utf8", env: process.env },
  );
  return result.status === 0;
}

function ensureRelease() {
  if (releaseExists()) {
    console.log(`[upload-desktop-github] release ${tag} exists`);
    return;
  }
  console.log(`[upload-desktop-github] creating ${tag} on ${RELEASES_REPO}`);
  gh([
    "release",
    "create",
    tag,
    "--repo",
    RELEASES_REPO,
    "--title",
    `CMAE ${version}`,
    "--notes",
    `Desktop release ${tag}`,
  ]);
}

function uploadAssets(files) {
  const paths = [];
  for (const f of files) {
    const localPath = path.join(dist, f.local);
    if (!existsSync(localPath)) {
      if (f.required) {
        throw new Error(`Missing required artefact: ${localPath}`);
      }
      console.log(`[upload-desktop-github] skip (missing): ${f.local}`);
      continue;
    }
    paths.push(localPath);
  }
  if (!paths.length) {
    throw new Error("No artefacts to upload");
  }
  console.log(`[upload-desktop-github] uploading ${paths.length} file(s)…`);
  gh(
    [
      "release",
      "upload",
      tag,
      "--repo",
      RELEASES_REPO,
      "--clobber",
      ...paths,
    ],
    { stdio: "inherit" },
  );
}

function main() {
  ensureRelease();
  uploadAssets(pickFiles());

  const next = {
    ...policy,
    latest: version,
    minSupported: policy.minSupported || version,
    cdnBase: `https://github.com/${RELEASES_REPO}/releases/download`,
    releaseUrl,
    updateFeedUrl: releaseUrl,
    releasesRepo: RELEASES_REPO,
    downloads: {
      ...(policy.downloads || {}),
      "darwin-arm64": `${downloadBase}/CMAE-${version}-mac-arm64.dmg`,
      "win32-x64": `${downloadBase}/CMAE-${version}-win-x64.exe`,
    },
  };

  writeFileSync(policyPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");

  // Also attach policy.json so landing can fetch without waiting for Vercel deploy.
  const policyTmp = path.join(dist, "policy.json");
  writeFileSync(policyTmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  gh(
    [
      "release",
      "upload",
      tag,
      "--repo",
      RELEASES_REPO,
      "--clobber",
      policyTmp,
    ],
    { stdio: "inherit" },
  );

  console.log(
    JSON.stringify(
      {
        version,
        tag,
        repo: RELEASES_REPO,
        downloads: next.downloads,
        releaseUrl,
      },
      null,
      2,
    ),
  );
}

try {
  main();
} catch (err) {
  console.error("[upload-desktop-github]", err instanceof Error ? err.message : err);
  process.exit(1);
}
