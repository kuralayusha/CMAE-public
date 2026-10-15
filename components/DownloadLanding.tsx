"use client";

import { useEffect, useState } from "react";
import type { VersionPolicy } from "@/lib/version/policy";
import { LandingResearchDemo } from "@/components/landing/LandingResearchDemo";
import { LandingTrackerDemo } from "@/components/landing/LandingTrackerDemo";
import "@/app/download/download.css";

type Props = {
  initialPolicy: VersionPolicy;
};

const FAQ: { q: string; a: string }[] = [
  {
    q: "Is CMAE free?",
    a: "Yes for personal use. You need your own Gmail App Password and a Cursor API key for research agents.",
  },
  {
    q: "Does CMAE send emails for me?",
    a: "No. CMAE writes drafts into Gmail Drafts. You always review and send yourself.",
  },
  {
    q: "Where is my data stored?",
    a: "On your machine — SQLite and files under the app’s user data folder. Nothing is uploaded to our servers except optional language-pack translation.",
  },
  {
    q: "Mac or Windows?",
    a: "macOS Apple Silicon (arm64) and Windows x64. Use the buttons in the hero.",
  },
  {
    q: "Why does macOS ask to open the app?",
    a: "Signed and notarized builds show a one-time “downloaded from the Internet” prompt. Click Open once.",
  },
  {
    q: "Windows SmartScreen?",
    a: "Unsigned Windows builds may warn. Choose More info → Run anyway until a code-signing certificate is added.",
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

      <div className="cmae-land-hero-stage">
        <LandingResearchDemo />
      </div>

      <section className="cmae-land-section" aria-labelledby="cmae-land-how">
        <h2 id="cmae-land-how" className="cmae-land-h2">
          How it works
        </h2>
        <p className="cmae-land-section-lead">
          Three steps. CMAE never sends mail on your behalf.
        </p>
        <ol className="cmae-land-steps">
          <li>
            <span className="cmae-land-step-n">01</span>
            <span className="cmae-land-step-t">Research</span>
            <span className="cmae-land-step-d">
              Paste careers URLs — agents find contacts and draft outreach.
            </span>
          </li>
          <li>
            <span className="cmae-land-step-n">02</span>
            <span className="cmae-land-step-t">Draft</span>
            <span className="cmae-land-step-d">
              Sync Gmail, prepare follow-ups — drafts land in Gmail Drafts.
            </span>
          </li>
          <li>
            <span className="cmae-land-step-n">03</span>
            <span className="cmae-land-step-t">You send</span>
            <span className="cmae-land-step-d">
              Open Gmail, review, send. You stay in control.
            </span>
          </li>
        </ol>
      </section>

      <section className="cmae-land-section" aria-labelledby="cmae-land-track">
        <h2 id="cmae-land-track" className="cmae-land-h2">
          One list for every application
        </h2>
        <p className="cmae-land-section-lead">
          Try a sync — statuses update the way Tracker does in the app.
        </p>
        <LandingTrackerDemo />
      </section>

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
          Local-first. Installers from{" "}
          <a href={initialPolicy.releaseUrl}>GitHub Releases</a>.
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
