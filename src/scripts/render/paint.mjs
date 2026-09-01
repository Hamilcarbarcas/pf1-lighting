/**
 * What the darkness-level texture should say, for this observer. DESIGN.md §4.3, §7.0.
 *
 * `field()` answers how bright the ground is everywhere, god's eye, once per scene state. The right
 * decomposition for light sources and the wrong one for umbra, which is a property of the path
 * between an observer and a point (§4.3) and so has no god's-eye answer. This file is the seam: it
 * takes the field's cells, clamps them where the selected observer is looking through a darkness,
 * and hands the result to the painter.
 *
 * Not part of `renderer.rebuild()` because it runs on a different clock. The renderer is driven by
 * field staleness and ends by re-initialising every source whose clip changed — §9.5 measured source
 * construction as the dominant cost in the whole module. Umbra changes whenever an observer moves,
 * the most frequent event there is. Putting one behind the other would pay ~10 ms of source
 * construction per frame of a token drag to express something that costs a triangulation.
 *
 * So the two are split: sources rebuild when the scene changes, the texture repaints when either the
 * scene or the point of view changes. Nothing here constructs a source.
 *
 * Overlap is the mechanism now — reversed 2026-08-27. This section used to say the opposite, and the
 * reasoning was sound for the blend mode it assumed: `invalidateDarknessLevelContainer` sorts the
 * container by darkness level descending (`illumination-effects.mjs:106-110`), so under the default
 * blend an umbra laid over the ambient would be erased by it. The shadow was therefore cut into each
 * cell instead, keeping the output a disjoint set.
 *
 * §7.0 step 6 retired that constraint. Foundry registers `MIN_COLOR` and `MAX_COLOR` into
 * `PIXI.BLEND_MODES` at startup (`board.mjs:721-722`), and this channel holds a darkness level, so
 * `MAX` is darkest wins per fragment — what a clamp means (§4.3): nothing between two points can
 * make the far one brighter. A clamp is composited over the finished picture by {@link clampRamps}
 * rather than cut into it, and wins wherever it lands.
 *
 * `applyShadows` is still here and is off (`softClamps`). Leaving both on was worse than either: the
 * cut produces a flat hard-edged cell at the clamp level, and `max(hard, soft ramp)` is the hard one
 * everywhere inside it, so the cut silently defeated the ramp that replaced it. Kept behind the
 * switch because it is the whole of §4.3.1 and the bisection is one setting away.
 *
 * Several observers: §5.3's rule is `max` over observers of the resolved brightness, so a point
 * shadowed for one creature and lit for another is lit. Exact and cheap here rather than an
 * approximation, because
 *
 * ```
 * { p : max_o clamp_o(p) <= C }  ==  ∩_o { p : clamp_o(p) <= C }
 * ```
 *
 * — the region clamped to `C` or darker is the intersection of the observers' own such regions, and
 * an observer with no umbra short-circuits the whole pass to no clamp anywhere, which is correct and
 * is the common case the moment anyone has see in darkness.
 */

import { MODULE_ID, SETTING_RENDER } from "../constants.mjs";
import { flag } from "../settings-cache.mjs";
import {
  CLIPPER_SCALE,
  containsPoint,
  difference,
  fromClipperPaths,
  groupRings,
  intersection,
  splitRings,
  toClipperPath,
  union,
} from "../geometry.mjs";
import { TIER, tierOf } from "../model/tiers.mjs";
import * as field from "../model/field.mjs";
import * as umbra from "../vision/umbra.mjs";
import * as ambientTakeover from "./ambient.mjs";
import * as darknessTexture from "./darkness-texture.mjs";
import { CLAMP_SORT } from "./darkness-shaders.mjs";
import * as gradient from "./gradient.mjs";
import * as halo from "./halo.mjs";
import { darknessFor } from "./levels.mjs";
import { width as transitionWidth } from "./transition.mjs";
import * as lightRamps from "./light-ramps.mjs";
import * as fieldBlur from "./texture-blur.mjs";

let signature = null;
let lastStats = null;
/**
 * The field object the last completed pass painted from.
 *
 * @remarks
 * Separate from {@link signature}, which holds the field and every observer's `los` and so cannot
 * say which of them moved. This one answers only whether the ground's input changed, the question
 * the redundant half of the pass turns on.
 *
 * @type {object|null}
 */
let lastPaintedField = null;
/**
 * Which branch {@link shadowRegions} took last — `"unseen"` for the two-op closed form,
 * `"general"` for the per-observer fold. See {@link unseenOnly}.
 *
 * @type {"unseen"|"general"|null}
 */
let lastShadowPath = null;
/** The cells handed to the painter last time, for `ui/cell-overlay.levels`. @type {object[]|null} */
let lastCellList = null;
/** The composited ramps from the same pass — lights, halos and clamps. @type {object[]} */
let lastRampList = [];

/**
 * Announced after every repaint, so the debug overlay can follow without polling.
 *
 * A hook rather than an injected callback: `ui/cell-overlay.mjs` already imports this file, so a
 * callback would have to be wired the other way for one listener. Same reasoning as
 * `levels.TABLE_CHANGED_HOOK`.
 */
export const PAINTED_HOOK = `${MODULE_ID}.painted`;
let scheduled = false;

export const SETTING_HIDE_UNSEEN = "hideUnseenGround";
export const SETTING_SOFT_CLAMPS = "softClamps";

/**
 * Are the umbra and vision clamps composited as ramps, or cut into the ground cells?
 *
 * @remarks
 * The two express the same regions and cannot both be applied: the cut is flat and hard-edged, and
 * `MAX_COLOR` over it can only agree with it. On is §6.4.3's picture; off is §4.3.1's original one,
 * the fallback if a clamp lands somewhere it should not.
 */
export function softClamps() {
  // Cached — read three times in one pass and once more per merged ground region.
  return flag(SETTING_SOFT_CLAMPS, true);
}

/** Is unseen ground drawn dark? See {@link unseenRegionFor}. */
export function hideUnseen() {
  // Cached — `unseenRegionFor` asks once per observer per pass.
  return flag(SETTING_HIDE_UNSEEN, true);
}

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTING_HIDE_UNSEEN, {
    name: "Unseen ground is drawn dark",
    hint:
      "Treats a wall the way a darkness is already treated: ground the viewer cannot see is " +
      "drawn at Dark rather than at whatever the model says is there. Without it, a darkness " +
      "spell or an umbra stays visible through fog, because Foundry renders unseen ground from " +
      "the same texture this module writes its light levels into. Affects drawing only — what a " +
      "creature can see is unchanged.",
    scope: "world",
    // No control surface, matching the module's other corrections of core behaviour.
    config: false,
    type: Boolean,
    default: true,
    onChange: () => repaint({ force: true }),
  });

  game.settings.register(MODULE_ID, SETTING_SOFT_CLAMPS, {
    name: "Unseen and shadowed ground fades in",
    hint:
      "Composites the umbra and the edge of vision over the finished picture with a gradient, " +
      "instead of cutting them into the ground as flat hard-edged regions. Off restores the " +
      "original behaviour, which is the one to compare against if a clamp lands somewhere it " +
      "should not.",
    scope: "world",
    // No control surface, matching the module's other corrections of core behaviour.
    config: false,
    type: Boolean,
    default: true,
    onChange: () => repaint({ force: true }),
  });
}

/**
 * Both switches, because painting needs both.
 *
 * The setting is read from `constants.mjs` rather than from `renderer.mjs`, which registers it: the
 * renderer imports this module, so importing it back would be a cycle.
 */
function active() {
  if (!ambientTakeover.isEnabled()) return false;
  return flag(SETTING_RENDER);
}

/* -------------------------------------------- */
/*  Inputs                                      */
/* -------------------------------------------- */

/** Active vision sources, in a stable order so the signature is comparable. */
function observers() {
  return [...(canvas?.effects?.visionSources?.values() ?? [])].filter((s) => s.active);
}

/**
 * Cell kinds that say how bright the **ground** is, and therefore paint into the texture.
 *
 * @remarks
 * `clip`, `reduced` and `stack` are light and belong to sources. The rest are ground:
 *
 *   - `ambient` — the scene's own tier, where no suppressor governs
 *   - `dark` — a suppressor's region, at the transformed ambient tier
 *
 * `stack` was here and deliberately is not any more (2026-08-23). A flat fill in the texture could
 * not sit next to a light: `SWITCH_COLOR` blends a light's two zones across 72% of its ratio at the
 * default attenuation (`base-lighting.mjs:312-318`), so a light is nearly all gradient and a plateau
 * butted against it reads as a hard step. Stack cells are drawn by cloning their own emitters at a
 * raised level, reproducing the same curve — see `renderer.mjs`.
 *
 * The cost of that move is the umbra clamp: an overlap is a light now, and a light in an umbra dims
 * without clamping (§7.0). Accepted deliberately (2026-08-23) because the torches that made the
 * overlap already behave that way — the clamped stack cell was the one thing in the region that did
 * not.
 */
const GROUND_KINDS = new Set(["ambient", "dark"]);

/** The field's paintable cells: everything whose job is to say how bright the ground is. */
function baseCells() {
  const out = [];
  for (const cell of field.get().cells) {
    if (!GROUND_KINDS.has(cell.kind)) continue;
    if (cell.tier === undefined) continue;
    out.push(cell);
  }
  return out;
}

/**
 * Everything this observer cannot see, as a clamp region. DESIGN.md §4.3.1.
 *
 * @remarks
 * 2026-08-27, and the right shape for a reason worth writing down. The model already owns "this
 * observer cannot perceive here, so clamp it" — that is the umbra — and a wall is the most basic
 * case of not perceiving. Treating the two the same makes every unseen part of a scene render
 * consistently instead of showing whatever the model happened to paint there.
 *
 * It also resolves the leak three earlier patches missed. The darkness discs visible through fog
 * were `dark` regions in the darkness-level texture, not meshes — every darkness source on the scene
 * reports `parent: "none"`, `visible: false`, because §6.4.1's `darkeningStrength` withholds the
 * mesh for every tier but Supernatural Dark. §6.2.8 stopped fog reading that texture for its
 * replacement colour, which fixed the base; what remained came through the partial `mix` where the
 * vision mask is neither 0 nor 1. Clamping the ground itself removes the discs from the texture in
 * the first place, so there is nothing left to bleed through at any mask value — attacking the
 * source rather than each route out of it.
 *
 * Render-only, deliberately. This does not go through `umbra.clampAt`, so `perceivedTier` and every
 * mechanical consumer are untouched. §6.1 keeps model and picture agreeing by construction, and this
 * is a claim about drawing — a blindsighted creature perceives past a wall perfectly well, and a
 * model reporting Dark there would be wrong about the rules to fix something about pixels.
 *
 * @returns {{clamp: number, polygons: PIXI.Polygon[]}|null}
 */
function unseenRegionFor(source) {
  if (!hideUnseen() || !source?.los) return null;

  const rect = canvas?.dimensions?.sceneRect;
  if (!rect) return null;

  const outside = difference(
    [toClipperPath(rect.toPolygon(), CLIPPER_SCALE)],
    [toClipperPath(source.los, CLIPPER_SCALE)]
  );
  if (!outside.length) return null;

  // `los` comes back as a hole in the scene rect, wound against it, which is what `containsPoint`'s
  // even-odd test and `union`'s `pftNonZero` both expect.
  return { clamp: TIER.DARK, polygons: fromClipperPaths(outside, CLIPPER_SCALE) };
}

/**
 * The unseen-ground clamp for every observer at once, in two Clipper ops. DESIGN.md §9.10.
 *
 * @remarks
 * The whole pass collapses when nothing casts umbra, which is every scene with no magical darkness
 * on it — the common case, and the one this module spends most of its life in.
 *
 * With only `unseen` regions in play, {@link shadowRegions}'s general form asks for
 *
 * ```
 * ∩ₒ (rect \ losₒ)
 * ```
 *
 * one observer at a time: a `difference` per observer to build each complement, a `union` per
 * observer to collect it, and an `intersection` to fold them together. Six observers is 6 + 6 + 5 =
 * 17 Clipper ops per repaint, and core re-initialises vision every animation frame, so a token drag
 * ran it hundreds of times. A Clipper trace of one drag (2026-08-28) attributed 5,440 of 7,316
 * `Clipper.Execute` calls to exactly these three lines, and every op allocates an `IntPoint` per
 * vertex, which feeds the Major GC behind the stalls.
 *
 * De Morgan does it in two:
 *
 * ```
 * ∩ₒ (rect \ losₒ)  ≡  rect \ (∪ₒ losₒ)
 * ```
 *
 * — one `union` over every observer's `los`, one `difference` from the scene rect. Exact rather than
 * an approximation, and it drops the polygon round trip too: the general path converts each
 * complement to `PIXI.Polygon` in {@link unseenRegionFor} and straight back to Clipper paths in the
 * union below, where this never leaves path space.
 *
 * Parity with the general path, case by case, because this returns early and a divergence would be
 * silent:
 *
 * | Case | General path | Here |
 * | --- | --- | --- |
 * | `hideUnseen` off | `unseenRegionFor` → null → no regions → `[]` | `[]` |
 * | an observer with no `los` | same, `[]` | `[]` |
 * | an observer whose `los` covers the rect | its complement is empty → `[]` | `∪` covers the rect, so the difference is empty → `[]` |
 *
 * That third row is §5.3's rule and the reason the identity is the right one: a point one creature
 * can see is lit for everyone, so a single all-seeing observer clamps nothing anywhere.
 *
 * @param {PointVisionSource[]} sources
 * @returns {{clamp: number, paths: object[][]}[]}
 */
function unseenOnly(sources) {
  if (!hideUnseen()) return [];

  const rect = canvas?.dimensions?.sceneRect;
  if (!rect) return [];

  const seen = [];
  for (const source of sources) {
    // An observer with no line of sight sees nowhere, and the general path answers `[]` for it (its
    // `unseenRegionFor` is null, so `perObserver` has an empty entry). Match that.
    if (!source?.los) return [];
    const path = toClipperPath(source.los, CLIPPER_SCALE);
    if (path.length < 3) return [];
    seen.push(path);
  }
  if (!seen.length) return [];

  const rectPath = [toClipperPath(rect.toPolygon(), CLIPPER_SCALE)];
  const paths = difference(rectPath, union(seen));
  return paths.length ? [{ clamp: TIER.DARK, paths }] : [];
}

/**
 * Is this point outside every observer's line of sight, and so drawn dark?
 *
 * @remarks
 * The point-query form of {@link unseenOnly}, for the readout. §4.3.1's clamp is render-only and
 * deliberately never reaches `perceivedTier` — see {@link unseenRegionFor} — so the readout, which is
 * a view rather than a rules query, had no term for it and went on calling a walled-off room Bright
 * while the picture correctly had it dark (reported 2026-08-30). Exactly the failure §4.3's own
 * god's-eye bug was, one clamp later: the chip has to carry every term the picture carries.
 *
 * Exported from here rather than reimplemented in `ui/readout.mjs` so the two cannot drift — §6.1,
 * and the reason the readout does not simply test `los` itself. Three behaviours have to match and
 * none of them is obvious from outside: the `hideUnseen` gate, god's eye clamping nothing (§5.4), and
 * an observer with no `los` disabling the clamp everywhere rather than only for itself.
 *
 * @param {{x: number, y: number}} point
 * @returns {boolean}
 */
export function unseenAt(point) {
  if (!hideUnseen()) return false;

  const sources = observers();
  // God's eye. No observer, no fog, nothing to hide — §5.4.
  if (!sources.length) return false;

  for (const source of sources) {
    // Parity with `unseenOnly`, which answers `[]` — no clamp anywhere — for a source with no line
    // of sight, rather than treating it as an observer who sees nothing.
    if (!source.los) return false;
    // §5.3: seen by one observer is seen. The first hit ends it.
    if (source.los.contains(point.x, point.y)) return false;
  }
  return true;
}

/**
 * Cumulative shadow regions, darkest tier first.
 *
 * @returns {{clamp: number, paths: object[][]}[]} Each entry is everywhere clamped to this tier or
 *   darker — cumulative, not disjoint. {@link applyShadows} relies on that: it processes darkest
 *   first and skips cells already at or below the clamp, so the cumulative regions produce disjoint
 *   output with no extra difference.
 */
function shadowRegions() {
  const sources = observers();
  // God's eye. No observer, no path, no umbra — §5.4.
  if (!sources.length) return [];

  // Resolved once and reused below: `regionsFor` is cached, but calling it twice would make the fast
  // path's guard and the general path's input two separate reads of the same thing.
  const umbrae = sources.map((source) => umbra.regionsFor(source));

  // Nothing casts umbra, so there is one clamp and it has a closed form. See {@link unseenOnly} — 17
  // Clipper ops become 2 on the scenes that carry no magical darkness.
  if (umbrae.every((regions) => !regions.length)) {
    lastShadowPath = "unseen";
    return unseenOnly(sources);
  }
  lastShadowPath = "general";

  const perObserver = sources.map((source, i) => {
    const regions = umbrae[i];
    const unseen = unseenRegionFor(source);
    return unseen ? [...regions, unseen] : regions;
  });
  // One observer that shadows nothing means `max` over observers clamps nothing, anywhere. Also the
  // state when `umbraPerception` is off, which is why no separate check is needed.
  if (perObserver.some((regions) => !regions.length)) return [];

  const tiers = new Set();
  for (const regions of perObserver) for (const region of regions) tiers.add(region.clamp);
  // Darkest first. TIER ascends with brightness, so Supernatural Dark (0) leads.
  const ordered = [...tiers].sort((a, b) => a - b);

  const out = [];
  for (const clamp of ordered) {
    const perObserverPaths = perObserver.map((regions) =>
      union(
        regions
          .filter((region) => region.clamp <= clamp)
          .flatMap((region) => region.polygons.map((p) => toClipperPath(p, CLIPPER_SCALE)))
          .filter((path) => path.length >= 3)
      )
    );

    if (perObserverPaths.some((paths) => !paths.length)) continue;

    // `∩` across observers, exactly as the identity above requires. One observer needs none.
    let paths = perObserverPaths[0];
    for (let i = 1; i < perObserverPaths.length && paths.length; i++) {
      paths = intersection(paths, perObserverPaths[i]);
    }
    if (paths.length) out.push({ clamp, paths });
  }
  return out;
}

/* -------------------------------------------- */
/*  The split                                   */
/* -------------------------------------------- */

/** A cell's rings as Clipper paths — outer plus holes, which `pftNonZero` reads correctly. */
function cellPaths(cell) {
  const paths = [toClipperPath(cell.polygon, CLIPPER_SCALE)];
  for (const hole of cell.holes ?? []) {
    const path = toClipperPath(hole, CLIPPER_SCALE);
    if (path.length >= 3) paths.push(path);
  }
  return paths;
}

/**
 * Rebuild a cell over new geometry at a new tier.
 *
 * @remarks
 * `clamped` marks the piece the shadow took down, as against the piece that kept its own tier.
 * Nothing in the model reads it — a clamped cell and an ordinary one are both a polygon at a level —
 * but `render/gradient.mjs` does: a §3.4 spill band is drawn by a gradient mesh unless it was
 * clamped, in which case it is a constant again and is painted flat on top of the gradient. Stamping
 * it here lets that decision be made without re-deriving which cells came from a shadow further down
 * the pipeline.
 *
 * @param {object[][]} paths
 * @param {object} template
 * @param {number} tier
 * @param {boolean} [clamped] - Did a shadow put this piece at `tier`, or is it the cell's own?
 */
function cellsFromPaths(paths, template, tier, clamped = false) {
  return groupRings(fromClipperPaths(paths, CLIPPER_SCALE)).map(({ outer, holes }) => ({
    ...template,
    polygon: outer,
    holes,
    tier,
    clamped: clamped || template.clamped === true,
  }));
}

/**
 * Cut the shadow into the cells.
 *
 * @param {object[]} cells
 * @param {{clamp: number, paths: object[][]}[]} shadows - Darkest first
 * @returns {{cells: object[], ops: number, split: number}}
 */
function applyShadows(cells, shadows) {
  let working = cells;
  let ops = 0;
  let split = 0;

  for (const { clamp, paths } of shadows) {
    const next = [];
    for (const cell of working) {
      // The clamp only ever darkens (§4.3). A cell already at or below it is finished, and skipping
      // it here keeps the common scene down to a single split: with a Dark clamp, every `dark` cell
      // is already Dark or lower and only the ambient survives to be cut.
      if (cell.tier <= clamp) {
        next.push(cell);
        continue;
      }

      const subject = cellPaths(cell);
      const inside = intersection(subject, paths);
      ops++;
      if (!inside.length) {
        next.push(cell);
        continue;
      }

      const outside = difference(subject, paths);
      ops++;
      split++;

      next.push(...cellsFromPaths(inside, cell, clamp, true));
      next.push(...cellsFromPaths(outside, cell, cell.tier));
    }
    working = next;
  }

  return { cells: working, ops, split };
}

/* -------------------------------------------- */
/*  Clamp meshes — §7.0 step 6                  */
/* -------------------------------------------- */

/**
 * Minkowski offset in scene pixels; negative erodes.
 *
 * `jtMiter` for the reason `render/halo.mjs` gives at length: a round join curves every corner and
 * its segment count falls as the offset shrinks, so a small erosion facets a circle.
 */
function offsetPaths(paths, delta) {
  if (!paths.length || !delta) return paths;
  const co = new ClipperLib.ClipperOffset(2, 0.25);
  co.AddPaths(paths, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
  const out = new ClipperLib.Paths();
  co.Execute(out, delta * CLIPPER_SCALE);
  return out;
}

/**
 * The shadow regions as `MAX_COLOR` meshes, drawn after everything else.
 *
 * @remarks
 * Exists because §7.0 step 6 put light into the darkness-level texture, and that texture is
 * deliberately not vision-masked. A light source's illumination mesh is replaced in unseen area by
 * `VisualEffectsMaskingFilter`; a region written here is not, on purpose — it is what lets true
 * seeing and god's eye still read the map's real light levels (§7.0). Moving a torch's brightness
 * into it would have made the torch shine through walls, §4.3.1's bug arriving by a new route.
 *
 * `MAX` on the red channel is darkest wins per fragment, which is what a clamp means (§4.3): nothing
 * between two points can make the far one brighter. So the clamp is not cut into anything — it is
 * composited over the finished picture, after the ground and after the lights, and wins wherever it
 * lands.
 *
 * The cumulative regions {@link shadowRegions} returns overlap by construction, darker inside
 * brighter, and `MAX` resolves that correctly with no extra difference.
 *
 * {@link applyShadows} is deliberately still running. It cuts the same clamp into the ground cells,
 * so on ground this is redundant — `max(Dark, Dark)` — and the two agree by construction, reading
 * the same regions. Keeping both makes step 6 additive: §4.3.1 was hard won, and removing the cut in
 * the same change that introduced the composite would leave no way to tell which of them a
 * regression belonged to. The cut can come out once this is proven, and that is worth doing — it is
 * most of what a token drag costs.
 *
 * @param {{clamp: number, paths: object[][]}[]} shadows
 * @returns {object[]} Ramp payloads in `render/gradient.mjs`'s shape
 */
function clampRamps(shadows) {
  const out = [];
  let index = 0;

  const half = transitionWidth() / 2;

  for (const { clamp, paths } of shadows) {
    const { level } = darknessFor(clamp);
    const vertices = [];
    const levels = [];
    const indices = [];

    // The clamp's own edge ramps too (§6.4.3). Eroding the region and painting the collar as a ramp
    // from `level` down to 0 gives a soft vision boundary out of the same mechanism as every other
    // transition: zero is the brightest value the channel holds, and `max(x, 0)` is `x`, so the
    // outer end of the collar contributes nothing. The `MAX` mirror of the trick §7.0 step 6 plays
    // with `MIN` for a light's rim.
    //
    // The outer boundary only, which is the whole of the 2026-08-27 halo fix. A negative Clipper
    // offset shrinks the region, which grows every hole — so `offsetPaths(paths, -half)` put a
    // collar around each hole as well, and the umbra's holes are the darkness sources that cast it.
    // There the clamp faded to 0 over ground the observer cannot see, `MAX` let whatever was beneath
    // show through, and a light out-reaching its own darkness came back as a bright ring at the
    // darkness's rim — a gradient away from dark that the observer's perspective does not have, and
    // the collar was inventing one.
    //
    // Not a judgement about holes in general: a hole here is a boundary the clamp shares with
    // something at least as dark, so there is no step to soften. The hard edge that leaves is
    // softened by §6.4.4's field blur along with every other boundary nobody enumerated, and that
    // blur works on the composited field, so it cannot reveal a brighter value from beneath the way
    // this collar could.
    const rings = half > 0 ? fromClipperPaths(paths, CLIPPER_SCALE) : [];
    const { outers, holes } = half > 0 ? splitRings(rings) : { outers: [], holes: [] };
    const back = (polygons) => polygons.map((polygon) => toClipperPath(polygon, CLIPPER_SCALE));

    let core = paths;
    if (half > 0 && outers.length) {
      const eroded = offsetPaths(back(outers), -half);
      core = holes.length && eroded.length ? difference(eroded, back(holes)) : eroded;
    }
    const collar = half > 0 && core.length && core !== paths ? difference(paths, core) : [];

    const emit = (rings, levelFor) => {
      for (const { outer, holes } of groupRings(fromClipperPaths(rings, CLIPPER_SCALE))) {
        if (!(outer?.points?.length >= 6)) continue;
        const points = holes?.length ? Array.from(outer.points) : outer.points;
        const holeIndices = [];
        for (const hole of holes ?? []) {
          if (!(hole?.points?.length >= 6)) continue;
          holeIndices.push(points.length / 2);
          for (const value of hole.points) points.push(value);
        }

        const tri = PIXI.utils.earcut(points, holeIndices.length ? holeIndices : null, 2);
        if (!tri.length) continue;

        const base = vertices.length / 2;
        for (let i = 0; i < points.length; i += 2) {
          vertices.push(points[i], points[i + 1]);
          levels.push(levelFor({ x: points[i], y: points[i + 1] }));
        }
        for (const i of tri) indices.push(base + i);
      }
    };

    // The interior is the clamp outright; the collar fades it out across the boundary. A vertex
    // still inside the eroded core is the inner end of the ramp, everything else the outer.
    emit(core.length ? core : paths, () => level);
    if (collar.length) {
      const coreRings = fromClipperPaths(core, CLIPPER_SCALE);
      emit(collar, (point) => (containsPoint(coreRings, point) ? level : 0));
    }

    if (indices.length < 3) continue;

    out.push({
      id: `${MODULE_ID}.clamp.${clamp}.${index++}`,
      kind: "clamp",
      blendMode: "MAX_COLOR",
      sortLevel: CLAMP_SORT,
      nominal: level,
      vertices: new Float32Array(vertices),
      levels: new Float32Array(levels),
      indices: new Uint32Array(indices),
      bounds: canvas.dimensions.sceneRect.clone(),
      // No outline, so `getDarknessLevel` never answers from a clamp. It covers most of the map when
      // an observer is in a corridor, and a point query there should report what the ground is, not
      // what this observer can see of it — the same argument the seam backstop makes for staying out
      // of that query.
      outline: [],
      triangles: indices.length / 3,
    });
  }

  return out;
}

/* -------------------------------------------- */
/*  Driving it                                  */
/* -------------------------------------------- */

/**
 * Everything the painted result depends on, as references.
 *
 * @remarks
 * The same identity trick the umbra cache and `field.currentSignature` use, for the same reason: both
 * dependencies announce a change by becoming a different object. `field.get()` returns the same
 * object until the scene changes, and `source.los` is replaced by `_createShapes` rather than
 * mutated, so an observer stepping one pixel invalidates the pass and nobody else's movement does.
 *
 * That is what makes this safe to hang off `refreshToken`, which fires far above frame rate.
 */
function currentSignature() {
  const parts = [field.get()];
  for (const source of observers()) parts.push(source.los);
  return parts;
}

function matches(next) {
  if (!signature || signature.length !== next.length) return false;
  for (let i = 0; i < next.length; i++) if (signature[i] !== next[i]) return false;
  return true;
}

/**
 * Recompute and repaint the tier field for the current point of view.
 *
 * @param {object} [options]
 * @param {boolean} [options.force] - Repaint even if nothing it depends on changed
 * @returns {object|null}
 */
export function repaint({ force = false } = {}) {
  if (!canvas?.ready) return null;

  if (!active()) {
    if (lastStats) {
      gradient.clear();
      darknessTexture.clear();
      lastStats = null;
      signature = null;
    }
    return null;
  }

  const next = currentSignature();
  if (!force && matches(next)) return lastStats;
  signature = next;

  // Which half of this pass was wasted. The signature above is `[field, ...los]`, and an observer
  // walking replaces its own `los` every time vision re-initialises, so the pass reruns with the
  // field object identical. `shadowRegions` and `clampRamps` genuinely depend on the point of view;
  // the ground paint, the light ramps and the halos do not. Recording it turns "repaint is 7 ms"
  // into "6 ms of that had nothing to recompute".
  const currentField = field.get();
  const fieldStable = currentField === lastPaintedField;
  lastPaintedField = currentField;

  const t0 = performance.now();
  const base = baseCells();
  const tBase = performance.now();
  const shadows = shadowRegions();
  const tShadows = performance.now();

  // The cut is off, and leaving it on was actively wrong (2026-08-27: hard edges on wall shadows and
  // around a spill).
  //
  // §7.0 step 6 kept `applyShadows` running beside the new `MAX_COLOR` clamp meshes as
  // belt-and-braces, on the grounds that §4.3.1 was hard won and the two agree by construction. They
  // do agree, and that is the problem: the cut produces a flat cell at the clamp level with a hard
  // boundary, and `max(hard Dark, soft ramp)` is the hard one everywhere inside it. So the cut
  // silently defeated the ramp that replaced it, and every umbra and vision boundary on the map came
  // back with exactly the edge §6.4.3 had just removed.
  //
  // Kept behind a switch rather than deleted, because it is still the whole of §4.3.1 and a
  // bisection between a wrong clamp and a wrong ramp is one setting away.
  const cut = shadows.length && !softClamps();
  const { cells, ops, split } = cut
    ? applyShadows(base, shadows)
    : { cells: base, ops: 0, split: 0 };

  // §7.0 step 6 — the two passes that composite over the ground rather than being cut into it.
  // Lights first (`MIN_COLOR`, brightest wins), then clamps (`MAX_COLOR`, darkest wins); the sort
  // ladder in `render/darkness-shaders.mjs` is what puts them in that order.
  const tCut = performance.now();
  const lights = lightRamps.rampsFrom(currentField.cells, tierOf(currentField.stats?.ambientB ?? 0));
  const tLights = performance.now();
  const clamps = softClamps() ? clampRamps(shadows) : [];
  const tClamps = performance.now();
  // §6.4.3 — the ground's own boundaries, as ramps rather than as a blur.
  //
  // From `base`, not from the shadow-cut `cells` (2026-08-27: gradient applied inconsistently and
  // changing while lights are dragged). A cut introduces boundaries that are not brightness
  // boundaries at all — the umbra and the edge of vision, moving every frame an observer does, and
  // already carrying their own ramped mesh in `clampRamps`. Haloing them meant a second gradient on
  // the same edge, rebuilt from different geometry each frame. The model's own boundaries do not
  // move when a token walks.
  const halos = halo.halosFrom(base);
  // Cheap and idempotent: it compares one number and returns.
  fieldBlur.sync();
  const tHalos = performance.now();

  // Before the painter, because the painter asks whether a gradient exists.
  const ramps = gradient.sync([...halos, ...lights, ...clamps]);
  const tGradient = performance.now();
  lastCellList = cells;
  lastRampList = [...halos, ...lights, ...clamps];
  const painted = darknessTexture.paint(cells);
  const tGround = performance.now();

  lastStats = {
    base: base.length,
    painted,
    // §7.0 step 5/6. Every mesh that composites over the ground rather than partitioning it:
    // spill falloffs, light contributions, and the clamps that put unseen ground back to Dark.
    ramps,
    lights: lights.length,
    clamps: clamps.length,
    halos: halos.length,
    fieldBlur: fieldBlur.isEnabled(),
    shadows: shadows.length,
    // `split: 0` is the normal state now, the cut being off and the clamps composited instead — see
    // the note at `cut`. Only meaningful with `softClamps` turned off.
    split,
    softClamps: softClamps(),
    // §9.10. `"general"` on a scene with no magical darkness would mean the closed form is being
    // skipped, which is the difference between 2 Clipper ops per repaint and 17.
    shadowPath: lastShadowPath,
    ops,
    ms: +(performance.now() - t0).toFixed(2),
    // `fieldStable: true` means every `ground`, `lights` and `halos` millisecond below was spent
    // reproducing the previous answer. Only `shadows` and `clamps` are observer-dependent; see the
    // note where `fieldStable` is computed.
    fieldStable,
    stage: {
      base: +(tBase - t0).toFixed(2),
      shadows: +(tShadows - tBase).toFixed(2),
      cut: +(tCut - tShadows).toFixed(2),
      lights: +(tLights - tCut).toFixed(2),
      clamps: +(tClamps - tLights).toFixed(2),
      halos: +(tHalos - tClamps).toFixed(2),
      gradient: +(tGradient - tHalos).toFixed(2),
      ground: +(tGround - tGradient).toFixed(2),
    },
    ...(shadows.length && !split ? { quiet: explainQuiet(base, shadows) } : {}),
  };
  Hooks.callAll(PAINTED_HOOK, lastStats);
  return lastStats;
}

/**
 * Why did a live shadow cut nothing?
 *
 * @remarks
 * `shadows > 0, split: 0` is the most misleading state this pass can be in: it looks identical to a
 * broken clamp and is almost always correct. Two ordinary reasons, needing opposite responses, so
 * the readout names which:
 *
 *   - nothing to darken — the umbra falls on ground with no cell under it. At scene darkness 1 there
 *     is no `ambient` cell at all (`ambientB` is 0, so `field()` emits none), and the texture is
 *     already at its clear colour there. Correct, and invisible: umbra painting needs a lit scene to
 *     show anything.
 *   - already dark enough — every cell the shadow lands on is at or below the clamp. A Dark umbra
 *     over `dark` cells is a no-op by definition (§4.3, the clamp only darkens).
 *
 * The third possibility, a clamp that should have bitten and did not, is what is left when neither
 * line fits.
 */
function explainQuiet(base, shadows) {
  const darkest = Math.min(...shadows.map((s) => s.clamp));
  const above = base.filter((cell) => cell.tier > darkest).length;
  if (!base.length) return "no ambient or dark cells at all — a lit scene is needed to see this";
  if (!above) return `every cell is already at or below the clamp (tier ${darkest})`;
  return `${above} cell(s) above the clamp were not cut — the shadow may not reach them`;
}

/** Coalesce to one repaint per frame; the driving hooks fire well above frame rate. */
function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    repaint();
  });
}

export function registerHooks() {
  // `initializeVisionSources` is the signal that an observer's `los` was rebuilt, the umbra half;
  // the rest are the field half, matching the renderer's set for the same reasons (a light-bearing
  // token moving does not fire `initializeLightSources`).
  for (const hook of [
    "initializeVisionSources",
    "initializeLightSources",
    "refreshAmbientLight",
    "refreshToken",
    "canvasReady",
  ]) {
    Hooks.on(hook, () => schedule());
  }

  Hooks.on("canvasTearDown", () => {
    signature = null;
    lastStats = null;
    lastPaintedField = null;
    // The container these live in belongs to the old canvas; this is about dropping the module's
    // references, same as `renderer.mjs` does for the texture pool.
    gradient.dispose();
    fieldBlur.dispose();
  });
}

/**
 * The ground regions the painter was last given — `ui/cell-overlay.levels`'s input.
 *
 * Post-clamp, which is the point: it is what was *drawn*, not what the field computed.
 */
export function lastCells() {
  return lastCellList;
}

/** The light, halo and clamp meshes composited over those cells on the same pass. */
export function lastRamps() {
  return lastRampList;
}

/** Drop the cached signature so the next call recomputes. */
export function invalidate() {
  signature = null;
}

/**
 * Debug readout.
 *
 * @remarks
 * `shadows` above zero with `split` at zero is the interesting state and not a fault: the observer is
 * looking through a darkness, and every cell it falls on was already at or below the clamp. On an
 * unlit scene that is every cell, which is why umbra painting shows nothing there and a great deal
 * at noon.
 */
export function stats() {
  const report = {
    enabled: active(),
    observers: observers().length,
    umbraTiers: shadowTiers(),
    // §4.3.1. `true` with `observers: 0` is a god's-eye view and correctly clamps nothing — there is
    // no point of view to be unable to see from.
    hideUnseen: hideUnseen(),
    ...(repaint({ force: true }) ?? { note: "needs the renderer and 'Model global illumination'" }),
    texture: darknessTexture.status(),
    gradient: gradient.stats(),
    blur: fieldBlur.status(),
  };
  console.error(`${MODULE_ID} | tier paint`, report);
  return report;
}

/** Which clamp tiers are currently shadowing anything. */
const shadowTiers = () => shadowRegions().map((s) => s.clamp);
