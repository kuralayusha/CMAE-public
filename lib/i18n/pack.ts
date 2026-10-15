import "server-only";

import fs from "node:fs";
import {
  getEnPackPath,
  getLocaleMetaPath,
  getUserPackPath,
} from "./paths";
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
  const pack = readJsonFile<LocalePack>(getEnPackPath());
  if (!pack || typeof pack !== "object") {
    throw new Error("English locale pack (locales/en.json) is missing or invalid");
  }
  return pack;
}

export function loadUserPack(): LocalePack | null {
  return readJsonFile<LocalePack>(getUserPackPath());
}

export function loadLocaleMeta(): LocaleMeta | null {
  return readJsonFile<LocaleMeta>(getLocaleMetaPath());
}

export function saveUserPack(code: string, pack: LocalePack): LocaleMeta {
  const meta: LocaleMeta = {
    code: code.toLowerCase().slice(0, 16) || APP_LANGUAGE,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    /*turbopackIgnore: true*/ getUserPackPath(),
    `${JSON.stringify(pack, null, 2)}\n`,
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
  if (user && meta?.code) {
    return { code: meta.code, pack: user };
  }
  if (user) {
    return { code: meta?.code || APP_LANGUAGE, pack: user };
  }
  return { code: APP_LANGUAGE, pack: loadEnPack() };
}

export { getNested, lookupString } from "./lookup";
