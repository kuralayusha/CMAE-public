"use client";

import { useEffect, useState } from "react";
import { useT } from "@/components/I18nProvider";
import { ModelPicker } from "@/components/ModelPicker";
import { Field } from "@/components/ui";
import { PROVIDERS, recommendationFor, shortName } from "@/lib/llm/catalog";
import type { OpenRouterModel } from "@/lib/llm/openrouter";
import {
  DEFAULT_MODELS,
  TUNABLE_FEATURES,
  slotForFeature,
  type Effort,
  type LlmChoice,
  type LlmOverrides,
  type ModelSlot,
} from "@/lib/llm/slots";

export type LlmFormValue = {
  openrouterApiKey: string;
  llmModelFast: string;
  llmModelSmart: string;
  llmEffortFast: Effort | "";
  llmEffortSmart: Effort | "";
  /** Detailed mode: features pinned to their own model; absent = follows the slot. */
  llmOverrides: LlmOverrides;
};

/** Initial form state before settings load (the built-in models, no pins). */
export const LLM_FORM_DEFAULTS: Omit<LlmFormValue, "openrouterApiKey"> = {
  llmModelFast: DEFAULT_MODELS.fast,
  llmModelSmart: DEFAULT_MODELS.smart,
  llmEffortFast: "",
  llmEffortSmart: "",
  llmOverrides: {},
};

/** Pick the LLM fields out of a GET/PUT /api/settings response. */
export function llmFormFromSettings(s: {
  llmModelFast?: string;
  llmModelSmart?: string;
  llmEffortFast?: Effort | "";
  llmEffortSmart?: Effort | "";
  llmOverrides?: LlmOverrides;
}): Omit<LlmFormValue, "openrouterApiKey"> {
  return {
    llmModelFast: s.llmModelFast || DEFAULT_MODELS.fast,
    llmModelSmart: s.llmModelSmart || DEFAULT_MODELS.smart,
    llmEffortFast: s.llmEffortFast ?? "",
    llmEffortSmart: s.llmEffortSmart ?? "",
    llmOverrides: s.llmOverrides ?? {},
  };
}

let catalogPromise: Promise<OpenRouterModel[]> | null = null;

/** One fetch per page load; a failure is not cached so the next mount retries. */
function loadCatalog(): Promise<OpenRouterModel[]> {
  catalogPromise ??= fetch("/api/llm/models")
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((d: { models?: OpenRouterModel[] }) => d.models ?? [])
    .catch((err) => {
      catalogPromise = null;
      throw err;
    });
  return catalogPromise;
}

/** "research.writer" → "researchWriter" (i18n key under llm.features). */
const featureKey = (f: string) => f.replace(/\.(\w)/g, (_, c: string) => c.toUpperCase());

/**
 * OpenRouter key + the two model slots (+ optional per-feature "detailed
 * mode"). Shared by the onboarding wizard and Settings; the parent owns the
 * state and sends it to PUT /api/settings.
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
  const [catalog, setCatalog] = useState<OpenRouterModel[] | null>(null);
  const [detailed, setDetailed] = useState(Object.keys(value.llmOverrides).length > 0);

  useEffect(() => {
    let alive = true;
    loadCatalog()
      .then((m) => alive && setCatalog(m))
      .catch(() => {
        /* picker degrades to a plain slug field */
      });
    return () => {
      alive = false;
    };
  }, []);

  const slotChoice = (slot: ModelSlot): LlmChoice =>
    slot === "fast"
      ? { model: value.llmModelFast, effort: value.llmEffortFast }
      : { model: value.llmModelSmart, effort: value.llmEffortSmart };

  const setSlot = (slot: ModelSlot, c: LlmChoice) =>
    onChange(
      slot === "fast"
        ? { ...value, llmModelFast: c.model, llmEffortFast: c.effort }
        : { ...value, llmModelSmart: c.model, llmEffortSmart: c.effort },
    );

  function quickSetup(providerId: string) {
    const fast = recommendationFor(providerId, "fast", catalog);
    const smart = recommendationFor(providerId, "smart", catalog);
    if (!fast || !smart) return;
    onChange({
      ...value,
      llmModelFast: fast.model,
      llmEffortFast: fast.effort,
      llmModelSmart: smart.model,
      llmEffortSmart: smart.effort,
    });
  }

  function setOverride(feature: (typeof TUNABLE_FEATURES)[number]["feature"], c: LlmChoice | null) {
    const next = { ...value.llmOverrides };
    if (c) next[feature] = c;
    else delete next[feature];
    onChange({ ...value, llmOverrides: next });
  }

  const nameOf = (id: string) => {
    const m = catalog?.find((x) => x.id === id);
    return m ? shortName(m.name) : id;
  };

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

      <Field label={t("llm.quickSetup")} hint={t("llm.quickSetupHint")}>
        <select
          className="cmae-input"
          value=""
          disabled={!catalog}
          onChange={(e) => e.target.value && quickSetup(e.target.value)}
        >
          <option value="">{t("llm.quickSetupPick")}</option>
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>

      {(["fast", "smart"] as const).map((slot) => (
        <div key={slot} className="cmae-llm-block">
          <div>
            <span className="cmae-field-label">
              {t(slot === "fast" ? "fields.llmModelFast" : "fields.llmModelSmart")}
            </span>
            <p className="cmae-field-hint">
              {t(slot === "fast" ? "fields.llmModelFastHint" : "fields.llmModelSmartHint")}
            </p>
          </div>
          <ModelPicker
            catalog={catalog}
            slot={slot}
            value={slotChoice(slot)}
            onChange={(c) => setSlot(slot, c)}
          />
        </div>
      ))}

      <div className="cmae-llm-block">
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={detailed}
            onChange={(e) => {
              setDetailed(e.target.checked);
              // Switching it off must not leave hidden pins that still apply.
              if (!e.target.checked && Object.keys(value.llmOverrides).length) {
                onChange({ ...value, llmOverrides: {} });
              }
            }}
          />
          <span className="cmae-field-label">{t("llm.detailedMode")}</span>
        </label>
        <p className="cmae-field-hint">{t("llm.detailedModeHint")}</p>

        {detailed
          ? (["research", "tracker"] as const).map((group) => (
              <div key={group}>
                <span className="cmae-field-label">{t(`llm.groups.${group}`)}</span>
                {TUNABLE_FEATURES.filter((f) => f.group === group).map(({ feature }) => {
                  const pin = value.llmOverrides[feature];
                  const slot = slotForFeature(feature);
                  const slotModel = slotChoice(slot).model;
                  return (
                    <div key={feature} className="cmae-llm-feature">
                      <div className="cmae-llm-feature-head">
                        <div>
                          <strong>{t(`llm.features.${featureKey(feature)}`)}</strong>
                          <p className="cmae-field-hint">
                            {t(`llm.features.${featureKey(feature)}Hint`)}
                          </p>
                        </div>
                        {pin ? (
                          <button
                            type="button"
                            className="cmae-btn cmae-btn-ghost"
                            onClick={() => setOverride(feature, null)}
                          >
                            {t("llm.followSlot")}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="cmae-btn cmae-btn-ghost"
                            onClick={() => setOverride(feature, slotChoice(slot))}
                          >
                            {t("llm.customize")}
                          </button>
                        )}
                      </div>
                      {pin ? (
                        <ModelPicker
                          catalog={catalog}
                          slot={slot}
                          value={pin}
                          onChange={(c) => setOverride(feature, c)}
                        />
                      ) : (
                        <p className="cmae-field-hint">
                          {t("llm.followsSlot", {
                            slot: t(
                              slot === "fast" ? "fields.llmModelFast" : "fields.llmModelSmart",
                            ),
                            model: nameOf(slotModel),
                          })}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          : null}
      </div>
    </>
  );
}
