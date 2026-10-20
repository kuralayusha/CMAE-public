declare global {
  // eslint-disable-next-line no-var
  var __cmaeResearchAborts: Map<string, AbortController> | undefined;
}

function abortMap(): Map<string, AbortController> {
  if (!globalThis.__cmaeResearchAborts) {
    globalThis.__cmaeResearchAborts = new Map();
  }
  return globalThis.__cmaeResearchAborts;
}

/** Create (or replace) the abort controller for a live research run. */
export function resetJobAbort(jobId: string): AbortSignal {
  const map = abortMap();
  const prev = map.get(jobId);
  if (prev && !prev.signal.aborted) {
    try {
      prev.abort();
    } catch {
      /* ignore */
    }
  }
  const ac = new AbortController();
  map.set(jobId, ac);
  return ac.signal;
}

export function getJobSignal(jobId: string): AbortSignal | undefined {
  return abortMap().get(jobId)?.signal;
}

export function abortJob(jobId: string): void {
  const ac = abortMap().get(jobId);
  if (!ac || ac.signal.aborted) return;
  try {
    ac.abort();
  } catch {
    /* ignore */
  }
}

export function clearJobAbort(jobId: string): void {
  abortMap().delete(jobId);
}
