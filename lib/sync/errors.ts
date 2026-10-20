export type SyncErrorKind =
  | "auth"
  | "network"
  | "throttle"
  | "server"
  | "llm"
  | "disk"
  | "db"
  | "stuck"
  | "bug"
  | "canceled_by_reset"
  | "canceled_by_account_switch"
  | "fenced"
  | "canceled";

export class FencedError extends Error {
  readonly kind = "fenced" as const;
  constructor(message = "Job fenced out by epoch/credentials/account change") {
    super(message);
    this.name = "FencedError";
  }
}

export function classifySyncError(err: unknown): {
  kind: SyncErrorKind;
  message: string;
} {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  if (err instanceof FencedError || lower.includes("fenced")) {
    return { kind: "fenced", message };
  }
  if (
    lower.includes("authenticationfailed") ||
    lower.includes("invalid credentials") ||
    lower.includes("auth") && lower.includes("fail") ||
    lower.includes("application-specific password")
  ) {
    return { kind: "auth", message };
  }
  if (
    lower.includes("[throttled]") ||
    lower.includes("too many simultaneous") ||
    lower.includes("rate limit") ||
    lower.includes("bandwidth")
  ) {
    return { kind: "throttle", message };
  }
  if (
    lower.includes("econnreset") ||
    lower.includes("enotfound") ||
    lower.includes("etimedout") ||
    lower.includes("econnrefused") ||
    lower.includes("socket") ||
    lower.includes("network") ||
    lower.includes("offline") ||
    lower.includes("getaddrinfo")
  ) {
    return { kind: "network", message };
  }
  if (
    lower.includes("sqlite_full") ||
    lower.includes("enospc") ||
    lower.includes("no space")
  ) {
    return { kind: "disk", message };
  }
  if (lower.includes("sqlite_busy") || lower.includes("database is locked")) {
    return { kind: "db", message };
  }
  if (lower.includes("stuck") || lower.includes("phase budget")) {
    return { kind: "stuck", message };
  }
  if (
    lower.includes("llm") ||
    lower.includes("timeout") && lower.includes("composer")
  ) {
    return { kind: "llm", message };
  }
  return { kind: "bug", message };
}

/** Backoff delays (ms) by attempt index (1-based): 1, 2, 5, 15, 30 min. */
export function retryDelayMs(attempt: number): number {
  const mins = [1, 2, 5, 15, 30];
  const idx = Math.max(0, Math.min(mins.length - 1, attempt - 1));
  return mins[idx]! * 60_000;
}
