export type AppPageId = "tracker" | "research" | "folders" | "settings";

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

/**
 * English reference only — live UI copy comes from locales via `help.*` keys.
 * Keep this aligned with locales/en.json help section for docs/fallback clarity.
 */
export const PAGE_HELP: Record<AppPageId, PageHelp> = {
  tracker: {
    navLabel: "Tracker",
    title: "Tracker",
    subtitle:
      "Follow every application in one list. Drafts go to Gmail; you always send them yourself.",
    helpTitle: "How Tracker works",
    helpBody: [
      "Each row is one job application. CMAE reads your related Gmail and updates the status as the conversation changes — you do not set statuses by hand.",
      "Days mentioned below (when to follow up, when something closes) can be changed in Settings.",
    ],
    helpSteps: [
      "Run Gmail sync to load recent mail. Turn on Thorough sync if something looks missing (last ~30 days).",
      "Companies from Research also appear here automatically.",
      "For a follow-up, reply, or thank-you, use the action — CMAE writes a draft into Gmail Drafts.",
      "Click a company row to open its timeline. You always send from Gmail yourself; CMAE never sends mail for you.",
    ],
  },
  research: {
    navLabel: "Research",
    title: "Research",
    subtitle:
      "Paste company or careers page URLs. CMAE finds contacts and prepares an outreach draft.",
    helpTitle: "How Research works",
    helpBody: [
      "Start research with one or more URLs. Each link is processed on its own so you can run several in parallel.",
      "Results are saved under Folders; good matches also show up in Tracker.",
    ],
    helpSteps: [
      "Paste careers or company URLs (one per line, or separated by commas).",
      "Start research — CMAE reviews the site, looks for contacts, and drafts an email.",
      "Re-open earlier runs from the history list on the left.",
      "When a run finishes, check Tracker and send the draft from Gmail.",
    ],
  },
  folders: {
    navLabel: "Folders",
    title: "Folders",
    subtitle:
      "Browse research files and company folders like your system file manager, and preview what you need.",
    helpTitle: "What Folders is for",
    helpBody: [
      "Each research run creates a company folder with notes, drafts, and related files.",
      "Browse here without leaving the app. Rename or delete folders when you no longer need them.",
    ],
    helpSteps: [
      "Choose a company folder from the list on the left.",
      "Click a file to preview it.",
      "Rename or delete folders as needed — Tracker stays in sync.",
      "CV files can also be managed more easily in Settings.",
    ],
  },
  settings: {
    navLabel: "Settings",
    title: "Settings",
    subtitle: "Update your profile, Gmail, Cursor key, and job preferences.",
    helpTitle: "About Settings",
    helpBody: [
      "Everything from setup lives here. Changes apply to new drafts right away.",
      "Your Gmail App Password and Cursor API key are encrypted and stored only on this computer.",
    ],
    helpSteps: [
      "Update your name and language under Profile — new drafts follow these.",
      "To change Gmail or Cursor details, paste a new value; leave the field blank to keep the current one.",
      "Job preferences (work type, notice period, salary) shape application and follow-up wording.",
      "Add PDF CVs here; they attach to drafts based on language and tags.",
    ],
  },
};
