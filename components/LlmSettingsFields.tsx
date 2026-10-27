"use client";

import { useEffect, useState } from "react";
import { useT } from "@/components/I18nProvider";
import { ModelPicker } from "@/components/ModelPicker";
import {
  ActivityIcon,
  BoltIcon,
  BuildingIcon,
  CalendarIcon,
  CheckIcon,
  ClockIcon,
  EyeIcon,
  FilterIcon,
  GlobeIcon,
  KeyIcon,
  LinkIcon,
  MailIcon,
  PencilIcon,
  ResetIcon,
  SearchIcon,
  SendIcon,
  SlidersIcon,
  SparklesIcon,
  TargetIcon,
  WandIcon,
} from "@/components/icons";
import type { ReactElement } from "react";
import { PROVIDERS, recommendationFor, shortName } from "@/lib/llm/catalog";
import "./llm-picker.css";
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

const FEATURE_ICONS: Record<string, ReactElement> = {
  "research.scout": <GlobeIcon size={16} />,
  "research.research": <BuildingIcon size={16} />,
  "research.jobfit": <TargetIcon size={16} />,
  "research.discover": <LinkIcon size={16} />,
  "research.writer": <PencilIcon size={16} />,
  "research.reviewer": <EyeIcon size={16} />,
  "tracker.sync.triage": <FilterIcon size={16} />,
  "tracker.sync.identity": <BuildingIcon size={16} />,
  "tracker.sync.events": <CalendarIcon size={16} />,
  "tracker.signals": <ActivityIcon size={16} />,
  "tracker.match": <LinkIcon size={16} />,
  "tracker.timeline": <ClockIcon size={16} />,
  "tracker.followup": <SendIcon size={16} />,
};

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

  const keyOk = hasKey || keyFromEnv;
  const keyHint = hasKey
    ? t("fields.openrouterKeySaved")
    : keyFromEnv
      ? t("fields.openrouterKeyFromEnv")
      : t("fields.openrouterKeyHint");
  const slotLabel = (slot: ModelSlot) =>
    t(slot === "fast" ? "fields.llmModelFast" : "fields.llmModelSmart");
  const SlotIcon = ({ slot }: { slot: ModelSlot }) =>
    slot === "fast" ? <BoltIcon size={16} /> : <SparklesIcon size={16} />;
  const pinCount = Object.keys(value.llmOverrides).length;

  function toggleDetailed() {
    const next = !detailed;
    setDetailed(next);
    // Switching it off must not leave hidden pins that still apply.
    if (!next && pinCount) onChange({ ...value, llmOverrides: {} });
  }

  return (
    <div className="cmae-llm">
      <section className="cmae-llm-card">
        <div className="cmae-llm-card-head is-flat">
          <span className="cmae-llm-card-icon"><KeyIcon size={16} /></span>
          <div className="cmae-llm-card-copy">
            <h3 className="cmae-llm-card-title">{t("fields.openrouterApiKey")}</h3>
            <p className="cmae-llm-card-desc">{keyHint}</p>
          </div>
          {keyOk ? (
            <span className="cmae-llm-chip is-ok"><CheckIcon size={12} />{t("llm.keyReady")}</span>
          ) : null}
        </div>
        <div className="cmae-llm-card-body" style={{ paddingTop: 0 }}>
          <input
            className="cmae-input"
            type="password"
            autoComplete="off"
            aria-label={t("fields.openrouterApiKey")}
            placeholder={hasKey ? "••••••••" : "sk-or-…"}
            value={value.openrouterApiKey}
            onChange={(e) => onChange({ ...value, openrouterApiKey: e.target.value })}
          />
        </div>
      </section>

      <div className="cmae-llm-quick">
        <span className="cmae-llm-card-icon"><WandIcon size={16} /></span>
        <div className="cmae-llm-card-copy">
          <h3 className="cmae-llm-card-title">{t("llm.quickSetup")}</h3>
          <p className="cmae-llm-card-desc">{t("llm.quickSetupHint")}</p>
        </div>
        <select
          className="cmae-input"
          aria-label={t("llm.quickSetup")}
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
      </div>

      {(["fast", "smart"] as const).map((slot) => (
        <section key={slot} className="cmae-llm-card">
          <div className="cmae-llm-card-head">
            <span className="cmae-llm-card-icon"><SlotIcon slot={slot} /></span>
            <div className="cmae-llm-card-copy">
              <h3 className="cmae-llm-card-title">{slotLabel(slot)}</h3>
              <p className="cmae-llm-card-desc">
                {t(slot === "fast" ? "fields.llmModelFastHint" : "fields.llmModelSmartHint")}
              </p>
            </div>
          </div>
          <div className="cmae-llm-card-body">
            <ModelPicker
              catalog={catalog}
              slot={slot}
              value={slotChoice(slot)}
              onChange={(c) => setSlot(slot, c)}
            />
          </div>
        </section>
      ))}

      <section className="cmae-llm-card">
        <div className={`cmae-llm-card-head${detailed ? "" : " is-flat"}`}>
          <span className="cmae-llm-card-icon"><SlidersIcon size={16} /></span>
          <div className="cmae-llm-card-copy">
            <h3 className="cmae-llm-card-title">{t("llm.detailedMode")}</h3>
            <p className="cmae-llm-card-desc">{t("llm.detailedModeHint")}</p>
          </div>
          {pinCount ? (
            <span className="cmae-llm-chip">{t("llm.customCount", { count: pinCount })}</span>
          ) : null}
          <button
            type="button"
            role="switch"
            aria-checked={detailed}
            aria-label={t("llm.detailedMode")}
            className="cmae-switch"
            onClick={toggleDetailed}
          />
        </div>

        {detailed ? (
          <div className="cmae-llm-card-body">
            {(["research", "tracker"] as const).map((group) => (
              <div key={group}>
                <h4 className="cmae-llm-group-title">
                  {group === "research" ? <SearchIcon size={14} /> : <MailIcon size={14} />}
                  {t(`llm.groups.${group}`)}
                </h4>
                <div className="cmae-llm-features">
                  {TUNABLE_FEATURES.filter((f) => f.group === group).map(({ feature }) => {
                    const pin = value.llmOverrides[feature];
                    const slot = slotForFeature(feature);
                    const key = featureKey(feature);
                    return (
                      <div
                        key={feature}
                        className={`cmae-llm-feature${pin ? " is-pinned" : ""}`}
                      >
                        <div className="cmae-llm-feature-head">
                          <span className="cmae-llm-feature-icon">{FEATURE_ICONS[feature]}</span>
                          <div className="cmae-llm-feature-copy">
                            <div className="cmae-llm-feature-name">{t(`llm.features.${key}`)}</div>
                            <p className="cmae-llm-card-desc">{t(`llm.features.${key}Hint`)}</p>
                          </div>
                          <div className="cmae-llm-feature-actions">
                            {pin ? (
                              <>
                                <span className="cmae-llm-chip is-ok">{t("llm.customBadge")}</span>
                                <button
                                  type="button"
                                  className="cmae-btn cmae-btn-ghost cmae-llm-btn"
                                  onClick={() => setOverride(feature, null)}
                                >
                                  <ResetIcon size={12} />
                                  {t("llm.followSlot")}
                                </button>
                              </>
                            ) : (
                              <>
                                <span className="cmae-llm-chip" title={slotLabel(slot)}>
                                  <SlotIcon slot={slot} />
                                  <b>{nameOf(slotChoice(slot).model)}</b>
                                </span>
                                <button
                                  type="button"
                                  className="cmae-btn cmae-btn-ghost cmae-llm-btn"
                                  onClick={() => setOverride(feature, slotChoice(slot))}
                                >
                                  <PencilIcon size={12} />
                                  {t("llm.customize")}
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                        {pin ? (
                          <ModelPicker
                            catalog={catalog}
                            slot={slot}
                            value={pin}
                            onChange={(c) => setOverride(feature, c)}
                          />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}
