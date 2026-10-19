import { NextResponse } from "next/server";
import { loadEnPack, saveUserPack } from "@/lib/i18n/pack";
import { getRemoteTranslateUrl, isVercelRuntime } from "@/lib/i18n/remote";
import { countMissingLeaves, mergeShape } from "@/lib/i18n/shape";
import { translateLocalePack } from "@/lib/i18n/translate";
import type { LocalePack } from "@/lib/i18n/types";
import { updateSettings } from "@/lib/settings/service";

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

    // Vercel = translation host (key lives here only)
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

    // Desktop / local Next: proxy to remote host, then save pack on this device
    const remoteUrl = getRemoteTranslateUrl();
    if (remoteUrl) {
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
      const localEn = loadEnPack();
      // Remote catalog can lag behind this build's en.json. Prefer a local
      // full translate so new keys are not left as English forever.
      if (countMissingLeaves(localEn, pack) > 0) {
        try {
          const local = await translateLocalePack(targetLanguage, {
            persist: true,
          });
          return NextResponse.json({
            code: local.code,
            pack: local.pack,
            en: localEn,
            meta: local.meta,
            skippedLlm: local.skippedLlm,
            host: "local-after-stale-remote",
            remoteGaps: countMissingLeaves(localEn, pack),
          });
        } catch {
          /* fall through — save merged pack with English fills */
        }
      }
      const merged = mergeShape(localEn, pack);
      const meta = saveUserPack(code, merged);
      updateSettings({ preferredLanguage: code });
      return NextResponse.json({
        code,
        pack: merged,
        en: localEn,
        meta,
        skippedLlm: Boolean(remoteData.skippedLlm),
        host: remoteUrl,
      });
    }

    // Opt-out: CMAE_I18N_URL=local → translate with this machine's key
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
