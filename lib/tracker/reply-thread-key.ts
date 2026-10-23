/**
 * Reply-thread key stored on tracker notes.
 * Kept out of pending-draft.ts so draft save does not import that module:
 * a circular route graph there left these exports undefined ("is not a function")
 * after the local mail file was already written.
 */

const REPLY_THREAD_KINDS = ["follow_up", "thanks", "reply"] as const;

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

/** Thread the user picked when preparing this draft kind. */
export function parseReplyThreadKey(
  notesJson: string | null | undefined,
  kind: string,
): string | null {
  if (!REPLY_THREAD_KINDS.includes(kind as (typeof REPLY_THREAD_KINDS)[number])) {
    return null;
  }
  const raw = parseNotes(notesJson).replyThreadByKind;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = (raw as Record<string, unknown>)[kind];
  if (typeof value !== "string") return null;
  const key = value.trim();
  return /^(t|m):.{1,400}$/.test(key) ? key : null;
}

export function withReplyThreadKey(
  notesJson: string | null | undefined,
  kind: string,
  threadKey: string,
): string {
  const notes = parseNotes(notesJson);
  const prev =
    notes.replyThreadByKind &&
    typeof notes.replyThreadByKind === "object" &&
    !Array.isArray(notes.replyThreadByKind)
      ? (notes.replyThreadByKind as Record<string, unknown>)
      : {};
  notes.replyThreadByKind = { ...prev, [kind]: threadKey };
  return JSON.stringify(notes);
}
