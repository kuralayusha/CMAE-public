import { NextResponse } from "next/server";
import {
  addCvFromBuffer,
  getCvsDirPath,
  listCvs,
  MAX_CV_COUNT,
} from "@/lib/cv/library";
import { updateSettings } from "@/lib/settings/service";

export const runtime = "nodejs";

/** List CV library (workspace/cvs). */
export async function GET() {
  try {
    const cvs = listCvs();
    return NextResponse.json({
      cvs,
      max: MAX_CV_COUNT,
      dir: getCvsDirPath(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** Upload a PDF into the multi-CV library (+ keep legacy settings.cvText in sync with default). */
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "PDF file required" }, { status: 400 });
    }
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      return NextResponse.json(
        { error: "Only PDF files are accepted" },
        { status: 400 },
      );
    }

    const language = String(form.get("language") || "en");
    const label = String(form.get("label") || "").trim() || undefined;
    const tagsRaw = String(form.get("tags") || "");
    const tags = tagsRaw
      .split(/[,;]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    const isDefault = String(form.get("isDefault") || "") === "1";

    const buffer = Buffer.from(await file.arrayBuffer());
    const entry = await addCvFromBuffer(buffer, file.name, {
      label,
      language,
      tags,
      isDefault,
    });

    // Legacy single-CV fields: seed from this upload when default / first
    if (entry.isDefault || entry.hasText) {
      const { getCvEntries } = await import("@/lib/cv/library");
      const def =
        getCvEntries().find((e) => e.isDefault) || getCvEntries()[0];
      if (def?.text) {
        updateSettings({
          cvText: def.text,
          cvFileName: def.fileName,
        });
      }
    }

    return NextResponse.json({
      entry,
      cvs: listCvs(),
      max: MAX_CV_COUNT,
      dir: getCvsDirPath(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
