/**
 * Company-folder contact.md candidates + user recipient preference (notesJson).
 * Research ranks emails; user may override; drafts use effective primaryTo.
 * List/GET reads from workspace index (Faz 7) — no fs on that path.
 */

import fs from "fs";
import path from "path";
import { getWorkspaceRoot } from "@/lib/research/workspace";
import { WS, WS_LEGACY } from "@/lib/workspace/filenames";

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

export type RecipientCandidate = {
  email: string;
  role: string | null;
  priority: number | null;
  reason: string | null;
  /** AI's top pick from contact.md ## Recommended */
  recommended: boolean;
};

export type WorkspaceRecipients = {
  recommended: string | null;
  candidates: RecipientCandidate[];
};

function parseNotes(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* ignore */
  }
  return {};
}

export function parseSelectedRecipient(
  notesJson: string | null | undefined,
  columnValue?: string | null,
): string | null {
  if (columnValue) {
    const m = columnValue.trim().match(EMAIL_RE);
    if (m) return m[0];
  }
  const notes = parseNotes(notesJson);
  const raw = notes.selectedRecipient;
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(EMAIL_RE);
  return m ? m[0] : null;
}

export function withSelectedRecipient(
  notesJson: string | null | undefined,
  email: string | null,
): string {
  const notes = parseNotes(notesJson);
  if (email) {
    notes.selectedRecipient = email;
  } else {
    delete notes.selectedRecipient;
  }
  return JSON.stringify(notes);
}

function readContactText(folderPath: string): string | null {
  if (!folderPath || !fs.existsSync(/*turbopackIgnore: true*/ folderPath)) {
    return null;
  }
  const names = [WS.contact, ...WS_LEGACY.contact];
  for (const name of names) {
    const full = path.join(/*turbopackIgnore: true*/ folderPath, name);
    if (!fs.existsSync(/*turbopackIgnore: true*/ full)) continue;
    try {
      return fs.readFileSync(/*turbopackIgnore: true*/ full, "utf8");
    } catch {
      /* skip */
    }
  }
  return null;
}

function sectionBody(text: string, heading: string): string {
  const re = new RegExp(
    `##\\s*${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`,
    "i",
  );
  const m = text.match(re);
  return m?.[1]?.trim() || "";
}

/** Parse ranked emails from contact.md text (Recommended + Candidates). */
export function parseContactRecipientsFromText(
  text: string,
): WorkspaceRecipients {
  if (!text) return { recommended: null, candidates: [] };

  const recommendedBody = sectionBody(text, "Recommended");
  const recommendedMatch = recommendedBody.match(EMAIL_RE);
  const recommended = recommendedMatch ? recommendedMatch[0] : null;
  const recommendedLower = recommended?.toLowerCase() || null;

  const candidatesBody = sectionBody(text, "Candidates");
  const candidates: RecipientCandidate[] = [];
  const seen = new Set<string>();

  for (const line of candidatesBody.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("-")) continue;
    const emailMatch = trimmed.match(EMAIL_RE);
    if (!emailMatch) continue;
    const email = emailMatch[0];
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const meta = trimmed.match(
      /_\(role:\s*([^,]*?),\s*p(\d+),\s*([^)]*)\)_/i,
    );
    const reasonMatch = trimmed.match(/—\s*(.+)$/);
    candidates.push({
      email,
      role: meta?.[1]?.trim() || null,
      priority: meta?.[2] ? Number(meta[2]) : null,
      reason: reasonMatch?.[1]?.trim() || null,
      recommended: recommendedLower === key,
    });
  }

  // Ensure recommended appears even if Candidates section was empty/malformed
  if (recommended && !seen.has(recommended.toLowerCase())) {
    candidates.unshift({
      email: recommended,
      role: null,
      priority: 1,
      reason: null,
      recommended: true,
    });
  } else if (recommendedLower) {
    for (const c of candidates) {
      c.recommended = c.email.toLowerCase() === recommendedLower;
    }
  }

  candidates.sort((a, b) => {
    if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
    const pa = a.priority ?? 99;
    const pb = b.priority ?? 99;
    return pa - pb;
  });

  return { recommended, candidates };
}

/** Parse ranked emails from contact.md on disk (indexing / non-GET paths). */
export function parseContactRecipients(
  folderPath: string,
): WorkspaceRecipients {
  const text = readContactText(folderPath);
  if (!text) return { recommended: null, candidates: [] };
  return parseContactRecipientsFromText(text);
}

export function folderPathForWorkspace(
  workspaceFolder: string | null | undefined,
): string | null {
  if (!workspaceFolder?.trim()) return null;
  const full = path.join(getWorkspaceRoot(), workspaceFolder.trim());
  return fs.existsSync(/*turbopackIgnore: true*/ full) ? full : null;
}

export function loadRecipientsForItem(item: {
  workspaceFolder: string | null;
}): WorkspaceRecipients {
  // Faz 7: index only — never touch disk on list/GET.
  // Lazy import avoids cycle with workspace-index → parseContactRecipientsFromText.
  const { loadRecipientsFromIndex } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("./workspace-index") as typeof import("./workspace-index");
  return loadRecipientsFromIndex(item.workspaceFolder);
}

/**
 * Effective To: address. User preference wins when still among candidates
 * (or when no candidate list exists yet).
 */
export function resolveEffectiveRecipient(opts: {
  selected: string | null;
  recommended: string | null;
  candidates: RecipientCandidate[];
  fallback?: string | null;
}): string | null {
  const selected = opts.selected?.trim() || null;
  if (selected) {
    const key = selected.toLowerCase();
    if (opts.candidates.length) {
      const hit = opts.candidates.find((c) => c.email.toLowerCase() === key);
      if (hit) return hit.email;
    } else {
      return selected;
    }
  }
  if (opts.recommended) return opts.recommended;
  if (opts.candidates[0]?.email) return opts.candidates[0].email;
  return opts.fallback?.trim() || null;
}

/** Keep selectedRecipient in notes only if still valid against candidates. */
export function preserveSelectedRecipientInNotes(
  notesObj: Record<string, unknown>,
  prevNotesJson: string | null | undefined,
  candidates: RecipientCandidate[],
): string | null {
  const selected = parseSelectedRecipient(prevNotesJson);
  if (!selected) return null;
  if (!candidates.length) {
    notesObj.selectedRecipient = selected;
    return selected;
  }
  const hit = candidates.find(
    (c) => c.email.toLowerCase() === selected.toLowerCase(),
  );
  if (!hit) return null;
  notesObj.selectedRecipient = hit.email;
  return hit.email;
}
