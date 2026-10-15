import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Align CMAE_USER_DATA before any route/RSC opens SQLite.
 * Desktop workers sometimes lose the env; sticky file from Electron restores it.
 */
if (!process.env.CMAE_USER_DATA?.trim() && !process.env.VERCEL && !process.env.VERCEL_ENV) {
  try {
    const home = process.env.HOME?.trim() || os.homedir();
    const sticky = path.join(home, ".cmae-app-root");
    if (fs.existsSync(sticky)) {
      const root = fs.readFileSync(sticky, "utf8").trim();
      if (root && fs.existsSync(root)) {
        process.env.CMAE_USER_DATA = path.resolve(root);
      }
    }
  } catch {
    /* ignore */
  }
}
