import "server-only";

import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "@/lib/paths";

/** Shipped English source pack (repo / standalone bundle). */
export function getEnPackPath(): string {
  const cwd = process.cwd();
  const candidates = [
    path.join(/*turbopackIgnore: true*/ cwd, "locales", "en.json"),
    path.join(/*turbopackIgnore: true*/ cwd, "..", "locales", "en.json"),
    // Next standalone on Vercel
    path.join(
      /*turbopackIgnore: true*/ cwd,
      ".next",
      "standalone",
      "locales",
      "en.json",
    ),
    path.join(
      /*turbopackIgnore: true*/ cwd,
      "..",
      "..",
      "locales",
      "en.json",
    ),
  ];
  for (const p of candidates) {
    if (fs.existsSync(/*turbopackIgnore: true*/ p)) return p;
  }
  return candidates[0]!;
}

export function getLocalesDir(): string {
  const dir = path.join(/*turbopackIgnore: true*/ getDataDir(), "locales");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getUserPackPath(): string {
  return path.join(/*turbopackIgnore: true*/ getLocalesDir(), "user.json");
}

export function getLocaleMetaPath(): string {
  return path.join(/*turbopackIgnore: true*/ getLocalesDir(), "meta.json");
}
