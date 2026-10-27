import { currentUsageRunId, promptWithUsage, withUsageRunAsync } from "@/lib/ai-usage";
import { ImapFlow } from "imapflow";
import { t } from "@/lib/i18n/t";
import {
  modelForSlot,
  resolveOpenRouterKey,
  savedOpenRouterKey,
} from "@/lib/llm/config";
import { OpenRouterError } from "@/lib/llm/openrouter";
import {
  getGmailCredentials,
  updateSettings,
} from "@/lib/settings/service";

export type VerifyCheck = {
  ok: boolean;
  error?: string;
};

export type OnboardingVerifyResult = {
  gmail: VerifyCheck;
  ai: VerifyCheck;
  ok: boolean;
  /** Which onboarding step to return to on failure */
  failStep?: "gmail" | "ai";
};

/** Persist an env OpenRouter key into SQLite so packaged desktop stays onboarded. */
export function persistEnvOpenRouterKeyIfNeeded(): void {
  if (savedOpenRouterKey()) return;
  const env = process.env.OPENROUTER_API_KEY?.trim();
  if (!env) return;
  updateSettings({ openrouterApiKey: env });
}

/** Live IMAP login against Gmail — does not fetch mail. */
export async function verifyGmailImap(): Promise<VerifyCheck> {
  const creds = getGmailCredentials();
  if (!creds) {
    return {
      ok: false,
      error: t("onboarding.verify.gmailMissing"),
    };
  }

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: creds.address, pass: creds.appPassword },
    logger: false,
  });

  try {
    await client.connect();
    await client.mailboxOpen("INBOX", { readOnly: true });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: humanizeImapError(msg),
    };
  } finally {
    try {
      await client.logout();
    } catch {
      try {
        client.close();
      } catch {
        /* ignore */
      }
    }
  }
}

class NoResponseError extends Error {}

/**
 * Live check of the OpenRouter key AND both model slots (one tiny call per
 * distinct model), so a mistyped slug fails here instead of mid-research.
 */
export async function verifyOpenRouter(): Promise<VerifyCheck> {
  let apiKey: string;
  try {
    apiKey = resolveOpenRouterKey();
  } catch {
    return { ok: false, error: t("onboarding.verify.openrouterMissing") };
  }

  const models = [...new Set([modelForSlot("fast"), modelForSlot("smart")])];
  try {
    // Live check: never cached (feature policy), but its tokens are metered.
    const verify = async () => {
      for (const model of models) {
        try {
          await promptWithUsage({
            feature: "onboarding.verify",
            prompt: "Reply with exactly one word: pong. No other text.",
            apiKey,
            model,
            timeoutMs: 45_000,
            emptyError: (status) =>
              new NoResponseError(
                t("onboarding.verify.openrouterNoResponse", { model, status }),
              ),
          });
        } catch (err) {
          throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
            verifyModel: model,
          });
        }
      }
    };
    if (currentUsageRunId()) await verify();
    else await withUsageRunAsync(globalThis.crypto.randomUUID(), verify);
    persistEnvOpenRouterKeyIfNeeded();
    return { ok: true };
  } catch (err) {
    if (err instanceof NoResponseError) return { ok: false, error: err.message };
    const model = (err as { verifyModel?: string }).verifyModel ?? models[0]!;
    return { ok: false, error: humanizeOpenRouterError(err, model) };
  }
}

export async function verifyOnboardingConnections(): Promise<OnboardingVerifyResult> {
  const gmail = await verifyGmailImap();
  if (!gmail.ok) {
    return { gmail, ai: { ok: false }, ok: false, failStep: "gmail" };
  }

  const ai = await verifyOpenRouter();
  if (!ai.ok) {
    return { gmail, ai, ok: false, failStep: "ai" };
  }

  return { gmail, ai, ok: true };
}

function humanizeImapError(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes("invalid credentials") || m.includes("authentication failed")) {
    return t("onboarding.verify.gmailRejected");
  }
  if (m.includes("application-specific password")) {
    return t("onboarding.verify.gmailAppPasswordRequired");
  }
  if (m.includes("timeout") || m.includes("timed out")) {
    return t("onboarding.verify.gmailTimeout");
  }
  return msg.slice(0, 200);
}

function humanizeOpenRouterError(err: unknown, model: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  const status = err instanceof OpenRouterError ? err.status : 0;
  const m = msg.toLowerCase();
  if (status === 401 || status === 403 || m.includes("no auth") || m.includes("invalid api key")) {
    return t("onboarding.verify.openrouterInvalid");
  }
  if (status === 402) return t("onboarding.verify.openrouterCredits");
  if (status === 404 || m.includes("no endpoints") || m.includes("not a valid model")) {
    return t("onboarding.verify.openrouterModel", { model });
  }
  if (status === 429) return t("onboarding.verify.openrouterRateLimit");
  if (m.includes("timeout") || m.includes("timed out")) {
    return t("onboarding.verify.openrouterTimeout");
  }
  return msg.slice(0, 200);
}
