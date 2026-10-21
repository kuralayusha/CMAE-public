/**
 * Anonymous, stable usage identity: random UUIDv4 + 256-bit secret, kept in
 * `<userData>/anon-id` (same root as master.key) — NOT in SQLite, because the
 * DB is wiped on onboarding reset. Written once (exclusive link, chmod 600),
 * never overwritten by normal code paths. A copy lives in app_meta
 * `anon_id_backup` and restores a missing/corrupt file. The only way to get a
 * new identity is `regenerateAnonId()` — the server's 409 collision path.
 * Uninstalling the desktop app removes userData (and so the id): intended.
 *
 * Nothing here is derived from hardware, mail address or API key.
 */

import type Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAppMeta, setAppMeta } from "@/lib/db/app-meta";
import { getSqlite } from "@/lib/db/client";
import { getAppRoot } from "@/lib/paths";

export type AnonId = { userId: string; secret: string };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET_RE = /^[0-9a-f]{64}$/i;
const BACKUP_KEY = "anon_id_backup";

export function anonIdPath(root: string = getAppRoot()): string {
  return path.join(/*turbopackIgnore: true*/ root, "anon-id");
}

function parse(raw: string | null | undefined): AnonId | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<AnonId>;
    if (
      typeof o.userId === "string" &&
      typeof o.secret === "string" &&
      UUID_RE.test(o.userId) &&
      SECRET_RE.test(o.secret)
    ) {
      return { userId: o.userId.toLowerCase(), secret: o.secret.toLowerCase() };
    }
  } catch {
    /* corrupt */
  }
  return null;
}

function generate(): AnonId {
  return {
    userId: crypto.randomUUID(),
    secret: crypto.randomBytes(32).toString("hex"),
  };
}

function readFile(file: string): { id: AnonId | null; exists: boolean } {
  try {
    const raw = fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8");
    return { id: parse(raw), exists: true };
  } catch {
    return { id: null, exists: false };
  }
}

/** Write-once: succeeds only if `file` does not exist (atomic via hard link). */
function writeOnce(file: string, id: AnonId): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(id), { encoding: "utf8", mode: 0o600 });
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    // Filesystems without hard links: exclusive create instead.
    try {
      fs.writeFileSync(file, JSON.stringify(id), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      return true;
    } catch (err2) {
      if ((err2 as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err2;
    }
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* ignore */
    }
  }
}

function readBackup(db: Database.Database | null): AnonId | null {
  if (!db) return null;
  try {
    return parse(getAppMeta(BACKUP_KEY, db));
  } catch {
    return null;
  }
}

function writeBackup(db: Database.Database | null, id: AnonId): void {
  if (!db) return;
  try {
    setAppMeta(BACKUP_KEY, JSON.stringify(id), db);
  } catch {
    /* DB not ready — file stays the source of truth */
  }
}

function tryDb(): Database.Database | null {
  try {
    return getSqlite();
  } catch {
    return null;
  }
}

export function getAnonId(
  opts: { root?: string; db?: Database.Database | null } = {},
): AnonId {
  const file = anonIdPath(opts.root);
  const db = opts.db === undefined ? tryDb() : opts.db;

  const first = readFile(file);
  if (first.id) {
    const backup = readBackup(db);
    if (!backup || backup.userId !== first.id.userId || backup.secret !== first.id.secret) {
      writeBackup(db, first.id);
    }
    return first.id;
  }

  // Missing or corrupt file → restore from backup, else mint a new one.
  const restored = readBackup(db) ?? generate();
  if (first.exists) {
    // Keep the corrupt file for forensics; never delete in place.
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      /* ignore */
    }
  }
  if (!writeOnce(file, restored)) {
    // Lost a race with another process — use what won.
    const winner = readFile(file).id;
    if (winner) {
      writeBackup(db, winner);
      return winner;
    }
  }
  writeBackup(db, restored);
  return restored;
}

/**
 * ONLY for the 409 (user id collision) path: replace the identity atomically.
 * `expectedUserId` guards against concurrent regenerations.
 */
export function regenerateAnonId(
  expectedUserId: string,
  opts: { root?: string; db?: Database.Database | null } = {},
): AnonId {
  const file = anonIdPath(opts.root);
  const db = opts.db === undefined ? tryDb() : opts.db;
  const current = readFile(file).id;
  if (current && current.userId !== expectedUserId) return current; // already rotated
  const next = generate();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* ignore */
  }
  writeBackup(db, next);
  return next;
}
