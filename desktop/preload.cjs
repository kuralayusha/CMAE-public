const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cmaeDesktop", {
  isDesktop: true,
  /** Wipe Application Support data + remove .app (not the .dmg), then quit. */
  uninstallApp: () => ipcRenderer.invoke("cmae:uninstall"),
});
