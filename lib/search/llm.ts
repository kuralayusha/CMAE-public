import { Agent } from "@cursor/sdk";
import { eq } from "drizzle-orm";
import { decryptOptional } from "@/lib/crypto/encryption";
import { getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";
import { speak } from "./speak";
import type { SpecialistId } from "./types";

async function resolveApiKey(): Promise<string> {
  if (process.env.CURSOR_API_KEY) return process.env.CURSOR_API_KEY;
  const row = getDb().select().from(settings).where(eq(settings.id, 1)).get();
  const key = decryptOptional(row?.cursorApiKeyEnc);
  if (!key) {
    throw new Error("Cursor API key yok — Ayarlar’dan ekleyin veya CURSOR_API_KEY set edin");
  }
  return key;
}

export async function askLlm(
  jobId: string,
  prompt: string,
  label?: string,
  agent: SpecialistId | "conductor" = "conductor",
): Promise<string> {
  speak(
    jobId,
    agent,
    "think",
    label || "Model düşünüyor…",
    "Durum değerlendiriliyor",
  );
  const apiKey = await resolveApiKey();
  const result = await Agent.prompt(prompt, {
    apiKey,
    model: { id: "composer-2.5" },
    local: { cwd: process.cwd() },
  });

  if (result.status === "error" || !result.result) {
    throw new Error(`LLM yanıt vermedi (status=${result.status ?? "unknown"})`);
  }
  const text = String(result.result).trim();
  const preview = text.replace(/\s+/g, " ").slice(0, 160);
  speak(
    jobId,
    agent,
    "think",
    `  ↳ ${preview}${text.length > 160 ? "…" : ""}`,
    `Yanıt alındı: ${preview.slice(0, 90)}${preview.length > 90 ? "…" : ""}`,
  );
  return text;
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
