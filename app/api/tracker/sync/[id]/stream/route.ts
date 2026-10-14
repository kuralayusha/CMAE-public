import { requireOnboardedResponse } from "@/lib/onboarding/http";
import {
  getSyncSession,
  subscribeSyncSession,
  syncSessionHello,
  type SyncSessionEvent,
} from "@/lib/tracker/session";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const blocked = requireOnboardedResponse();
  if (blocked) return blocked;
  const { id } = await ctx.params;
  const session = getSyncSession(id);
  if (!session) {
    return new Response(JSON.stringify({ error: "Sync session yok" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  let closed = false;

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

      const hello = syncSessionHello(id);
      if (hello) send(hello);

      if (
        session.status === "done" ||
        session.status === "error" ||
        session.status === "canceled"
      ) {
        if (session.result) {
          send({ type: "result", result: session.result });
        }
        if (session.error) {
          send({ type: "error", error: session.error });
        }
        send({ type: "done", status: session.status });
        try {
          controller.close();
        } catch {
          /* ignore */
        }
        return;
      }

      const onEvent = (event: SyncSessionEvent) => {
        send(event);
        if (event.type === "done") {
          cleanup();
          try {
            controller.close();
          } catch {
            /* ignore */
          }
        }
      };

      const unsub = subscribeSyncSession(id, onEvent);

      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          closed = true;
        }
      }, 15000);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsub();
      };

      (controller as unknown as { _cleanup?: () => void })._cleanup = cleanup;
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
