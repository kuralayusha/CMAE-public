import type { AiGroup, MailBrief } from "./match";
import {
  companyKey,
  detectAckOnly,
  detectAutoAck,
  detectClickAction,
  detectOooAway,
  isNonJobMail,
  parseReturnDate,
  positionKey,
  subjectRoot,
} from "./signals";

function mergeTwo(a: AiGroup, b: AiGroup): AiGroup {
  const mailIds = [...new Set([...a.mailIds, ...b.mailIds])];
  const waitingUntil = a.waitingUntil || b.waitingUntil;
  return {
    company: a.company.length >= b.company.length ? a.company : b.company,
    position: a.position || b.position,
    status: preferStatus(a, b),
    sentiment: a.sentiment || b.sentiment,
    waitingOn: a.waitingOn || b.waitingOn,
    waitingUntil,
    isThanksSent: a.isThanksSent || b.isThanksSent,
    isAutoReply: a.isAutoReply && b.isAutoReply,
    isAckOnly: a.isAckOnly || b.isAckOnly,
    isClickAction: a.isClickAction || b.isClickAction,
    followUpCountHint: Math.max(a.followUpCountHint, b.followUpCountHint),
    mailIds,
    researchJobId: a.researchJobId || b.researchJobId,
    notes: [a.notes, b.notes].filter(Boolean).join(" | ").slice(0, 500),
  };
}

function preferStatus(a: AiGroup, b: AiGroup): AiGroup["status"] {
  const rank: Record<string, number> = {
    needs_reply: 0,
    needs_action: 1,
    follow_up_due: 2,
    waiting: 3,
    rejected: 4,
    in_progress: 5,
    ready_to_send: 6,
    closed: 7,
    inactive: 8,
    ignored: 9,
  };
  return (rank[a.status] ?? 9) <= (rank[b.status] ?? 9) ? a.status : b.status;
}

function enrichFromMails(group: AiGroup, mails: MailBrief[]): AiGroup {
  const linked = group.mailIds
    .map((id) => mails.find((m) => m.id === id))
    .filter((m): m is MailBrief => Boolean(m));
  if (!linked.length) return group;

  const lastIn = [...linked]
    .filter((m) => m.folder === "INBOX")
    .sort((a, b) => a.dateIso.localeCompare(b.dateIso))
    .at(-1);

  let waitingUntil = group.waitingUntil;
  let isAutoReply = group.isAutoReply;
  let isAckOnly = group.isAckOnly;
  let isClickAction = group.isClickAction;
  let status = group.status;

  if (lastIn) {
    const blob = `${lastIn.subject}\n${lastIn.bodyPreview || lastIn.snippet}`;
    const lastOut = [...linked]
      .filter((m) => m.folder === "SENT")
      .sort((a, b) => a.dateIso.localeCompare(b.dateIso))
      .at(-1);
    const sentAfterInbound =
      Boolean(lastOut) &&
      Date.parse(lastOut!.dateIso) > Date.parse(lastIn.dateIso);

    if (detectOooAway(lastIn.subject, blob) && !sentAfterInbound) {
      isAutoReply = true;
      isAckOnly = false;
      isClickAction = false;
      waitingUntil =
        waitingUntil ||
        parseReturnDate(blob) ||
        parseReturnDate(lastIn.subject);
      status = "waiting";
    } else if (detectAutoAck(lastIn.subject, blob) || detectAckOnly(lastIn.subject, blob, lastIn.fromAddr)) {
      // Generic auto-receipt / ACK — not dated waiting
      isAutoReply = detectAutoAck(lastIn.subject, blob);
      isAckOnly = true;
      isClickAction = false;
      waitingUntil = null;
      if (
        status === "needs_reply" ||
        status === "needs_action" ||
        status === "waiting"
      ) {
        status = sentAfterInbound ? "follow_up_due" : "in_progress";
      }
    } else if (
      detectClickAction(lastIn.subject, blob, lastIn.fromAddr) &&
      !sentAfterInbound
    ) {
      isClickAction = true;
      isAckOnly = false;
      status = "needs_action";
    }
  }

  // All inbound ACK-only and no ask → never needs_reply
  const inbounds = linked.filter((m) => m.folder === "INBOX");
  if (
    inbounds.length > 0 &&
    inbounds.every((m) =>
      detectAckOnly(
        m.subject,
        `${m.subject}\n${m.bodyPreview || m.snippet}`,
        m.fromAddr,
      ),
    ) &&
    (status === "needs_reply" || status === "needs_action")
  ) {
    status = "in_progress";
    isAckOnly = true;
  }

  return {
    ...group,
    status,
    waitingUntil,
    isAutoReply,
    isAckOnly,
    isClickAction,
  };
}

/**
 * Merge fragmented AI groups + attach orphan mails so one application = one row.
 */
export function consolidateAiGroups(
  groups: AiGroup[],
  mails: MailBrief[],
): AiGroup[] {
  if (!groups.length && !mails.length) return [];

  let work = groups.map((g) => enrichFromMails({ ...g }, mails));
  const assigned = new Set(work.flatMap((g) => g.mailIds));

  // Attach orphans by company domain / subject root
  for (const m of mails) {
    if (assigned.has(m.id)) continue;
    const addr =
      (m.folder === "SENT" ? m.toAddr : m.fromAddr).split(",")[0]?.trim() ||
      "";
    const domain = addr.split("@")[1]?.toLowerCase() || "";
    const root = subjectRoot(m.subject);
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < work.length; i++) {
      const g = work[i]!;
      let score = 0;
      const gMails = g.mailIds
        .map((id) => mails.find((x) => x.id === id))
        .filter((x): x is MailBrief => Boolean(x));
      for (const gm of gMails) {
        const gAddr =
          (gm.folder === "SENT" ? gm.toAddr : gm.fromAddr)
            .split(",")[0]
            ?.trim() || "";
        const gDomain = gAddr.split("@")[1]?.toLowerCase() || "";
        if (domain && gDomain && domain === gDomain) score += 3;
        if (root && subjectRoot(gm.subject) === root) score += 4;
        if (m.threadId && gm.threadId && m.threadId === gm.threadId) score += 5;
      }
      const ck = companyKey(g.company);
      if (ck && domain.includes(ck)) score += 2;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best >= 0 && bestScore >= 3) {
      work[best] = {
        ...work[best]!,
        mailIds: [...new Set([...work[best]!.mailIds, m.id])],
      };
      assigned.add(m.id);
    }
  }

  // Union-find style merges
  const merged: AiGroup[] = [];
  const used = new Set<number>();

  for (let i = 0; i < work.length; i++) {
    if (used.has(i)) continue;
    let cur = work[i]!;
    used.add(i);
    let changed = true;
    while (changed) {
      changed = false;
      for (let j = 0; j < work.length; j++) {
        if (used.has(j)) continue;
        const other = work[j]!;
        if (shouldMerge(cur, other, mails)) {
          cur = mergeTwo(cur, other);
          used.add(j);
          changed = true;
        }
      }
    }
    merged.push(enrichFromMails(cur, mails));
  }

  // Drop groups that only contain personal/newsletter mail
  return merged.filter((g) => {
    if (!g.mailIds.length) return true; // workspace-only rows stay
    const linked = g.mailIds
      .map((id) => mails.find((m) => m.id === id))
      .filter((m): m is MailBrief => Boolean(m));
    if (!linked.length) return true;
    return linked.some((m) => !isNonJobMail(m));
  });
}

function shouldMerge(a: AiGroup, b: AiGroup, mails: MailBrief[]): boolean {
  const aMails = a.mailIds
    .map((id) => mails.find((m) => m.id === id))
    .filter((m): m is MailBrief => Boolean(m));
  const bMails = b.mailIds
    .map((id) => mails.find((m) => m.id === id))
    .filter((m): m is MailBrief => Boolean(m));

  const aThreads = new Set(aMails.map((m) => m.threadId).filter(Boolean));
  const bThreads = new Set(bMails.map((m) => m.threadId).filter(Boolean));
  for (const t of aThreads) {
    if (t && bThreads.has(t)) return true;
  }

  const aRoots = new Set(aMails.map((m) => subjectRoot(m.subject)).filter(Boolean));
  const bRoots = new Set(bMails.map((m) => subjectRoot(m.subject)).filter(Boolean));
  let sharedRoot = false;
  for (const r of aRoots) {
    if (bRoots.has(r)) {
      sharedRoot = true;
      break;
    }
  }

  const sameCompany = companyKey(a.company) === companyKey(b.company);
  if (!sameCompany) return false;

  const pa = positionKey(a.position);
  const pb = positionKey(b.position);
  const samePosition = Boolean(pa && pb && pa === pb);
  const oneMissingPosition = !pa || !pb;

  // ACK / OOO / click-CTA fragments fold into the main company application
  if (
    a.isAckOnly ||
    b.isAckOnly ||
    a.isAutoReply ||
    b.isAutoReply ||
    a.isClickAction ||
    b.isClickAction
  ) {
    if (samePosition || oneMissingPosition || sharedRoot) return true;
  }

  if (sharedRoot && (samePosition || oneMissingPosition)) return true;
  if (samePosition) return true;

  // Same company, overlapping contact domain, one side only outbound or only inbound
  const aOnlyOut = aMails.length > 0 && aMails.every((m) => m.folder === "SENT");
  const bOnlyIn = bMails.length > 0 && bMails.every((m) => m.folder === "INBOX");
  const bOnlyOut = bMails.length > 0 && bMails.every((m) => m.folder === "SENT");
  const aOnlyIn = aMails.length > 0 && aMails.every((m) => m.folder === "INBOX");
  if ((aOnlyOut && bOnlyIn) || (bOnlyOut && aOnlyIn)) {
    if (oneMissingPosition || sharedRoot) return true;
  }

  return false;
}
