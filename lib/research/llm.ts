import { Agent } from "@cursor/sdk";
import { eq } from "drizzle-orm";
import { decryptOptional } from "@/lib/crypto/encryption";
import { getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";
import { t } from "@/lib/i18n/t";
import { getAgentCwd } from "@/lib/paths";
import { speak } from "./speak";
import type { SpecialistId } from "./types";

async function resolveApiKey(): Promise<string> {
  if (process.env.CURSOR_API_KEY) return process.env.CURSOR_API_KEY;
  const row = getDb().select().from(settings).where(eq(settings.id, 1)).get();
  const key = decryptOptional(row?.cursorApiKeyEnc);
  if (!key) {
    throw new Error(t("errors.cursorKeyMissing"));
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
    label || "Model thinking…",
    "Evaluating status",
  );
  const apiKey = await resolveApiKey();
  const result = await Agent.prompt(prompt, {
    apiKey,
    model: { id: "composer-2.5" },
    local: { cwd: getAgentCwd() },
  });

  if (result.status === "error" || !result.result) {
    throw new Error(
      t("errors.llmNoResponse", { status: result.status ?? "unknown" }),
    );
  }
  const text = String(result.result).trim();
  const preview = text.replace(/\s+/g, " ").slice(0, 160);
  speak(
    jobId,
    agent,
    "think",
    `  ↳ ${preview}${text.length > 160 ? "…" : ""}`,
    `Response received: ${preview.slice(0, 90)}${preview.length > 90 ? "…" : ""}`,
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
