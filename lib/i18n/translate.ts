import "server-only";

import {
  promptWithUsage,
  readStampedUsage,
  withUsageRunAsync,
  type PromptWithUsageResult,
} from "@/lib/ai-usage";
import { modelForFeature, resolveOpenRouterKey } from "@/lib/llm/config";
import { updateSettings } from "@/lib/settings/service";
import { formatHintsForSection } from "./hints";
import { mapPool } from "./pool";
import { applyLocaleOverrides } from "./overrides";
import {
  loadEnPack,
  loadLocaleMeta,
  loadUserPack,
  saveUserPack,
} from "./pack";
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

/**
 * Translation key: on the Vercel host it is the admin OpenRouter key from env
 * (the maintainer pays for language packs); on a desktop that opted out of the
 * remote host (CMAE_I18N_URL=local) it is the user's own key.
 */
function translateModel(): string {
  return process.env.CMAE_I18N_MODEL?.trim() || modelForFeature("i18n.translate");
}

/**
 * Sections translated at once. A full pack is ~20 independent model calls; run
 * one after another it took ~250 s of the host's 300 s budget. 5 keeps well
 * inside OpenRouter's rate limits for a small model.
 */
const TRANSLATE_CONCURRENCY = 5;

export type TranslateUsageCall = {
  feature: "i18n.translate";
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costMicroUsd: number;
  durationMs: number;
  cached: boolean;
  usageMissing: boolean;
};

function usageCallFrom(
  result: Pick<
    PromptWithUsageResult,
    "usage" | "cached" | "costMicroUsd" | "durationMs"
  >,
  model: string,
): TranslateUsageCall {
  const u = result.usage;
  return {
    feature: "i18n.translate",
    model,
    inputTokens: u?.inputTokens ?? 0,
    outputTokens: u?.outputTokens ?? 0,
    cacheReadTokens: u?.cacheReadTokens ?? 0,
    cacheWriteTokens: u?.cacheWriteTokens ?? 0,
    reasoningTokens: u?.reasoningTokens ?? 0,
    costMicroUsd: result.costMicroUsd,
    durationMs: result.durationMs,
    cached: result.cached,
    usageMissing: !result.cached && u === null,
  };
}

async function askTranslateLlm(
  prompt: string,
  sink: TranslateUsageCall[],
): Promise<string> {
  const apiKey = resolveOpenRouterKey();
  const model = translateModel();
  try {
    const result = await promptWithUsage({
      feature: "i18n.translate",
      prompt,
      apiKey,
      model,
      emptyError: (status) => new Error(t("errors.llmNoResponse", { status })),
    });
    sink.push(usageCallFrom(result, model));
    return result.text;
  } catch (err) {
    const stamped = readStampedUsage(err);
    if (stamped) sink.push(usageCallFrom(stamped, model));
    throw err;
  }
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
  sink: TranslateUsageCall[],
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
- Keep technical tokens like Gmail, IMAP, OpenRouter, PDF, UID unchanged when they are product/protocol names.
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

  const raw = await askTranslateLlm(prompt, sink);
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
  /** Set when this pass called the model. Null when nothing was translated. */
  usageRunId: string | null;
  /** One entry per model call, including a failed call that threw afterwards. */
  usageCalls: TranslateUsageCall[];
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
  let usageRunId: string | null = null;
  const usageCalls: TranslateUsageCall[] = [];

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
      resolveOpenRouterKey();
      const out: LocalePack = {};
      const translateRunId = globalThis.crypto.randomUUID();
      usageRunId = translateRunId;
      try {
        await withUsageRunAsync(translateRunId, async () => {
          const entries = Object.entries(missing);
          const translated = await mapPool(
            entries,
            TRANSLATE_CONCURRENCY,
            async ([sectionKey, sectionVal]) => {
              if (typeof sectionVal === "string") {
                const tiny = await translateSection(
                  sectionKey,
                  { value: sectionVal },
                  code,
                  usageCalls,
                );
                return typeof tiny.value === "string" ? tiny.value : sectionVal;
              }
              return translateSection(sectionKey, sectionVal, code, usageCalls);
            },
          );
          // Results come back in input order, so `out` keeps the pack's key order.
          entries.forEach(([sectionKey], i) => {
            out[sectionKey] = translated[i]!;
          });
        });
      } catch (err) {
        if (err && typeof err === "object") {
          Object.assign(err, { usageRunId, usageCalls });
        }
        throw err;
      }
      // Assign outside the ALS callback so TS sees definite assignment.
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
  return { code, pack, meta, skippedLlm, usageRunId, usageCalls };
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
