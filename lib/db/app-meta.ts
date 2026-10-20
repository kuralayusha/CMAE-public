import type Database from "better-sqlite3";
import { getSqlite } from "./client";

export type AppMetaKey =
  | "tracker_revision"
  | "db_epoch"
  | "credentials_version"
  | "account_id"
  | "maintenance_until"
  | "schema_backup_path";

export function getAppMeta(
  key: AppMetaKey | string,
  db: Database.Database = getSqlite(),
): string {
  try {
    const row = db
      .prepare(`SELECT value FROM app_meta WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row?.value ?? "";
  } catch {
    return "";
  }
}

export function setAppMeta(
  key: AppMetaKey | string,
  value: string,
  db: Database.Database = getSqlite(),
): void {
  db.prepare(
    `INSERT INTO app_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function getAppMetaInt(
  key: AppMetaKey | string,
  db: Database.Database = getSqlite(),
): number {
  const n = Number.parseInt(getAppMeta(key, db), 10);
  return Number.isFinite(n) ? n : 0;
}

export function bumpAppMetaInt(
  key: AppMetaKey | string,
  db: Database.Database = getSqlite(),
): number {
  const next = getAppMetaInt(key, db) + 1;
  setAppMeta(key, String(next), db);
  return next;
}

export function getFencingTokens(db: Database.Database = getSqlite()): {
  dbEpoch: number;
  credentialsVersion: number;
  accountId: string;
} {
  return {
    dbEpoch: getAppMetaInt("db_epoch", db),
    credentialsVersion: getAppMetaInt("credentials_version", db),
    accountId: getAppMeta("account_id", db) || "",
  };
}

export function isMaintenanceActive(
  db: Database.Database = getSqlite(),
  now = new Date(),
): boolean {
  const until = getAppMeta("maintenance_until", db).trim();
  if (!until) return false;
  const t = Date.parse(until);
  if (!Number.isFinite(t)) return false;
  return t > now.getTime();
}

export function setMaintenanceUntil(
  isoOrEmpty: string,
  db: Database.Database = getSqlite(),
): void {
  setAppMeta("maintenance_until", isoOrEmpty, db);
}

/** Normalize Gmail address for account_id fencing. */
export function normalizeAccountId(address: string | null | undefined): string {
  return (address || "").trim().toLowerCase();
}
