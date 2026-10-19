/**
 * Stable identity helpers so inactive rows survive sync without duplicates
 * when AI renames "ExampleCo" → "ExampleCo" (same mailbox).
 */

const PERSONAL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
  "gmx.de",
  "gmx.net",
  "web.de",
]);

export function parseEmailAddr(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/[\w.+-]+@[\w.-]+\.\w+/);
  return m ? m[0]!.toLowerCase() : null;
}

export function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const d = email.slice(at + 1).toLowerCase();
  if (!d || PERSONAL_DOMAINS.has(d)) return null;
  return d;
}

/** "ExampleCo" / "ExampleCo GmbH" / "ExampleCo" → same key */
export function normalizeCompanyKey(name: string | null | undefined): string {
  if (!name) return "";
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[!?.'`"“”]/g, "")
    .replace(
      /\b(gmbh|ag|se|inc|ltd|llc|co|kg|ug|mbh|e\.?\s*v\.?|group|holding)\b/g,
      "",
    )
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

export function samePrimaryEmail(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const ea = parseEmailAddr(a);
  const eb = parseEmailAddr(b);
  return Boolean(ea && eb && ea === eb);
}

export function sameCompanyIdentity(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const ka = normalizeCompanyKey(a);
  const kb = normalizeCompanyKey(b);
  return Boolean(ka && kb && ka === kb);
}
