/**
 * *Configure visuals* — the numbers that decide how the model is drawn. DESIGN.md §10.6.
 *
 * Everything here answers *how does this look*, never *what is true*. Change any of it and the
 * light level under a token is the same number it was: the readout, what creatures can see, the
 * umbra and every mechanical consumer read the model, and the model does not read this file.
 * That is the line the window is drawn along, and it is why they came out of the flat list
 * together rather than one at a time.
 *
 * ## Why a window rather than a row each
 *
 * Four of them are one setting with four values. *Brightness of Bright / Normal / Dim / Dark* is
 * a **ladder** — the rule that matters is that they descend and that the gaps between them stay
 * wide enough to read, which is a fact about the four together and cannot be stated in any one
 * of their hints. As four rows in a list they carried four near-identical paragraphs saying so
 * (Patrick, 2026-08-26: *"do away with individual hints — just one hint"*). As a group under one
 * heading they need one.
 *
 * The rest are the two source-edge distances, the one **brightness transition width** every
 * boundary in the module now fades over (§6.4.3/§6.4.4), how far unseen ground is dimmed, how far
 * greyscale reaches into fog (§6.2.11), and the see-in-darkness offset — the rest of the same question,
 * with nowhere better to be.
 *
 * Deliberately **counted nowhere**. An earlier version of this file said "the eight numbers" in
 * four places and was wrong in all four within a month; the list below is the only census.
 *
 * Two rows that used to be here are gone rather than moved. *Ground edge softening* and *Band
 * softening* both blurred individual meshes, which cannot produce a gradient at all; one width now
 * covers every boundary and one blur of the composited field delivers it.
 *
 * ## The settings are not owned here
 *
 * Each key stays registered in the module that reads it, with its own `onChange`. This window
 * reads and writes them by
 * key and nothing else — `render/levels.mjs`, `render/soften.mjs`, `render/transition.mjs`,
 * `render/darkness-mask.mjs`, `render/greyscale.mjs`, `vision/blindness.mjs`. §10.6's reason: a
 * menu that owns its settings is a second
 * dependency graph to keep in step with the first, and the `onChange` work here is real (the
 * tier table re-solves the light weights and repaints every scene set to a tier).
 *
 * Writing through `game.settings.set` per changed key is also what keeps those `onChange`s
 * firing exactly once each, and only for what moved.
 */

import { MODULE_ID } from "../constants.mjs";
import { TIER } from "../model/tiers.mjs";
import { TIER_SETTINGS } from "../render/levels.mjs";
import {
  SETTING_DARKNESS_SOFTNESS,
  SETTING_EDGE_SOFTNESS,
} from "../render/soften.mjs";
import { SETTING_DARK_SIGHT_BRIGHTNESS } from "../vision/blindness.mjs";
import { SETTING_WIDTH } from "../render/transition.mjs";
import { SETTING_UNSEEN_DIMMING } from "../render/darkness-mask.mjs";
import { SETTING_FOG_GREY } from "../render/greyscale.mjs";

export const MENU_KEY = "visualsConfig";

/**
 * The tier ladder, brightest first.
 *
 * @remarks
 * Descending deliberately, and it is not cosmetic: the one rule a GM has to hold in their head
 * is that the numbers **ascend** as the tiers get darker (0 is full daylight). Listing the tiers
 * from Bright down makes a wrong entry visible as a value out of order rather than as a number
 * they have to reason about.
 */
const LADDER = [
  { tier: TIER.BRIGHT, label: "Bright" },
  { tier: TIER.NORMAL, label: "Normal" },
  { tier: TIER.DIM, label: "Dim" },
  { tier: TIER.DARK, label: "Dark" },
];

/**
 * The sliders, in the order the edges occur on screen: light, then darkness, then ground — then
 * the two that are not edges at all and have nowhere better to live.
 */
const SLIDERS = [
  {
    key: SETTING_EDGE_SOFTNESS,
    label: "Light edge softening",
    hint:
      "How far a light's cut or clipped edge fades, in grid squares. Applies only where a light " +
      "is not a plain circle — walls, clips, band overlaps — because Foundry fades an " +
      "unobstructed disc with attenuation instead.",
    min: 0.05,
    max: 1,
    step: 0.05,
  },
  {
    key: SETTING_DARKNESS_SOFTNESS,
    label: "Darkness edge softening",
    hint:
      "How far a darkness source's own disc fades at its rim, in grid squares. A fixed distance " +
      "rather than a proportion, so a large darkness looks harder-edged than a small one.",
    min: 0.5,
    max: 6,
    step: 0.5,
  },
  {
    key: SETTING_WIDTH,
    label: "Brightness transition width",
    hint:
      "How far one brightness fades into the next, in grid squares — and it is the same distance " +
      "everywhere it happens: a region's edge, the rim of a darkness, a light's two zones, the " +
      "edge of what you can see, and a window's spill. 0 makes every brightness boundary hard.",
    min: 0,
    max: 4,
    step: 0.05,
  },
  {
    key: SETTING_UNSEEN_DIMMING,
    label: "Unseen ground dimming",
    hint:
      "How far explored ground outside your current vision is taken toward black, on top of " +
      "already being drawn at Dark. Foundry hard-codes this at 0.5, which stacks heavily on dark " +
      "terrain. Ground you have never visited stays solid black either way.",
    min: 0,
    max: 1,
    step: 0.05,
  },
  {
    key: SETTING_FOG_GREY,
    label: "Greyscale in explored fog",
    hint:
      "Seeing in black and white greys the dark parts of what you can see. This is how much of " +
      "that reaches explored ground you cannot currently see: 0 leaves remembered terrain in " +
      "full colour, 1 treats it exactly like ground in view. The boundary is your own vision " +
      "polygon, so it moves with you — the middle of the range exists to keep that edge quiet.",
    min: 0,
    max: 1,
    step: 0.05,
  },
  {
    key: SETTING_DARK_SIGHT_BRIGHTNESS,
    label: "See-in-darkness brightness",
    hint:
      "Adjusts how bright terrain looks to a creature with see in darkness or true seeing. " +
      "Foundry cannot reveal an area without also lightening it, so their view reads brighter " +
      "than the scene's own lighting. Negative values dim it back; 0 leaves it alone.",
    min: -1,
    max: 1,
    step: 0.05,
  },
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
 * `<range-picker>` is Foundry's own custom element and shows the number as you drag, which is
 * the whole reason a slider is tolerable for these: every one of them is a quantity nobody can
 * predict from the number alone, and all of them want trying against a live map.
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
      title: "Configure Visuals",
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
      ({ tier, label }) => `
      <div class="form-group slim">
        <label>${label}</label>
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
      ({ key, label, hint, min, max, step }) => `
      <div class="form-group">
        <label>${label}</label>
        <div class="form-fields">${slider(key, read(key), { min, max, step })}</div>
        <p class="hint">${hint}</p>
      </div>`
    ).join("");

    return `
<fieldset>
  <legend>Brightness levels</legend>
  <p class="hint">How dark the ground at each tier is drawn, from <strong>0</strong> (full
    daylight) to <strong>1</strong> (unlit). They should ascend as the tiers get darker, and the
    gaps between them are what makes one tier readable against the next. Supernatural Dark is
    drawn at the same level as Dark; the two are told apart by the darkness source's own
    overlay.</p>
  ${rungs}
</fieldset>

<fieldset>
  <legend>Edges and shading</legend>
  ${sliders}
</fieldset>

<footer class="form-footer">
  <button type="button" data-action="reset">
    <i class="fa-solid fa-rotate-left"></i> Restore defaults</button>
  <button type="submit"><i class="fa-solid fa-save"></i> Save</button>
</footer>`;
  }

  /** @override */
  _replaceHTML(result, content) {
    content.innerHTML = result;
  }

  /* -------------------------------------------- */

  /** Every key this window edits, in one list. */
  static get #keys() {
    return [...LADDER.map(({ tier }) => TIER_SETTINGS[tier]), ...SLIDERS.map((s) => s.key)];
  }

  /**
   * @remarks
   * **Written one key at a time, and only where the value moved.** Each of these carries an
   * `onChange` that does real work — the tier table re-solves the light weights and pushes every
   * scene stored at a tier to its new darkness (§10.5) — and writing every key unconditionally
   * would run that four times over for one edited number. It is the same trap
   * `setting_onchange_fires_on_create` describes from the other direction.
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

    if (changed) ui.notifications.info(`PF1 Lighting | ${changed} visual setting(s) updated.`);
  }

  static async #onReset() {
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Restore default visuals" },
      content:
        `<p>Put every number in this window back to the module's own values?</p>` +
        `<p>Nothing about what creatures can see will change — these only affect how the ` +
        `model is drawn.</p>`,
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
    name: "Visuals",
    label: "Configure Visuals",
    hint:
      "How bright each of the five light levels is drawn, and how softly the edges between them " +
      "fade. Appearance only — none of it changes what a creature can see.",
    icon: "fa-solid fa-sliders",
    type: VisualsConfig,
    restricted: true,
  });
}

/** Open it from the console: `game.pf1Lighting.render.visuals()` */
export function open() {
  return new VisualsConfig().render({ force: true });
}
