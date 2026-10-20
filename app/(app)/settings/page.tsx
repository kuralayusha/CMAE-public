"use client";

import { useEffect, useState } from "react";
import { CvDropzone } from "@/components/CvDropzone";
import { useLocaleUpper, useT } from "@/components/I18nProvider";
import { LocalePrepOverlay } from "@/components/LocalePrepOverlay";
import {
  useOperations,
  type OperationsReason,
} from "@/components/OperationsProvider";
import { Button, Field, PageShell } from "@/components/ui";
import { PREFERRED_LANGUAGES } from "@/lib/settings/languages";
import { formatVersionLabel } from "@/lib/version/semver";

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
  family: string;
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

function SettingsAcc({
  title,
  children,
  danger,
}: {
  title: string;
  children: React.ReactNode;
  danger?: boolean;
}) {
  const upper = useLocaleUpper();
  return (
    <details
      className={`cmae-form-acc${danger ? " is-danger" : ""}`}
      name="cmae-settings"
    >
      <summary className="cmae-form-acc-sum">
        <span className="cmae-form-section-title">{upper(title)}</span>
      </summary>
      <div className="cmae-form-section">{children}</div>
    </details>
  );
}

function opsReasonLabel(
  t: (key: string) => string,
  reasons: OperationsReason[],
): string {
  if (reasons.length === 1) {
    const r = reasons[0]!;
    return t(`settings.opsReason.${r}`);
  }
  return t("settings.opsReason.multiple");
}

export default function SettingsPage() {
  const t = useT();
  const upper = useLocaleUpper();
  const ops = useOperations();
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
  const [meta, setMeta] = useState<Settings | null>(null);
  const [cvs, setCvs] = useState<CvItem[]>([]);
  const [cvMax, setCvMax] = useState(4);
  const [status, setStatus] = useState<string | null>(null);
  const [statusTone, setStatusTone] = useState<"ok" | "err" | null>(null);
  const [busy, setBusy] = useState(false);
  const [wipeOpen, setWipeOpen] = useState(false);
  const [uninstallOpen, setUninstallOpen] = useState(false);
  const [accountSwitchPreview, setAccountSwitchPreview] = useState<{
    oldAccountId: string;
    newAccountId: string;
    mailCount: number;
    itemCount: number;
    draftCount: number;
    researchOnlyKept: number;
  } | null>(null);
  const [isDesktop, setIsDesktop] = useState(false);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  /** When set, full-screen locale prep locks the UI until pack is ready. */
  const [localePrep, setLocalePrep] = useState<{
    next: string;
    prev: string;
  } | null>(null);
  const localeLocked = Boolean(localePrep);
  const opsLocked = ops.busy;
  const formLocked = localeLocked || opsLocked;

  useEffect(() => {
    setIsDesktop(Boolean(window.cmaeDesktop?.isDesktop));
    void (async () => {
      try {
        if (window.cmaeDesktop?.getVersion) {
          setAppVersion(await window.cmaeDesktop.getVersion());
          return;
        }
        const res = await fetch("/api/version?platform=web&arch=web", {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          current?: string;
          status?: { current?: string };
        };
        setAppVersion(data.current || data.status?.current || null);
      } catch {
        /* ignore */
      }
    })();
  }, []);

  async function loadCvs() {
    const res = await fetch("/api/settings/cv");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || t("settings.error.loadCvs"));
    setCvs(data.cvs || []);
    setCvMax(data.max || 4);
  }

  async function load() {
    const res = await fetch("/api/settings");
    const data: Settings = await res.json();
    setMeta(data);
    const lang = (data.preferredLanguage || "en").toLowerCase();
    setForm((f) => ({
      ...f,
      fullName: data.fullName || "",
      gmailAddress: data.gmailAddress || "",
      followUpDays: data.followUpDays || 5,
      preferredLanguage: data.preferredLanguage || "en",
      emailSignature: data.emailSignature || "",
    }));
    setPrefs({ ...DEFAULT_PREFS, ...(data.jobPreferences || {}) });
    await loadCvs().catch(() => undefined);

    // Shipped en.json changed → old user pack mixes EN+TR; refresh automatically
    if (lang && lang !== "en" && !lang.startsWith("en")) {
      try {
        const packRes = await fetch("/api/i18n/pack", { cache: "no-store" });
        const packData = packRes.ok ? await packRes.json() : null;
        if (packData?.needsTranslation) {
          setLocalePrep({ next: lang, prev: lang });
        }
      } catch {
        /* ignore */
      }
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function toggleWorkType(wt: WorkType) {
    setPrefs((p) => {
      const has = p.workTypes.includes(wt);
      return {
        ...p,
        workTypes: has
          ? p.workTypes.filter((x) => x !== wt)
          : [...p.workTypes, wt],
      };
    });
  }

  function flash(text: string | null, tone: "ok" | "err" | null = null) {
    setStatus(text);
    setStatusTone(text ? tone : null);
  }

  async function persistSettings(opts?: { confirmAccountSwitch?: boolean }) {
    if (formLocked) return;
    setBusy(true);
    flash(null);
    const prevLang = (meta?.preferredLanguage || "en").toLowerCase();
    const nextLang = form.preferredLanguage.trim().toLowerCase();
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          jobPreferences: prefs,
          confirmAccountSwitch: Boolean(opts?.confirmAccountSwitch),
        }),
      });
      const data = await res.json();
      if (
        res.status === 409 &&
        data.code === "ACCOUNT_SWITCH_REQUIRED" &&
        data.preview
      ) {
        setAccountSwitchPreview(data.preview);
        setBusy(false);
        return;
      }
      if (!res.ok) throw new Error(data.error || t("settings.error.saveFailed"));
      setAccountSwitchPreview(null);
      setMeta(data);
      if (data.jobPreferences) setPrefs({ ...DEFAULT_PREFS, ...data.jobPreferences });
      setForm((f) => ({ ...f, gmailAppPassword: "", cursorApiKey: "" }));

      if (nextLang && nextLang !== prevLang) {
        setBusy(false);
        setLocalePrep({ next: nextLang, prev: prevLang });
        return;
      }
      flash(t("settings.saved"), "ok");
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err), "err");
    } finally {
      setBusy(false);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    await persistSettings();
  }

  async function uploadCv(file: File) {
    if (formLocked) return;
    setBusy(true);
    flash(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("language", form.preferredLanguage || "en");
      const res = await fetch("/api/settings/cv", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t("settings.error.uploadCv"));
      setCvs(data.cvs || []);
      flash(
        t("settings.cvAdded", { name: data.entry?.label || file.name }),
        "ok",
      );
      await load();
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err), "err");
    } finally {
      setBusy(false);
    }
  }

  async function patchCv(
    id: string,
    patch: Partial<{
      label: string;
      language: string;
      family: string;
      tags: string[];
      isDefault: boolean;
    }>,
  ) {
    if (formLocked) return;
    setBusy(true);
    flash(null);
    try {
      const res = await fetch(`/api/settings/cv/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t("settings.error.updateCv"));
      setCvs(data.cvs || []);
      flash(t("settings.cvUpdated"), "ok");
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err), "err");
    } finally {
      setBusy(false);
    }
  }

  async function removeCv(id: string) {
    if (formLocked) return;
    if (!window.confirm(t("settings.cvConfirmDelete"))) return;
    setBusy(true);
    flash(null);
    try {
      const res = await fetch(`/api/settings/cv/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t("settings.error.deleteCv"));
      setCvs(data.cvs || []);
      flash(t("settings.cvDeleted"), "ok");
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err), "err");
    } finally {
      setBusy(false);
    }
  }

  async function confirmWipe() {
    if (formLocked) return;
    setBusy(true);
    flash(null);
    try {
      const res = await fetch("/api/onboarding/reset", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Delete failed");
      setWipeOpen(false);
      try {
        for (const k of Object.keys(localStorage)) {
          if (k.startsWith("cmae.help.seen.")) localStorage.removeItem(k);
        }
        sessionStorage.removeItem("cmae.onb.redirectGuard");
      } catch {
        /* ignore */
      }
      // Align Next workers onto the same data root after wipe
      try {
        await fetch("/api/onboarding/reconcile", { method: "POST" });
      } catch {
        /* ignore */
      }
      // Hard navigation — soft router can keep stale (app) layout / RSC cache
      window.location.assign(data.redirectTo || "/onboarding");
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err), "err");
      setBusy(false);
    }
  }

  async function confirmUninstall() {
    if (formLocked) return;
    if (!window.cmaeDesktop?.uninstallApp) {
      flash(t("settings.uninstallDesktopOnly"), "err");
      setUninstallOpen(false);
      return;
    }
    setBusy(true);
    flash(null);
    try {
      try {
        for (const k of Object.keys(localStorage)) {
          if (k.startsWith("cmae.help.seen.")) localStorage.removeItem(k);
        }
      } catch {
        /* ignore */
      }
      await window.cmaeDesktop.uninstallApp();
      // App exits; if it somehow stays open:
      flash(t("settings.uninstalling"));
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err), "err");
      setBusy(false);
    }
  }

  return (
    <>
      <PageShell
        title={t("help.settings.title")}
        subtitle={t("help.settings.subtitle")}
        helpPageId={formLocked ? undefined : "settings"}
      >
        {opsLocked && !localeLocked ? (
          <p className="cmae-form-hint" role="status">
            {t("settings.opsLocked", {
              reason: opsReasonLabel(t, ops.reasons),
            })}
          </p>
        ) : null}
        <form
          className="cmae-form"
          onSubmit={save}
          {...(formLocked ? { inert: true } : {})}
          aria-busy={formLocked || busy}
        >
          <SettingsAcc title={t("settings.accProfile")}>
            <Field
              label={t("fields.fullName")}
              hint={t("fields.fullNameHint")}
            >
              <input
                className="cmae-input"
                value={form.fullName}
                onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                placeholder={t("fields.fullNamePlaceholder")}
              />
            </Field>
            <Field
              label={t("settings.preferredLanguage")}
              hint={t("settings.preferredLanguageHint")}
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
          </SettingsAcc>

          <SettingsAcc title={t("settings.accGmail")}>
            <Field
              label={t("fields.gmailAddress")}
              hint={
                meta?.hasGmailAppPassword
                  ? t("fields.gmailPwSaved")
                  : t("fields.gmailPwMissing")
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
              label={t("fields.gmailAppPassword")}
              hint={t("fields.gmailAppPasswordKeep")}
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
            <p className="cmae-field-hint">{t("onboarding.gmailPrivacy")}</p>
          </SettingsAcc>

          <SettingsAcc title={t("settings.accCursor")}>
            <p className="cmae-field-hint">{t("onboarding.cursorPrivacy")}</p>
            <Field
              label={t("fields.cursorApiKeyShort")}
              hint={
                meta?.hasCursorApiKey
                  ? t("fields.cursorKeySavedKeep")
                  : meta?.cursorApiKeyFromEnv
                    ? t("fields.cursorKeyFromEnvKeep")
                    : t("fields.cursorKeyHint")
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
          </SettingsAcc>

          <SettingsAcc title={t("settings.accEmail")}>
            <Field
              label={t("fields.followUpDays")}
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
          </SettingsAcc>

          <SettingsAcc title={t("settings.accJob")}>
            <p className="cmae-form-hint">{t("settings.jobWhy")}</p>

            <Field label={t("fields.workType")} hint={t("fields.workTypeHintMulti")}>
              <div className="cmae-check-row">
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
              hint={t("fields.noticeHintSettings")}
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

            <h3 className="cmae-form-subsection">
              {upper(t("fields.salarySection"))}
            </h3>
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
                      salaryCurrency: e.target.value as "eur" | "usd" | "other",
                    })
                  }
                >
                  <option value="eur">{t("fields.euroEur")}</option>
                  <option value="usd">{t("fields.dollarUsd")}</option>
                  <option value="other">{t("fields.other")}</option>
                </select>
              </Field>
              {prefs.salaryCurrency === "other" ? (
                <Field label={t("fields.otherCurrency")} hint={t("fields.otherCurrencyHint")}>
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
              <Field label={t("fields.minSalary")} hint={t("fields.minSalaryHint")}>
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
              {t("fields.negotiable")}
            </label>
          </SettingsAcc>

          <SettingsAcc title={t("settings.accCv")}>
            <p className="cmae-form-hint">
              {t("settings.cvHint", { max: cvMax })}
            </p>

            {cvs.length ? (
              <ul className="cmae-cv-list">
                {cvs.map((cv) => (
                  <li key={cv.id} className="cmae-cv-item">
                    <div className="cmae-form-grid">
                      <Field label={t("fields.cvLabel")}>
                        <input
                          className="cmae-input"
                          defaultValue={cv.label}
                          disabled={busy || formLocked}
                          onBlur={(e) => {
                            const v = e.target.value.trim();
                            if (v && v !== cv.label) void patchCv(cv.id, { label: v });
                          }}
                        />
                      </Field>
                      <Field label={t("fields.cvLanguage")}>
                        <select
                          className="cmae-input"
                          value={cv.language}
                          disabled={busy || formLocked}
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
                      <Field
                        label={t("fields.cvFamily")}
                        hint={t("fields.cvFamilyHint")}
                      >
                        <input
                          className="cmae-input"
                          defaultValue={cv.family || ""}
                          disabled={busy || formLocked}
                          placeholder={t("fields.cvFamilyPlaceholder")}
                          onBlur={(e) => {
                            const family = e.target.value.trim();
                            if (family !== (cv.family || "")) {
                              void patchCv(cv.id, { family });
                            }
                          }}
                        />
                      </Field>
                      <Field label={t("fields.cvTags")} hint={t("fields.cvTagsHint")}>
                        <input
                          className="cmae-input"
                          defaultValue={cv.tags.join(", ")}
                          disabled={busy || formLocked}
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
                          disabled={busy || formLocked}
                          onChange={() => void patchCv(cv.id, { isDefault: true })}
                        />
                        {t("common.default")}
                      </label>
                      <span className="cmae-form-status">{cv.fileName}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={busy || formLocked}
                        onClick={() => void removeCv(cv.id)}
                      >
                        {t("common.delete")}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}

            {cvs.length < cvMax ? (
              <CvDropzone
                busy={busy || formLocked}
                onFile={(file) => void uploadCv(file)}
                onInvalid={(msg) => flash(msg, "err")}
              />
            ) : (
              <p className="cmae-form-hint">
                {t("settings.cvLimit", { max: cvMax })}
              </p>
            )}
          </SettingsAcc>

          <div className="cmae-form-actions">
            <Button type="submit" disabled={busy || formLocked}>
              {busy ? t("common.saving") : t("common.save")}
            </Button>
            {status ? (
              <span
                className={[
                  "cmae-form-status",
                  statusTone === "ok" ? "is-ok" : "",
                  statusTone === "err" ? "is-err" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                role={statusTone === "err" ? "alert" : "status"}
              >
                {status}
              </span>
            ) : null}
          </div>

          <SettingsAcc title={t("settings.accDanger")} danger>
            <p className="cmae-form-hint">{t("settings.dangerWipeHint")}</p>
            <Button
              type="button"
              variant="danger"
              disabled={busy || formLocked}
              onClick={() => setWipeOpen(true)}
            >
              {t("settings.dangerWipeBtn")}
            </Button>

            {isDesktop ? (
              <>
                <p className="cmae-form-hint" style={{ marginTop: "1.25rem" }}>
                  {t("settings.dangerUninstallHint")}
                </p>
                <Button
                  type="button"
                  variant="danger"
                  disabled={busy || formLocked}
                  onClick={() => setUninstallOpen(true)}
                >
                  {t("settings.dangerUninstallBtn")}
                </Button>
              </>
            ) : null}
          </SettingsAcc>

          {appVersion ? (
            <p className="cmae-settings-version">
              {t("settings.appVersion", {
                version: formatVersionLabel(appVersion),
              })}
            </p>
          ) : null}
        </form>
      </PageShell>

      {localePrep ? (
        <LocalePrepOverlay
          mode="overlay"
          targetLanguage={localePrep.next}
          doneKey="settings.localePrepDone"
          failKey="settings.localePrepFail"
          onComplete={() => {
            setLocalePrep(null);
            flash(t("settings.languageUpdated"), "ok");
            void load();
          }}
          onError={(message) => {
            const prev = localePrep.prev;
            setLocalePrep(null);
            flash(message || t("settings.languageFailed"), "err");
            setForm((f) => ({ ...f, preferredLanguage: prev }));
            void (async () => {
              try {
                await fetch("/api/settings", {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ preferredLanguage: prev }),
                });
              } catch {
                /* ignore */
              }
              await load();
            })();
          }}
        />
      ) : null}

      {accountSwitchPreview ? (
        <div
          className="term-modal-backdrop"
          role="presentation"
          onClick={() => !busy && setAccountSwitchPreview(null)}
        >
          <div
            className="term-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="account-switch-title"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="term-modal-head">
              <h3 id="account-switch-title">
                {t("settings.accountSwitchTitle")}
              </h3>
              <button
                type="button"
                className="term-modal-close"
                onClick={() => setAccountSwitchPreview(null)}
                disabled={busy}
                aria-label={t("common.close")}
              >
                ×
              </button>
            </header>
            <div className="term-modal-body">
              <p>
                {t("settings.accountSwitchBody", {
                  old: accountSwitchPreview.oldAccountId,
                  mails: accountSwitchPreview.mailCount,
                  items: accountSwitchPreview.itemCount,
                  drafts: accountSwitchPreview.draftCount,
                  kept: accountSwitchPreview.researchOnlyKept,
                })}
              </p>
            </div>
            <div className="term-modal-actions">
              <button
                type="button"
                className="term-modal-btn term-modal-btn-ghost"
                onClick={() => setAccountSwitchPreview(null)}
                disabled={busy}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="term-modal-btn term-modal-btn-danger"
                onClick={() =>
                  void persistSettings({ confirmAccountSwitch: true })
                }
                disabled={busy}
              >
                {busy
                  ? t("common.saving")
                  : t("settings.accountSwitchConfirm")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

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
            <header className="term-modal-head">
              <h3 id="wipe-title">{t("settings.wipeTitle")}</h3>
              <button
                type="button"
                className="term-modal-close"
                onClick={() => setWipeOpen(false)}
                disabled={busy}
                aria-label={t("common.close")}
              >
                ×
              </button>
            </header>
            <div className="term-modal-body">
              <p>{t("settings.wipeBody")}</p>
            </div>
            <div className="term-modal-actions">
              <button
                type="button"
                className="term-modal-btn term-modal-btn-ghost"
                onClick={() => setWipeOpen(false)}
                disabled={busy}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="term-modal-btn term-modal-btn-danger"
                onClick={() => void confirmWipe()}
                disabled={busy}
              >
                {busy ? t("common.deleting") : t("settings.wipeConfirm")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {uninstallOpen ? (
        <div
          className="term-modal-backdrop"
          role="presentation"
          onClick={() => !busy && setUninstallOpen(false)}
        >
          <div
            className="term-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="uninstall-title"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="term-modal-head">
              <h3 id="uninstall-title">{t("settings.uninstallTitle")}</h3>
              <button
                type="button"
                className="term-modal-close"
                onClick={() => setUninstallOpen(false)}
                disabled={busy}
                aria-label={t("common.close")}
              >
                ×
              </button>
            </header>
            <div className="term-modal-body">
              <p>{t("settings.uninstallBody")}</p>
            </div>
            <div className="term-modal-actions">
              <button
                type="button"
                className="term-modal-btn term-modal-btn-ghost"
                onClick={() => setUninstallOpen(false)}
                disabled={busy}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="term-modal-btn term-modal-btn-danger"
                onClick={() => void confirmUninstall()}
                disabled={busy}
              >
                {busy
                  ? t("settings.uninstallingBtn")
                  : t("settings.uninstallConfirm")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
