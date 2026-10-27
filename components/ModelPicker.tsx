"use client";

import { useState } from "react";
import { useT } from "@/components/I18nProvider";
import {
  BuildingIcon,
  CheckIcon,
  CoinsIcon,
  GaugeIcon,
  LayersIcon,
  SparklesIcon,
  TagIcon,
  WandIcon,
} from "@/components/icons";
import {
  OLDER_FAMILY_KEY,
  PROVIDERS,
  effortFor,
  familiesFor,
  familyOfModel,
  providerOf,
  recommendationFor,
  shortName,
} from "@/lib/llm/catalog";
import type { OpenRouterModel } from "@/lib/llm/openrouter";
import {
  DEFAULT_MODELS,
  EFFORTS,
  isEffort,
  type Effort,
  type LlmChoice,
  type ModelSlot,
} from "@/lib/llm/slots";
import "./llm-picker.css";

const CUSTOM = "__custom";

const usd = (n: number | null) =>
  n == null ? "?" : `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;

/** Compact "$in / $out" used inside the version dropdown. */
export const priceLabel = (m: OpenRouterModel) =>
  `${usd(m.promptPerM)} / ${usd(m.completionPerM)}`;

/** Efforts in a stable low → high order, whatever order the catalog lists. */
function orderedEfforts(m: OpenRouterModel): Effort[] {
  return EFFORTS.filter((e) => m.efforts?.includes(e));
}

/**
 * Two-stage model picker: company → model line (e.g. Opus / Sonnet) → exact
 * version → thinking effort (only when the model has one). Picking a company
 * or line always lands on a complete, valid model, never an empty state.
 * Without a catalog (offline) or for any other company it degrades to a plain
 * OpenRouter slug field. A summary row shows price and whether this is our
 * recommendation.
 */
export function ModelPicker({
  catalog,
  value,
  onChange,
  slot,
}: {
  catalog: OpenRouterModel[] | null;
  value: LlmChoice;
  onChange: (next: LlmChoice) => void;
  /** Which slot this picks for — drives the recommendation. Omit for "smart". */
  slot?: ModelSlot;
}) {
  const t = useT();
  const [forceCustom, setForceCustom] = useState(false);
  const recSlot: ModelSlot = slot ?? "smart";
  const model = value.model.trim() || (slot ? DEFAULT_MODELS[slot] : "");
  const known = catalog?.find((m) => m.id === model);
  const custom = forceCustom || !catalog || (Boolean(model) && !known);
  const provider = providerOf(model);
  const providerId = custom ? CUSTOM : (provider?.id ?? PROVIDERS[0]!.id);
  const families = catalog && !custom ? familiesFor(providerId, catalog) : [];
  const family = catalog && known ? familyOfModel(model, catalog) : null;
  const rec = !custom ? recommendationFor(providerId, recSlot, catalog) : null;
  const recModel = rec ? catalog?.find((m) => m.id === rec.model) : undefined;
  const isRec = Boolean(rec && rec.model === model && rec.effort === value.effort);

  const pick = (m: OpenRouterModel) =>
    onChange({ model: m.id, effort: effortFor(m, value.effort) });

  function onProvider(id: string) {
    if (id === CUSTOM) {
      setForceCustom(true);
      return;
    }
    setForceCustom(false);
    const r = recommendationFor(id, recSlot, catalog);
    if (r) return onChange({ model: r.model, effort: r.effort });
    const first = catalog ? familiesFor(id, catalog)[0]?.models[0] : undefined;
    if (first) onChange({ model: first.id, effort: "" });
  }

  const effortOptions: Effort[] = custom ? [...EFFORTS] : known ? orderedEfforts(known) : [];

  return (
    <div className="cmae-llm-picker">
      <div className="cmae-llm-grid">
        <label className="cmae-llm-sub">
          <span className="cmae-llm-sublabel">
            <BuildingIcon size={12} />
            {t("llm.provider")}
          </span>
          <select
            className="cmae-input"
            value={providerId}
            onChange={(e) => onProvider(e.target.value)}
          >
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            <option value={CUSTOM}>{t("llm.providerOther")}</option>
          </select>
        </label>

        {custom ? (
          <label className="cmae-llm-sub">
            <span className="cmae-llm-sublabel">
              <TagIcon size={12} />
              {t("llm.customModel")}
            </span>
            <input
              className="cmae-input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="vendor/model-name"
              value={value.model}
              onChange={(e) => onChange({ model: e.target.value, effort: value.effort })}
            />
          </label>
        ) : (
          <label className="cmae-llm-sub">
            <span className="cmae-llm-sublabel">
              <LayersIcon size={12} />
              {t("llm.family")}
            </span>
            <select
              className="cmae-input"
              value={family?.key ?? ""}
              onChange={(e) => {
                const f = families.find((x) => x.key === e.target.value);
                if (f?.models[0]) pick(f.models[0]);
              }}
            >
              {families.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.key === OLDER_FAMILY_KEY ? t("llm.olderModels") : f.label}
                </option>
              ))}
            </select>
          </label>
        )}

        {!custom && family ? (
          <label className="cmae-llm-sub">
            <span className="cmae-llm-sublabel">
              <TagIcon size={12} />
              {t("llm.model")}
            </span>
            <select
              className="cmae-input"
              value={model}
              onChange={(e) => {
                const m = family.models.find((x) => x.id === e.target.value);
                if (m) pick(m);
              }}
            >
              {family.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {shortName(m.name)} — {priceLabel(m)}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {effortOptions.length > 0 ? (
          <label className="cmae-llm-sub">
            <span className="cmae-llm-sublabel">
              <GaugeIcon size={12} />
              {t("llm.effort")}
            </span>
            <select
              className="cmae-input"
              value={value.effort}
              onChange={(e) =>
                onChange({ model, effort: isEffort(e.target.value) ? e.target.value : "" })
              }
            >
              <option value="">{t("llm.effortDefault")}</option>
              {effortOptions.map((e) => (
                <option key={e} value={e}>
                  {t(`llm.efforts.${e}`)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {custom ? (
        <p className="cmae-llm-note">
          {catalog ? t("llm.customHint") : t("llm.catalogUnavailable")}
        </p>
      ) : known ? (
        <div className="cmae-llm-summary">
          <span className="cmae-llm-chip">
            <CoinsIcon size={12} />
            {t("llm.priceChip", {
              input: usd(known.promptPerM),
              output: usd(known.completionPerM),
            })}
          </span>
          {known.reasoningMandatory ? (
            <span className="cmae-llm-chip">
              <SparklesIcon size={12} />
              {t("llm.alwaysThinks")}
            </span>
          ) : null}
          {isRec ? (
            <span className="cmae-llm-chip is-ok cmae-llm-summary-end">
              <CheckIcon size={12} />
              {t("llm.recommendedBadge")}
            </span>
          ) : rec && recModel ? (
            <button
              type="button"
              className="cmae-btn cmae-btn-ghost cmae-llm-btn cmae-llm-summary-end"
              title={t("llm.recommended", {
                model: shortName(recModel.name),
                effort: rec.effort ? ` · ${t(`llm.efforts.${rec.effort}`)}` : "",
              })}
              onClick={() => onChange({ model: rec.model, effort: rec.effort })}
            >
              <WandIcon size={12} />
              {t("llm.useRecommended")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
