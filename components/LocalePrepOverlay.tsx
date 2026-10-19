"use client";

import { useEffect, useRef, useState } from "react";
import { BrandMark } from "@/components/BrandMark";
import { useI18n } from "@/components/I18nProvider";
import { APP_LANGUAGE, type LocalePack } from "@/lib/i18n/types";
import "./onboarding.css";

type BootStatus = "pending" | "running" | "ok" | "fail";

type BootItem = {
  id: string;
  status: BootStatus;
  detail?: string;
};

const LOCALE_PREP_TEMPLATE: { id: string }[] = [
  { id: "selected" },
  { id: "connecting" },
  { id: "catalog" },
  { id: "nav" },
  { id: "mail" },
  { id: "polish" },
  { id: "assembling" },
  { id: "writing" },
  { id: "switching" },
];

const LOCALE_PREP_WORK_IDS = [
  "catalog",
  "nav",
  "mail",
  "polish",
  "assembling",
] as const;

const LOCALE_PREP_WORK_DWELL_MS = [4200, 7800, 10000, 12000] as const;

const LOCALE_PREP_WAIT_HINT_KEYS = [
  "onboarding.localePrepWait0",
  "onboarding.localePrepWait1",
  "onboarding.localePrepWait2",
] as const;

const LOCALE_PREP_MIN_MS = 5200;

function freshItems(): BootItem[] {
  return LOCALE_PREP_TEMPLATE.map((b) => ({
    id: b.id,
    status: "pending" as const,
  }));
}

function sleep(ms: number) {
  return new Promise<void>((r) => window.setTimeout(r, ms));
}

export type LocalePrepComplete = {
  code: string;
  pack: LocalePack;
  deferred?: boolean;
};

type Props = {
  targetLanguage: string;
  /** `overlay` locks the whole app (settings). `page` fills onboarding step. */
  mode?: "overlay" | "page";
  doneKey?: string;
  failKey?: string;
  /**
   * Onboarding: if Cursor key is missing, save preference and continue in EN.
   * Settings (default false): fail loudly — user is already onboarded.
   */
  allowDeferWithoutKey?: boolean;
  onComplete: (result: LocalePrepComplete) => void;
  onError: (message: string) => void;
};

export function LocalePrepOverlay({
  targetLanguage,
  mode = "overlay",
  doneKey = "onboarding.localePrepDone",
  failKey = "onboarding.localePrepFail",
  allowDeferWithoutKey = false,
  onComplete,
  onError,
}: Props) {
  const { t, setPack } = useI18n();
  const [items, setItems] = useState<BootItem[]>(freshItems);
  const [done, setDone] = useState(false);
  const [failMsg, setFailMsg] = useState<string | null>(null);
  const startedRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  const onErrorRef = useRef(onError);
  onCompleteRef.current = onComplete;
  onErrorRef.current = onError;

  function patch(id: string, patchItem: Partial<BootItem>) {
    setItems((prev) =>
      prev.map((b) => (b.id === id ? { ...b, ...patchItem } : b)),
    );
  }

  useEffect(() => {
    if (mode !== "overlay") return;

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const blockUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", blockUnload);

    const lockUrl = `${window.location.pathname}${window.location.search}`;
    window.history.pushState({ cmaeLocaleLock: 1 }, "", lockUrl);
    const blockPop = () => {
      window.history.pushState({ cmaeLocaleLock: 1 }, "", lockUrl);
    };
    window.addEventListener("popstate", blockPop);

    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("beforeunload", blockUnload);
      window.removeEventListener("popstate", blockPop);
    };
  }, [mode]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const lang = targetLanguage.trim() || APP_LANGUAGE;
    const started = Date.now();

    const translate = async (): Promise<LocalePrepComplete> => {
      const res = await fetch("/api/i18n/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetLanguage: lang }),
      });
      const data = await res.json();
      if (!res.ok) {
        const errMsg = String(
          data.error || t("onboarding.error.localeTranslateFailed"),
        );
        if (
          allowDeferWithoutKey &&
          /api key/i.test(errMsg) &&
          lang.toLowerCase().slice(0, 2) !== "en"
        ) {
          await fetch("/api/settings", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ preferredLanguage: lang }),
          });
          const packRes = await fetch("/api/i18n/pack");
          if (packRes.ok) {
            const packData = await packRes.json();
            const enPack = (packData.en || packData.pack) as LocalePack;
            setPack(APP_LANGUAGE, enPack);
            return { code: APP_LANGUAGE, pack: enPack, deferred: true };
          }
          return { code: APP_LANGUAGE, pack: {}, deferred: true };
        }
        throw new Error(errMsg);
      }
      const code = String(data.code || lang);
      const pack = data.pack as LocalePack;
      setPack(code, pack);
      return { code, pack, deferred: false };
    };

    async function paceWorkSteps(work: Promise<LocalePrepComplete>) {
      let settled = false;
      let failure: unknown = null;
      let value: LocalePrepComplete | null = null;
      const tracked = work.then(
        (v) => {
          settled = true;
          value = v;
          return v;
        },
        (err) => {
          settled = true;
          failure = err;
          throw err;
        },
      );

      for (let i = 0; i < LOCALE_PREP_WORK_IDS.length; i++) {
        const id = LOCALE_PREP_WORK_IDS[i]!;
        const isLast = i === LOCALE_PREP_WORK_IDS.length - 1;
        patch(id, { status: "running", detail: undefined });

        if (isLast) {
          let hintIdx = 0;
          while (!settled) {
            patch(id, {
              status: "running",
              detail:
                LOCALE_PREP_WAIT_HINT_KEYS[
                  hintIdx % LOCALE_PREP_WAIT_HINT_KEYS.length
                ],
            });
            hintIdx += 1;
            await Promise.race([
              sleep(5200),
              tracked.catch(() => undefined),
            ]);
          }
          if (failure) throw failure;
          await tracked;
          patch(id, { status: "ok", detail: undefined });
          return value!;
        }

        const dwell = LOCALE_PREP_WORK_DWELL_MS[i] ?? 8000;
        await Promise.race([
          sleep(dwell),
          tracked.catch(() => undefined),
        ]);

        if (failure) throw failure;

        if (settled) {
          patch(id, { status: "ok", detail: undefined });
          for (let j = i + 1; j < LOCALE_PREP_WORK_IDS.length; j++) {
            const nextId = LOCALE_PREP_WORK_IDS[j]!;
            patch(nextId, { status: "running" });
            await sleep(340);
            patch(nextId, { status: "ok" });
          }
          await tracked;
          return value!;
        }

        patch(id, { status: "ok", detail: undefined });
      }

      return tracked;
    }

    void (async () => {
      try {
        setItems(freshItems());
        setDone(false);
        setFailMsg(null);

        patch("selected", { status: "running" });
        await sleep(520);
        patch("selected", { status: "ok" });

        patch("connecting", { status: "running" });
        const translatePromise = translate();
        await sleep(900);
        patch("connecting", { status: "ok" });

        const result = await paceWorkSteps(translatePromise);

        patch("writing", { status: "running" });
        await sleep(480);
        patch("writing", { status: "ok" });

        patch("switching", { status: "running" });
        await sleep(520);
        patch("switching", { status: "ok" });

        const elapsed = Date.now() - started;
        if (elapsed < LOCALE_PREP_MIN_MS) {
          await sleep(LOCALE_PREP_MIN_MS - elapsed);
        }
        setDone(true);
        await sleep(700);
        onCompleteRef.current(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setFailMsg(msg);
        setItems((prev) =>
          prev.map((b) =>
            b.status === "running"
              ? { ...b, status: "fail" as const, detail: msg }
              : b,
          ),
        );
        await sleep(1600);
        onErrorRef.current(msg);
      }
    })();
  }, [targetLanguage, allowDeferWithoutKey, setPack]);

  const body = (
    <div className="cmae-onb-boot">
      <h1 className="cmae-onb-boot-title">{t("onboarding.localePrepTitle")}</h1>
      <p className="cmae-onb-boot-lead">{t("onboarding.localePrepLead")}</p>
      <ul className="cmae-onb-boot-list">
        {items.map((item) => (
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
              <span>{t(`onboarding.localePrepSteps.${item.id}`)}</span>
              {item.detail ? (
                <span className="cmae-onb-boot-detail">
                  {item.detail.startsWith("onboarding.")
                    ? t(item.detail)
                    : item.detail}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {failMsg ? (
        <p className="cmae-onb-boot-fail is-visible">
          {failMsg} {t(failKey)}
        </p>
      ) : (
        <p className={`cmae-onb-boot-done${done ? " is-visible" : ""}`}>
          {t(doneKey)}
        </p>
      )}
    </div>
  );

  if (mode === "page") {
    return (
      <div className="cmae-onb" role="status" aria-live="polite" aria-busy={!done && !failMsg}>
        <div className="cmae-onb-brand">
          <BrandMark size={28} className="cmae-onb-brand-mark" />
          CMAE
        </div>
        {body}
      </div>
    );
  }

  return (
    <div
      className="cmae-locale-prep-overlay"
      role="alertdialog"
      aria-modal="true"
      aria-live="polite"
      aria-busy={!done && !failMsg}
      aria-label={t("onboarding.localePrepTitle")}
    >
      <div className="cmae-locale-prep-overlay-inner">
        <div className="cmae-onb-brand">
          <BrandMark size={28} className="cmae-onb-brand-mark" />
          CMAE
        </div>
        {body}
      </div>
    </div>
  );
}
