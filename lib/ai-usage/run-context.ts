/**
 * Groups many AI calls into one logical "run" (sync job, research job,
 * locale translate batch, …). Callers wrap the top-level operation; each
 * `promptWithUsage` then inherits the run id via AsyncLocalStorage.
 */

import { AsyncLocalStorage } from "node:async_hooks";

type RunStore = { runId: string };

const als = new AsyncLocalStorage<RunStore>();

/** Current run id, if any enclosing `withUsageRun` is active. */
export function currentUsageRunId(): string | null {
  return als.getStore()?.runId ?? null;
}

/** Run `fn` with every nested AI call tagged as `runId`. */
export function withUsageRun<T>(runId: string, fn: () => T): T {
  return als.run({ runId }, fn);
}

export async function withUsageRunAsync<T>(
  runId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return als.run({ runId }, fn);
}
