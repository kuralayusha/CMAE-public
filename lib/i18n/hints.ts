import "server-only";

import fs from "node:fs";
import path from "node:path";
import bundledHints from "@/locales/i18n-hints.json";
import type { LocalePack } from "./types";

type HintMap = Record<string, string>;

function loadHintMap(): HintMap {
  const cwd = process.cwd();
  const candidates = [
    path.join(/*turbopackIgnore: true*/ cwd, "locales", "i18n-hints.json"),
    path.join(
      /*turbopackIgnore: true*/ cwd,
      "..",
      "locales",
      "i18n-hints.json",
    ),
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(/*turbopackIgnore: true*/ file)) continue;
      const raw = fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as HintMap;
      }
    } catch {
      /* try next */
    }
  }
  return bundledHints as HintMap;
}

function collectLeafPaths(
  pack: LocalePack,
  prefix: string,
  out: string[],
): void {
  for (const [key, val] of Object.entries(pack)) {
    const pathKey = prefix ? `${prefix}.${key}` : key;
    if (typeof val === "string") {
      out.push(pathKey);
    } else if (val && typeof val === "object" && !Array.isArray(val)) {
      collectLeafPaths(val as LocalePack, pathKey, out);
    }
  }
}

/**
 * Translator notes for leaves present in this section payload.
 * Returned as a compact bullet list for the LLM prompt (or empty string).
 */
export function formatHintsForSection(
  sectionKey: string,
  section: LocalePack,
): string {
  const hints = loadHintMap();
  const paths: string[] = [];
  collectLeafPaths(section, sectionKey, paths);
  const lines: string[] = [];
  for (const p of paths) {
    const note = hints[p];
    if (note && note.trim()) lines.push(`- ${p}: ${note.trim()}`);
  }
  if (!lines.length) return "";
  return `\nKEY CONTEXT (follow these; they override ambiguous English wording):\n${lines.join("\n")}\n`;
}
