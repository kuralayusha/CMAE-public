import "server-only";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Matches electron-builder `productName` / branded folder. */
const APP_DATA_NAME = "CMAE";
/** Older Electron installs used package.json `name` (lowercase). */
const APP_DATA_NAME_LEGACY = "cmae";

function isVercel(): boolean {
  return Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
}

function firstExistingDir(candidates: string[]): string | null {
  for (const dir of candidates) {
    try {
      if (fs.existsSync(/*turbopackIgnore: true*/ dir)) return dir;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * Cross-process sticky file so RSC workers / child processes that lose
 * CMAE_USER_DATA still open the same SQLite as the API that wrote the
 * onboarding flag (otherwise Tracker↔onboarding bounce loops forever).
 */
function stickyAppRootPath(): string {
  const home = process.env.HOME?.trim() || os.homedir();
  return path.join(/*turbopackIgnore: true*/ home, ".cmae-app-root");
}

function readStickyAppRoot(): string | null {
  try {
    const raw = fs
      .readFileSync(/*turbopackIgnore: true*/ stickyAppRootPath(), "utf8")
      .trim();
    if (!raw) return null;
    const resolved = path.resolve(/*turbopackIgnore: true*/ raw);
    if (fs.existsSync(/*turbopackIgnore: true*/ resolved)) return resolved;
  } catch {
    /* ignore */
  }
  return null;
}

function writeStickyAppRoot(root: string): void {
  try {
    fs.writeFileSync(
      /*turbopackIgnore: true*/ stickyAppRootPath(),
      `${root}\n`,
      "utf8",
    );
  } catch {
    /* ignore */
  }
}

/**
 * Per-user app data when Electron did not inject CMAE_USER_DATA
 * (worker/child, or rare env loss). Never hardcodes a username —
 * always derives from HOME / APPDATA / XDG for the current OS user.
 */
function packagedUserDataFallback(): string | null {
  if (process.platform === "darwin") {
    const home = process.env.HOME?.trim();
    if (!home) return null;
    const candidates = [APP_DATA_NAME, APP_DATA_NAME_LEGACY].map((name) =>
      path.join(
        /*turbopackIgnore: true*/ home,
        "Library",
        "Application Support",
        name,
      ),
    );
    return firstExistingDir(candidates) ?? candidates[0]!;
  }

  if (process.platform === "win32") {
    // Electron userData → %APPDATA%\<name> (roaming)
    const appData = process.env.APPDATA?.trim();
    if (!appData) return null;
    const candidates = [APP_DATA_NAME, APP_DATA_NAME_LEGACY].map((name) =>
      path.join(/*turbopackIgnore: true*/ appData, name),
    );
    return firstExistingDir(candidates) ?? candidates[0]!;
  }

  // Linux / other: Electron uses ~/.config/<name>
  const home = process.env.HOME?.trim();
  const xdg =
    process.env.XDG_CONFIG_HOME?.trim() ||
    (home ? path.join(/*turbopackIgnore: true*/ home, ".config") : "");
  if (!xdg) return null;
  const candidates = [APP_DATA_NAME, APP_DATA_NAME_LEGACY].map((name) =>
    path.join(/*turbopackIgnore: true*/ xdg, name),
  );
  return firstExistingDir(candidates) ?? candidates[0]!;
}

function looksPackaged(cwd: string): boolean {
  return (
    cwd.includes(`${path.sep}CMAE.app${path.sep}`) ||
    cwd.endsWith(`${path.sep}standalone`) ||
    cwd.includes(`${path.sep}standalone${path.sep}`) ||
    /\.exe$/i.test(process.execPath || "")
  );
}

/** Freeze first resolution so RSC / route handlers never flip mid-process. */
let cachedAppRoot: string | null = null;

/**
 * App data root.
 * - Electron: CMAE_USER_DATA (app.getPath("userData") — per OS user, Mac/Win/Linux)
 * - Sticky ~/.cmae-app-root when a worker lost the env (same SQLite for all)
 * - Vercel: /tmp/cmae (ephemeral, writable)
 * - Packaged standalone without env: OS user data dir (see packagedUserDataFallback)
 * - Dev / local: process.cwd()
 */
export function getAppRoot(): string {
  // Env always wins and refreshes cache (worker may have cached cwd earlier).
  const fromEnv = process.env.CMAE_USER_DATA?.trim();
  if (fromEnv) {
    const resolved = path.resolve(/*turbopackIgnore: true*/ fromEnv);
    writeStickyAppRoot(resolved);
    cachedAppRoot = resolved;
    return cachedAppRoot;
  }

  // Freeze once resolved in this process. Mid-flight sticky flips (e.g. desktop
  // writing ~/.cmae-app-root while next dev sync holds an open SQLite handle)
  // close the DB under long-running rebuilds → "database connection is not open".
  // Fresh workers still pick sticky below when cache is empty.
  if (cachedAppRoot) return cachedAppRoot;

  const sticky = readStickyAppRoot();
  if (sticky) {
    cachedAppRoot = sticky;
    return cachedAppRoot;
  }


  if (isVercel()) {
    cachedAppRoot = "/tmp/cmae";
    return cachedAppRoot;
  }

  // Packaged desktop sometimes loses CMAE_USER_DATA on a worker/child —
  // never fall back to standalone cwd (that caused "complete" then bounce).
  const cwd = process.cwd();
  if (looksPackaged(cwd)) {
    const fallback = packagedUserDataFallback();
    if (fallback) {
      cachedAppRoot = fallback;
      writeStickyAppRoot(cachedAppRoot);
      return cachedAppRoot;
    }
  }

  cachedAppRoot = cwd;
  return cachedAppRoot;
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

export function getResearchJobsDir(): string {
  const dataDir = getDataDir();
  const dir = path.join(/*turbopackIgnore: true*/ dataDir, "research-jobs");
  fs.mkdirSync(dir, { recursive: true });
  // One-time migrate from legacy Search product name
  const legacy = path.join(/*turbopackIgnore: true*/ dataDir, "search-jobs");
  try {
    if (fs.existsSync(/*turbopackIgnore: true*/ legacy)) {
      for (const name of fs.readdirSync(/*turbopackIgnore: true*/ legacy)) {
        const from = path.join(/*turbopackIgnore: true*/ legacy, name);
        const to = path.join(/*turbopackIgnore: true*/ dir, name);
        if (!fs.existsSync(/*turbopackIgnore: true*/ to)) {
          fs.renameSync(from, to);
        }
      }
      try {
        fs.rmdirSync(/*turbopackIgnore: true*/ legacy);
      } catch {
        /* not empty — leave leftovers */
      }
    }
  } catch {
    /* ignore */
  }
  return dir;
}
