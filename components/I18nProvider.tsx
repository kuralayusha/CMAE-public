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
import { APP_LANGUAGE, type LocalePack } from "@/lib/i18n/types";
import { tFromPacks, type TVars } from "@/lib/i18n/t";

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

export function I18nProvider({ children }: { children: ReactNode }) {
  const [code, setCode] = useState<string>(APP_LANGUAGE);
  const [pack, setPackState] = useState<LocalePack>({});
  const [en, setEn] = useState<LocalePack>({});
  const [ready, setReady] = useState(false);

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
    void reload();
  }, [reload]);

  const setPack = useCallback((nextCode: string, nextPack: LocalePack) => {
    setCode(nextCode);
    setPackState(nextPack);
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
