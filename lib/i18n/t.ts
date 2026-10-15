import { loadActivePack, loadEnPack, lookupString } from "./pack";
import type { LocalePack } from "./types";

export type TVars = Record<string, string | number | null | undefined>;

export function interpolate(template: string, vars?: TVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = vars[name];
    return v == null ? "" : String(v);
  });
}

/** Resolve a key from active (user) pack with English fallback. */
export function t(
  key: string,
  vars?: TVars,
  packs?: { active?: LocalePack; en?: LocalePack },
): string {
  const en = packs?.en ?? loadEnPack();
  const active = packs?.active ?? loadActivePack().pack;
  const raw =
    lookupString(active, key) ?? lookupString(en, key) ?? key;
  return interpolate(raw, vars);
}

/** Pure lookup without disk I/O — for client hook. */
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
