/**
 * Mutation layer helper (Faz 6 / §2.7).
 * User-column writes only; derivation owns fact columns.
 */

import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { isMaintenanceActive } from "@/lib/db/app-meta";
import { getDb, getSqlite } from "@/lib/db/client";
import { bumpRevision, type RevisionSource } from "@/lib/db/revision";
import { trackerItems } from "@/lib/db/schema";
import { t } from "@/lib/i18n/t";
import { emitTrackerEvent } from "./events-bus";

export type TrackerItemRow = typeof trackerItems.$inferSelect;

/** User-owned columns mutations may touch. */
export type UserColumnPatch = {
  selectedRecipient?: string | null;
  primaryTo?: string | null;
  userState?: string;
  notesJson?: string | null;
  /** Cached status mirror for legacy readers when user_state flips. */
  status?: string;
  waitingOn?: string | null;
  nextFollowUpAt?: string | null;
  ignored?: number;
  workspaceFolder?: string | null;
  researchJobId?: string | null;
  deletedAt?: string | null;
  deletedReason?: string | null;
  mergedIntoId?: number | null;
};

export class MutationConflictError extends Error {
  readonly code = "USER_VERSION_CONFLICT" as const;
  readonly current: number;

  constructor(current: number) {
    super(t("tracker.error.versionConflict"));
    this.name = "MutationConflictError";
    this.current = current;
  }
}

export class ItemGoneError extends Error {
  readonly code = "ITEM_GONE" as const;
  readonly reason: "deleted" | "merged";
  readonly mergedIntoId: number | null;
  readonly deletedReason: string | null;

  constructor(opts: {
    reason: "deleted" | "merged";
    mergedIntoId?: number | null;
    deletedReason?: string | null;
  }) {
    super(
      opts.reason === "merged"
        ? t("tracker.error.itemMerged")
        : t("tracker.error.itemDeleted"),
    );
    this.name = "ItemGoneError";
    this.reason = opts.reason;
    this.mergedIntoId = opts.mergedIntoId ?? null;
    this.deletedReason = opts.deletedReason ?? null;
  }
}

export class MaintenanceError extends Error {
  readonly code = "MAINTENANCE" as const;
  constructor() {
    super(t("tracker.error.maintenance"));
    this.name = "MaintenanceError";
  }
}

export type WithItemTxOpts = {
  expectUserVersion?: number;
  source?: RevisionSource | string;
  /** When true, allow reading a soft-deleted/merged row (for lineage ops). */
  allowGone?: boolean;
};

export type WithItemTxResult<T> = {
  rev: number;
  userVersion: number;
  item: TrackerItemRow;
  result: T;
};

function assertNotMaintenance(db: Database.Database) {
  if (isMaintenanceActive(db)) throw new MaintenanceError();
}

function loadLiveRow(db: ReturnType<typeof getDb>, itemId: number): TrackerItemRow {
  const row = db
    .select()
    .from(trackerItems)
    .where(eq(trackerItems.id, itemId))
    .get();
  if (!row) throw new Error(t("tracker.error.notFound"));
  return row;
}

function assertRowAlive(row: TrackerItemRow, allowGone?: boolean) {
  if (allowGone) return;
  if (row.mergedIntoId != null || row.deletedReason === "merged") {
    throw new ItemGoneError({
      reason: "merged",
      mergedIntoId: row.mergedIntoId,
      deletedReason: row.deletedReason,
    });
  }
  if (row.deletedAt) {
    throw new ItemGoneError({
      reason: "deleted",
      deletedReason: row.deletedReason,
    });
  }
}

/**
 * BEGIN IMMEDIATE → fencing → read row → optional user_version check →
 * apply user-column patch → user_version++ → bumpRevision → COMMIT.
 */
export function withItemTx<T = void>(
  itemId: number,
  opts: WithItemTxOpts,
  fn: (
    sqlite: Database.Database,
    row: TrackerItemRow,
  ) => { patch?: UserColumnPatch; result?: T } | UserColumnPatch | void,
): WithItemTxResult<T> {
  const sqlite = getSqlite();
  const source = opts.source || "mutation";

  const run = sqlite.transaction(() => {
    assertNotMaintenance(sqlite);
    const db = getDb();
    const row = loadLiveRow(db, itemId);
    assertRowAlive(row, opts.allowGone);

    if (
      opts.expectUserVersion != null &&
      (row.userVersion || 1) !== opts.expectUserVersion
    ) {
      throw new MutationConflictError(row.userVersion || 1);
    }

    const out = fn(sqlite, row);
    let patch: UserColumnPatch | undefined;
    let result: T | undefined;
    if (out && typeof out === "object") {
      if ("patch" in out || "result" in out) {
        const shaped = out as { patch?: UserColumnPatch; result?: T };
        patch = shaped.patch;
        result = shaped.result;
      } else {
        patch = out as UserColumnPatch;
      }
    }

    const now = new Date().toISOString();
    const nextVersion = (row.userVersion || 1) + 1;
    const set: Record<string, unknown> = {
      userVersion: nextVersion,
      updatedAt: now,
    };
    if (patch) {
      for (const [k, v] of Object.entries(patch)) {
        if (v !== undefined) set[k] = v;
      }
    }

    db.update(trackerItems)
      .set(set)
      .where(eq(trackerItems.id, itemId))
      .run();

    const rev = bumpRevision(sqlite, source, "upsert", [itemId]);
    const item = loadLiveRow(db, itemId);
    return {
      rev,
      userVersion: nextVersion,
      item,
      result: result as T,
    };
  });

  return run.immediate();
}

/**
 * Multi-item user mutation in one IMMEDIATE transaction.
 * Each id gets its own user_version bump when patched.
 */
export function withItemsTx<T = void>(
  itemIds: number[],
  opts: { source?: RevisionSource | string },
  fn: (
    sqlite: Database.Database,
    rows: Map<number, TrackerItemRow>,
  ) => {
    patches: Map<number, UserColumnPatch>;
    result?: T;
  },
): { rev: number; result: T; touched: number[] } {
  const sqlite = getSqlite();
  const source = opts.source || "mutation";
  const uniq = [...new Set(itemIds.filter((n) => Number.isFinite(n)))];

  const run = sqlite.transaction(() => {
    assertNotMaintenance(sqlite);
    const db = getDb();
    const rows = new Map<number, TrackerItemRow>();
    for (const id of uniq) {
      const row = loadLiveRow(db, id);
      assertRowAlive(row);
      rows.set(id, row);
    }

    const { patches, result } = fn(sqlite, rows);
    const now = new Date().toISOString();
    const touched: number[] = [];

    for (const [id, patch] of patches) {
      const row = rows.get(id);
      if (!row) continue;
      const set: Record<string, unknown> = {
        userVersion: (row.userVersion || 1) + 1,
        updatedAt: now,
      };
      for (const [k, v] of Object.entries(patch)) {
        if (v !== undefined) set[k] = v;
      }
      db.update(trackerItems)
        .set(set)
        .where(eq(trackerItems.id, id))
        .run();
      touched.push(id);
    }

    const rev = touched.length
      ? bumpRevision(sqlite, source, "upsert", touched)
      : 0;
    return { rev, result: result as T, touched };
  });

  return run.immediate();
}

/** Soft-delete an item and emit deleted SSE (inside caller's tx or standalone). */
export function softDeleteItemInTx(
  sqlite: Database.Database,
  itemId: number,
  reason: string,
  source: RevisionSource | string = "mutation",
): number {
  const db = getDb();
  const now = new Date().toISOString();
  const row = loadLiveRow(db, itemId);
  db.update(trackerItems)
    .set({
      deletedAt: now,
      deletedReason: reason,
      userVersion: (row.userVersion || 1) + 1,
      updatedAt: now,
    })
    .where(eq(trackerItems.id, itemId))
    .run();
  const rev = bumpRevision(sqlite, source, "delete", [itemId]);
  emitTrackerEvent({
    type: "deleted",
    rev,
    itemId,
    reason,
  });
  return rev;
}

/** Mark loser merged into winner; emit merged SSE. */
export function mergeItemInTx(
  sqlite: Database.Database,
  fromId: number,
  intoId: number,
  source: RevisionSource | string = "mutation",
): number {
  const db = getDb();
  const now = new Date().toISOString();
  const row = loadLiveRow(db, fromId);
  db.update(trackerItems)
    .set({
      deletedAt: now,
      deletedReason: "merged",
      mergedIntoId: intoId,
      userVersion: (row.userVersion || 1) + 1,
      updatedAt: now,
    })
    .where(eq(trackerItems.id, fromId))
    .run();
  const rev = bumpRevision(sqlite, source, "merge", [fromId, intoId]);
  emitTrackerEvent({
    type: "merged",
    rev,
    fromId,
    intoId,
  });
  return rev;
}
