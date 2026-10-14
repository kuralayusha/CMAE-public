import { Agent } from "@cursor/sdk";
import { eq } from "drizzle-orm";
import { decryptOptional } from "@/lib/crypto/encryption";
import { getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";

async function resolveApiKey(): Promise<string> {
  if (process.env.CURSOR_API_KEY) return process.env.CURSOR_API_KEY;
  const row = getDb().select().from(settings).where(eq(settings.id, 1)).get();
  const key = decryptOptional(row?.cursorApiKeyEnc);
  if (!key) {
    throw new Error("Cursor API key yok — Ayarlar’dan ekleyin veya CURSOR_API_KEY set edin");
  }
  return key;
}

export async function askTrackerLlm(prompt: string): Promise<string> {
  const apiKey = await resolveApiKey();
  const result = await Agent.prompt(prompt, {
    apiKey,
    model: { id: "composer-2.5" },
    local: { cwd: process.cwd() },
  });
  if (result.status === "error" || !result.result) {
    throw new Error(`LLM yanıt vermedi (status=${result.status ?? "unknown"})`);
  }
  return String(result.result).trim();
}

export function extractJson<T>(text: string): T | null {
  const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return null;
  }
}
