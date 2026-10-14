"use client";

import { useEffect, useState } from "react";
import { PageHelpModal, usePageHelp } from "@/components/PageHelp";
import { TopNav } from "@/components/TopNav";
import { Button, Field, PageShell } from "@/components/ui";
import { PAGE_HELP } from "@/lib/help/pages";
import { PREFERRED_LANGUAGES } from "@/lib/settings/languages";

const pageMeta = PAGE_HELP.settings;

type WorkType = "fulltime" | "parttime" | "contracted";

type JobPreferences = {
  workTypes: WorkType[];
  noticeWeeks: number;
  salaryPeriod: "monthly" | "yearly";
  salaryKind: "gross" | "net";
  salaryCurrency: "eur" | "usd" | "other";
  salaryCurrencyOther: string;
  salaryMin: number | null;
  salaryNegotiable: boolean;
};

type Settings = {
  fullName: string | null;
  gmailAddress: string | null;
  hasGmailAppPassword: boolean;
  hasCursorApiKey: boolean;
  cursorApiKeyFromEnv?: boolean;
  cvFileName: string | null;
  hasCv: boolean;
  followUpDays: number;
  preferredLanguage: string;
  emailSignature: string | null;
  jobPreferences?: JobPreferences;
};

type CvItem = {
  id: string;
  fileName: string;
  label: string;
  language: string;
  tags: string[];
  isDefault: boolean;
  hasText: boolean;
};

const DEFAULT_PREFS: JobPreferences = {
  workTypes: [],
  noticeWeeks: 0,
  salaryPeriod: "monthly",
  salaryKind: "gross",
  salaryCurrency: "eur",
  salaryCurrencyOther: "",
  salaryMin: null,
  salaryNegotiable: true,
};

export default function SettingsPage() {
  const help = usePageHelp("settings");
  const [form, setForm] = useState({
    fullName: "",
    gmailAddress: "",
    gmailAppPassword: "",
    cursorApiKey: "",
    followUpDays: 5,
    preferredLanguage: "tr",
    emailSignature: "",
  });
  const [prefs, setPrefs] = useState<JobPreferences>(DEFAULT_PREFS);
  const [meta, setMeta] = useState<Settings | null>(null);
  const [cvs, setCvs] = useState<CvItem[]>([]);
  const [cvMax, setCvMax] = useState(4);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wipeOpen, setWipeOpen] = useState(false);

  async function loadCvs() {
    const res = await fetch("/api/settings/cv");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "CV listesi alınamadı");
    setCvs(data.cvs || []);
    setCvMax(data.max || 4);
  }

  async function load() {
    const res = await fetch("/api/settings");
    const data: Settings = await res.json();
    setMeta(data);
    setForm((f) => ({
      ...f,
      fullName: data.fullName || "",
      gmailAddress: data.gmailAddress || "",
      followUpDays: data.followUpDays || 5,
      preferredLanguage: data.preferredLanguage || "tr",
      emailSignature: data.emailSignature || "",
    }));
    setPrefs({ ...DEFAULT_PREFS, ...(data.jobPreferences || {}) });
    await loadCvs().catch(() => undefined);
  }

  useEffect(() => {
    void load();
  }, []);

  function toggleWorkType(t: WorkType) {
    setPrefs((p) => {
      const has = p.workTypes.includes(t);
      return {
        ...p,
        workTypes: has
          ? p.workTypes.filter((x) => x !== t)
          : [...p.workTypes, t],
      };
    });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, jobPreferences: prefs }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Kayıt başarısız");
      setMeta(data);
      if (data.jobPreferences) setPrefs({ ...DEFAULT_PREFS, ...data.jobPreferences });
      setForm((f) => ({ ...f, gmailAppPassword: "", cursorApiKey: "" }));
      setStatus("Kaydedildi");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function uploadCv(file: File) {
    setBusy(true);
    setStatus(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("language", form.preferredLanguage || "en");
      const res = await fetch("/api/settings/cv", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "CV yüklenemedi");
      setCvs(data.cvs || []);
      setStatus(`CV eklendi: ${data.entry?.label || file.name}`);
      await load();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function patchCv(
    id: string,
    patch: Partial<{ label: string; language: string; tags: string[]; isDefault: boolean }>,
  ) {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/settings/cv/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "CV güncellenemedi");
      setCvs(data.cvs || []);
      setStatus("CV güncellendi");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeCv(id: string) {
    if (!window.confirm("Bu CV silinsin mi?")) return;
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/settings/cv/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "CV silinemedi");
      setCvs(data.cvs || []);
      setStatus("CV silindi");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmWipe() {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch("/api/onboarding/reset", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Silme başarısız");
      setWipeOpen(false);
      try {
        for (const k of Object.keys(localStorage)) {
          if (k.startsWith("cmae.help.seen.")) localStorage.removeItem(k);
        }
      } catch {
        /* ignore */
      }
      // Hard navigation — soft router can keep stale (app) layout / RSC cache
      window.location.assign(data.redirectTo || "/onboarding");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <>
      <TopNav active="settings" onHelp={help.reopen} />
      <PageShell title={pageMeta.title} subtitle={pageMeta.subtitle}>
        <form className="cmae-form" onSubmit={save}>
          <section className="cmae-form-section">
            <h2 className="cmae-form-section-title">Profil</h2>
            <Field
              label="Ad Soyad"
              hint="Mail gövdesinde ve ek dosya adında kullanılır."
            >
              <input
                className="cmae-input"
                value={form.fullName}
                onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                placeholder="Adın Soyadın"
              />
            </Field>
          </section>

          <hr className="cmae-form-rule" />

          <section className="cmae-form-section">
            <h2 className="cmae-form-section-title">Gmail</h2>
            <Field
              label="Gmail adresi"
              hint={
                meta?.hasGmailAppPassword
                  ? "App Password kayıtlı ✓"
                  : "App Password henüz yok"
              }
            >
              <input
                className="cmae-input"
                type="email"
                value={form.gmailAddress}
                onChange={(e) => setForm({ ...form, gmailAddress: e.target.value })}
              />
            </Field>
            <Field
              label="Gmail App Password"
              hint="Boş bırakırsan mevcut şifre korunur."
            >
              <input
                className="cmae-input"
                type="password"
                autoComplete="new-password"
                placeholder="xxxx xxxx xxxx xxxx"
                value={form.gmailAppPassword}
                onChange={(e) =>
                  setForm({ ...form, gmailAppPassword: e.target.value })
                }
              />
            </Field>
          </section>

          <hr className="cmae-form-rule" />

          <section className="cmae-form-section">
            <h2 className="cmae-form-section-title">Cursor API Key</h2>
            <Field
              label="API Key"
              hint={
                meta?.hasCursorApiKey
                  ? "Veritabanında kayıtlı ✓ — boş bırakırsan korunur"
                  : meta?.cursorApiKeyFromEnv
                    ? ".env içinde CURSOR_API_KEY var — boş bırakabilirsin"
                    : "cursor.com/dashboard/api adresinden al"
              }
            >
              <input
                className="cmae-input"
                type="password"
                autoComplete="off"
                placeholder={meta?.hasCursorApiKey ? "••••••••" : "crsr_…"}
                value={form.cursorApiKey}
                onChange={(e) => setForm({ ...form, cursorApiKey: e.target.value })}
              />
            </Field>
          </section>

          <hr className="cmae-form-rule" />

          <section className="cmae-form-section">
            <h2 className="cmae-form-section-title">Mail tercihleri</h2>
            <div className="cmae-form-grid">
              <Field
                label="Tercih edilen dil"
                hint="Ana diliniz olarak seçmenizi tavsiye ederiz."
              >
                <select
                  className="cmae-input"
                  value={form.preferredLanguage}
                  onChange={(e) =>
                    setForm({ ...form, preferredLanguage: e.target.value })
                  }
                >
                  {PREFERRED_LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Follow-up günü"
                hint="Mailiniz karşılıksız kaldığında kaç gün sonra hatırlatma maili göndereceğinizi belirler. Önerilen: 4–7 gün."
              >
                <input
                  className="cmae-input"
                  type="number"
                  min={1}
                  max={30}
                  value={form.followUpDays}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      followUpDays: Number(e.target.value) || 5,
                    })
                  }
                />
              </Field>
            </div>
            <Field
              label="E-posta imzası"
              hint="Alt satırlar korunur; AI değiştiremez."
            >
              <textarea
                className="cmae-input cmae-textarea"
                rows={6}
                spellCheck={false}
                placeholder={
                  "Jane Doe\nBerlin, 10115\n+49 30 1234567\nwww.janedoe.dev"
                }
                value={form.emailSignature}
                onChange={(e) =>
                  setForm({ ...form, emailSignature: e.target.value })
                }
              />
            </Field>
          </section>

          <hr className="cmae-form-rule" />

          <section className="cmae-form-section">
            <h2 className="cmae-form-section-title">İş tercihleri</h2>
            <p className="cmae-form-hint">
              Çalışma tipi ve ihbar başvuru / follow-up metinlerinde geçer. Ücret
              yalnızca karşı taraf sorduğunda yanıtlarda kullanılır.
            </p>

            <Field label="Çalışma tipi" hint="Birden fazla seçilebilir">
              <div className="cmae-check-row">
                {(
                  [
                    ["fulltime", "Full-time"],
                    ["parttime", "Part-time"],
                    ["contracted", "Contracted"],
                  ] as const
                ).map(([id, label]) => (
                  <label key={id} className="cmae-check">
                    <input
                      type="checkbox"
                      checked={prefs.workTypes.includes(id)}
                      onChange={() => toggleWorkType(id)}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </Field>

            <Field
              label="İhbar süresi (hafta)"
              hint="0 = ab sofort / hemen başlayabilirim"
            >
              <input
                className="cmae-input"
                type="number"
                min={0}
                max={104}
                value={prefs.noticeWeeks}
                onChange={(e) =>
                  setPrefs({
                    ...prefs,
                    noticeWeeks: Math.max(0, Number(e.target.value) || 0),
                  })
                }
              />
            </Field>

            <h3 className="cmae-form-subsection">Ücret beklentisi</h3>
            <div className="cmae-form-grid">
              <Field label="Periyot">
                <select
                  className="cmae-input"
                  value={prefs.salaryPeriod}
                  onChange={(e) =>
                    setPrefs({
                      ...prefs,
                      salaryPeriod: e.target.value as "monthly" | "yearly",
                    })
                  }
                >
                  <option value="monthly">Aylık</option>
                  <option value="yearly">Yıllık</option>
                </select>
              </Field>
              <Field label="Brüt / Net">
                <select
                  className="cmae-input"
                  value={prefs.salaryKind}
                  onChange={(e) =>
                    setPrefs({
                      ...prefs,
                      salaryKind: e.target.value as "gross" | "net",
                    })
                  }
                >
                  <option value="gross">Brüt</option>
                  <option value="net">Net</option>
                </select>
              </Field>
              <Field label="Para birimi">
                <select
                  className="cmae-input"
                  value={prefs.salaryCurrency}
                  onChange={(e) =>
                    setPrefs({
                      ...prefs,
                      salaryCurrency: e.target.value as "eur" | "usd" | "other",
                    })
                  }
                >
                  <option value="eur">Euro (EUR)</option>
                  <option value="usd">Dolar (USD)</option>
                  <option value="other">Diğer</option>
                </select>
              </Field>
              {prefs.salaryCurrency === "other" ? (
                <Field label="Diğer para birimi" hint="ör. TL, TRY, CHF">
                  <input
                    className="cmae-input"
                    value={prefs.salaryCurrencyOther}
                    placeholder="TL"
                    onChange={(e) =>
                      setPrefs({ ...prefs, salaryCurrencyOther: e.target.value })
                    }
                  />
                </Field>
              ) : null}
              <Field label="Min ücret" hint="Beklediğin taban">
                <input
                  className="cmae-input"
                  type="number"
                  min={0}
                  value={prefs.salaryMin ?? ""}
                  placeholder="—"
                  onChange={(e) =>
                    setPrefs({
                      ...prefs,
                      salaryMin:
                        e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                />
              </Field>
            </div>
            <label className="cmae-check">
              <input
                type="checkbox"
                checked={prefs.salaryNegotiable}
                onChange={(e) =>
                  setPrefs({ ...prefs, salaryNegotiable: e.target.checked })
                }
              />
              Pazarlığa açığım
            </label>
          </section>

          <hr className="cmae-form-rule" />

          <section className="cmae-form-section">
            <h2 className="cmae-form-section-title">CV</h2>
            <p className="cmae-form-hint">
              En fazla {cvMax} PDF. Dil ve etiketlere göre başvuru / follow-up
              taslaklarına otomatik eklenir.
            </p>

            {cvs.length ? (
              <ul className="cmae-cv-list">
                {cvs.map((cv) => (
                  <li key={cv.id} className="cmae-cv-item">
                    <div className="cmae-form-grid">
                      <Field label="Etiket">
                        <input
                          className="cmae-input"
                          defaultValue={cv.label}
                          disabled={busy}
                          onBlur={(e) => {
                            const v = e.target.value.trim();
                            if (v && v !== cv.label) void patchCv(cv.id, { label: v });
                          }}
                        />
                      </Field>
                      <Field label="Dil">
                        <select
                          className="cmae-input"
                          value={cv.language}
                          disabled={busy}
                          onChange={(e) =>
                            void patchCv(cv.id, { language: e.target.value })
                          }
                        >
                          {PREFERRED_LANGUAGES.map((l) => (
                            <option key={l.code} value={l.code}>
                              {l.label}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Etiketler (virgülle)" hint="ör. marketing, frontend">
                        <input
                          className="cmae-input"
                          defaultValue={cv.tags.join(", ")}
                          disabled={busy}
                          onBlur={(e) => {
                            const tags = e.target.value
                              .split(/[,;]+/)
                              .map((t) => t.trim())
                              .filter(Boolean);
                            const same = tags.join(",") === cv.tags.join(",");
                            if (!same) void patchCv(cv.id, { tags });
                          }}
                        />
                      </Field>
                    </div>
                    <div className="cmae-cv-item-actions">
                      <label className="cmae-cv-default">
                        <input
                          type="radio"
                          name="cv-default"
                          checked={cv.isDefault}
                          disabled={busy}
                          onChange={() => void patchCv(cv.id, { isDefault: true })}
                        />
                        Varsayılan
                      </label>
                      <span className="cmae-form-status">{cv.fileName}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void removeCv(cv.id)}
                      >
                        Sil
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="cmae-form-hint">Henüz CV yok.</p>
            )}

            {cvs.length < cvMax ? (
              <Field label="PDF yükle">
                <input
                  type="file"
                  accept="application/pdf"
                  disabled={busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void uploadCv(file);
                    e.target.value = "";
                  }}
                />
              </Field>
            ) : (
              <p className="cmae-form-hint">
                Limit doldu ({cvMax}). Yeni eklemek için birini sil.
              </p>
            )}
          </section>

          <div className="cmae-form-actions">
            <Button type="submit" disabled={busy}>
              {busy ? "Kaydediliyor…" : "Kaydet"}
            </Button>
            {status ? <span className="cmae-form-status">{status}</span> : null}
          </div>

          <hr className="cmae-form-rule" />

          <section className="cmae-form-section">
            <h2 className="cmae-form-section-title">Tehlikeli bölge</h2>
            <p className="cmae-form-hint">
              Veritabanı, workspace şirket klasörleri, CV’ler ve arama geçmişi
              silinir. Uygulama sıfır kurulum gibi onboarding’e döner.
            </p>
            <Button
              type="button"
              variant="danger"
              disabled={busy}
              onClick={() => setWipeOpen(true)}
            >
              Tüm Verileri Sil
            </Button>
          </section>
        </form>
      </PageShell>

      <PageHelpModal
        pageId="settings"
        open={help.open}
        onClose={help.close}
      />

      {wipeOpen ? (
        <div
          className="term-modal-backdrop"
          role="presentation"
          onClick={() => !busy && setWipeOpen(false)}
        >
          <div
            className="term-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wipe-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="wipe-title">Tüm veriler silinsin mi?</h3>
            <p>
              Ayarlar, mailler, tracker, CV’ler, workspace klasörleri ve arama
              geçmişi kalıcı olarak silinir. Bu işlem geri alınamaz.
            </p>
            <div className="term-modal-actions">
              <button
                type="button"
                className="term-modal-btn term-modal-btn-ghost"
                onClick={() => setWipeOpen(false)}
                disabled={busy}
              >
                Vazgeç
              </button>
              <button
                type="button"
                className="term-modal-btn term-modal-btn-danger"
                onClick={() => void confirmWipe()}
                disabled={busy}
              >
                {busy ? "Siliniyor…" : "Evet, tümünü sil"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
