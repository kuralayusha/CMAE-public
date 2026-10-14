import type { DiscoveredPage, PlannedRoute, RankedEmail } from "./discover";
import type { ReviewVerdict, SpecialistId } from "./types";

export type UserProfile = {
  fullName: string;
  email: string;
  cvText: string;
  preferredLang: string;
};

export type JobFitResult = {
  hasMatchingJob: boolean;
  jobs: { title: string; url: string; whyFit: string; priority: number }[];
  siteLanguage: string;
  notes: string;
};

/** Mutable bag shared across specialists for one company run */
export type RunContext = {
  jobId: string;
  url: string;
  user: UserProfile;
  folderName: string;
  folderPath: string;
  companyName: string;
  siteLanguage: string;
  home: DiscoveredPage | null;
  pages: DiscoveredPage[];
  routes: PlannedRoute[];
  pathGuesses: string[];
  planNotes: string;
  jobFit: JobFitResult | null;
  emails: RankedEmail[];
  primaryEmail: string | null;
  researchMd: string;
  draftSite: string;
  draftPreferred: string;
  lastReview: ReviewVerdict | null;
  /** Feedback injected when rewinding to a specialist */
  redoFeedback: Partial<Record<Exclude<SpecialistId, "reviewer">, string>>;
  retries: Partial<Record<Exclude<SpecialistId, "reviewer">, number>>;
};

export function createRunContext(
  jobId: string,
  url: string,
  user: UserProfile,
): RunContext {
  return {
    jobId,
    url,
    user,
    folderName: "",
    folderPath: "",
    companyName: "",
    siteLanguage: "und",
    home: null,
    pages: [],
    routes: [],
    pathGuesses: [],
    planNotes: "",
    jobFit: null,
    emails: [],
    primaryEmail: null,
    researchMd: "",
    draftSite: "",
    draftPreferred: "",
    lastReview: null,
    redoFeedback: {},
    retries: {},
  };
}
