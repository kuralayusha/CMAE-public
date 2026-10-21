import { createHash } from "node:crypto";
import type { AiFeature } from "./features";

/** CRLF → LF, strip trailing whitespace per line, trim. Content is untouched otherwise. */
export function normalizePrompt(prompt: string): string {
  return prompt
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
}

/** key = sha256(model | feature | prompt_version | normalized prompt) */
export function cacheKey(input: {
  model: string;
  feature: AiFeature;
  promptVersion?: string | number;
  prompt: string;
}): string {
  return createHash("sha256")
    .update(
      [
        input.model,
        input.feature,
        String(input.promptVersion ?? "0"),
        normalizePrompt(input.prompt),
      ].join("|"),
    )
    .digest("hex");
}
