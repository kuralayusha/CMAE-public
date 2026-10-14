export const WORK_TYPES = ["fulltime", "parttime", "contracted"] as const;
export type WorkType = (typeof WORK_TYPES)[number];

export type SalaryPeriod = "monthly" | "yearly";
export type SalaryKind = "gross" | "net";
export type SalaryCurrency = "eur" | "usd" | "other";

export type JobPreferences = {
  workTypes: WorkType[];
  /** 0 = available immediately / ab sofort */
  noticeWeeks: number;
  salaryPeriod: SalaryPeriod;
  salaryKind: SalaryKind;
  salaryCurrency: SalaryCurrency;
  /** Free text when currency is "other" (e.g. TL, Turkish Lira) */
  salaryCurrencyOther: string;
  /** Minimum expectation only (no max range) */
  salaryMin: number | null;
  salaryNegotiable: boolean;
};

export const DEFAULT_JOB_PREFERENCES: JobPreferences = {
  workTypes: [],
  noticeWeeks: 0,
  salaryPeriod: "monthly",
  salaryKind: "gross",
  salaryCurrency: "eur",
  salaryCurrencyOther: "",
  salaryMin: null,
  salaryNegotiable: true,
};

function asWorkTypes(v: unknown): WorkType[] {
  if (!Array.isArray(v)) return [];
  const out: WorkType[] = [];
  for (const x of v) {
    if (WORK_TYPES.includes(x as WorkType) && !out.includes(x as WorkType)) {
      out.push(x as WorkType);
    }
  }
  return out;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function parseJobPreferences(raw: string | null | undefined): JobPreferences {
  if (!raw?.trim()) return { ...DEFAULT_JOB_PREFERENCES };
  try {
    const j = JSON.parse(raw) as Partial<JobPreferences>;
    const currency: SalaryCurrency =
      j.salaryCurrency === "usd" || j.salaryCurrency === "other"
        ? j.salaryCurrency
        : "eur";
    return {
      workTypes: asWorkTypes(j.workTypes),
      noticeWeeks: Math.max(0, Math.min(104, Math.round(Number(j.noticeWeeks) || 0))),
      salaryPeriod: j.salaryPeriod === "yearly" ? "yearly" : "monthly",
      salaryKind: j.salaryKind === "net" ? "net" : "gross",
      salaryCurrency: currency,
      salaryCurrencyOther: String(j.salaryCurrencyOther || "").trim().slice(0, 40),
      salaryMin: numOrNull(j.salaryMin),
      salaryNegotiable: j.salaryNegotiable !== false,
    };
  } catch {
    return { ...DEFAULT_JOB_PREFERENCES };
  }
}

export function serializeJobPreferences(prefs: JobPreferences): string {
  return JSON.stringify({
    workTypes: asWorkTypes(prefs.workTypes),
    noticeWeeks: Math.max(0, Math.min(104, Math.round(Number(prefs.noticeWeeks) || 0))),
    salaryPeriod: prefs.salaryPeriod === "yearly" ? "yearly" : "monthly",
    salaryKind: prefs.salaryKind === "net" ? "net" : "gross",
    salaryCurrency:
      prefs.salaryCurrency === "usd" || prefs.salaryCurrency === "other"
        ? prefs.salaryCurrency
        : "eur",
    salaryCurrencyOther: String(prefs.salaryCurrencyOther || "").trim().slice(0, 40),
    salaryMin: numOrNull(prefs.salaryMin),
    salaryNegotiable: Boolean(prefs.salaryNegotiable),
  });
}

export function mergeJobPreferences(
  current: JobPreferences,
  patch: Partial<JobPreferences>,
): JobPreferences {
  return parseJobPreferences(
    serializeJobPreferences({
      ...current,
      ...patch,
      workTypes:
        patch.workTypes !== undefined ? patch.workTypes : current.workTypes,
    }),
  );
}

function workTypeLabel(t: WorkType, langHint = "en"): string {
  const tr = langHint.startsWith("tr");
  const de = langHint.startsWith("de");
  if (t === "fulltime") return tr ? "tam zamanlı" : de ? "Vollzeit" : "full-time";
  if (t === "parttime") return tr ? "yarı zamanlı" : de ? "Teilzeit" : "part-time";
  return tr ? "sözleşmeli / contractor" : de ? "Contract / freiberuflich" : "contracted";
}

function currencyLabel(prefs: JobPreferences): string {
  if (prefs.salaryCurrency === "eur") return "EUR";
  if (prefs.salaryCurrency === "usd") return "USD";
  return prefs.salaryCurrencyOther.trim() || "other";
}

function noticeLabel(weeks: number, langHint = "en"): string {
  if (weeks <= 0) {
    if (langHint.startsWith("de")) return "ab sofort";
    if (langHint.startsWith("tr")) return "hemen / ab sofort";
    return "immediately (ab sofort)";
  }
  if (langHint.startsWith("tr")) return `${weeks} hafta ihbar`;
  if (langHint.startsWith("de")) return `${weeks} Wochen Kündigungsfrist`;
  return `${weeks} week(s) notice`;
}

/** Compact block for application / follow-up writers (work type + notice; no salary dump). */
export function formatPreferencesForApplication(
  prefs: JobPreferences,
  langHint = "en",
): string {
  const lines: string[] = [];
  if (prefs.workTypes.length) {
    lines.push(
      `Preferred work types: ${prefs.workTypes.map((t) => workTypeLabel(t, langHint)).join(", ")}`,
    );
  }
  lines.push(`Notice / availability: ${noticeLabel(prefs.noticeWeeks, langHint)}`);
  lines.push(
    "Guidance: You may briefly mention availability/notice and preferred work type when natural. Do NOT volunteer salary figures unless the role posting explicitly asks.",
  );
  return lines.join("\n");
}

/** Full block for reply agent — answer salary/notice/work-type questions from this only. */
export function formatPreferencesForReply(prefs: JobPreferences, langHint = "en"): string {
  const cur = currencyLabel(prefs);
  const period = prefs.salaryPeriod === "yearly" ? "yearly" : "monthly";
  const kind = prefs.salaryKind === "net" ? "net" : "gross";
  const min = prefs.salaryMin;
  const salary =
    min != null ? `from ${min} ${cur} ${kind} ${period}` : "not set";
  return [
    `Work types open to: ${
      prefs.workTypes.length
        ? prefs.workTypes.map((t) => workTypeLabel(t, langHint)).join(", ")
        : "not specified"
    }`,
    `Notice / availability: ${noticeLabel(prefs.noticeWeeks, langHint)}`,
    `Salary expectation (minimum): ${salary}`,
    `Open to negotiation: ${prefs.salaryNegotiable ? "yes" : "no"}`,
    "Guidance: If their mail asks about salary, notice period, start date, or employment type, answer using ONLY these facts. Do not invent numbers. If a field is unset, omit or say you are flexible — do not fabricate.",
  ].join("\n");
}
