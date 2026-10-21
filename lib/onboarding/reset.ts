import fs from "fs";
import path from "path";
import {
  bumpAppMetaInt,
  getAppMetaInt,
  setAppMeta,
} from "@/lib/db/app-meta";
import { clearMaintenance, prepareResetFencing } from "@/lib/sync/engine";
import {
  closeDb,
  getDb,
  wipeDatabaseContents,
  wipeDatabaseFiles,
} from "@/lib/db/client";
import {
  clearOnboardingCompleteMarker,
  isOnboardingComplete,
  isOnboardingFlagSet,
} from "@/lib/onboarding/status";
import { clearUserPack } from "@/lib/i18n/pack";
import { clearAllResearchJobs } from "@/lib/research/persist";
import { getWorkspaceRoot } from "@/lib/research/workspace";
import { getAppRoot } from "@/lib/paths";
import { emitTrackerEvent } from "@/lib/tracker/events-bus";

/**
 * Full local wipe — app should behave like a fresh install.
 * Cancels jobs under maintenance, waits for lease release, bumps db_epoch
 * so any in-flight writer is fenced out before wipe.
 */
export async function resetAppForOnboarding(): Promise<void> {
  let fenceEpoch = 1;
  let fenceCreds = 0;
  try {
    await prepareResetFencing();
    fenceEpoch = Math.max(1, getAppMetaInt("db_epoch"));
    fenceCreds = Math.max(0, getAppMetaInt("credentials_version"));
  } catch {
    /* best-effort if DB not ready */
  }

  clearAllResearchJobs();
  try {
    clearUserPack();
  } catch {
    /* ignore */
  }

  // Close before any data/ deletion — otherwise macOS case-insensitive
  // CMAE/cmae sibling wipe (or file recreate) leaves writes on a ghost inode
  // while status/CLI open the new empty directory entry.
  closeDb();
  wipeWorkspaceContents();
  wipeLegacySiblingAppData();

  // 1) Reopen + clear while connected (reliable). Keep elevated fencing tokens
  // so a pre-wipe job that held epoch 0 cannot write back after wipe.
  wipeDatabaseContents({
    dbEpoch: fenceEpoch,
    credentialsVersion: fenceCreds,
  });
  clearOnboardingCompleteMarker();
  clearMaintenance();

  // 2) Best-effort cold recreate (ignores lock failures; contents already empty)
  try {
    wipeDatabaseFiles();
  } catch {
    /* contents already wiped */
  }
  getDb();
  // File recreate + migrations re-seed epoch 0 via INSERT OR IGNORE — re-apply.
  setAppMeta("db_epoch", String(fenceEpoch));
  setAppMeta("credentials_version", String(fenceCreds));
  bumpAppMetaInt("db_epoch");
  clearOnboardingCompleteMarker();

  // 3) Belt-and-suspenders if file recreate somehow restored junk
  if (isOnboardingFlagSet() || isOnboardingComplete()) {
    wipeDatabaseContents({
      dbEpoch: Math.max(1, getAppMetaInt("db_epoch")),
      credentialsVersion: Math.max(0, getAppMetaInt("credentials_version")),
    });
    clearOnboardingCompleteMarker();
  }

  if (isOnboardingFlagSet() || isOnboardingComplete()) {
    throw new Error(
      "Data was wiped but the onboarding flag could not be cleared — restart the server and try again",
    );
  }

  emitTrackerEvent({ type: "reset", rev: 0 });
}

function wipeWorkspaceContents(): void {
  const root = getWorkspaceRoot();
  try {
    fs.mkdirSync(/*turbopackIgnore: true*/ root, { recursive: true });
    for (const name of fs.readdirSync(/*turbopackIgnore: true*/ root)) {
      if (name === "." || name === "..") continue;
      fs.rmSync(
        path.join(/*turbopackIgnore: true*/ root, name),
        { recursive: true, force: true },
      );
    }
  } catch {
    /* ignore */
  }
}

/**
 * Electron productName is "CMAE" but older builds used "cmae". If both
 * Application Support folders exist, wipe can clear one while sync still
 * reads the other — Phase A "454 mails + 100 apps after wipe" symptom.
 *
 * On case-insensitive volumes (typical macOS), CMAE and cmae are the same
 * directory — string inequality is not enough; compare device+inode.
 */
function samePathIdentity(a: string, b: string): boolean {
  try {
    if (path.resolve(/*turbopackIgnore: true*/ a) === path.resolve(/*turbopackIgnore: true*/ b)) {
      return true;
    }
    const sa = fs.statSync(/*turbopackIgnore: true*/ a);
    const sb = fs.statSync(/*turbopackIgnore: true*/ b);
    return sa.ino === sb.ino && sa.dev === sb.dev;
  } catch {
    return false;
  }
}

function wipeLegacySiblingAppData(): void {
  try {
    const current = path.resolve(/*turbopackIgnore: true*/ getAppRoot());
    const parent = path.dirname(current);
    const base = path.basename(current);
    const siblingName =
      base === "CMAE" ? "cmae" : base === "cmae" ? "CMAE" : null;
    if (!siblingName) return;
    const sibling = path.join(/*turbopackIgnore: true*/ parent, siblingName);
    if (
      !fs.existsSync(/*turbopackIgnore: true*/ sibling) ||
      samePathIdentity(sibling, current)
    ) {
      return;
    }
    for (const sub of ["data", "workspace"] as const) {
      const dir = path.join(/*turbopackIgnore: true*/ sibling, sub);
      if (!fs.existsSync(/*turbopackIgnore: true*/ dir)) continue;
      // Never delete the live app's own data/workspace via a case alias.
      const live = path.join(/*turbopackIgnore: true*/ current, sub);
      if (
        fs.existsSync(/*turbopackIgnore: true*/ live) &&
        samePathIdentity(dir, live)
      ) {
        continue;
      }
      fs.rmSync(/*turbopackIgnore: true*/ dir, { recursive: true, force: true });
    }
  } catch {
    /* best-effort */
  }
}
