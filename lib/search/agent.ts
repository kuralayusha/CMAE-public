import { runConductor } from "./conductor";

/** Entry: one conductor session per URL */
export async function runSearchAgent(jobId: string) {
  await runConductor(jobId);
}
