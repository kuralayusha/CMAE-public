/**
 * Language-agnostic MIME / mail text decoding.
 * Fixes UTF-8 quoted-printable (and other charsets) so Turkish, German,
 * Polish, etc. characters survive into DB + UI instead of Latin-1 mojibake.
 */
import iconv from "iconv-lite";

const CHARSET_ALIASES: Record<string, string> = {
  utf8: "utf-8",
  "utf-8": "utf-8",
  unicode: "utf-8",
  latin1: "iso-8859-1",
  "iso-8859-1": "iso-8859-1",
  "iso8859-1": "iso-8859-1",
  "iso-8859-9": "iso-8859-9",
  "iso8859-9": "iso-8859-9",
  "windows-1254": "windows-1254",
  cp1254: "windows-1254",
  "windows-1252": "windows-1252",
  cp1252: "windows-1252",
  "iso-8859-2": "iso-8859-2",
  "iso8859-2": "iso-8859-2",
  "windows-1250": "windows-1250",
  cp1250: "windows-1250",
  "iso-8859-15": "iso-8859-15",
  "us-ascii": "utf-8",
  ascii: "utf-8",
};

/** Typical leftovers when UTF-8 bytes were decoded as Latin-1 / Windows-1252. */
const MOJIBAKE_RE =
  /(?:Ã.|Â.|Å.|Ä.|Æ.|Ø.|Å|Å¸|Ä±|ÅŸ|Ã§|Ã¶|Ã¼|Ã±|Ã¡|Ã©|Ã­|Ã³|Ãº|Ä|Å)/;

export function normalizeCharset(charset: string | null | undefined): string {
  const raw = (charset || "").trim().toLowerCase().replace(/["']/g, "");
  if (!raw) return "utf-8";
  return CHARSET_ALIASES[raw] || raw;
}

export function decodeBytes(
  buf: Buffer,
  charset?: string | null,
): string {
  const cs = normalizeCharset(charset);
  if (iconv.encodingExists(cs)) {
    return iconv.decode(buf, cs);
  }
  return buf.toString("utf8");
}

/** Soft-break + =XX → raw bytes (charset applied separately). */
export function quotedPrintableToBuffer(input: string): Buffer {
  const soft = (input || "").replace(/=\r?\n/g, "");
  const out = Buffer.alloc(soft.length);
  let n = 0;
  for (let i = 0; i < soft.length; i++) {
    if (
      soft[i] === "=" &&
      i + 2 < soft.length &&
      /^[0-9A-Fa-f]{2}$/.test(soft.slice(i + 1, i + 3))
    ) {
      out[n++] = parseInt(soft.slice(i + 1, i + 3), 16);
      i += 2;
    } else {
      out[n++] = soft.charCodeAt(i) & 0xff;
    }
  }
  return out.subarray(0, n);
}

export function decodeQuotedPrintable(
  input: string,
  charset?: string | null,
): string {
  return decodeBytes(quotedPrintableToBuffer(input), charset);
}

export function decodeBase64Body(
  input: string,
  charset?: string | null,
): string {
  const compact = (input || "").replace(/\s+/g, "");
  if (!compact) return "";
  const padLen = (4 - (compact.length % 4)) % 4;
  const padded = compact + "=".repeat(padLen);
  try {
    return decodeBytes(Buffer.from(padded, "base64"), charset);
  } catch {
    return input;
  }
}

/**
 * Repair text already stored as Latin-1 / Windows-1252 mojibake of UTF-8
 * (e.g. "ÅŸÄ±" / "ÅŸÄ±" → "şı"). Safe no-op when text is already correct.
 */
export function repairUtf8Mojibake(text: string): string {
  if (!text || !MOJIBAKE_RE.test(text)) return text;
  let best = text;
  let bestScore = mojibakeScore(text);

  for (const candidate of [
    tryMojibakeFix(text, "latin1"),
    tryMojibakeFix(text, "windows-1252"),
  ]) {
    if (!candidate) continue;
    const score = mojibakeScore(candidate);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function tryMojibakeFix(
  text: string,
  asEncoding: "latin1" | "windows-1252",
): string | null {
  try {
    const bytes =
      asEncoding === "latin1"
        ? Buffer.from(text, "latin1")
        : iconv.encode(text, "windows-1252");
    const repaired = bytes.toString("utf8");
    if (!repaired || repaired.includes("\uFFFD")) return null;
    return repaired;
  } catch {
    return null;
  }
}

function mojibakeScore(s: string): number {
  const hits = s.match(MOJIBAKE_RE);
  return hits ? hits.length : 0;
}

export function transferEncodingOf(headers: string): "quoted-printable" | "base64" | "7bit" {
  const m = headers.match(/Content-Transfer-Encoding:\s*([^\s;]+)/i);
  const enc = (m?.[1] || "7bit").toLowerCase();
  if (enc === "quoted-printable" || enc === "base64") return enc;
  return "7bit";
}

export function charsetOf(headersOrTypeLine: string): string {
  const m = headersOrTypeLine.match(/charset\s*=\s*["']?([^\s"';]+)/i);
  return normalizeCharset(m?.[1]);
}

/** Decode a MIME body part using CTE + charset from its headers. */
export function decodeMimeBody(
  headers: string,
  body: string,
  fallbackCharset = "utf-8",
): string {
  const charset = charsetOf(headers) || fallbackCharset;
  const cte = transferEncodingOf(headers);
  if (cte === "quoted-printable") return decodeQuotedPrintable(body, charset);
  if (cte === "base64") return decodeBase64Body(body, charset);
  // 7bit / 8bit: body may already be a JS string; re-encode as latin1 bytes then decode
  return decodeBytes(Buffer.from(body, "binary"), charset);
}
