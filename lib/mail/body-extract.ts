import { createHash } from "crypto";
import { decodeMimeBody, repairUtf8Mojibake } from "@/lib/tracker/mail-text";

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

type StructureNode = {
  part?: string;
  type: string;
  childNodes?: StructureNode[];
};

/** Prefer text/plain part id, else text/html. */
export function findTextPartIds(
  structure: StructureNode | null | undefined,
): { plain: string | null; html: string | null } {
  let plain: string | null = null;
  let html: string | null = null;

  function walk(node: StructureNode | undefined, path: string) {
    if (!node) return;
    const type = (node.type || "").toLowerCase();
    const part = node.part || path || "1";
    if (type === "text/plain" && !plain) plain = part;
    if (type === "text/html" && !html) html = part;
    if (node.childNodes?.length) {
      for (let i = 0; i < node.childNodes.length; i++) {
        walk(node.childNodes[i], node.childNodes[i]?.part || `${part}.${i + 1}`);
      }
    }
  }

  walk(structure || undefined, "1");
  return { plain, html };
}

export function textFromBodyPart(
  buf: Buffer | undefined,
  kind: "plain" | "html",
): string {
  if (!buf?.length) return "";
  const raw = buf.toString("utf8");
  const decoded = repairUtf8Mojibake(raw);
  const text =
    kind === "html" ? stripHtml(decoded) : decoded.replace(/\s+/g, " ");
  return text.trim().slice(0, 8000);
}

/** Fallback when only TEXT / HEADER blobs are available. */
export function extractBodyFromRaw(
  source: Buffer | string | null | undefined,
): string {
  if (!source) return "";
  const raw =
    typeof source === "string" ? source : source.toString("binary");

  const part =
    matchMimePart(raw, "text/plain") || matchMimePart(raw, "text/html");
  if (part) {
    const decoded = repairUtf8Mojibake(
      decodeMimeBody(part.headers, part.body),
    );
    const text =
      part.kind === "html" ? stripHtml(decoded) : decoded.replace(/\s+/g, " ");
    return text.trim().slice(0, 8000);
  }

  const split = raw.match(/^([\s\S]*?)\r?\n\r?\n([\s\S]*)$/);
  if (split) {
    const decoded = repairUtf8Mojibake(
      decodeMimeBody(split[1] || "", split[2] || ""),
    );
    return stripHtml(decoded).slice(0, 8000);
  }
  return stripHtml(repairUtf8Mojibake(raw)).slice(0, 8000);
}

function matchMimePart(
  raw: string,
  type: "text/plain" | "text/html",
): { headers: string; body: string; kind: "plain" | "html" } | null {
  const re = new RegExp(
    `(Content-Type:\\s*${type.replace("/", "\\/")}[^\\r\\n]*(?:\\r?\\n[^\\r\\n]+)*)\\r?\\n\\r?\\n([\\s\\S]*?)(?=\\r?\\n--[\\w=]|\\r?\\nContent-Type:|$)`,
    "i",
  );
  const m = raw.match(re);
  if (!m?.[1] || m[2] == null) return null;
  return {
    headers: m[1],
    body: m[2],
    kind: type === "text/html" ? "html" : "plain",
  };
}

export function headersHash(
  from: string,
  to: string,
  subject: string,
  dateIso: string,
): string {
  return createHash("sha256")
    .update([from, to, subject, dateIso].join("|"))
    .digest("hex")
    .slice(0, 32);
}

export function parseHeaderBlock(buf: Buffer | undefined): Record<string, string> {
  if (!buf?.length) return {};
  const text = buf.toString("utf8");
  const out: Record<string, string> = {};
  let current: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s/.test(line) && current) {
      out[current] = `${out[current]} ${line.trim()}`.trim();
      continue;
    }
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m) {
      current = m[1].toLowerCase();
      out[current] = (m[2] || "").trim();
    }
  }
  return out;
}
