#!/usr/bin/env node
/**
 * After `next build`, prepare a portable desktop payload:
 * - copy static + public into standalone
 * - flatten standalone into desktop-resources/standalone (dereference symlinks)
 * - download official Node.js binary into desktop-resources/node(.exe)
 * Must run on the target OS (darwin/win32) so native modules match.
 */
import {
  createWriteStream,
  cpSync,
  existsSync,
  mkdirSync,
  chmodSync,
  rmSync,
  readdirSync,
  statSync,
  lstatSync,
  readlinkSync,
} from "fs";
import { createRequire } from "module";
import http from "http";
import https from "https";
import path from "path";
import { pipeline } from "stream/promises";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const standalone = path.join(root, ".next", "standalone");
const staticSrc = path.join(root, ".next", "static");
const publicSrc = path.join(root, "public");
const resourcesDir = path.join(root, "desktop-resources");
const payloadDir = path.join(resourcesDir, "standalone");

function mustExist(p, label) {
  if (!existsSync(p)) {
    throw new Error(`${label} missing: ${p}. Run \`npm run build\` first.`);
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

function canvasNativePackage() {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (process.platform === "darwin") {
    return `@napi-rs/canvas-darwin-${arch}`;
  }
  if (process.platform === "win32") {
    if (arch !== "x64") {
      throw new Error(
        `Windows desktop prepare only supports x64 (got ${process.arch})`,
      );
    }
    return "@napi-rs/canvas-win32-x64-msvc";
  }
  throw new Error(
    `Desktop prepare only supports darwin/win32 (got ${process.platform})`,
  );
}

async function fetchOfficialNodeBinary() {
  const version = process.env.CMAE_BUNDLE_NODE_VERSION || process.versions.node;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const tmpDir = path.join(resourcesDir, ".node-extract");

  let name;
  let archiveName;
  let url;
  let destNode;
  let extractedNode;

  if (process.platform === "darwin") {
    name = `node-v${version}-darwin-${arch}`;
    archiveName = `${name}.tar.gz`;
    url = `https://nodejs.org/dist/v${version}/${archiveName}`;
    destNode = path.join(resourcesDir, "node");
    extractedNode = path.join(tmpDir, name, "bin", "node");
  } else if (process.platform === "win32") {
    if (arch !== "x64") {
      throw new Error(
        `Windows desktop prepare only supports x64 (got ${process.arch})`,
      );
    }
    name = `node-v${version}-win-x64`;
    archiveName = `${name}.zip`;
    url = `https://nodejs.org/dist/v${version}/${archiveName}`;
    destNode = path.join(resourcesDir, "node.exe");
    extractedNode = path.join(tmpDir, name, "node.exe");
  } else {
    throw new Error(
      `Desktop prepare only supports darwin/win32 (got ${process.platform})`,
    );
  }

  const archivePath = path.join(resourcesDir, archiveName);

  mkdirSync(resourcesDir, { recursive: true });
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  // Drop the other platform's leftover binary
  for (const leftover of ["node", "node.exe"]) {
    rmSync(path.join(resourcesDir, leftover), { force: true });
  }

  console.log(`Downloading official Node ${version} (${process.platform}-${arch})…`);
  console.log(url);
  const res = await download(url);
  await pipeline(res, createWriteStream(archivePath));

  if (process.platform === "darwin") {
    execFileSync("tar", ["-xzf", archivePath, "-C", tmpDir], {
      stdio: "inherit",
    });
  } else {
    // Windows 10+ / GitHub runners ship tar that can extract zip
    execFileSync("tar", ["-xf", archivePath, "-C", tmpDir], {
      stdio: "inherit",
    });
  }

  if (!existsSync(extractedNode)) {
    throw new Error(
      `Official Node binary missing after extract: ${extractedNode}`,
    );
  }
  cpSync(extractedNode, destNode);
  if (process.platform !== "win32") {
    chmodSync(destNode, 0o755);
  }
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(archivePath, { force: true });

  const ver = execFileSync(destNode, ["-v"], { encoding: "utf8" }).trim();
  console.log(`Bundled Node ready: ${destNode} (${ver})`);
}

/** Recursively copy, turning symlinks into real files/dirs. */
function copyDeref(src, dest) {
  const st = lstatSync(src);
  if (st.isSymbolicLink()) {
    const target = readlinkSync(src);
    const resolved = path.resolve(path.dirname(src), target);
    if (!existsSync(resolved)) {
      console.warn(`Skipping broken symlink: ${src} -> ${target}`);
      return;
    }
    copyDeref(resolved, dest);
    return;
  }
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(src)) {
      copyDeref(path.join(src, name), path.join(dest, name));
    }
    return;
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(src, dest);
}

mustExist(standalone, "Standalone output");
mustExist(path.join(standalone, "server.js"), "standalone/server.js");
mustExist(staticSrc, ".next/static");

const staticDest = path.join(standalone, ".next", "static");
mkdirSync(path.dirname(staticDest), { recursive: true });
rmSync(staticDest, { recursive: true, force: true });
cpSync(staticSrc, staticDest, { recursive: true });
console.log("Copied .next/static → standalone");

if (existsSync(publicSrc)) {
  const publicDest = path.join(standalone, "public");
  rmSync(publicDest, { recursive: true, force: true });
  cpSync(publicSrc, publicDest, { recursive: true });
  console.log("Copied public → standalone");
}

/** Replace incomplete NFT copies with full packages needed at runtime. */
function resolvePackageRoot(pkgName) {
  try {
    return path.dirname(require.resolve(`${pkgName}/package.json`));
  } catch {
    // packages that omit package.json from "exports"
    const entry = require.resolve(pkgName);
    let dir = path.dirname(entry);
    for (let i = 0; i < 8; i++) {
      if (existsSync(path.join(dir, "package.json"))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    const fallback = path.join(root, "node_modules", pkgName);
    if (existsSync(fallback)) return fallback;
    throw new Error(`Cannot resolve package root for ${pkgName}`);
  }
}

function copyFullPackage(pkgName) {
  const pkgRoot = resolvePackageRoot(pkgName);
  const dest = path.join(standalone, "node_modules", pkgName);
  mkdirSync(path.dirname(dest), { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  cpSync(pkgRoot, dest, { recursive: true });
  console.log(`Copied ${pkgName} → standalone/node_modules`);
}

copyFullPackage("better-sqlite3");
// pdf-parse → pdfjs-dist worker files are often dropped by file tracing
copyFullPackage("pdfjs-dist");
copyFullPackage("pdf-parse");
// pdfjs Node polyfills (DOMMatrix etc.) — without this packaged app 500s on every page
copyFullPackage("@napi-rs/canvas");
{
  const platformPkg = canvasNativePackage();
  try {
    copyFullPackage(platformPkg);
  } catch (err) {
    console.warn(
      `Optional ${platformPkg} missing (${err instanceof Error ? err.message : err})`,
    );
  }
}

// Drop accidental runtime junk that NFT may have pulled in
for (const junk of ["workspace", "data", "dist-desktop", ".desktop-data"]) {
  rmSync(path.join(standalone, junk), { recursive: true, force: true });
}

// Flatten into desktop-resources/standalone (no broken symlinks for electron-builder)
rmSync(payloadDir, { recursive: true, force: true });
mkdirSync(payloadDir, { recursive: true });
copyDeref(standalone, payloadDir);
console.log(`Flattened standalone → ${payloadDir}`);

const nm = path.join(payloadDir, "node_modules");
if (!existsSync(nm) || !statSync(nm).isDirectory()) {
  throw new Error("desktop-resources/standalone/node_modules missing after copy");
}
const hashedSqlite = path.join(
  payloadDir,
  ".next",
  "node_modules",
  "better-sqlite3-90e2652d1716b047",
);
// Hash suffix can change; ensure every entry under .next/node_modules is a real dir
const hashedDir = path.join(payloadDir, ".next", "node_modules");
if (existsSync(hashedDir)) {
  for (const name of readdirSync(hashedDir)) {
    const p = path.join(hashedDir, name);
    if (lstatSync(p).isSymbolicLink()) {
      throw new Error(`Symlink survived flatten: ${p}`);
    }
  }
  console.log("Verified .next/node_modules entries are real directories");
} else {
  console.warn("No .next/node_modules hashed externals dir (unexpected)");
}
void hashedSqlite;

await fetchOfficialNodeBinary();
console.log("prepare-desktop: done");
