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
    // Avoid repeating the agent name at the start; otherwise wrap in parentheses
    if (!/\([^)]+agent[^)]*\)$/i.test(human) && !/\(Conductor\)$/i.test(human) && !/\(System\)$/i.test(human)) {
      human = withAgent(human.replace(/\.$/, ""), agent);
    }
  } else {
    human =
      derivePlain({ kind, text: tagged, agent: agentId }) ||
      withAgent(text.replace(/^[◆▶⏪·\s]+/, "").slice(0, 140), agent);
  }

  emitLine(jobId, kind, tagged, agentId, human);
}
