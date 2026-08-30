/**
 * Configure visuals — the numbers that decide how the model is drawn. DESIGN.md §10.6.
 *
 * Everything here answers how something looks, never what is true. Change any of it and the light
 * level under a token is the number it was: the readout, what creatures can see, the umbra and
 * every mechanical consumer read the model, and the model does not read this file. That is the line
 * the window is drawn along, and why these came out of the flat list together rather than one at a
 * time.
 *
 * A window rather than a row each, because four of them are one setting with four values.
 * Brightness of Bright / Normal / Dim / Dark is a ladder — what matters is that they descend and
 * that the gaps stay wide enough to read, a fact about the four together that cannot be stated in
 * any one hint. As four rows they carried four near-identical paragraphs saying so (2026-08-26); as
 * a group under one heading they need one.
 *
 * The rest are the single brightness transition width every boundary now fades over
 * (§6.4.3/§6.4.4), how far unseen ground is dimmed, and the see-in-darkness offset — the rest of
 * the same question, with nowhere better to be.
 *
 * Deliberately counted nowhere. An earlier version said "the eight numbers" in four places and was
 * wrong in all four within a month; the list below is the only census.
 *
 * Five rows that used to be here are gone. Ground edge softening and Band softening blurred
 * individual meshes, which cannot produce a gradient at all — one width now covers every boundary
 * and one blur of the composited field delivers it. Light and Darkness edge softening still work
 * and still have settings, being source-mesh tuning rather than brightness and too niche for a row.
 * Greyscale in explored fog went on 2026-08-29 when its default became 0: a slider whose whole
 * range departs from the shipped answer is a console setting, not a row.
 *
 * The settings are not owned here. Each key stays registered in the module that reads it, with its
 * own `onChange`; this window reads and writes them by key and nothing else —
 * `render/levels.mjs`, `render/transition.mjs`, `render/darkness-mask.mjs`, `vision/blindness.mjs`.
 * §10.6's reason: a menu owning its settings is a second dependency graph to keep in step with the
 * first, and the `onChange` work here is real (the tier table re-solves the light weights and
 * repaints every scene set to a tier).
 *
 * Writing through `game.settings.set` per changed key also keeps those `onChange`s firing exactly
 * once each, and only for what moved.
 */

import { MODULE_ID } from "../constants.mjs";
import { t } from "../i18n.mjs";
import { TIER, tierLabel } from "../model/tiers.mjs";
import { TIER_SETTINGS } from "../render/levels.mjs";
import { SETTING_DARK_SIGHT_BRIGHTNESS } from "../vision/blindness.mjs";
import { SETTING_WIDTH } from "../render/transition.mjs";
import { SETTING_UNSEEN_DIMMING } from "../render/darkness-mask.mjs";

export const MENU_KEY = "visualsConfig";

/**
 * The tier ladder, brightest first.
 *
 * @remarks
 * Descending deliberately, and not cosmetically: the one rule a GM has to hold is that the numbers
 * ascend as the tiers get darker (0 is full daylight). Listing the tiers from Bright down makes a
 * wrong entry visible as a value out of order rather than a number to reason about.
 */
const LADDER = [TIER.BRIGHT, TIER.NORMAL, TIER.DIM, TIER.DARK];

/**
 * The sliders.
 *
 * @remarks
 * Light edge softening and Darkness edge softening were here and came out in §10.6.2's audit
 * (2026-08-27) as too niche to take up settings space. Both tune a source's mesh edge — much
 * smaller and rarer than the brightness boundaries this window is otherwise about, and since §7.0
 * step 6 the light one governs only a colour wash. They keep their settings and console access;
 * they lost their rows.
 */
const SLIDERS = [
  { key: SETTING_WIDTH, text: "TransitionWidth", min: 0, max: 4, step: 0.05 },
  { key: SETTING_UNSEEN_DIMMING, text: "UnseenDimming", min: 0, max: 1, step: 0.05 },
  { key: SETTING_DARK_SIGHT_BRIGHTNESS, text: "DarkSightBrightness", min: -1, max: 1, step: 0.05 },
];

/* -------------------------------------------- */
/*  Markup                                      */
/* -------------------------------------------- */

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

const read = (key, fallback = 0) => {
  try {
    const value = game.settings.get(MODULE_ID, key);
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
};

/**
 * A range control with its value beside it.
 *
 * @remarks
 * `<range-picker>` is Foundry's own custom element and shows the number while dragging, which is
 * why a slider is tolerable here: each of these is a quantity nobody can predict from the number
 * alone, and all want trying against a live map.
 */
function slider(key, value, { min, max, step }) {
  return `<range-picker name="${esc(key)}" value="${esc(value)}" min="${min}" max="${max}"
    step="${step}"></range-picker>`;
}

/* -------------------------------------------- */
/*  The application                             */
/* -------------------------------------------- */

class VisualsConfig extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "pf1-lighting-visuals",
    tag: "form",
    classes: ["pf1-lighting", "visuals-config"],
    window: {
      // A key: `ApplicationV2#title` runs it through `game.i18n.localize`.
      title: "PF1LIGHTING.Visuals.Title",
      icon: "fa-solid fa-sliders",
      contentClasses: ["standard-form"],
      resizable: true,
    },
    position: { width: 560, height: "auto" },
    form: {
      handler: VisualsConfig.#onSubmit,
      closeOnSubmit: true,
    },
    actions: {
      reset: VisualsConfig.#onReset,
    },
  };

  /** @override */
  async _renderHTML() {
    const rungs = LADDER.map(
      (tier) => `
      <div class="form-group slim">
        <label>${esc(tierLabel(tier))}</label>
        <div class="form-fields">
          ${slider(TIER_SETTINGS[tier], read(TIER_SETTINGS[tier]), {
            min: 0,
            max: 1,
            step: 0.05,
          })}
        </div>
      </div>`
    ).join("");

    const sliders = SLIDERS.map(
      ({ key: setting, text, min, max, step }) => `
      <div class="form-group">
        <label>${esc(t(`Visuals.${text}.Label`))}</label>
        <div class="form-fields">${slider(setting, read(setting), { min, max, step })}</div>
        <p class="hint">${t(`Visuals.${text}.Hint`)}</p>
      </div>`
    ).join("");

    // The scroll is on a wrapper, not on the window, and the footer sits outside it. With ten
    // controls this window is taller than a 1080p screen once Foundry's chrome is counted, and the
    // two buttons were what went off the bottom — a settings window whose Save must be scrolled to
    // is worse than one that is merely long.
    //
    // `calc(100vh - …)` rather than a pixel height: the window is `height: "auto"` and sizes to this
    // box, so a viewport-relative cap fits a laptop and still uses a tall monitor. Inline rather
    // than in `styles/` because the module's CSS is unlayered and outranks core's — a stray
    // `overflow` rule leaking out of this file is the bug class
    // `feedback_css_scope_every_selector` records, and one attribute cannot leak.
    return `
<div style="overflow-y: auto; overflow-x: hidden; max-height: calc(100vh - 260px); padding-right: 4px;">
<fieldset>
  <legend>${esc(t("Visuals.Levels.Legend"))}</legend>
  <p class="hint">${t("Visuals.Levels.Hint")}</p>
  ${rungs}
</fieldset>

<fieldset>
  <legend>${esc(t("Visuals.Transitions.Legend"))}</legend>
  ${sliders}
</fieldset>
</div>

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

  /** Every key this window edits, in one list. */
  static get #keys() {
    return [...LADDER.map((tier) => TIER_SETTINGS[tier]), ...SLIDERS.map((s) => s.key)];
  }

  /**
   * @remarks
   * Written one key at a time, and only where the value moved. Each carries an `onChange` that does
   * real work — the tier table re-solves the light weights and pushes every scene stored at a tier
   * to its new darkness (§10.5) — so writing every key unconditionally would run that four times
   * over for one edited number. The same trap `setting_onchange_fires_on_create` describes, from
   * the other direction.
   */
  static async #onSubmit(event, form, formData) {
    const data = formData.object;
    let changed = 0;

    for (const key of VisualsConfig.#keys) {
      const next = Number(data[key]);
      if (!Number.isFinite(next)) continue;
      if (next === read(key)) continue;
      await game.settings.set(MODULE_ID, key, next);
      changed++;
    }

    if (changed) ui.notifications.info(t("Visuals.Saved", { count: changed }));
  }

  static async #onReset() {
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: t("Visuals.Reset.Title") },
      content: t("Visuals.Reset.Body"),
    });
    if (!ok) return;

    for (const key of VisualsConfig.#keys) {
      const setting = game.settings.settings.get(`${MODULE_ID}.${key}`);
      if (!setting) continue;
      if (read(key) === setting.default) continue;
      await game.settings.set(MODULE_ID, key, setting.default);
    }
    this.render();
  }
}

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

export function registerSettings() {
  game.settings.registerMenu(MODULE_ID, MENU_KEY, {
    name: "PF1LIGHTING.Menu.visualsConfig.Name",
    label: "PF1LIGHTING.Menu.visualsConfig.Label",
    hint: "PF1LIGHTING.Menu.visualsConfig.Hint",
    icon: "fa-solid fa-sliders",
    type: VisualsConfig,
    restricted: true,
  });
}

/** Open it from the console: `game.pf1Lighting.render.visuals()` */
export function open() {
  return new VisualsConfig().render({ force: true });
}
