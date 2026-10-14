import { eq } from "drizzle-orm";
import { decryptOptional, encryptOptional } from "@/lib/crypto/encryption";
import { getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";
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

export function getPublicSettings(): SettingsPublic {
  const db = getDb();
  const row = db.select().from(settings).where(eq(settings.id, 1)).get();
  return {
    fullName: row?.fullName ?? null,
    gmailAddress: row?.gmailAddress ?? null,
    hasGmailAppPassword: Boolean(row?.gmailAppPasswordEnc),
    hasCursorApiKey: Boolean(row?.cursorApiKeyEnc),
    cursorApiKeyFromEnv: Boolean(process.env.CURSOR_API_KEY?.trim()),
    cvFileName: row?.cvFileName ?? null,
    hasCv: Boolean(row?.cvText),
    followUpDays: row?.followUpDays ?? 5,
    preferredLanguage: row?.preferredLanguage ?? "tr",
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
  const current = db.select().from(settings).where(eq(settings.id, 1)).get();

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

  db.update(settings)
    .set({
      fullName: input.fullName ?? current?.fullName,
      gmailAddress: input.gmailAddress ?? current?.gmailAddress,
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
        input.preferredLanguage ?? current?.preferredLanguage ?? "tr",
      emailSignature:
        input.emailSignature !== undefined
          ? input.emailSignature.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
          : current?.emailSignature,
      cvText: input.cvText ?? current?.cvText,
      cvFileName: input.cvFileName ?? current?.cvFileName,
      jobPreferencesJson,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(settings.id, 1))
    .run();

  return getPublicSettings();
}

export function getJobPreferences(): JobPreferences {
  return parseJobPreferences(getSettingsRow()?.jobPreferencesJson);
}

export function getGmailCredentials(): {
  address: string;
  appPassword: string;
} | null {
  const db = getDb();
  const row = db.select().from(settings).where(eq(settings.id, 1)).get();
  const address = row?.gmailAddress?.trim();
  const appPassword = decryptOptional(row?.gmailAppPasswordEnc)?.replace(
    /\s+/g,
    "",
  );
  if (!address || !appPassword) return null;
  return { address, appPassword };
}

export function getSettingsRow() {
  const db = getDb();
  return db.select().from(settings).where(eq(settings.id, 1)).get() ?? null;
}
