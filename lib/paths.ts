import "server-only";

import fs from "node:fs";
import path from "node:path";

function isVercel(): boolean {
  return Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
}

/**
 * App data root.
 * - Electron: CMAE_USER_DATA (app.getPath("userData"))
 * - Vercel: /tmp/cmae (ephemeral, writable)
 * - Packaged standalone without env: macOS Application Support/CMAE
 * - Dev / local: process.cwd()
 */
export function getAppRoot(): string {
  const fromEnv = process.env.CMAE_USER_DATA?.trim();
  if (fromEnv) return path.resolve(/*turbopackIgnore: true*/ fromEnv);
  if (isVercel()) return "/tmp/cmae";

  // Packaged desktop sometimes loses CMAE_USER_DATA on a worker/child —
  // never fall back to standalone cwd (that caused "complete" then bounce).
  const cwd = process.cwd();
  const packaged =
    cwd.includes(`${path.sep}CMAE.app${path.sep}`) ||
    cwd.endsWith(`${path.sep}standalone`) ||
    cwd.includes(`${path.sep}standalone${path.sep}`);
  if (packaged) {
    const home = process.env.HOME?.trim();
    if (home && process.platform === "darwin") {
      return path.join(
        /*turbopackIgnore: true*/ home,
        "Library",
        "Application Support",
        "CMAE",
      );
    }
    if (process.env.APPDATA?.trim() && process.platform === "win32") {
      return path.join(
        /*turbopackIgnore: true*/ process.env.APPDATA.trim(),
        "CMAE",
      );
    }
  }

  return cwd;
}

export function getDataDir(): string {
  const dir = path.join(/*turbopackIgnore: true*/ getAppRoot(), "data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getWorkspaceRootPath(): string {
  const dir = path.join(/*turbopackIgnore: true*/ getAppRoot(), "workspace");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getSearchJobsDir(): string {
  const dir = path.join(/*turbopackIgnore: true*/ getDataDir(), "search-jobs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Working directory for Cursor/local agents — prefer workspace when present. */
export function getAgentCwd(): string {
  return getWorkspaceRootPath();
}
