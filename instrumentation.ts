/**
 * Align CMAE_USER_DATA before any route/RSC opens SQLite.
 * Desktop workers sometimes lose the env; sticky file from Electron restores it.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") return;
  if (process.env.CMAE_USER_DATA?.trim()) return;
  if (process.env.VERCEL || process.env.VERCEL_ENV) return;

  try {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const home = process.env.HOME?.trim() || os.homedir();
    const sticky = path.join(home, ".cmae-app-root");
    if (!fs.existsSync(sticky)) return;
    const root = fs.readFileSync(sticky, "utf8").trim();
    if (!root || !fs.existsSync(root)) return;
    process.env.CMAE_USER_DATA = path.resolve(root);
  } catch {
    /* ignore */
  }
}
