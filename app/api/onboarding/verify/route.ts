import { NextResponse } from "next/server";
import {
  verifyOpenRouter,
  verifyGmailImap,
} from "@/lib/onboarding/verify";

export const runtime = "nodejs";
export const maxDuration = 120;

type Check = "gmail" | "ai" | "all";

/** Live-check Gmail IMAP and/or OpenRouter key + models. */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { check?: string };
    const check = (body.check || "all") as Check;

    if (check === "gmail") {
      const gmail = await verifyGmailImap();
      return NextResponse.json(
        { check: "gmail", gmail, ok: gmail.ok },
        { status: gmail.ok ? 200 : 422 },
      );
    }

    if (check === "ai") {
      const ai = await verifyOpenRouter();
      return NextResponse.json(
        { check: "ai", ai, ok: ai.ok },
        { status: ai.ok ? 200 : 422 },
      );
    }

    const gmail = await verifyGmailImap();
    if (!gmail.ok) {
      return NextResponse.json(
        {
          check: "all",
          gmail,
          cursor: { ok: false },
          ok: false,
          failStep: "gmail",
        },
        { status: 422 },
      );
    }
    const ai = await verifyOpenRouter();
    return NextResponse.json(
      {
        check: "all",
        gmail,
        ai,
        ok: ai.ok,
        failStep: ai.ok ? undefined : "ai",
      },
      { status: ai.ok ? 200 : 422 },
    );
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
