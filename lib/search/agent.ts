import { runConductor } from "./conductor";

/** Entry: her URL için bir conductor oturumu */
export async function runSearchAgent(jobId: string) {
  await runConductor(jobId);
}
