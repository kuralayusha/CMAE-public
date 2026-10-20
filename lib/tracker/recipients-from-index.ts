/**
 * Faz 7: read contact recipients from workspace_files index (no fs).
 * Split from workspace-index to avoid a recipients ↔ workspace-index cycle
 * that breaks Turbopack `require()` interop at runtime.
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { workspaceFiles, workspaceFolders } from "@/lib/db/schema";
import { WS, WS_LEGACY } from "@/lib/workspace/filenames";
import type { WorkspaceRecipients } from "./recipients";

export function loadRecipientsFromIndex(
  workspaceFolder: string | null,
): WorkspaceRecipients {
  if (!workspaceFolder) return { recommended: null, candidates: [] };
  const present = getDb()
    .select()
    .from(workspaceFolders)
    .where(eq(workspaceFolders.folder, workspaceFolder))
    .get();
  if (present && !present.present) {
    return { recommended: null, candidates: [] };
  }

  const contactNames = [WS.contact, ...WS_LEGACY.contact];
  for (const name of contactNames) {
    const row = getDb()
      .select()
      .from(workspaceFiles)
      .where(
        and(
          eq(workspaceFiles.folder, workspaceFolder),
          eq(workspaceFiles.name, name),
        ),
      )
      .get();
    if (!row?.metaJson) continue;
    try {
      const parsed = JSON.parse(row.metaJson) as WorkspaceRecipients;
      if (parsed && typeof parsed === "object") {
        return {
          recommended: parsed.recommended ?? null,
          candidates: Array.isArray(parsed.candidates) ? parsed.candidates : [],
        };
      }
    } catch {
      /* continue */
    }
  }
  return { recommended: null, candidates: [] };
}
