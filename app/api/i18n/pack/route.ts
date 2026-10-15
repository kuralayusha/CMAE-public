import { NextResponse } from "next/server";
import { loadActivePack, loadEnPack } from "@/lib/i18n/pack";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const en = loadEnPack();
    try {
      const active = loadActivePack();
      return NextResponse.json({
        code: active.code,
        pack: active.pack,
        en,
      });
    } catch {
      // Ephemeral hosts (Vercel) may have no user pack yet
      return NextResponse.json({
        code: "en",
        pack: en,
        en,
      });
    }
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
