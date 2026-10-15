"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/components/I18nProvider";
import { Button, Field } from "@/components/ui";
import { APP_LANGUAGE, type LocalePack } from "@/lib/i18n/types";
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
  "language",
  "localePrep",
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

/** Progress dots exclude language / localePrep / boot. */
const FLOW_STEPS = STEPS.filter(
  (s) => s !== "language" && s !== "localePrep" && s !== "boot",
);

type BootStatus = "pending" | "running" | "ok" | "fail";

type BootItem = {
  id: string;
  label: string;
  status: BootStatus;
  detail?: string;
};

const BOOT_TEMPLATE: Omit<BootItem, "status" | "detail">[] = [
  { id: "db", label: "Database ready" },
  { id: "profile", label: "Profile and preferences saved" },
  { id: "gmail", label: "Trying Gmail IMAP connection" },
  { id: "cursor", label: "Trying Cursor API key" },
  { id: "cv", label: "CV library ready" },
  { id: "unlock", label: "Unlocking Tracker / Search" },
];

const LOCALE_PREP_TEMPLATE: Omit<BootItem, "status" | "detail">[] = [
  { id: "selected", label: "Language selected" },
  { id: "contacting", label: "Contacting translation service" },
  { id: "preparing", label: "Preparing your language pack" },
  { id: "writing", label: "Writing locale files" },
  { id: "switching", label: "Switching UI to your language" },
];

const LOCALE_PREP_MIN_MS = 3200;

function freshBootItems(): BootItem[] {
  return BOOT_TEMPLATE.map((b) => ({ ...b, status: "pending" as const }));
}

function freshLocalePrepItems(): BootItem[] {
  return LOCALE_PREP_TEMPLATE.map((b) => ({
    ...b,
    status: "pending" as const,
  }));
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
  const { t, setPack } = useI18n();
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
  const [localePrepItems, setLocalePrepItems] = useState<BootItem[]>(
    freshLocalePrepItems,
  );
  const [localePrepDone, setLocalePrepDone] = useState(false);
  const [localePrepFailMsg, setLocalePrepFailMsg] = useState<string | null>(
    null,
  );

  const [form, setForm] = useState({
    fullName: "",
    gmailAddress: "",
    gmailAppPassword: "",
    cursorApiKey: "",
    followUpDays: 5,
    preferredLanguage: "en",
    emailSignature: "",
  });
  const [prefs, setPrefs] = useState<JobPreferences>(DEFAULT_PREFS);

  const stepId: StepId = STEPS[step] ?? "language";

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
          preferredLanguage: s.preferredLanguage || "en",
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
      case "language":
        return Boolean(form.preferredLanguage.trim());
      case "localePrep":
        return false;
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
          form.emailSignature.trim().length >= 3 && form.followUpDays >= 1
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
    if (!res.ok) throw new Error(data.error || "Save failed");
    setHasGmailPw(Boolean(data.hasGmailAppPassword) || hasGmailPw);
    setHasCursorKey(Boolean(data.hasCursorApiKey));
    setCursorFromEnv(Boolean(data.cursorApiKeyFromEnv));
    setForm((f) => ({ ...f, gmailAppPassword: "", cursorApiKey: "" }));
  }

  async function goNext() {
    setError(null);
    if (stepId === "language") {
      setStep(STEPS.indexOf("localePrep"));
      void runLocalePrep();
      return;
    }
    if (stepId === "localePrep") return;
    if (stepId === "welcome") {
      setStep(STEPS.indexOf("profile"));
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
          throw new Error(`Missing: ${gaps.join(", ")}`);
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
    if (stepId === "localePrep" || stepId === "boot") return;
    if (stepId === "welcome") {
      setStep(STEPS.indexOf("language"));
      return;
    }
    setStep((s) => Math.max(0, s - 1));
  }

  function patchBoot(id: string, patch: Partial<BootItem>) {
    setBootItems((prev) =>
      prev.map((b) => (b.id === id ? { ...b, ...patch } : b)),
    );
  }

  function patchLocalePrep(id: string, patch: Partial<BootItem>) {
    setLocalePrepItems((prev) =>
      prev.map((b) => (b.id === id ? { ...b, ...patch } : b)),
    );
  }

  function sleep(ms: number) {
    return new Promise<void>((r) => window.setTimeout(r, ms));
  }

  async function runLocalePrep() {
    setLocalePrepItems(freshLocalePrepItems());
    setLocalePrepDone(false);
    setLocalePrepFailMsg(null);
    const lang = form.preferredLanguage.trim() || "en";
    const started = Date.now();

    const animate = async () => {
      const order = LOCALE_PREP_TEMPLATE.map((x) => x.id);
      for (const id of order) {
        patchLocalePrep(id, { status: "running" });
        await sleep(520);
        patchLocalePrep(id, { status: "ok" });
      }
    };

    const translate = async () => {
      const res = await fetch("/api/i18n/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetLanguage: lang }),
      });
      const data = await res.json();
      if (!res.ok) {
        const errMsg = String(data.error || "Language pack translation failed");
        // No Cursor key yet — save preference and continue in English UI;
        // boot will retry translation after the key is verified.
        if (/api key/i.test(errMsg) && lang.toLowerCase().slice(0, 2) !== "en") {
          await fetch("/api/settings", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ preferredLanguage: lang }),
          });
          const packRes = await fetch("/api/i18n/pack");
          if (packRes.ok) {
            const packData = await packRes.json();
            setPack(APP_LANGUAGE, (packData.en || packData.pack) as LocalePack);
          }
          setForm((f) => ({ ...f, preferredLanguage: lang }));
          return { deferred: true as const };
        }
        throw new Error(errMsg);
      }
      setPack(String(data.code || lang), data.pack as LocalePack);
      setForm((f) => ({
        ...f,
        preferredLanguage: String(data.code || lang),
      }));
      return { deferred: false as const };
    };

    try {
      await Promise.all([animate(), translate()]);
      const elapsed = Date.now() - started;
      if (elapsed < LOCALE_PREP_MIN_MS) {
        await sleep(LOCALE_PREP_MIN_MS - elapsed);
      }
      setLocalePrepDone(true);
      await sleep(700);
      setStep(STEPS.indexOf("welcome"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLocalePrepFailMsg(msg);
      setError(msg);
      const last = LOCALE_PREP_TEMPLATE[LOCALE_PREP_TEMPLATE.length - 1]!;
      patchLocalePrep(last.id, { status: "fail", detail: msg });
      await sleep(1600);
      setStep(STEPS.indexOf("language"));
    }
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
      await softOk("db", "Database ready");
      await softOk("profile", "Profile and preferences saved");

      patchBoot("gmail", {
        status: "running",
        label: "Trying Gmail IMAP connection…",
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
          "Gmail connection failed";
        patchBoot("gmail", {
          status: "fail",
          label: "Gmail connection failed",
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
        label: "Gmail IMAP connection verified",
      });

      patchBoot("cursor", {
        status: "running",
        label: "Trying Cursor API key…",
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
          "Cursor API key could not be verified";
        patchBoot("cursor", {
          status: "fail",
          label: "Cursor API key failed",
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
        label: "Cursor API key verified",
      });

      // Finish deferred locale pack now that Cursor key works
      const pref = form.preferredLanguage.trim() || "en";
      if (pref.toLowerCase().slice(0, 2) !== "en") {
        try {
          const tr = await fetch("/api/i18n/translate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ targetLanguage: pref }),
          });
          const trData = await tr.json();
          if (tr.ok && trData.pack) {
            setPack(String(trData.code || pref), trData.pack as LocalePack);
          }
        } catch {
          /* keep English UI */
        }
      }

      await softOk("cv", "CV library ready");

      patchBoot("unlock", {
        status: "running",
        label: "Unlocking Tracker / Search…",
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
              ? `Missing: ${(completeData.gaps as string[]).join(", ")}`
              : "Could not complete"),
        );
      }

      patchBoot("unlock", {
        status: "ok",
        label: "Tracker / Search unlocked",
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
      if (!res.ok) throw new Error(data.error || "Could not upload CV");
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
      if (!res.ok) throw new Error(data.error || "Could not delete CV");
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
      if (!res.ok) throw new Error(data.error || "Could not update language");
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

  if (stepId === "localePrep") {
    return (
      <div className="cmae-onb">
        <div className="cmae-onb-brand">CMAE</div>
        <div className="cmae-onb-boot">
          <h1 className="cmae-onb-boot-title">Preparing your language…</h1>
          <p className="cmae-onb-boot-lead">
            We are building a full UI language pack for you. This only happens
            once unless you change language later.
          </p>
          <ul className="cmae-onb-boot-list">
            {localePrepItems.map((item) => (
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
          {localePrepFailMsg ? (
            <p className="cmae-onb-boot-fail is-visible">
              {localePrepFailMsg} — returning to language selection…
            </p>
          ) : (
            <p
              className={`cmae-onb-boot-done${localePrepDone ? " is-visible" : ""}`}
            >
              Language pack ready — continuing…
            </p>
          )}
        </div>
      </div>
    );
  }

  if (stepId === "boot") {
    return (
      <div className="cmae-onb">
        <div className="cmae-onb-brand">CMAE</div>
        <div className="cmae-onb-boot">
          <h1 className="cmae-onb-boot-title">
            {t("onboarding.bootTitle")}
          </h1>
          <p className="cmae-onb-boot-lead">{t("onboarding.bootLead")}</p>
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
              {bootFailMsg} {t("onboarding.bootFail")}
            </p>
          ) : (
            <p
              className={`cmae-onb-boot-done${bootDone ? " is-visible" : ""}`}
            >
              {t("onboarding.bootDone")}
            </p>
          )}
        </div>
      </div>
    );
  }

  const flowIndex = FLOW_STEPS.indexOf(stepId as (typeof FLOW_STEPS)[number]);
  const showProgress = flowIndex >= 0;

  return (
    <div className="cmae-onb">
      <div className="cmae-onb-brand">CMAE</div>
      <div className="cmae-onb-card">
        {showProgress ? (
          <>
            <div className="cmae-onb-progress" aria-hidden>
              {FLOW_STEPS.map((id, i) => (
                <span
                  key={id}
                  className={
                    i < flowIndex
                      ? "is-done"
                      : i === flowIndex
                        ? "is-active"
                        : undefined
                  }
                />
              ))}
            </div>
            <p className="cmae-onb-step-label">
              {t("onboarding.stepLabel", {
                current: flowIndex + 1,
                total: FLOW_STEPS.length,
              })}
            </p>
          </>
        ) : null}

        {stepId === "language" ? (
          <>
            <h1 className="cmae-onb-title">Choose your language</h1>
            <p className="cmae-onb-lead">
              This language is used for the app interface and for translated
              mail copies. Application emails are still written in the
              company&apos;s language.
            </p>
            <div className="cmae-onb-fields">
              <Field label="Your language">
                <select
                  className="cmae-input"
                  value={form.preferredLanguage}
                  onChange={(e) =>
                    setForm({ ...form, preferredLanguage: e.target.value })
                  }
                  autoFocus
                >
                  {PREFERRED_LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </>
        ) : null}

        {stepId === "welcome" ? (
          <>
            <h1 className="cmae-onb-title">{t("onboarding.welcomeTitle")}</h1>
            <p className="cmae-onb-lead">{t("onboarding.welcomeLead")}</p>
          </>
        ) : null}

        {stepId === "profile" ? (
          <>
            <h1 className="cmae-onb-title">{t("onboarding.profileTitle")}</h1>
            <p className="cmae-onb-why">{t("onboarding.profileWhy")}</p>
            <div className="cmae-onb-fields">
              <Field label={t("onboarding.fullName")}>
                <input
                  className="cmae-input"
                  value={form.fullName}
                  onChange={(e) =>
                    setForm({ ...form, fullName: e.target.value })
                  }
                  placeholder={t("onboarding.fullNamePlaceholder")}
                  autoFocus
                />
              </Field>
            </div>
          </>
        ) : null}

        {stepId === "gmail" ? (
          <>
            <h1 className="cmae-onb-title">Gmail connection</h1>
            <p className="cmae-onb-why">
              Tracker reads inbox/sent mail via IMAP and writes application and
              follow-up drafts to the Gmail Drafts folder. Not your normal
              password — an App Password is required.
            </p>
            <ol className="cmae-onb-guide">
              <li>
                <strong>2-Step Verification</strong> must be enabled on your
                Google account.
              </li>
              <li>
                Open the{" "}
                <a
                  href="https://myaccount.google.com/apppasswords"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  App passwords
                </a>{" "}
                page.
              </li>
              <li>
                Enter an app name such as <strong>CMAE</strong> →{" "}
                <strong>Create</strong>.
              </li>
              <li>
                Copy the generated <strong>16-digit password</strong> and paste
                it below.
              </li>
            </ol>
            <div className="cmae-onb-fields">
              <Field label="Gmail address">
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
                    ? "A password is already saved — paste a new one to replace it"
                    : "You can paste with spaces or without"
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
              Search agents (discovery, research, email writing) and Tracker
              follow-up / reply drafts run with this key.
            </p>
            <ol className="cmae-onb-guide">
              <li>
                Open{" "}
                <a
                  href="https://cursor.com/dashboard/api"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Cursor Dashboard → API Keys
                </a>
                .
              </li>
              <li>
                Create a new API key (any name, e.g.{" "}
                <strong>CMAE local</strong>).
              </li>
              <li>
                Copy the key and paste it below <strong>once</strong> — it will
                then be stored securely.
              </li>
            </ol>
            <div className="cmae-onb-fields">
              <Field
                label="Cursor API Key"
                hint={
                  hasCursorKey
                    ? "Saved in the database — paste a new one to replace it"
                    : cursorFromEnv
                      ? "CURSOR_API_KEY from .env will be used — you can leave this blank"
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
            <h1 className="cmae-onb-title">Your mail preferences</h1>
            <p className="cmae-onb-why">
              Follow-up timing and the signature appended exactly at the end of
              every email.
            </p>
            <div className="cmae-onb-fields">
              <Field
                label="Follow-up day"
                hint="How many days after no reply before a reminder email. Recommended: 4–7 days."
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
                label="Email signature"
                hint="Line breaks are preserved; AI cannot change this"
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
            <h1 className="cmae-onb-title">Your job preferences</h1>
            <p className="cmae-onb-why">
              Work type and notice period appear in application / follow-up
              text. Salary is only used in replies when the other side asks; it
              is never written into emails on its own.
            </p>
            <div className="cmae-onb-fields">
              <Field label="Work type" hint="Select at least one">
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
                label="Notice period (weeks)"
                hint="0 = immediately / ab sofort"
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
                <Field label="Period">
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
                    <option value="monthly">Monthly</option>
                    <option value="yearly">Yearly</option>
                  </select>
                </Field>
                <Field label="Gross / Net">
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
                    <option value="gross">Gross</option>
                    <option value="net">Net</option>
                  </select>
                </Field>
                <Field label="Currency">
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
                    <option value="usd">Dollar</option>
                    <option value="other">Other</option>
                  </select>
                </Field>
                {prefs.salaryCurrency === "other" ? (
                  <Field label="Other currency">
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
                <Field label="Min salary">
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
                Open to negotiation
              </label>
            </div>
          </>
        ) : null}

        {stepId === "cv" ? (
          <>
            <h1 className="cmae-onb-title">Upload your CV</h1>
            <p className="cmae-onb-why">
              Text is parsed so AI can write personalized emails; the PDF is
              attached automatically to application and follow-up Gmail drafts.
              At least one CV is required — you can edit languages/labels later
              in Settings.
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
                      aria-label="CV language"
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
                      Delete
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="cmae-onb-hint">No CV yet.</p>
            )}
            {cvs.length < 4 ? (
              <Field label="Upload PDF">
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
          {stepId !== "language" ? (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={goBack}
            >
              {t("common.back")}
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
                  ? "Start system"
                  : stepId === "welcome"
                    ? "Get started"
                    : stepId === "language"
                      ? "Continue"
                      : t("common.continue")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
