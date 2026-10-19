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
  // Default: GitHub provider → public kuralayusha/cmae-releases (baked by
  // electron-builder.yml). Optional override for QA:
  //   CMAE_UPDATE_FEED_URL=https://github.com/…/cmae-releases
  const feed = (process.env.CMAE_UPDATE_FEED_URL || "").trim().replace(/\/$/, "");
  if (feed) {
    try {
      if (feed.includes("github.com")) {
        autoUpdater.setFeedURL({
          provider: "github",
          owner: "kuralayusha",
          repo: "cmae-releases",
        });
      } else {
        autoUpdater.setFeedURL({ provider: "generic", url: feed });
      }
    } catch (err) {
      console.warn("[updater] setFeedURL failed:", err);
    }
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
    if (updateDownloaded) return;
    emit?.({ phase: "checking" });
  });
  updater.on("update-available", (info) => {
    if (updateDownloaded) {
      emit?.({ phase: "downloaded", info });
      return;
    }
    emit?.({ phase: "available", info });
  });
  updater.on("update-not-available", (info) => {
    emit?.({ phase: "none", info });
  });
  updater.on("download-progress", (info) => {
    if (updateDownloaded) return;
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
