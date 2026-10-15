"use client";

import { useEffect, useState } from "react";
import { useI18n, useT } from "@/components/I18nProvider";
import { PageHelpModal, usePageHelp } from "@/components/PageHelp";
import { TopNav } from "@/components/TopNav";
import { Button, Field, PageShell } from "@/components/ui";
import type { LocalePack } from "@/lib/i18n/types";
import { PREFERRED_LANGUAGES } from "@/lib/settings/languages";

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

function SettingsAcc({
  title,
  children,
  danger,
}: {
  title: string;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <details
      className={`cmae-form-acc${danger ? " is-danger" : ""}`}
      name="cmae-settings"
    >
      <summary className="cmae-form-acc-sum">
        <span className="cmae-form-section-title">{title}</span>
      </summary>
      <div className="cmae-form-section">{children}</div>
    </details>
  );
}

export default function SettingsPage() {
  const t = useT();
  const { setPack } = useI18n();
  const help = usePageHelp("settings");
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
  const [busy, setBusy] = useState(false);
  const [wipeOpen, setWipeOpen] = useState(false);
  const [uninstallOpen, setUninstallOpen] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    setIsDesktop(Boolean(window.cmaeDesktop?.isDesktop));
  }, []);

  async function loadCvs() {
    const res = await fetch("/api/settings/cv");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not load CV list");
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
      preferredLanguage: data.preferredLanguage || "en",
      emailSignature: data.emailSignature || "",
    }));
    setPrefs({ ...DEFAULT_PREFS, ...(data.jobPreferences || {}) });
    await loadCvs().catch(() => undefined);
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

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    const prevLang = (meta?.preferredLanguage || "en").toLowerCase();
    const nextLang = form.preferredLanguage.trim().toLowerCase();
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, jobPreferences: prefs }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed");
      setMeta(data);
      if (data.jobPreferences) setPrefs({ ...DEFAULT_PREFS, ...data.jobPreferences });
      setForm((f) => ({ ...f, gmailAppPassword: "", cursorApiKey: "" }));

      if (nextLang && nextLang !== prevLang) {
        setStatus(t("settings.languageUpdating"));
        const tr = await fetch("/api/i18n/translate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetLanguage: nextLang }),
        });
        const trData = await tr.json();
        if (!tr.ok) {
          throw new Error(trData.error || t("settings.languageFailed"));
        }
        setPack(String(trData.code || nextLang), trData.pack as LocalePack);
        setStatus(t("settings.languageUpdated"));
      } else {
        setStatus("Saved");
      }
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
      if (!res.ok) throw new Error(data.error || "Could not upload CV");
      setCvs(data.cvs || []);
      setStatus(`CV added: ${data.entry?.label || file.name}`);
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
      if (!res.ok) throw new Error(data.error || "Could not update CV");
      setCvs(data.cvs || []);
      setStatus("CV updated");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeCv(id: string) {
    if (!window.confirm("Delete this CV?")) return;
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/settings/cv/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not delete CV");
      setCvs(data.cvs || []);
      setStatus("CV deleted");
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
      if (!res.ok) throw new Error(data.error || "Delete failed");
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

  async function confirmUninstall() {
    if (!window.cmaeDesktop?.uninstallApp) {
      setStatus("Uninstall is only available in the desktop app");
      setUninstallOpen(false);
      return;
    }
    setBusy(true);
    setStatus(null);
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
      setStatus("Uninstalling… the app will close shortly.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <>
      <TopNav active="settings" onHelp={help.reopen} />
      <PageShell
        title={t("help.settings.title")}
        subtitle={t("help.settings.subtitle")}
      >
        <form className="cmae-form" onSubmit={save}>
          <SettingsAcc title="Profile">
            <Field
              label="Full name"
              hint="Used in the email body and attachment filename."
            >
              <input
                className="cmae-input"
                value={form.fullName}
                onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                placeholder="Your Full Name"
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

          <SettingsAcc title="Gmail">
            <Field
              label="Gmail address"
              hint={
                meta?.hasGmailAppPassword
                  ? "App Password saved ✓"
                  : "No App Password yet"
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
              hint="Leave blank to keep the current password."
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
          </SettingsAcc>

          <SettingsAcc title="Cursor API Key">
            <Field
              label="API Key"
              hint={
                meta?.hasCursorApiKey
                  ? "Saved in the database ✓ — leave blank to keep it"
                  : meta?.cursorApiKeyFromEnv
                    ? "CURSOR_API_KEY is set in .env — you can leave this blank"
                    : "Get it from cursor.com/dashboard/api"
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

          <SettingsAcc title="Email preferences">
            <Field
              label="Follow-up days"
              hint="How many days to wait before sending a reminder if there's no reply. Recommended: 4–7 days."
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
              hint="Line breaks are preserved; AI cannot change this."
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

          <SettingsAcc title="Job preferences">
            <p className="cmae-form-hint">
              Work type and notice period appear in application / follow-up
              texts. Salary is only used in replies when the other party asks.
            </p>

            <Field label="Work type" hint="Multiple selections allowed">
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
              label="Notice period (weeks)"
              hint="0 = available immediately / can start right away"
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

            <h3 className="cmae-form-subsection">Salary expectations</h3>
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
                      salaryCurrency: e.target.value as "eur" | "usd" | "other",
                    })
                  }
                >
                  <option value="eur">Euro (EUR)</option>
                  <option value="usd">Dollar (USD)</option>
                  <option value="other">Other</option>
                </select>
              </Field>
              {prefs.salaryCurrency === "other" ? (
                <Field label="Other currency" hint="e.g. TL, TRY, CHF">
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
              <Field label="Min salary" hint="Your expected floor">
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
              Open to negotiation
            </label>
          </SettingsAcc>

          <SettingsAcc title="CV">
            <p className="cmae-form-hint">
              Up to {cvMax} PDFs. Attached automatically to application /
              follow-up drafts based on language and tags.
            </p>

            {cvs.length ? (
              <ul className="cmae-cv-list">
                {cvs.map((cv) => (
                  <li key={cv.id} className="cmae-cv-item">
                    <div className="cmae-form-grid">
                      <Field label="Label">
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
                      <Field label="Language">
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
                      <Field label="Tags (comma-separated)" hint="e.g. marketing, frontend">
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
                        Default
                      </label>
                      <span className="cmae-form-status">{cv.fileName}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void removeCv(cv.id)}
                      >
                        Delete
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="cmae-form-hint">No CVs yet.</p>
            )}

            {cvs.length < cvMax ? (
              <Field label="Upload PDF">
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
                Limit reached ({cvMax}). Delete one to add another.
              </p>
            )}
          </SettingsAcc>

          <div className="cmae-form-actions">
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
            {status ? <span className="cmae-form-status">{status}</span> : null}
          </div>

          <SettingsAcc title="Danger zone" danger>
            <p className="cmae-form-hint">
              Deletes the database, workspace company folders, CVs, and search
              history. The app returns to onboarding as if freshly installed.
            </p>
            <Button
              type="button"
              variant="danger"
              disabled={busy}
              onClick={() => setWipeOpen(true)}
            >
              Delete All Data
            </Button>

            {isDesktop ? (
              <>
                <p className="cmae-form-hint" style={{ marginTop: "1.25rem" }}>
                  Removes CMAE from this Mac: all local data under Application
                  Support and the installed app. Your{" "}
                  <code>.dmg</code> installer file is not deleted — you can
                  reinstall from it later.
                </p>
                <Button
                  type="button"
                  variant="danger"
                  disabled={busy}
                  onClick={() => setUninstallOpen(true)}
                >
                  Uninstall CMAE
                </Button>
              </>
            ) : null}
          </SettingsAcc>
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
            <h3 id="wipe-title">Delete all data?</h3>
            <p>
              Settings, emails, tracker, CVs, workspace folders, and search
              history will be permanently deleted. This cannot be undone.
            </p>
            <div className="term-modal-actions">
              <button
                type="button"
                className="term-modal-btn term-modal-btn-ghost"
                onClick={() => setWipeOpen(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="term-modal-btn term-modal-btn-danger"
                onClick={() => void confirmWipe()}
                disabled={busy}
              >
                {busy ? "Deleting…" : "Yes, delete everything"}
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
            <h3 id="uninstall-title">Uninstall CMAE?</h3>
            <p>
              This removes the app and all of its data on this Mac (database,
              workspace, settings, CVs). The{" "}
              <code>.dmg</code> file itself is left alone so you can install
              again later. The app will quit immediately.
            </p>
            <div className="term-modal-actions">
              <button
                type="button"
                className="term-modal-btn term-modal-btn-ghost"
                onClick={() => setUninstallOpen(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="term-modal-btn term-modal-btn-danger"
                onClick={() => void confirmUninstall()}
                disabled={busy}
              >
                {busy ? "Uninstalling…" : "Yes, uninstall"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
