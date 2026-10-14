import { requireOnboardedResponse } from "@/lib/onboarding/http";
import { subscribeTrackerLive, type TrackerLiveEvent } from "@/lib/tracker/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const blocked = requireOnboardedResponse();
  if (blocked) return blocked;
  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let unsub: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (payload: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
          );
        } catch {
          closed = true;
        }
      };

      send({ type: "hello", at: Date.now() });

      unsub = subscribeTrackerLive((event: TrackerLiveEvent) => {
        send(event);
      });

      heartbeat = setInterval(() => {
        send({ type: "ping", at: Date.now() });
      }, 25000);
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsub?.();
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
