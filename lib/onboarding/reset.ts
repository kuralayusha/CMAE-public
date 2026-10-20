import fs from "fs";
import path from "path";
import { clearMaintenance, prepareResetFencing } from "@/lib/sync/engine";
import {
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
import { emitTrackerEvent } from "@/lib/tracker/events-bus";

/**
 * Full local wipe — app should behave like a fresh install.
 * Cancels jobs under maintenance, waits for lease release, bumps db_epoch
 * so any in-flight writer is fenced out before wipe.
 */
export async function resetAppForOnboarding(): Promise<void> {
  try {
    await prepareResetFencing();
  } catch {
    /* best-effort if DB not ready */
  }

  clearAllResearchJobs();
  wipeWorkspaceContents();
  try {
    clearUserPack();
  } catch {
    /* ignore */
  }

  // 1) Always clear while connected (reliable)
  wipeDatabaseContents();
  clearOnboardingCompleteMarker();
  clearMaintenance();

  // 2) Best-effort cold recreate (ignores lock failures; contents already empty)
  try {
    wipeDatabaseFiles();
  } catch {
    /* contents already wiped */
  }
  getDb();
  clearOnboardingCompleteMarker();

  // 3) Belt-and-suspenders if file recreate somehow restored junk
  if (isOnboardingFlagSet() || isOnboardingComplete()) {
    wipeDatabaseContents();
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
    fs.mkdirSync(root, { recursive: true });
    for (const name of fs.readdirSync(root)) {
      if (name === "." || name === "..") continue;
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
    }
  } catch {
    /* ignore */
  }
}
