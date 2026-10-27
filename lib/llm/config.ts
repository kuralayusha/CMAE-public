import "server-only";

import { eq } from "drizzle-orm";
import type { AiFeature } from "@/lib/ai-usage/features";
import { decryptOptional } from "@/lib/crypto/encryption";
import { getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";
import { t } from "@/lib/i18n/t";
import { DEFAULT_MODELS, slotForFeature, type ModelSlot } from "./slots";

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

/** Model for a slot: saved choice → built-in default (env pins it on Vercel). */
export function modelForSlot(slot: ModelSlot): string {
  if (isVercel()) {
    return (
      process.env[slot === "fast" ? "CMAE_LLM_MODEL_FAST" : "CMAE_LLM_MODEL_SMART"]?.trim() ||
      DEFAULT_MODELS[slot]
    );
  }
  try {
    const row = getDb().select().from(settings).where(eq(settings.id, 1)).get();
    const saved = (slot === "fast" ? row?.llmModelFast : row?.llmModelSmart)?.trim();
    if (saved) return saved;
  } catch {
    /* fall through to default */
  }
  return DEFAULT_MODELS[slot];
}

export function modelForFeature(feature: AiFeature): string {
  return modelForSlot(slotForFeature(feature));
}
