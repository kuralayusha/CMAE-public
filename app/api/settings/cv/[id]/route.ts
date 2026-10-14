import { NextResponse } from "next/server";
import {
  deleteCv,
  getCvEntries,
  listCvs,
  updateCvMeta,
} from "@/lib/cv/library";
import { updateSettings } from "@/lib/settings/service";

export const runtime = "nodejs";

function syncLegacyDefault() {
  const def = getCvEntries().find((e) => e.isDefault) || getCvEntries()[0];
  if (def?.text) {
    updateSettings({ cvText: def.text, cvFileName: def.fileName });
  } else {
    updateSettings({ cvText: "", cvFileName: "" });
  }
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as {
      label?: string;
      language?: string;
      tags?: string[];
      isDefault?: boolean;
    };
    const entry = updateCvMeta(id, {
      label: body.label,
      language: body.language,
      tags: body.tags,
      isDefault: body.isDefault,
    });
    if (body.isDefault === true || entry.isDefault) {
      syncLegacyDefault();
    }
    return NextResponse.json({ entry, cvs: listCvs() });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    deleteCv(id);
    syncLegacyDefault();
    return NextResponse.json({ ok: true, cvs: listCvs() });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
