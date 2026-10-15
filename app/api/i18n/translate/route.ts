import { NextResponse } from "next/server";
import { loadEnPack, saveUserPack } from "@/lib/i18n/pack";
import {
  DEFAULT_I18N_REMOTE_BASE,
  getRemoteTranslateUrl,
  isVercelRuntime,
} from "@/lib/i18n/remote";
import { translateLocalePack } from "@/lib/i18n/translate";
import type { LocalePack } from "@/lib/i18n/types";
import { updateSettings } from "@/lib/settings/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** Locale pack translation can take a while (chunked LLM). */
export const maxDuration = 300;

function preferRemoteHost(): boolean {
  // On Vercel we are the translation host — run LLM here.
  if (isVercelRuntime()) return false;
  const raw = (
    process.env.CMAE_I18N_URL ||
    process.env.NEXT_PUBLIC_CMAE_I18N_URL ||
    DEFAULT_I18N_REMOTE_BASE
  ).trim();
  if (!raw || raw === "local" || raw === "0" || raw === "false") return false;
  return true;
}

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

    // Remote translation server (this deployment on Vercel)
    if (isVercelRuntime()) {
      const result = await translateLocalePack(targetLanguage, {
        persist: false,
      });
      return NextResponse.json({
        code: result.code,
        pack: result.pack,
        en: loadEnPack(),
        meta: result.meta,
        skippedLlm: result.skippedLlm,
        host: "vercel",
      });
    }

    // Local / desktop: call remote host, then persist pack locally
    if (preferRemoteHost()) {
      const remoteUrl = getRemoteTranslateUrl();
      const remoteRes = await fetch(remoteUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetLanguage }),
      });
      const remoteData = (await remoteRes.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
        pack?: LocalePack;
        en?: LocalePack;
        skippedLlm?: boolean;
        meta?: { code: string; updatedAt: string };
      };
      if (!remoteRes.ok) {
        return NextResponse.json(
          {
            error:
              remoteData.error ||
              `Remote translate failed (${remoteRes.status}) at ${remoteUrl}`,
          },
          { status: remoteRes.status >= 400 ? remoteRes.status : 502 },
        );
      }
      const code = String(remoteData.code || targetLanguage);
      const pack = remoteData.pack;
      if (!pack || typeof pack !== "object") {
        return NextResponse.json(
          { error: "Remote translate returned no pack" },
          { status: 502 },
        );
      }
      const meta = saveUserPack(code, pack);
      updateSettings({ preferredLanguage: code });
      return NextResponse.json({
        code,
        pack,
        en: remoteData.en || loadEnPack(),
        meta,
        skippedLlm: Boolean(remoteData.skippedLlm),
        host: remoteUrl,
      });
    }

    // Explicit local LLM translate (CMAE_I18N_URL=local)
    const result = await translateLocalePack(targetLanguage, {
      persist: true,
    });
    return NextResponse.json({
      code: result.code,
      pack: result.pack,
      en: loadEnPack(),
      meta: result.meta,
      skippedLlm: result.skippedLlm,
      host: "local",
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
