/** OS file manager display names for UI (client or server). */

export type FileManagerKind = "finder" | "explorer" | "files";

export function detectFileManagerKind(
  platform?: string,
): FileManagerKind {
  const p = (platform || "").toLowerCase();
  if (p === "darwin" || p === "mac" || p === "macos") return "finder";
  if (p === "win32" || p === "windows" || p.startsWith("win")) return "explorer";
  if (typeof navigator !== "undefined") {
    const ua = navigator.userAgent || "";
    const navPlat = navigator.platform || "";
    if (/Mac/i.test(ua) || /Mac/i.test(navPlat)) return "finder";
    if (/Win/i.test(ua) || /Win/i.test(navPlat)) return "explorer";
  }
  return "files";
}

export function fileManagerLabel(kind: FileManagerKind): string {
  if (kind === "finder") return "Finder";
  if (kind === "explorer") return "Explorer";
  return "Files";
}

export function openInFileManagerLabel(kind: FileManagerKind): string {
  return `Open in ${fileManagerLabel(kind)}`;
}

export function showInFileManagerTitle(kind: FileManagerKind): string {
  return `Show in ${fileManagerLabel(kind)}`;
}

export function couldNotOpenFileManager(kind: FileManagerKind): string {
  return `Could not open ${fileManagerLabel(kind)}`;
}
