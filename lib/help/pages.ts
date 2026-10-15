export type AppPageId = "tracker" | "search" | "folders" | "settings";

export type PageHelp = {
  /** Navbar / product label */
  navLabel: string;
  /** Page H1 */
  title: string;
  /** Short subtitle under H1 */
  subtitle: string;
  /** Modal heading */
  helpTitle: string;
  /** Intro paragraphs */
  helpBody: string[];
  /** Numbered how-to steps */
  helpSteps: string[];
};

export const PAGE_HELP: Record<AppPageId, PageHelp> = {
  tracker: {
    navLabel: "Tracker",
    title: "Tracker",
    subtitle:
      "Track every application here. Drafts land in Gmail; sending is always on you.",
    helpTitle: "How Tracker works",
    helpBody: [
      "This page merges Gmail application threads with companies you researched under Search into one list.",
      "Each row is one application process: status, latest activity, and ready actions.",
    ],
    helpSteps: [
      "Run Gmail sync to pull recent mail. On first setup, Hard Sync can scan the last 30 days.",
      "Companies you research under Search also appear in this list automatically.",
      "When you need a follow-up, reply, or thank-you, use the action — the draft is written to Gmail Drafts.",
      "You always send from Gmail yourself; CMAE never sends mail.",
    ],
  },
  search: {
    navLabel: "Search",
    title: "Search",
    subtitle:
      "Paste company or careers page URLs. Agents find contacts and prepare an outreach draft.",
    helpTitle: "How Search works",
    helpBody: [
      "Start a company research run with one or more URLs. Each link runs in its own terminal in parallel.",
      "Outputs are stored under Folders; strong matches link into Tracker.",
    ],
    helpSteps: [
      "Paste careers or company URLs into the box (one per line or comma-separated).",
      "Start research — agents scan the site, find contacts, and draft mail.",
      "Re-open past runs from the history rail on the left.",
      "When a run finishes, check Tracker and send the draft from Gmail.",
    ],
  },
  folders: {
    navLabel: "Folders",
    title: "Folders",
    subtitle:
      "Browse research outputs and company files like your system file manager, and preview what you need.",
    helpTitle: "What Folders is for",
    helpBody: [
      "Each research run creates a company folder under workspace: notes, drafts, and attachments live here.",
      "Use this page to browse without leaving the app, and rename or delete folders when needed.",
    ],
    helpSteps: [
      "Pick a company folder from the left tree.",
      "Click a file to preview; markdown and text open in the browser.",
      "You can rename or delete folders — Tracker links stay in sync.",
      "CVs live under cvs/; managing them in Settings is usually easier.",
    ],
  },
  settings: {
    navLabel: "Settings",
    title: "Settings",
    subtitle: "Update your profile, Gmail, Cursor API, and job preferences.",
    helpTitle: "About Settings",
    helpBody: [
      "Everything you entered in onboarding lives here. Changes apply to new drafts right away.",
      "Secrets (Gmail App Password, Cursor API Key) are encrypted in the local database on this machine.",
    ],
    helpSteps: [
      "Update your name and preferred language under Profile — drafts and AI follow these.",
      "To change Gmail or Cursor credentials, paste a new value; leave blank to keep the current one.",
      "Job preferences (work type, notice, salary) feed application and follow-up copy.",
      "Add PDF CVs to the library; they attach to drafts by language and tags.",
    ],
  },
};

export function helpSeenKey(pageId: AppPageId): string {
  return `cmae.help.seen.${pageId}`;
}
