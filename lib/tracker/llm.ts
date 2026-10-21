import { eq } from "drizzle-orm";
import { decryptOptional } from "@/lib/crypto/encryption";
import { getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";
import { t } from "@/lib/i18n/t";
import { getAgentCwd } from "@/lib/paths";
import { promptLlm, TRACKER_LLM_TIMEOUT_MS } from "./llm-core";

export { extractJson, TRACKER_LLM_MODEL } from "./llm-core";

async function resolveApiKey(): Promise<string> {
  if (process.env.CURSOR_API_KEY) return process.env.CURSOR_API_KEY;
  const row = getDb().select().from(settings).where(eq(settings.id, 1)).get();
  const key = decryptOptional(row?.cursorApiKeyEnc);
  if (!key) {
    throw new Error(t("errors.cursorKeyMissing"));
  }
  return key;
}

export async function askTrackerLlm(prompt: string): Promise<string> {
  const apiKey = await resolveApiKey();
  return promptLlm({
    prompt,
    apiKey,
    cwd: getAgentCwd(),
    timeoutMs: TRACKER_LLM_TIMEOUT_MS,
    timeoutError: () =>
      new Error(
        t("errors.llmTimeout", { seconds: TRACKER_LLM_TIMEOUT_MS / 1000 }),
      ),
    emptyError: (status) => new Error(t("errors.llmNoResponse", { status })),
  });
}
