/**
 * Configure light spill — the numbers behind §3.4. DESIGN.md §10.10.
 *
 * Modelled on `ui/visuals.mjs` (§10.6.1), including the rule that made that window worth having:
 * the settings are not owned here. Every key stays registered in the module that reads it —
 * `model/spill.mjs` for the ladder, `model/geodesic.mjs` for the resolution — each with its own
 * `onChange`, and this window reads and writes them by key. Writing one key at a time, only where
 * the value moved, keeps each `onChange` firing once, which matters here because every one rebuilds
 * the spill geometry for the whole scene.
 *
 * Unlike Visuals, this window is not appearance-only. These numbers move the model: a light level a
 * creature can see by, everywhere spill reaches. Hence plain feet in a number field rather than
 * sliders — a GM tuning them is comparing against a torch's radius, not dragging until it looks
 * right.
 *
 * Two rows came out with §3.4.1's rewrite. Spill cone angle described the wedge the old
 * construction clipped its bands against, and there is no wedge; Band width described a single
 * uniform step, and each tier now carries its own.
 */

import { MODULE_ID } from "../constants.mjs";
import { t } from "../i18n.mjs";
import { TIER, tierLabel } from "../model/tiers.mjs";
import { SETTING_ENABLED, SETTING_RADIUS } from "../model/spill.mjs";
import { SETTING_CELL } from "../model/geodesic.mjs";

export const MENU_KEY = "spillConfig";

/**
 * The three band widths, brightest first.
 *
 * @remarks
 * Widths, not radii, since §3.4.1 (2026-08-28). The same three stored keys; what changed is that 40
 * means bright carries forty feet before it reads as normal, rather than a bright spill's cone
 * being forty feet long. The old scheme needed both a per-tier radius and a separate uniform band
 * width, which double-counted the falloff; this needs one number per rung, and the reach is their
 * sum.
 *
 * Descending for `ui/visuals.mjs`'s reason: the one rule to hold is that a brighter sky throws
 * further, so a wrong entry shows up as a number out of order rather than one to reason about.
 * There is no Dark row because there is nothing below Dim to spill — `globalLightCutoff` is the Dim
 * threshold and global illumination erases beneath it.
 */
const CAPS = [TIER.BRIGHT, TIER.NORMAL, TIER.DIM];

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

const read = (key, fallback = 0) => {
  try {
    const value = game.settings.get(MODULE_ID, key);
    return value ?? fallback;
  } catch {
    return fallback;
  }
};

const number = (key, value, { min, max, step }) =>
  `<input type="number" name="${esc(key)}" value="${esc(value)}" min="${min}" max="${max}"
    step="${step}">`;

/* -------------------------------------------- */

class SpillConfig extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "pf1-lighting-spill",
    tag: "form",
    classes: ["pf1-lighting", "spill-config"],
    window: {
      title: "PF1LIGHTING.Spill.Title",
      icon: "fa-solid fa-door-open",
      contentClasses: ["standard-form"],
      resizable: true,
    },
    position: { width: 560, height: "auto" },
    form: {
      handler: SpillConfig.#onSubmit,
      closeOnSubmit: true,
    },
    actions: {
      reset: SpillConfig.#onReset,
    },
  };

  /** @override */
  async _renderHTML() {
    const caps = CAPS.map(
      (tier) => `
      <div class="form-group slim">
        <label>${esc(tierLabel(tier))}</label>
        <div class="form-fields">
          ${number(SETTING_RADIUS[tier], read(SETTING_RADIUS[tier]), { min: 0, max: 200, step: 5 })}
          <span class="units">${esc(t("Common.Ft"))}</span>
        </div>
      </div>`
    ).join("");

    const enabled = read(SETTING_ENABLED, true) === true;

    const bright = Number(read(SETTING_RADIUS[TIER.BRIGHT], 40));
    const normal = Number(read(SETTING_RADIUS[TIER.NORMAL], 20));
    const dim = Number(read(SETTING_RADIUS[TIER.DIM], 10));

    return `
<fieldset>
  <legend>${esc(t("Spill.Enable.Legend"))}</legend>
  <div class="form-group">
    <label>${esc(t("Spill.Enable.Label"))}</label>
    <div class="form-fields">
      <input type="checkbox" name="${esc(SETTING_ENABLED)}" ${enabled ? "checked" : ""}>
    </div>
    <p class="hint">${t("Spill.Enable.Hint")}</p>
  </div>
</fieldset>

<fieldset>
  <legend>${esc(t("Spill.Falloff.Legend"))}</legend>
  <p class="hint">${t("Spill.Falloff.Hint")}</p>
  ${caps}
  <p class="hint">${t("Spill.Falloff.Total", {
    bright,
    normal,
    dim,
    total: bright + normal + dim,
  })}</p>
</fieldset>

<fieldset>
  <legend>${esc(t("Spill.Accuracy.Legend"))}</legend>
  <div class="form-group">
    <label>${esc(t("Spill.Accuracy.Label"))}</label>
    <div class="form-fields">
      <range-picker name="${esc(SETTING_CELL)}" value="${esc(read(SETTING_CELL, 25))}"
        min="5" max="100" step="5"></range-picker>
      <span class="units">${esc(t("Common.Px"))}</span>
    </div>
    <p class="hint">${t("Spill.Accuracy.Hint")}</p>
  </div>
</fieldset>

<footer class="form-footer">
  <button type="button" data-action="reset">
    <i class="fa-solid fa-rotate-left"></i> ${esc(t("Common.RestoreDefaults"))}</button>
  <button type="submit"><i class="fa-solid fa-save"></i> ${esc(t("Common.Save"))}</button>
</footer>`;
  }

  /** @override */
  _replaceHTML(result, content) {
    content.innerHTML = result;
  }

  /* -------------------------------------------- */

  static get #numericKeys() {
    return [
      // `transitionWidth` is deliberately not here (2026-08-27) — it duplicated brightness
      // transition width. It was repeated in this window because a spill falloff is where the width
      // shows most, which was true and still cost more than it bought: one setting on two forms
      // means two Restore defaults buttons that disagree about what they reset, and a number that
      // looks like a spill property while governing every boundary in the module. It lives in
      // Configure Visuals alone now.
      ...CAPS.map((tier) => SETTING_RADIUS[tier]),
      // §3.4.1. An accuracy knob rather than a model number, but it belongs on this form rather
      // than in Configure Visuals: too coarse a grid closes a doorway, which changes what a
      // creature can see. That is the line this window sits on the far side of.
      SETTING_CELL,
    ];
  }

  /**
   * @remarks
   * One key at a time, and only where the value moved. Each `onChange` bumps the geometry epoch and
   * re-sweeps every window on the scene, so writing all of them unconditionally would do that once
   * per key for one edited number.
   */
  static async #onSubmit(event, form, formData) {
    const data = formData.object;
    let changed = 0;

    const enabled = data[SETTING_ENABLED] === true;
    if (enabled !== (read(SETTING_ENABLED, true) === true)) {
      await game.settings.set(MODULE_ID, SETTING_ENABLED, enabled);
      changed++;
    }

    for (const key of SpillConfig.#numericKeys) {
      const next = Number(data[key]);
      if (!Number.isFinite(next)) continue;
      if (next === Number(read(key))) continue;
      await game.settings.set(MODULE_ID, key, next);
      changed++;
    }

    if (changed) ui.notifications.info(t("Spill.Saved", { count: changed }));
  }

  static async #onReset() {
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: t("Spill.Reset.Title") },
      content: t("Spill.Reset.Body"),
    });
    if (!ok) return;

    for (const key of [SETTING_ENABLED, ...SpillConfig.#numericKeys]) {
      const setting = game.settings.settings.get(`${MODULE_ID}.${key}`);
      if (!setting) continue;
      if (read(key) === setting.default) continue;
      await game.settings.set(MODULE_ID, key, setting.default);
    }
    this.render();
  }
}

/* -------------------------------------------- */

export function registerSettings() {
  game.settings.registerMenu(MODULE_ID, MENU_KEY, {
    name: "PF1LIGHTING.Menu.spillConfig.Name",
    label: "PF1LIGHTING.Menu.spillConfig.Label",
    hint: "PF1LIGHTING.Menu.spillConfig.Hint",
    icon: "fa-solid fa-door-open",
    type: SpillConfig,
    restricted: true,
  });
}

/** Open it from the console: `game.pf1Lighting.spill.config()` */
export function open() {
  return new SpillConfig().render({ force: true });
}
