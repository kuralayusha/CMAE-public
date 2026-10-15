import type { LocalePack } from "./types";

export type TVars = Record<string, string | number | null | undefined>;

export function getNested(
  pack: LocalePack,
  key: string,
): string | LocalePack | undefined {
  const parts = key.split(".").filter(Boolean);
  let cur: string | LocalePack | undefined = pack;
  for (const part of parts) {
    if (cur == null || typeof cur === "string") return undefined;
    cur = cur[part];
  }
  return cur;
}

export function lookupString(
  pack: LocalePack,
  key: string,
): string | undefined {
  const v = getNested(pack, key);
  return typeof v === "string" ? v : undefined;
}

export function interpolate(template: string, vars?: TVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = vars[name];
    return v == null ? "" : String(v);
  });
}

/** Pure lookup without disk I/O — safe for client components. */
export function tFromPacks(
  key: string,
  active: LocalePack,
  en: LocalePack,
  vars?: TVars,
): string {
  const raw =
    lookupString(active, key) ?? lookupString(en, key) ?? key;
  return interpolate(raw, vars);
}
