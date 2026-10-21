import { promptWithUsage, type AiFeature } from "@/lib/ai-usage";
import { eq } from "drizzle-orm";
import { decryptOptional } from "@/lib/crypto/encryption";
import { getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";
import { t } from "@/lib/i18n/t";
import { getAgentCwd } from "@/lib/paths";
import { throwIfCanceled, whenJobAborted } from "./cancel";
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
  feature: AiFeature,
  prompt: string,
  label?: string,
  agent: SpecialistId | "conductor" = "conductor",
): Promise<string> {
  throwIfCanceled(jobId);
  speak(
    jobId,
    agent,
    "think",
    label || "Model thinking…",
    t("terminal.plain.evaluating"),
  );
  const apiKey = await resolveApiKey();
  throwIfCanceled(jobId);

  // The SDK call has no abort API — promptWithUsage races it against the job
  // abort promise so cancel unblocks the pipeline immediately.
  const result = await promptWithUsage({
    feature,
    prompt,
    apiKey,
    cwd: getAgentCwd(),
    model: "composer-2.5",
    cancelRace: whenJobAborted(jobId),
    emptyError: (status) => new Error(t("errors.llmNoResponse", { status })),
  });

  throwIfCanceled(jobId);

  const text = result.text;
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
