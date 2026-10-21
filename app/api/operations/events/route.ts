import { requireOnboardedResponse } from "@/lib/onboarding/http";
import { subscribeOperations } from "@/lib/operations/bus";
import { getOperationsStatus, type OperationsStatus } from "@/lib/operations/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type OpsEvent =
  | ({ type: "snapshot" | "status" } & OperationsStatus)
  | { type: "ping" };

export async function GET(request: Request) {
  const blocked = requireOnboardedResponse();
  if (blocked) return blocked;

  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let unsub: (() => void) | null = null;

  const cleanup = () => {
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    unsub?.();
    unsub = null;
  };

  const stream = new ReadableStream({
    start(controller) {
      const send = (payload: OpsEvent) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
          );
        } catch {
          cleanup();
        }
      };

      send({ type: "snapshot", ...getOperationsStatus() });
      unsub = subscribeOperations((status) => {
        send({ type: "status", ...status });
      });

      heartbeat = setInterval(() => send({ type: "ping" }), 25000);
      if (typeof heartbeat === "object" && "unref" in heartbeat) {
        heartbeat.unref();
      }

      request.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
