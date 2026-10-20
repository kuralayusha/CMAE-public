/**
 * @deprecated Prefer `regroupTrackerItems` from `./derive/regroup`.
 * Kept as a thin alias so hard-sync and older call sites keep working.
 * Normal incremental sync must use `derivePendingMails` (no DELETE-all).
 */

import {
  regroupTrackerItems,
  type RegroupPreview,
} from "./derive/regroup";
import type { SyncProgressFn } from "./types";

/**
 * Explicit AI regroup with stable-id diff (Faz 4).
 * Does not wipe tracker_items — matched ids are preserved.
 */
export async function rebuildTrackerItems(opts?: {
  onProgress?: SyncProgressFn;
  signal?: AbortSignal;
  dryRun?: boolean;
}): Promise<{ itemCount: number; preview?: RegroupPreview }> {
  const result = await regroupTrackerItems(opts);
  return { itemCount: result.itemCount, preview: result.preview };
}
