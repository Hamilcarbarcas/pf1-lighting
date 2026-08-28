/**
 * Getting global illumination out of the way. DESIGN.md §7.0.
 *
 * The one missing piece behind three separate visible defects:
 *
 *   1. a *darkness* on a lit map is computed correctly and **drawn not at all** (§6.2.3);
 *   2. an umbra shadows what lies beyond it but **does not paint it** (§4.3 stage B);
 *   3. an ordinary darkness has no mesh, so its **animation does nothing** (§6.2.6).
 *
 * All three reduce to: global illumination is unconditional, so nothing can be darkened below
 * it. Illumination composites with `MAX_COLOR`, so a dimmer fill painted on top *loses* to the
 * ambient underneath. The global contribution has to be **absent** from the region, not
 * outvoted.
 *
 * ## This used to be a geometry problem, and it is not one
 *
 * The first build cut the ambient out by handing `GlobalLightSource` a `customPolygon` — the
 * scene rect with the darkness subtracted — and paying pooled stand-in light sources to fill
 * whatever the singleton could no longer reach. `customPolygon` holds **one closed ring, no
 * holes** (`polygon-mesher.mjs:22-26`, `visibility.mjs:639`), and "scene minus a darkness in
 * the middle" is exactly the shape that is not. Everything that followed — annulus splitting
 * across the whole scene, seam overlap, and four bugs that were each one un-cloned
 * `GlobalLightSource` property (`level`, then `dim`/`bright`, then the `darkness` band, then
 * the `globalLight` uniform) — was the cost of expressing a *number* as an *object*.
 *
 * The shader has the number already:
 *
 * ```glsl
 * if ( globalLight && ((computedDarknessLevel < globalLightThresholds[0])
 *                   || (computedDarknessLevel > globalLightThresholds[1])) ) discard;
 * ```
 *
 * `base-lighting.mjs:383`, and `computedDarknessLevel` is **per fragment**, sampled from the
 * darkness-level texture that `render/darkness-texture.mjs` now writes the model into. So
 * narrowing the upper threshold to {@link globalLightCutoff} makes global light discard
 * itself everywhere the model says the ground is darker than Dim — holes, islands and all,
 * with no polygon anywhere in the mechanism.
 *
 * What is left of this file is one uniform.
 *
 * ## Why the threshold and not the source's own data
 *
 * `data.darkness` looks like the natural place, and it is the wrong one.
 * `#refreshDynamicIllumination` tests the **scene's** darkness level against that same band to
 * decide whether to draw the global source into the visibility mask at all
 * (`visibility.mjs:637-640`). Narrowing it there would stop global light *revealing* the map
 * whenever the scene's slider sat above our cutoff, which has nothing to do with the question
 * being asked. The uniform reaches only the fragment test, which is the only test that should
 * change; the reveal half is handled per region, by the erasing meshes in
 * `render/darkness-texture.mjs`.
 */

import { MODULE_ID } from "../constants.mjs";
import {
  applyLightWeights,
  darknessTable,
  globalLightCutoff,
  restoreLightWeights,
} from "./levels.mjs";
import * as field from "../model/field.mjs";

/**
 * Is §7.0 step 6 drawing lights into the texture?
 *
 * @remarks
 * Read through the setting key rather than by importing `render/light-ramps.mjs`, which imports
 * `render/darkness-shaders.mjs` and sits downstream of this file in the render graph. Same rule
 * `render/paint.mjs` follows for the renderer's own switch.
 */
function lightsInTexture() {
  try {
    return game.settings.get(MODULE_ID, "lightsInTexture") === true;
  } catch {
    return false;
  }
}

export const SETTING_AMBIENT = "ambientTakeover";

const PATCH_MARK = "pf1LightingAmbientPatched";

/**
 * Is the takeover active?
 *
 * @remarks
 * **Its own setting, separate from the renderer's, and default off.** Same reasoning as
 * `umbraPerception` against `perceptionEnabled`: this is the change that makes the *whole
 * map* render through this module rather than only the parts near a darkness, so its failure
 * mode is "the map looks slightly wrong" rather than "the darkness looks wrong". That is a
 * much worse thing to debug, and one toggle turns it back into a one-minute bisection.
 */
export function isEnabled() {
  try {
    return game.settings.get(MODULE_ID, SETTING_AMBIENT) === true;
  } catch {
    return false;
  }
}

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTING_AMBIENT, {
    name: "Model global illumination",
    hint:
      "Paints the model's five brightness tiers into Foundry's darkness-level texture, so a " +
      "darkness actually darkens a brightly lit map and every area reads at its true tier — " +
      "including under true seeing and god's eye. Quantises ambient brightness to the five " +
      "tiers. Requires the renderer.",
    scope: "world",
    // **No control surface, by decision (Patrick, 2026-08-26).** The functionality stays; the
    // switch was a development bisection aid and the module is past needing one in the menu.
    // Reachable from the console — see `game.pf1Lighting.settings`.
    config: false,
    type: Boolean,
    // Flipped from `false` with the control. See `suppression.mjs` for the reasoning.
    default: true,
    onChange: () => {
      if (!canvas?.ready) return;
      syncLightWeights();
      // The threshold is a uniform, so a refresh is enough for the lighting half; the meshes
      // are dropped by the renderer's own rebuild, which the perception update provokes.
      canvas.perception.update({ initializeLighting: true, refreshLighting: true, refreshVision: true });
    },
  });
}

/**
 * Put light sources on the same brightness ladder as the ambient, or take them off it.
 *
 * @remarks
 * Tied to this setting rather than to the renderer, because it is the same claim: *every area
 * reads at the tier the model says it is*, and a light whose zones are anchored somewhere else
 * breaks that claim exactly as a stand-in fill did. See `levels.deriveWeights` — with the stock
 * `weights.bright` of 1 a light's bright zone is `ambientBrightest` outright, immune to the
 * scene's darkness, our tier field and any umbra over it.
 *
 * Restoring is not optional housekeeping: `CONFIG.Canvas.lightLevels` is global and affects
 * every module on the canvas, so switching the setting off has to give it back untouched.
 */
export function syncLightWeights() {
  if (isEnabled()) applyLightWeights();
  else restoreLightWeights();
}

export function registerHooks() {
  // Ambient colours are per scene, and the weights are solved against them — so they have to be
  // re-derived on every canvas, not once at startup.
  Hooks.on("canvasReady", () => syncLightWeights());
}

/* -------------------------------------------- */
/*  The mixin                                   */
/* -------------------------------------------- */

/**
 * Mix over whatever global light source class is installed.
 *
 * @remarks
 * **Applied at `init`, unlike every other mixin in this module, and the difference is
 * load-bearing.** `EnvironmentCanvasGroup` builds its source in the constructor as a
 * non-writable value property (`environment.mjs:29-30`), and the canvas groups are created in
 * `Canvas#initialize()` (`board.mjs:582`) — long before `canvasInit` (`board.mjs:1024`). A
 * later patch changes the CONFIG slot and nothing else: the live singleton stays an instance
 * of the stock class and cannot be replaced.
 *
 * That failure is silent in the worst way — the mixin reports itself installed and the source
 * simply behaves as before. {@link status} therefore reports the CONFIG slot and the
 * *instance* separately.
 */
export function applyMixin() {
  const Base = CONFIG.Canvas.globalLightSourceClass;
  if (!Base || Base[PATCH_MARK]) return;

  CONFIG.Canvas.globalLightSourceClass = class extends Base {
    static [PATCH_MARK] = true;

    /**
     * @override
     * @remarks
     * `super` sets both thresholds from `this.data.darkness` every time
     * (`global-light-source.mjs:74-80`), so this can only ever narrow them, never leak: with
     * the setting off, or on a frame where the base writes first, the stock band is what
     * stands. Nothing needs restoring when the takeover is switched off.
     *
     * Only the **upper** bound moves. The lower one is the GM's "this light is for dark
     * scenes" control and means something we have no view on.
     */
    _updateCommonUniforms(shader) {
      super._updateCommonUniforms(shader);
      if (!isEnabled()) return;

      const u = shader.uniforms;
      if (!u.globalLightThresholds) return;

      // **Under §7.0 step 6 it contributes nothing at all**, and this is the second half of
      // Patrick's report that dark regions still tracked the scene's slider (2026-08-27).
      //
      // Narrowing the upper bound stops global light painting where the model says *darker than
      // Dim*, which was the whole point while the ground's brightness still came from light
      // sources. It leaves it painting everywhere else — and what it paints is
      // `mix(computedBackgroundColor, ambientBrightest, weightBright)`, a wash laid over the tier
      // the texture just wrote. So a Normal cell rendered brighter than ground at Normal, and the
      // wash appeared and vanished as the scene's darkness crossed the source's own
      // `darkness.min/max` band — a brightness change with no model change behind it, which is
      // exactly what the takeover exists to stop.
      //
      // An inverted band discards every fragment: `level < 1 || level > 0` is true for all of
      // `[0, 1]`. **The reveal half is untouched** — `#refreshDynamicIllumination` reads the
      // source's *shape* into the visibility mask (`visibility.mjs:637-640`), not this uniform, so
      // global illumination still lights the map for the purpose of what a creature can see. Only
      // its opinion about brightness is withdrawn, which the texture now owns outright.
      if (lightsInTexture()) {
        u.globalLightThresholds[0] = 1;
        u.globalLightThresholds[1] = 0;
        return;
      }

      u.globalLightThresholds[1] = Math.min(u.globalLightThresholds[1], globalLightCutoff());
    }
  };

  Object.defineProperty(CONFIG.Canvas.globalLightSourceClass, "name", {
    value: "PF1LightingGlobalLightSource",
  });
}

/* -------------------------------------------- */
/*  Diagnostics                                 */
/* -------------------------------------------- */

/**
 * Is the takeover live, and if it is doing nothing, **why**?
 *
 * @remarks
 * The last fields exist because the switch being on is not the same as it having anything to
 * do, and the difference is invisible on screen. §7.0 only bites where global illumination
 * actually contributes: a scene with global light disabled, or at full darkness, has no
 * ambient to cut and correctly renders exactly as before.
 *
 * Without this, "I turned it on and nothing changed" has two causes that look identical — the
 * feature is broken, or the scene never needed it. That is the shape of question this project
 * has lost the most time to.
 */
export function status() {
  const source = canvas?.environment?.globalLightSource;

  let ambientCells = null;
  let darkCells = null;
  let ambientB = null;
  try {
    const current = field.get();
    ambientCells = current.cells.filter((cell) => cell.kind === "ambient").length;
    darkCells = current.cells.filter((cell) => cell.kind === "dark").length;
    ambientB = current.stats.ambientB ?? null;
  } catch {
    /* canvas not ready */
  }

  const report = {
    enabled: isEnabled(),
    cutoff: globalLightCutoff(),
    table: { ...darknessTable() },
    // The solved light weights. `bright: 1` here means they are **not** installed, and a light's
    // bright zone is `ambientBrightest` regardless of anything the model says.
    lightLevels: { ...(CONFIG.Canvas.lightLevels ?? {}) },
    // The CONFIG slot. Necessary and **not sufficient** — see below.
    patched: CONFIG.Canvas.globalLightSourceClass?.[PATCH_MARK] === true,
    // **The live singleton.** These two can disagree, and when they do nothing works while
    // everything reports healthy: the group holds its source in a non-writable property built
    // in its constructor, so a CONFIG patch applied after `Canvas#initialize()` leaves an
    // instance of the stock class that can never be replaced.
    instancePatched: source?.constructor?.[PATCH_MARK] === true,
    active: source?.active ?? null,
    // The band as authored. The uniform is what we narrow; this stays the GM's value, and the
    // two disagreeing is the expected state rather than a fault.
    band: source?.data?.darkness ? { ...source.data.darkness } : null,

    // --- Does this scene give the takeover anything to do? ---
    globalLightEnabled: canvas?.scene?.environment?.globalLight?.enabled ?? null,
    darknessLevel: canvas?.environment?.darknessLevel ?? null,
    // 0 means global illumination contributes nothing, so there is nothing to cut out and
    // nothing will look different however the setting is set.
    ambientB,
    ambientCells,
    darkCells,
  };
  console.error("PF1 Lighting | ambient takeover", report);
  return report;
}
