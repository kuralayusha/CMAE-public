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
 * - Dev / local: process.cwd()
 */
export function getAppRoot(): string {
  const fromEnv = process.env.CMAE_USER_DATA?.trim();
  if (fromEnv) return path.resolve(/*turbopackIgnore: true*/ fromEnv);
  if (isVercel()) return "/tmp/cmae";
  return process.cwd();
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
