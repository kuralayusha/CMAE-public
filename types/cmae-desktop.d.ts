export {};

type CmaeUpdateEvent = {
  phase:
    | "checking"
    | "available"
    | "none"
    | "downloading"
    | "downloaded"
    | "error";
  info?: unknown;
};

declare global {
  interface Window {
    cmaeDesktop?: {
      isDesktop: true;
      platform: NodeJS.Platform;
      arch: string;
      uninstallApp: () => Promise<{ ok: boolean }>;
      getVersion: () => Promise<string>;
      openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>;
      checkForUpdates: () => Promise<{
        ok: boolean;
        reason?: string;
        updateInfo?: unknown;
      }>;
      quitAndInstall: () => Promise<{ ok: boolean; reason?: string }>;
      onUpdateEvent: (handler: (ev: CmaeUpdateEvent) => void) => () => void;
    };
  }
}
