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
    id: "acme",
    name: "Acme Corp",
    folder: "01-acme",
    url: "https://acme.example.com/jobs",
    hostname: "acme.example.com",
    roleKey: "landing.demo.roleBackend",
  },
  {
    id: "globex",
    name: "Globex",
    folder: "02-globex",
    url: "https://globex.example.com/careers",
    hostname: "globex.example.com",
    roleKey: "landing.demo.roleProduct",
  },
  {
    id: "initech",
    name: "Initech",
    folder: "03-initech",
    url: "https://initech.example.com/careers",
    hostname: "initech.example.com",
    roleKey: "landing.demo.roleFullstack",
  },
];

const FILES_BY_COMPANY: Record<string, ScenarioFile[]> = {
  acme: [
    {
      id: "info",
      name: "company_info.md",
      badges: [{ label: "for you", tone: "ok" }],
      body: `# Acme Corp — research note (en)

Logistics software for growing distributors. Teams ship order routing, inventory, and invoicing products used by small shops and large warehouses.

## Why this fit
- Strong backend / distributed systems culture
- Open roles on the jobs board match your API and reliability focus

## Suggested angle
Lead with a concrete systems win (latency, idempotency, or order-processing edge cases), then ask for a short intro to the hiring team.`,
    },
    {
      id: "draft",
      name: "email_draft.md",
      badges: [{ label: "for you", tone: "ok" }],
      body: `To: hiring@acme.example.com
Subject: Backend Engineer — application

Hi Acme Corp hiring team,

I am applying for the Backend Engineer role. I build reliable APIs and order-processing services, and Acme Corp's focus on correct, boring infrastructure is a strong match.

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
hiring@acme.example.com

## Candidates
- hiring@acme.example.com _(role: careers, p1)_ — primary careers inbox
- jobs@acme.example.com _(role: careers, p2)_ — secondary listing alias`,
    },
  ],
  globex: [
    {
      id: "info",
      name: "company_info.md",
      badges: [{ label: "for you", tone: "ok" }],
      body: `# Globex — research note (en)

Cloud tooling for regional web teams. Managed deploys, staging environments, and edge delivery are core product bets.

## Why this fit
- Product engineering close to the stack you already use
- Customer-facing shipping cadence matches your portfolio

## Suggested angle
Mention a web performance win, then ask who owns Product Engineer hiring for the team you care about.`,
    },
    {
      id: "draft",
      name: "email_draft.md",
      badges: [{ label: "for you", tone: "ok" }],
      body: `To: talent@globex.example.com
Subject: Product Engineer — cold outreach

Hi,

I am reaching out about Product Engineer roles at Globex. I ship web products end to end and care about DX and performance as much as features.

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
talent@globex.example.com

## Candidates
- talent@globex.example.com _(role: hr, p1)_ — recruiting mailbox
- careers@globex.example.com _(role: careers, p2)_ — careers form alias`,
    },
  ],
  initech: [
    {
      id: "info",
      name: "company_info.md",
      badges: [{ label: "for you", tone: "ok" }],
      body: `# Initech — research note (en)

Workflow software for small, fast-moving product teams. Speed, clear UX, and crisp design are the brand.

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
      body: `To: jobs@initech.example.com
Subject: Full-stack Engineer application

Hello Initech team,

I am applying for the Full-stack Engineer role. I care about fast UI, clean data models, and tools people actually enjoy using — which is why Initech stands out.

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
jobs@initech.example.com

## Candidates
- jobs@initech.example.com _(role: careers, p1)_ — careers inbox
- hello@initech.example.com _(role: contact, p3)_ — general — deprioritized`,
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
