import { Agent } from "@cursor/sdk";
import { ImapFlow } from "imapflow";
import { eq } from "drizzle-orm";
import { decryptOptional } from "@/lib/crypto/encryption";
import { getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";
import { getGmailCredentials } from "@/lib/settings/service";

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
  const env = process.env.CURSOR_API_KEY?.trim();
  if (env) return env;
  const row = getDb().select().from(settings).where(eq(settings.id, 1)).get();
  return decryptOptional(row?.cursorApiKeyEnc)?.trim() || null;
}

/** Live IMAP login against Gmail — does not fetch mail. */
export async function verifyGmailImap(): Promise<VerifyCheck> {
  const creds = getGmailCredentials();
  if (!creds) {
    return {
      ok: false,
      error: "Gmail adresi veya App Password eksik",
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

/** Live Cursor SDK call — confirms the API key works. */
export async function verifyCursorApiKey(): Promise<VerifyCheck> {
  const apiKey = resolveCursorApiKey();
  if (!apiKey) {
    return { ok: false, error: "Cursor API key eksik" };
  }

  try {
    const result = await Agent.prompt(
      "Reply with exactly one word: pong. No other text.",
      {
        apiKey,
        model: { id: "composer-2.5" },
        local: { cwd: process.cwd() },
      },
    );

    if (result.status === "error" || !result.result) {
      return {
        ok: false,
        error: `Cursor API yanıt vermedi (status=${result.status ?? "unknown"})`,
      };
    }
    return { ok: true };
  } catch (err) {
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
    return "Gmail girişi reddedildi — adresi ve App Password’ü kontrol et";
  }
  if (m.includes("application-specific password")) {
    return "App Password gerekli — Google hesabında uygulama şifresi oluştur";
  }
  if (m.includes("timeout") || m.includes("timed out")) {
    return "Gmail’e bağlanırken zaman aşımı — tekrar dene";
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
    return "Cursor API key geçersiz veya yetkisiz — dashboard’dan yeni key al";
  }
  if (m.includes("timeout") || m.includes("timed out")) {
    return "Cursor API zaman aşımı — tekrar dene";
  }
  return msg.slice(0, 200);
}
