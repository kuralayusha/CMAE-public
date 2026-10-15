const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cmaeDesktop", {
  isDesktop: true,
  platform: process.platform,
  arch: process.arch,
  /** Wipe Application Support data + remove .app (not the .dmg), then quit. */
  uninstallApp: () => ipcRenderer.invoke("cmae:uninstall"),
  getVersion: () => ipcRenderer.invoke("cmae:get-version"),
  openExternal: (url) => ipcRenderer.invoke("cmae:open-external", url),
  checkForUpdates: () => ipcRenderer.invoke("cmae:check-updates"),
  quitAndInstall: () => ipcRenderer.invoke("cmae:quit-and-install"),
  onUpdateEvent: (handler) => {
    const listener = (_event, payload) => {
      handler(payload);
    };
    ipcRenderer.on("cmae:update-event", listener);
    return () => {
      ipcRenderer.removeListener("cmae:update-event", listener);
    };
  },
});
