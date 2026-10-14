import type { SpecialistId, TermKind } from "./types";

const AGENT_TR: Record<string, string> = {
  conductor: "Orkestra şefi",
  scout: "Keşif ajanı",
  jobfit: "İlan eşleştirme ajanı",
  contact: "İletişim ajanı",
  research: "Araştırma ajanı",
  writer: "Yazım ajanı",
  reviewer: "Kontrol ajanı",
};

export function agentLabel(agent?: SpecialistId | "conductor" | string | null) {
  if (!agent) return "Sistem";
  return AGENT_TR[agent] || agent;
}

/** Asıl cümle önde, ajan parantezde — göz yormasın */
export function withAgent(
  action: string,
  agent?: SpecialistId | "conductor" | string | null,
): string {
  const body = action.replace(/\s+/g, " ").trim().replace(/\.$/, "");
  const who = agentLabel(agent);
  return `${body}. (${who})`;
}

/** Detay satırından okunabilir özet üret (eski loglar / eksik plain için) */
export function derivePlain(input: {
  kind: TermKind;
  text: string;
  agent?: SpecialistId;
}): string | null {
  const raw = input.text.replace(/^\[[^\]]+\]\s*/, "").trim();
  const agent = input.agent || guessAgent(input.text);

  if (input.kind === "curl") {
    const url = raw.match(/https?:\/\/[^\s'"]+/)?.[0];
    return withAgent(
      url ? `Web sayfası indiriliyor: ${shortUrl(url)}` : "İnternetten veri çekiliyor",
      agent || "scout",
    );
  }
  if (input.kind === "python") {
    return withAgent("Metin içinde e-posta / veri taranıyor", agent || "contact");
  }
  if (input.kind === "err") {
    return withAgent(`Sorun: ${clip(raw, 110)}`, agent);
  }
  if (input.kind === "ok") {
    return withAgent(`Tamamlandı: ${clip(stripDecor(raw), 120)}`, agent);
  }

  if (/dispatch →\s*(\w+)/i.test(raw)) {
    const m = raw.match(/dispatch →\s*(\w+)/i);
    return withAgent(`İş ${agentLabel(m?.[1])} ajanına verildi`, "conductor");
  }
  if (/REWIND →\s*(\w+)/i.test(raw)) {
    const m = raw.match(/REWIND →\s*(\w+)/i);
    return withAgent(
      `Paket beğenilmedi; ${agentLabel(m?.[1])} adımından itibaren yeniden deneniyor`,
      "reviewer",
    );
  }
  if (/workflow complete|done ·/i.test(raw)) {
    return withAgent("Araştırma tamamlandı", "conductor");
  }
  if (/CANCEL|aborted \(canceled\)/i.test(raw)) {
    return withAgent("İş kullanıcı tarafından iptal edildi", "conductor");
  }
  if (/session|specialists:/i.test(raw)) {
    return withAgent("Araştırma başlatıldı", "conductor");
  }
  if (/online/i.test(raw)) {
    return withAgent("Göreve başlandı", agent);
  }
  if (/Ana sayfa|sayfa çek/i.test(raw)) {
    return withAgent("Sitenin ana sayfası inceleniyor", agent || "scout");
  }
  if (/Ziyaret|Path denemesi|rota/i.test(raw)) {
    return withAgent("İlgili sayfalar dolaşılıyor", agent || "scout");
  }
  if (/Şirket adı/i.test(raw)) {
    return withAgent("Şirket adı çıkarılıyor", agent || "scout");
  }
  if (/İlan–CV|ilan/i.test(raw) && (input.agent === "jobfit" || /jobfit/i.test(input.text))) {
    return withAgent("CV’ye uygun açık pozisyon aranıyor", "jobfit");
  }
  if (/e-posta|email|iletisim|İletişim/i.test(raw)) {
    return withAgent("Başvuru için uygun e-posta aranıyor", agent || "contact");
  }
  if (/Sorgu:|Harici|şirket profili|Research/i.test(raw)) {
    return withAgent("Şirket hakkında dış kaynaklardan bilgi toplanıyor", agent || "research");
  }
  if (/Mail taslağı|Mail \(/i.test(raw)) {
    return withAgent("Başvuru e-postası taslağı yazılıyor", agent || "writer");
  }
  if (/skor|PASS|REWIND|Paket/i.test(raw)) {
    return withAgent("Başvuru paketi puanlanıyor", agent || "reviewer");
  }
  if (/Model düşünüyor|↳/i.test(raw)) {
    if (raw.startsWith("↳")) return null;
    return withAgent("Durum değerlendiriliyor", agent);
  }
  if (/bytes|preview:|stderr/i.test(raw)) {
    return null;
  }

  const cleaned = clip(stripDecor(raw), 140);
  if (!cleaned || cleaned.length < 3) return null;
  return withAgent(cleaned, agent);
}

function guessAgent(text: string): string | undefined {
  const m = text.match(/^\[([a-z]+)\]/i);
  return m?.[1];
}

function stripDecor(s: string) {
  return s.replace(/^[◆▶⏪·↳✖\s$]+/, "").trim();
}

function shortUrl(u: string) {
  try {
    const x = new URL(u);
    return x.hostname.replace(/^www\./, "") + (x.pathname === "/" ? "" : x.pathname.slice(0, 40));
  } catch {
    return clip(u, 60);
  }
}

function clip(s: string, n: number) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}
