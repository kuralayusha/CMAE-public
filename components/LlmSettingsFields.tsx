"use client";

import { useEffect, useState } from "react";
import { useT } from "@/components/I18nProvider";
import { Field } from "@/components/ui";
import { DEFAULT_MODELS, type ModelSlot } from "@/lib/llm/slots";

type CatalogModel = {
  id: string;
  name: string;
  contextLength: number | null;
  promptPerM: number | null;
  completionPerM: number | null;
  free: boolean;
};

export type LlmFormValue = {
  openrouterApiKey: string;
  llmModelFast: string;
  llmModelSmart: string;
};

let catalogPromise: Promise<CatalogModel[]> | null = null;

/** One fetch per page load; a failure is not cached so the next mount retries. */
function loadCatalog(): Promise<CatalogModel[]> {
  catalogPromise ??= fetch("/api/llm/models")
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((d: { models?: CatalogModel[] }) => d.models ?? [])
    .catch((err) => {
      catalogPromise = null;
      throw err;
    });
  return catalogPromise;
}

const usd = (n: number | null) =>
  n == null ? "?" : `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;

const SLOTS: ModelSlot[] = ["fast", "smart"];
const FIELD: Record<ModelSlot, keyof LlmFormValue> = {
  fast: "llmModelFast",
  smart: "llmModelSmart",
};

/**
 * OpenRouter key + the two model slots. Shared by the onboarding wizard and
 * Settings; the parent owns the state and sends it to PUT /api/settings.
 * Model inputs are free text with a searchable catalog (<datalist>), so a
 * model missing from the catalog can still be typed in.
 */
export function LlmSettingsFields({
  value,
  onChange,
  hasKey,
  keyFromEnv,
}: {
  value: LlmFormValue;
  onChange: (next: LlmFormValue) => void;
  hasKey: boolean;
  keyFromEnv: boolean;
}) {
  const t = useT();
  const [catalog, setCatalog] = useState<CatalogModel[] | null>(null);
  const [catalogFailed, setCatalogFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    loadCatalog()
      .then((m) => alive && setCatalog(m))
      .catch(() => alive && setCatalogFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  const byId = new Map((catalog ?? []).map((m) => [m.id, m]));

  function modelNote(slot: ModelSlot): string {
    const id = value[FIELD[slot]].trim();
    if (!id) return t("fields.llmModelEmpty", { model: DEFAULT_MODELS[slot] });
    if (!catalog) return catalogFailed ? t("fields.llmCatalogFailed") : "";
    const m = byId.get(id);
    if (!m) return t("fields.llmModelUnknown");
    const price = t("fields.llmModelPrice", {
      prompt: usd(m.promptPerM),
      completion: usd(m.completionPerM),
    });
    return m.free ? `${price} · ${t("fields.llmModelFree")}` : price;
  }

  const keyHint = hasKey
    ? t("fields.openrouterKeySaved")
    : keyFromEnv
      ? t("fields.openrouterKeyFromEnv")
      : t("fields.openrouterKeyHint");

  return (
    <>
      <Field label={t("fields.openrouterApiKey")} hint={keyHint}>
        <input
          className="cmae-input"
          type="password"
          autoComplete="off"
          placeholder={hasKey ? "••••••••" : "sk-or-…"}
          value={value.openrouterApiKey}
          onChange={(e) => onChange({ ...value, openrouterApiKey: e.target.value })}
        />
      </Field>

      {SLOTS.map((slot) => (
        <Field
          key={slot}
          label={t(slot === "fast" ? "fields.llmModelFast" : "fields.llmModelSmart")}
          hint={`${t(
            slot === "fast" ? "fields.llmModelFastHint" : "fields.llmModelSmartHint",
          )}${modelNote(slot) ? ` — ${modelNote(slot)}` : ""}`}
        >
          <input
            className="cmae-input"
            type="text"
            list="cmae-llm-models"
            autoComplete="off"
            spellCheck={false}
            placeholder={DEFAULT_MODELS[slot]}
            value={value[FIELD[slot]]}
            onChange={(e) => onChange({ ...value, [FIELD[slot]]: e.target.value })}
          />
        </Field>
      ))}

      <datalist id="cmae-llm-models">
        {(catalog ?? []).map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </datalist>
    </>
  );
}
