"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n, useLocaleUpper } from "@/components/I18nProvider";
import { LocalePrepOverlay } from "@/components/LocalePrepOverlay";
import { RichText } from "@/components/RichText";
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
  { id: "locale", label: "Language pack ready" },
  { id: "cv", label: "CV library ready" },
  { id: "unlock", label: "Unlocking Tracker / Search" },
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

/** Survives React Strict Mode remounts in the same JS realm. */
let wizardHydratedOnce = false;

function pickFilled(local: string, server: string | null | undefined): string {
  if (local.trim()) return local;
  return server?.trim() ? String(server) : local;
}

export function OnboardingWizard() {
  const router = useRouter();
  const { t, setPack } = useI18n();
  const upper = useLocaleUpper();
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
    preferredLanguage: "en",
    emailSignature: "",
  });
  const [prefs, setPrefs] = useState<JobPreferences>(DEFAULT_PREFS);
  const formRef = useRef(form);
  const prefsRef = useRef(prefs);
  formRef.current = form;
  prefsRef.current = prefs;

  const stepId: StepId = STEPS[step] ?? "language";

  useEffect(() => {
    void (async () => {
      try {
        await fetch("/api/onboarding/reconcile", {
          method: "POST",
          cache: "no-store",
        }).catch(() => null);
        const res = await fetch("/api/onboarding/status", { cache: "no-store" });
        const data = await res.json();
        // Same API path as Start system / RequireOnboarded — safe to enter app
        if (data.complete || data.flagSet) {
          window.location.replace("/tracker");
          return;
        }
        if (wizardHydratedOnce) return;
        wizardHydratedOnce = true;
        const s = data.settings || {};
        setForm((f) => ({
          ...f,
          fullName: pickFilled(f.fullName, s.fullName),
          gmailAddress: pickFilled(f.gmailAddress, s.gmailAddress),
          followUpDays: f.followUpDays || s.followUpDays || 5,
          preferredLanguage: pickFilled(
            f.preferredLanguage,
            s.preferredLanguage,
          ) || "en",
          emailSignature: pickFilled(f.emailSignature, s.emailSignature),
        }));
        if (s.jobPreferences) {
          setPrefs((p) => {
            const hasLocal = p.workTypes.length > 0 || p.salaryMin != null;
            if (hasLocal) return p;
            return { ...DEFAULT_PREFS, ...s.jobPreferences };
          });
        }
        setHasGmailPw(Boolean(s.hasGmailAppPassword));
        setHasCursorKey(Boolean(s.hasCursorApiKey));
        setCursorFromEnv(Boolean(s.cursorApiKeyFromEnv));
        if (Array.isArray(data.cvs) && data.cvs.length) {
          setCvs(data.cvs);
        }
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

  async function persistPartial(snapshot?: {
    form: typeof form;
    prefs: JobPreferences;
  }) {
    const f = snapshot?.form ?? formRef.current;
    const p = snapshot?.prefs ?? prefsRef.current;
    const body: Record<string, unknown> = {
      fullName: f.fullName,
      gmailAddress: f.gmailAddress,
      followUpDays: f.followUpDays,
      preferredLanguage: f.preferredLanguage,
      emailSignature: f.emailSignature,
      jobPreferences: p,
    };
    if (f.gmailAppPassword.trim()) {
      body.gmailAppPassword = f.gmailAppPassword;
    }
    if (f.cursorApiKey.trim()) {
      body.cursorApiKey = f.cursorApiKey;
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
    setForm((prev) => ({ ...prev, gmailAppPassword: "", cursorApiKey: "" }));
  }

  async function skipToWelcomeWithLang(code: string, pack: LocalePack) {
    setPack(code, pack);
    setForm((f) => ({ ...f, preferredLanguage: code }));
    try {
      await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preferredLanguage: code }),
      });
    } catch {
      /* preference save is best-effort before welcome */
    }
    setStep(STEPS.indexOf("welcome"));
  }

  async function goNext() {
    setError(null);
    if (stepId === "language") {
      const lang = form.preferredLanguage.trim() || APP_LANGUAGE;
      const code = lang.toLowerCase();

      // English (or already-translated pack) → skip localePrep animation
      if (code === APP_LANGUAGE || code.startsWith("en")) {
        setBusy(true);
        try {
          const packRes = await fetch("/api/i18n/pack");
          const packData = packRes.ok ? await packRes.json() : null;
          await skipToWelcomeWithLang(
            APP_LANGUAGE,
            (packData?.en || packData?.pack || {}) as LocalePack,
          );
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
        return;
      }

      setBusy(true);
      try {
        const packRes = await fetch("/api/i18n/pack");
        if (packRes.ok) {
          const packData = await packRes.json();
          const existing = String(packData.code || "").toLowerCase();
          const hasPack =
            existing === code &&
            packData.pack &&
            typeof packData.pack === "object" &&
            Object.keys(packData.pack as object).length > 0;
          // Reuse only a fresh pack — stale en.json fingerprint ⇒ retranslate
          if (hasPack && !packData.needsTranslation) {
            await skipToWelcomeWithLang(existing, packData.pack as LocalePack);
            return;
          }
        }
      } catch {
        /* fall through to localePrep */
      } finally {
        setBusy(false);
      }

      setStep(STEPS.indexOf("localePrep"));
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
      // Cursor step: env key alone used to look "ready" then vanish after restart
      if (stepId === "cursor" && !hasCursorKey && cursorFromEnv) {
        const check = await fetch("/api/onboarding/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ check: "cursor" }),
        });
        const checkData = await check.json().catch(() => ({}));
        if (!check.ok || !checkData.ok) {
          throw new Error(
            checkData.cursor?.error ||
              checkData.error ||
              t("fields.cursorKeyRequired"),
          );
        }
        setHasCursorKey(true);
      }
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

  function sleep(ms: number) {
    return new Promise<void>((r) => window.setTimeout(r, ms));
  }

  /**
   * After Cursor is verified, only (re)build the locale pack if missing.
   * Always paint a running tick first — a silent multi-minute translate
   * after "cursor ok" looked like a freeze on the CV step.
   */
  async function ensureBootLocalePack(
    softOk: (id: string) => Promise<void>,
  ) {
    const pref = (form.preferredLanguage.trim() || "en").toLowerCase();
    if (pref === "en" || pref.startsWith("en")) {
      await softOk("locale");
      return;
    }

    try {
      const packRes = await fetch("/api/i18n/pack");
      if (packRes.ok) {
        const packData = await packRes.json();
        const code = String(packData.code || "").toLowerCase();
        const hasPack =
          code === pref &&
          packData.pack &&
          typeof packData.pack === "object" &&
          Object.keys(packData.pack as object).length > 0;
        if (hasPack && !packData.needsTranslation) {
          setPack(code, packData.pack as LocalePack);
          await softOk("locale");
          return;
        }
      }
    } catch {
      /* fall through to translate */
    }

    patchBoot("locale", {
      status: "running",
      detail: t("onboarding.bootLocalePreparing"),
    });
    // Let React paint the … tick before the long request blocks
    await sleep(120);

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
      /* keep English UI — boot can still continue */
    }

    patchBoot("locale", { status: "ok", detail: undefined });
  }

  async function runBootSequence() {
    setBootItems(freshBootItems());
    setBootDone(false);
    setBootFailMsg(null);

    // Snapshot before any await — persistPartial clears secrets from state
    const snapshot = {
      form: { ...formRef.current },
      prefs: { ...prefsRef.current },
    };

    const softOk = async (id: string) => {
      patchBoot(id, { status: "running" });
      await sleep(420);
      patchBoot(id, { status: "ok" });
    };

    try {
      await softOk("db");
      await softOk("profile");

      patchBoot("gmail", { status: "running" });

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
          detail: msg,
        });
        setBootFailMsg(msg);
        await sleep(1600);
        setError(msg);
        setStep(STEPS.indexOf("gmail"));
        return;
      }

      patchBoot("gmail", { status: "ok" });

      patchBoot("cursor", { status: "running" });

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
          detail: msg,
        });
        setBootFailMsg(msg);
        await sleep(1600);
        setError(msg);
        setStep(STEPS.indexOf("cursor"));
        return;
      }

      patchBoot("cursor", { status: "ok" });

      // Language pack: skip if already built in localePrep; otherwise show
      // a running step (silent await here looked like a freeze).
      await ensureBootLocalePack(softOk);

      await softOk("cv");

      patchBoot("unlock", { status: "running" });

      // Re-save full wizard state — empty {} after wipe left gaps / empty settings
      await persistPartial(snapshot);

      const completeRes = await fetch("/api/onboarding/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: snapshot.form.fullName,
          gmailAddress: snapshot.form.gmailAddress,
          followUpDays: snapshot.form.followUpDays,
          preferredLanguage: snapshot.form.preferredLanguage,
          emailSignature: snapshot.form.emailSignature,
          jobPreferences: snapshot.prefs,
          ...(snapshot.form.gmailAppPassword.trim()
            ? { gmailAppPassword: snapshot.form.gmailAppPassword }
            : {}),
          ...(snapshot.form.cursorApiKey.trim()
            ? { cursorApiKey: snapshot.form.cursorApiKey }
            : {}),
        }),
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
      if (!completeData.complete && !completeData.onboardingCompletedAt) {
        throw new Error("Onboarding flag was not saved — try Start system again");
      }

      // Reopen SQLite on the sticky app-root so RSC layout sees the same flag
      const reconcileRes = await fetch("/api/onboarding/reconcile", {
        method: "POST",
        cache: "no-store",
      });
      const reconcileData = await reconcileRes.json().catch(() => ({}));
      if (
        !reconcileRes.ok ||
        (!reconcileData.complete && !reconcileData.flagSet)
      ) {
        throw new Error(
          reconcileData.error ||
            "Onboarding finished but the unlock flag could not be confirmed — try Start system again",
        );
      }

      patchBoot("unlock", { status: "ok" });
      setBootDone(true);
      await sleep(800);
      wizardHydratedOnce = false;
      // Tracker uses RequireOnboarded (same status API) — no RSC DB gate bounce
      window.location.replace("/tracker");

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
      <LocalePrepOverlay
        mode="page"
        targetLanguage={form.preferredLanguage}
        allowDeferWithoutKey
        onComplete={(result) => {
          setForm((f) => ({
            ...f,
            preferredLanguage: result.deferred
              ? f.preferredLanguage
              : result.code,
          }));
          setStep(STEPS.indexOf("welcome"));
        }}
        onError={(msg) => {
          setError(msg);
          setStep(STEPS.indexOf("language"));
        }}
      />
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
                  <span>{t(`onboarding.bootSteps.${item.id}`)}</span>
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
              {upper(
                t("onboarding.stepLabel", {
                  current: flowIndex + 1,
                  total: FLOW_STEPS.length,
                }),
              )}
            </p>
          </>
        ) : null}

        {stepId === "language" ? (
          <>
            <h1 className="cmae-onb-title">{t("onboarding.languageTitle")}</h1>
            <p className="cmae-onb-lead">{t("onboarding.languageLead")}</p>
            <div className="cmae-onb-fields">
              <Field label={t("onboarding.languageLabel")}>
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
              <Field label={t("fields.fullName")}>
                <input
                  className="cmae-input"
                  value={form.fullName}
                  onChange={(e) =>
                    setForm({ ...form, fullName: e.target.value })
                  }
                  placeholder={t("fields.fullNamePlaceholder")}
                  autoFocus
                />
              </Field>
            </div>
          </>
        ) : null}

        {stepId === "gmail" ? (
          <>
            <h1 className="cmae-onb-title">{t("onboarding.gmailTitle")}</h1>
            <p className="cmae-onb-why cmae-onb-privacy">
              {t("onboarding.gmailWhy")}
            </p>
            <ol className="cmae-onb-guide">
              <li>{t("onboarding.gmailGuide0")}</li>
              <li>
                <RichText
                  text={t("onboarding.gmailGuide1")}
                  parts={{
                    link: (
                      <a
                        href="https://myaccount.google.com/apppasswords"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {t("onboarding.gmailGuide1Link")}
                      </a>
                    ),
                  }}
                />
              </li>
              <li>
                <RichText
                  text={t("onboarding.gmailGuide2")}
                  parts={{
                    app: <strong>CMAE</strong>,
                  }}
                />
              </li>
              <li>{t("onboarding.gmailGuide3")}</li>
            </ol>
            <div className="cmae-onb-fields">
              <Field label={t("fields.gmailAddress")}>
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
                label={t("fields.gmailAppPassword")}
                hint={
                  hasGmailPw
                    ? t("fields.gmailAppPasswordReplace")
                    : t("fields.gmailAppPasswordPaste")
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
            <h1 className="cmae-onb-title">{t("onboarding.cursorTitle")}</h1>
            <p className="cmae-onb-why cmae-onb-privacy">
              {t("onboarding.cursorWhy")}
            </p>
            <ol className="cmae-onb-guide">
              <li>
                <RichText
                  text={t("onboarding.cursorGuide0")}
                  parts={{
                    link: (
                      <a
                        href="https://cursor.com/dashboard/api"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {t("onboarding.cursorGuide0Link")}
                      </a>
                    ),
                  }}
                />
              </li>
              <li>
                <RichText
                  text={t("onboarding.cursorGuide1")}
                  parts={{
                    name: <strong>CMAE local</strong>,
                  }}
                />
              </li>
              <li>{t("onboarding.cursorGuide2")}</li>
            </ol>
            <div className="cmae-onb-fields">
              <Field
                label={t("fields.cursorApiKey")}
                hint={
                  hasCursorKey
                    ? t("fields.cursorKeySaved")
                    : cursorFromEnv
                      ? t("fields.cursorKeyFromEnv")
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
            <h1 className="cmae-onb-title">{t("onboarding.prefsTitle")}</h1>
            <p className="cmae-onb-why">{t("onboarding.prefsWhy")}</p>
            <div className="cmae-onb-fields">
              <Field
                label={t("fields.followUpDay")}
                hint={t("fields.followUpHint")}
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
                label={t("fields.emailSignature")}
                hint={t("fields.emailSignatureHint")}
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
            <h1 className="cmae-onb-title">{t("onboarding.jobTitle")}</h1>
            <p className="cmae-onb-why">{t("onboarding.jobWhy")}</p>
            <div className="cmae-onb-fields">
              <Field
                label={t("fields.workType")}
                hint={t("fields.workTypeHintOne")}
              >
                <div className="cmae-onb-check-row">
                  {(
                    [
                      ["fulltime", "fields.workFulltime"],
                      ["parttime", "fields.workParttime"],
                      ["contracted", "fields.workContracted"],
                    ] as const
                  ).map(([id, labelKey]) => (
                    <label key={id} className="cmae-check">
                      <input
                        type="checkbox"
                        checked={prefs.workTypes.includes(id)}
                        onChange={() => toggleWorkType(id)}
                      />
                      {t(labelKey)}
                    </label>
                  ))}
                </div>
              </Field>
              <Field
                label={t("fields.noticeWeeks")}
                hint={t("fields.noticeHintOnb")}
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
                <Field label={t("fields.period")}>
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
                    <option value="monthly">{t("fields.monthly")}</option>
                    <option value="yearly">{t("fields.yearly")}</option>
                  </select>
                </Field>
                <Field label={t("fields.grossNet")}>
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
                    <option value="gross">{t("fields.gross")}</option>
                    <option value="net">{t("fields.net")}</option>
                  </select>
                </Field>
                <Field label={t("fields.currency")}>
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
                    <option value="eur">{t("fields.euro")}</option>
                    <option value="usd">{t("fields.dollar")}</option>
                    <option value="other">{t("fields.other")}</option>
                  </select>
                </Field>
                {prefs.salaryCurrency === "other" ? (
                  <Field label={t("fields.otherCurrency")}>
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
                <Field label={t("fields.minSalary")}>
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
                {t("fields.negotiable")}
              </label>
            </div>
          </>
        ) : null}

        {stepId === "cv" ? (
          <>
            <h1 className="cmae-onb-title">{t("onboarding.cvTitle")}</h1>
            <p className="cmae-onb-why">{t("onboarding.cvWhy")}</p>
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
                      aria-label={t("fields.cvLanguageAria")}
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
                      {t("common.delete")}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="cmae-onb-hint">{t("onboarding.cvEmpty")}</p>
            )}
            {cvs.length < 4 ? (
              <Field label={t("fields.uploadPdf")}>
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
                  ? t("onboarding.startSystem")
                  : stepId === "welcome"
                    ? t("onboarding.getStarted")
                    : t("common.continue")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
