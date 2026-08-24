/**
 * The renderer — DESIGN.md §6, §8.2 step 3.
 *
 * Takes `field()`'s cells and puts them on the screen. One job per cell kind:
 *
 *   `clip`     narrow the **real** source to the cell, so flicker, colour and falloff
 *              survive (§6.1). This is the point of the whole design.
 *   `reduced`  a pooled synthetic at the emitter's origin with its set tier lowered
 *              inward, so suppressed light keeps its gradient (§6.2.2).
 *   `dark`     the tier into the **darkness-level texture** (§7.0), plus the real darkness
 *              source clipped to the region for Supernatural Dark's violet and animation.
 *   `ambient`  the same texture, at the scene's own tier.
 *
 * Note where the split falls: **sources carry light, the texture carries the ground.** A light
 * source can only add, and composites with `MAX_COLOR`, so nothing built out of one can express
 * "this area is one step dimmer than everything around it". The texture is a number per
 * fragment that every lighting *and vision* shader reads, which is both weaker and exactly
 * right — see `render/darkness-texture.mjs`.
 *
 * Everything is pooled (§9.5) and driven off the field's own staleness detection, so a
 * frame in which nothing changed costs one reference comparison.
 */

import { MODULE_ID, SETTING_RENDER } from "../constants.mjs";
import { isNativeSuppressionDisabled } from "../suppression.mjs";
import * as field from "../model/field.mjs";
import {
  emitters as registryEmitters,
  suppressors as registrySuppressors,
} from "../model/registry.mjs";
import { TIER, stepTier, tierOf } from "../model/tiers.mjs";
import { levelForTier } from "./levels.mjs";
import * as ambientTakeover from "./ambient.mjs";
import * as clip from "./clip.mjs";
import * as darknessTexture from "./darkness-texture.mjs";
import * as tierPaint from "./paint.mjs";
import * as pool from "./pool.mjs";


export { SETTING_RENDER };

/**
 * Draw band overlaps, or only *model* them.
 *
 * @remarks
 * §3.2.1's stacking is a rule about light levels and the model applies it unconditionally —
 * the readout, perception, the umbra and every mechanical consumer see a two-torch overlap as
 * Normal whatever this says. What it controls is whether the renderer *shows* it, by cloning
 * the participating emitters at a raised level.
 *
 * Off by default (Patrick, 2026-08-24): the overlaps read oddly, and a light level you can
 * query but cannot see is a normal state of affairs for this module — it is what the whole
 * §4.8 perception layer is built on. Separating the two costs one branch.
 */
export const SETTING_SHOW_STACKS = "showStackedOverlaps";

/** Draw an ordinary *darkness* that has an animation, for the animation alone. See {@link darkeningPlan}. */
export const SETTING_DARKNESS_ANIMATION = "darknessAnimationStrength";

const showStacks = () => {
  try {
    return game.settings.get(MODULE_ID, SETTING_SHOW_STACKS) === true;
  } catch {
    return false;
  }
};

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
 * So darkness sources do the one job they were designed for — Supernatural Dark — and every
 * other tier is expressed by clipping light away and writing the tier into the darkness-level
 * texture (§7.0). Both are exact, and neither is a scaled approximation of an effect built for
 * a different purpose.
 *
 * The `ambientTier` parameter is kept because the signature reads as though it should matter
 * and a future two-band source (§3.3.1) may make it so; today it does not.
 *
 * ## Except for animation — §6.2.6 revisited, 2026-08-24
 *
 * §6.2.6 recorded that an ordinary *darkness* cannot animate: strength 0 withholds the mesh,
 * and an animation is a fragment shader on a mesh. It concluded that a workaround was not worth
 * it, because "synthesising a mesh purely to carry an animation would mean a second source
 * fighting the first over the same ground".
 *
 * **That objection expired when §7.0 landed.** The texture owns the ground's brightness now, so
 * there is no fight: the source is not being asked to darken, only to draw. And the darkness
 * shader has exactly the dial that needs — the animation modifies `finalColor` *before* the
 * intensity scale is applied (`darkness-lighting.mjs:119`):
 *
 * ```glsl
 * finalColor *= (mix(color, color * 0.33, darknessLevel) * colorationAlpha);
 * ```
 *
 * So a small non-zero strength draws the mesh faintly: the animation plays, and the extra
 * darkening on top of the tier the texture already set is a tint rather than a second opinion.
 *
 * **Opt-in per source, by the GM's own choice of animation.** A darkness with no animation
 * configured stays exactly as it was — no mesh, no cost, no tint. Nothing changes for anyone
 * who has not asked for it, which is what makes a faint deliberate inaccuracy acceptable here.
 */
function darkeningPlan(ambientTier, targetTier, source) {
  void ambientTier;
  // The one tier a darkness source is actually good at, at its authored strength.
  if (targetTier === TIER.SUPERNATURAL_DARK) return { strength: 1, animationOnly: false };
  // Nothing to animate, or the GM has not asked for one: no mesh, exactly as before.
  if (!source?.data?.animation?.type || !animateDarkness()) {
    return { strength: 0, animationOnly: false };
  }
  // Draw it, contributing nothing but the animation. `strength` is the tint toward the
  // source's authored colour; 0 leaves the ground exactly at the tier the texture set.
  return { strength: 0, animationOnly: true };
}

const animateDarkness = () => {
  try {
    return game.settings.get(MODULE_ID, SETTING_DARKNESS_ANIMATION) === true;
  } catch {
    return false;
  }
};


/**
 * A light's two zones as Foundry lighting levels — DESIGN.md §3.2.1.
 *
 * @remarks
 * The whole content of the two-zone model, on the render side. The inner zone provides a set
 * tier and maps straight across; the band **raises** the prevailing level, so its tier depends
 * on what it is sitting on and has to be computed rather than looked up.
 *
 * Both go through {@link levelForTier} rather than a table lookup, because Foundry's levels are
 * **relative to the background** and the background is no longer always Dark (§7.0). A torch on
 * a Normal-lit map, capped at Normal, has to resolve to `UNLIT` — paint the ground exactly as it
 * is — where a table lookup would ask for `BRIGHT` and overshoot the ground it stands on.
 *
 * `base` is the scene's ambient tier and not a per-pixel value, which is the approximation this
 * makes: the shader has one uniform per zone per source, so a band crossing two differently lit
 * areas paints one level throughout. It matters only where a band overlaps *another light's*
 * inner zone, and the model stays exact there regardless — §6.3's standing bargain, mechanics
 * from the model and appearance from the shader.
 *
 * @param {object|null} emission
 * @param {number} base - The ambient tier the band raises from
 * @returns {{inner: number|undefined, band: number|undefined}} Foundry lighting levels
 */
function levelsFor(emission, base) {
  if (!emission) return { inner: undefined, band: undefined };
  const bandTier = Math.max(
    base,
    Math.min(stepTier(base, emission.steps ?? 1), emission.cap ?? emission.tier)
  );
  return {
    inner: levelForTier(emission.tier, base),
    band: levelForTier(bandTier, base),
  };
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
  // The ambient rung every relative band raises from (§3.2.1).
  const sceneTier = tierOf(current.stats.ambientB ?? 0);

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

    if (clip.assign(source, primary.clipped ? primary.polygon : null)) restage.add(source);
    // A split cell's pieces must abut with no fade, or the seam shows — as a dark line
    // if they meet, or a bright one if they overlap (coloration blends additively).
    if (clip.setHardEdges(source, split)) restage.add(source);

    // §3.2.1's two zones, onto Foundry's two level-correction uniforms. The inner zone paints
    // its set tier; the band paints one rung up from the ambient it sits on, ceiling `cap`.
    // Where two bands overlap the shader cannot sum — `MAX_COLOR` — and the `stack` cells
    // handle it through the darkness texture instead.
    const zones = levelsFor(emitter.emission, sceneTier);
    if (clip.setLevel(source, zones.inner, zones.band)) restage.add(source);

    for (const cell of rest) {
      clones++;
      const clone = pool.fill({
        kind: "light",
        polygon: cell.polygon,
        x: source.x,
        y: source.y,
        elevation: source.elevation ?? 0,
        emission: emitter.emission,
        color: source.data?.color ?? undefined,
        // **The comment above claimed this for months and the code never did it.** A split
        // cell's clones were built with no `animation`, so an animated light stopped animating
        // at the cut — the one place §6.2.1's "the seam is invisible" stops being true, because
        // a static piece next to a flickering one is not a seam, it is two different lights.
        // Reported 2026-08-23: the annulus split is invisible until the light animates.
        //
        // `seed` rides along so the pieces stay in phase; without it each clone starts its own
        // cycle and the cut shows as a beat rather than a line.
        animation: source.data?.animation,
        seed: source.data?.seed,
        // Passed in, not set afterwards. `_initializeSoftEdges` runs inside `initialize()`, so
        // the old `clip.setHardEdges(clone, true)` here landed a rebuild too late — and on a
        // pooled source it then never cleared. See the note in `pool.fill`.
        hardEdges: true,
      });
    }
  }

  // An emitter with no `clip` cell at all is fully suppressed. It has no cells, so it is
  // *not* reachable from `current.cells` — the registry is the only place it still
  // exists, and without this its stale clip would keep painting last frame's shape.
  for (const entry of registryEmitters()) {
    if (entry.isGlobal || touched.has(entry.source)) continue;
    if (clip.assign(entry.source, null)) restage.add(entry.source);
  }

  // --- `reduced` — the emitter's own geometry at a lowered set tier (§3.2.1). ---
  //
  // Was a radius shift (§6.2.2) until the two zones stopped meaning the same thing. Reduction
  // is now a change of *level*, so the light keeps both radii and simply paints dimmer, which
  // is both closer to the rule and one fewer transformation to get wrong.
  let reduced = 0;
  for (const cell of current.cells) {
    if (cell.kind !== "reduced" || !cell.emitter) continue;
    reduced++;
    const zones = levelsFor(cell.emission, sceneTier);
    pool.fill({
      kind: "light",
      polygon: cell.polygon,
      x: cell.emitter.source.x,
      y: cell.emitter.source.y,
      elevation: cell.emitter.source.elevation ?? 0,
      emission: cell.emission,
      level: zones.inner,
      bandLevel: zones.band,
      color: cell.emitter.source.data?.color ?? undefined,
    });
  }

  // --- `stack` — a band overlap, drawn by cloning the lights that made it. §3.2.1. ---
  //
  // **Not a fill, and the reason is the shape of a light rather than its brightness.** The
  // first version wrote the overlap into the darkness-level texture as a flat region at the
  // summed tier, which is what the model says is there and looked wrong anyway: `SWITCH_COLOR`
  // blends a light's two zones across 72% of its ratio at the default attenuation
  // (`base-lighting.mjs:312-318`) and `FALLOFF` ramps the outer half on top of that, so a
  // Foundry light is very nearly *all* gradient. A plateau butted against that reads as a step
  // however accurate its value — reported 2026-08-23 as the overlap standing out against the
  // light around it, twice, before the cause was the flatness rather than the number.
  //
  // So the overlap is drawn with the same curve it has to meet: one clone per participating
  // emitter, at that emitter's own origin, radii and attenuation, clipped to the region and
  // with its **band** level raised to the resolved tier. `MAX_COLOR` across the clones gives
  // `max(falloff_i)` with the rung added, which is the same function as `max(falloff_i)` just
  // outside the boundary — so the two sides differ by a level and not by a shape, and the soft
  // edge has something it can actually blend.
  //
  // One clone per emitter, not one per region: a single clone would only match wherever that
  // light happened to be the strongest of them.
  let stacked = 0;
  const drawStacks = showStacks();
  for (const cell of current.cells) {
    if (!drawStacks) break;
    if (cell.kind !== "stack" || !cell.emitters?.length) continue;
    const band = levelForTier(cell.tier, sceneTier);
    for (const emitter of cell.emitters) {
      const source = emitter.source;
      stacked++;
      pool.fill({
        kind: "light",
        polygon: cell.polygon,
        x: source.x,
        y: source.y,
        elevation: source.elevation ?? 0,
        emission: emitter.emission,
        level: levelForTier(emitter.emission?.tier ?? TIER.NORMAL, sceneTier),
        bandLevel: band,
        color: source.data?.color ?? undefined,
        // The three that make the clone's curve identical to the original's. Attenuation drives
        // both `SWITCH_COLOR` and `FALLOFF`, so a default here would reintroduce the step it is
        // here to remove.
        attenuation: source.data?.attenuation,
        softEdges: true,
        // A flickering torch's contribution to the overlap has to flicker with it, or the
        // region reads as a static patch pinned over moving light — the same failure the split
        // cell's clones had before they carried `animation`.
        animation: source.data?.animation,
        seed: source.data?.seed,
      });
    }
  }

  // `ambient` and `dark` cells do not belong to this pass at all — they say how bright the
  // *ground* is, which goes to the darkness-level texture and is **observer-relative** once
  // umbra is painted (§4.3). That runs on a different clock: see `render/paint.mjs`, called
  // once at the end.
  const takeover = ambientTakeover.isEnabled();

  // --- `dark` — the region a suppressor governs. Two things happen to it. ---
  //
  // Its **tier** goes to the darkness-level texture, collected below into `paint`. That is
  // what actually makes the ground read as Dim, Dark or anything else.
  //
  // Its **darkness source** is separately clipped to the region, for the one job a darkness
  // source is good at: Supernatural Dark's violet, and the animation the GM chose. It is not a
  // dimmer and cannot be made into one — see {@link darkeningPlan} — so every other tier
  // withholds the mesh and leaves the paint to the texture.
  const bySuppressor = new Map();
  for (const cell of current.cells) {
    if (cell.kind !== "dark" || !cell.suppressor) continue;
    const list = bySuppressor.get(cell.suppressor) ?? [];
    list.push(cell);
    bySuppressor.set(cell.suppressor, list);
  }

  let fills = 0;
  let darkClones = 0;
  let darkCells = 0;
  let blanked = 0;
  const litSuppressors = new Set();
  const ambientTier = sceneTier;

  for (const [suppressor, cells] of bySuppressor) {
    const source = suppressor.source;
    litSuppressors.add(source);

    cells.sort((a, b) => area(b.polygon) - area(a.polygon));
    const [primary, ...rest] = cells;
    const plan = darkeningPlan(ambientTier, primary.tier ?? TIER.DARK, source);
    const drawn = plan.animationOnly || plan.strength > 0;

    // Strength 0 *is* the way to render nothing — no degenerate geometry needed. An
    // earlier version blanked the shape instead, which was both unnecessary and unsafe
    // (see the aliasing note in `clip._createShapes`).
    //
    // Almost everything lands here: only Supernatural Dark is drawn by a darkness source.
    // Every other tier is painted by the darkness-level texture instead (§7.0), which is a
    // better answer than the one this branch was waiting for — it darkens by a *number*
    // rather than by scaling an effect built to darken to black.
    if (!drawn) blanked++;
    else fills++;

    if (clip.assign(source, primary.clipped ? primary.polygon : null)) restage.add(source);
    clip.setStrength(source, plan.strength, plan.animationOnly);
    // Alpha alone does not stop a darkness source drawing (measured 2026-08-22) — and lowering
    // it makes the darkness *harder*, not fainter — so not drawing is the only "off".
    clip.setHidden(source, !drawn);

    for (const cell of rest) {
      darkClones++;
      const bounds = cell.polygon.getBounds();
      const clone = pool.fill({
        kind: "darkness",
        polygon: cell.polygon,
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height / 2,
        // A split cell's pieces have to carry the animation too, or the darkness roils on one
        // side of the cut and sits still on the other — the same failure the light clones had.
        animation: source.data?.animation,
        seed: source.data?.seed,
      });
      const clonePlan = darkeningPlan(ambientTier, cell.tier ?? TIER.DARK, source);
      clip.setStrength(clone, clonePlan.strength, clonePlan.animationOnly);
    }

    // Counted here only for the readout; the painting itself is `render/paint.mjs`.
    if (takeover) darkCells += cells.filter((cell) => cell.tier !== undefined).length;
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

  // §7.0 / §4.3 — the ground's tiers, clamped for whoever is looking. Forced, because the
  // field just changed and `repaint` compares against the field it last painted.
  const painted = tierPaint.repaint({ force: true })?.painted ?? 0;

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
  // `initialize` reallocates every one of those sources' `shape`, and shapes *are* the field's
  // signature — so without this the field recomputes next frame purely because we re-meshed,
  // restages again, and the two chase each other at frame rate on an idle scene. See
  // `field.resync`.
  if (restage.size) field.resync();
  // `refreshVision` because the texture's second mesh per region lives in the **visibility**
  // mask (`vision.light.global.meshes`), and its `ERASE` blend is assigned by
  // `#refreshDynamicIllumination` — which only runs inside a visibility refresh. Without it a
  // newly painted region darkens but stays revealed by global light.
  canvas.perception.update({ refreshLighting: true, refreshVision: takeover });

  lastStats = {
    ms: +(performance.now() - t0).toFixed(2),
    clipped: byEmitter.size,
    clones,
    reduced,
    // §3.2.1 — synthetic clones drawn for band overlaps. Counts *clones*, not regions: a
    // two-band overlap contributes two, because both curves are needed to match the boundary.
    stacked,
    fills,
    darkClones,
    // §7.0. `dark` cells handed to the texture — above zero is the observable proof that a
    // *darkness* on a lit map is being drawn rather than merely computed.
    darkCells,
    // Cells handed to the darkness-level texture — `ambient` plus `dark`. Zero with the
    // takeover on means the field produced neither, which is a model question, not a paint one.
    painted,
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

  // Hand the scene's own darkness level back to Foundry. Meshes left painted would outlive
  // the renderer being switched off, and they are the one piece of state here that lives in a
  // container whose owner never asked for it.
  tierPaint.invalidate();
  darknessTexture.clear();

  // Safe to use the broad signal here: with the renderer off, the hook's `rebuild()` call
  // returns immediately, so there is no cycle to fall into.
  canvas.perception.update({ initializeLighting: true, refreshLighting: true });
}

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTING_DARKNESS_ANIMATION, {
    name: "Animate ordinary darkness",
    hint:
      "An ordinary darkness is drawn by removing light, so it has no surface of its own and " +
      "an animation picked in its config does nothing. This draws one that contributes only " +
      "the animation, leaving the light level exactly where the rules put it. Applies only to " +
      "a darkness that has an animation set; a deeper darkness already animates.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => rebuild({ force: true }),
  });

  game.settings.register(MODULE_ID, SETTING_SHOW_STACKS, {
    name: "Draw overlapping light bands brighter",
    hint:
      "Where two lights' outer bands overlap they raise the light level a further step. This " +
      "controls only whether that is drawn. The level is computed either way, so the readout, " +
      "what creatures can see, and every other rule still use it.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => rebuild({ force: true }),
  });

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
    // The containers our meshes live in belong to the old canvas and go with it, so this is
    // about dropping *our* references: a pooled entry pointing at a destroyed mesh would be
    // handed straight back out on the next scene.
    darknessTexture.dispose();
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
