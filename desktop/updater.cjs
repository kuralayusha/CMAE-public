/**
 * electron-updater wiring for packaged builds.
 * Dev / unpackaged: no-op.
 */
const { app } = require("electron");

/** @type {import('electron-updater').AppUpdater | null} */
let autoUpdater = null;
/** @type {((payload: { phase: string; info?: unknown }) => void) | null} */
let emit = null;
let updateDownloaded = false;

function loadUpdater() {
  if (autoUpdater) return autoUpdater;
  if (!app.isPackaged) return null;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (err) {
    console.warn("[updater] electron-updater missing:", err);
    return null;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Private GitHub repos need GH_TOKEN / GITHUB_TOKEN in the environment
  // at build time for publish; at runtime set via CMAE_GH_TOKEN if needed.
  const token = process.env.CMAE_GH_TOKEN || process.env.GH_TOKEN;
  if (token) {
    autoUpdater.requestHeaders = {
      ...(autoUpdater.requestHeaders || {}),
      Authorization: `token ${token}`,
    };
  }
  return autoUpdater;
}

/**
 * @param {(payload: { phase: string; info?: unknown }) => void} onEvent
 */
function initAutoUpdater(onEvent) {
  emit = onEvent;
  const updater = loadUpdater();
  if (!updater) return;

  updater.on("checking-for-update", () => {
    emit?.({ phase: "checking" });
  });
  updater.on("update-available", (info) => {
    emit?.({ phase: "available", info });
  });
  updater.on("update-not-available", (info) => {
    emit?.({ phase: "none", info });
  });
  updater.on("download-progress", (info) => {
    emit?.({ phase: "downloading", info });
  });
  updater.on("update-downloaded", (info) => {
    updateDownloaded = true;
    emit?.({ phase: "downloaded", info });
  });
  updater.on("error", (err) => {
    console.error("[updater]", err);
    emit?.({
      phase: "error",
      info: err instanceof Error ? err.message : String(err),
    });
  });

  // Initial check shortly after ready; then every 4h
  setTimeout(() => {
    void checkForUpdates();
  }, 8_000);
  setInterval(
    () => {
      void checkForUpdates();
    },
    4 * 60 * 60 * 1000,
  );
}

async function checkForUpdates() {
  const updater = loadUpdater();
  if (!updater) return { ok: false, reason: "unavailable" };
  try {
    const result = await updater.checkForUpdates();
    return { ok: true, updateInfo: result?.updateInfo ?? null };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function quitAndInstall() {
  const updater = loadUpdater();
  if (!updater || !updateDownloaded) {
    return { ok: false, reason: "no-download" };
  }
  // isSilent=false, isForceRunAfter=true
  updater.quitAndInstall(false, true);
  return { ok: true };
}

function getVersion() {
  return app.getVersion();
}

module.exports = {
  initAutoUpdater,
  checkForUpdates,
  quitAndInstall,
  getVersion,
};
