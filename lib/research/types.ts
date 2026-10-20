export type TermKind = "think" | "curl" | "python" | "system" | "ok" | "err";

export type TermLine = {
  id: string;
  kind: TermKind;
  /** Technical / detail log line */
  text: string;
  /** Plain description for readable mode (client derives if missing) */
  plain?: string;
  at: number;
  agent?: SpecialistId;
};

export type JobStatus = "queued" | "running" | "done" | "error" | "canceled";

export type ResearchJob = {
  id: string;
  url: string;
  folderName: string;
  folderPath: string;
  status: JobStatus;
  companyName: string | null;
  error: string | null;
  createdAt: number;
  lines: TermLine[];
  /** Soft-kill flag — specialists + conductor check; AbortController hard-stops curl */
  cancelRequested?: boolean;
};

export type JobEvent =
  | { type: "line"; line: TermLine }
  | {
      type: "status";
      status: JobStatus;
      companyName?: string | null;
      error?: string | null;
      folderName?: string;
    }
  | { type: "done"; status: JobStatus };

/** Workflow specialist ids — order matters for rewind */
export const SPECIALISTS = [
  "scout",
  "jobfit",
  "contact",
  "research",
  "writer",
  "reviewer",
] as const;

export type SpecialistId = (typeof SPECIALISTS)[number];

export type SpecialistScores = Partial<Record<Exclude<SpecialistId, "reviewer">, number>>;

export type ReviewVerdict = {
  passed: boolean;
  overallScore: number;
  threshold: number;
  scores: SpecialistScores;
  /** Which specialist must redo — conductor rewinds here and continues forward */
  rewindTo: Exclude<SpecialistId, "reviewer"> | null;
  feedback: Partial<Record<Exclude<SpecialistId, "reviewer">, string>>;
  summary: string;
};
