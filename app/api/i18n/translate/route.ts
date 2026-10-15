import { NextResponse } from "next/server";
import { loadEnPack } from "@/lib/i18n/pack";
import { translateLocalePack } from "@/lib/i18n/translate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** Locale pack translation can take a while (chunked LLM). */
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      targetLanguage?: string;
    };
    const targetLanguage = String(body.targetLanguage || "").trim();
    if (!targetLanguage) {
      return NextResponse.json(
        { error: "targetLanguage is required" },
        { status: 400 },
      );
    }

    const result = await translateLocalePack(targetLanguage);
    return NextResponse.json({
      code: result.code,
      pack: result.pack,
      en: loadEnPack(),
      meta: result.meta,
      skippedLlm: result.skippedLlm,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
