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

/** Non-blocking: scheduler must not delay server ready (see Next instrumentation docs). */
void import("./lib/sync/scheduler")
  .then((s) => s.start())
  .catch((err) => {
    console.error("[instrumentation] sync scheduler failed to start", err);
  });

/** Non-blocking: AI usage upload worker (counters only; no-op when telemetry is off / unconfigured). */
void import("./lib/ai-usage/uploader")
  .then((u) => u.startUsageUploader())
  .catch((err) => {
    console.error("[instrumentation] usage uploader failed to start", err);
  });
