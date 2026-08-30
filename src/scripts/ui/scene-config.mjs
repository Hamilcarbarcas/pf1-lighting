/**
 * The scene's light level, as a tier. DESIGN.md §10.5.
 *
 * The scene stores a tier rather than just a number. `scene.environment.darknessLevel` is a `[0,1]`
 * scalar and the model reads it back through `tierFromDarkness` — nearest rung, ties to the darker.
 * That inversion is fine for reading a scene somebody else configured and wrong to build a control
 * on, for the reason §10.2 gives about presets: the tier a GM chose is a fact about history, and
 * history cannot be recovered from the number.
 *
 * It matters here in a way it does not for presets, the tier table now being editable (§10.5). Move
 * Dim from 0.67 to 0.80 and every scene set to Dim should follow. Re-deriving from the stored 0.67
 * cannot do that reliably — the nearest rung to 0.67 under the new table may not be Dim any more, so
 * a scene would silently change tier because an unrelated one was retuned. Storing the choice makes
 * the update deterministic: the scene is Dim, Dim is now 0.80, write 0.80.
 *
 * So `flags.pf1-lighting.tier` is the source of truth and `environment.darknessLevel` is derived
 * output. A scene with no flag has never been set through this control and is left alone — the
 * dropdown shows its nearest tier so it reads sensibly, and nothing is written until a GM picks one.
 * Snapping every existing scene on install would be the module deciding something it was not asked
 * to decide.
 *
 * The slider is replaced rather than hidden alongside a dropdown (2026-08-25). The model quantises
 * to five tiers, so a continuous control offers precision that does not exist, and two controls
 * updating each other is the arrangement §10.5 already rejected for this field. Core's input is
 * moved into a hidden slot rather than duplicated, two fields sharing a name making
 * `FormDataExtended` return an array.
 *
 * The two transition buttons go the same way: the lighting palette's Transition to Daylight and
 * Transition to Darkness are replaced by one button per tier (2026-08-28), for the same reason
 * twice over. They slide `darknessLevel` across ten seconds, a long crossfade through states a
 * four-rung model does not have, and they write the raw number without the tier flag, so a scene
 * set by one of them is a scene this file has to guess about. `setSceneTier` writes both fields at
 * once and omits `animateDarkness`, which is what makes the change instant.
 */

import { MODULE_ID } from "../constants.mjs";
import { t } from "../i18n.mjs";
import { TIER, TIER_NAME, tierLabel } from "../model/tiers.mjs";
import { darknessTable, tierFromDarkness } from "../render/levels.mjs";

/** Per-feature de-dup marker, never a shared utility class. */
const MARKER = "pf1-lighting-scene-tier";

/** Applied to the core row whose input has been taken. */
const HIDDEN_ROW = "pf1-lighting-moved";

/** `flags.pf1-lighting.tier` — the chosen tier, and the reason this module exists. */
export const TIER_FLAG = "tier";
const FLAG_PATH = `flags.${MODULE_ID}.${TIER_FLAG}`;

/**
 * Tiers a scene's ambient can be, brightest first.
 *
 * Supernatural Dark is absent deliberately: not somewhere ambient light can be, only somewhere a
 * suppressor with the right floor puts a creature (see `tiers.stepTier`).
 */
const SCENE_TIERS = [TIER.BRIGHT, TIER.NORMAL, TIER.DIM, TIER.DARK];

/** Floats. The stored level is written from the table, so equality is about round-tripping. */
const EPSILON = 1e-6;

/** The darkness level a tier should be stored at, right now. */
const levelFor = (tier) => darknessTable()[tier] ?? 1;

/** The tier a scene has been set to, or null if it has never been set through this control. */
export function tierOf(scene) {
  const stored = scene?.flags?.[MODULE_ID]?.[TIER_FLAG];
  return Number.isFinite(stored) && SCENE_TIERS.includes(stored) ? stored : null;
}

/**
 * The tier a scene *reads as*, whether or not it was ever set through this control.
 *
 * @remarks
 * The fallback half of {@link tierOf}, split out for the API (§11.5). A consumer asking what light
 * level a scene is wants an answer for every scene; the `null` distinguishing never-set from
 * set-to-Dark matters to the sync pass and to nobody outside it.
 */
export function nearestTier(scene = canvas?.scene) {
  return tierFromDarkness(scene?.environment?.darknessLevel ?? 0);
}

/* -------------------------------------------- */
/*  Keeping scenes in step with the table       */
/* -------------------------------------------- */

/**
 * Should this client be the one writing scene documents?
 *
 * @remarks
 * A world setting's `onChange` fires on every connected client and a scene is a world document, so
 * without this the update would be attempted by players (refused) and by every GM at once (each
 * issuing the same write). `activeGM` is Foundry's own answer to exactly-one-GM-does-this.
 */
export const isWriter = () => game.users?.activeGM?.isSelf === true;

/**
 * Bring scenes' stored darkness back in line with the tier they were set to.
 *
 * @remarks
 * Locked scenes are skipped rather than attempted. `Scene#_preUpdate` silently deletes
 * `environment.darknessLevel` from an update when `environment.darknessLock` is set
 * (`documents/scene.mjs:416-419`) — no error, no effect — so issuing the write anyway would produce
 * a readout claiming to have updated scenes it did not. They are counted separately.
 *
 * @param {Scene[]} scenes
 * @returns {Promise<{updated: number, locked: number, checked: number}>}
 */
export async function syncScenes(scenes) {
  const report = { updated: 0, locked: 0, checked: 0 };
  if (!isWriter()) return report;

  const updates = [];
  for (const scene of scenes ?? []) {
    const tier = tierOf(scene);
    if (tier === null) continue; // Never set through this control, so not this module's to touch.
    report.checked++;

    const target = levelFor(tier);
    const current = scene.environment?.darknessLevel ?? 0;
    if (Math.abs(current - target) <= EPSILON) continue;

    if (scene.environment?.darknessLock) {
      report.locked++;
      continue;
    }
    updates.push({ _id: scene.id, "environment.darknessLevel": target });
  }

  if (updates.length) {
    await Scene.updateDocuments(updates);
    report.updated = updates.length;
  }
  return report;
}

/** Every scene in the world that has been given a tier. */
export const syncAllScenes = () => syncScenes(game.scenes?.contents ?? []);

/* -------------------------------------------- */
/*  The lighting-control buttons (§10.5.2)      */
/* -------------------------------------------- */

/**
 * Set the current scene's light level, instantly.
 *
 * @remarks
 * Both halves, or neither. `flags.pf1-lighting.tier` is the source of truth and
 * `environment.darknessLevel` derived output (§10.5.1), so a button writing only the number would
 * leave the scene looking right while still recorded as whatever tier it last carried, and the next
 * table change would drag it elsewhere. One update, both fields.
 *
 * No `animateDarkness` option: `Scene##onUpdate` hands the change to
 * `canvas.effects.animateDarkness` only when the option is present (`documents/scene.mjs:606`), so
 * omitting it gives the instant change rather than a zero passed to the animator.
 *
 * @param {number} tier - A {@link TIER} value from {@link SCENE_TIERS}
 * @param {Scene} [scene=canvas.scene]
 * @returns {Promise<?number>} The tier set, or null if nothing was written
 */
export async function setSceneTier(tier, scene = canvas?.scene) {
  if (!scene) return null;
  if (!SCENE_TIERS.includes(tier)) return null;
  if (scene.environment?.darknessLock) {
    ui.notifications?.warn(t("Notify.SceneDarknessLocked", { scene: scene.name }));
    return null;
  }
  // The change hook fires from `updateScene`, not here — see {@link announceTierChange}.
  await scene.update({
    [FLAG_PATH]: tier,
    "environment.darknessLevel": levelFor(tier),
  });
  return tier;
}

/**
 * Announce that a scene's light level moved. DESIGN.md §11.5.
 *
 * @remarks
 * From `updateScene`, not from the writers. The tier can be set from the dropdown, a
 * lighting-palette button, the API, or another client entirely, and a hook fired at each write
 * would miss the last of those and fire twice for nothing on a preview. `updateScene` is where
 * every route converges, and where a consumer would otherwise have to do this work itself —
 * re-deriving the tier from the raw number and filtering out its own writes.
 *
 * Fires only when the tier changes. The darkness level moving within a rung — a GM nudging the
 * slider on a scene never put through the dropdown — is not a light-level change as far as this
 * module is concerned, and a consumer acting on one would be acting on noise.
 */
function announceTierChange(scene, changed) {
  const touched =
    foundry.utils.hasProperty(changed, `flags.${MODULE_ID}.${TIER_FLAG}`) ||
    foundry.utils.hasProperty(changed, "environment.darknessLevel");
  if (!touched) return;

  const tier = tierOf(scene) ?? nearestTier(scene);
  const previous = lastAnnounced.get(scene.id);
  if (previous === tier) return;
  lastAnnounced.set(scene.id, tier);
  // `previous` is undefined the first time a scene is seen, which is honest — nothing knows what it
  // was before this client loaded.
  Hooks.callAll(`${MODULE_ID}.sceneTierChanged`, scene, tier, previous ?? null);
}

/** Last tier announced per scene, so an update that does not move the rung stays quiet. */
const lastAnnounced = new Map();

/** Tool id for a tier's button. Also the prefix everything below matches on. */
const toolId = (tier) => `pf1LightingTier${tier}`;

/**
 * Brightest to darkest. Core's own sun and moon at the ends, so the two buttons a GM already
 * knows keep their meaning and the two new ones read as the rungs between them.
 */
const TIER_ICONS = Object.freeze({
  [TIER.BRIGHT]: "fa-solid fa-sun",
  [TIER.NORMAL]: "fa-solid fa-cloud-sun",
  [TIER.DIM]: "fa-solid fa-cloud-moon",
  [TIER.DARK]: "fa-solid fa-moon",
});

/**
 * Replace core's two transition buttons with one per tier. DESIGN.md §10.5.2.
 *
 * @remarks
 * Replaced, not added to. Core's Transition to Daylight and Transition to Darkness slide
 * `darknessLevel` over ten seconds (`CONFIG.Canvas.darknessToDaylightAnimationMS`), a long crossfade
 * through states a four-rung model does not have, and they write the raw number without the tier
 * flag, so a scene set by one of them is a scene this module has to guess about. The same argument
 * §10.5 makes for replacing the slider outright.
 *
 * `visible` is evaluated once per `#prepareControls`, which core re-runs on `canvasReady` and
 * whenever `darknessLock` changes (`documents/scene.mjs:625-627`) — the two moments it can go stale
 * — so honouring the lock here needs nothing of its own.
 *
 * v13 passes `controls` as a Record keyed by control name, not an array; see the note on
 * `vision/observer.registerSceneControls`.
 */
export function registerSceneControls() {
  Hooks.on("getSceneControlButtons", (controls) => {
    const lighting = controls.lighting;
    if (!lighting?.tools) return;

    delete lighting.tools.day;
    delete lighting.tools.night;

    // Core numbered these 4 and 5, behind the two buttons just removed. The new ones take 2–5, so
    // the palette keeps one order per tool rather than relying on how equal orders happen to sort.
    if (lighting.tools.reset) lighting.tools.reset.order = 6;
    if (lighting.tools.clear) lighting.tools.clear.order = 7;

    if (canvas?.scene?.environment?.darknessLock) return;

    SCENE_TIERS.forEach((tier, i) => {
      lighting.tools[toolId(tier)] = {
        name: toolId(tier),
        order: 2 + i,
        // Formatted rather than handed over as a key: `getSceneControlButtons` fires long after
        // `init`, so `game.i18n` is loaded and the tier name has to be interpolated. The template's
        // own `{{localize}}` passes an already-formatted string straight through.
        title: t("Control.SetSceneTier", { tier: tierLabel(tier) }),
        icon: TIER_ICONS[tier],
        button: true,
        onChange: () => setSceneTier(tier),
      };
    });
  });
}

/* -------------------------------------------- */
/*  The control                                 */
/* -------------------------------------------- */

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

/**
 * Suppress the change events this module's own writes provoke.
 *
 * @remarks
 * Assigning `.value` on one of Foundry's custom form elements dispatches `input` and `change`
 * (`applications/elements/form-element.mjs:89-92`), so driving core's darkness input from the
 * dropdown re-enters the same delegated listener, and without this the two would push each other
 * around the form. Cheaper and more robust than reaching for `_setValue`, which is protected and
 * exists only on the custom elements — a plain `<input type="range">` would need the guard anyway.
 */
let applying = false;

function markup(tier, drifted, locked) {
  const options = SCENE_TIERS.map(
    (value) =>
      `<option value="${value}"${value === tier ? " selected" : ""}>${esc(tierLabel(value))}</option>`
  ).join("");

  return `
<div class="form-group ${MARKER}">
  <label>${esc(t("SceneConfig.Label"))}</label>
  <div class="form-fields">
    <select data-drives="darkness"${locked ? " disabled" : ""}>${options}</select>
  </div>
  <input type="hidden" name="${FLAG_PATH}" value="${tier}" data-dtype="Number">
  <span data-slot="darkness" hidden></span>
  <p class="hint">${t("SceneConfig.Hint")}${drifted ? t("SceneConfig.Drifted") : ""}${
    locked ? t("SceneConfig.Locked") : ""
  }</p>
</div>`;
}

function inject(app, element) {
  const root = element instanceof HTMLElement ? element : element?.[0];
  if (!root || root.querySelector(`.${MARKER}`)) return;

  const native = root.querySelector('[name="environment.darknessLevel"]');
  const row = native?.closest(".form-group");
  if (!native || !row) return;

  const scene = app.document;
  const current = Number(native.value);
  // No flag: show the nearest rung so the control reads sensibly, and write nothing until the GM
  // picks one.
  const stored = tierOf(scene);
  const tier = stored ?? tierFromDarkness(current);
  const drifted = stored !== null && Math.abs(current - levelFor(tier)) > EPSILON;
  const locked = scene.environment?.darknessLock === true;

  row.classList.add(HIDDEN_ROW);
  row.insertAdjacentHTML("beforebegin", markup(tier, drifted, locked));

  const group = root.querySelector(`.${MARKER}`);
  group.querySelector('[data-slot="darkness"]').replaceChildren(native);

  group.addEventListener("change", (event) => {
    if (applying) return;
    const select = event.target;
    if (select?.dataset?.drives !== "darkness") return;

    const next = Number(select.value);
    group.querySelector(`[name="${FLAG_PATH}"]`).value = next;

    applying = true;
    try {
      native.value = levelFor(next);
    } finally {
      applying = false;
    }
    // Core previews any change whose field name contains `environment.` (`scene-config.mjs:236`),
    // so the preview comes from letting the real field's event reach the sheet rather than from any
    // call here.
    native.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/* -------------------------------------------- */

export function registerHooks() {
  Hooks.on("renderSceneConfig", (app, element) => {
    try {
      inject(app, element);
    } catch (error) {
      console.error(`${MODULE_ID} | scene config injection failed`, error);
    }
  });

  // The table moved: every scene that was set to a tier now stores the wrong number.
  Hooks.on(`${MODULE_ID}.tierTableChanged`, () => {
    syncAllScenes().then((report) => {
      if (report.updated || report.locked) {
        console.error(`${MODULE_ID} | scene light levels re-synced`, report);
      }
      if (report.locked) {
        ui.notifications?.warn(t("Notify.ScenesLocked", { count: report.locked }));
      }
    });
  });

  // A safety net rather than the main path: the sync above covers every scene at the moment the
  // table changes, but a scene created or imported while a different table was in force — or by a
  // client that was not the active GM — arrives with a stale level. Checking the one scene being
  // drawn costs a comparison.
  Hooks.on("canvasReady", () => {
    if (canvas?.scene) syncScenes([canvas.scene]);
    // Seed the announcer, so the first real change reports a `previous` rather than firing on
    // arrival at a scene that has not changed at all.
    if (canvas?.scene) {
      lastAnnounced.set(canvas.scene.id, tierOf(canvas.scene) ?? nearestTier(canvas.scene));
    }
  });

  // The API's change signal (§11.5). Every route to a new tier passes through here.
  Hooks.on("updateScene", (scene, changed) => {
    try {
      announceTierChange(scene, changed);
    } catch (error) {
      console.error(`${MODULE_ID} | scene tier hook failed`, error);
    }
  });
}

/** Debug readout: which scenes carry a tier, and whether their stored level matches it. */
export function status() {
  const rows = [];
  for (const scene of game.scenes?.contents ?? []) {
    const tier = tierOf(scene);
    if (tier === null) continue;
    const target = levelFor(tier);
    const current = scene.environment?.darknessLevel ?? 0;
    rows.push({
      name: scene.name,
      tier: TIER_NAME[tier],
      stored: +current.toFixed(4),
      shouldBe: +target.toFixed(4),
      matches: Math.abs(current - target) <= EPSILON,
      locked: scene.environment?.darknessLock === true,
    });
  }
  const report = {
    writer: isWriter(),
    withTier: rows.length,
    // Scenes predating the control, or never set through it. Not a fault — they are read by
    // nearest rung and deliberately left alone.
    untiered: (game.scenes?.contents?.length ?? 0) - rows.length,
    scenes: rows,
  };
  console.error(`${MODULE_ID} | scene light levels`, report);
  return report;
}
