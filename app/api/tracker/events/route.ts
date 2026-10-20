import { requireOnboardedResponse } from "@/lib/onboarding/http";
import {
  backfillTrackerEvents,
  subscribeTrackerEvents,
  trackerHelloEvent,
  type TrackerEvent,
} from "@/lib/tracker/events-bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function eventId(event: TrackerEvent): number | null {
  if ("rev" in event && typeof event.rev === "number") return event.rev;
  return null;
}

export async function GET(request: Request) {
  const blocked = requireOnboardedResponse();
  if (blocked) return blocked;

  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let unsub: (() => void) | null = null;

  const lastEventIdHeader = request.headers.get("last-event-id");
  const lastEventId = lastEventIdHeader
    ? Number.parseInt(lastEventIdHeader, 10)
    : NaN;

  const stream = new ReadableStream({
    start(controller) {
      const send = (payload: TrackerEvent) => {
        if (closed) return;
        try {
          const id = eventId(payload);
          const idLine = id != null ? `id: ${id}\n` : "";
          controller.enqueue(
            encoder.encode(`${idLine}data: ${JSON.stringify(payload)}\n\n`),
          );
        } catch {
          closed = true;
        }
      };

      send(trackerHelloEvent());

      if (Number.isFinite(lastEventId)) {
        for (const ev of backfillTrackerEvents(lastEventId)) {
          send(ev);
        }
      }

      unsub = subscribeTrackerEvents((event) => {
        send(event);
      });

      heartbeat = setInterval(() => {
        send({ type: "ping" });
      }, 25000);
      if (heartbeat && typeof heartbeat === "object" && "unref" in heartbeat) {
        heartbeat.unref();
      }
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
