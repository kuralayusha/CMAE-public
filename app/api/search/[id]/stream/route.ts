import { requireOnboardedResponse } from "@/lib/onboarding/http";
import { getJob, getJobBus } from "@/lib/search/events";
import type { JobEvent } from "@/lib/search/types";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const blocked = requireOnboardedResponse();
  if (blocked) return blocked;
  const { id } = await ctx.params;
  const job = getJob(id);
  if (!job) {
    return new Response(JSON.stringify({ error: "Job not found" }), {
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
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      // snapshot
      send({
        type: "hello",
        job: {
          id: job.id,
          url: job.url,
          status: job.status,
          folderName: job.folderName,
          companyName: job.companyName,
          error: job.error,
        },
      });
      for (const line of job.lines) {
        send({ type: "line", line });
      }
      if (job.status === "done" || job.status === "error") {
        send({ type: "done", status: job.status });
      }

      const onEvent = (event: JobEvent) => {
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

      const bus = getJobBus();
      const channel = `job:${id}`;
      bus.on(channel, onEvent);

      const heartbeat = setInterval(() => {
        if (closed) return;
        controller.enqueue(encoder.encode(`: ping\n\n`));
      }, 15000);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        bus.off(channel, onEvent);
      };

      // if already finished after snapshot
      if (job.status === "done" || job.status === "error") {
        cleanup();
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      }

      // store cleanup on cancel via cancel()
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
    },
  });
}
