import { Agent } from "@cursor/sdk";
import { eq } from "drizzle-orm";
import { decryptOptional } from "@/lib/crypto/encryption";
import { getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";
import { getAgentCwd } from "@/lib/paths";
import { updateSettings } from "@/lib/settings/service";
import {
  loadEnPack,
  loadLocaleMeta,
  loadUserPack,
  saveUserPack,
} from "./pack";
import { APP_LANGUAGE, type LocaleMeta, type LocalePack } from "./types";

async function resolveApiKey(): Promise<string> {
  if (process.env.CURSOR_API_KEY) return process.env.CURSOR_API_KEY;
  const row = getDb().select().from(settings).where(eq(settings.id, 1)).get();
  const key = decryptOptional(row?.cursorApiKeyEnc);
  if (!key) {
    throw new Error(
      "Cursor API key missing — add it in Settings or set CURSOR_API_KEY",
    );
  }
  return key;
}

async function askTranslateLlm(prompt: string): Promise<string> {
  const apiKey = await resolveApiKey();
  const result = await Agent.prompt(prompt, {
    apiKey,
    model: { id: "composer-2.5" },
    local: { cwd: getAgentCwd() },
  });
  if (result.status === "error" || !result.result) {
    throw new Error(
      `Translation LLM did not respond (status=${result.status ?? "unknown"})`,
    );
  }
  return String(result.result).trim();
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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/** Keep source shape; fill missing leaves from English. */
function mergeShape(en: LocalePack, translated: LocalePack): LocalePack {
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

async function translateSection(
  sectionKey: string,
  section: LocalePack,
  targetLanguage: string,
): Promise<LocalePack> {
  const prompt = `You are a professional UI localization engine.
Translate the following JSON object of UI strings from English into language code "${targetLanguage}".

Rules:
- Return ONLY a valid JSON object (no markdown fences, no commentary).
- Keep the exact same keys and nesting.
- Keep placeholders like {name}, {count}, {url}, {agent} unchanged.
- Keep product name "CMAE" unchanged.
- Keep technical tokens like Gmail, IMAP, Cursor, PDF, UID unchanged when they are product/protocol names.
- Natural, concise UI tone for ${targetLanguage}.

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

/**
 * Build user locale pack from shipped English JSON.
 * Writes data/locales/user.json and updates preferredLanguage.
 */
export async function translateLocalePack(
  targetLanguage: string,
): Promise<TranslateResult> {
  const code = targetLanguage.toLowerCase().trim().slice(0, 16) || APP_LANGUAGE;
  const en = loadEnPack();

  let pack: LocalePack;
  let skippedLlm = false;

  if (code === APP_LANGUAGE || code.startsWith("en")) {
    pack = en;
    skippedLlm = true;
  } else {
    // Need Cursor API for non-English packs
    await resolveApiKey();
    const sections = Object.entries(en);
    const out: LocalePack = {};
    for (const [sectionKey, sectionVal] of sections) {
      if (typeof sectionVal === "string") {
        // Rare top-level string — translate as tiny object
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
    pack = mergeShape(en, out);
  }

  const meta = saveUserPack(code, pack);
  updateSettings({ preferredLanguage: code });
  return { code, pack, meta, skippedLlm };
}

/** True when user pack is missing or for a different language. */
export function needsLocaleTranslation(preferredLanguage: string): boolean {
  const code =
    preferredLanguage.toLowerCase().trim().slice(0, 16) || APP_LANGUAGE;
  if (code === APP_LANGUAGE || code.startsWith("en")) {
    return false;
  }
  const meta = loadLocaleMeta();
  const pack = loadUserPack();
  if (!pack || !meta?.code) return true;
  return meta.code.toLowerCase() !== code;
}
