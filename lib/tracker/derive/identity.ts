/**
 * Stage 2 — identity resolution: conversation → tracker item
 * (architecture §2.6.7). Pure: items / roles are passed in, the tie-break
 * LLM is injected. One row per actual employer; the intermediary is the
 * row's channel.
 *
 * 1. Deterministic keys: ref code, normalized employer name, employer domain,
 *    counterpart address. Domains the account learned to be intermediaries
 *    (ATS / agency / job board) or free-mail never key identity.
 * 2. Otherwise the top-k most similar items (never all of them) go to a
 *    small AI tie-break: one of these, or a new row.
 */

import { normalizeCompanyKey } from "../identity";
import { extractJson, type LlmFn } from "../llm-core";
import type { SenderRole, TriageResult } from "./stage-store";

export type IdentityItem = {
  id: number;
  company: string;
  position: string | null;
  channel?: string | null;
  /** Employer names seen on this item's conversations (stage 1). */
  employerNames: string[];
  /** Employer domains (never intermediary / free-mail). */
  domains: string[];
  /** Counterpart addresses on employer domains. */
  emails: string[];
  refCodes: string[];
  lastSubject?: string | null;
  lastEvent?: string | null;
};

export type IdentityConversation = {
  conversationId: string;
  triage: TriageResult;
  /** Non-user addresses that appear in the conversation. */
  addresses: string[];
  subject: string;
  /** Short excerpt for the tie-break prompt. */
  excerpt?: string;
};

export type IdentityRoles = {
  /** Base domains with role ats / agency / job_board / personal. */
  nonEmployerDomains: Set<string>;
  /** User's own addresses (never counterparts). */
  userEmails: Set<string>;
};

export type IdentityVia =
  | "ref_code"
  | "employer_name"
  | "employer_domain"
  | "contact"
  | "ai";

export type IdentityDecision =
  | { kind: "attach"; itemId: number; via: IdentityVia }
  | { kind: "create"; via: "no_candidate" | "ai"; itemId?: number }
  | { kind: "ask"; candidates: number[] }
  | { kind: "ambiguous"; reason: string };

/** Free-mail providers: an address there identifies a person, not an employer. */
const FREE_MAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.de",
  "gmx.net",
  "gmx.com",
  "web.de",
  "t-online.de",
  "yandex.com",
  "mail.ru",
]);

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu", "or", "ne"]);

/** "jobs.m.personio.de" → "personio.de"; "x.co.uk" → "x.co.uk". */
export function baseDomain(domain: string): string {
  const parts = domain.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const sld = parts[parts.length - 2]!;
  const tld = parts[parts.length - 1]!;
  if (tld.length === 2 && SECOND_LEVEL.has(sld)) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}

export function addressesIn(raw: string): string[] {
  return (raw.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || []).map((a) => a.toLowerCase());
}

function domainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  return at < 0 ? null : baseDomain(email.slice(at + 1));
}

export function isEmployerDomain(domain: string, roles: IdentityRoles): boolean {
  const base = baseDomain(domain);
  if (FREE_MAIL.has(base)) return false;
  if (roles.nonEmployerDomains.has(base)) return false;
  for (const e of roles.userEmails) if (domainOf(e) === base) return false;
  return true;
}

/** Domains the triage itself judged not to be the employer's. */
function triageNonEmployer(triage: TriageResult): Set<string> {
  const out = new Set<string>();
  for (const r of triage.senderRoles || []) {
    if (r.role !== "employer") out.add(baseDomain(r.domain));
  }
  return out;
}

export function normalizeRefCode(v: string | null | undefined): string {
  return (v || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function conversationKeys(conv: IdentityConversation, roles: IdentityRoles) {
  const own = triageNonEmployer(conv.triage);
  const emails = new Set<string>();
  const domains = new Set<string>();
  const candidates = [...conv.addresses];
  if (conv.triage.counterpartEmail) candidates.push(conv.triage.counterpartEmail);
  for (const a of candidates) {
    if (roles.userEmails.has(a)) continue;
    const d = domainOf(a);
    if (!d || own.has(d) || !isEmployerDomain(d, roles)) continue;
    emails.add(a);
    domains.add(d);
  }
  return {
    name: normalizeCompanyKey(conv.triage.employer),
    domains,
    emails,
    refCode: normalizeRefCode(conv.triage.refCode),
  };
}

function nameTokens(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .split(/[^a-z0-9]+/)
      .filter(
        (t) =>
          t.length > 1 &&
          !/^(gmbh|ag|se|inc|ltd|llc|co|kg|ug|mbh|ev|eg|group|holding|the|und|and)$/.test(t),
      ),
  );
}

/** 0..1 name similarity (token Jaccard, key containment). */
export function nameSimilarity(a: string, b: string): number {
  const ka = normalizeCompanyKey(a);
  const kb = normalizeCompanyKey(b);
  if (!ka || !kb) return 0;
  if (ka === kb) return 1;
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = ta.size + tb.size - inter;
  const jac = union ? inter / union : 0;
  const shorter = ka.length <= kb.length ? ka : kb;
  const longer = ka.length <= kb.length ? kb : ka;
  const contain = shorter.length >= 3 && longer.includes(shorter) ? 0.6 : 0;
  return Math.max(jac, contain);
}

function itemNames(item: IdentityItem): string[] {
  return [item.company, ...item.employerNames].filter(Boolean);
}

function bestNameSim(name: string | null, item: IdentityItem): number {
  if (!name) return 0;
  return Math.max(0, ...itemNames(item).map((n) => nameSimilarity(name, n)));
}

function namesCompatible(name: string | null, item: IdentityItem): boolean {
  if (!name) return true;
  return bestNameSim(name, item) >= 0.5;
}

/**
 * Structural veto on an AI "same employer" answer: both sides have their
 * own employer domains, none shared, and the names are not alike.
 */
export function contradicts(
  conv: IdentityConversation,
  item: IdentityItem,
  roles: IdentityRoles,
): boolean {
  const keys = conversationKeys(conv, roles);
  if (!keys.domains.size || !item.domains.length) return false;
  if (item.domains.some((d) => keys.domains.has(baseDomain(d)))) return false;
  return bestNameSim(conv.triage.employer, item) < 0.5;
}

/** Deterministic keys first; otherwise ranked candidates for the tie-break. */
export function resolveByKeys(
  conv: IdentityConversation,
  items: IdentityItem[],
  roles: IdentityRoles,
  k = 6,
): IdentityDecision {
  const keys = conversationKeys(conv, roles);
  const employer = conv.triage.employer;

  if (keys.refCode.length >= 3) {
    const hits = items.filter((i) =>
      i.refCodes.some((r) => normalizeRefCode(r) === keys.refCode),
    );
    if (hits.length === 1 && namesCompatible(employer, hits[0]!)) {
      return { kind: "attach", itemId: hits[0]!.id, via: "ref_code" };
    }
  }

  if (keys.name) {
    const hits = items.filter((i) =>
      itemNames(i).some((n) => normalizeCompanyKey(n) === keys.name),
    );
    if (hits.length === 1) {
      return { kind: "attach", itemId: hits[0]!.id, via: "employer_name" };
    }
    if (hits.length > 1) {
      return { kind: "ask", candidates: hits.slice(0, k).map((h) => h.id) };
    }
  }

  const byDomain = items.filter((i) =>
    i.domains.some((d) => keys.domains.has(baseDomain(d))),
  );
  if (byDomain.length === 1 && namesCompatible(employer, byDomain[0]!)) {
    return { kind: "attach", itemId: byDomain[0]!.id, via: "employer_domain" };
  }

  const byEmail = items.filter((i) => i.emails.some((e) => keys.emails.has(e.toLowerCase())));
  if (byEmail.length === 1 && namesCompatible(employer, byEmail[0]!)) {
    return { kind: "attach", itemId: byEmail[0]!.id, via: "contact" };
  }

  const ranked = rankCandidates(conv, items, roles)
    .filter((c) => c.score >= 0.3)
    .slice(0, k);
  if (!ranked.length) {
    if (!employer) return { kind: "ambiguous", reason: "no_employer" };
    return { kind: "create", via: "no_candidate" };
  }
  return { kind: "ask", candidates: ranked.map((r) => r.itemId) };
}

export function rankCandidates(
  conv: IdentityConversation,
  items: IdentityItem[],
  roles: IdentityRoles,
): { itemId: number; score: number }[] {
  const keys = conversationKeys(conv, roles);
  const position = conv.triage.position || "";
  return items
    .map((item) => {
      let score = bestNameSim(conv.triage.employer, item);
      if (item.domains.some((d) => keys.domains.has(baseDomain(d)))) score += 0.6;
      if (item.emails.some((e) => keys.emails.has(e.toLowerCase()))) score += 0.4;
      if (
        keys.refCode.length >= 3 &&
        item.refCodes.some((r) => normalizeRefCode(r) === keys.refCode)
      ) {
        score += 0.6;
      }
      if (position && item.position && nameSimilarity(position, item.position) >= 0.5) {
        score += 0.1;
      }
      return { itemId: item.id, score };
    })
    .sort((a, b) => b.score - a.score || a.itemId - b.itemId);
}

export const TIEBREAK_PROMPT_VERSION = 2;

export type TieBreakQuestion = {
  conversation: IdentityConversation;
  candidates: IdentityItem[];
  /** The conversation's own employer-side domains (ATS/agency/free-mail excluded). */
  employerDomains?: string[];
};

export function buildTieBreakPrompt(questions: TieBreakQuestion[]): string {
  const blocks = questions.map((q, i) => {
    const t = q.conversation.triage;
    const cands = q.candidates.map((c) =>
      JSON.stringify({
        id: c.id,
        company: c.company,
        also_known_as: [...new Set(c.employerNames)].slice(0, 4),
        channel: c.channel || null,
        position: c.position,
        domains: c.domains.slice(0, 4),
        last_subject: c.lastSubject || null,
        last_event: c.lastEvent || null,
      }),
    );
    return `Q${i + 1}:
conversation: ${JSON.stringify({
      employer: t.employer,
      intermediary: t.intermediary,
      position: t.position,
      ref_code: t.refCode,
      counterpart: t.counterpartEmail,
      domains: q.employerDomains?.slice(0, 4) ?? [],
      subject: q.conversation.subject.slice(0, 160),
      excerpt: (q.conversation.excerpt || "").slice(0, 500),
    })}
candidates:
${cands.join("\n")}`;
  });
  return `A job-application tracker keeps exactly ONE row per actual employer (different positions at the same employer share a row; the ATS / agency / job board is only the row's channel).
For each question decide whether the conversation belongs to one of the candidate rows (same employer organisation) or needs a new row. Similar names are NOT enough: different companies, subsidiaries with their own hiring, or an agency vs. its client are different employers. Spelling variants, legal-form suffixes, brand vs. legal name of the same organisation are the same employer. When the conversation and a candidate both have employer domains and none match, treat them as different organisations unless the text clearly says they are the same.

Return ONLY JSON:
{"answers":[{"q":"Q1","row":12,"reason":"short"},{"q":"Q2","row":"new","reason":"short"}]}

${blocks.join("\n\n")}`;
}

export function parseTieBreak(
  text: string,
  questions: TieBreakQuestion[],
): Map<number, number | "new"> {
  const out = new Map<number, number | "new">();
  const parsed = extractJson<{ answers?: { q?: unknown; row?: unknown }[] }>(text);
  if (!Array.isArray(parsed?.answers)) return out;
  for (const a of parsed.answers) {
    const idx = Number(String(a?.q ?? "").replace(/^Q/i, "")) - 1;
    const q = questions[idx];
    if (!q || out.has(idx)) continue;
    if (String(a.row).toLowerCase() === "new") {
      out.set(idx, "new");
      continue;
    }
    const row = Number(a.row);
    if (q.candidates.some((c) => c.id === row)) out.set(idx, row);
  }
  return out;
}

/** One tie-break call for several questions; unanswered → absent. */
export async function askTieBreak(
  questions: TieBreakQuestion[],
  llm: LlmFn,
): Promise<Map<number, number | "new">> {
  if (!questions.length) return new Map();
  const text = await llm(buildTieBreakPrompt(questions));
  return parseTieBreak(text, questions);
}

export function rolesFromList(
  list: { domain: string; role: SenderRole | string }[],
  userEmails: string[],
): IdentityRoles {
  const nonEmployer = new Set<string>();
  for (const r of list) {
    if (r.role !== "employer") nonEmployer.add(baseDomain(r.domain));
  }
  return {
    nonEmployerDomains: nonEmployer,
    userEmails: new Set(userEmails.map((e) => e.toLowerCase())),
  };
}

/** Fold a resolved conversation into its item's identity keys. */
export function absorbConversation(
  item: IdentityItem,
  conv: IdentityConversation,
  roles: IdentityRoles,
): void {
  const keys = conversationKeys(conv, roles);
  if (conv.triage.employer && !item.employerNames.includes(conv.triage.employer)) {
    item.employerNames.push(conv.triage.employer);
  }
  for (const d of keys.domains) if (!item.domains.includes(d)) item.domains.push(d);
  for (const e of keys.emails) if (!item.emails.includes(e)) item.emails.push(e);
  if (conv.triage.refCode && !item.refCodes.includes(conv.triage.refCode)) {
    item.refCodes.push(conv.triage.refCode);
  }
  if (!item.channel && conv.triage.intermediary) item.channel = conv.triage.intermediary;
  if (!item.position && conv.triage.position) item.position = conv.triage.position;
  item.lastSubject = conv.subject || item.lastSubject;
}

/**
 * Resolve a list of conversations against `items` (mutated: created rows are
 * appended so later conversations of the same employer attach to them).
 * `createItem` returns the new item's id. Deterministic decisions first
 * (chronological), then one batched tie-break round for the rest.
 */
export async function resolveConversations(
  convs: IdentityConversation[],
  items: IdentityItem[],
  roles: IdentityRoles,
  opts: {
    llm?: LlmFn;
    createItem: (conv: IdentityConversation) => number;
    tieBreakBatch?: number;
    onTieBreak?: (info: { questions: number; answered: number; ms: number; error?: string }) => void;
  },
): Promise<Map<string, IdentityDecision>> {
  const out = new Map<string, IdentityDecision>();
  const byId = () => new Map(items.map((i) => [i.id, i]));

  const create = (conv: IdentityConversation, via: "no_candidate" | "ai") => {
    const id = opts.createItem(conv);
    const item: IdentityItem = {
      id,
      company: conv.triage.employer || "",
      position: conv.triage.position,
      channel: conv.triage.intermediary,
      employerNames: [],
      domains: [],
      emails: [],
      refCodes: [],
    };
    absorbConversation(item, conv, roles);
    items.push(item);
    out.set(conv.conversationId, { kind: "create", via, itemId: id });
    return id;
  };

  const attach = (conv: IdentityConversation, itemId: number, via: IdentityVia) => {
    const item = byId().get(itemId);
    if (item) absorbConversation(item, conv, roles);
    out.set(conv.conversationId, { kind: "attach", itemId, via });
  };

  const pending: IdentityConversation[] = [];
  for (const conv of convs) {
    const d = resolveByKeys(conv, items, roles);
    if (d.kind === "attach") attach(conv, d.itemId, d.via);
    else if (d.kind === "create") create(conv, d.via);
    else if (d.kind === "ambiguous") out.set(conv.conversationId, d);
    else pending.push(conv);
  }

  const batchSize = opts.tieBreakBatch ?? 8;
  for (let i = 0; i < pending.length; i += batchSize) {
    const slice = pending.slice(i, i + batchSize);
    const map = byId();
    const questions: TieBreakQuestion[] = slice.map((conv) => {
      const d = resolveByKeys(conv, items, roles);
      const ids = d.kind === "ask" ? d.candidates : [];
      return {
        conversation: conv,
        candidates: ids.map((id) => map.get(id)!).filter(Boolean),
        employerDomains: [...conversationKeys(conv, roles).domains],
      };
    });
    let answers = new Map<number, number | "new">();
    if (opts.llm) {
      const t0 = Date.now();
      try {
        answers = await askTieBreak(
          questions.filter((q) => q.candidates.length),
          opts.llm,
        ).then((m) => {
          // Re-index to the full question list.
          const asked = questions
            .map((q, idx) => ({ q, idx }))
            .filter((x) => x.q.candidates.length);
          const re = new Map<number, number | "new">();
          for (const [k, v] of m) re.set(asked[k]!.idx, v);
          return re;
        });
        opts.onTieBreak?.({ questions: questions.length, answered: answers.size, ms: Date.now() - t0 });
      } catch (err) {
        opts.onTieBreak?.({
          questions: questions.length,
          answered: 0,
          ms: Date.now() - t0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    questions.forEach((q, idx) => {
      const conv = q.conversation;
      // Rows created earlier in this round may now match exactly.
      const again = resolveByKeys(conv, items, roles);
      if (again.kind === "attach") {
        attach(conv, again.itemId, again.via);
        return;
      }
      if (!q.candidates.length) {
        if (again.kind === "create") create(conv, again.via);
        else out.set(conv.conversationId, { kind: "ambiguous", reason: "no_employer" });
        return;
      }
      const a = answers.get(idx);
      if (a === "new") {
        if (conv.triage.employer) create(conv, "ai");
        else out.set(conv.conversationId, { kind: "ambiguous", reason: "no_employer" });
      } else if (typeof a === "number") {
        const cand = map.get(a);
        if (cand && contradicts(conv, cand, roles)) {
          if (conv.triage.employer) create(conv, "ai");
          else out.set(conv.conversationId, { kind: "ambiguous", reason: "tie_break_conflict" });
        } else {
          attach(conv, a, "ai");
        }
      } else {
        out.set(conv.conversationId, { kind: "ambiguous", reason: "tie_break_failed" });
      }
    });
  }
  return out;
}
