/**
 * *Configure light spill* — the numbers behind §3.4. DESIGN.md §10.10.
 *
 * Modelled on `ui/visuals.mjs` (§10.6.1), including the rule that made that window worth having:
 * **the settings are not owned here.** Every key stays registered in the module that reads it —
 * `model/spill.mjs` for the ladder, `model/geodesic.mjs` for the resolution — each with its own
 * `onChange`, and this window reads and writes them by key. Writing one key at a time, and only
 * where the value moved, is what keeps each `onChange` firing once, which matters here because
 * every one of them rebuilds the spill geometry for the whole scene.
 *
 * Unlike Visuals, this window is **not** appearance-only. These numbers move the model: a light
 * level a creature can see by, everywhere spill reaches. That is why the widths are plain feet in
 * a number field rather than sliders — a GM tuning them is comparing them against a torch's
 * radius, not dragging until it looks right.
 *
 * Two rows came out with §3.4.1's rewrite. *Spill cone angle* described the wedge the old
 * construction clipped its bands against, and there is no wedge; *Band width* described a single
 * uniform step, and each tier now carries its own.
 */

import { MODULE_ID } from "../constants.mjs";
import { TIER } from "../model/tiers.mjs";
import { SETTING_ENABLED, SETTING_RADIUS } from "../model/spill.mjs";
import { SETTING_CELL } from "../model/geodesic.mjs";

export const MENU_KEY = "spillConfig";

/**
 * The three band widths, brightest first.
 *
 * @remarks
 * **They are widths, not radii, since §3.4.1** (Hamilcarbarcas, 2026-08-28: *"Am I correct assuming band
 * width is an outdated knob?"*). The same three stored keys; what changed is that 40 means *bright
 * carries forty feet before it reads as normal* rather than *a bright spill's cone is forty feet
 * long*. The old scheme needed both a per-tier radius and a separate uniform band width, which
 * double-counted the falloff; this needs one number per rung and the reach is their sum.
 *
 * Descending for `ui/visuals.mjs`'s reason: the one rule to hold in your head is that a brighter
 * sky throws further, so a wrong entry shows up as a number out of order rather than as one you
 * have to reason about. There is no Dark row because there is nothing below Dim to spill —
 * `globalLightCutoff` is the Dim threshold and global illumination erases beneath it.
 */
const CAPS = [
  { tier: TIER.BRIGHT, label: "Bright" },
  { tier: TIER.NORMAL, label: "Normal" },
  { tier: TIER.DIM, label: "Dim" },
];

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
      title: "Configure Light Spill",
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
      ({ tier, label }) => `
      <div class="form-group slim">
        <label>${label}</label>
        <div class="form-fields">
          ${number(SETTING_RADIUS[tier], read(SETTING_RADIUS[tier]), { min: 0, max: 200, step: 5 })}
          <span class="units">ft</span>
        </div>
      </div>`
    ).join("");

    const enabled = read(SETTING_ENABLED, true) === true;

    return `
<fieldset>
  <legend>Light spill</legend>
  <div class="form-group">
    <label>Enable light spill</label>
    <div class="form-fields">
      <input type="checkbox" name="${esc(SETTING_ENABLED)}" ${enabled ? "checked" : ""}>
    </div>
    <p class="hint">Lets outdoor light in through windows and open doors on the border of an
      interior region, falling off in bands. A window is any wall that does not block light;
      an open door counts while it is open. Needs <em>Model global illumination</em> on, or the
      model will move and the map will not.</p>
  </div>
</fieldset>

<fieldset>
  <legend>Falloff</legend>
  <p class="hint">How far each brightness carries indoors before it drops to the next one down,
    measured <strong>along the floor</strong> — so light that has to turn a corner spends its
    distance getting there. A window starts at whatever it is like <strong>outside</strong>, and a
    <em>darkness</em> over the window starts it lower, so the same window reaches less far while
    the spell is on it. The steps run down to dim and stop; there is nothing below dim to spill.</p>
  ${caps}
  <p class="hint">Bright light through a window therefore reaches
    ${read(SETTING_RADIUS[TIER.BRIGHT], 40)} + ${read(SETTING_RADIUS[TIER.NORMAL], 20)} +
    ${read(SETTING_RADIUS[TIER.DIM], 10)} =
    <strong>${
      Number(read(SETTING_RADIUS[TIER.BRIGHT], 40)) +
      Number(read(SETTING_RADIUS[TIER.NORMAL], 20)) +
      Number(read(SETTING_RADIUS[TIER.DIM], 10))
    } ft</strong> in total.</p>
</fieldset>

<fieldset>
  <legend>Accuracy</legend>
  <div class="form-group">
    <label>Grid resolution</label>
    <div class="form-fields">
      <range-picker name="${esc(SETTING_CELL)}" value="${esc(read(SETTING_CELL, 25))}"
        min="5" max="100" step="5"></range-picker>
      <span class="units">px</span>
    </div>
    <p class="hint">How finely the spill is worked out, in pixels — a quarter of a grid square by
      default. Smaller places the edges between brightnesses more precisely, and costs about five
      times as much for each halving. The symptom of too coarse is a brightness edge that does not
      quite follow the wall it should be running along; walls themselves stay exact at any
      setting.</p>
  </div>
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

  static get #numericKeys() {
    return [
      // **`transitionWidth` is deliberately not here** (Hamilcarbarcas, 2026-08-27: *"transition width in
      // light spill can go too — it's a duplicate to brightness transition width"*). It was
      // repeated in this window on the grounds that a spill falloff is where the width shows most,
      // which was true and still cost more than it bought: one setting on two forms means two
      // *Restore defaults* buttons that disagree about what they reset, and a number that appears
      // to be a spill property when it governs every boundary in the module. It lives in
      // *Configure Visuals* alone now.
      ...CAPS.map(({ tier }) => SETTING_RADIUS[tier]),
      // §3.4.1. An accuracy knob rather than a model number, but it belongs on this form and not in
      // *Configure Visuals*: too coarse a grid closes a doorway, which changes what a creature can
      // see. That is the line this window is on the far side of.
      SETTING_CELL,
    ];
  }

  /**
   * @remarks
   * One key at a time, and only where the value moved. Each `onChange` here bumps the geometry
   * epoch and re-sweeps every window on the scene, so writing all of them unconditionally would do
   * that once per key for one edited number.
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

    if (changed) ui.notifications.info(`PF1 Lighting | ${changed} light spill setting(s) updated.`);
  }

  static async #onReset() {
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Restore default light spill" },
      content: `<p>Put every light-spill setting back to the module's own values?</p>`,
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
    name: "Light Spill",
    label: "Configure Light Spill",
    hint:
      "How far outdoor light reaches in through a window or an open door, and how quickly it " +
      "falls off. Unlike Visuals, these change what creatures can see.",
    icon: "fa-solid fa-door-open",
    type: SpillConfig,
    restricted: true,
  });
}

/** Open it from the console: `game.pf1Lighting.spill.config()` */
export function open() {
  return new SpillConfig().render({ force: true });
}
