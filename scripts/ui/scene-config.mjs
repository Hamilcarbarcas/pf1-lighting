/**
 * The scene's light level, as a tier. DESIGN.md §10.5.
 *
 * ## Why the scene stores a tier and not just a number
 *
 * `scene.environment.darknessLevel` is a `[0,1]` scalar, and the model reads it back through
 * `tierFromDarkness` — nearest rung, ties to the darker. That inversion is fine for *reading* a
 * scene somebody else configured, and it is the wrong thing to build a control on, for the same
 * reason §10.2 gives about presets: **the tier a GM chose is a fact about history, and history
 * cannot be recovered from the number.**
 *
 * It matters here in a way it does not for presets, because the tier table is now editable
 * (§10.5). Move Dim from 0.67 to 0.80 and every scene the GM set to Dim should follow. Re-deriving
 * from the stored 0.67 cannot do that reliably — the nearest rung to 0.67 under the *new* table
 * may not be Dim any more, so a scene would silently change tier because the GM retuned an
 * unrelated one. Storing the choice makes the update deterministic: the scene is Dim, Dim is now
 * 0.80, write 0.80.
 *
 * So `flags.pf1-lighting.tier` is the source of truth and `environment.darknessLevel` is derived
 * output. A scene with no flag has never been set through this control and is left alone — the
 * dropdown shows its nearest tier so it reads sensibly, and nothing is written until a GM picks
 * one. Snapping every existing scene on install would be the module deciding something it was
 * not asked to decide.
 *
 * ## The slider is gone
 *
 * Not hidden alongside a dropdown — replaced (Patrick, 2026-08-25). The model quantises to five
 * tiers, so a continuous control offers precision that does not exist, and two controls that
 * update each other is the arrangement §10.5 already rejected for this exact field. Core's input
 * is *moved* into a hidden slot rather than duplicated, because two fields sharing a name make
 * `FormDataExtended` return an array.
 */

import { MODULE_ID } from "../constants.mjs";
import { TIER, TIER_NAME } from "../model/tiers.mjs";
import { darknessTable, tierFromDarkness } from "../render/levels.mjs";

/** Our own de-dup marker. Per-feature, never a shared utility class. */
const MARKER = "pf1-lighting-scene-tier";

/** Applied to the core row whose input we have taken. */
const HIDDEN_ROW = "pf1-lighting-moved";

/** `flags.pf1-lighting.tier` — the chosen tier, and the reason this module exists. */
export const TIER_FLAG = "tier";
const FLAG_PATH = `flags.${MODULE_ID}.${TIER_FLAG}`;

/**
 * Tiers a scene's ambient can be, brightest first.
 *
 * Supernatural Dark is absent deliberately: it is not somewhere ambient light can *be*, only
 * somewhere a suppressor with the right floor can put you (see `tiers.stepTier`).
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

/* -------------------------------------------- */
/*  Keeping scenes in step with the table       */
/* -------------------------------------------- */

/**
 * Should this client be the one writing scene documents?
 *
 * @remarks
 * A world setting's `onChange` fires on **every** connected client, and a scene is a world
 * document, so without this the update would be attempted by players (who are refused) and by
 * every GM at once (who would each issue the same write). `activeGM` is Foundry's own answer to
 * "exactly one GM should do this".
 */
const isWriter = () => game.users?.activeGM?.isSelf === true;

/**
 * Bring scenes' stored darkness back in line with the tier they were set to.
 *
 * @remarks
 * **Locked scenes are skipped rather than attempted.** `Scene#_preUpdate` silently *deletes*
 * `environment.darknessLevel` from an update when `environment.darknessLock` is set
 * (`documents/scene.mjs:416-419`) — no error, no effect — so issuing the write anyway would
 * produce a readout claiming to have updated scenes it did not. They are counted separately.
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
    if (tier === null) continue; // Never set through this control; not ours to touch.
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
/*  The control                                 */
/* -------------------------------------------- */

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

/**
 * Suppress the change events our own writes provoke.
 *
 * @remarks
 * Assigning `.value` on one of Foundry's custom form elements **dispatches `input` and `change`**
 * (`applications/elements/form-element.mjs:89-92`). Driving core's darkness input from our
 * dropdown therefore re-enters the same delegated listener, and without this the two would push
 * each other around the form. Cheaper and more robust than reaching for `_setValue`, which is
 * protected and only exists on the custom elements — a plain `<input type="range">` would need
 * the guard anyway.
 */
let applying = false;

function markup(tier, drifted, locked) {
  const options = SCENE_TIERS.map(
    (value) =>
      `<option value="${value}"${value === tier ? " selected" : ""}>${esc(TIER_NAME[value])}</option>`
  ).join("");

  return `
<div class="form-group ${MARKER}">
  <label>Light level</label>
  <div class="form-fields">
    <select data-drives="darkness"${locked ? " disabled" : ""}>${options}</select>
  </div>
  <input type="hidden" name="${FLAG_PATH}" value="${tier}" data-dtype="Number">
  <span data-slot="darkness" hidden></span>
  <p class="hint">The scene's own light level, before any light or darkness on it. How dark
    each tier is drawn is set in this module's settings, and scenes follow when it changes.${
      drifted
        ? " <strong>This scene's stored darkness does not match its tier</strong> — saving will bring it into line."
        : ""
    }${locked ? " Darkness is locked on this scene, so this cannot be changed." : ""}</p>
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
  // No flag: show the nearest rung so the control reads sensibly, and write nothing until the
  // GM actually picks one.
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
    // Core previews any change whose field name contains `environment.`
    // (`scene-config.mjs:236`), so the preview comes from letting the real field's event reach
    // the sheet rather than from calling anything ourselves.
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
        ui.notifications?.warn(
          `PF1 Lighting: ${report.locked} scene(s) have darkness locked and were left unchanged.`
        );
      }
    });
  });

  // A safety net rather than the main path: the sync above covers every scene at the moment the
  // table changes, but a scene created or imported while a different table was in force — or by
  // a client that was not the active GM — arrives with a stale level. Checking the one scene
  // being drawn costs a comparison.
  Hooks.on("canvasReady", () => {
    if (canvas?.scene) syncScenes([canvas.scene]);
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
    // Scenes that predate the control, or were never set through it. Not a fault — they are
    // read by nearest rung and deliberately left alone.
    untiered: (game.scenes?.contents?.length ?? 0) - rows.length,
    scenes: rows,
  };
  console.error(`${MODULE_ID} | scene light levels`, report);
  return report;
}
