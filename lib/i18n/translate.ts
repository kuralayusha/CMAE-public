import "server-only";

import { promptWithUsage } from "@/lib/ai-usage";
import { eq } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { decryptOptional } from "@/lib/crypto/encryption";
import { getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";
import { getAgentCwd } from "@/lib/paths";
import { updateSettings } from "@/lib/settings/service";
import { formatHintsForSection } from "./hints";
import { applyLocaleOverrides } from "./overrides";
import {
  loadEnPack,
  loadLocaleMeta,
  loadUserPack,
  saveUserPack,
} from "./pack";
import { isVercelRuntime } from "./remote";
import {
  countMissingLeaves,
  deepMergePack,
  mergeShape,
  pickMissingLeaves,
} from "./shape";
import { t } from "./t";
import { APP_LANGUAGE, type LocaleMeta, type LocalePack } from "./types";

export {
  mergeShape,
  countMissingLeaves,
  pickMissingLeaves,
  deepMergePack,
} from "./shape";

async function resolveApiKey(): Promise<string> {
  if (process.env.CURSOR_API_KEY?.trim()) {
    return process.env.CURSOR_API_KEY.trim();
  }
  // On the remote host, only env key is supported (no local Settings DB).
  if (isVercelRuntime()) {
    throw new Error(
      "CURSOR_API_KEY must be set on the translation server (Vercel env)",
    );
  }
  const row = getDb().select().from(settings).where(eq(settings.id, 1)).get();
  const key = decryptOptional(row?.cursorApiKeyEnc);
  if (!key) {
    throw new Error(t("errors.cursorKeyMissing"));
  }
  return key;
}

/**
 * Cursor SDK persists under `$HOME/.cursor/projects/...`.
 * Vercel home is not writable — relocate HOME + cwd to /tmp before the SDK call.
 */
function ensureWritableCursorHome(): string {
  if (isVercelRuntime()) {
    const home = "/tmp/cmae-home";
    const cwd = "/tmp/cmae-agent";
    process.env.HOME = home;
    process.env.TMPDIR = "/tmp";
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    process.env.XDG_CACHE_HOME = path.join(home, ".cache");
    for (const dir of [
      home,
      cwd,
      path.join(home, ".cursor", "projects"),
      process.env.XDG_CONFIG_HOME,
      process.env.XDG_DATA_HOME,
      process.env.XDG_CACHE_HOME,
    ]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return cwd;
  }
  const cwd = getAgentCwd();
  fs.mkdirSync(cwd, { recursive: true });
  return cwd;
}

async function askTranslateLlm(prompt: string): Promise<string> {
  const cwd = ensureWritableCursorHome();
  const apiKey = await resolveApiKey();
  const result = await promptWithUsage({
    feature: "i18n.translate",
    prompt,
    apiKey,
    cwd,
    model: "composer-2.5",
    emptyError: (status) => new Error(t("errors.llmNoResponse", { status })),
  });
  return result.text;
}

function extractJsonObject(text: string): LocalePack | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as LocalePack;
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function translateSection(
  sectionKey: string,
  section: LocalePack,
  targetLanguage: string,
): Promise<LocalePack> {
  const keyContext = formatHintsForSection(sectionKey, section);
  const prompt = `You are a professional UI localization engine.
Translate the following JSON object of UI strings from English into language code "${targetLanguage}".

Rules:
- Return ONLY a valid JSON object (no markdown fences, no commentary).
- Keep the exact same keys and nesting.
- Keep placeholders like {name}, {count}, {url}, {agent}, {link}, {app}, {fileManager} unchanged (including the braces).
- When a string is one full sentence with a {link}/{app}/{name} slot, translate the whole sentence naturally for that language's word order — do not leave English fragments around the placeholder.
- Keep product name "CMAE" unchanged.
- Keep technical tokens like Gmail, IMAP, Cursor, PDF, UID unchanged when they are product/protocol names.
- Natural, concise UI tone for ${targetLanguage}.
- Prefer sentence case / title case in values (not ALL CAPS). The app uppercases labels in the UI with correct locale rules.
- Part of speech is critical for short UI labels:
  - STATUS / chip / badge / inPanel / *status* keys → adjectival or state form (never an imperative verb).
    Examples: EN "Open" (status) → TR "Açık", DE "Offen", FR "Ouvert" (not Aç / Öffnen / Ouvrir).
    EN "Send"/"Reply" as status chips → state wording (TR "Hazır"/"Yanıt"), not command verbs (Gönder/Yanıtla).
  - BUTTON / action keys (Save, Delete, Cancel, Continue, Back, Close, Expand, Collapse) → imperative is correct.
  - Folder / column / field nouns (Sent, Link, Notes, Label, Period) → nouns, not verbs.
- If KEY CONTEXT is provided below, those notes override ambiguous English wording.
- If target is Turkish (tr): never confuse İ/I/i/ı — dotted i uppercases to İ, dotless ı to I. Do not write ASCII "I" where Turkish "İ" is required.
${keyContext}
Section key: ${sectionKey}
JSON:
${JSON.stringify(section, null, 2)}`;

  const raw = await askTranslateLlm(prompt);
  const parsed = extractJsonObject(raw);
  if (!parsed) {
    throw new Error(`Failed to parse translation for section "${sectionKey}"`);
  }
  return mergeShape(section, parsed);
}

export type TranslateResult = {
  code: string;
  pack: LocalePack;
  meta: LocaleMeta;
  skippedLlm: boolean;
};

export type TranslateOptions = {
  /**
   * Persist pack to disk + update preferredLanguage.
   * False for remote/Vercel translation-only servers (caller saves locally).
   */
  persist?: boolean;
};

/**
 * Build user locale pack from shipped English JSON.
 * Incremental: only missing/new leaves go to the LLM; existing translations are kept.
 * When persist=true (default locally), writes data/locales/user.json.
 */
export async function translateLocalePack(
  targetLanguage: string,
  opts?: TranslateOptions,
): Promise<TranslateResult> {
  const persist = opts?.persist !== false;
  const code = targetLanguage.toLowerCase().trim().slice(0, 16) || APP_LANGUAGE;
  const en = loadEnPack();

  let pack: LocalePack;
  let skippedLlm = false;

  if (code === APP_LANGUAGE || code.startsWith("en")) {
    pack = en;
    skippedLlm = true;
  } else {
    const meta = loadLocaleMeta();
    const existingRaw = loadUserPack();
    const sameLang =
      Boolean(existingRaw) &&
      Boolean(meta?.code) &&
      meta!.code.toLowerCase() === code;
    // Raw prior pack only — do NOT mergeShape(en, …) here or English fillers
    // would hide new keys from pickMissingLeaves.
    const prior: LocalePack = sameLang ? existingRaw! : {};

    const missing = pickMissingLeaves(en, prior);
    const missingCount = countMissingLeaves(en, prior);

    if (missingCount === 0) {
      // en.json changed (hash) but no new keys — keep translations, refresh hash only
      pack = mergeShape(en, prior);
      skippedLlm = true;
    } else {
      await resolveApiKey();
      const out: LocalePack = {};
      for (const [sectionKey, sectionVal] of Object.entries(missing)) {
        if (typeof sectionVal === "string") {
          const tiny = await translateSection(
            sectionKey,
            { value: sectionVal },
            code,
          );
          out[sectionKey] =
            typeof tiny.value === "string" ? tiny.value : sectionVal;
        } else {
          out[sectionKey] = await translateSection(
            sectionKey,
            sectionVal,
            code,
          );
        }
      }
      pack = mergeShape(en, deepMergePack(prior, out));
    }
  }

  // Hand-fixes (POS mistakes, etc.) win over LLM output for every consumer.
  pack = applyLocaleOverrides(code, pack);

  let meta: LocaleMeta = {
    code,
    updatedAt: new Date().toISOString(),
  };
  if (persist) {
    meta = saveUserPack(code, pack);
    updateSettings({ preferredLanguage: code });
  }
  return { code, pack, meta, skippedLlm };
}

/**
 * True when UI needs a translate pass for preferredLanguage.
 * Only missing/new leaves (or language switch / no pack) — not every en.json edit.
 * Hash-only drift is fixed silently in loadActivePack.
 */
export function needsLocaleTranslation(preferredLanguage: string): boolean {
  const code =
    preferredLanguage.toLowerCase().trim().slice(0, 16) || APP_LANGUAGE;
  if (code === APP_LANGUAGE || code.startsWith("en")) {
    return false;
  }
  const meta = loadLocaleMeta();
  const pack = loadUserPack();
  const en = loadEnPack();
  if (!pack || !meta?.code) return true;
  if (meta.code.toLowerCase() !== code) return true;
  // New or empty leaves vs shipped English → incremental LLM translate
  return countMissingLeaves(en, pack) > 0;
}
