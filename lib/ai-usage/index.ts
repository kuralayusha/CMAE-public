/**
 * Server entry: importing this registers the SQLite usage backend (metering +
 * response cache). Eval/CLI code that must stay DB-free imports
 * `./call` directly instead.
 */

import { describeOpenRouterError } from "../llm/errors";
import { setLlmErrorDescriber, setUsageBackend } from "./call";
import { createDbBackend } from "./store";

setLlmErrorDescriber(describeOpenRouterError);

// Vercel hosts only the i18n proxy and has no per-user SQLite. Measured
// translation calls are returned to the desktop, which writes ai_usage_events.
if (!process.env.VERCEL && !process.env.VERCEL_ENV) {
  setUsageBackend(createDbBackend());
}

export { promptWithUsage, readStampedUsage, LlmTimeoutError } from "./call";
export type { StampedUsage } from "./call";
export type { PromptWithUsageInput, PromptWithUsageResult } from "./call";
export { AI_FEATURES, isCacheableFeature } from "./features";
export type { AiFeature, SyncMode } from "./features";
export {
  currentUsageRunId,
  withUsageRun,
  withUsageRunAsync,
} from "./run-context";
