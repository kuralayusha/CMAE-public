import { eq } from "drizzle-orm";
import { decryptOptional, encryptOptional } from "@/lib/crypto/encryption";
import {
  normalizeAccountId,
  setAppMeta,
} from "@/lib/db/app-meta";
import { getDb, getSqlite } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";
import { notifyCredentialsChanged } from "@/lib/sync/credentials";
import {
  type JobPreferences,
  parseJobPreferences,
  serializeJobPreferences,
} from "./preferences";

export type SettingsPublic = {
  fullName: string | null;
  gmailAddress: string | null;
  hasGmailAppPassword: boolean;
  /** True only when a key is stored in SQLite (not .env). */
  hasCursorApiKey: boolean;
  /** True when process.env.CURSOR_API_KEY is set (survives data wipe). */
  cursorApiKeyFromEnv: boolean;
  cvFileName: string | null;
  hasCv: boolean;
  followUpDays: number;
  preferredLanguage: string;
  /** Newlines preserved as stored */
  emailSignature: string | null;
  jobPreferences: JobPreferences;
  onboardingCompletedAt: string | null;
  updatedAt: string | null;
};

function hasDecryptableSecret(enc: string | null | undefined): boolean {
  if (!enc?.trim()) return false;
  try {
    return Boolean(decryptOptional(enc)?.trim());
  } catch {
    return false;
  }
}

function ensureSettingsRow() {
  const db = getDb();
  const row = db.select().from(settings).where(eq(settings.id, 1)).get();
  if (row) return row;
  db.insert(settings)
    .values({
      id: 1,
      followUpDays: 5,
      preferredLanguage: "en",
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoNothing()
    .run();
  return db.select().from(settings).where(eq(settings.id, 1)).get() ?? null;
}

export function getPublicSettings(): SettingsPublic {
  const row = ensureSettingsRow();
  return {
    fullName: row?.fullName ?? null,
    gmailAddress: row?.gmailAddress ?? null,
    hasGmailAppPassword: hasDecryptableSecret(row?.gmailAppPasswordEnc),
    /** Decryptable key in SQLite only — .env alone does not count as "saved". */
    hasCursorApiKey: hasDecryptableSecret(row?.cursorApiKeyEnc),
    cursorApiKeyFromEnv: Boolean(process.env.CURSOR_API_KEY?.trim()),
    cvFileName: row?.cvFileName ?? null,
    hasCv: Boolean(row?.cvText),
    followUpDays: row?.followUpDays ?? 5,
    preferredLanguage: row?.preferredLanguage ?? "en",
    emailSignature: row?.emailSignature ?? null,
    jobPreferences: parseJobPreferences(row?.jobPreferencesJson),
    onboardingCompletedAt: row?.onboardingCompletedAt ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

export function updateSettings(input: {
  fullName?: string;
  gmailAddress?: string;
  gmailAppPassword?: string;
  cursorApiKey?: string;
  followUpDays?: number;
  preferredLanguage?: string;
  /** Pass string (incl. "") to set; omit to keep current. Newlines kept as-is. */
  emailSignature?: string;
  cvText?: string;
  cvFileName?: string;
  jobPreferences?: JobPreferences | Partial<JobPreferences>;
}) {
  const db = getDb();
  const current = ensureSettingsRow();

  let jobPreferencesJson = current?.jobPreferencesJson ?? null;
  if (input.jobPreferences !== undefined) {
    const merged = {
      ...parseJobPreferences(current?.jobPreferencesJson),
      ...input.jobPreferences,
      workTypes:
        input.jobPreferences.workTypes !== undefined
          ? input.jobPreferences.workTypes
          : parseJobPreferences(current?.jobPreferencesJson).workTypes,
    };
    jobPreferencesJson = serializeJobPreferences(
      parseJobPreferences(serializeJobPreferences(merged as JobPreferences)),
    );
  }

  // Empty strings must not clobber already-saved fields (wipe→wizard race /
  // Strict Mode hydrate then accidental empty PUT).
  const keepOrSet = (
    incoming: string | undefined,
    existing: string | null | undefined,
  ) => {
    if (incoming === undefined) return existing;
    if (incoming.trim()) return incoming;
    return existing?.trim() ? existing : incoming;
  };

  const next = {
    fullName: keepOrSet(input.fullName, current?.fullName),
    gmailAddress: keepOrSet(input.gmailAddress, current?.gmailAddress),
    gmailAppPasswordEnc:
      input.gmailAppPassword !== undefined && input.gmailAppPassword !== ""
        ? encryptOptional(input.gmailAppPassword)
        : current?.gmailAppPasswordEnc,
    cursorApiKeyEnc:
      input.cursorApiKey !== undefined && input.cursorApiKey !== ""
        ? encryptOptional(input.cursorApiKey)
        : current?.cursorApiKeyEnc,
    followUpDays: input.followUpDays ?? current?.followUpDays ?? 5,
    preferredLanguage:
      keepOrSet(input.preferredLanguage, current?.preferredLanguage) ?? "en",
    emailSignature:
      input.emailSignature !== undefined
        ? (() => {
            const normalized = input.emailSignature
              .replace(/\r\n/g, "\n")
              .replace(/\r/g, "\n");
            if (normalized.trim()) return normalized;
            return current?.emailSignature?.trim()
              ? current.emailSignature
              : normalized;
          })()
        : current?.emailSignature,
    cvText: input.cvText !== undefined ? input.cvText : current?.cvText,
    cvFileName:
      input.cvFileName !== undefined ? input.cvFileName : current?.cvFileName,
    jobPreferencesJson,
    updatedAt: new Date().toISOString(),
  };

  const credsChanged =
    (input.gmailAppPassword !== undefined && input.gmailAppPassword !== "") ||
    (input.gmailAddress !== undefined &&
      normalizeAccountId(input.gmailAddress) !==
        normalizeAccountId(current?.gmailAddress));

  const result = db
    .update(settings)
    .set(next)
    .where(eq(settings.id, 1))
    .run();

  if (!result.changes) {
    db.insert(settings)
      .values({
        id: 1,
        ...next,
        onboardingCompletedAt: current?.onboardingCompletedAt ?? null,
      })
      .onConflictDoUpdate({
        target: settings.id,
        set: next,
      })
      .run();
  }

  if (credsChanged) {
    const accountId = normalizeAccountId(next.gmailAddress);
    if (accountId) {
      setAppMeta("account_id", accountId, getSqlite());
    }
    notifyCredentialsChanged();
  }

  return getPublicSettings();
}

export function getJobPreferences(): JobPreferences {
  return parseJobPreferences(getSettingsRow()?.jobPreferencesJson);
}

export function getGmailCredentials(): {
  address: string;
  appPassword: string;
} | null {
  const row = ensureSettingsRow();
  const address = row?.gmailAddress?.trim();
  const appPassword = decryptOptional(row?.gmailAppPasswordEnc)?.replace(
    /\s+/g,
    "",
  );
  if (!address || !appPassword) return null;
  return { address, appPassword };
}

export function getSettingsRow() {
  return ensureSettingsRow();
}
