/**
 * *Configure light spill* — the numbers behind §3.4. DESIGN.md §10.10.
 *
 * Modelled on `ui/visuals.mjs` (§10.6.1), including the rule that made that window worth having:
 * **the settings are not owned here.** Every key stays registered in the module that reads it —
 * `model/spill.mjs` for the geometry, `render/gradient.mjs` for the falloff profile — each with
 * its own `onChange`, and this window reads and writes them by key. Writing one key at a time, and
 * only where the value moved, is what keeps each `onChange` firing once — and here that matters
 * more than it did there, because most of these invalidate the sweep cache and rebuild the
 * spill geometry for the whole scene. The plateau is the exception: it re-maps a vertex buffer
 * without moving a vertex.
 *
 * Unlike Visuals, this window is **not** appearance-only. These numbers move the model: a light
 * level a creature can see by, everywhere spill reaches. That is why the radii are plain feet in
 * a number field rather than sliders — a GM tuning them is comparing them against a torch's
 * radius, not dragging until it looks right.
 */

import { MODULE_ID } from "../constants.mjs";
import { TIER } from "../model/tiers.mjs";
import {
  SETTING_ANGLE,
  SETTING_BAND,
  SETTING_ENABLED,
  SETTING_RADIUS,
} from "../model/spill.mjs";
import { SETTING_WIDTH } from "../render/transition.mjs";

export const MENU_KEY = "spillConfig";

/**
 * The three caps, brightest first.
 *
 * @remarks
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

  <div class="form-group">
    <label>Spill cone angle</label>
    <div class="form-fields">
      <range-picker name="${esc(SETTING_ANGLE)}" value="${esc(read(SETTING_ANGLE, 105))}"
        min="30" max="180" step="5"></range-picker>
    </div>
    <p class="hint">How wide the brightest wedge reads, in degrees. This is how the light
      <em>looks</em> coming through the gap, not what the walls block — the bands beside the
      wedge are worked out separately and are cut off by walls either way.</p>
  </div>
</fieldset>

<fieldset>
  <legend>Reach</legend>
  <p class="hint">How far the bright wedge throws, chosen by how bright it is <strong>outside</strong>
    the window. A <em>darkness</em> over the window lowers that, so the same window throws less far
    while the spell is on it.</p>
  ${caps}

  <div class="form-group">
    <label>Band width</label>
    <div class="form-fields">
      ${number(SETTING_BAND, read(SETTING_BAND, 10), { min: 5, max: 60, step: 5 })}
      <span class="units">ft</span>
    </div>
    <p class="hint">How far each step of the falloff runs past the last, down to dim. Bright light
      through a window therefore reaches its own distance above <em>plus</em> two of these before
      it runs out.</p>
  </div>

  <div class="form-group">
    <label>Transition width</label>
    <div class="form-fields">
      <range-picker name="${esc(SETTING_WIDTH)}"
        value="${esc(read(SETTING_WIDTH, 0.75))}" min="0" max="4" step="0.05"></range-picker>
      <span class="units">squares</span>
    </div>
    <p class="hint">How far one brightness fades into the next. This is <strong>not</strong> a
      spill-only setting: it is the same distance everywhere brightness changes — a room's edge, a
      darkness rim, a light's zones — and it is edited here as well because a spill falloff is
      where it shows most. <strong>0</strong> makes every brightness boundary a hard edge.</p>
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
      SETTING_ANGLE,
      SETTING_BAND,
      SETTING_WIDTH,
      ...CAPS.map(({ tier }) => SETTING_RADIUS[tier]),
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
