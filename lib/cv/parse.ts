import fs from "fs";
import { createRequire } from "module";
import path from "path";
import { pathToFileURL } from "url";

/** Resolve modules from the running server cwd (standalone or project root). */
const requireFromCwd = createRequire(path.join(process.cwd(), "package.json"));

type PdfParseModule = typeof import("pdf-parse");

/**
 * Lazy-load pdf-parse so pages that only list CVs (onboarding / tracker layout)
 * do not pull pdfjs + @napi-rs/canvas at request time.
 */
async function loadPdfParse(): Promise<PdfParseModule> {
  // pdfjs polyfills DOMMatrix via @napi-rs/canvas when available
  try {
    await import("@napi-rs/canvas");
  } catch {
    /* optional at runtime; prepare-desktop should ship it for packaged apps */
  }
  return import("pdf-parse");
}

/**
 * pdfjs worker path for Node ESM.
 * Windows absolute paths like C:\... are parsed as protocol "c:" — must be file:// URLs.
 */
function workerUrl(absPath: string): string {
  return pathToFileURL(path.resolve(absPath)).href;
}

/** Point pdf.js at a real worker file (standalone NFT often drops pdf.worker.mjs). */
function ensurePdfWorker(PDFParse: PdfParseModule["PDFParse"]) {
  // Prefer cwd-local package first so a parent project node_modules cannot steal resolve.
  const candidates = [
    path.join(
      process.cwd(),
      "node_modules",
      "pdfjs-dist",
      "legacy",
      "build",
      "pdf.worker.mjs",
    ),
    path.join(
      process.cwd(),
      "node_modules",
      "pdfjs-dist",
      "legacy",
      "build",
      "pdf.worker.min.mjs",
    ),
  ];
  try {
    candidates.push(
      requireFromCwd.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"),
    );
  } catch {
    /* ignore */
  }

  for (const worker of candidates) {
    if (fs.existsSync(/*turbopackIgnore: true*/ worker)) {
      PDFParse.setWorker(workerUrl(worker));
      return;
    }
  }
}

export async function parseCvPdf(buffer: Buffer): Promise<{ text: string }> {
  const { PDFParse } = await loadPdfParse();
  ensurePdfWorker(PDFParse);
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    const text = (result.text || "")
      .replace(/\r/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!text) {
      throw new Error("Could not extract text from PDF");
    }
    return { text };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}
