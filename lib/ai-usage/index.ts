/**
 * Server entry: importing this registers the SQLite usage backend (metering +
 * response cache). Eval/CLI code that must stay DB-free imports
 * `./call` directly instead.
 */

import { setUsageBackend } from "./call";
import { createDbBackend } from "./store";

// Vercel hosts only the i18n proxy: no per-user metering/telemetry there.
if (!process.env.VERCEL && !process.env.VERCEL_ENV) {
  setUsageBackend(createDbBackend());
}

export { promptWithUsage, LlmTimeoutError } from "./call";
export type { PromptWithUsageInput, PromptWithUsageResult } from "./call";
export { AI_FEATURES, isCacheableFeature } from "./features";
export type { AiFeature, SyncMode } from "./features";
export {
  currentUsageRunId,
  withUsageRun,
  withUsageRunAsync,
} from "./run-context";
