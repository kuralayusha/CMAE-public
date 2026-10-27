"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type ScenarioCompany = {
  id: string;
  name: string;
  folder: string;
  url: string;
  hostname: string;
  /** i18n key (landing.demo.role*) for the job title shown in the tracker demo. */
  roleKey: string;
};

export type ScenarioFile = {
  id: string;
  name: string;
  badges: { label: string; tone: "ok" | "ai" | "muted" }[];
  body: string;
};

export const SCENARIO_COMPANIES: ScenarioCompany[] = [
  {
    id: "stripe",
    name: "Stripe",
    folder: "01-stripe",
    url: "https://stripe.com/jobs",
    hostname: "stripe.com",
    roleKey: "landing.demo.roleBackend",
  },
  {
    id: "vercel",
    name: "Vercel",
    folder: "02-vercel",
    url: "https://vercel.com/careers",
    hostname: "vercel.com",
    roleKey: "landing.demo.roleProduct",
  },
  {
    id: "linear",
    name: "Linear",
    folder: "03-linear",
    url: "https://linear.app/careers",
    hostname: "linear.app",
    roleKey: "landing.demo.roleFullstack",
  },
];

const FILES_BY_COMPANY: Record<string, ScenarioFile[]> = {
  stripe: [
    {
      id: "info",
      name: "company_info.md",
      badges: [{ label: "for you", tone: "ok" }],
      body: `# Stripe — research note (en)

Payments infrastructure for the internet. Teams ship billing, Connect, and Treasury products used by startups and enterprises.

## Why this fit
- Strong backend / distributed systems culture
- Open roles on the jobs board match your API and reliability focus

## Suggested angle
Lead with a concrete systems win (latency, idempotency, or payment edge cases), then ask for a short intro to the hiring team.`,
    },
    {
      id: "draft",
      name: "email_draft.md",
      badges: [{ label: "for you", tone: "ok" }],
      body: `To: hiring@example.com
Subject: Backend Engineer — application

Hi Stripe hiring team,

I am applying for the Backend Engineer role. I build reliable APIs and payment-adjacent services, and Stripe's focus on correct, boring infrastructure is a strong match.

I attached my CV. Happy to share a short write-up of a recent systems project if useful.

Best regards,
Alex Rivera`,
    },
    {
      id: "contact",
      name: "contact.md",
      badges: [{ label: "for CMAE", tone: "ai" }],
      body: `# Contact (contact agent)

## Recommended
hiring@example.com

## Candidates
- hiring@example.com _(role: careers, p1)_ — primary careers inbox
- jobs@example.com _(role: careers, p2)_ — secondary listing alias`,
    },
  ],
  vercel: [
    {
      id: "info",
      name: "company_info.md",
      badges: [{ label: "for you", tone: "ok" }],
      body: `# Vercel — research note (en)

Frontend cloud for Next.js and modern web apps. Fluid compute, previews, and edge delivery are core product bets.

## Why this fit
- Product engineering close to the framework you already use
- Customer-facing shipping cadence matches your portfolio

## Suggested angle
Mention a Next.js / performance win, then ask who owns Product Engineer hiring for the team you care about.`,
    },
    {
      id: "draft",
      name: "email_draft.md",
      badges: [{ label: "for you", tone: "ok" }],
      body: `To: talent@example.com
Subject: Product Engineer — cold outreach

Hi,

I am reaching out about Product Engineer roles at Vercel. I ship Next.js products end to end and care about DX and performance as much as features.

CV attached. Would love a pointer to the right hiring contact if this lands in the wrong inbox.

Thanks,
Alex Rivera`,
    },
    {
      id: "contact",
      name: "contact.md",
      badges: [{ label: "for CMAE", tone: "ai" }],
      body: `# Contact (contact agent)

## Recommended
talent@example.com

## Candidates
- talent@example.com _(role: hr, p1)_ — recruiting mailbox
- careers@example.com _(role: careers, p2)_ — careers form alias`,
    },
  ],
  linear: [
    {
      id: "info",
      name: "company_info.md",
      badges: [{ label: "for you", tone: "ok" }],
      body: `# Linear — research note (en)

Issue tracking built for high-agency product teams. Speed, keyboard UX, and crisp design are the brand.

## Why this fit
- Full-stack product work with strong craft bar
- Your project demos map cleanly to their product surface

## Suggested angle
Open with a product taste note (speed / clarity), then ask about the Full-stack Engineer opening.`,
    },
    {
      id: "draft",
      name: "email_draft.md",
      badges: [{ label: "for you", tone: "ok" }],
      body: `To: jobs@example.com
Subject: Full-stack Engineer application

Hello Linear team,

I am applying for the Full-stack Engineer role. I care about fast UI, clean data models, and tools people actually enjoy using — which is why Linear stands out.

CV attached. Glad to walk through a recent product build if helpful.

Best,
Alex Rivera`,
    },
    {
      id: "contact",
      name: "contact.md",
      badges: [{ label: "for CMAE", tone: "ai" }],
      body: `# Contact (contact agent)

## Recommended
jobs@example.com

## Candidates
- jobs@example.com _(role: careers, p1)_ — careers inbox
- hello@example.com _(role: contact, p3)_ — general — deprioritized`,
    },
  ],
};

type LandingScenarioValue = {
  researchDone: boolean;
  researchRunId: number;
  trackerSynced: boolean;
  companies: ScenarioCompany[];
  filesFor: (companyId: string) => ScenarioFile[];
  markResearchDone: () => void;
  resetResearch: () => void;
  markTrackerSynced: (synced: boolean) => void;
};

const LandingScenarioContext = createContext<LandingScenarioValue | null>(null);

export function LandingScenarioProvider({ children }: { children: ReactNode }) {
  const [researchDone, setResearchDone] = useState(false);
  const [researchRunId, setResearchRunId] = useState(0);
  const [trackerSynced, setTrackerSynced] = useState(false);

  const markResearchDone = useCallback(() => {
    setResearchDone(true);
    setResearchRunId((n) => n + 1);
  }, []);

  const resetResearch = useCallback(() => {
    setResearchDone(false);
  }, []);

  const markTrackerSynced = useCallback((synced: boolean) => {
    setTrackerSynced(synced);
  }, []);

  const filesFor = useCallback((companyId: string) => {
    return FILES_BY_COMPANY[companyId] || [];
  }, []);

  const value = useMemo(
    () => ({
      researchDone,
      researchRunId,
      trackerSynced,
      companies: SCENARIO_COMPANIES,
      filesFor,
      markResearchDone,
      resetResearch,
      markTrackerSynced,
    }),
    [
      researchDone,
      researchRunId,
      trackerSynced,
      filesFor,
      markResearchDone,
      resetResearch,
      markTrackerSynced,
    ],
  );

  return (
    <LandingScenarioContext.Provider value={value}>
      {children}
    </LandingScenarioContext.Provider>
  );
}

export function useLandingScenario() {
  const ctx = useContext(LandingScenarioContext);
  if (!ctx) {
    throw new Error("useLandingScenario must be used within LandingScenarioProvider");
  }
  return ctx;
}
