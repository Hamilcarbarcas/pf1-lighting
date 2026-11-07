/**
 * Painting the umbra by withholding revelation, not by re-rendering. DESIGN.md §4.3, §7.0.
 *
 * A mask, not a light. The obvious construction treats an umbra as a suppressor region: inject it
 * into `field()`, let the renderer cut the lights and fill at the clamp tier. Accurate, and the
 * wrong layer — wall line-of-sight is smooth during motion, so the question is what Foundry does
 * that this would not (2026-08-23).
 *
 * Moving a token re-runs that token's own sweep and redraws a mask. It never touches a light
 * source. §9.5 measured that source construction dominates this module's cost, so hanging umbra off
 * the field would put the most expensive operation behind the most frequent event — roughly 10 ms
 * per frame of observer movement, untunable, because the work is real.
 *
 * The principle: per-scene facts belong in sources, per-observer facts belong in masks. An umbra is
 * per-observer by definition.
 *
 * `vision.light.mask` is assigned to the `mask` property of the `vision.light` container
 * (`visibility.mjs:404` — added as a child and set as the mask in one line, easy to read straight
 * past). So:
 *
 * ```
 * visible  =  (light.sources ∪ light.global ∪ light.cached)  ∩  light.mask   ∪   sight
 * ```
 *
 * `light.sources` is the union of every light on the scene and is not observer-relative, which
 * looked fatal — a lit room beyond a darkness is drawn there by its own torch. It is not, because
 * that union is intersected with `light.mask`: keep the umbra out of the mask and the room stops
 * being revealed, however brightly its torch burns.
 *
 * Darkvision falls out with no branch. `vision.sight` is a separate union drawn from
 * `visionSource.shape`, ungated by `light.mask` (`visibility.mjs:408`, `:579`), so withholding only
 * light perception blinds ordinary sight to a Dark umbra and leaves darkvision seeing through it —
 * §4.3's rule, obtained from Foundry's structure rather than by testing senses.
 *
 * Two mechanisms tried and rejected, both instructive.
 *
 * An `ERASE`-blended child of the mask: the obvious way to subtract, and it adds instead.
 * `vision.light.mask` is the `mask` property of `vision.light`, and PIXI renders a Graphics mask
 * through the stencil buffer, which ignores blend modes entirely. The umbra went into the stencil
 * as ordinary coverage, so the region it was meant to hide became the one region reliably revealed.
 * Core's `vision.darkness` gets away with `ERASE` by being a child of `vision`, composited to a
 * texture — not the same thing one level down.
 *
 * Swapping in a trimmed polygon and letting core draw it: nearly right, failing in exactly one
 * case. `light − umbra` yields a ring with a hole whenever the umbra is fully surrounded, and
 * `drawShape` takes a single contour, so keeping the largest ring fills the hole back in — a dark
 * umbra vanished while wholly enclosed and reappeared the moment any part of it reached the rim of
 * the light polygon. Reported 2026-08-23 with exactly that signature. The first version's comment
 * called dropping a ring the conservative error; it is the opposite, since a dropped hole
 * over-reveals.
 *
 * So core is handed an empty polygon and the mask contribution is drawn here instead, with
 * `beginHole`/`endHole` — the only version that survives a fully enclosed umbra.
 *
 * And it must be drawn during the refresh, not after. `refreshVisibility` ends by committing fog,
 * and the commit renders the whole `vision` container, so a contribution added once the method has
 * returned is correct on screen and invisible to exploration. That cost fog of war entirely for a
 * while (2026-08-24); see {@link drawPending}.
 *
 * It hides, it does not dim — a mask is binary. A limitation, but not the whole story: hiding and
 * dimming answer different questions, and this file was briefly deleted-in-place on the mistaken
 * belief that they were the same one.
 *
 * The division with `render/paint.mjs`, corrected 2026-08-23: the two compose, and the clamp tier
 * decides which does the work.
 *
 * | Clamp | Mechanism | Why |
 * | --- | --- | --- |
 * | below `SIGHT_TIER` | this file hides | Dark means the observer perceives nothing there; withholding the reveal is the honest render |
 * | `SIGHT_TIER` and above | the texture dims | Dim means they can see, so hiding would overstate the rule |
 *
 * They also overlap harmlessly on a Dark clamp, and usefully: the mask removes the region from
 * light perception while the texture still writes the tier, so a darkvision observer — whose
 * `vision.sight` is not gated by `light.mask` — gets the region revealed and rendered dark, which
 * neither mechanism produces alone.
 *
 * The wrong version stood this file down entirely whenever the texture was active, reasoning that
 * hiding beats dimming so the two cannot compose. True of one region, irrelevant here: a region's
 * clamp picks its mechanism, so the conflict never arises.
 *
 * Neither dims a region lit by a light source. The texture governs the background only, and a
 * light's mesh composites over it with `MAX_COLOR`, so Dim-clamped torchlight is still unexpressed.
 * Dark-clamped torchlight is fine, the mask removing the light's contribution outright (the
 * illumination layer is masked by the vision texture).
 */

import {
  CLIPPER_SCALE,
  difference,
  fromClipperPaths,
  groupRings,
  intersection,
  outsideRange,
  toClipperPath,
} from "../geometry.mjs";
import { HIDDEN, RENDER_SHAPE } from "../constants.mjs";
import * as field from "../model/field.mjs";
import { lowLightAmbient } from "../model/registry.mjs";
import { tierOf } from "../model/tiers.mjs";
import { darknessFor } from "../render/levels.mjs";
import * as obstructed from "../render/obstructed.mjs";
import * as carveWorker from "./carve-worker-client.mjs";
import * as motion from "./motion.mjs";
import { SIGHT_TIER } from "./perception.mjs";
import { regionsFor } from "./umbra.mjs";
import * as withheld from "../withheld.mjs";
import * as revealed from "../revealed.mjs";
import * as unexplored from "../unexplored.mjs";

const PATCH_MARK = "pf1LightingUmbraMaskPatched";

/** Handed to core in place of a trimmed polygon (`light` or `shape`); `drawShape` renders nothing. */
const EMPTY = new PIXI.Polygon([]);

/** Per observer, Clipper results kept until something they read changes. §9.14. */
const carveCache = new WeakMap();
/** A cut costing less than this, in milliseconds, stays here and never trails. */
const CUT_WORKER_ABOVE_MS = 1.5;
/** A source further than this from its last cut, in squares, is cut at once. */
const TRAIL_SQUARES = 4;
const revealCache = new WeakMap();
/** Light paths per elevation, for one state of the lights. */
let coverage = { version: null, byElevation: new Map() };

/** Bounds of Clipper paths. */
function boxOf(paths) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const path of paths) {
    for (const { X, Y } of path) {
      if (X < minX) minX = X;
      if (X > maxX) maxX = X;
      if (Y < minY) minY = Y;
      if (Y > maxY) maxY = Y;
    }
  }
  return { minX, minY, maxX, maxY };
}

/** A ring's bounds, kept: most rings come back unchanged step to step. */
const ringBoxes = new WeakMap();

function ringBox(path) {
  let box = ringBoxes.get(path);
  if (!box) ringBoxes.set(path, box = boxOf([path]));
  return box;
}

const boxesTouch = (a, b) => (a.minX <= b.maxX) && (b.minX <= a.maxX) && (a.minY <= b.maxY) && (b.minY <= a.maxY);

const sameList = (a, b) => (a.length === b.length) && a.every((item, i) => item === b[i]);

/** Moves on any light's (re-)initialisation, or one coming or going. */
function lightsVersion() {
  let sum = 0;
  let count = 0;
  for (const source of canvas?.effects?.lightSources?.values() ?? []) {
    sum += source.updateId ?? 0;
    count++;
  }
  return `${count}|${sum}`;
}

/** Core's fill for `vision.sight` (`groups/visibility.mjs:516`), read by the visibility filter's red channel. */
const SIGHT_FILL = 0xff0000;

let patched = false;

/** Is the carve installed? `api.withheld.active()`; DESIGN.md §4.3.2. */
export const isPatched = () => patched;

/**
 * Per-source contributions awaiting the `visibilityRefresh` hook, or null between refreshes. Each
 * entry is `{rings, preview, layer}`: the trimmed rings, whether core would have drawn this
 * source's polygon into the `.preview` graphics rather than the live ones, and which layer.
 *
 * @remarks
 * Module-scoped rather than closed over per call, so {@link drawPending} can be a plain listener
 * registered once and a refresh that throws before the hook leaves nothing for the next one to
 * draw.
 */
let pending = null;

/** Diagnostics for the last pass; see {@link status}. */
let lastPass = freshPass();

function freshPass() {
  return {
    observers: 0,
    // Totals across both layers. `drawn` must equal `trimmed`; see {@link status}.
    trimmed: 0, drawn: 0,
    trimmedLight: 0, trimmedSight: 0, drawnLight: 0, drawnSight: 0,
    // A trim that removed everything: swapped for EMPTY with nothing to draw. Not in `trimmed`.
    emptied: 0,
    // §4.3.3: revealed rings queued and drawn, per layer. Drawn must equal queued here too.
    revealedLight: 0, revealedSight: 0, drawnRevealLight: 0, drawnRevealSight: 0,
    // Raised-surface reveals no light reaches at their height: nothing drawn on the light layer.
    revealUnlit: 0,
    // §4.3.4: view moved to the preview graphics so fog does not explore it, per layer, queued and drawn.
    unexploredLight: 0, unexploredSight: 0, drawnUnexploredLight: 0, drawnUnexploredSight: 0,
    rings: 0, holes: 0, routedPreview: 0,
    // §4.3.5: observers with obstructed ground in their `los`, and its rings, for the obstructed mask.
    obstructedObservers: 0, obstructedRings: 0,
  };
}

/**
 * The umbra paths that actually hide something from this observer.
 *
 * @remarks
 * Only regions the observer cannot see at all. `SIGHT_TIER` is the dimmest tier ordinary sight
 * works in, so a Dim-clamped umbra is left alone — the observer can see there, and hiding it would
 * be a worse error than not dimming it.
 */
function blockingPaths(source) {
  const paths = [];
  for (const region of regionsFor(source)) {
    if (region.clamp >= SIGHT_TIER) continue;
    for (const polygon of region.polygons) {
      const path = toClipperPath(polygon, CLIPPER_SCALE);
      if (path.length >= 3) paths.push(path);
    }
  }
  return paths;
}

/**
 * A polygon with the given regions removed.
 *
 * @param {PIXI.Polygon} polygon
 * @param {object[][]} removed  Clipper paths
 * @returns {PIXI.Polygon[]|null} Rings to draw, or null to leave the polygon alone
 */
function trim(polygon, removed) {
  if (!polygon?.points?.length || !removed.length) return null;
  // One `difference` handles every region at once: Clipper unions the clip set under non-zero fill,
  // so no separate union pass is needed.
  const remaining = difference([toClipperPath(polygon, CLIPPER_SCALE)], removed);
  return fromClipperPaths(remaining, CLIPPER_SCALE);
}

/** A cut's inputs, less the rings that can't touch the polygon: Clipper's cost follows its input. */
function narrowed(polygon, removed, keep) {
  if (!polygon?.points?.length) return { polygon: null, removed: [], keep: [] };
  const box = boxOf([toClipperPath(polygon, CLIPPER_SCALE)]);
  return {
    polygon,
    removed: removed.filter((path) => boxesTouch(ringBox(path), box)),
    keep: keep.filter((path) => boxesTouch(ringBox(path), box)),
  };
}

/**
 * One layer of an observer's view, trimmed by `removed` (as {@link trim}) and split by `keep`, the
 * regions fog must not explore (§4.3.4): `live` is drawn as before, `preview` into the `.preview`
 * graphics. For light perception `removed` is §4.3's umbra plus every `light`-layer withheld region
 * (§4.3.2); for sight it is the withheld regions only, darkvision seeing through the umbra.
 * `live: null` leaves the source's own polygon alone, which is the case with nothing to remove or keep.
 *
 * @returns {{live: PIXI.Polygon[]|null, preview: PIXI.Polygon[]}}
 */
function split({ polygon, removed, keep }) {
  if (!keep.length) return { live: trim(polygon, removed), preview: [] };
  let paths = [toClipperPath(polygon, CLIPPER_SCALE)];
  if (removed.length) paths = difference(paths, removed);
  return {
    live: fromClipperPaths(difference(paths, keep), CLIPPER_SCALE),
    preview: fromClipperPaths(intersection(paths, keep), CLIPPER_SCALE),
  };
}

/**
 * Does global light reach a roof? Core draws it only inside its darkness range
 * (`groups/visibility.mjs:634-640`), and §6.2.12's sky erases it from every unfaded roof when the
 * outdoor tier is darker than Dim. Without a field, global light counts as reaching.
 */
function skyLit() {
  const global = canvas?.environment?.globalLightSource;
  if (!global?.active) return false;
  const { min, max } = global.data.darkness;
  const level = canvas.environment.darknessLevel;
  if ((level < min) || (level > max)) return false;
  let ambientB;
  try {
    ambientB = field.get()?.stats?.ambientB;
  } catch {
    return true;
  }
  if (!Number.isFinite(ambientB)) return true;
  return !darknessFor(lowLightAmbient(tierOf(ambientB))).erase;
}

/**
 * Light coverage at a height: the visibility shapes (as `clip.patchVisibility` hands them to core) of
 * every active light at or above it, core's own roof test (`base-lighting.mjs:394`).
 */
function coverageAt(elevation) {
  const version = lightsVersion();
  if (coverage.version !== version) coverage = { version, byElevation: new Map() };
  const hit = coverage.byElevation.get(elevation);
  if (hit) return hit;
  const paths = [];
  for (const source of canvas?.effects?.lightSources?.values() ?? []) {
    if (!source.active || (source instanceof foundry.canvas.sources.GlobalLightSource)) continue;
    if (source[HIDDEN] || !((source.elevation ?? 0) >= elevation)) continue;
    const path = toClipperPath(source[RENDER_SHAPE] ?? source.shape, CLIPPER_SCALE);
    if (path.length >= 3) paths.push(path);
  }
  const entries = paths.map((path) => ({ path, box: boxOf([path]) }));
  coverage.byElevation.set(elevation, entries);
  return entries;
}

/**
 * §4.3.3: queue this observer's revealed rings. Each layer's reveals lose whatever lies beyond that
 * layer's range (and, for light perception, §4.3's umbra), in one `difference` per layer. Withheld
 * regions do **not** apply (decided 2026-10-08): they carve what the observer sees of the ground, a
 * reveal is something its provider has already resolved as seen, and a roof's reveal lost to the
 * ground umbras of the walls beneath it showed as dark wedges across the roof. They are drawn into the `.preview` graphics, which show but which
 * fog's commit hides (`perception/fog.mjs:346-358`), so a reveal is never explored. A blinded source
 * reveals nothing; a layer with no range reveals nothing on that layer.
 *
 * A light-layer reveal tagged with an `elevation` (a raised surface's height) is also kept to the
 * light that reaches that height: lights at or above it, or everything when global light reaches
 * roofs. Visibility is planar, so without this a lamp inside a building counted as lighting its
 * revealed roof, and the roof showed exactly over the lamp's footprint (found 2026-10-08).
 */
function queueReveals(source) {
  if (!revealed.hasProviders() || source.isBlinded) return;
  try {
    const shown = revealed.collect(source);
    if (!shown.light.length && !shown.sight.length) return;
    const trimmed = trimmedReveals(source, shown);
    let sky = null;
    for (const group of trimmed.light) {
      let rings = group.rings;
      if (group.paths.length && (group.elevation !== null) && !(sky ??= skyLit())) {
        rings = coveredRings(group);
        if (!rings.length) lastPass.revealUnlit++;
      }
      if (!rings.length) continue;
      pending.push({ rings, preview: true, layer: withheld.LAYERS.LIGHT, reveal: true });
      lastPass.revealedLight++;
    }
    if (trimmed.sight.length) {
      pending.push({ rings: trimmed.sight, preview: true, layer: withheld.LAYERS.SIGHT, reveal: true });
      lastPass.revealedSight++;
    }
  } catch (error) {
    // Fail closed for reveals: a fault reveals nothing, and the rest of the pass is unaffected.
    console.error("PF1 Lighting | reveal trim failed", error);
  }
}

/**
 * Draw one observer's trimmed light perception into the mask, holes included.
 *
 * @remarks
 * `beginHole`/`endHole` is the reason this is done by hand — see the header. Same even-odd
 * reasoning as the umbra overlay: a ring wound against the largest one is a hole, and filling it is
 * the bug this replaced.
 *
 * Each outer is followed by its own holes. PIXI attaches a hole to the last shape drawn
 * (`GraphicsGeometry.drawHole`), so drawing every outer first put every hole on the last outer and
 * left holes in the others uncut (DESIGN.md §4.3.2, defect 1).
 */
function drawTrimmed(mask, rings, color = 0xffffff) {
  mask.beginFill(color, 1);
  for (const { outer, holes } of groupRings(rings)) {
    if (!outer.points?.length) continue;
    mask.drawPolygon(outer.points);
    lastPass.rings++;
    for (const polygon of holes) {
      if (!polygon.points?.length) continue;
      mask.beginHole();
      mask.drawPolygon(polygon.points);
      mask.endHole();
      lastPass.holes++;
    }
  }
  mask.endFill();
}

/**
 * Would core draw this source's light perception into `light.mask.preview`?
 *
 * @remarks
 * Core's own predicate for the live mask (`groups/visibility.mjs:585`), negated. Preview graphics are
 * hidden while fog commits (`perception/fog.mjs:346-358`), so a contribution drawn into the live mask
 * instead would explore what only a preview or a blinded source saw (DESIGN.md §4.3.2, defect 2).
 */
function drawsToPreview(source) {
  return !(source.lightRadius > 0) || source.isBlinded || source.isPreview;
}

/** The same for `vision.sight`: core keys it on `radius` (`groups/visibility.mjs:578`). */
function sightDrawsToPreview(source) {
  return !(source.radius > 0) || source.isBlinded || source.isPreview;
}

/**
 * Substitute trimmed light perception for the duration of one visibility refresh.
 *
 * @remarks
 * A prototype patch, and a second wrapper on `refreshVisibility` alongside `clip.patchVisibility` —
 * deliberately separate rather than merged, the two answering different questions on different
 * sides of the module's layering. Merging them would mean `render/` importing from `vision/`.
 *
 * `source.light` is a plain assigned property (`point-vision-source.mjs:232`), restored in a
 * `finally`. `los` is never touched, which matters: the umbra is computed from `los` and cached on
 * its identity, so modifying it would invalidate the cache that produced the modification.
 */
/** Identity of every input is enough: each is replaced when it changes. */
const sameCarve = (a, b) => (a.light === b.light) && (a.shape === b.shape) && (a.collected === b.collected)
  && (a.keep === b.keep) && (a.umbrae === b.umbrae);

const carveValue = (light, sight) => ({
  light: light.live,
  keptLight: light.preview,
  sight: sight.live,
  keptSight: sight.preview,
});

const polygonsOf = ({ live, preview }) => ({
  live: live && live.map((flat) => new PIXI.Polygon(Array.from(flat))),
  preview: preview.map((flat) => new PIXI.Polygon(Array.from(flat))),
});

/** May this cut go to the worker, with the last one standing in until it's back? §9.14. */
function trails(source, hit) {
  if (!motion.switches.trail || !motion.isMoving() || source.isPreview || (hit.ms < CUT_WORKER_ABOVE_MS)) return false;
  if (hit.elevation !== source.elevation) return false;
  const reach = TRAIL_SQUARES * (canvas.grid?.size ?? 100);
  if (Math.hypot(source.origin.x - hit.origin.x, source.origin.y - hit.origin.y) > reach) return false;
  return carveWorker.available();
}

/** One observer's carve. */
function carveFor(source, collected, keep) {
  const regions = regionsFor(source);
  const umbrae = regions.length ? regions : null;
  const inputs = { light: source.light, shape: source.shape, collected, keep, umbrae };
  const hit = carveCache.get(source);
  if (hit && (sameCarve(hit.inputs, inputs) || (hit.asked && sameCarve(hit.asked, inputs)))) return hit.value;

  const layers = {
    light: narrowed(source.light, [...blockingPaths(source), ...collected.light], keep.light),
    sight: narrowed(source.shape, collected.sight, keep.sight),
  };
  // A copy: core writes `source.origin` in place.
  const origin = { x: source.origin.x, y: source.origin.y };
  const { elevation } = source;
  if (hit && trails(source, hit)) {
    hit.asked = inputs;
    carveWorker.submit(source, layers, (result) => {
      if (carveCache.get(source) !== hit) return;
      if (hit.asked === inputs) hit.asked = null;
      if (result) {
        Object.assign(hit, {
          inputs, origin, elevation, ms: result.ms,
          value: carveValue(polygonsOf(result.light), polygonsOf(result.sight)),
        });
      }
      if (canvas?.ready) canvas.perception.update({ refreshVision: true });
    });
    return hit.value;
  }

  const start = performance.now();
  const value = carveValue(split(layers.light), split(layers.sight));
  carveCache.set(source, { inputs, value, origin, elevation, ms: performance.now() - start, asked: null });
  return value;
}

/** Is this observer's newest cut still on the worker? Asks for it if it hasn't been. §9.14. */
export function cutPending(source) {
  carveFor(source, withheld.collect(source), unexplored.collect(source));
  return !!carveCache.get(source)?.asked;
}

/** One observer's reveals, trimmed to its range and umbras, before light coverage. */
function trimmedReveals(source, shown) {
  const regions = regionsFor(source);
  const umbrae = regions.length ? regions : null;
  const { lightRadius, radius } = source;
  const hit = revealCache.get(source);
  if (hit && (hit.shown === shown) && (hit.umbrae === umbrae) && (hit.lightRadius === lightRadius)
    && (hit.radius === radius)) return hit;

  const light = [];
  if (shown.light.length && (lightRadius > 0)) {
    const outside = outsideRange(source.origin, lightRadius);
    const clip = [...blockingPaths(source), ...outside];
    // Nothing moves the clip but a finite range or an umbra, so unchanged paths keep their results,
    // light coverage included. A whole roof stays put as an observer walks.
    const reusable = hit && (hit.umbrae === umbrae) && !outside.length;
    const byElevation = new Map();
    shown.light.forEach((path, i) => {
      const elevation = shown.lightElevations?.[i] ?? null;
      if (!byElevation.has(elevation)) byElevation.set(elevation, []);
      byElevation.get(elevation).push(path);
    });
    for (const [elevation, group] of byElevation) {
      const prior = reusable ? hit.light.find((entry) => entry.elevation === elevation) : null;
      if (prior && sameList(prior.input, group)) {
        light.push(prior);
        continue;
      }
      const paths = difference(group, clip);
      light.push({ elevation, input: group, paths, rings: fromClipperPaths(paths, CLIPPER_SCALE), box: boxOf(paths), covered: null });
    }
  }
  const sight = (shown.sight.length && (radius > 0))
    ? fromClipperPaths(difference(shown.sight, outsideRange(source.origin, radius)), CLIPPER_SCALE)
    : [];
  const entry = { shown, umbrae, lightRadius, radius, light, sight };
  revealCache.set(source, entry);
  return entry;
}

/** A raised reveal group cut to the light that reaches its height, for this state of the lights. */
function coveredRings(group) {
  const version = lightsVersion();
  if (group.covered?.version === version) return group.covered.rings;
  // Only the lights that can touch it: a clip of every light on the scene is the expensive part.
  const lit = coverageAt(group.elevation).filter((entry) => boxesTouch(entry.box, group.box)).map((entry) => entry.path);
  const paths = lit.length ? intersection(group.paths, lit) : [];
  const rings = fromClipperPaths(paths, CLIPPER_SCALE);
  group.covered = { version, rings };
  return rings;
}

export function applyPatch() {
  if (patched) return;
  const proto = foundry.canvas.groups?.CanvasVisibility?.prototype;
  if (!proto?.refreshVisibility || proto[PATCH_MARK]) return;
  patched = true;
  proto[PATCH_MARK] = true;

  const original = proto.refreshVisibility;
  proto.refreshVisibility = function pf1LightingUmbraRefreshVisibility(...args) {
    lastPass = freshPass();

    // [source, property, original polygon]
    const swapped = [];
    pending = [];
    // §4.3.5: per observer, its obstructed ground clipped to `los` and its depth, for `render/obstructed.mjs`.
    const obstructedSets = [];

    // Swap one property for EMPTY and queue its trimmed rings; core then draws nothing for it.
    const substitute = (source, property, rings, layer, preview) => {
      swapped.push([source, property, source[property]]);
      // Core is given nothing to draw for this source; the trimmed version is drawn below, only a
      // hand-drawn contribution being able to carry holes.
      source[property] = EMPTY;
      if (!rings.length) {
        lastPass.emptied++;
        return;
      }
      pending.push({ rings, preview, layer });
      lastPass.trimmed++;
      if (layer === withheld.LAYERS.LIGHT) lastPass.trimmedLight++;
      else lastPass.trimmedSight++;
    };

    for (const source of canvas.effects?.visionSources ?? []) {
      if (!source.active) continue;
      lastPass.observers++;
      let light = null;
      let sight = null;
      let keptLight = [];
      let keptSight = [];
      try {
        const collected = withheld.collect(source);
        // §4.3.5: a preview or blinded source sees nothing it could be looking across.
        if (!source.isPreview && !source.isBlinded) {
          const entry = obstructed.entryFor(source, collected);
          if (entry) {
            obstructedSets.push(entry);
            lastPass.obstructedObservers++;
            lastPass.obstructedRings += entry.rings.length;
          }
        }
        // §4.3.4: the part of the view fog must not explore, split off into the preview graphics.
        ({ light, keptLight, sight, keptSight } = carveFor(source, collected, unexplored.collect(source)));
      } catch (error) {
        // A geometry fault must never stop the canvas drawing its visibility. Failing open leaves
        // the pre-umbra picture rather than a broken one.
        console.error("PF1 Lighting | umbra mask trim failed", error);
        light = sight = null;
        keptLight = keptSight = [];
      }
      if (light) substitute(source, "light", light, withheld.LAYERS.LIGHT, drawsToPreview(source));
      if (sight) substitute(source, "shape", sight, withheld.LAYERS.SIGHT, sightDrawsToPreview(source));
      if (keptLight.length) {
        pending.push({ rings: keptLight, preview: true, layer: withheld.LAYERS.LIGHT, unexplored: true });
        lastPass.unexploredLight++;
      }
      if (keptSight.length) {
        pending.push({ rings: keptSight, preview: true, layer: withheld.LAYERS.SIGHT, unexplored: true });
        lastPass.unexploredSight++;
      }
      queueReveals(source);
    }

    try {
      obstructed.publish(obstructedSets);
    } catch (error) {
      // Failing open: obstructed ground keeps whatever the mask last held, and the carve is unaffected.
      console.error("PF1 Lighting | obstructed mask update failed", error);
    }

    try {
      return original.apply(this, args);
    } finally {
      // `shape` is swapped for this one call only, and nothing that reads it for another purpose
      // runs inside it (§4.3.2; the §6.2.4 hazard is a persistent clip).
      for (const [source, property, polygon] of swapped) source[property] = polygon;
      // The draw happens in `visibilityRefresh`, mid-call — see {@link drawPending}. What is left
      // here is dropping anything the hook did not consume, so a throw before the hook cannot leave
      // stale rings for the next refresh.
      pending = null;
    }
  };

  // Ordering is the point of using the hook. Core calls `visibilityRefresh` immediately before its
  // `endFill`s and before `canvas.fog.commit()` (`groups/visibility.mjs:588-606`), the only window
  // where a contribution to `vision.light.mask` is both inside the fill and visible to fog.
  Hooks.on("visibilityRefresh", drawPending);
  Hooks.on("canvasTearDown", () => carveWorker.reset());
}

/**
 * Draw the trimmed light perception this refresh computed, into the mask core is still filling.
 *
 * @remarks
 * This used to run in the wrapper's `finally`, and that broke fog of war (found 2026-08-24, reported
 * as non-darkvision tokens clearing no fog at all and darkvision tokens clearing only their
 * darkvision radius).
 *
 * `refreshVisibility` ends with `if ( commitFog ) canvas.fog.commit()`, and `commit()` renders the
 * whole `vision` container, masked by `vision.light.mask` (`perception/fog.mjs:330-355`). Drawing
 * after `original` returned put the contribution in after that snapshot. The mask is a persistent
 * `LegacyGraphics`, so the screen was right from the next frame onward and only the exploration
 * texture was wrong — which is why it survived every visual check. A deferred write is invisible to
 * everything except the one consumer that reads mid-call.
 *
 * The symptoms follow from what was left in the mask at commit time. Each swapped source had been
 * handed {@link EMPTY}, so light perception contributed nothing, and `vision.sight` — a sibling of
 * `vision.light`, and so unmasked — was all fog ever saw. A token with no darkvision has
 * `visionSource.radius === 0` and draws no sight FOV, so it explored nothing; a token with
 * darkvision explored its darkvision radius and no further.
 *
 * `commitFog` is unaffected by the swap: core sets it from
 * `lightRadius > 0 && !blinded && !isPreview`, never from what the polygon contains, so an empty
 * shape still schedules the commit. That is why fog updated at all rather than freezing, which
 * would have been a much louder failure.
 *
 * @param {CanvasVisibility} visibility
 */
function drawPending(visibility) {
  const entries = pending;
  // Consume only what this module's wrapper set on this call. A `visibilityRefresh` raised from
  // anywhere else finds nothing, and the `finally` clears it if this was never reached.
  pending = null;
  if (!entries?.length) return;

  const vision = visibility?.vision;
  if (!vision) return;

  for (const { rings, preview, layer, reveal, unexplored: kept } of entries) {
    const isLight = layer === withheld.LAYERS.LIGHT;
    // Core's routing for this source, so a preview or blinded source's view shows without
    // exploring. See {@link drawsToPreview}. Reveals always go to preview (§4.3.3).
    const graphics = isLight ? vision.light?.mask : vision.sight;
    const target = preview ? graphics?.preview : graphics;
    if (!target) continue;
    try {
      // The mask is a stencil and ignores colour; `vision.sight` is read by its red channel.
      drawTrimmed(target, rings, isLight ? 0xffffff : SIGHT_FILL);
      if (reveal) {
        if (isLight) lastPass.drawnRevealLight++;
        else lastPass.drawnRevealSight++;
        continue;
      }
      if (kept) {
        if (isLight) lastPass.drawnUnexploredLight++;
        else lastPass.drawnUnexploredSight++;
        continue;
      }
      lastPass.drawn++;
      if (isLight) lastPass.drawnLight++;
      else lastPass.drawnSight++;
      if (preview) lastPass.routedPreview++;
    } catch (error) {
      console.error("PF1 Lighting | umbra mask draw failed", error);
    }
  }
}

/** The last pass's counters, copied, without logging or recomputing: for per-frame recorders. */
export const lastPassReport = () => ({ ...lastPass });

/**
 * Console readout.
 *
 * @remarks
 * The per-observer geometry is here because a bare pass/fail counter cannot separate the several
 * ways this goes quiet: a bounded `lightRadius` bounding the trim, a wall making the umbra genuinely
 * short, or every region resolving to Dim and being left alone deliberately.
 *
 * `holes` is worth watching. A dark umbra fully enclosed by a dim one produces exactly one, and
 * mishandling it is what made an enclosed umbra vanish.
 *
 * `drawn` must equal `trimmed`. They differ only if the `visibilityRefresh` hook did not reach
 * {@link drawPending} — the shape the fog-of-war bug had, and the shape it would have again if
 * anything swallowed that hook. The screen looks correct either way. The same holds per layer
 * (`drawnLight`/`trimmedLight`, `drawnSight`/`trimmedSight`). A trim that removed everything is
 * `emptied`, not `trimmed`, having nothing to draw.
 */
export function status() {
  const observers = [];
  for (const source of canvas?.effects?.visionSources ?? []) {
    if (!source.active) continue;
    const regions = regionsFor(source);
    const collected = withheld.collect(source);
    observers.push({
      id: source.sourceId,
      // §4.3.2: polygon counts by provider, and how many paths reached each layer.
      withheld: { ...collected.byProvider },
      withheldLight: collected.light.length,
      withheldSight: collected.sight.length,
      lightRadius: Math.round(source.lightRadius ?? 0),
      losRadius: Math.round(source.los?.config?.radius ?? 0),
      // Foundry returns `los` itself when unconstrained, so true means light perception is
      // scene-wide and cannot be limiting the shadow.
      lightIsLos: source.light === source.los,
      regions: regions.length,
      clamps: regions.map((r) => r.clamp),
      // Only regions below `SIGHT_TIER` hide anything. `blocking: 0` with `regions > 0` is the
      // documented Dim limitation rather than a fault.
      blocking: regions.filter((r) => r.clamp < SIGHT_TIER).length,
    });
  }

  const report = {
    patched,
    ...lastPass,
    motion: motion.status(),
    worker: carveWorker.workerStats(),
    providers: withheld.list(),
    revealProviders: revealed.list(),
    unexploredProviders: unexplored.list(),
    observers,
    // Not observer-relative: such a light draws its full polygon into `light.mask`
    // (`visibility.mjs:542-546`), and drawing a separate contribution does not remove it. A
    // non-zero count here is the remaining known hole in this approach.
    visionProvidingLights: [...(canvas?.effects?.lightSources ?? [])].filter(
      (s) => s.active && s.data?.vision
    ).length,
  };
  console.error("PF1 Lighting | umbra mask", report);
  return report;
}
