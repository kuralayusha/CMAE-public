"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useIntlLocale, useT } from "@/components/I18nProvider";
import { Button } from "@/components/ui";
import { refreshTrackerList } from "@/lib/tracker/client-store";
import "./merge-manager.css";

type MergeMail = {
  subject: string;
  from: string;
  direction: string | null;
  date: string;
};

type MergeSide = {
  id: number;
  company: string;
  primaryTo: string | null;
  userState: string;
  status: string;
  mails: MergeMail[];
  mailCount: number;
};

type Conflict = {
  field: string;
  winner: string | null;
  loser: string | null;
};

type Proposal = {
  id: string;
  origin: string;
  conflicts: Conflict[];
  winner: MergeSide;
  loser: MergeSide;
};

type Side = "winner" | "loser";

function formatDate(iso: string, locale: string): string {
  try {
    return new Date(iso).toLocaleDateString(locale, {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

export function MergeManager() {
  const t = useT();
  const locale = useIntlLocale();
  const router = useRouter();
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [initialTotal, setInitialTotal] = useState(0);
  const [decided, setDecided] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** proposalId → field → chosen side (unset until user picks). */
  const [picks, setPicks] = useState<Record<string, Record<string, Side>>>({});
  const redirected = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/tracker/merge-proposals", {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(t("tracker.error.mergeFailed"));
      const data = (await res.json()) as { proposals?: Proposal[] };
      const list = data.proposals || [];
      setProposals(list);
      setInitialTotal((prev) => Math.max(prev, list.length));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!loaded || proposals.length > 0 || redirected.current) return;
    redirected.current = true;
    const delay = decided > 0 ? 900 : 0;
    window.setTimeout(() => router.replace("/tracker"), delay);
  }, [loaded, proposals.length, decided, router]);

  async function respond(p: Proposal, decision: "accept" | "reject") {
    setBusyId(p.id);
    setError(null);
    const choices: Record<string, string | null> = {};
    if (decision === "accept") {
      for (const c of p.conflicts) {
        const side = picks[p.id]?.[c.field];
        choices[c.field] = side === "loser" ? c.loser : c.winner;
      }
    }
    try {
      const res = await fetch("/api/tracker/merge-proposals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: p.id, decision, choices }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || t("tracker.error.mergeFailed"));
      setDecided((n) => n + 1);
      await Promise.all([load(), refreshTrackerList({ force: true })]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await load();
    } finally {
      setBusyId(null);
    }
  }

  function whyLabel(origin: string): string {
    const key = `tracker.merge.why.${origin}`;
    const text = t(key);
    return text === key ? t("tracker.merge.why.other") : text;
  }

  function fieldLabel(field: string): string {
    return field === "user_state"
      ? t("tracker.merge.fieldUserState")
      : t("tracker.merge.fieldRecipient");
  }

  function renderSide(side: MergeSide, label: string) {
    const chipKey = `tracker.chip.${side.status}`;
    const chip = t(chipKey);
    const status = chip === chipKey ? side.status.replace(/_/g, " ") : chip;
    const extra = side.mailCount - side.mails.length;
    return (
      <div className="cmae-merge-side">
        <p className="cmae-merge-side-label">{label}</p>
        <h3 className="cmae-merge-company">{side.company}</h3>
        <dl className="cmae-merge-meta">
          <dt>{t("tracker.col.recipient")}</dt>
          <dd>{side.primaryTo || "—"}</dd>
          <dt>{t("tracker.col.status")}</dt>
          <dd>{status}</dd>
        </dl>
        <p className="cmae-merge-mails-title">
          {t("tracker.merge.mails", { count: side.mailCount })}
        </p>
        {side.mails.length ? (
          <ul className="cmae-merge-mails">
            {side.mails.map((m, i) => (
              <li key={`${m.date}-${i}`}>
                <span className="cmae-merge-mail-subject">
                  {m.subject || t("tracker.merge.noSubject")}
                </span>
                <span className="cmae-merge-mail-meta">
                  {m.direction === "out"
                    ? t("tracker.merge.dirOut")
                    : t("tracker.merge.dirIn")}
                  {" · "}
                  {m.from}
                  {" · "}
                  <span suppressHydrationWarning>
                    {formatDate(m.date, locale)}
                  </span>
                </span>
              </li>
            ))}
            {extra > 0 ? (
              <li className="cmae-merge-mail-more">
                {t("tracker.merge.moreMails", { count: extra })}
              </li>
            ) : null}
          </ul>
        ) : (
          <p className="cmae-merge-mail-more">{t("tracker.merge.noMails")}</p>
        )}
      </div>
    );
  }

  const done = Math.min(decided, initialTotal);

  return (
    <div className="cmae-merge">
      <Link href="/tracker" className="cmae-merge-back">
        ← {t("tracker.merge.back")}
      </Link>
      <p className="cmae-merge-intro">{t("tracker.merge.intro")}</p>

      {initialTotal > 0 ? (
        <p className="cmae-merge-progress" role="status">
          {t("tracker.merge.progress", { done, total: initialTotal })}
        </p>
      ) : null}

      {error ? <p className="cmae-tracker-banner is-error">{error}</p> : null}

      {!loaded ? (
        <p className="cmae-merge-intro">{t("tracker.loading")}</p>
      ) : proposals.length === 0 ? (
        <p className="cmae-tracker-banner" role="status">
          {t("tracker.merge.allDone")}
        </p>
      ) : (
        proposals.map((p) => {
          const missing = p.conflicts.some((c) => !picks[p.id]?.[c.field]);
          const busy = busyId === p.id;
          return (
            <section key={p.id} className="cmae-merge-card">
              <header className="cmae-merge-card-head">
                <h2>
                  {t("tracker.merge.pair", {
                    a: p.winner.company,
                    b: p.loser.company,
                  })}
                </h2>
                <span className="cmae-merge-why">{whyLabel(p.origin)}</span>
              </header>
              <div className="cmae-merge-cols">
                {renderSide(p.winner, t("tracker.merge.sideA"))}
                {renderSide(p.loser, t("tracker.merge.sideB"))}
              </div>
              {p.conflicts.length ? (
                <div className="cmae-merge-conflicts">
                  <p>{t("tracker.merge.conflictHint")}</p>
                  {p.conflicts.map((c) => (
                    <fieldset key={c.field} className="cmae-merge-conflict">
                      <legend>{fieldLabel(c.field)}</legend>
                      {(["winner", "loser"] as const).map((side) => (
                        <label key={side}>
                          <input
                            type="radio"
                            name={`${p.id}:${c.field}`}
                            checked={picks[p.id]?.[c.field] === side}
                            disabled={busy}
                            onChange={() =>
                              setPicks((prev) => ({
                                ...prev,
                                [p.id]: { ...(prev[p.id] || {}), [c.field]: side },
                              }))
                            }
                          />
                          <span>
                            {(side === "winner" ? c.winner : c.loser) || "—"}
                            {" ("}
                            {side === "winner"
                              ? t("tracker.merge.sideA")
                              : t("tracker.merge.sideB")}
                            {")"}
                          </span>
                        </label>
                      ))}
                    </fieldset>
                  ))}
                </div>
              ) : null}
              <div className="cmae-merge-actions">
                <Button
                  type="button"
                  disabled={busy || missing}
                  onClick={() => void respond(p, "accept")}
                >
                  {t("tracker.merge.accept")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void respond(p, "reject")}
                >
                  {t("tracker.merge.reject")}
                </Button>
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}
