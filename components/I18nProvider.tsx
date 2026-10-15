"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { localeUpper } from "@/lib/i18n/case";
import { tFromPacks, type TVars } from "@/lib/i18n/lookup";
import { APP_LANGUAGE, type LocalePack } from "@/lib/i18n/types";

type I18nContextValue = {
  code: string;
  ready: boolean;
  t: (key: string, vars?: TVars) => string;
  setPack: (code: string, pack: LocalePack) => void;
  reload: () => Promise<void>;
};

const I18nContext = createContext<I18nContextValue | null>(null);

type PackResponse = {
  code: string;
  pack: LocalePack;
  en: LocalePack;
};

type Props = {
  children: ReactNode;
  /** SSR seed — avoids key flash on first paint / refresh */
  initialCode?: string;
  initialPack?: LocalePack;
  initialEn?: LocalePack;
};

export function I18nProvider({
  children,
  initialCode = APP_LANGUAGE,
  initialPack = {},
  initialEn = {},
}: Props) {
  const hasSeed = Object.keys(initialEn).length > 0;
  const [code, setCode] = useState<string>(initialCode || APP_LANGUAGE);
  const [pack, setPackState] = useState<LocalePack>(
    Object.keys(initialPack).length ? initialPack : initialEn,
  );
  const [en, setEn] = useState<LocalePack>(initialEn);
  const [ready, setReady] = useState(hasSeed);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/i18n/pack");
      if (!res.ok) return;
      const data = (await res.json()) as PackResponse;
      setCode(data.code || APP_LANGUAGE);
      setPackState(data.pack || {});
      setEn(data.en || {});
    } catch {
      /* keep previous */
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    // Background refresh only — seed already painted the correct language
    void reload();
  }, [reload]);

  // Keep <html lang> in sync so CSS / a11y / locale casing (TR İ/I) stay correct
  // after client-side language changes (no full reload).
  useEffect(() => {
    const lang = (code || APP_LANGUAGE).trim().slice(0, 2).toLowerCase() || "en";
    document.documentElement.lang = lang;
  }, [code]);

  const setPack = useCallback((nextCode: string, nextPack: LocalePack) => {
    setCode(nextCode);
    setPackState(nextPack);
    setReady(true);
  }, []);

  const value = useMemo<I18nContextValue>(
    () => ({
      code,
      ready,
      t: (key, vars) => tFromPacks(key, pack, en, vars),
      setPack,
      reload,
    }),
    [code, ready, pack, en, setPack, reload],
  );

  return (
    <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    return {
      code: APP_LANGUAGE,
      ready: true,
      t: (key) => key,
      setPack: () => undefined,
      reload: async () => undefined,
    };
  }
  return ctx;
}

export function useT() {
  return useI18n().t;
}

/** Uppercase for UI chrome (labels, badges) using the active locale. */
export function useLocaleUpper() {
  const { code } = useI18n();
  return useCallback((text: string) => localeUpper(text, code), [code]);
}
