/**
 * Light Level: a ckl-roll-bonuses conditional target. DESIGN.md §13.
 *
 * Matches when the light a token stands in (god's eye, brightest occupied square) compares to a
 * chosen tier.
 * Conditional targets are evaluated at roll time, so no invalidation is needed when tokens move.
 */

import { brightnessOf } from "./api.mjs";
import { TIER } from "./model/tiers.mjs";
import { t } from "./i18n.mjs";

const RB_ID = "ckl-roll-bonuses";

/** Stored as names: a tier of 0 is falsy, and roll-bonuses' select treats falsy as unset. */
const TIERS = Object.freeze({
  bright: TIER.BRIGHT,
  normal: TIER.NORMAL,
  dim: TIER.DIM,
  dark: TIER.DARK,
  supernaturalDark: TIER.SUPERNATURAL_DARK,
});

const TIER_LABEL = {
  bright: "Bright",
  normal: "Normal",
  dim: "Dim",
  dark: "Dark",
  supernaturalDark: "SupernaturalDark",
};

const SUBJECTS = ["self", "target", "either", "both"];
const COMPARISONS = ["at", "above", "below"];

const COMPARE = {
  at: (tier, ref) => tier === ref,
  above: (tier, ref) => tier > ref,
  below: (tier, ref) => tier < ref,
};

const choices = (list, path) => Object.fromEntries(list.map((k) => [k, t(`${path}.${k}`)]));
const tierChoices = () =>
  Object.fromEntries(Object.entries(TIER_LABEL).map(([k, label]) => [k, t(`Tier.${label}`)]));

function registerTarget(api) {
  const BaseConditionalTarget = api?.sources?.BaseConditionalTarget;
  const inputs = api?.inputs;
  if (!BaseConditionalTarget || !api.utils?.registerSource || !inputs?.keyValueSelect || !inputs?.radioInput) {
    console.error("pf1-lighting | roll-bonuses API not usable; the Light Level target is unavailable.");
    return;
  }

  class LightLevelTarget extends BaseConditionalTarget {
    /** @override */
    static get sourceKey() { return "pf1-lighting-light-level"; }

    static get #subjectKey() { return `${this.key}-subject`; }
    static get #comparisonKey() { return `${this.key}-comparison`; }
    static get #tierKey() { return `${this.key}-tier`; }

    /** @override */
    static get journal() { return ""; }

    /** @override */
    static get label() { return t("RollBonuses.LightLevel.Label"); }

    /** @override */
    static get tooltip() { return t("RollBonuses.LightLevel.Tooltip"); }

    /** Missing or stale flags fall back to the select's first choice, matching what the sheet shows. */
    static #config(source) {
      const flag = (key, list) => {
        const value = source.getFlag(RB_ID, key);
        return list.includes(value) ? value : list[0];
      };
      return {
        subject: flag(this.#subjectKey, SUBJECTS),
        comparison: flag(this.#comparisonKey, COMPARISONS),
        tier: flag(this.#tierKey, Object.keys(TIERS)),
      };
    }

    /** @override */
    static fluentDescription(source) {
      const { subject, comparison, tier } = this.#config(source);
      return t(`RollBonuses.LightLevel.Fluent.${comparison}`, {
        subject: t(`RollBonuses.LightLevel.Subject.${subject}`),
        tier: t(`Tier.${TIER_LABEL[tier]}`),
      });
    }

    /** @override */
    static getHints(source) {
      return [this.fluentDescription(source)];
    }

    /** The actor's controlled token, else every token of it on the canvas. */
    static #selfTokens(actor) {
      const controlled = canvas.tokens.controlled.filter((token) => token.actor?.uuid === actor.uuid);
      return controlled.length ? controlled : actor.getActiveTokens();
    }

    /** @override */
    static _filterToApplicableSources(actor, sources) {
      if (!sources.length || !canvas?.ready) return [];

      const self = this.#selfTokens(actor);
      const targets = api.utils.currentTargets?.() ?? [...game.user.targets];
      const all = [...self, ...targets];
      if (!all.length) return [];

      // One call builds the field once for every subject. Brightest occupied square (§13).
      const tiers = brightnessOf(all, { sample: "max" });
      const selfTiers = tiers.slice(0, self.length);
      const targetTiers = tiers.slice(self.length);

      return sources.filter((source) => {
        const { subject, comparison, tier } = this.#config(source);
        const test = (value) => COMPARE[comparison](value, TIERS[tier]);
        const selfOk = selfTiers.some(test);
        const targetOk = targetTiers.length > 0 && targetTiers.every(test);
        switch (subject) {
          case "self": return selfOk;
          case "target": return targetOk;
          case "either": return selfOk || targetOk;
          case "both": return selfOk && targetOk;
          default: return false;
        }
      });
    }

    /**
     * @override
     * @param {ItemPF} item
     * @param {{ subject?: string, comparison?: string, tier?: string }} [config]
     */
    static async configure(item, { subject = "self", comparison = "at", tier = "bright" } = {}) {
      await item.update({
        system: { flags: { boolean: { [this.key]: true } } },
        flags: {
          [RB_ID]: {
            [this.#subjectKey]: subject,
            [this.#comparisonKey]: comparison,
            [this.#tierKey]: tier,
          },
        },
      });
    }

    /** @override */
    static showInputOnItemSheet({ html, isEditable, item }) {
      const options = { canEdit: isEditable, inputType: "target" };
      const sub = { ...options, isSubLabel: true };

      inputs.showEnabledLabel({
        item,
        journal: this.journal,
        key: this.key,
        label: this.label,
        parent: html,
        tooltip: this.tooltip,
      }, options);

      inputs.keyValueSelect({
        choices: choices(SUBJECTS, "RollBonuses.LightLevel.Subject"),
        item,
        journal: this.journal,
        key: this.#subjectKey,
        label: t("RollBonuses.LightLevel.SubjectLabel"),
        parent: html,
        tooltip: t("RollBonuses.LightLevel.SubjectTooltip"),
      }, sub);

      inputs.radioInput({
        item,
        journal: this.journal,
        key: this.#comparisonKey,
        label: t("RollBonuses.LightLevel.ComparisonLabel"),
        parent: html,
        tooltip: t("RollBonuses.LightLevel.ComparisonTooltip"),
        values: COMPARISONS.map((id) => ({ id, label: t(`RollBonuses.LightLevel.Comparison.${id}`) })),
      }, sub);

      inputs.keyValueSelect({
        choices: tierChoices(),
        item,
        journal: this.journal,
        key: this.#tierKey,
        label: t("RollBonuses.LightLevel.TierLabel"),
        parent: html,
        tooltip: t("RollBonuses.LightLevel.TierTooltip"),
      }, sub);
    }
  }

  try {
    api.utils.registerSource(LightLevelTarget);
    LightLevelTarget.init?.();
  } catch (err) {
    console.error("pf1-lighting | registering the Light Level target failed:", err);
  }
}

Hooks.once(`${RB_ID}.ready`, registerTarget);
