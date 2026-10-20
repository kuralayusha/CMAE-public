import "server-only";

import fs from "node:fs";
import path from "node:path";
import trOverrides from "@/locales/overrides/tr.json";
import { deepMergePack } from "./shape";
import type { LocalePack } from "./types";

/** Bundled corrections — always available even when disk tracing misses files. */
const BUNDLED: Record<string, LocalePack> = {
  tr: trOverrides as LocalePack,
};

function overridesDir(): string {
  const cwd = process.cwd();
  const candidates = [
    path.join(/*turbopackIgnore: true*/ cwd, "locales", "overrides"),
    path.join(/*turbopackIgnore: true*/ cwd, "..", "locales", "overrides"),
    path.join(
      /*turbopackIgnore: true*/ cwd,
      ".next",
      "standalone",
      "locales",
      "overrides",
    ),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(/*turbopackIgnore: true*/ dir)) return dir;
  }
  return candidates[0]!;
}

function readOverrideFile(code: string): LocalePack | null {
  try {
    const file = path.join(
      /*turbopackIgnore: true*/ overridesDir(),
      `${code}.json`,
    );
    if (!fs.existsSync(/*turbopackIgnore: true*/ file)) return null;
    const raw = fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as LocalePack;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Language codes to try for overrides (most specific first).
 * "tr-TR" → ["tr-TR", "tr"]
 */
export function overrideCodeCandidates(lang: string): string[] {
  const code = lang.toLowerCase().trim().slice(0, 16);
  if (!code || code === "en" || code.startsWith("en")) return [];
  const out: string[] = [];
  if (code) out.push(code);
  const base = code.split("-")[0];
  if (base && base !== code) out.push(base);
  return out;
}

/** Shipped hand-fixes for a locale (LLM mistakes, POS ambiguity, etc.). */
export function loadLocaleOverrides(lang: string): LocalePack | null {
  let merged: LocalePack | null = null;
  // Apply base then specific so tr-TR can refine tr
  for (const code of [...overrideCodeCandidates(lang)].reverse()) {
    const fromDisk = readOverrideFile(code);
    const bundled = BUNDLED[code];
    const layer = deepMergePack(bundled || {}, fromDisk || {});
    if (Object.keys(layer).length === 0) continue;
    merged = merged ? deepMergePack(merged, layer) : layer;
  }
  return merged && Object.keys(merged).length > 0 ? merged : null;
}

/** Apply shipped overrides on top of a translated pack (overrides win). */
export function applyLocaleOverrides(
  lang: string,
  pack: LocalePack,
): LocalePack {
  const overrides = loadLocaleOverrides(lang);
  if (!overrides) return pack;
  return deepMergePack(pack, overrides);
}
