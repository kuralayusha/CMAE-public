import { NextResponse } from "next/server";
import { loadActivePack, loadEnPack } from "@/lib/i18n/pack";
import { needsLocaleTranslation } from "@/lib/i18n/translate";

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
        needsTranslation: needsLocaleTranslation(active.code),
      });
    } catch {
      // Ephemeral hosts (Vercel) may have no user pack yet
      return NextResponse.json({
        code: "en",
        pack: en,
        en,
        needsTranslation: false,
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
