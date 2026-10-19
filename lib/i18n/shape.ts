import type { LocalePack } from "./types";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/** Keep source shape; fill missing leaves from English. */
export function mergeShape(en: LocalePack, translated: LocalePack): LocalePack {
  const out: LocalePack = {};
  for (const [key, enVal] of Object.entries(en)) {
    const trVal = translated[key];
    if (typeof enVal === "string") {
      out[key] =
        typeof trVal === "string" && trVal.trim() ? trVal : enVal;
    } else if (isPlainObject(enVal)) {
      const child =
        trVal && typeof trVal === "object" && !Array.isArray(trVal)
          ? (trVal as LocalePack)
          : {};
      out[key] = mergeShape(enVal, child);
    }
  }
  return out;
}

/** Count string leaves present in `en` but missing/empty in `pack`. */
export function countMissingLeaves(en: LocalePack, pack: LocalePack): number {
  let n = 0;
  for (const [key, enVal] of Object.entries(en)) {
    const pVal = pack[key];
    if (typeof enVal === "string") {
      if (typeof pVal !== "string" || !pVal.trim()) n += 1;
    } else if (isPlainObject(enVal)) {
      n += countMissingLeaves(
        enVal,
        isPlainObject(pVal) ? (pVal as LocalePack) : {},
      );
    }
  }
  return n;
}

/**
 * Subtree of `en` containing only leaves that are missing/empty in `pack`.
 * Used for incremental LLM translate (new keys only).
 */
export function pickMissingLeaves(en: LocalePack, pack: LocalePack): LocalePack {
  const out: LocalePack = {};
  for (const [key, enVal] of Object.entries(en)) {
    const pVal = pack[key];
    if (typeof enVal === "string") {
      if (typeof pVal !== "string" || !pVal.trim()) {
        out[key] = enVal;
      }
    } else if (isPlainObject(enVal)) {
      const child = pickMissingLeaves(
        enVal,
        isPlainObject(pVal) ? (pVal as LocalePack) : {},
      );
      if (Object.keys(child).length > 0) out[key] = child;
    }
  }
  return out;
}

/** Deep-merge patch into base (patch wins on string leaves). */
export function deepMergePack(base: LocalePack, patch: LocalePack): LocalePack {
  const out: LocalePack = { ...base };
  for (const [key, patchVal] of Object.entries(patch)) {
    const baseVal = out[key];
    if (typeof patchVal === "string") {
      if (patchVal.trim()) out[key] = patchVal;
    } else if (isPlainObject(patchVal)) {
      out[key] = deepMergePack(
        isPlainObject(baseVal) ? (baseVal as LocalePack) : {},
        patchVal,
      );
    }
  }
  return out;
}
