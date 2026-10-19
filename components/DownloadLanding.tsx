"use client";

import { useEffect, useState } from "react";
import type { VersionPolicy } from "@/lib/version/policy";
import { BrandMark } from "@/components/BrandMark";
import { LandingResearchDemo } from "@/components/landing/LandingResearchDemo";
import { LandingFoldersDemo } from "@/components/landing/LandingFoldersDemo";
import { LandingTrackerDemo } from "@/components/landing/LandingTrackerDemo";
import { LandingScenarioProvider } from "@/components/landing/LandingScenario";
import { LandingStage } from "@/components/landing/LandingStage";
import "@/app/download/download.css";

type Props = {
  initialPolicy: VersionPolicy;
};

const FAQ: { q: string; a: string }[] = [
  {
    q: "Does CMAE send emails for me?",
    a: "No. CMAE never sends mail. It writes into Gmail Drafts (with your CV attached when relevant). You open Gmail, review, and send yourself.",
  },
  {
    q: "Is CMAE free?",
    a: "The desktop app itself is free. You bring a Gmail App Password and a Cursor API key; you pay Cursor for API usage on your own account.",
  },
  {
    q: "What do I need to get started?",
    a: "Three things: a Gmail account with a Google App Password (2-Step Verification), a Cursor API key (powers Research and email drafting), and at least one CV as PDF. Keys stay encrypted on your machine; you can add more CVs (languages/labels) later in Settings.",
  },
  {
    q: "Where is my data stored? Is it private?",
    a: "Workspace data lives on your computer (SQLite + userData): company folders, CVs, Tracker state, and settings. Your Gmail App Password and Cursor API key are encrypted locally and are never uploaded to CMAE servers. Research and draft generation send content to your Cursor account via the API key. Separately, choosing a non-English UI language may use an optional remote step to build a language pack.",
  },
  {
    q: "Why Gmail only — and what is an App Password?",
    a: "CMAE syncs mail and saves drafts via Gmail IMAP with a Google App Password — not your normal Gmail password. Outlook and other providers are not supported yet. The App Password is encrypted and stored only on your computer.",
  },
  {
    q: "Which platforms are supported?",
    a: "macOS Apple Silicon (arm64) via .dmg, and Windows x64 via .exe. Intel Macs and Linux are not offered yet. There is no browser app — day-to-day use is the desktop client so credentials and research files stay local.",
  },
  {
    q: "Why does my OS warn when I install or open CMAE?",
    a: "On Mac, first launch after download: right-click CMAE → Open → confirm (Gatekeeper). On Windows, unsigned builds often hit SmartScreen — choose More info → Run anyway. Signed builds reduce these warnings.",
  },
  {
    q: "What is CMAE?",
    a: "CMAE (Cold Mail AI Engine) is a local-first desktop app for job outreach that never sends mail for you. You get Research, Folders, Tracker, and Settings in one place.",
  },
  {
    q: "Do I need to be online?",
    a: "Yes for Research (fetching pages + Cursor), Gmail sync, and updates. Browsing already-saved Folders and reviewing Tracker rows works offline once data is on disk.",
  },
  {
    q: "How do updates work?",
    a: "The app checks for a newer build and can prompt you to download it. Installing a newer .dmg or .exe keeps your userData. Do not use Settings → wipe if you only meant to upgrade.",
  },
  {
    q: "Can I change the interface language?",
    a: "Yes, in onboarding or Settings. UI language packs can be generated for your locale. Emails to companies still follow each company’s language; translated copies are for you.",
  },
  {
    q: "How do I wipe everything?",
    a: "Settings includes a full wipe of local settings, mail cache, tracker, CVs, company folders, and research history on this computer. It cannot be undone — you will set up CMAE again from scratch.",
  },
];

export function DownloadLanding({ initialPolicy }: Props) {
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

  return (
    <div className={`cmae-land${visible ? " is-ready" : ""}`}>
      <header className="cmae-land-hero">
        <div className="cmae-land-hero-copy">
          <p className="cmae-land-brand">
            <BrandMark size={48} className="cmae-land-brand-mark" />
            <span>CMAE</span>
          </p>
          <h1 className="cmae-land-title">Cold mail under your control.</h1>
          <div className="cmae-land-ctas">
            <a className="cmae-land-cta is-primary" href={macUrl}>
              Download for Mac
              <span>Apple Silicon · .dmg · v{initialPolicy.latest}</span>
            </a>
            <a className="cmae-land-cta" href={winUrl}>
              Download for Windows
              <span>x64 · .exe · v{initialPolicy.latest}</span>
            </a>
          </div>
          <p className="cmae-land-trust-line">
            Local desktop · Drafts only · You hit send
          </p>
        </div>
      </header>

      <div className="cmae-land-tour" aria-label="Interactive product tour">
        <p className="cmae-land-tour-label">Interactive tour</p>
        <LandingScenarioProvider>
          <LandingStage
            step="01"
            title="Research"
            lead="Paste careers URLs. Contacts and drafts, ready to review."
          >
            <LandingResearchDemo />
          </LandingStage>

          <LandingStage
            step="02"
            title="Folders"
            lead="Open a company. Brief and draft on disk."
          >
            <LandingFoldersDemo />
          </LandingStage>

          <LandingStage
            step="03"
            title="Tracker"
            lead="Sync Gmail. Ready when you are."
          >
            <LandingTrackerDemo />
          </LandingStage>
        </LandingScenarioProvider>
      </div>

      <section className="cmae-land-section" aria-labelledby="cmae-land-faq">
        <h2 id="cmae-land-faq" className="cmae-land-h2">
          FAQ
        </h2>
        <p className="cmae-land-section-lead">
          Cost, sending, privacy, and setup — decide before you download.
        </p>
        <div className="cmae-land-faq">
          {FAQ.map((item, i) => {
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
        <h2 className="cmae-land-h2">Get the desktop app</h2>
        <p className="cmae-land-section-lead">
          Mac .dmg · Windows .exe · Local install
        </p>
        <div className="cmae-land-ctas">
          <a className="cmae-land-cta is-primary" href={macUrl}>
            Mac · .dmg
          </a>
          <a className="cmae-land-cta" href={winUrl}>
            Windows · .exe
          </a>
        </div>
      </section>

      <footer className="cmae-land-foot">
        <span className="cmae-land-foot-brand">
          <BrandMark size={16} className="cmae-land-foot-mark" />
          CMAE
        </span>
        <span>v{initialPolicy.latest}</span>
      </footer>
    </div>
  );
}
