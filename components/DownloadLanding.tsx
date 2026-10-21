"use client";

import { useEffect, useMemo, useState } from "react";
import type { VersionPolicy } from "@/lib/version/policy";
import { BrandMark } from "@/components/BrandMark";
import { useT } from "@/components/I18nProvider";
import { LandingResearchDemo } from "@/components/landing/LandingResearchDemo";
import { LandingFoldersDemo } from "@/components/landing/LandingFoldersDemo";
import { LandingTrackerDemo } from "@/components/landing/LandingTrackerDemo";
import { LandingScenarioProvider } from "@/components/landing/LandingScenario";
import { LandingStage } from "@/components/landing/LandingStage";
import "@/app/download/download.css";

type Props = {
  initialPolicy: VersionPolicy;
};

const FAQ_KEYS = [
  "send",
  "free",
  "need",
  "privacy",
  "gmail",
  "platforms",
  "osWarn",
  "what",
  "online",
  "updates",
  "lang",
  "wipe",
] as const;

export function DownloadLanding({ initialPolicy }: Props) {
  const t = useT();
  const [openFaq, setOpenFaq] = useState<number | null>(0);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const id = window.requestAnimationFrame(() => setVisible(true));
    return () => window.cancelAnimationFrame(id);
  }, []);

  const macUrl =
    initialPolicy.downloads["darwin-arm64"] || initialPolicy.releaseUrl;
  const winUrl =
    initialPolicy.downloads["win32-x64"] || initialPolicy.releaseUrl;

  const faq = useMemo(
    () =>
      FAQ_KEYS.map((k) => ({
        q: t(`landing.faq.${k}Q`),
        a: t(`landing.faq.${k}A`),
      })),
    [t],
  );

  return (
    <div className={`cmae-land${visible ? " is-ready" : ""}`}>
      <header className="cmae-land-hero">
        <div className="cmae-land-hero-copy">
          <p className="cmae-land-brand">
            <BrandMark size={48} className="cmae-land-brand-mark" />
            <span>{t("landing.brand")}</span>
          </p>
          <h1 className="cmae-land-title">{t("landing.heroTitle")}</h1>
          <div className="cmae-land-ctas">
            <a className="cmae-land-cta is-primary" href={macUrl}>
              {t("landing.downloadMac")}
              <span>
                {t("landing.downloadMacMeta", { version: initialPolicy.latest })}
              </span>
            </a>
            <a className="cmae-land-cta" href={winUrl}>
              {t("landing.downloadWin")}
              <span>
                {t("landing.downloadWinMeta", { version: initialPolicy.latest })}
              </span>
            </a>
          </div>
          <p className="cmae-land-trust-line">{t("landing.trustLine")}</p>
        </div>
      </header>

      <div className="cmae-land-tour" aria-label={t("landing.tourAria")}>
        <p className="cmae-land-tour-label">{t("landing.tourLabel")}</p>
        <LandingScenarioProvider>
          <LandingStage
            step="01"
            title={t("landing.stageResearchTitle")}
            lead={t("landing.stageResearchLead")}
          >
            <LandingResearchDemo />
          </LandingStage>

          <LandingStage
            step="02"
            title={t("landing.stageFoldersTitle")}
            lead={t("landing.stageFoldersLead")}
          >
            <LandingFoldersDemo />
          </LandingStage>

          <LandingStage
            step="03"
            title={t("landing.stageTrackerTitle")}
            lead={t("landing.stageTrackerLead")}
          >
            <LandingTrackerDemo />
          </LandingStage>
        </LandingScenarioProvider>
      </div>

      <section className="cmae-land-section" aria-labelledby="cmae-land-faq">
        <h2 id="cmae-land-faq" className="cmae-land-h2">
          {t("landing.faqTitle")}
        </h2>
        <p className="cmae-land-section-lead">{t("landing.faqLead")}</p>
        <div className="cmae-land-faq">
          {faq.map((item, i) => {
            const open = openFaq === i;
            return (
              <div
                key={item.q}
                className={`cmae-land-faq-item${open ? " is-open" : ""}`}
              >
                <button
                  type="button"
                  className="cmae-land-faq-q"
                  aria-expanded={open}
                  onClick={() => setOpenFaq(open ? null : i)}
                >
                  {item.q}
                  <span className="cmae-land-faq-icon" aria-hidden="true">
                    {open ? "−" : "+"}
                  </span>
                </button>
                {open ? <p className="cmae-land-faq-a">{item.a}</p> : null}
              </div>
            );
          })}
        </div>
      </section>

      <section className="cmae-land-section cmae-land-footer-cta">
        <h2 className="cmae-land-h2">{t("landing.footerCtaTitle")}</h2>
        <p className="cmae-land-section-lead">{t("landing.footerCtaLead")}</p>
        <div className="cmae-land-ctas">
          <a className="cmae-land-cta is-primary" href={macUrl}>
            {t("landing.footerMac")}
          </a>
          <a className="cmae-land-cta" href={winUrl}>
            {t("landing.footerWin")}
          </a>
        </div>
      </section>

      <footer className="cmae-land-foot">
        <span className="cmae-land-foot-brand">
          <BrandMark size={16} className="cmae-land-foot-mark" />
          {t("landing.brand")}
        </span>
        <span>v{initialPolicy.latest}</span>
      </footer>
    </div>
  );
}
