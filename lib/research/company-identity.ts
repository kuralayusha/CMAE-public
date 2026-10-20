/**
 * Target company identity is always the entity that owns the user-given URL.
 * Employers / clients / partners mentioned on a page are never the research target.
 */

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

/** First label of the hostname, e.g. janedoe.dev → "Jane", ExampleSoft.com.tr → "ExampleSoft". */
export function hostBrandHint(hostOrUrl: string): string {
  const host = hostOrUrl.includes("://")
    ? hostnameOf(hostOrUrl)
    : hostOrUrl.replace(/^www\./i, "").toLowerCase();
  const label = (host.split(".")[0] || host || "Company").trim();
  if (!label) return "Company";
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function normalizeToken(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

/** True when the proposed name shares identity with the URL hostname. */
export function nameMatchesHost(companyName: string, hostOrUrl: string): boolean {
  const host = hostOrUrl.includes("://")
    ? hostnameOf(hostOrUrl)
    : hostOrUrl.replace(/^www\./i, "").toLowerCase();
  const hostNorm = normalizeToken(host);
  const labelNorm = normalizeToken(host.split(".")[0] || "");
  const nameNorm = normalizeToken(companyName);
  if (!nameNorm || !hostNorm) return false;
  if (nameNorm === labelNorm || nameNorm === hostNorm) return true;
  if (labelNorm.length >= 3 && (nameNorm.includes(labelNorm) || labelNorm.includes(nameNorm))) {
    return true;
  }
  // e.g. name "Jane Doe" vs host janedoe.dev
  const firstWord = normalizeToken(companyName.split(/\s+/)[0] || "");
  if (
    firstWord.length >= 3 &&
    (firstWord === labelNorm ||
      labelNorm.includes(firstWord) ||
      firstWord.includes(labelNorm))
  ) {
    return true;
  }
  return false;
}

export type SiteKind =
  | "employer"
  | "agency"
  | "personal_portfolio"
  | "product"
  | "other";

export type CompanyIdentityGuess = {
  companyName: string;
  siteKind: SiteKind;
};

/**
 * Keep LLM naming only when it still refers to the URL owner.
 * Otherwise fall back to host brand (never to a mentioned employer).
 */
export function resolveCompanyName(
  url: string,
  guess: CompanyIdentityGuess | null,
  fallbackHost?: string,
): { companyName: string; siteKind: SiteKind; usedFallback: boolean } {
  const host = fallbackHost || hostnameOf(url) || "company";
  const hint = hostBrandHint(host);
  const siteKind = guess?.siteKind || "other";
  const raw = (guess?.companyName || "").trim().slice(0, 80);

  if (raw && nameMatchesHost(raw, host)) {
    return { companyName: raw, siteKind, usedFallback: false };
  }

  // Personal site with a person-style name that still matches the host label
  // is already handled above. Anything else (e.g. ExampleSoft on janedoe.dev) → host.
  return {
    companyName: hint,
    siteKind,
    usedFallback: Boolean(raw),
  };
}
