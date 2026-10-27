import { eq } from "drizzle-orm";
import { decryptOptional, encryptOptional } from "@/lib/crypto/encryption";
import {
  normalizeAccountId,
  setAppMeta,
} from "@/lib/db/app-meta";
import { isTelemetryEnabled } from "@/lib/ai-usage/store";
import { getDb, getSqlite } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";
import { DEFAULT_MODELS, type ModelSlot } from "@/lib/llm/slots";
import { notifyCredentialsChanged } from "@/lib/sync/credentials";
import {
  DEFAULT_FOLLOW_UP_DAYS,
  DEFAULT_REJECTION_CLOSE_DAYS,
  DEFAULT_STALE_CLOSE_DAYS,
  statusSettingsFromRow,
  type StatusSettings,
} from "@/lib/tracker/status-constants";
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
  hasOpenrouterApiKey: boolean;
  /** True when process.env.OPENROUTER_API_KEY is set (survives data wipe). */
  openrouterApiKeyFromEnv: boolean;
  /** Effective OpenRouter slugs (saved choice or built-in default). */
  llmModelFast: string;
  llmModelSmart: string;
  /** False while the slot still uses the built-in default. */
  llmModelFastCustom: boolean;
  llmModelSmartCustom: boolean;
  cvFileName: string | null;
  hasCv: boolean;
  followUpDays: number;
  /** Rejected → closed after this many days without a thank-you */
  rejectionCloseDays: number;
  /** No human reply this many days after the last outbound → closed */
  staleCloseDays: number;
  preferredLanguage: string;
  /** Newlines preserved as stored */
  emailSignature: string | null;
  jobPreferences: JobPreferences;
  onboardingCompletedAt: string | null;
  /** Anonymous AI usage counters upload (default on). */
  usageTelemetryEnabled: boolean;
  updatedAt: string | null;
};

/** Store a slot only when it differs from the built-in default (so default upgrades still apply). */
function slotOverride(raw: string, slot: ModelSlot): string | null {
  const v = raw.trim();
  return !v || v === DEFAULT_MODELS[slot] ? null : v;
}

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
      followUpDays: DEFAULT_FOLLOW_UP_DAYS,
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
    hasOpenrouterApiKey: hasDecryptableSecret(row?.openrouterApiKeyEnc),
    openrouterApiKeyFromEnv: Boolean(process.env.OPENROUTER_API_KEY?.trim()),
    llmModelFast: row?.llmModelFast?.trim() || DEFAULT_MODELS.fast,
    llmModelSmart: row?.llmModelSmart?.trim() || DEFAULT_MODELS.smart,
    llmModelFastCustom: Boolean(row?.llmModelFast?.trim()),
    llmModelSmartCustom: Boolean(row?.llmModelSmart?.trim()),
    cvFileName: row?.cvFileName ?? null,
    hasCv: Boolean(row?.cvText),
    followUpDays: row?.followUpDays ?? DEFAULT_FOLLOW_UP_DAYS,
    rejectionCloseDays:
      row?.rejectionCloseDays ?? DEFAULT_REJECTION_CLOSE_DAYS,
    staleCloseDays: row?.staleCloseDays ?? DEFAULT_STALE_CLOSE_DAYS,
    preferredLanguage: row?.preferredLanguage ?? "en",
    emailSignature: row?.emailSignature ?? null,
    jobPreferences: parseJobPreferences(row?.jobPreferencesJson),
    onboardingCompletedAt: row?.onboardingCompletedAt ?? null,
    usageTelemetryEnabled: isTelemetryEnabled(getSqlite()),
    updatedAt: row?.updatedAt ?? null,
  };
}

export function updateSettings(input: {
  fullName?: string;
  gmailAddress?: string;
  gmailAppPassword?: string;
  openrouterApiKey?: string;
  /** OpenRouter slug; "" resets the slot to the built-in default. */
  llmModelFast?: string;
  llmModelSmart?: string;
  followUpDays?: number;
  rejectionCloseDays?: number;
  staleCloseDays?: number;
  preferredLanguage?: string;
  /** Pass string (incl. "") to set; omit to keep current. Newlines kept as-is. */
  emailSignature?: string;
  cvText?: string;
  cvFileName?: string;
  jobPreferences?: JobPreferences | Partial<JobPreferences>;
  usageTelemetryEnabled?: boolean;
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
    openrouterApiKeyEnc:
      input.openrouterApiKey !== undefined && input.openrouterApiKey !== ""
        ? encryptOptional(input.openrouterApiKey)
        : current?.openrouterApiKeyEnc,
    llmModelFast:
      input.llmModelFast !== undefined
        ? slotOverride(input.llmModelFast, "fast")
        : current?.llmModelFast,
    llmModelSmart:
      input.llmModelSmart !== undefined
        ? slotOverride(input.llmModelSmart, "smart")
        : current?.llmModelSmart,
    followUpDays:
      input.followUpDays ?? current?.followUpDays ?? DEFAULT_FOLLOW_UP_DAYS,
    rejectionCloseDays:
      input.rejectionCloseDays ??
      current?.rejectionCloseDays ??
      DEFAULT_REJECTION_CLOSE_DAYS,
    staleCloseDays:
      input.staleCloseDays ??
      current?.staleCloseDays ??
      DEFAULT_STALE_CLOSE_DAYS,
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
    // Demo lock: anonymous usage sharing stays on no matter what the client sends.
    usageTelemetryEnabled: true,
    updatedAt: new Date().toISOString(),
  };

  const oldAccount = normalizeAccountId(current?.gmailAddress);
  const newAccount = normalizeAccountId(next.gmailAddress);
  const addressChanged =
    Boolean(input.gmailAddress !== undefined) &&
    Boolean(newAccount) &&
    oldAccount !== newAccount;
  /** Different Gmail identity — K2 wipe must run before (or with) this write. */
  const isAccountSwitch = Boolean(oldAccount && newAccount && addressChanged);
  const passwordChanged =
    input.gmailAppPassword !== undefined && input.gmailAppPassword !== "";
  const credsChanged = passwordChanged || addressChanged;

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

  // Account switch: executeAccountSwitch already set account_id + fencing.
  // Same-address / first-set: update fencing tokens here.
  if (credsChanged && !isAccountSwitch) {
    const accountId = normalizeAccountId(next.gmailAddress);
    if (accountId) {
      setAppMeta("account_id", accountId, getSqlite());
    }
    notifyCredentialsChanged();
  }

  return getPublicSettings();
}

/** True when saving would change Gmail identity (K2). */
export function wouldSwitchGmailAccount(
  nextGmailAddress: string | undefined,
): boolean {
  if (nextGmailAddress === undefined) return false;
  const current = ensureSettingsRow();
  const oldAccount = normalizeAccountId(current?.gmailAddress);
  const newAccount = normalizeAccountId(nextGmailAddress);
  return Boolean(oldAccount && newAccount && oldAccount !== newAccount);
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

/** Day thresholds for computed-on-read tracker status (effective()). */
export function getStatusSettings(): StatusSettings {
  return statusSettingsFromRow(ensureSettingsRow());
}

/** @deprecated use STALE_CLOSE_DAYS_* / REJECTION_CLOSE_DAYS_* in status-constants. */
export const CLOSE_DAYS_MIN = 1;
/** @deprecated use STALE_CLOSE_DAYS_* / REJECTION_CLOSE_DAYS_* in status-constants. */
export const CLOSE_DAYS_MAX = 90;
