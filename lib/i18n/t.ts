import "server-only";

import { loadActivePack, loadEnPack } from "./pack";
import { interpolate, lookupString, type TVars } from "./lookup";
import type { LocalePack } from "./types";

export type { TVars };

/** Server-only: resolve a key from active (user) pack with English fallback. */
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
