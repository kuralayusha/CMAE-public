import "server-only";

import { createHash } from "node:crypto";
import fs from "node:fs";
import enFallback from "@/locales/en.json";
import {
  getEnPackPath,
  getLocaleMetaPath,
  getUserPackPath,
} from "./paths";
import { applyLocaleOverrides } from "./overrides";
import { countMissingLeaves, mergeShape } from "./shape";
import type { LocaleMeta, LocalePack } from "./types";
import { APP_LANGUAGE } from "./types";

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(/*turbopackIgnore: true*/ filePath)) return null;
    const raw = fs.readFileSync(/*turbopackIgnore: true*/ filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function loadEnPack(): LocalePack {
  const fromDisk = readJsonFile<LocalePack>(getEnPackPath());
  if (fromDisk && typeof fromDisk === "object") return fromDisk;
  // Bundled fallback — required on Vercel when file tracing misses locales/
  return enFallback as LocalePack;
}

/** Stable fingerprint of shipped English — used to invalidate stale user packs. */
export function hashEnPack(en?: LocalePack): string {
  const pack = en ?? loadEnPack();
  return createHash("sha256")
    .update(JSON.stringify(pack))
    .digest("hex")
    .slice(0, 24);
}

export function loadUserPack(): LocalePack | null {
  return readJsonFile<LocalePack>(getUserPackPath());
}

export function loadLocaleMeta(): LocaleMeta | null {
  return readJsonFile<LocaleMeta>(getLocaleMetaPath());
}

export function saveUserPack(code: string, pack: LocalePack): LocaleMeta {
  // Always align to shipped en.json so remote/stale catalogs cannot drop keys
  const merged = mergeShape(loadEnPack(), pack);
  const meta: LocaleMeta = {
    code: code.toLowerCase().slice(0, 16) || APP_LANGUAGE,
    updatedAt: new Date().toISOString(),
    enSourceHash: hashEnPack(),
  };
  fs.writeFileSync(
    /*turbopackIgnore: true*/ getUserPackPath(),
    `${JSON.stringify(merged, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    /*turbopackIgnore: true*/ getLocaleMetaPath(),
    `${JSON.stringify(meta, null, 2)}\n`,
    "utf8",
  );
  return meta;
}

export function clearUserPack(): void {
  for (const p of [getUserPackPath(), getLocaleMetaPath()]) {
    try {
      if (fs.existsSync(/*turbopackIgnore: true*/ p)) {
        fs.unlinkSync(/*turbopackIgnore: true*/ p);
      }
    } catch {
      /* ignore */
    }
  }
}

/** Active pack for UI: user pack if present, else English. */
export function loadActivePack(): { code: string; pack: LocalePack } {
  const meta = loadLocaleMeta();
  const user = loadUserPack();
  const en = loadEnPack();
  if (user && meta?.code) {
    const code = meta.code.toLowerCase();
    // English is the source pack. A saved user.json snapshot must not freeze
    // older English copy (placeholders like {count} would stay literal).
    if (code === APP_LANGUAGE || code.startsWith("en")) {
      return { code: APP_LANGUAGE, pack: en };
    }
    let pack = mergeShape(en, user);
    // en.json changed but no missing keys — stamp new hash without LLM.
    // Count on the raw user pack: `pack` is already English-filled, so it can
    // never look incomplete, and saving it would freeze new keys in English.
    const hash = hashEnPack(en);
    if (
      meta.enSourceHash !== hash &&
      countMissingLeaves(en, user) === 0
    ) {
      try {
        saveUserPack(meta.code, pack);
      } catch {
        /* ignore disk errors on read path */
      }
    }
    pack = applyLocaleOverrides(meta.code, pack);
    return { code: meta.code, pack };
  }
  if (user) {
    const code = meta?.code || APP_LANGUAGE;
    return {
      code,
      pack: applyLocaleOverrides(code, mergeShape(en, user)),
    };
  }
  return { code: APP_LANGUAGE, pack: en };
}

export { getNested, lookupString } from "./lookup";
