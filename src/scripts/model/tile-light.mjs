/**
 * A tile's configured light. DESIGN.md §12.9.4.
 *
 * ```js
 * flags["pf1-lighting"].emits = {
 *   preset: "torch",                       // "" for none, or "custom"
 *   custom: { negative, light, config },   // preset-shaped; kept while a table preset is selected
 * }
 * ```
 *
 * Configuration only: nothing lights until the Tile HUD's *As configured* row is picked.
 */

import { MODULE_ID } from "../constants.mjs";
import { t } from "../i18n.mjs";
import { CUSTOM, table as presetTable } from "./presets.mjs";

export const EMITS_FLAG = "emits";
export const CUSTOM_KEY = "custom";

export const raw = (doc) => doc?.getFlag?.(MODULE_ID, EMITS_FLAG) ?? null;

/** The saved custom light, or null. */
export function customOf(doc) {
  const custom = raw(doc)?.[CUSTOM_KEY];
  return custom?.light ? custom : null;
}

/**
 * The effect to hand `companion.apply`, or null when nothing usable is configured.
 *
 * @param {TileDocument} doc
 * @param {object} [extra] - Merged into the effect (`id`, typically)
 */
export function effectFor(doc, extra = {}) {
  const preset = raw(doc)?.preset;
  if (!preset) return null;

  if (preset === CUSTOM) {
    const custom = customOf(doc);
    if (!custom) return null;
    return {
      ...extra,
      preset: CUSTOM,
      label: t("TileLight.CustomLabel"),
      // `negative` rides in `light`: `companion.toRecord` resolves no preset for Custom.
      light: { ...custom.light, negative: custom.negative === true },
      config: custom.config ?? {},
      configured: true,
    };
  }

  const entry = presetTable()[preset];
  if (!entry) return null;
  return { ...extra, preset, label: entry.label ?? preset, configured: true };
}
