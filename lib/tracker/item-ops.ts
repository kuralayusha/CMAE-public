/**
 * Persistent per-row op locks for long mutations (prepare / draft).
 * Survives navigation; hello/changed can surface busy state to other windows.
 */

import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import { and, eq, lt } from "drizzle-orm";
import { getDb, getSqlite } from "@/lib/db/client";
import { itemOps } from "@/lib/db/schema";
import { t } from "@/lib/i18n/t";
import { bumpRevision } from "@/lib/db/revision";

const DEFAULT_TTL_MS = 10 * 60_000;

export class ItemOpBusyError extends Error {
  readonly code = "ITEM_OP_BUSY" as const;
  readonly itemId: number;
  readonly op: string;
  readonly owner: string;
  readonly expiresAt: string;

  constructor(row: {
    itemId: number;
    op: string;
    owner: string;
    expiresAt: string;
  }) {
    super(t("tracker.error.itemOpBusy"));
    this.name = "ItemOpBusyError";
    this.itemId = row.itemId;
    this.op = row.op;
    this.owner = row.owner;
    this.expiresAt = row.expiresAt;
  }
}

export type ItemOpRow = {
  itemId: number;
  op: string;
  owner: string;
  startedAt: string;
  expiresAt: string;
};

function cleanupExpired(db = getDb(), nowIso = new Date().toISOString()) {
  db.delete(itemOps).where(lt(itemOps.expiresAt, nowIso)).run();
}

export function listActiveItemOps(
  db = getDb(),
  nowIso = new Date().toISOString(),
): ItemOpRow[] {
  cleanupExpired(db, nowIso);
  return db.select().from(itemOps).all();
}

export function acquireItemOp(
  itemId: number,
  op: string,
  opts?: { owner?: string; ttlMs?: number; sqlite?: Database.Database },
): ItemOpRow {
  const sqlite = opts?.sqlite ?? getSqlite();
  const owner = opts?.owner || randomUUID();
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

  const run = sqlite.transaction(() => {
    const db = getDb();
    cleanupExpired(db, nowIso);
    const existing = db
      .select()
      .from(itemOps)
      .where(and(eq(itemOps.itemId, itemId), eq(itemOps.op, op)))
      .get();
    if (existing) {
      throw new ItemOpBusyError(existing);
    }
    db.insert(itemOps)
      .values({
        itemId,
        op,
        owner,
        startedAt: nowIso,
        expiresAt,
      })
      .run();
    bumpRevision(sqlite, "mutation", "upsert", [itemId]);
    return {
      itemId,
      op,
      owner,
      startedAt: nowIso,
      expiresAt,
    };
  });

  return run.immediate();
}

export function releaseItemOp(
  itemId: number,
  op: string,
  opts?: { owner?: string; sqlite?: Database.Database },
): void {
  const sqlite = opts?.sqlite ?? getSqlite();
  const run = sqlite.transaction(() => {
    const db = getDb();
    const existing = db
      .select()
      .from(itemOps)
      .where(and(eq(itemOps.itemId, itemId), eq(itemOps.op, op)))
      .get();
    if (!existing) return;
    if (opts?.owner && existing.owner !== opts.owner) return;
    db.delete(itemOps)
      .where(and(eq(itemOps.itemId, itemId), eq(itemOps.op, op)))
      .run();
    bumpRevision(sqlite, "mutation", "upsert", [itemId]);
  });
  run.immediate();
}

/** Acquire → await fn → always release (even on throw). */
export async function withItemOp<T>(
  itemId: number,
  op: string,
  fn: () => Promise<T>,
  opts?: { owner?: string; ttlMs?: number },
): Promise<T> {
  const lock = acquireItemOp(itemId, op, opts);
  try {
    return await fn();
  } finally {
    try {
      releaseItemOp(itemId, op, { owner: lock.owner });
    } catch {
      /* best-effort */
    }
  }
}

export function prepareOpKey(kind: string): string {
  return `prepare:${kind}`;
}

export function draftOpKey(kind: string): string {
  return `draft:${kind}`;
}
