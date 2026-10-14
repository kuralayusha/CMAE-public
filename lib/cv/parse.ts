import { PDFParse } from "pdf-parse";

export async function parseCvPdf(buffer: Buffer): Promise<{ text: string }> {
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
