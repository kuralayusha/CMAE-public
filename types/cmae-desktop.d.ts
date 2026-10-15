export {};

declare global {
  interface Window {
    cmaeDesktop?: {
      isDesktop: true;
      uninstallApp: () => Promise<{ ok: boolean }>;
    };
  }
}
