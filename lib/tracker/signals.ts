/**
 * Deterministic mail signals — auto-reply / ACK / return dates.
 * Used to override weak AI labels.
 */

import {
  decodeBase64Body,
  decodeQuotedPrintable,
  repairUtf8Mojibake,
} from "./mail-text";

/** Strip HTML tags/entities when a body was stored as raw markup. */
function stripHtmlish(html: string): string {
  if (!/<[a-zA-Z!?][\s\S]*?>/.test(html)) return html;
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_, n: string) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeBase64Blob(compact: string, sample: string): boolean {
  if (compact.length < 60) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact.slice(0, 160))) return false;
  // Already readable plain text / HTML — leave alone
  // Any letter outside ASCII (TR/DE/PL/… accents) ⇒ not a raw b64 blob
  if (/[^\x00-\x7F]/.test(sample.slice(0, 160))) return false;
  if (/\b(hallo|hello|dear|sehr|vielen|guten|merhaba|sayın)\b/i.test(sample.slice(0, 160))) {
    return false;
  }
  if (/^<!DOCTYPE\s+html|^<html[\s>]/i.test(sample.trim())) return false;
  // Classic base64-of-HTML starts with PCFET0N… / PGh0bWw…
  if (/^(PCFET0N|PGh0bW|PGJvZHk|PHNwYW4)/i.test(compact)) return true;
  // Mostly base64 alphabet, little punctuation
  const head = compact.slice(0, 200);
  const nonB64 = (head.match(/[^A-Za-z0-9+/=]/g) || []).length;
  return nonB64 === 0;
}

function looksLikeQuotedPrintable(text: string): boolean {
  // Soft breaks ⇒ still on the wire
  if (/=\r?\n/.test(text)) return true;
  // UTF-8 multi-byte lead in QP (=C3=BC, =C5=9F, =E2=80=A6, …) — not a URL query
  if (
    /=(?:C[2-9A-F]|D[0-9A-F]|E[0-9A-F]|F[0-7])=[0-9A-Fa-f]{2}/i.test(text)
  ) {
    return true;
  }
  // Dense =XX runs (encoded spaces =20, equals =3D) without looking like a URL
  const hits = text.match(/=[0-9A-Fa-f]{2}/g) || [];
  if (hits.length < 4) return false;
  const sample = text.slice(0, 500);
  const density = hits.length / Math.max(sample.length, 1);
  return density >= 0.04;
}

/** Decode quoted-printable / soft breaks / stray base64 so regexes match real text. */
export function normalizeMailText(text: string): string {
  let s = (text || "").replace(/\r/g, "");
  if (looksLikeQuotedPrintable(s)) {
    s = decodeQuotedPrintable(s, "utf-8");
  }
  // Some IMAP bodies arrive as raw base64 (often truncated mid-stream, unpadded)
  const compact = s.replace(/\s+/g, "");
  if (looksLikeBase64Blob(compact, s)) {
    const decoded = decodeBase64Body(compact, "utf-8");
    // Letters in any script (Latin + accents, Cyrillic, CJK, …)
    if (decoded && /\p{L}{4,}/u.test(decoded)) {
      s = decoded;
    }
  }
  s = repairUtf8Mojibake(s);
  return stripHtmlish(s);
}

function blobOf(subject: string, body: string): string {
  // Normalize parts separately — concatenating first breaks base64 body detection
  // (subject prefix makes the blob fail the base64 alphabet check).
  return `${normalizeMailText(subject)}\n${normalizeMailText(body)}`.toLowerCase();
}

export function subjectRoot(subject: string): string {
  let s = subject.trim();
  for (let i = 0; i < 4; i++) {
    const next = s.replace(
      /^(re|aw|wg|fwd|fw|sv|automatische antwort|automatic reply|out of office)\s*:\s*/i,
      "",
    );
    if (next === s) break;
    s = next.trim();
  }
  return s.toLowerCase().replace(/\s+/g, " ");
}

/** Real OOO / vacation — dated wait. NOT a generic "we received your application". */
export function detectOooAway(subject: string, body: string): boolean {
  const blob = blobOf(subject, body);
  return (
    /^out of office\b/i.test(subject.trim()) ||
    /abwesenheitsnotiz/.test(blob) ||
    /ich bin derzeit (im urlaub|nicht (im haus|erreichbar)|abwesend)/.test(
      blob,
    ) ||
    /i am currently (out of the office|on (annual )?leave|on vacation|away)/.test(
      blob,
    ) ||
    /emails? (will )?not be (forwarded|monitored)|e-mails werden nicht weitergeleitet/.test(
      blob,
    ) ||
    (/urlaub|vacation|out of office|abwesend|nicht im haus/.test(blob) &&
      /(wieder im haus|back (in|on)|ab (montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)|until|bis\s+\d)/.test(
        blob,
      ))
  );
}

/**
 * Generic auto-receipt: "Automatische Antwort" / thank you we got your application,
 * please be patient — NOT a human reply and NOT OOO waiting.
 */
export function detectAutoAck(subject: string, body: string): boolean {
  if (detectOooAway(subject, body)) return false;
  if (detectRejection(subject, body)) return false;
  const sub = normalizeMailText(subject).trim();
  const blob = blobOf(subject, body);
  const autoHeader =
    /^automatische antwort\b/i.test(sub) ||
    /^automatic reply\b/i.test(sub) ||
    /^auto[- ]?reply\b/i.test(sub);
  if (autoHeader || /automatische antwort|automatic reply/.test(blob)) {
    return true;
  }
  // Recruiting auto-receipt without "Automatische Antwort" subject
  // e.g. ExampleWare "Deine Karriere bei … / setzen uns baldmöglich wieder"
  return (
    /wir setzen uns (baldm[oö]glich )?wieder|baldm[oö]glich wieder mit dir in verbindung/.test(
      blob,
    ) ||
    (/vielen dank f[uü]r deine nachricht/.test(blob) &&
      /interesse an einer karriere|freuen uns [uü]ber dein interesse/.test(blob) &&
      /recruiting|bewerbung@|karriere/.test(blob))
  );
}

/** Any automated non-human message (OOO or auto-ACK). */
export function detectAutoReply(subject: string, body: string): boolean {
  return detectOooAway(subject, body) || detectAutoAck(subject, body);
}

/**
 * Click-link / button CTA — NOT a written reply.
 * e.g. confirm email, complete profile, GDPR "Ich stimme zu", survey confirm.
 */
/**
 * Optional ATS / receipt links that look like CTAs but are NOT required
 * (Workday Candidate Home, "you may wish to view status", create account).
 */
export function detectOptionalPortalLink(subject: string, body: string): boolean {
  const blob = blobOf(subject, body);
  const optional =
    /you may wish to|candidate home|view the application status|if you do not have .* account|follow this link to create|sign into the candidate/.test(
      blob,
    ) ||
    (/thank you for your application|thanks for (your )?application|bewerbung.*(erhalten|eingegangen)/.test(
      blob,
    ) &&
      /account|candidate home|portal|status/.test(blob));

  // Real required verify is NOT optional
  const requiredVerify =
    /verify your (candidate )?account|confirm your email address and complete setup|link will expire|activate\//.test(
      blob,
    );

  return optional && !requiredVerify;
}

export function detectClickAction(
  subject: string,
  body: string,
  fromAddr = "",
): boolean {
  if (detectAutoReply(subject, body)) return false;
  if (detectOptionalPortalLink(subject, body)) return false;
  if (detectRejection(subject, body)) return false;
  const blob = blobOf(subject, body);
  const from = fromAddr.toLowerCase();

  const noreplyish =
    /noreply|no-reply|donotreply|do-not-reply|onboarding@|welcome\.|mailer-daemon|notifications?@/.test(
      from,
    );

  const clickCta =
    /teilnahme bestätigen|e-?mail(-|\s)?adresse bestätigen|bestätigung Ihrer e-?mail|confirm (your )?e-?mail|confirm participation/.test(
      blob,
    ) ||
    /complete (my |your )?profile|profil (vervollständigen|aktivieren|link is still waiting)|don't forget to complete your profile/.test(
      blob,
    ) ||
    /ich stimme zu|stimme der (weiteren )?speicherung zu|speicherung Ihrer bewerbungsdaten|consent.*(click|link|button)|einwilligung.*(link|klicken|bestätigen)/.test(
      blob,
    ) ||
    /bitte bestätigen Sie uns noch Ihre e-?mail|click (here|the button) to (confirm|complete|activate)/.test(
      blob,
    ) ||
    /erst danach erhalten Sie|profile link is still waiting/.test(blob) ||
    /verify your (candidate )?account|confirm your email address and complete setup|link will expire/.test(
      blob,
    );

  // CTA button labels often appear as plain text in IMAP extracts
  const buttonish =
    /\b(teilnahme bestätigen|complete my profile|ich stimme zu|confirm email|verify email)\b/.test(
      blob,
    );

  if (clickCta || buttonish) return true;

  // noreply + "confirm/activate/click" language without asking for a written answer
  if (
    noreplyish &&
    /(bestätigen|confirm|aktivieren|activate|klicken|click here|button)/.test(
      blob,
    ) &&
    !/(wann hätten|availability|interviewtermin|could you (send|share|tell)|bitte um rückruf)/.test(
      blob,
    )
  ) {
    return true;
  }

  return false;
}

/** Personal chatter / newsletters — must not enter the job tracker at all. */
/** Soft / hard rejection — not an ACK, not needs_reply. */
export function detectRejection(subject: string, body: string): boolean {
  const blob = blobOf(subject, body);
  return (
    /leider (derzeit )?keine passende|leider.{0,100}keine passende|keine passende (stelle|position|einsatz)/.test(
      blob,
    ) ||
    /unfortunately we (have )?(to )?(reject|decline)|we (will|can) not (be )?progress|not (be )?moving forward/.test(
      blob,
    ) ||
    /absage|nach sorgf[aä]ltiger pr[uü]fung|sorgf[aä]ltig(e|er)? gepr[uü]ft|andere bewerber(innen)? (den vorzug|weiter)/.test(
      blob,
    ) ||
    /nicht weiter berücksichtigen|your application was not successful|we have decided not to/.test(
      blob,
    ) ||
    /f[aä]llt es uns nicht leicht.+keine passende|derzeit leider keine/.test(blob) ||
    /ne yaz[ıi]k ki|maalesef.*(uygun|devam|olumsuz)|başvurunuz.*olumsuz|üzgünüz.*pozisyon/.test(
      blob,
    ) ||
    /malheureusement.*(candidature|profil)|nous ne (pouvons|donnerons) pas suite/.test(
      blob,
    ) ||
    /lamentablemente|no (podemos )?continuar con tu candidatura/.test(blob)
  );
}

export function isNonJobMail(mail: {
  subject: string;
  fromAddr: string;
  toAddr: string;
  bodyPreview?: string;
  snippet?: string;
}): boolean {
  const sub = normalizeMailText(mail.subject).toLowerCase();
  const blob = blobOf(
    mail.subject,
    mail.bodyPreview || mail.snippet || "",
  );
  const from = (mail.fromAddr || "").toLowerCase();

  if (
    /daily newsletter|\bnewsletter\b|view in browser|unsubscribe|e-posta listesinden çık/.test(
      sub,
    ) ||
    /daily newsletter|\bnewsletter\b/.test(blob)
  ) {
    return true;
  }

  const jobish =
    /bewerbung|application|interview|frontend|backend|fullstack|engineer|developer|stelle|vakanz|recruiting|karriere|initiative?bewerbung|jobs@|career|hr@|talent|workday|candidate/.test(
      blob,
    );

  const personal =
    /@(gmail|googlemail|hotmail|outlook|yahoo|icloud|me|protonmail|gmx)\./i;
  const fromPersonal = personal.test(mail.fromAddr);
  const toPersonal = personal.test(mail.toAddr);
  if (fromPersonal && toPersonal && !jobish) return true;

  // Consumer / marketplace platforms — never a hiring thread unless body is jobish
  if (
    !jobish &&
    /@(preply|duolingo|spotify|netflix|paypal|ebay|booking|airbnb|uber|deliveroo|shopify|stripe|github|gitlab|notion|slack|zoom|udemy|coursera)\./i.test(
      from,
    )
  ) {
    return true;
  }

  // Google/Apple account security & product noise (careers/recruiting still jobish)
  if (
    !jobish &&
    /@(google\.com|apple\.com|accounts\.google\.com)/i.test(from) &&
    /security|verification|verify|2-step|two.?step|sign-?in|new device|alert|account|password|recovery|login|otp|code/.test(
      `${sub} ${blob}`,
    )
  ) {
    return true;
  }

  return false;
}

/** "Thanks for applying / we received your CV" with no real question and no click-CTA. */
export function detectAckOnly(subject: string, body: string, fromAddr = ""): boolean {
  if (detectOooAway(subject, body)) return false;
  if (detectRejection(subject, body)) return false;
  if (detectClickAction(subject, body, fromAddr)) return false;
  // Generic auto-receipt counts as ACK (not waiting, not needs_reply)
  if (detectAutoAck(subject, body)) return true;
  const blob = blobOf(subject, body);
  const ack =
    /vielen dank f[uü]r (die )?(zusendung|ihre bewerbung|dein interesse|deine bewerbung|deine nachricht)/.test(
      blob,
    ) ||
    /thank you for (your )?(application|interest|submitting)/.test(blob) ||
    /we (have )?received your application/.test(blob) ||
    /bewerbungsunterlagen wurden|bewerbungsdaten nun im/.test(blob) ||
    /ihre bewerbung.*(erfasst|eingegangen|erhalten|abgeschlossen)/.test(blob) ||
    /deine bewerbung bei/.test(blob) ||
    (/ihre bewerbung/i.test(normalizeMailText(subject)) && /vielen dank/.test(blob)) ||
    /nachdem wir deine unterlagen gesichtet haben, werden wir umgehend wieder/.test(
      blob,
    ) ||
    // Light multilingual boosts (full coverage is AI intent pass)
    /başvurunuz.{0,60}(alınm[ıi]şt[ıi]r|al[ıi]nd[ıi])|taraf[ıi]m[ıi]zca alın|başvurunuzu ald[ıi]k|ilginiz i[çc]in te[şs]ekk[üu]r/.test(
      blob,
    ) ||
    /nous avons bien re[cç]u votre candidature|merci pour votre candidature|votre candidature a bien [eé]t[eé] re[cç]ue/.test(
      blob,
    ) ||
    /hemos recibido tu candidatura|gracias por (tu|su) (candidatura|aplicación)/.test(
      blob,
    ) ||
    /bedankt voor (je|uw) sollicitatie|we hebben je sollicitatie ontvangen/.test(
      blob,
    ) ||
    detectOptionalPortalLink(subject, body);

  const asksWrittenReply =
    /\?/.test(blob) ||
    /bitte (um|senden|teilen|ausfüllen|unterschreiben)/.test(blob) ||
    /(could|would|can) you (please )?(send|share|tell|provide|reply)/.test(
      blob,
    ) ||
    /wann (hätten|könnten|passt|sind sie)/.test(blob) ||
    /verfügbar|availability|interviewtermin|gespr[aä]ch/.test(blob) ||
    /du kannst gerne eine initiativbewerbung/.test(blob);

  return ack && !asksWrittenReply;
}

/**
 * Parse "back on" dates from OOO text. Returns YYYY-MM-DD (UTC noon anchor).
 */
export function parseReturnDate(
  text: string,
  now = new Date(),
): string | null {
  const raw = normalizeMailText(text);

  const de = raw.match(
    /\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})\b/,
  );
  if (de) {
    let y = Number(de[3]);
    if (y < 100) y += 2000;
    const m = Number(de[2]);
    const d = Number(de[1]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return isoDate(y, m, d);
    }
  }

  const iso = raw.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const en = raw.match(
    /\b(?:until|through|back(?:\s+on)?|returning)\s+(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/i,
  );
  if (en) {
    let y = Number(en[3]);
    if (y < 100) y += 2000;
    return isoDate(y, Number(en[1]), Number(en[2]));
  }

  // "ab Freitag" / "from Friday" without date → next that weekday
  const weekday = raw.match(
    /\b(?:ab|from|until|bis)\s+(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  );
  if (weekday) {
    const map: Record<string, number> = {
      sonntag: 0,
      sunday: 0,
      montag: 1,
      monday: 1,
      dienstag: 2,
      tuesday: 2,
      mittwoch: 3,
      wednesday: 3,
      donnerstag: 4,
      thursday: 4,
      freitag: 5,
      friday: 5,
      samstag: 6,
      saturday: 6,
    };
    const target = map[weekday[1]!.toLowerCase()];
    if (target !== undefined) {
      const d = new Date(now);
      d.setHours(12, 0, 0, 0);
      const delta = (target - d.getDay() + 7) % 7 || 7;
      d.setDate(d.getDate() + delta);
      return isoDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
    }
  }

  return null;
}

export function nextBusinessDayAfter(isoDay: string): string {
  const d = new Date(`${isoDay.slice(0, 10)}T12:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d.toISOString();
}

export function endOfDayUtc(isoDay: string): number {
  const t = Date.parse(`${isoDay.slice(0, 10)}T23:59:59.000Z`);
  return Number.isNaN(t) ? Date.now() : t;
}

function isoDate(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function companyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(gmbh|ag|ltd|llc|inc|se|kg|co\.?|the)\b/g, "")
    .replace(/[^a-z0-9äöüß]+/gi, "")
    .trim();
}

export function positionKey(position: string | null | undefined): string {
  if (!position) return "";
  return position
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/[^a-z0-9äöüß]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
