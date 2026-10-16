"use client";

import { useEffect, useState } from "react";
import type { VersionPolicy } from "@/lib/version/policy";
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
    q: "What is CMAE?",
    a: "CMAE (Cold Mail AI Engine) is a local desktop app for job outreach: research company sites, find contacts, draft personalized emails, sync Gmail threads into a Tracker, and keep follow-ups organized — without sending mail for you.",
  },
  {
    q: "What can I do in the app?",
    a: "Research pastes careers URLs and runs parallel agents (scout → job fit → contact → research → writer → review). Folders browses the company workspace files. Tracker lists applications by status (Ready to send, Reply needed, Follow-up due, and more) and creates Gmail drafts for apply / follow-up / reply / thanks.",
  },
  {
    q: "Is CMAE free?",
    a: "The desktop app is free for personal use. You bring your own Gmail (App Password) and a Cursor API key. Cursor usage is billed on your Cursor account, not by CMAE.",
  },
  {
    q: "Does CMAE send emails for me?",
    a: "No. CMAE never sends mail or push notifications. It writes drafts into Gmail Drafts (with your CV attached when relevant). You always open Gmail, review, and send yourself.",
  },
  {
    q: "Do I need Gmail, or will Outlook work?",
    a: "Gmail only for now. CMAE uses IMAP sync and Gmail Drafts with a Google App Password — not your normal Gmail password. Outlook and other providers are not supported.",
  },
  {
    q: "What is a Gmail App Password?",
    a: "A 16-character password from Google for apps (requires 2-Step Verification). CMAE uses it to read recent mail and save drafts. It is encrypted and stored only on your computer — never uploaded to CMAE servers.",
  },
  {
    q: "Why do I need a Cursor API key?",
    a: "Research agents, email drafting, and follow-up suggestions run through Cursor’s API. The key stays encrypted on your machine. Without it, Research and AI drafting cannot run.",
  },
  {
    q: "Where is my data stored? Is it private?",
    a: "On your computer: SQLite + files under the app userData folder (company folders, CVs, settings). Secrets are encrypted locally. CMAE does not upload your mail or keys to our servers. The only optional cloud step is interface language-pack translation when you pick a non-English UI language.",
  },
  {
    q: "Do I need a CV?",
    a: "Yes — at least one PDF. CMAE reads the text to personalize outreach and attaches the PDF to application and follow-up drafts. You can add more CVs (languages/labels) later in Settings.",
  },
  {
    q: "Which platforms are supported?",
    a: "macOS Apple Silicon (arm64) via .dmg, and Windows x64 via .exe. Intel Macs and Linux desktop builds are not offered yet.",
  },
  {
    q: "Is there a web app I can use in the browser?",
    a: "This site is the download landing page. Day-to-day use is the desktop app so your Gmail credentials and research files stay on your machine.",
  },
  {
    q: "Do I need to be online?",
    a: "Yes for Research (fetching pages + Cursor), Gmail sync, and updates. Browsing already-saved Folders and reviewing Tracker rows works offline once data is on disk.",
  },
  {
    q: "How do updates work?",
    a: "The app checks a version policy and can prompt you when a newer build is available. Reinstalling a newer installer keeps your userData. Avoid Settings → wipe/uninstall if you only meant to upgrade.",
  },
  {
    q: "Why does macOS warn when I open CMAE?",
    a: "First launch after download: right-click CMAE → Open → confirm Open (Gatekeeper). Signed/notarized builds usually need this once; unsigned builds may need the same path.",
  },
  {
    q: "Windows SmartScreen blocked the installer — is that normal?",
    a: "Unsigned Windows builds often trigger SmartScreen. Choose More info → Run anyway, then finish the installer. Signed builds reduce this warning.",
  },
  {
    q: "Can I change the interface language?",
    a: "Yes in onboarding or Settings. UI language packs can be generated for your locale. Emails to companies still follow each company’s language; translated copies are for you.",
  },
  {
    q: "How do I wipe everything?",
    a: "Settings includes a full wipe of local settings, mail cache, tracker, CVs, company folders, and research history on this computer. That cannot be undone — you will set up CMAE again from scratch.",
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
          <p className="cmae-land-brand">CMAE</p>
          <h1 className="cmae-land-title">Cold mail, without the chaos.</h1>
          <p className="cmae-land-lead">
            Research companies, draft outreach, sync Gmail — you always send.
          </p>
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
        </div>
      </header>

      <div className="cmae-land-tour" aria-label="Interactive product tour">
        <p className="cmae-land-tour-label">Interactive tour</p>
        <LandingScenarioProvider>
          <LandingStage
            step="01"
            title="Research"
            lead="Paste careers URLs — agents find contacts and draft outreach. Try Start research."
          >
            <LandingResearchDemo />
          </LandingStage>

          <LandingStage
            step="02"
            title="Folders"
            lead="Open a company folder — read the brief or the drafted email. Everything stays on your machine."
          >
            <LandingFoldersDemo />
          </LandingStage>

          <LandingStage
            step="03"
            title="Tracker"
            lead="Sync Gmail — researched companies show up Ready to send. You always send from Gmail yourself."
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
          Short answers before you install.
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
          Local-first. Signed installers via CDN (v{initialPolicy.latest}).
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
        <span>CMAE</span>
        <span>v{initialPolicy.latest}</span>
      </footer>
    </div>
  );
}
