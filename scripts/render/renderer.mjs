/**
 * The renderer — DESIGN.md §6, §8.2 step 3.
 *
 * Takes `field()`'s cells and puts them on the screen. Three jobs, one per cell kind:
 *
 *   `clip`     narrow the **real** source to the cell, so flicker, colour and falloff
 *              survive (§6.1). This is the point of the whole design.
 *   `reduced`  a pooled synthetic at the emitter's origin with radii shifted one zone
 *              inward, so suppressed light keeps its gradient (§6.2.2).
 *   `dark`     the **real darkness source**, clipped to the region it governs and scaled
 *              to darken by exactly the amount the model computed (§6.2.3).
 *
 * Everything is pooled (§9.5) and driven off the field's own staleness detection, so a
 * frame in which nothing changed costs one reference comparison.
 */

import { MODULE_ID } from "../constants.mjs";
import { isNativeSuppressionDisabled } from "../suppression.mjs";
import * as field from "../model/field.mjs";
import {
  emitters as registryEmitters,
  suppressors as registrySuppressors,
} from "../model/registry.mjs";
import { TIER, tierOf } from "../model/tiers.mjs";
import * as clip from "./clip.mjs";
import * as pool from "./pool.mjs";


export const SETTING_RENDER = "renderEnabled";

let lastField = null;
let lastStats = null;
let scheduled = false;

/**
 * Coalesce rebuild requests to at most one per frame.
 *
 * @remarks
 * The hooks that drive the renderer fire far above frame rate — `refreshAmbientLight`
 * once per light per refresh, and the lighting layer refreshes constantly while it is the
 * active control layer. Calling `rebuild` directly from each of those meant a full
 * rebuild many times per frame whenever anything actually changed, which is where the lag
 * came from.
 *
 * Nothing is lost by deferring: the render only has to be right by the time the frame is
 * drawn.
 */
function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    rebuild();
  });
}

const active = () => {
  try {
    return game.settings.get(MODULE_ID, SETTING_RENDER) === true;
  } catch {
    return false;
  }
};

/** Polygon area, for picking which piece of a split cell the real source keeps. */
function area(polygon) {
  return Math.abs(polygon?.signedArea?.() ?? 0);
}

/**
 * How hard a darkness source should darken, 0..1 — currently all-or-nothing.
 *
 * @remarks
 * **A `PointDarknessSource` is not a dimmer, and trying to use it as one failed.**
 *
 * The attempt was to scale `colorationAlpha` so a *darkness* on a lit map would take the
 * area down exactly one tier. Three things defeat it, and none is a tuning problem:
 *
 *   1. The shader darkens relative to **what is already rendered**, not relative to
 *      ambient. On ground already dim, any subtraction goes below the ambient floor, so
 *      the area reads *darker* than surrounding unlit ground rather than one step down.
 *   2. `enableVisionMasking` includes `|| !game.user.isGM`
 *      (`point-darkness-source.mjs:211`), so the same source renders differently for the
 *      GM than for a player. No alpha value reconciles that.
 *   3. It carries a padded `_visualShape` and a mesh scaled to the padded radius, all
 *      built for rendering supernatural darkness specifically.
 *
 * So darkness sources now do the one job they were designed for — Supernatural Dark —
 * and everything else is expressed by clipping light away, which is exact.
 *
 * **Target Dark** needs no source: removing the light *is* the render.
 * **Target above Dark** — a *darkness* at noon capping at Normal — cannot be drawn at
 * all without lowering ambient inside a region, which means owning global illumination.
 * That is §7.1, and it is a real blocker rather than a deferred nicety. `evaluate()` and
 * the readout still report those correctly; only the paint is missing.
 */
function darkeningStrength(ambientTier, targetTier) {
  void ambientTier;
  return targetTier === TIER.SUPERNATURAL_DARK ? 1 : 0;
}

/**
 * Rebuild the render from the current field.
 *
 * @param {object} [options]
 * @param {boolean} [options.force] - Rebuild even if the field is unchanged
 * @returns {object|null} Statistics, or null if nothing was done
 */
export function rebuild({ force = false } = {}) {
  if (!canvas?.ready) return null;

  if (!active()) {
    if (lastField) reset();
    // Only on an explicit call. The hooks fire constantly and would drown the console.
    if (force) {
      ui.notifications?.warn(
        "PF1 Lighting | Renderer is disabled — enable 'Render the lighting model' in settings."
      );
    }
    return null;
  }

  if (!isNativeSuppressionDisabled()) {
    // Without this, Foundry clips light at darkness boundaries before the model ever sees
    // it, so the cells we render are computed from already-suppressed geometry.
    if (force) {
      ui.notifications?.warn(
        "PF1 Lighting | Renderer needs 'Disable native darkness suppression' to also be on."
      );
    }
  }

  const current = field.get();
  if (!force && current === lastField) return lastStats;
  lastField = current;

  const t0 = performance.now();
  pool.begin();

  // --- `clip` — group by emitter, since a cell may have been split into several rings
  //     (§6.2.1) and a source can only hold one shape. ---
  const byEmitter = new Map();
  for (const cell of current.cells) {
    if (cell.kind !== "clip" || !cell.emitter) continue;
    const list = byEmitter.get(cell.emitter) ?? [];
    list.push(cell);
    byEmitter.set(cell.emitter, list);
  }

  let clones = 0;
  const touched = new Set();
  const restage = new Set();

  for (const [emitter, cells] of byEmitter) {
    const source = emitter.source;
    touched.add(source);

    // Largest piece to the real source; the rest become clones carrying the same
    // animation config, so a split torch still flickers as one torch (§6.2.4).
    cells.sort((a, b) => area(b.polygon) - area(a.polygon));
    const [primary, ...rest] = cells;
    const split = cells.length > 1;

    if (clip.assign(source, primary.polygon)) restage.add(source);
    // A split cell's pieces must abut with no fade, or the seam shows — as a dark line
    // if they meet, or a bright one if they overlap (coloration blends additively).
    if (clip.setHardEdges(source, split)) restage.add(source);

    for (const cell of rest) {
      clones++;
      const clone = pool.fill({
        kind: "light",
        polygon: cell.polygon,
        x: source.x,
        y: source.y,
        elevation: source.elevation ?? 0,
        radii: emitter.radii,
        color: source.data?.color ?? undefined,
      });
      clip.setHardEdges(clone, true);
    }
  }

  // An emitter with no `clip` cell at all is fully suppressed. It has no cells, so it is
  // *not* reachable from `current.cells` — the registry is the only place it still
  // exists, and without this its stale clip would keep painting last frame's shape.
  for (const entry of registryEmitters()) {
    if (entry.isGlobal || touched.has(entry.source)) continue;
    if (clip.assign(entry.source, null)) restage.add(entry.source);
  }

  // --- `reduced` — gradient preserved via shifted radii (§6.2.2). ---
  let reduced = 0;
  for (const cell of current.cells) {
    if (cell.kind !== "reduced" || !cell.emitter) continue;
    reduced++;
    pool.fill({
      kind: "light",
      polygon: cell.polygon,
      x: cell.emitter.source.x,
      y: cell.emitter.source.y,
      elevation: cell.emitter.source.elevation ?? 0,
      radii: cell.radii,
      color: cell.emitter.source.data?.color ?? undefined,
    });
  }

  // --- `dark` — the region a suppressor governs, rendered by the suppressor itself. ---
  //
  // Routed through the **real darkness source**, not a synthetic fill, for the same
  // reason light is: it already has the right origin and animation, and reusing it keeps
  // one source per effect instead of two fighting over the same ground.
  //
  // A darkness source *subtracts*, which is what makes this work on a lit map. The tier
  // is ambient reduced one step, so a light source could never express it — but a
  // darkness source scaled to a fraction of full strength darkens the region *to* that
  // tier rather than to black. That is a *darkness* spell at noon dropping Bright to
  // Normal. See {@link darkeningStrength}.
  const bySuppressor = new Map();
  for (const cell of current.cells) {
    if (cell.kind !== "dark" || !cell.suppressor) continue;
    const list = bySuppressor.get(cell.suppressor) ?? [];
    list.push(cell);
    bySuppressor.set(cell.suppressor, list);
  }

  let fills = 0;
  let darkClones = 0;
  let blanked = 0;
  const litSuppressors = new Set();
  const ambientTier = tierOf(current.stats.ambientB ?? 0);

  for (const [suppressor, cells] of bySuppressor) {
    const source = suppressor.source;
    litSuppressors.add(source);

    cells.sort((a, b) => area(b.polygon) - area(a.polygon));
    const [primary, ...rest] = cells;
    const strength = darkeningStrength(ambientTier, primary.tier ?? TIER.DARK);

    // Strength 0 *is* the way to render nothing — no degenerate geometry needed. An
    // earlier version blanked the shape instead, which was both unnecessary and unsafe
    // (see the aliasing note in `clip._createShapes`).
    //
    // Almost everything lands here now: only Supernatural Dark is drawn by a darkness
    // source. Dark is rendered by the absence of light, and anything above Dark is not
    // renderable until §7.1. See {@link darkeningStrength}.
    if (strength <= 0) blanked++;
    else fills++;

    if (clip.assign(source, primary.polygon)) restage.add(source);
    clip.setStrength(source, strength);
    // Alpha alone does not stop a darkness source drawing (measured 2026-08-22), so
    // strength 0 withholds the mesh outright.
    clip.setHidden(source, strength <= 0);

    for (const cell of rest) {
      darkClones++;
      const bounds = cell.polygon.getBounds();
      const clone = pool.fill({
        kind: "darkness",
        polygon: cell.polygon,
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height / 2,
      });
      clip.setStrength(clone, darkeningStrength(ambientTier, cell.tier ?? TIER.DARK));
    }
  }

  // A suppressor with no `dark` cell was wholly cancelled — by a *daylight*, or by light
  // it cannot touch covering all of it. Stop it painting, without touching its geometry.
  for (const entry of registrySuppressors()) {
    if (litSuppressors.has(entry.source)) continue;
    if (clip.assign(entry.source, null)) restage.add(entry.source);
    clip.setStrength(entry.source, 0);
    clip.setHidden(entry.source, true);
  }

  pool.finish();

  // Re-run `_createShapes` on exactly the sources whose clip changed, by calling
  // `initialize()` with no data — that skips the data update but still rebuilds the shape
  // (`base-effect-source.mjs:206-224`).
  //
  // Deliberately **not** `perception.update({initializeLighting: true})`, which would be
  // the obvious way to do it. That fires the `initializeLightSources` hook, which calls
  // this function, which re-initialises sources, which allocates fresh unclipped
  // polygons, which changes the field signature, which recomputes the field, which
  // rebuilds — forever. Re-initialising directly stays inside the tick.
  for (const source of restage) source.initialize();
  canvas.perception.update({ refreshLighting: true });

  lastStats = {
    ms: +(performance.now() - t0).toFixed(2),
    clipped: byEmitter.size,
    clones,
    reduced,
    fills,
    darkClones,
    blanked,
    pool: pool.stats(),
  };
  return lastStats;
}

/** Drop every clip and park every pooled source, restoring stock rendering. */
export function reset() {
  lastField = null;
  lastStats = null;
  if (!canvas?.ready) return;

  for (const source of [...canvas.effects.lightSources, ...canvas.effects.darknessSources]) {
    clip.assign(source, null);
    clip.setLevel(source, undefined);
    clip.setStrength(source, undefined);
    clip.setHidden(source, false);
    clip.setHardEdges(source, false);
  }

  pool.begin();
  pool.finish();

  // Safe to use the broad signal here: with the renderer off, the hook's `rebuild()` call
  // returns immediately, so there is no cycle to fall into.
  canvas.perception.update({ initializeLighting: true, refreshLighting: true });
}

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTING_RENDER, {
    name: "Render the lighting model",
    hint:
      "Draws the scene using this module's model instead of Foundry's: light clipped at darkness " +
      "boundaries, five brightness tiers, darkness-spell semantics. Requires 'Disable native " +
      "darkness suppression' to also be on.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: (value) => (value ? rebuild({ force: true }) : reset()),
  });
}

export function registerHooks() {
  // Same signals as the overlay, and for the same reason: `initializeLightSources` does
  // not fire for an ordinary light-bearing token moving, so `refreshToken` is what keeps
  // a walking torch's cells current. Both are cheap because `field.get()` returns the
  // same object when nothing changed and `rebuild` bails on that.
  Hooks.on("initializeLightSources", schedule);
  Hooks.on("refreshToken", schedule);
  // Needed because a plain light does not request `initializeLighting` — only one that
  // creates edges does (`placeables/light.mjs:328`). Without this, dropping a dragged
  // light left the render showing its old position until something unrelated fired.
  Hooks.on("refreshAmbientLight", schedule);

  Hooks.on("canvasReady", () => {
    lastField = null;
    if (!active()) return;
    rebuild({ force: true });
    // Again on the next tick. On a page load the first pass can land before Foundry has
    // finished creating light sources, and if nothing subsequently fires one of our
    // hooks the render stays unapplied until the setting is toggled — which is exactly
    // what happened on F5.
    canvas.app?.ticker?.addOnce(() => rebuild({ force: true }));
  });

  Hooks.on("canvasTearDown", () => {
    lastField = null;
    lastStats = null;
    pool.dispose();
  });
}

/**
 * Debug readout.
 *
 * Always reports whether the renderer is even switched on. `null` alone could not
 * distinguish "disabled" from "ran and did nothing", which cost a diagnostic round trip.
 */
export function stats() {
  return {
    enabled: active(),
    nativeSuppressionDisabled: isNativeSuppressionDisabled(),
    ...(lastStats ?? { note: "no rebuild has run" }),
  };
}
