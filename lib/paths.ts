import fs from "fs";
import path from "path";

/**
 * App data root.
 * - Dev / `next start`: process.cwd()
 * - Electron: CMAE_USER_DATA set by the desktop shell (app.getPath("userData"))
 */
export function getAppRoot(): string {
  const fromEnv = process.env.CMAE_USER_DATA?.trim();
  if (fromEnv) return path.resolve(/*turbopackIgnore: true*/ fromEnv);
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
