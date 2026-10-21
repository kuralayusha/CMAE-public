/**
 * Stage 0 conversation graph — pure (no DB), shared by derive and the eval.
 */

import { createHash } from "crypto";

export type ConversationMail = {
  id: number;
  threadId: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  referencesHdr: string | null;
  at: string;
  accountId?: string | null;
};

export type Conversation = {
  key: string;
  accountId: string | null;
  threadKey: string | null;
  mailIds: number[];
  latestAt: string;
  fingerprint: string;
};

function normMsgId(raw: string): string {
  return raw.trim().replace(/^<|>$/g, "").toLowerCase();
}

function refTokens(mail: ConversationMail): string[] {
  const out: string[] = [];
  for (const raw of [mail.inReplyTo, mail.referencesHdr]) {
    if (!raw) continue;
    for (const part of raw.split(/[\s,]+/)) {
      const id = normMsgId(part);
      if (id) out.push(id);
    }
  }
  return out;
}

export function conversationFingerprint(
  mailIds: number[],
  latestAt: string,
): string {
  const ids = [...mailIds].sort((a, b) => a - b).join(",");
  return createHash("sha256").update(`${ids}|${latestAt}`).digest("hex");
}

/** Pure: group mails into conversations (union-find over thread + reply links). */
export function assembleConversations(
  mails: ConversationMail[],
): Conversation[] {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
  };

  const byThread = new Map<string, number>();
  const byMsgId = new Map<string, number>();
  for (const m of mails) {
    parent.set(m.id, m.id);
  }
  for (const m of mails) {
    if (m.threadId) {
      const tk = `${m.accountId || ""}|${m.threadId}`;
      const first = byThread.get(tk);
      if (first == null) byThread.set(tk, m.id);
      else union(first, m.id);
    }
    if (m.messageId) {
      const mk = `${m.accountId || ""}|${normMsgId(m.messageId)}`;
      const first = byMsgId.get(mk);
      if (first == null) byMsgId.set(mk, m.id);
      else union(first, m.id);
    }
  }
  for (const m of mails) {
    for (const ref of refTokens(m)) {
      const target = byMsgId.get(`${m.accountId || ""}|${ref}`);
      if (target != null) union(target, m.id);
    }
  }

  const groups = new Map<number, ConversationMail[]>();
  for (const m of mails) {
    const root = find(m.id);
    const list = groups.get(root) || [];
    list.push(m);
    groups.set(root, list);
  }

  const out: Conversation[] = [];
  for (const members of groups.values()) {
    const threadIds = [
      ...new Set(members.map((m) => m.threadId).filter(Boolean) as string[]),
    ].sort();
    const mailIds = members.map((m) => m.id).sort((a, b) => a - b);
    const latestAt = members.map((m) => m.at).sort().at(-1) || "";
    const threadKey = threadIds[0] ?? null;
    const accountId = members.find((m) => m.accountId)?.accountId ?? null;
    out.push({
      key: threadKey
        ? `${accountId || ""}|t:${threadKey}`
        : `${accountId || ""}|m:${mailIds[0]}`,
      accountId,
      threadKey,
      mailIds,
      latestAt,
      fingerprint: conversationFingerprint(mailIds, latestAt),
    });
  }
  return out;
}

/** Pure: mail id → conversation key. */
export function conversationKeyByMail(
  convs: Conversation[],
): Map<number, string> {
  const map = new Map<number, string>();
  for (const c of convs) {
    for (const id of c.mailIds) map.set(id, c.key);
  }
  return map;
}

/**
 * Pure: for each conversation that already has assigned mails, assign its
 * unassigned mails to the item holding most of them (tie → lowest id).
 * Never moves an already-assigned mail.
 */
export function planConversationAssignments(
  convs: Conversation[],
  assigned: ReadonlyMap<number, number>,
): Map<number, { itemId: number; conversationKey: string }> {
  const plan = new Map<number, { itemId: number; conversationKey: string }>();
  for (const conv of convs) {
    const counts = new Map<number, number>();
    for (const id of conv.mailIds) {
      const itemId = assigned.get(id);
      if (itemId != null) counts.set(itemId, (counts.get(itemId) || 0) + 1);
    }
    if (!counts.size) continue;
    const itemId = [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0] - b[0],
    )[0]![0];
    for (const id of conv.mailIds) {
      if (!assigned.has(id)) {
        plan.set(id, { itemId, conversationKey: conv.key });
      }
    }
  }
  return plan;
}

/** Owning item per conversation (majority of assigned mails). */
export function conversationItem(
  conv: Conversation,
  assigned: ReadonlyMap<number, number>,
): number | null {
  const counts = new Map<number, number>();
  for (const id of conv.mailIds) {
    const itemId = assigned.get(id);
    if (itemId != null) counts.set(itemId, (counts.get(itemId) || 0) + 1);
  }
  if (!counts.size) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0];
}
