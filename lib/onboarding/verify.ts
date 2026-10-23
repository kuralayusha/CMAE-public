import { currentUsageRunId, promptWithUsage, withUsageRunAsync } from "@/lib/ai-usage";
import { ImapFlow } from "imapflow";
import { eq } from "drizzle-orm";
import { decryptOptional } from "@/lib/crypto/encryption";
import { getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";
import { t } from "@/lib/i18n/t";
import { getAgentCwd } from "@/lib/paths";
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
  cursor: VerifyCheck;
  ok: boolean;
  /** Which onboarding step to return to on failure */
  failStep?: "gmail" | "cursor";
};

function resolveCursorApiKey(): string | null {
  try {
    const row = getDb().select().from(settings).where(eq(settings.id, 1)).get();
    const fromDb = decryptOptional(row?.cursorApiKeyEnc)?.trim();
    if (fromDb) return fromDb;
  } catch {
    /* corrupt/wrong master key — fall through to env */
  }
  return process.env.CURSOR_API_KEY?.trim() || null;
}

/** Persist env Cursor key into SQLite so packaged desktop stays onboarded. */
export function persistEnvCursorKeyIfNeeded(): void {
  try {
    const row = getDb().select().from(settings).where(eq(settings.id, 1)).get();
    if (decryptOptional(row?.cursorApiKeyEnc)?.trim()) return;
  } catch {
    /* treat as missing */
  }
  const env = process.env.CURSOR_API_KEY?.trim();
  if (!env) return;
  updateSettings({ cursorApiKey: env });
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

/** Live Cursor SDK call — confirms the API key works. */
export async function verifyCursorApiKey(): Promise<VerifyCheck> {
  const apiKey = resolveCursorApiKey();
  if (!apiKey) {
    return { ok: false, error: t("onboarding.verify.cursorMissing") };
  }

  try {
    // Live check: never cached (feature policy), but its tokens are metered.
    const verify = () =>
      promptWithUsage({
        feature: "onboarding.verify",
        prompt: "Reply with exactly one word: pong. No other text.",
        apiKey,
        cwd: getAgentCwd(),
        model: "composer-2.5",
        emptyError: (status) =>
          new NoResponseError(t("onboarding.verify.cursorNoResponse", { status })),
      });
    if (currentUsageRunId()) await verify();
    else await withUsageRunAsync(globalThis.crypto.randomUUID(), verify);
    persistEnvCursorKeyIfNeeded();
    return { ok: true };
  } catch (err) {
    if (err instanceof NoResponseError) return { ok: false, error: err.message };
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: humanizeCursorError(msg) };
  }
}

export async function verifyOnboardingConnections(): Promise<OnboardingVerifyResult> {
  const gmail = await verifyGmailImap();
  if (!gmail.ok) {
    return { gmail, cursor: { ok: false }, ok: false, failStep: "gmail" };
  }

  const cursor = await verifyCursorApiKey();
  if (!cursor.ok) {
    return { gmail, cursor, ok: false, failStep: "cursor" };
  }

  return { gmail, cursor, ok: true };
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

function humanizeCursorError(msg: string): string {
  const m = msg.toLowerCase();
  if (
    m.includes("unauthorized") ||
    m.includes("401") ||
    m.includes("invalid") ||
    m.includes("api key")
  ) {
    return t("onboarding.verify.cursorInvalid");
  }
  if (m.includes("timeout") || m.includes("timed out")) {
    return t("onboarding.verify.cursorTimeout");
  }
  return msg.slice(0, 200);
}
