import { Agent } from "@cursor/sdk";
import { eq } from "drizzle-orm";
import { decryptOptional } from "@/lib/crypto/encryption";
import { getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";
import { t } from "@/lib/i18n/t";
import { getAgentCwd } from "@/lib/paths";

async function resolveApiKey(): Promise<string> {
  if (process.env.CURSOR_API_KEY) return process.env.CURSOR_API_KEY;
  const row = getDb().select().from(settings).where(eq(settings.id, 1)).get();
  const key = decryptOptional(row?.cursorApiKeyEnc);
  if (!key) {
    throw new Error(t("errors.cursorKeyMissing"));
  }
  return key;
}

const LLM_TIMEOUT_MS = 90_000;

export async function askTrackerLlm(prompt: string): Promise<string> {
  const apiKey = await resolveApiKey();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Agent.prompt(prompt, {
        apiKey,
        model: { id: "composer-2.5" },
        local: { cwd: getAgentCwd() },
      }),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(t("errors.llmTimeout", { seconds: 90 })));
        }, LLM_TIMEOUT_MS);
      }),
    ]);
    if (result.status === "error" || !result.result) {
      throw new Error(
        t("errors.llmNoResponse", { status: result.status ?? "unknown" }),
      );
    }
    return String(result.result).trim();
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
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
