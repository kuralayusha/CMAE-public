"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Field } from "@/components/ui";
import { PREFERRED_LANGUAGES } from "@/lib/settings/languages";
import "./onboarding.css";

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

type CvItem = {
  id: string;
  fileName: string;
  label: string;
  language: string;
};

const STEPS = [
  "welcome",
  "profile",
  "gmail",
  "cursor",
  "prefs",
  "job",
  "cv",
  "boot",
] as const;

type StepId = (typeof STEPS)[number];

type BootStatus = "pending" | "running" | "ok" | "fail";

type BootItem = {
  id: string;
  label: string;
  status: BootStatus;
  detail?: string;
};

const BOOT_TEMPLATE: Omit<BootItem, "status" | "detail">[] = [
  { id: "db", label: "Database hazır" },
  { id: "profile", label: "Profil ve tercihler kaydedildi" },
  { id: "gmail", label: "Gmail IMAP bağlantısı deneniyor" },
  { id: "cursor", label: "Cursor API key deneniyor" },
  { id: "cv", label: "CV kütüphanesi hazır" },
  { id: "unlock", label: "Tracker / Araştır kilidi açılıyor" },
];

function freshBootItems(): BootItem[] {
  return BOOT_TEMPLATE.map((b) => ({ ...b, status: "pending" as const }));
}

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

export function OnboardingWizard() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasGmailPw, setHasGmailPw] = useState(false);
  const [hasCursorKey, setHasCursorKey] = useState(false);
  const [cursorFromEnv, setCursorFromEnv] = useState(false);
  const [cvs, setCvs] = useState<CvItem[]>([]);
  const [bootItems, setBootItems] = useState<BootItem[]>(freshBootItems);
  const [bootDone, setBootDone] = useState(false);
  const [bootFailMsg, setBootFailMsg] = useState<string | null>(null);

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

  const stepId: StepId = STEPS[step] ?? "welcome";

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/onboarding/status");
        const data = await res.json();
        if (data.complete) {
          router.replace("/tracker");
          return;
        }
        const s = data.settings || {};
        setForm((f) => ({
          ...f,
          fullName: s.fullName || "",
          gmailAddress: s.gmailAddress || "",
          followUpDays: s.followUpDays || 5,
          preferredLanguage: s.preferredLanguage || "tr",
          emailSignature: s.emailSignature || "",
        }));
        if (s.jobPreferences) {
          setPrefs({ ...DEFAULT_PREFS, ...s.jobPreferences });
        }
        setHasGmailPw(Boolean(s.hasGmailAppPassword));
        setHasCursorKey(Boolean(s.hasCursorApiKey));
        setCursorFromEnv(Boolean(s.cursorApiKeyFromEnv));
        setCvs(data.cvs || []);
      } catch {
        /* first boot */
      }
    })();
  }, [router]);

  const canNext = useMemo(() => {
    switch (stepId) {
      case "welcome":
        return true;
      case "profile":
        return Boolean(form.fullName.trim());
      case "gmail":
        return (
          form.gmailAddress.trim() &&
          (form.gmailAppPassword.trim().length >= 8 || hasGmailPw)
        );
      case "cursor":
        return (
          form.cursorApiKey.trim().length >= 8 ||
          hasCursorKey ||
          cursorFromEnv
        );
      case "prefs":
        return (
          form.preferredLanguage.trim() &&
          form.emailSignature.trim().length >= 3 &&
          form.followUpDays >= 1
        );
      case "job":
        return (
          prefs.workTypes.length >= 1 &&
          prefs.noticeWeeks >= 0 &&
          prefs.salaryMin != null &&
          prefs.salaryMin >= 0 &&
          (prefs.salaryCurrency !== "other" ||
            prefs.salaryCurrencyOther.trim().length > 0)
        );
      case "cv":
        return cvs.length >= 1;
      case "boot":
        return true;
      default:
        return false;
    }
  }, [stepId, form, prefs, cvs, hasGmailPw, hasCursorKey, cursorFromEnv]);

  async function persistPartial() {
    const body: Record<string, unknown> = {
      fullName: form.fullName,
      gmailAddress: form.gmailAddress,
      followUpDays: form.followUpDays,
      preferredLanguage: form.preferredLanguage,
      emailSignature: form.emailSignature,
      jobPreferences: prefs,
    };
    if (form.gmailAppPassword.trim()) {
      body.gmailAppPassword = form.gmailAppPassword;
    }
    if (form.cursorApiKey.trim()) {
      body.cursorApiKey = form.cursorApiKey;
    }
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Kayıt başarısız");
    setHasGmailPw(Boolean(data.hasGmailAppPassword) || hasGmailPw);
    setHasCursorKey(Boolean(data.hasCursorApiKey));
    setCursorFromEnv(Boolean(data.cursorApiKeyFromEnv));
    setForm((f) => ({ ...f, gmailAppPassword: "", cursorApiKey: "" }));
  }

  async function goNext() {
    setError(null);
    if (stepId === "welcome") {
      setStep(1);
      return;
    }
    if (stepId === "cv") {
      setBusy(true);
      try {
        await persistPartial();
        // Gaps check without marking complete — live verify runs on boot
        const statusRes = await fetch("/api/onboarding/status");
        const statusData = await statusRes.json();
        const gaps = (statusData.gaps || []) as string[];
        if (gaps.length) {
          throw new Error(`Eksik: ${gaps.join(", ")}`);
        }
        setBusy(false);
        setStep(STEPS.length - 1);
        void runBootSequence();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      }
      return;
    }
    if (stepId === "boot") return;

    setBusy(true);
    try {
      await persistPartial();
      setStep((s) => Math.min(s + 1, STEPS.length - 1));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function goBack() {
    setError(null);
    setStep((s) => Math.max(0, s - 1));
  }

  function patchBoot(id: string, patch: Partial<BootItem>) {
    setBootItems((prev) =>
      prev.map((b) => (b.id === id ? { ...b, ...patch } : b)),
    );
  }

  function sleep(ms: number) {
    return new Promise<void>((r) => window.setTimeout(r, ms));
  }

  async function runBootSequence() {
    setBootItems(freshBootItems());
    setBootDone(false);
    setBootFailMsg(null);

    const softOk = async (id: string, okLabel: string) => {
      patchBoot(id, { status: "running" });
      await sleep(420);
      patchBoot(id, { status: "ok", label: okLabel });
    };

    try {
      await softOk("db", "Database hazır");
      await softOk("profile", "Profil ve tercihler kaydedildi");

      patchBoot("gmail", {
        status: "running",
        label: "Gmail IMAP bağlantısı deneniyor…",
      });

      const gmailRes = await fetch("/api/onboarding/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ check: "gmail" }),
      });
      const gmailData = await gmailRes.json();
      if (!gmailData.gmail?.ok) {
        const msg =
          gmailData.gmail?.error ||
          gmailData.error ||
          "Gmail bağlantısı başarısız";
        patchBoot("gmail", {
          status: "fail",
          label: "Gmail bağlantısı başarısız",
          detail: msg,
        });
        setBootFailMsg(msg);
        await sleep(1600);
        setError(msg);
        setStep(STEPS.indexOf("gmail"));
        return;
      }

      patchBoot("gmail", {
        status: "ok",
        label: "Gmail IMAP bağlantısı doğrulandı",
      });

      patchBoot("cursor", {
        status: "running",
        label: "Cursor API key deneniyor…",
      });

      const cursorRes = await fetch("/api/onboarding/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ check: "cursor" }),
      });
      const cursorData = await cursorRes.json();
      if (!cursorData.cursor?.ok) {
        const msg =
          cursorData.cursor?.error ||
          cursorData.error ||
          "Cursor API key doğrulanamadı";
        patchBoot("cursor", {
          status: "fail",
          label: "Cursor API key başarısız",
          detail: msg,
        });
        setBootFailMsg(msg);
        await sleep(1600);
        setError(msg);
        setStep(STEPS.indexOf("cursor"));
        return;
      }

      patchBoot("cursor", {
        status: "ok",
        label: "Cursor API key doğrulandı",
      });

      await softOk("cv", "CV kütüphanesi hazır");

      patchBoot("unlock", {
        status: "running",
        label: "Tracker / Araştır kilidi açılıyor…",
      });

      const completeRes = await fetch("/api/onboarding/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const completeData = await completeRes.json();
      if (!completeRes.ok) {
        throw new Error(
          completeData.error ||
            (completeData.gaps
              ? `Eksik: ${(completeData.gaps as string[]).join(", ")}`
              : "Tamamlanamadı"),
        );
      }

      patchBoot("unlock", {
        status: "ok",
        label: "Tracker / Araştır kilidi açıldı",
      });
      setBootDone(true);
      await sleep(1200);
      router.replace("/tracker");
      router.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setBootFailMsg(msg);
      setError(msg);
      await sleep(1200);
      setStep(STEPS.indexOf("cv"));
    }
  }

  async function uploadCv(file: File) {
    setBusy(true);
    setError(null);
    try {
      await persistPartial();
      const fd = new FormData();
      fd.append("file", file);
      fd.append("language", form.preferredLanguage || "en");
      const res = await fetch("/api/settings/cv", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "CV yüklenemedi");
      setCvs(data.cvs || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeCv(id: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/settings/cv/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "CV silinemedi");
      setCvs(data.cvs || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function patchCvLanguage(id: string, language: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/settings/cv/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Dil güncellenemedi");
      setCvs(data.cvs || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

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

  if (stepId === "boot") {
    return (
      <div className="cmae-onb">
        <div className="cmae-onb-brand">CMAE</div>
        <div className="cmae-onb-boot">
          <h1 className="cmae-onb-boot-title">Bağlantılar doğrulanıyor…</h1>
          <p className="cmae-onb-boot-lead">
            Gmail IMAP ve Cursor API gerçekten deneniyor. Biri başarısız olursa
            ilgili adıma geri dönersin.
          </p>
          <ul className="cmae-onb-boot-list">
            {bootItems.map((item) => (
              <li
                key={item.id}
                className={`cmae-onb-boot-item is-visible is-${item.status}`}
              >
                <span className="cmae-onb-tick" aria-hidden>
                  {item.status === "ok"
                    ? "✓"
                    : item.status === "fail"
                      ? "!"
                      : item.status === "running"
                        ? "…"
                        : ""}
                </span>
                <span className="cmae-onb-boot-text">
                  <span>{item.label}</span>
                  {item.detail ? (
                    <span className="cmae-onb-boot-detail">{item.detail}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
          {bootFailMsg ? (
            <p className="cmae-onb-boot-fail is-visible">
              {bootFailMsg} — ilgili adıma dönülüyor…
            </p>
          ) : (
            <p
              className={`cmae-onb-boot-done${bootDone ? " is-visible" : ""}`}
            >
              Hazırsın — Tracker’a geçiliyor…
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="cmae-onb">
      <div className="cmae-onb-brand">CMAE</div>
      <div className="cmae-onb-card">
        <div className="cmae-onb-progress" aria-hidden>
          {STEPS.slice(0, -1).map((_, i) => (
            <span
              key={STEPS[i]}
              className={
                i < step ? "is-done" : i === step ? "is-active" : undefined
              }
            />
          ))}
        </div>
        <p className="cmae-onb-step-label">
          Adım {step + 1} / {STEPS.length - 1}
        </p>

        {stepId === "welcome" ? (
          <>
            <h1 className="cmae-onb-title">CMAE’ye hoş geldin</h1>
            <p className="cmae-onb-lead">
              CMAE; şirket araştırması, kişiselleştirilmiş başvuru mailleri,
              Gmail taslakları ve follow-up takibini tek yerde yönetir.
            </p>
          </>
        ) : null}

        {stepId === "profile" ? (
          <>
            <h1 className="cmae-onb-title">Profilin</h1>
            <p className="cmae-onb-why">
              Adın mail gövdesinde ve ek dosya adında (ör. Ad_Soyad_CV.pdf)
              kullanılır. Gmail hesabını sonraki adımda bağlarsın.
            </p>
            <div className="cmae-onb-fields">
              <Field label="Ad Soyad">
                <input
                  className="cmae-input"
                  value={form.fullName}
                  onChange={(e) =>
                    setForm({ ...form, fullName: e.target.value })
                  }
                  placeholder="Adın Soyadın"
                  autoFocus
                />
              </Field>
            </div>
          </>
        ) : null}

        {stepId === "gmail" ? (
          <>
            <h1 className="cmae-onb-title">Gmail bağlantısı</h1>
            <p className="cmae-onb-why">
              Tracker gelen/giden mailleri IMAP ile okur; başvuru ve follow-up
              taslaklarını Gmail Drafts klasörüne yazar. Normal şifre değil — App
              Password gerekir.
            </p>
            <ol className="cmae-onb-guide">
              <li>
                Google hesabında{" "}
                <strong>2 adımlı doğrulama</strong> açık olmalı.
              </li>
              <li>
                <a
                  href="https://myaccount.google.com/apppasswords"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  App passwords
                </a>{" "}
                sayfasını aç.
              </li>
              <li>
                Uygulama adı olarak örn. <strong>CMAE</strong> yaz →{" "}
                <strong>Create</strong>.
              </li>
              <li>
                Oluşan <strong>16 haneli şifreyi</strong> kopyala ve aşağıya
                yapıştır.
              </li>
            </ol>
            <div className="cmae-onb-fields">
              <Field label="Gmail adresi">
                <input
                  className="cmae-input"
                  type="email"
                  value={form.gmailAddress}
                  onChange={(e) =>
                    setForm({ ...form, gmailAddress: e.target.value })
                  }
                />
              </Field>
              <Field
                label="Gmail App Password"
                hint={
                  hasGmailPw
                    ? "Kayıtlı bir şifre var — değiştirmek için yenisini yapıştır"
                    : "Boşluklarla veya bitişik yapıştırabilirsin"
                }
              >
                <input
                  className="cmae-input"
                  type="password"
                  autoComplete="new-password"
                  placeholder={hasGmailPw ? "•••• •••• •••• ••••" : ""}
                  value={form.gmailAppPassword}
                  onChange={(e) =>
                    setForm({ ...form, gmailAppPassword: e.target.value })
                  }
                />
              </Field>
            </div>
          </>
        ) : null}

        {stepId === "cursor" ? (
          <>
            <h1 className="cmae-onb-title">Cursor API Key</h1>
            <p className="cmae-onb-why">
              Search ajanları (keşif, araştırma, mail yazımı) ve Tracker’daki
              follow-up / yanıt taslakları bu anahtarla çalışır.
            </p>
            <ol className="cmae-onb-guide">
              <li>
                <a
                  href="https://cursor.com/dashboard/api"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Cursor Dashboard → API Keys
                </a>{" "}
                sayfasını aç.
              </li>
              <li>
                Yeni bir API key oluştur (istediğin adı ver, örn.{" "}
                <strong>CMAE local</strong>).
              </li>
              <li>
                Anahtarı kopyala ve <strong>bir kez</strong> aşağıya yapıştır —
                sonra güvenli saklanır.
              </li>
            </ol>
            <div className="cmae-onb-fields">
              <Field
                label="Cursor API Key"
                hint={
                  hasCursorKey
                    ? "Veritabanında kayıtlı — değiştirmek için yenisini yapıştır"
                    : cursorFromEnv
                      ? ".env içindeki CURSOR_API_KEY kullanılacak — boş bırakabilirsin"
                      : undefined
                }
              >
                <input
                  className="cmae-input"
                  type="password"
                  autoComplete="off"
                  placeholder={hasCursorKey ? "••••••••" : "crsr_…"}
                  value={form.cursorApiKey}
                  onChange={(e) =>
                    setForm({ ...form, cursorApiKey: e.target.value })
                  }
                />
              </Field>
            </div>
          </>
        ) : null}

        {stepId === "prefs" ? (
          <>
            <h1 className="cmae-onb-title">Mail tercihlerin</h1>
            <p className="cmae-onb-why">
              Dil ikinci taslak dilini belirler; imza her mailin sonuna aynen
              eklenir.
            </p>
            <div className="cmae-onb-fields">
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
              <Field
                label="E-posta imzası"
                hint="Alt satırlar korunur; AI değiştiremez"
              >
                <textarea
                  className="cmae-input cmae-textarea"
                  rows={5}
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
            </div>
          </>
        ) : null}

        {stepId === "job" ? (
          <>
            <h1 className="cmae-onb-title">İş tercihlerin</h1>
            <p className="cmae-onb-why">
              Çalışma tipi ve ihbar başvuru / follow-up metinlerinde geçer. Ücret
              yalnızca karşı taraf sorduğunda yanıtlarda kullanılır; maillerde
              kendiliğinden yazılmaz.
            </p>
            <div className="cmae-onb-fields">
              <Field label="Çalışma tipi" hint="En az birini seç">
                <div className="cmae-onb-check-row">
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
                hint="0 = ab sofort / hemen"
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
                        salaryCurrency: e.target.value as
                          | "eur"
                          | "usd"
                          | "other",
                      })
                    }
                  >
                    <option value="eur">Euro</option>
                    <option value="usd">Dolar</option>
                    <option value="other">Diğer</option>
                  </select>
                </Field>
                {prefs.salaryCurrency === "other" ? (
                  <Field label="Diğer para birimi">
                    <input
                      className="cmae-input"
                      value={prefs.salaryCurrencyOther}
                      placeholder="TL"
                      onChange={(e) =>
                        setPrefs({
                          ...prefs,
                          salaryCurrencyOther: e.target.value,
                        })
                      }
                    />
                  </Field>
                ) : null}
                <Field label="Min ücret">
                  <input
                    className="cmae-input"
                    type="number"
                    min={0}
                    value={prefs.salaryMin ?? ""}
                    onChange={(e) =>
                      setPrefs({
                        ...prefs,
                        salaryMin:
                          e.target.value === ""
                            ? null
                            : Number(e.target.value),
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
                    setPrefs({
                      ...prefs,
                      salaryNegotiable: e.target.checked,
                    })
                  }
                />
                Pazarlığa açığım
              </label>
            </div>
          </>
        ) : null}

        {stepId === "cv" ? (
          <>
            <h1 className="cmae-onb-title">CV’ni yükle</h1>
            <p className="cmae-onb-why">
              Metin AI’ın kişiselleştirilmiş mail yazması için parse edilir; PDF
              başvuru ve follow-up Gmail taslaklarına otomatik eklenir. En az bir
              CV zorunlu — dil/etiketleri sonra Ayarlar’dan düzenleyebilirsin.
            </p>
            {cvs.length ? (
              <ul className="cmae-onb-cv-list">
                {cvs.map((cv) => (
                  <li key={cv.id}>
                    <span className="cmae-onb-cv-name">
                      {cv.label || cv.fileName}
                    </span>
                    <select
                      className="cmae-input cmae-onb-cv-lang"
                      value={cv.language}
                      disabled={busy}
                      aria-label="CV dili"
                      onChange={(e) =>
                        void patchCvLanguage(cv.id, e.target.value)
                      }
                    >
                      {PREFERRED_LANGUAGES.map((l) => (
                        <option key={l.code} value={l.code}>
                          {l.label}
                        </option>
                      ))}
                    </select>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void removeCv(cv.id)}
                    >
                      Sil
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="cmae-onb-hint">Henüz CV yok.</p>
            )}
            {cvs.length < 4 ? (
              <Field label="PDF yükle">
                <input
                  className="cmae-onb-file"
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
            ) : null}
          </>
        ) : null}

        {error ? <p className="cmae-onb-error">{error}</p> : null}

        <div className="cmae-onb-actions">
          {step > 0 ? (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={goBack}
            >
              Geri
            </Button>
          ) : (
            <span />
          )}
          <div className="cmae-onb-actions-right">
            <Button
              type="button"
              disabled={busy || !canNext}
              onClick={() => void goNext()}
            >
              {busy
                ? "…"
                : stepId === "cv"
                  ? "Sistemi başlat"
                  : stepId === "welcome"
                    ? "Başla"
                    : "İleri"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
