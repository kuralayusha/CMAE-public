/**
 * Canonical English workspace filenames.
 * Readers should accept legacy Turkish names as fallback.
 */

export const WS = {
  companyInfo: "company_info.md",
  companyInfoTranslated: "company_info_translated.md",
  jobLinks: "job_links.md",
  summary: "summary.md",
  contact: "contact.md",
  routes: "routes.md",
  review: "review.md",
  emailOriginal: "email_original.md",
  emailTranslated: "email_translated.md",
} as const;

/**
 * Legacy names still present in older company folders. The Turkish file names
 * are kept on purpose: existing user workspaces contain them.
 */
export const WS_LEGACY = {
  companyInfo: ["sirket_bilgileri.md"],
  jobLinks: ["basvuru_linkleri.md"],
  summary: ["ozet.md"],
  contact: ["iletisim.md"],
  routes: ["rotalar.md"],
  emailOriginal: ["email_site_language.md"],
} as const;

export function followUpOriginal(n: number): string {
  return `follow_up_${n}.md`;
}

export function followUpTranslated(n: number): string {
  return `follow_up_${n}_translated.md`;
}

export const THANKS_ORIGINAL = "thanks.md";
export const THANKS_TRANSLATED = "thanks_translated.md";
export const REPLY_ORIGINAL = "reply.md";
export const REPLY_TRANSLATED = "reply_translated.md";

/** True for user-language copies shown with "(for user)" badge. */
export function isTranslatedMailFile(name: string): boolean {
  return (
    /^email_translated\.md$/i.test(name) ||
    /^company_info_translated\.md$/i.test(name) ||
    /_translated\.md$/i.test(name) ||
    /^thanks_translated\.md$/i.test(name) ||
    /^reply_translated\.md$/i.test(name)
  );
}

/** Resolve first existing file among canonical + legacy names. */
export function resolveWorkspaceFile(
  folderPath: string,
  canonical: string,
  legacy: readonly string[],
  exists: (full: string) => boolean,
  join: (dir: string, name: string) => string,
): string | null {
  for (const name of [canonical, ...legacy]) {
    const full = join(folderPath, name);
    if (exists(full)) return name;
  }
  return null;
}
