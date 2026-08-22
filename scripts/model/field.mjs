/**
 * `field()` — the whole-scene resolution. DESIGN.md §6.1, §6.2, §9.6.
 *
 * Where `evaluate()` answers "what is the light level *here*", this answers "what is the
 * light level *everywhere*", as a set of polygonal cells the renderer can draw. It is the
 * model's output and the renderer's entire input.
 *
 * ## What a cell is
 *
 * Cells partition space **by treatment** — by which suppressor, if any, applies. Within
 * one treatment region, cells for different emitters are allowed to overlap, because the
 * shader's `MAX_COLOR` blend is exactly the right answer there: light does not stack
 * (§4.2), so the brightest wins. What must never overlap is a cell at full strength with
 * a cell that was suppressed, and that cannot happen, because suppression is positional:
 * any point inside a suppressor is inside it for *every* emitter reaching that point.
 *
 * That is the invariant §6.1 step 1 is really asserting, and it is subtler than
 * "the cells are disjoint".
 *
 * ## Three kinds
 *
 * | Kind | Geometry | Rendered as |
 * | --- | --- | --- |
 * | `clip` | `E \ (blocking regions + self-cancelled)` | the real source, clipped — keeps flicker and colour |
 * | `reduced` | `E ∩ region` where the suppressor may transform but not remove | synthetic source at `E`'s origin, radii shifted (§6.2.2) |
 * | `dark` | the effective region, less any light it may only transform | synthetic flat fill at the transformed ambient tier |
 *
 * **A blocked emitter produces no cell inside the region at all** — it does not dim, it
 * stops counting (§3.3). Getting that wrong is what made a torch crossing a *darkness*
 * paint a lit lens over ground that should have been dark; caught by the cell overlay
 * once the same correction had already landed in `contest`.
 *
 * `reduced` cells use {@link transformRadii} rather than a flat fill, so light a
 * suppressor merely dims still falls off from its origin. With the `darkness` preset
 * they never occur for a placed light — anything not eligible either counters the
 * suppressor or annihilates with it — but other presets reach them, as will ambient once
 * §7.1 gives global illumination real geometry.
 *
 * ## Cost
 *
 * §9.6 measured this shape at 4.4 ms on a deliberately worse-than-RAW scene. The cost
 * model is op count: every Clipper call is roughly equal, so the `tight` pre-filter
 * exists to avoid calls, not to make them cheaper.
 */

import {
  ambientBrightness,
  emitters as registryEmitters,
  suppressors as registrySuppressors,
  version,
} from "./registry.mjs";
import { applyTransform, breaks, eligibilityFn } from "./contest.mjs";
import { transformRadii } from "./ramp.mjs";
import { TIER, tierOf } from "./tiers.mjs";

/** Core uses 100 wherever it touches Clipper (`common/constants.mjs:2146`). */
const SCALE = 100;

/** Recursion limit for annulus splitting; a shape needing this many cuts is pathological. */
const MAX_SPLIT_DEPTH = 8;

let opCount = 0;

/**
 * Holes resolved by {@link splitAnnuli} during the current compute.
 *
 * Counted here rather than by comparing path counts around the call: splitting one
 * annulus turns two paths (outer + hole) into two simple rings, so a length delta reports
 * zero and the diagnostic silently reads clean.
 */
let holeCount = 0;

/* -------------------------------------------- */
/*  Clipper                                     */
/* -------------------------------------------- */

function boolOp(subject, clip, clipType) {
  opCount++;
  const c = new ClipperLib.Clipper();
  c.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
  if (clip?.length) c.AddPaths(clip, ClipperLib.PolyType.ptClip, true);
  const solution = new ClipperLib.Paths();
  c.Execute(clipType, solution, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return solution;
}

const difference = (a, b) => boolOp(a, b, ClipperLib.ClipType.ctDifference);
const intersection = (a, b) => boolOp(a, b, ClipperLib.ClipType.ctIntersection);

function union(paths) {
  if (paths.length === 0) return [];
  if (paths.length === 1) return [paths[0]];
  return boolOp(paths, null, ClipperLib.ClipType.ctUnion);
}

function boundsOf(path) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of path) {
    if (p.X < minX) minX = p.X;
    if (p.X > maxX) maxX = p.X;
    if (p.Y < minY) minY = p.Y;
    if (p.Y > maxY) maxY = p.Y;
  }
  return { minX, minY, maxX, maxY };
}

const boxesOverlap = (a, b) =>
  !(a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY);

const touchesAny = (box, list) => list.some((b) => boxesOverlap(box, b));

function boundsOfPaths(paths) {
  const boxes = paths.map(boundsOf);
  return {
    minX: Math.min(...boxes.map((b) => b.minX)),
    minY: Math.min(...boxes.map((b) => b.minY)),
    maxX: Math.max(...boxes.map((b) => b.maxX)),
    maxY: Math.max(...boxes.map((b) => b.maxY)),
  };
}

const rectPath = (minX, minY, maxX, maxY) => [
  { X: minX, Y: minY },
  { X: maxX, Y: minY },
  { X: maxX, Y: maxY },
  { X: minX, Y: maxY },
];

/* -------------------------------------------- */
/*  Annulus splitting (§6.2.1)                  */
/* -------------------------------------------- */

/**
 * Split a Clipper solution into simple, hole-free rings.
 *
 * @remarks
 * A source shape is a single closed ring — `PolygonMesher` accepts one flat points array
 * and only ever *generates* holes internally, during offsetting (`polygon-mesher.mjs:23`).
 * But a suppressor sitting wholly inside an emitter makes `E \ S` an annulus, and we
 * cannot dodge it by leaving `E` whole, because `MAX_COLOR` would let the bright ring win
 * over the reduced cell inside it.
 *
 * The cut is a horizontal half-plane through the hole's centre, taken recursively. A hole
 * straddling the cut line becomes an indentation on each side rather than a hole, so each
 * pass removes at least one and the recursion terminates. Two ops per hole.
 *
 * Preferred over the keyhole-bridge alternative because a zero-width slit is precisely
 * the feature the soft-edge offsetting passes (§6.4) handle worst. The seam this leaves
 * sits inside a region of uniform tier, so it is invisible.
 *
 * §9.6 measured 7 annuli out of 119 cells on a deliberately extreme scene, 0 on a
 * realistic one — so this is real but not hot.
 *
 * @param {ClipperLib.IntPoint[][]} paths
 * @param {number} [depth]
 * @returns {ClipperLib.IntPoint[][]} Hole-free rings
 */
function splitAnnuli(paths, depth = 0) {
  if (paths.length <= 1) return paths;

  // Orientation alone doesn't say which ring is outer, so anchor on the largest by
  // absolute area and call everything running the other way a hole.
  let outer = paths[0];
  let outerArea = Math.abs(ClipperLib.Clipper.Area(paths[0]));
  for (const path of paths) {
    const area = Math.abs(ClipperLib.Clipper.Area(path));
    if (area > outerArea) {
      outer = path;
      outerArea = area;
    }
  }
  const outerSign = Math.sign(ClipperLib.Clipper.Area(outer));
  const holes = paths.filter((p) => Math.sign(ClipperLib.Clipper.Area(p)) !== outerSign);

  if (!holes.length) return paths;
  holeCount++;
  if (depth >= MAX_SPLIT_DEPTH) {
    // Give up on the holes rather than emit an unrenderable shape. Over-bright in a
    // small region beats a mesh that throws.
    console.warn(
      `pf1-lighting | field: annulus split hit depth ${MAX_SPLIT_DEPTH}; ` +
        `${holes.length} hole(s) dropped from a cell.`
    );
    return paths.filter((p) => Math.sign(ClipperLib.Clipper.Area(p)) === outerSign);
  }

  const all = boundsOfPaths(paths);
  const hole = boundsOf(holes[0]);
  const cutY = Math.round((hole.minY + hole.maxY) / 2);

  // The halves **abut exactly** — no overlap.
  //
  // An earlier version overlapped them, reasoning that each half's soft-edge fade would
  // hide under the other's solid interior and `MAX_COLOR` would keep the doubling
  // harmless. Wrong: `MAX_COLOR` is the *illumination* layer, while **coloration blends
  // additively**, so the overlap band rendered as a bright line rather than no line.
  //
  // The seam is handled at render time instead, by forcing hard edges on every piece of
  // a split cell (`HARD_EDGES`). With no inset there is no fade to hide, and two pieces
  // sharing an exact edge meet cleanly.
  const top = rectPath(all.minX - 1, all.minY - 1, all.maxX + 1, cutY);
  const bottom = rectPath(all.minX - 1, cutY, all.maxX + 1, all.maxY + 1);

  return [
    ...splitAnnuli(intersection(paths, [top]), depth + 1),
    ...splitAnnuli(intersection(paths, [bottom]), depth + 1),
  ];
}

/** Clipper paths → PIXI polygons, dropping degenerate rings. */
function toPolygons(paths) {
  const out = [];
  for (const path of paths) {
    if (path.length < 3) continue;
    const points = new Array(path.length * 2);
    for (let i = 0, j = 0; i < path.length; i++, j += 2) {
      points[j] = path[i].X / SCALE;
      points[j + 1] = path[i].Y / SCALE;
    }
    out.push(new PIXI.Polygon(points));
  }
  return out;
}

/* -------------------------------------------- */
/*  Suppressor regions                          */
/* -------------------------------------------- */

/**
 * Carve the suppressors into disjoint regions, each with exactly one winner.
 *
 * @remarks
 * §4.1 says the highest-level suppressor wins outright — no composition. So processing
 * in descending level order and subtracting everything already claimed yields regions
 * that each answer to a single suppressor, in `2N` ops. Without this, overlapping
 * suppressors with different transforms have no well-defined answer.
 *
 * Equal levels do *not* cancel each other here. §4.1's cancellation is between a
 * suppressor and an *emitter*; two darknesses of the same level simply overlap, and the
 * first to claim the ground keeps it, which is arbitrary but harmless since their
 * transforms are equal by construction.
 *
 * @param {object[]} suppressors - Registry entries, strongest first
 * @returns {{suppressor: object, paths: ClipperLib.IntPoint[][], boxes: object[]}[]}
 */
function carveRegions(suppressors) {
  const regions = [];
  let claimed = [];

  for (const suppressor of suppressors) {
    const path = suppressor.path(SCALE);
    if (!path) continue;

    const paths = claimed.length ? difference([path], claimed) : [path];
    if (paths.length) {
      regions.push({ suppressor, paths, boxes: paths.map(boundsOf) });
    }
    claimed = claimed.length ? union([...claimed, path]) : [path];
  }

  return { regions, claimed };
}

/* -------------------------------------------- */
/*  Where a suppressor actually has force       */
/* -------------------------------------------- */

/**
 * Reduce each region to the part where its suppressor is not defeated.
 *
 * @remarks
 * A higher-level magical light *counters* the suppressor within its radius, and a
 * *daylight* *annihilates* with it (§4.1.2). Both strip the suppressor of force over the
 * same geometry, so both are subtracted here; they differ only in what happens to the
 * emitter, which is handled in the emitter loop.
 *
 * `effective` is what everything downstream clips against. `paths` stays available
 * because a canceller has to know the *original* overlap in order to remove its own
 * light from it.
 */
function resolveRegions(regions, emitters) {
  for (const region of regions) {
    const breakers = emitters.filter((e) => breaks(e, region.suppressor));
    region.breakers = new Set(breakers);

    if (!breakers.length) {
      region.effective = region.paths;
    } else {
      const broken = union(breakers.map((e) => e.path(SCALE)));
      region.effective = difference(region.paths, broken);
    }
    region.effectiveBoxes = region.effective.map(boundsOf);
  }
  return regions.filter((r) => r.effective.length);
}

/**
 * Sort the regions touching one emitter into what they do to it.
 *
 * @remarks
 * Memoised on `(kind, level, cancelsDarkness)` — eligibility and precedence both depend
 * only on those, so every mundane torch on the scene shares an answer. That turns 53
 * per-emitter computations into one or two, and lets the *union* of blocking regions,
 * which is the part costing a Clipper op, be computed once per signature.
 */
function classifyRegions(emitter, regions, cache) {
  const key = `${emitter.kind}:${emitter.level}:${emitter.cancelsDarkness ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const blocking = [];
  const reducing = [];
  for (const region of regions) {
    // Re-tested rather than read off `region.breakers`, which is keyed by object
    // identity. `breaks` depends only on the memo signature, so the two always agree —
    // but relying on that silently would make the cache correct by coincidence.
    if (breaks(emitter, region.suppressor)) continue;
    const isEligible = eligibilityFn(region.suppressor.eligibility);
    (isEligible(emitter, region.suppressor) ? blocking : reducing).push(region);
  }

  const paths = blocking.flatMap((r) => r.effective);
  const entry = {
    blocking,
    reducing,
    union: paths.length ? union(paths) : [],
  };
  entry.boxes = entry.union.map(boundsOf);
  cache.set(key, entry);
  return entry;
}

/* -------------------------------------------- */
/*  The field                                   */
/* -------------------------------------------- */

/**
 * @typedef {object} Cell
 * @property {"clip"|"reduced"|"dark"} kind
 * @property {PIXI.Polygon} polygon - A simple, hole-free ring. **Treat as read-only:** on
 *   a scene with no suppressors this is the source's own `shape`, shared rather than
 *   copied, because copying it would be the only cost on the fast path.
 * @property {object|null} emitter - Registry entry this cell's light comes from
 * @property {object|null} suppressor - Registry entry that modified it
 * @property {object|null} radii - For `reduced`, the transformed radii to render with
 * @property {number|undefined} tier - For `dark`, the tier to fill at: ambient
 *   transformed by the suppressor and bounded by its floor, so a *darkness* cast at noon
 *   fills at Normal and one cast at midnight fills at Dark
 */

/**
 * Compute the whole-scene cell decomposition.
 *
 * @param {object} [options]
 * @param {boolean} [options.filter=true] - Apply the `tight` bounds pre-filter (§9.6).
 *   Off is for measurement and debugging only; it produces identical cells.
 * @returns {{generation: number, cells: Cell[], stats: object}}
 */
export function compute({ filter = true } = {}) {
  const t0 = performance.now();
  opCount = 0;
  holeCount = 0;

  const cells = [];

  // Tested on `shape`, not `path()`, so that scenes taking the fast path below never
  // build a Clipper path at all.
  const hasShape = (e) => e.shape?.points?.length > 0;

  // Global illumination has no polygon, so it cannot be clipped or cut. It is a
  // placeholder emitter until §7.1 makes it real — but its brightness still sets what a
  // suppressor transforms *down from*, so it is kept aside rather than discarded.
  const all = registryEmitters();
  const emitters = all.filter((e) => !e.isGlobal && hasShape(e));
  const ambient = all.find((e) => e.isGlobal) ?? null;

  // Strongest first, so `carveRegions` can subtract what is already claimed.
  const suppressors = [...registrySuppressors()].filter(hasShape).sort((a, b) => b.level - a.level);

  // --- No suppressors: every emitter renders untouched. The common case by far, and it
  //     must not cost a single Clipper op — nor a scale-and-round trip out to integer
  //     coordinates and straight back, which is what building a path here would be. The
  //     source's own polygon *is* the cell. ---
  if (!suppressors.length) {
    for (const emitter of emitters) {
      cells.push({
        kind: "clip",
        polygon: emitter.shape,
        emitter,
        suppressor: null,
        radii: emitter.radii,
      });
    }
    return finish(cells, t0, { filtered: filter, emitters: emitters.length, suppressors: 0 });
  }

  const carved = carveRegions(suppressors);
  const regions = resolveRegions(carved.regions, emitters);
  const cache = new Map();

  const emit = (kind, paths, emitter, suppressor, radii, tier) => {
    for (const polygon of toPolygons(splitAnnuli(paths))) {
      cells.push({ kind, polygon, emitter, suppressor, radii, tier });
    }
  };

  for (const emitter of emitters) {
    const path = emitter.path(SCALE);
    const box = boundsOf(path);
    const { blocking, reducing, union: blocked, boxes } = classifyRegions(emitter, regions, cache);

    // Where a *daylight* annihilated a suppressor it stops emitting too — the only place
    // in the model where a light's own output is shaped by a suppressor it defeated
    // (§4.1.2). Uses the region's *original* geometry, since `effective` is exactly the
    // part this emitter already carved away.
    const selfCancelled = emitter.cancelsDarkness
      ? carved.regions.filter((r) => r.suppressor.level <= emitter.level).flatMap((r) => r.paths)
      : [];

    const remove = [...blocked, ...selfCancelled];

    // Nothing removes light from this emitter anywhere. It renders whole, no Clipper.
    if (!remove.length || (filter && !selfCancelled.length && !touchesAny(box, boxes))) {
      emit("clip", [path], emitter, null, emitter.radii);
    } else {
      emit("clip", difference([path], remove), emitter, null, emitter.radii);
    }

    // `reduced` — a suppressor that is *not* entitled to remove this emitter still
    // transforms it. With the `darkness` preset this never fires for a placed light:
    // anything not eligible either counters the suppressor or annihilates with it. It is
    // reachable through other presets, and through ambient once §7.1 gives global
    // illumination real geometry.
    for (const region of reducing) {
      if (filter && !touchesAny(box, region.effectiveBoxes)) continue;
      const inside = intersection([path], region.effective);
      if (!inside.length) continue;
      emit(
        "reduced",
        inside,
        emitter,
        region.suppressor,
        transformRadii(emitter.radii, region.suppressor.transform)
      );
    }
  }

  // --- Fill, per region. ---
  //
  // Blocked emitters contribute **nothing** here, so the fill is the whole effective
  // region rather than only the parts no light reached. That was the bug: the old
  // version subtracted every emitter's polygon and dimmed them instead, which left a
  // lit-looking lens wherever a torch crossed a darkness.
  //
  // Only `reducing` emitters — light the suppressor may transform but not remove — are
  // carved out, because those do still light the ground.
  const ambientB = ambient ? ambient.brightnessAt() : 0;

  for (const region of regions) {
    const lighting = emitters.filter(
      (e) =>
        !breaks(e, region.suppressor) &&
        !eligibilityFn(region.suppressor.eligibility)(e, region.suppressor)
    );
    const fill = lighting.length
      ? difference(region.effective, union(lighting.map((e) => e.path(SCALE))))
      : region.effective;
    if (!fill.length) continue;

    // The tier is the *transformed ambient* level, not a fixed Supernatural Dark. At
    // noon a *darkness* drops Bright to Normal; at midnight it bottoms out at its floor.
    const B = applyTransform(ambientB, region.suppressor.transform, region.suppressor.floor ?? TIER.DARK);
    emit("dark", fill, null, region.suppressor, null, tierOf(B));
  }

  return finish(cells, t0, {
    filtered: filter,
    emitters: emitters.length,
    suppressors: suppressors.length,
    regions: regions.length,
    ambientB: +ambientB.toFixed(3),
  });
}

function finish(cells, t0, extra) {
  return {
    generation: version(),
    cells,
    stats: {
      cells: cells.length,
      byKind: cells.reduce((acc, c) => ((acc[c.kind] = (acc[c.kind] ?? 0) + 1), acc), {}),
      annuli: holeCount,
      ops: opCount,
      ms: +(performance.now() - t0).toFixed(2),
      ...extra,
    },
  };
}

/* -------------------------------------------- */
/*  Cache                                       */
/* -------------------------------------------- */

let cached = null;
let signature = null;

/**
 * A cheap fingerprint of everything the field's geometry depends on.
 *
 * @remarks
 * The registry generation alone is **not** sufficient, and assuming it was is a bug this
 * nearly shipped with. A light-bearing token walking across the scene does not stale the
 * registry — position is read live (see `affectsRegistry`) — but it absolutely changes
 * the field, because every cell is cut from `source.shape`.
 *
 * Foundry allocates a **new** polygon object each time it re-runs `_createShapes`, which
 * is the end of every move, wall edit and door toggle. So comparing shape references
 * catches all of it with no bookkeeping and nothing to remember to invalidate — the same
 * trick `Entry#path` uses one level down.
 *
 * Ambient brightness rides along because it sets the tier that `dark` cells fill at, and
 * it slides continuously during a darkness animation.
 */
function currentSignature() {
  const parts = [version(), ambientBrightness()];
  for (const entry of registryEmitters()) parts.push(entry.shape);
  for (const entry of registrySuppressors()) parts.push(entry.shape);
  return parts;
}

function signatureMatches(next) {
  if (!signature || signature.length !== next.length) return false;
  for (let i = 0; i < next.length; i++) if (signature[i] !== next[i]) return false;
  return true;
}

/**
 * The current field, recomputed only when something it depends on has changed.
 *
 * @remarks
 * Still a whole-field cache: any change recomputes everything. §8.3 is where that gets
 * smarter — the measured 4.4 ms (§9.6) is affordable once and not once per token step.
 * What this does buy is *correctness* plus a free win: comparing ~50 object references
 * costs nothing next to a recompute, and most frames change nothing at all.
 *
 * @returns {{generation: number, cells: Cell[], stats: object}}
 */
export function get() {
  const next = currentSignature();
  if (cached && signatureMatches(next)) return cached;
  signature = next;
  return (cached = compute());
}

/** Drop the cached field. Rarely needed — {@link get} detects its own staleness. */
export function invalidate() {
  cached = null;
  signature = null;
}

/** Debug readout: compute fresh and report only the statistics. */
export function stats(options) {
  return compute(options).stats;
}

/**
 * Why did a region come out the shape it did?
 *
 * Reports the inputs to `resolveRegions` and the emitter classification side by side —
 * which emitters *break* each suppressor, how much of the region survived, and which
 * emitters cancel themselves against it. Cell counts alone cannot distinguish "the
 * daylight was never considered a breaker" from "it was, and the geometry came out
 * empty", and those need different fixes.
 *
 * @returns {object}
 */
export function explain() {
  const hasShape = (e) => e.shape?.points?.length > 0;
  const emitters = registryEmitters().filter((e) => !e.isGlobal && hasShape(e));
  const suppressors = [...registrySuppressors()].filter(hasShape).sort((a, b) => b.level - a.level);

  // Area, not path count. A circle with a bite out of it is still *one* path, so counting
  // paths cannot tell "carved" from "untouched" — which is exactly the mistake the first
  // version of this made.
  const areaOf = (paths) =>
    paths.reduce((sum, p) => sum + Math.abs(ClipperLib.Clipper.Area(p)), 0) / (SCALE * SCALE);
  const pct = (a, b) => (b > 0 ? +((1 - a / b) * 100).toFixed(1) : 0);

  opCount = 0;
  holeCount = 0;
  const carved = carveRegions(suppressors);
  const live = resolveRegions(carved.regions, emitters);

  // Emitter side: how much of each light survived into `clip` cells. If a *daylight*
  // overlapping a darkness is not losing area, `selfCancelled` is not subtracting.
  const { cells } = compute();
  const clipArea = new Map();
  for (const cell of cells) {
    if (cell.kind !== "clip" || !cell.emitter) continue;
    const a = Math.abs(cell.polygon.signedArea?.() ?? 0);
    clipArea.set(cell.emitter, (clipArea.get(cell.emitter) ?? 0) + a);
  }

  return {
    ambientB: +(registryEmitters().find((e) => e.isGlobal)?.brightnessAt() ?? 0).toFixed(3),
    liveRegions: live.length,

    emitters: emitters.map((e) => {
      const full = areaOf([e.path(SCALE)]);
      const kept = clipArea.get(e) ?? 0;
      return {
        id: e.id,
        kind: e.kind,
        level: e.level,
        cancelsDarkness: !!e.cancelsDarkness,
        fullArea: +full.toFixed(0),
        clipArea: +kept.toFixed(0),
        removedPct: pct(kept, full),
      };
    }),

    suppressors: suppressors.map((s) => ({
      id: s.id,
      level: s.level,
      floor: s.floor,
      eligibility: s.eligibility,
    })),

    regions: carved.regions.map((r) => {
      const before = areaOf(r.paths);
      const after = areaOf(r.effective ?? []);
      return {
        suppressor: r.suppressor.id,
        breakers: [...(r.breakers ?? [])].map((e) => e.id),
        carvedArea: +before.toFixed(0),
        effectiveArea: +after.toFixed(0),
        removedPct: pct(after, before),
      };
    }),

    // Every breaker/region pair, measured rather than inferred.
    //
    // `removedPct: 0` on both sides is ambiguous on its own: it reads the same whether
    // the subtraction is broken or the shapes simply barely touch. The gap between what
    // the model sees and what is on screen is real — a darkness source *renders* at
    // `radius + padding` through `_visualShape` (`point-darkness-source.mjs:132-135`),
    // so its violet disc is wider than the `shape` the model measures.
    overlaps: carved.regions.flatMap((r) =>
      [...(r.breakers ?? [])].map((e) => {
        const inter = intersection(r.paths, [e.path(SCALE)]);
        const dx = e.source.x - r.suppressor.source.x;
        const dy = e.source.y - r.suppressor.source.y;
        return {
          emitter: e.id,
          suppressor: r.suppressor.id,
          distance: +Math.hypot(dx, dy).toFixed(0),
          emitterRadius: +Math.sqrt(areaOf([e.path(SCALE)]) / Math.PI).toFixed(0),
          suppressorRadius: +Math.sqrt(areaOf(r.paths) / Math.PI).toFixed(0),
          // What the darkness actually draws, padding included.
          suppressorDrawnRadius: +(
            (r.suppressor.source.radius ?? 0) + (r.suppressor.source._padding ?? 0)
          ).toFixed(0),
          intersectionArea: +areaOf(inter).toFixed(0),
        };
      })
    ),
  };
}
