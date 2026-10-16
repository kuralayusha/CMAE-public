import "server-only";

import { loadEnPack } from "@/lib/i18n/pack";
import { lookupString } from "@/lib/i18n/lookup";
import { t } from "@/lib/i18n/t";

export type FolderStatusKind = "canceled" | "error";

const SUFFIX_KEYS: Record<FolderStatusKind, string> = {
  canceled: "folders.suffixCanceled",
  error: "folders.suffixError",
};

/** English + active-pack suffixes (legacy EN always recognized). */
export function folderStatusSuffixes(kind?: FolderStatusKind): string[] {
  const kinds: FolderStatusKind[] = kind
    ? [kind]
    : ["canceled", "error"];
  const out: string[] = [];
  const en = loadEnPack();
  for (const k of kinds) {
    const key = SUFFIX_KEYS[k];
    const active = t(key).trim();
    const english = (lookupString(en, key) || "").trim();
    if (active) out.push(active);
    if (english && english !== active) out.push(english);
  }
  return out;
}

export function folderStatusSuffix(kind: FolderStatusKind): string {
  return t(SUFFIX_KEYS[kind]).trim() || folderStatusSuffixes(kind)[0] || "";
}

export function hasFolderStatusSuffix(
  name: string,
  kind?: FolderStatusKind,
): boolean {
  const base = String(name || "").trim();
  if (!base) return false;
  const lower = base.toLowerCase();
  return folderStatusSuffixes(kind).some((s) =>
    lower.endsWith(s.toLowerCase()),
  );
}

/** Strip canceled/error suffix for display names. */
export function stripFolderStatusSuffix(name: string): string {
  let out = String(name || "").trim();
  for (const s of folderStatusSuffixes()) {
    if (out.toLowerCase().endsWith(s.toLowerCase())) {
      out = out.slice(0, out.length - s.length).trim();
      break;
    }
  }
  return out;
}

/** Client-safe strip using only English + optional locale strings. */
export function stripFolderStatusSuffixClient(
  name: string,
  localizedSuffixes: string[] = [],
): string {
  let out = String(name || "").trim();
  const list = [
    ...localizedSuffixes,
    "(canceled)",
    "(error)",
  ];
  for (const s of list) {
    const needle = s.trim();
    if (!needle) continue;
    if (out.toLowerCase().endsWith(needle.toLowerCase())) {
      out = out.slice(0, out.length - needle.length).trim();
      break;
    }
  }
  return out;
}
