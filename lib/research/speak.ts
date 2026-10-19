import { t } from "@/lib/i18n/t";
import { emitLine } from "./events";
import { derivePlain, withAgent } from "./plain";
import type { SpecialistId, TermKind } from "./types";

const TAG: Record<SpecialistId | "conductor", string> = {
  conductor: "conductor",
  scout: "scout",
  jobfit: "jobfit",
  contact: "contact",
  research: "research",
  writer: "writer",
  reviewer: "reviewer",
};

export function speak(
  jobId: string,
  agent: SpecialistId | "conductor",
  kind: TermKind,
  text: string,
  plain?: string,
) {
  const tagged = `[${TAG[agent]}] ${text}`;
  const agentId = agent === "conductor" ? undefined : agent;

  let human = plain;
  if (human) {
    // Avoid double parentheses if caller already wrapped the agent
    if (!/\([^)]+\)$/.test(human.trim())) {
      human = withAgent(human.replace(/\.$/, ""), agent, t);
    }
  } else {
    human =
      derivePlain({ kind, text: tagged, agent: agentId, t }) ||
      withAgent(text.replace(/^[◆▶⏪·\s]+/, "").slice(0, 140), agent, t);
  }

  emitLine(jobId, kind, tagged, agentId, human);
}
