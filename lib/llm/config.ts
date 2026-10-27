import "server-only";

import { eq } from "drizzle-orm";
import type { AiFeature } from "@/lib/ai-usage/features";
import { decryptOptional } from "@/lib/crypto/encryption";
import { getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";
import { t } from "@/lib/i18n/t";
import {
  DEFAULT_MODELS,
  isEffort,
  parseLlmOverrides,
  slotForFeature,
  type LlmChoice,
  type ModelSlot,
} from "./slots";

function isVercel(): boolean {
  return Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
}

function envKey(): string | null {
  return process.env.OPENROUTER_API_KEY?.trim() || null;
}

/** Key saved in Settings (decrypted), or null. Never throws. */
export function savedOpenRouterKey(): string | null {
  try {
    const row = getDb().select().from(settings).where(eq(settings.id, 1)).get();
    return decryptOptional(row?.openrouterApiKeyEnc)?.trim() || null;
  } catch {
    /* corrupt / wrong master key */
    return null;
  }
}

/**
 * The key every model call uses: env first (the Vercel translation host's
 * admin key, or a dev override), then the user's key from Settings. The Vercel
 * host has no per-user SQLite, so only env counts there.
 */
export function resolveOpenRouterKey(): string {
  const fromEnv = envKey();
  if (fromEnv) return fromEnv;
  if (!isVercel()) {
    const saved = savedOpenRouterKey();
    if (saved) return saved;
  }
  throw new Error(t("errors.openrouterKeyMissing"));
}

export function hasOpenRouterKey(): boolean {
  return Boolean(envKey() || (!isVercel() && savedOpenRouterKey()));
}

function settingsRow() {
  try {
    return getDb().select().from(settings).where(eq(settings.id, 1)).get() ?? null;
  } catch {
    /* DB unavailable → built-in defaults */
    return null;
  }
}

function slotChoice(slot: ModelSlot, row: ReturnType<typeof settingsRow>): LlmChoice {
  const model = (slot === "fast" ? row?.llmModelFast : row?.llmModelSmart)?.trim();
  const effort = slot === "fast" ? row?.llmEffortFast : row?.llmEffortSmart;
  return {
    model: model || DEFAULT_MODELS[slot],
    effort: isEffort(effort) ? effort : "",
  };
}

/** Model + effort for a slot: saved choice → built-in default (env pins it on Vercel). */
export function choiceForSlot(slot: ModelSlot): LlmChoice {
  if (isVercel()) {
    const env = process.env[slot === "fast" ? "CMAE_LLM_MODEL_FAST" : "CMAE_LLM_MODEL_SMART"];
    return { model: env?.trim() || DEFAULT_MODELS[slot], effort: "" };
  }
  return slotChoice(slot, settingsRow());
}

export function modelForSlot(slot: ModelSlot): string {
  return choiceForSlot(slot).model;
}

/** Detailed-mode pin for one feature, else its slot's choice. */
export function llmForFeature(feature: AiFeature): LlmChoice {
  if (isVercel()) return choiceForSlot(slotForFeature(feature));
  const row = settingsRow();
  const pinned = parseLlmOverrides(row?.llmOverridesJson)[feature];
  return pinned ?? slotChoice(slotForFeature(feature), row);
}

export function modelForFeature(feature: AiFeature): string {
  return llmForFeature(feature).model;
}

/** Every distinct model+effort the app may call (key check covers all of them). */
export function allConfiguredChoices(): LlmChoice[] {
  const row = isVercel() ? null : settingsRow();
  const list = [
    isVercel() ? choiceForSlot("fast") : slotChoice("fast", row),
    isVercel() ? choiceForSlot("smart") : slotChoice("smart", row),
    ...Object.values(parseLlmOverrides(row?.llmOverridesJson)),
  ];
  const seen = new Set<string>();
  return list.filter((c) => {
    const k = `${c.model}#${c.effort}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
