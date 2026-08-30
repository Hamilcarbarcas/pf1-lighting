/**
 * `field()` — the whole-scene resolution. DESIGN.md §6.1, §6.2, §9.6.
 *
 * Where `evaluate()` answers what the light level is at a point, this answers it everywhere, as a
 * set of polygonal cells the renderer can draw. The model's output and the renderer's entire input.
 *
 * ## What a cell is
 *
 * Cells partition space by treatment — by which suppressor, if any, applies. Within one treatment
 * region, cells for different emitters may overlap: the shader's `MAX_COLOR` blend is the right
 * answer there, since light does not stack (§4.2) and the brightest wins. What must never overlap
 * is a cell at full strength with a suppressed one, and that cannot happen, because suppression is
 * positional — any point inside a suppressor is inside it for every emitter reaching that point.
 *
 * That is the invariant §6.1 step 1 asserts, and it is subtler than "the cells are disjoint".
 *
 * ## Three kinds
 *
 * | Kind | Geometry | Rendered as |
 * | --- | --- | --- |
 * | `clip` | `E \ (blocking regions + self-cancelled)` | the real source, clipped — keeps flicker and colour |
 * | `dark` | the whole effective region | a mesh in the darkness-level texture, at the transformed ambient tier (§7.0) |
 * | `ambient` | the scene, less every region a suppressor governs | the same, at the scene's own tier |
 * | `stack` | where two or more relative bands overlap | the same, at the summed tier (§3.2.1) |
 *
 * A blocked emitter produces no cell inside the region at all — it does not dim, it stops counting
 * (§3.3). Getting that wrong made a torch crossing a darkness paint a lit lens over ground that
 * should have been dark; caught by the cell overlay once the same correction had landed in
 * `contest`.
 *
 * A surviving emitter produces its ordinary `clip` cell and nothing else (2026-08-29). §4.1's
 * reordering retired the `reduced` kind this file also used to emit: a light the suppressor cannot
 * block is not dimmed by it, it stands on the ground the suppressor produced and applies over it.
 * That ground reaches the emitter as its `base` — see {@link groundDomains} — so the whole rule is
 * carried by which tier a cell is stamped with. The renderer still knows how to draw a `reduced`
 * cell; nothing produces one.
 *
 * ## Cost
 *
 * §9.6 measured this shape at 4.4 ms on a deliberately worse-than-RAW scene. The cost model is op
 * count — every Clipper call is roughly equal — so the `tight` pre-filter exists to avoid calls,
 * not to make them cheaper.
 */

import {
  ambientBrightness,
  ambientTier,
  activeEmitters as registryEmitters,
  suppressors as registrySuppressors,
  version,
} from "./registry.mjs";
import { CLIPPER_SCALE, groupRings, toClipperPath } from "../geometry.mjs";
import { applyTransform, breaks, eligibilityFn } from "./contest.mjs";
import { normaliseEmission } from "./ramp.mjs";
import { TIER, resolveTier, stepTier, tierCeiling, tierOf } from "./tiers.mjs";
import * as areas from "./areas.mjs";

/**
 * Core uses 100 wherever it touches Clipper (`common/constants.mjs:2146`).
 *
 * Imported rather than redeclared since umbra (§4.3) became a second consumer: a path produced at
 * one scale and consumed at another reads as "the polygon vanished", not as a unit error.
 */
const SCALE = CLIPPER_SCALE;

/** Recursion limit for annulus splitting; a shape needing this many cuts is pathological. */
const MAX_SPLIT_DEPTH = 8;

let opCount = 0;

/**
 * Holes resolved by {@link splitAnnuli} during the current compute.
 *
 * Counted here rather than by comparing path counts around the call: splitting one annulus turns
 * two paths (outer + hole) into two simple rings, so a length delta reports zero and the
 * diagnostic silently reads clean.
 */
let holeCount = 0;

/**
 * Holes the splitter gave up on during the current compute.
 *
 * Distinct from {@link holeCount}, which counts holes encountered, nearly all of them resolved. A
 * non-zero value here is a rendered-wrong region, and the only statistic that explains an
 * over-bright patch inside a darkness.
 */
let droppedHoles = 0;

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
 * A source shape is a single closed ring — `PolygonMesher` accepts one flat points array and only
 * generates holes internally, during offsetting (`polygon-mesher.mjs:23`). But a suppressor sitting
 * wholly inside an emitter makes `E \ S` an annulus, and leaving `E` whole does not dodge it:
 * `MAX_COLOR` would let the bright ring win over the reduced cell inside.
 *
 * The cut is a horizontal half-plane through the hole's centre, taken recursively. A hole
 * straddling the cut line becomes an indentation on each side rather than a hole, so each pass
 * removes at least one and the recursion terminates. Two ops per hole.
 *
 * Preferred over the keyhole-bridge alternative because a zero-width slit is what the soft-edge
 * offsetting passes (§6.4) handle worst. The seam this leaves sits inside a region of uniform tier,
 * so it is invisible.
 *
 * §9.6 measured 7 annuli out of 119 cells on a deliberately extreme scene, 0 on a realistic one —
 * real but not hot.
 *
 * @param {ClipperLib.IntPoint[][]} paths
 * @param {number} [depth]
 * @returns {ClipperLib.IntPoint[][]} Hole-free rings
 */
function splitAnnuli(paths, depth = 0) {
  if (paths.length <= 1) return paths;

  // Orientation alone does not say which ring is outer, so anchor on the largest by absolute area
  // and call everything running the other way a hole.
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
    // Give up on the holes rather than emit an unrenderable shape: over-bright in a small region
    // beats a mesh that throws.
    //
    // Counted, not just warned. A `console.warn` scrolls away and increments nothing, so the one
    // statistic explaining an over-bright patch was invisible to `field.stats()`, which is where
    // anyone would look. §7.0 made this reachable for the first time: the ambient complement
    // carries one hole per darkness on the scene, where every cell before it carried a few.
    droppedHoles += holes.length;
    console.warn(
      `pf1-lighting | field: annulus split hit depth ${MAX_SPLIT_DEPTH}; ` +
        `${holes.length} hole(s) dropped from a cell.`
    );
    return paths.filter((p) => Math.sign(ClipperLib.Clipper.Area(p)) === outerSign);
  }

  const all = boundsOfPaths(paths);
  const hole = boundsOf(holes[0]);
  const cutY = Math.round((hole.minY + hole.maxY) / 2);

  // The halves abut exactly — no overlap.
  //
  // An earlier version overlapped them, on the reasoning that each half's soft-edge fade would hide
  // under the other's solid interior and `MAX_COLOR` would keep the doubling harmless. Wrong:
  // `MAX_COLOR` is the illumination layer, while coloration blends additively, so the overlap band
  // rendered as a bright line rather than no line.
  //
  // The seam is handled at render time instead, by forcing hard edges on every piece of a split
  // cell (`HARD_EDGES`). With no inset there is no fade to hide, and two pieces sharing an exact
  // edge meet cleanly.
  //
  // A `pad` option briefly existed for the ambient complement, whose cuts run the full width of the
  // scene and turned a hairline into a visible horizontal line. It went with the stand-in fills it
  // compensated for: ambient is a mesh in the darkness-level texture now (§7.0), rendered without
  // multisampling, where two triangles sharing an edge cover each boundary pixel exactly once and
  // there is no hairline to hide.
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
 * §4.1 says the highest-level suppressor wins outright, no composition. So processing in descending
 * level order and subtracting everything already claimed yields regions that each answer to a single
 * suppressor, in `2N` ops. Without it, overlapping suppressors with different transforms have no
 * well-defined answer.
 *
 * Equal levels do not cancel each other here. §4.1's cancellation is between a suppressor and an
 * emitter; two darknesses of the same level simply overlap, and the first to claim the ground keeps
 * it — arbitrary but harmless, since their transforms are equal by construction.
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
 * Only a daylight does that now (§4.1.2, narrowed 2026-08-29). A higher-level magical light used to
 * counter the suppressor within its radius and was subtracted here alongside; under §4.1's
 * reordering it does not remove the darkness from the ground, it lights the ground the darkness
 * produced, so the region stands and only the annihilation case cuts it.
 *
 * `effective` is what everything downstream clips against. `paths` stays available because a
 * canceller has to know the original overlap in order to remove its own light from it.
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
    // `effectiveBoxes` was computed here until 2026-08-29 and read by exactly one thing, the
    // `reduced` cell loop's `tight` pre-filter. That loop is gone, so the boxes are too.
  }
  return regions.filter((r) => r.effective.length);
}

/**
 * The regions that put this emitter out.
 *
 * @remarks
 * Memoised on `(kind, level, cancelsDarkness)` — eligibility and precedence depend only on those,
 * so every mundane torch on the scene shares an answer. That turns 53 per-emitter computations into
 * one or two, and lets the union of blocking regions, the part costing a Clipper op, be computed
 * once per signature.
 *
 * `reducing` is gone (2026-08-29). It held the regions entitled to dim this emitter rather than
 * remove it, and under §4.1's reordering no such category exists: a light the darkness cannot block
 * is not dimmed by it, it applies over the ground the darkness produced. So an emitter is either
 * blocked in a region or untouched by it, and untouched needs no list.
 */
function classifyRegions(emitter, regions, cache) {
  const key = `${emitter.kind}:${emitter.level}:${emitter.cancelsDarkness ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const blocking = [];
  for (const region of regions) {
    // Re-tested rather than read off `region.breakers`, which is keyed by object identity. `breaks`
    // depends only on the memo signature, so the two always agree — but relying on that silently
    // would make the cache correct by coincidence.
    if (breaks(emitter, region.suppressor)) continue;
    if (eligibilityFn(region.suppressor.eligibility)(emitter, region.suppressor)) {
      blocking.push(region);
    }
  }

  const paths = blocking.flatMap((r) => r.effective);
  const entry = {
    blocking,
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
 * @property {"clip"|"dark"|"ambient"|"stack"} kind - `reduced` is retired and no longer
 *   produced; the renderer's branch for it is left standing but unreachable (see the note at
 *   the head of this file)
 * @property {PIXI.Polygon} polygon - The outer ring. Treat as read-only: on a scene with no
 *   suppressors this is the source's own `shape`, shared rather than copied, since copying would be
 *   the only cost on the fast path.
 * @property {PIXI.Polygon[]} [holes] - Holes in {@link polygon}. Only `ambient` cells ever have any
 *   (§6.2.1: a cell rendered by a source must be one closed ring, and only ambient is rendered by a
 *   mesh instead). Consumers that cannot express a hole may ignore the field — every other kind is
 *   hole-free by construction.
 * @property {object|null} emitter - Registry entry this cell's light comes from
 * @property {object|null} suppressor - Registry entry that modified it
 * @property {object|null} emission - The emitter's own emission, for a `clip` cell
 * @property {number|undefined} tier - For `dark`, the tier to fill at: ambient transformed by the
 *   suppressor and bounded by its floor, so a darkness cast at noon fills at Normal and one cast at
 *   midnight fills at Dark
 */

/**
 * The area global illumination is entitled to cover, as a Clipper path.
 *
 * @remarks
 * `canvas.dimensions.sceneRect`, deliberately not `ambient.shape`. They are the same thing today,
 * since §7.0's takeover is a shader threshold and leaves the global source's geometry alone. They
 * were not during the version of §7.0 that wrote `customPolygon`: `shape` was then this module's
 * own output, and cutting the next field from it broke §6.6's rule against reading back the
 * module's own output, with the cells shrinking further on every pass.
 *
 * The scene rect is the honest input either way: the emitter's domain, fixed per scene, and what
 * `GlobalLightSource._createShapes` itself falls back to.
 *
 * @param {number} scale
 * @returns {{X: number, Y: number}[]|null}
 */
function ambientDomain(scale) {
  const rect = canvas?.dimensions?.sceneRect;
  if (!rect) return null;
  const pts = rect.toPolygon().points;
  const path = new Array(pts.length / 2);
  for (let i = 0, j = 0; i < pts.length; i += 2, j++) {
    path[j] = { X: Math.round(pts[i] * scale), Y: Math.round(pts[i + 1] * scale) };
  }
  return path;
}

/**
 * The scene rect split by ambient areas, one entry per resolved tier. DESIGN.md §10.7.
 *
 * @remarks
 * Returns `null` when there are no areas, and every caller branches on that rather than treating
 * "one domain covering everything" as the general case. A scene without an ambient region takes the
 * path it took before this existed, down to the op count — the discipline the no-suppressor fast
 * path below follows, for the same reason: §7.0's ambient cell is on the hot path of every scene,
 * and most scenes will never carry a region.
 *
 * The split folds one area at a time over the domains so far, cutting each into `D ∩ A` and
 * `D \ A`. Two ops per (domain × area), exponential in overlapping areas — which is why the result
 * is collapsed by tier before it leaves: `emitStacks` is the expensive consumer, and after the
 * collapse it runs at most five times however many regions are drawn, rather than once per
 * partition cell.
 *
 * Folding in document order also makes this agree with {@link areas.ambientTierAt} by construction
 * rather than by a rule stated in two places. Overlapping areas compose in that order, which
 * matters only when a *set* meets an *at most*.
 *
 * `box` is the combined extent of the areas, not of the domains — the base domain's extent is the
 * whole scene rect and would reject nothing. It is what lets an emitter nowhere near a region skip
 * the split entirely, which is most emitters on most scenes.
 *
 * @param {number} scale
 * @param {number} base - The scene's own ambient tier
 * @returns {{list: {tier: number, paths: {X: number, Y: number}[][]}[], box: object}|null}
 */
function ambientDomains(scale, base) {
  const list = areas.areas();
  if (!list.length) return null;

  const rect = ambientDomain(scale);
  if (!rect) return null;

  let domains = [{ tier: base, paths: [rect], derived: false }];
  const areaPaths = [];

  for (const area of list) {
    const clip = areas.pathsFor(area, scale);
    if (!clip.length) continue;
    areaPaths.push(...clip);

    const next = [];
    for (const domain of domains) {
      const inside = intersection(domain.paths, clip);
      if (inside.length) {
        next.push({
          tier: areas.foldTier(domain.tier, area),
          paths: inside,
          // Carried purely to decide `hardEdge`. A drawn region's boundary follows a wall and must
          // stay sharp; a §3.4 spill band's boundary is a falloff between two light levels and must
          // not. They arrive here in the same list and are otherwise identical, so this is the only
          // place the difference survives to the painter.
          derived: domain.derived || area.derived === true,
        });
      }

      const outside = difference(domain.paths, clip);
      if (outside.length) next.push({ tier: domain.tier, paths: outside, derived: domain.derived });
    }
    if (next.length) domains = next;
  }
  if (!areaPaths.length) return null;

  // Collapse. The parts are disjoint by construction, so concatenating their paths is a valid
  // Clipper subject without a union op — the point of doing it here rather than letting the
  // consumers each pay for one.
  //
  // Keyed on tier and softness: two parts at one tier that disagree about their edges cannot share
  // a mesh, and merging them would silently hard-edge a spill band abutting a region at the same
  // level.
  const byTier = new Map();
  for (const domain of domains) {
    const key = `${domain.tier}|${domain.derived ? 1 : 0}`;
    const merged = byTier.get(key);
    if (merged) merged.paths.push(...domain.paths);
    else byTier.set(key, { tier: domain.tier, derived: domain.derived, paths: [...domain.paths] });
  }
  return { list: [...byTier.values()], box: boundsOfPaths(areaPaths) };
}

/**
 * The domain list for {@link stampDomains}, with each darkness region folded in as ground of its
 * own. DESIGN.md §4.1.1a, §10.7.
 *
 * @remarks
 * This is what makes §4.1.1a's reordering render. A surviving light applies over the level a
 * darkness produced, and the renderer already knows how — `light-ramps.zonesFor` resolves a band as
 * `min(stepTier(base, steps), cap)`, measured from the ground it stands on. All it was missing is
 * that a darkness region is a ground. Fold the regions' resolved tiers in beside §10.7's ambient
 * areas and the existing machinery answers it: cells split at the region boundary and each part
 * carries the tier under it.
 *
 * The list must partition the scene rect. `stampDomains` drops any part of a cell that intersects
 * no domain, so the open ground is carried too, as each ambient domain (or the whole rect) less
 * everything a suppressor governs.
 *
 * Merged by tier, for `ambientDomains`' reason — the Clipper ops `stampDomains` pays per cell is
 * the length of this list, so the collapse bounds it at the number of distinct tiers (five) rather
 * than the number of regions drawn.
 *
 * The stack pass deliberately does not read this. Merging by tier throws away which suppressor
 * produced a part, and `emitStacks` needs that to know which emitters the region left standing —
 * see the note at its call site, and the bug it records.
 *
 * `box` stays the extent of the interesting ground only — the areas and the regions — so a light
 * nowhere near either still takes `stampDomains`' no-Clipper path. Deliberately not the extent of
 * the returned list, which is the whole scene rect by construction and would make every cell pay.
 *
 * @param {object|null} domains - §10.7's ambient areas, or null
 * @param {{tier: number, paths: object[]}[]} regionParts - One per (region × domain), from the
 *   fill loop, which has already resolved the tier
 * @param {object[]} governed - Union of every region's effective area
 * @param {number} sceneTier
 * @returns {{list: {tier: number, paths: object[]}[], box: object}|null}
 */
function groundDomains(domains, regionParts, governed, sceneTier) {
  if (!regionParts.length) return domains;

  const byTier = new Map();
  const add = (tier, paths) => {
    const hit = byTier.get(tier);
    if (hit) hit.paths.push(...paths);
    else byTier.set(tier, { tier, paths: [...paths] });
  };

  for (const part of regionParts) add(part.tier, part.paths);

  // The open ground. Disjoint from the regions by construction, so the parts can be
  // concatenated into one entry per tier without a union op.
  const open = domains?.list ?? [{ tier: sceneTier, paths: [ambientDomain(SCALE)].filter(Boolean) }];
  for (const domain of open) {
    if (!domain.paths.length) continue;
    const rest = governed.length ? difference(domain.paths, governed) : domain.paths;
    if (rest.length) add(domain.tier, rest);
  }

  const regionBox = boundsOfPaths(regionParts.flatMap((p) => p.paths));
  const box = domains
    ? {
        minX: Math.min(domains.box.minX, regionBox.minX),
        minY: Math.min(domains.box.minY, regionBox.minY),
        maxX: Math.max(domains.box.maxX, regionBox.maxX),
        maxY: Math.max(domains.box.maxY, regionBox.maxY),
      }
    : regionBox;

  return { list: [...byTier.values()], box };
}

/**
 * Give every emitter-drawn cell the ambient tier it stands on, splitting it where it crosses from
 * one domain into another.
 *
 * @remarks
 * The half of §10.7 that is not about the ground at all. Leaving it out produced a report that read
 * as the region blocking light sources (2026-08-26); it did not. The renderer turns a light's tier
 * into one of Foundry's lighting levels through `levelForTier(target, background)`, which returns
 * `UNLIT` whenever `target <= background` — a torch adds nothing at noon, correctly — and
 * `background` was one scalar for the whole scene, `tierOf(stats.ambientB)`. So on a Bright map
 * every ordinary light was already drawn unlit, right while the ground really was Bright everywhere
 * and wrong the moment a region made one room Dark. The lights were never blocked; they were unlit
 * for a reason that had stopped being true in that room.
 *
 * The model never had this bug — `evaluate()` reads `ambientTier(point)` through the global
 * emitter's contribution, so the torch in the cellar always resolved to Normal. Purely the picture,
 * which is why the fix is here and in `renderer.mjs` and nowhere else.
 *
 * `stack` cells are stamped where they are made, since `emitStacks` is already told its base.
 * `ambient` and `dark` cells need nothing: the first is a mesh and the second is drawn by a
 * darkness source, and neither goes through `levelForTier`.
 *
 * @param {object[]} cells
 * @param {object|null} domains
 * @param {number} sceneTier
 * @returns {object[]}
 */
function stampDomains(cells, domains, sceneTier) {
  if (!domains) return cells;

  const out = [];
  for (const cell of cells) {
    if (cell.kind !== "clip" && cell.kind !== "reduced") {
      out.push(cell);
      continue;
    }

    const path = toClipperPath(cell.polygon, SCALE);
    // Nowhere near a region, so it stands on the scene's own ambient and needs no Clipper at all.
    // The common case, and the reason the extent of the areas is what is tested.
    if (!path?.length || !boxesOverlap(boundsOf(path), domains.box)) {
      out.push({ ...cell, base: sceneTier });
      continue;
    }

    for (const domain of domains.list) {
      const part = intersection([path], domain.paths);
      if (!part.length) continue;
      // `splitAnnuli` because these cells are drawn by a source, and a source shape is one closed
      // ring (§6.2.1). Intersecting a disc with "the scene minus this room" produces exactly the
      // annulus that rule exists for.
      for (const polygon of toPolygons(splitAnnuli(part))) {
        out.push({ ...cell, polygon, base: domain.tier, clipped: true });
      }
    }
  }
  return out;
}

/**
 * Does a domain need a ground cell of its own?
 *
 * @remarks
 * Reduces to the pre-existing `ambientB > 0` test when nothing overrides the base, which is what
 * keeps an unlit scene emitting no ambient mesh at all. The second clause is the whole feature: a
 * *set Dark* area on a Bright map has a tier ceiling of 0 and must still be painted, since the mesh
 * is the only thing telling §7.0's shader threshold to discard global light there.
 */
const domainNeedsCell = (tier, base) => tierCeiling(tier) > 0 || tier !== base;

/**
 * What the open ground is worth, whether or not a global light source exists.
 *
 * @remarks
 * The bug this exists for (2026-08-28). Every ground-emitting branch below used to be gated on
 * `ambient` being non-null, and `registry.buildEmitters` drops the global entry outright when
 * `source.active` is false (`registry.mjs:259`). So with global illumination off — the scene
 * checkbox, its darkness threshold, or a *Restrict Global Illumination* region — the field emitted
 * no ground cells at all, and the darkness-level texture fell back to core's clear.
 *
 * That clear is `canvas.environment.darknessLevel` (`groups/effects.mjs:240-241`): the scene's own
 * number, flat across the map. So every ambient area silently lost its tier, and a light inside one
 * was drawn against the scene's background instead of the room's — rendered against a brighter
 * ground than the model says it stands on, which reads as blown out. Three routes to one condition,
 * which is why it looked like three different bugs.
 *
 * The ground's tier was never the source's to give. `registry.ambientBrightness` is
 * `tierCeiling(ambientTier(point))` and `ambientTier` reads the scene's darkness and its areas —
 * neither consults the global light source. So on a scene with no areas this reproduces the clear
 * exactly and nothing moves; what it adds is the area tiers, which had no other way in.
 *
 * `ambient.brightnessAt()` is still preferred where the entry exists, so the live read that keeps a
 * darkness animation from leaving the ambient stale (see `EmitterEntry`) is unchanged.
 */
const groundBrightness = (ambient) => (ambient ? ambient.brightnessAt() : ambientBrightness());

/**
 * Everything outside a domain, as a clip for `emitStacks`.
 *
 * @remarks
 * `emitStacks` already subtracts a path set from every cell it emits — that is how suppressor
 * regions are kept out — so restricting a run to one domain is the same operation with a different
 * argument, and needs no new parameter.
 */
function outsideOf(domain, scale) {
  const rect = ambientDomain(scale);
  if (!rect) return [];
  return difference([rect], domain.paths);
}

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
  droppedHoles = 0;

  const cells = [];

  /**
   * Emit a ground fill **with its holes intact**, unsplit.
   *
   * @remarks
   * `splitAnnuli` exists because a cell rendered by a light source must be one closed ring
   * (§6.2.1). An ambient cell is not: since §7.0 step 3 it is a mesh in the darkness-level texture,
   * and `PIXI.utils.earcut` takes hole indices natively.
   *
   * Splitting it was actively harmful, which is why this is a separate path rather than a tidy-up.
   * The complement carries one hole per darkness on the scene, so the recursive cuts run the full
   * width of the map — and every full-width artefact of 2026-08-23 was one of those cuts made
   * visible by a difference between two abutting fills. Holes remove the cuts rather than making
   * them meet better, the only fix that cannot regress.
   *
   * One cell per outer ring. Several outers arise only if a suppressor spans the scene rect edge to
   * edge, or an ambient area is drawn in two pieces; holes are assigned by containment rather than
   * assumed to belong to the first.
   */
  const emitAmbient = (paths, emitter, tier, hardEdge = false, spill = false) => {
    for (const { outer, holes } of groupRings(toPolygons(paths))) {
      cells.push({
        kind: "ambient",
        polygon: outer,
        holes,
        // Carried for the painter alone, and the inverse of `hardEdge` rather than a second copy of
        // it: §3.4's bands are the one ground boundary the model asserts a ramp across, so they want
        // a wider feather than the ordinary ground default, which is tuned as anti-aliasing for
        // edges that really are steps.
        spill,
        emitter,
        suppressor: null,
        emission: null,
        tier,
        // Ambient-area cells are never feathered (2026-08-26): a region boundary is drawn along a
        // wall, and a wall is a hard edge. The ground blur (§6.4.2a) exists for the boundary between
        // a darkness and open ground, which has no architecture on it and reads as a stencilled disc
        // without one. Blurring a room's outline instead makes the room bleed through its own walls.
        hardEdge,
      });
    }
  };

  // Tested on `shape`, not `path()`, so scenes taking the fast path below never build a Clipper
  // path at all.
  const hasShape = (e) => e.shape?.points?.length > 0;

  // Global illumination is kept out of the emitter loop — no origin or radii, so clipping and
  // radius-shifting are both meaningless for it — but it is not shapeless. Its entry wraps
  // `canvas.environment.globalLightSource`, whose `_createShapes` already sets `shape` to the scene
  // rect (or to `customPolygon`), so `ambient.path()` works and the scene-wide remainder can be cut
  // from it directly. See {@link emitAmbient}.
  //
  // Its brightness also sets what a suppressor transforms down from.
  // `activeEmitters`, not `emitters`: a light standing inside a darkness that can block it is out,
  // and an emitter that is out has no cells at all rather than cells that happen to be empty. See
  // `registry.markOriginSuppression` (§3.3.1).
  const all = registryEmitters();
  const emitters = all.filter((e) => !e.isGlobal && hasShape(e));
  const ambient = all.find((e) => e.isGlobal) ?? null;

  // Strongest first, so `carveRegions` can subtract what is already claimed.
  const suppressors = [...registrySuppressors()].filter(hasShape).sort((a, b) => b.level - a.level);

  // The scene's own ambient tier, and the split of the map by any regions that override it
  // (§10.7). `null` means there are no such regions and every ambient path below is the one it
  // was before the feature existed.
  const sceneTier = ambientTier();
  const domains = ambientDomains(SCALE, sceneTier);

  /**
   * The ambient tier a light's zones are **standing on**, for `levels.levelForTier`.
   *
   * @remarks
   * This was `sceneTier` at every call site until 2026-08-28, and `cell.base` was read with a
   * `?? sceneTier` fallback nothing ever overrode — the field was declared, consumed and never
   * assigned. Inside an ambient area (§10.7) that is the wrong background, and `levelForTier` is
   * exactly the function it is wrong for: its first rule returns `UNLIT` when the target is no
   * brighter than the ground, which is what stops a zone painting a level on top of ground that
   * already carries it. Given the scene's tier instead of the region's, that shortcut stops firing
   * and every zone double-counts — the tier once in the darkness-level texture (§7.0 step 6) and
   * again as a lighting level over it.
   *
   * Reported 2026-08-28 as light sources maxing out, only inside a region with Restrict Global
   * Illumination enabled and correct again once moved outside it. Both halves follow: outside a
   * region there are no domains, so `sceneTier` was right by definition; and the darker the scene,
   * the more zones clear `target > background` and start painting.
   *
   * One tier per emitter, from its origin — not per fragment, the bargain §6.3 and
   * `render/renderer.levelForTier`'s note already state: the shader has one uniform per zone per
   * source, so a light whose band crosses two differently lit areas paints one level throughout
   * either way. The choice here is only which one, and the ambient where the light actually stands
   * beats the scene's own on every count.
   */
  const baseFor = (emitter, fallback) => {
    // No ambient areas on the scene means `sceneTier` is right by definition and the query is pure
    // cost — the guard every other §10.7 path in this file carries.
    if (!domains) return fallback;
    // `emitter.source.x/y`, matching `registry.markOriginSuppression`'s reading of the same
    // origin. Global illumination has none and never reaches here (it is not in `emitters`).
    const x = emitter?.source?.x;
    const y = emitter?.source?.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return fallback;
    return areas.ambientTierAt({ x, y }, fallback);
  };

  // --- No suppressors: every emitter renders untouched. The common case by far, and it must not
  //     cost a single Clipper op — nor a scale-and-round trip out to integer coordinates and
  //     straight back, which is what building a path here would be. The source's own polygon is
  //     the cell. ---
  if (!suppressors.length) {
    for (const emitter of emitters) {
      cells.push({
        kind: "clip",
        polygon: emitter.shape,
        emitter,
        suppressor: null,
        emission: emitter.emission,
        clipped: false,
        base: baseFor(emitter, sceneTier),
      });
    }
    // Nothing governs any part of the scene, so the ambient cell is the scene rect — no union, no
    // difference, no Clipper at all. Preserving that is the point of this branch: §7.0 must not make
    // the common case pay for a feature it does not use.
    if (!domains) {
      const B = groundBrightness(ambient);
      const rect = canvas?.dimensions?.sceneRect;
      // Unguarded on `B`, for the reason given at the other ambient branch below: the ground has
      // to be painted even when it is fully dark, or the two composited passes of §7.0 step 6 have
      // nothing underneath them.
      if (rect) {
        cells.push({
          kind: "ambient",
          polygon: rect.toPolygon(),
          emitter: ambient,
          suppressor: null,
          emission: null,
          tier: tierOf(B),
        });
      }
    } else {
      // Ambient areas, with no darkness anywhere to cut them against (§10.7). Each domain is
      // already the shape it should be painted at; nothing is subtracted from it here.
      for (const domain of domains.list) {
        if (!domainNeedsCell(domain.tier, sceneTier)) continue;
        emitAmbient(domain.paths, ambient, domain.tier, !domain.derived, domain.derived);
      }
    }
    // Band overlaps still apply with no suppressor on the scene — in fact the usual place they
    // occur, two torches in a dark corridor (§3.2.1). It costs Clipper ops, so it goes after
    // everything above and self-cancels at `bands.length < 2`, which keeps the single-light case on
    // the no-op path this branch exists to protect.
    //
    // Once per domain, not once: a band raises by rungs, so what it resolves to depends on the
    // ambient it stands on, and two torches overlapping in an unlit cellar are not the same cell as
    // two torches overlapping in the street outside.
    const soloStacks = [];
    if (!domains) soloStacks.push(...emitStacks(emitters, sceneTier, []));
    else {
      for (const domain of domains.list) {
        soloStacks.push(...emitStacks(emitters, domain.tier, outsideOf(domain, SCALE)));
      }
    }
    for (const cell of soloStacks) cells.push(cell);

    return finish(stampDomains(cells, domains, sceneTier), t0, {
      filtered: filter,
      emitters: emitters.length,
      suppressors: 0,
      stacks: soloStacks.length,
      // How many distinct ambient tiers the map was split into. 0 means no region overrides it and
      // every path above was the pre-§10.7 one.
      domains: domains?.list.length ?? 0,
      ambientB: ambient ? +ambient.brightnessAt().toFixed(3) : 0,
    });
  }

  const carved = carveRegions(suppressors);
  const regions = resolveRegions(carved.regions, emitters);
  const cache = new Map();

  const emit = (kind, paths, emitter, suppressor, emission, tier, clipped = false) => {
    const base = baseFor(emitter, sceneTier);
    for (const polygon of toPolygons(splitAnnuli(paths))) {
      cells.push({ kind, polygon, emitter, suppressor, emission, tier, clipped, base });
    }
  };

  for (const emitter of emitters) {
    const path = emitter.path(SCALE);
    const box = boundsOf(path);
    const { union: blocked, boxes } = classifyRegions(emitter, regions, cache);

    // Where a daylight annihilated a suppressor it stops emitting too — the only place in the model
    // where a light's own output is shaped by a suppressor it defeated (§4.1.2). Uses the region's
    // original geometry, since `effective` is exactly the part this emitter already carved away.
    const selfCancelled = emitter.cancelsDarkness
      ? carved.regions.filter((r) => r.suppressor.level <= emitter.level).flatMap((r) => r.paths)
      : [];

    const remove = [...blocked, ...selfCancelled];

    // Nothing removes light from this emitter anywhere. It renders whole, no Clipper.
    if (!remove.length || (filter && !selfCancelled.length && !touchesAny(box, boxes))) {
      // Nothing removes light from this emitter, so the cell is its own outline. Pushed by identity
      // rather than round-tripped through Clipper — the trip was a no-op on a single path, and the
      // identity is what tells `clip.assign` this is not a clip at all.
      cells.push({
        kind: "clip",
        polygon: emitter.shape,
        emitter,
        suppressor: null,
        emission: emitter.emission,
        clipped: false,
        base: baseFor(emitter, sceneTier),
      });
    } else {
      emit("clip", difference([path], remove), emitter, null, emitter.emission, undefined, true);
    }

    // No second cell for the regions this emitter survives in (2026-08-29). There used to be a
    // `reduced` one carrying `transformEmission(...)`, for a suppressor entitled to dim this light
    // but not remove it. §4.1's reordering retired the category: a surviving light is not dimmed, it
    // is applied over the ground the darkness produced — the `dark` cell below, which reaches this
    // emitter as the `base` its zones are measured from. Nothing here needs to know, because
    // `stampDomains` assigns that base.
  }

  // --- Fill, per region. ---
  //
  // The fill is the whole effective region, with nothing subtracted — blocked emitters contribute
  // nothing, and surviving ones do not replace the ground, they stand on it (§4.1). The old version
  // subtracted every emitter's polygon and dimmed them instead, leaving a lit-looking lens wherever
  // a torch crossed a darkness; the 2026-08-29 version subtracted only the survivors, the same bug
  // in miniature — the hole read at the container's clear colour, the scene's un-reduced darkness,
  // so a lamp inside a darkness on a lit map undid the spell over its own radius.
  const ambientB = ambient ? ambient.brightnessAt() : 0;

  // What each domain's ground is worth before any suppressor touches it (§10.7). A darkness
  // transforms down from the ambient where it stands, so one cast inside an unlit cellar reduces
  // Dark and not the Bright street outside — without this it renders brighter than the room around
  // it, the failure backwards.
  //
  // `null` on a scene with no ambient areas, and also when global illumination is off: there is
  // then no ambient to override, and `ambientB` is already 0 for the same reason.
  const domainBases =
    domains && ambient
      ? domains.list.map((d) => ({ paths: d.paths, B: tierCeiling(d.tier) }))
      : null;

  // The ground each region produced, as a domain — see {@link stampDomains} and the note on
  // `regionDomains` below. Collected here because this loop already resolves the tier.
  const regionParts = [];

  for (const region of regions) {
    const fill = region.effective;
    if (!fill.length) continue;

    // The tier is the transformed ambient level, not a fixed Supernatural Dark. At noon a darkness
    // drops Bright to Normal; at midnight it bottoms out at its floor.
    //
    // Through `resolveTier`, not `tierOf`: thresholding cannot tell Supernatural Dark from Dark,
    // since both are B = 0, so the floor is applied here where the suppressor is known. Calling
    // `tierOf` directly made every `dark` cell report Dark however supernatural its source, which
    // silently disabled the renderer's black fill and the umbra's top rank alike.
    const floor = region.suppressor.floor ?? TIER.DARK;

    if (!domainBases) {
      const B = applyTransform(ambientB, region.suppressor.transform, floor);
      const tier = resolveTier(B, { floor });
      // `clipped: true` — a `dark` cell is always a Clipper product, never a source's own outline,
      // and the darkness source drawn for it is narrowed to exactly this region.
      emit("dark", fill, null, region.suppressor, null, tier, true);
      regionParts.push({ tier, paths: fill, suppressor: region.suppressor });
      continue;
    }

    // One `dark` cell per domain the region crosses. A darkness lying half in a cellar and half in
    // the street is genuinely two different tiers, and drawing it as one picks the wrong answer for
    // half of it.
    for (const base of domainBases) {
      const part = intersection(fill, base.paths);
      if (!part.length) continue;
      const B = applyTransform(base.B, region.suppressor.transform, floor);
      const tier = resolveTier(B, { floor });
      emit("dark", part, null, region.suppressor, null, tier, true);
      regionParts.push({ tier, paths: part, suppressor: region.suppressor });
    }
  }

  // --- `ambient` — everywhere a suppressor does *not* govern. DESIGN.md §7.0. ---
  //
  // The complement of the regions, not of the `dark` cells. A part of a suppressor's disc that a
  // breaker cancelled is absent from `effective`, and ambient applies there normally — so
  // subtracting `effective` is what makes a daylight-cancelled slice stay lit. Subtracting the
  // `dark` fills would also punch out wherever a `reducing` emitter happened to light the ground,
  // which is a different question.
  //
  // Two Clipper ops on any scene with a suppressor, against §9.6's measured ~4.4 ms budget of many.
  // Cheap but not free, which is why the no-suppressor branch above skips both.
  // Everywhere a suppressor governs, as one path set. Both consumers below need exactly this, so it
  // is unioned once — it was two identical ops when `stack` landed.
  const governed = union(regions.map((r) => r.effective).filter((p) => p.length).flat());

  // Every darkness region is now a ground in its own right (§4.1.1a), so `stampDomains` asks this
  // list rather than §10.7's areas alone what tier a cell stands on. Falls back to `domains`
  // unchanged, `null` included, when no region survived: `regionParts` is empty exactly when
  // `governed` is, so a scene with no darkness keeps the op count it had.
  //
  // Stamping only. The stack pass below needs the suppressor as well as the tier, so it reads
  // `regionParts` directly — see the note there.
  const ground = groundDomains(domains, regionParts, governed, sceneTier);

  if (!domains) {
    // No `ambientB > 0` guard, since §7.0 step 6. An unlit scene used to emit no ambient cell at all
    // and let the container's clear colour stand in, invisible only because that clear is
    // `canvas.environment.darknessLevel` and the default table puts Dark at 1.0 as well. Two things
    // now depend on the ground actually being painted: `MIN_COLOR` light meshes need an opaque base
    // to blend down from, and any retuned table would make a darkness spell render lighter than the
    // night around it.
    const rect = ambientDomain(SCALE);
    if (rect?.length) {
      const open = governed.length ? difference([rect], governed) : [rect];
      emitAmbient(open, ambient, tierOf(groundBrightness(ambient)));
    }
  } else {
    // The same complement, taken per domain (§10.7). Each is already confined to its own part of the
    // map, so the only thing left to remove is what a suppressor governs.
    for (const domain of domains.list) {
      if (!domainNeedsCell(domain.tier, sceneTier)) continue;
      const open = governed.length ? difference(domain.paths, governed) : domain.paths;
      // Hard unless the domain owes its tier to a computed area — see `ambientDomains`.
      if (open.length) emitAmbient(open, ambient, domain.tier, !domain.derived, domain.derived);
    }
  }

  // --- `stack` — where two or more relative bands overlap. DESIGN.md §3.2.1. ---
  //
  // Open ground first, exactly as before: every emitter, once per ambient domain, with everything
  // a suppressor governs cut out.
  const stacks = [];
  if (!domains) stacks.push(...emitStacks(emitters, sceneTier, governed));
  else {
    for (const domain of domains.list) {
      stacks.push(
        ...emitStacks(emitters, domain.tier, [...governed, ...outsideOf(domain, SCALE)])
      );
    }
  }

  // Then inside the regions, new with §4.1.1a, and it must be filtered by eligibility rather than
  // geometry alone. `emitStacks` sums bands over whatever emitter list it is handed; a region's
  // blocked emitters are still in `emitters`, still have bands, and those bands still overlap.
  // Handing it the unfiltered list built a Normal overlap out of two level-2 lights a level-2
  // darkness had put out — each light alone correctly showed nothing, and the pair lit the ground
  // between them (2026-08-29). Nothing in the pass could catch that: geometry is all it sees.
  //
  // The survivors are the set `contest` calls `over`, so two surviving lights overlapping inside a
  // darkness do still stack — from the tier it reduced the ground to.
  for (const part of regionParts) {
    const isEligible = eligibilityFn(part.suppressor.eligibility);
    const survivors = emitters.filter((e) => !isEligible(e, part.suppressor));
    if (survivors.length < 2) continue;
    stacks.push(...emitStacks(survivors, part.tier, outsideOf(part, SCALE)));
  }

  for (const cell of stacks) cells.push(cell);

  return finish(stampDomains(cells, ground, sceneTier), t0, {
    filtered: filter,
    emitters: emitters.length,
    suppressors: suppressors.length,
    regions: regions.length,
    stacks: stacks.length,
    domains: domains?.list.length ?? 0,
    // Distinct ground tiers the map resolved into, regions included. `domains` above counts only
    // §10.7's areas, so the two differ exactly when there is a darkness on the scene.
    grounds: ground?.list.length ?? 0,
    ambientB: +ambientB.toFixed(3),
  });
}

/* -------------------------------------------- */
/*  Band stacking — §3.2.1                      */
/* -------------------------------------------- */

/**
 * How many bands deep the enumeration goes.
 *
 * @remarks
 * Four rungs separate Dark from Bright, so with the usual one-step bands nothing above four
 * overlapping lights can change an answer — and the usual `cap` of Normal makes it two. The bound
 * is on combinations, not on lights, which is what keeps this from being exponential.
 */
const MAX_STACK_DEPTH = 4;

/**
 * A band's bounding box, without touching Clipper.
 *
 * @remarks
 * The point of computing it separately: the overlap search is `O(n²)` in candidates and most scenes
 * have none, so the pairwise rejection has to happen before a single path is built.
 * `shape.getBounds()` is the swept polygon's own cached extent.
 */
function bandBox(emitter) {
  const bounds = emitter.shape?.getBounds?.();
  if (!bounds) return null;
  return {
    minX: Math.round(bounds.x * SCALE),
    minY: Math.round(bounds.y * SCALE),
    maxX: Math.round(bounds.right * SCALE),
    maxY: Math.round(bounds.bottom * SCALE),
  };
}

/**
 * The annulus a light raises the level across: its swept shape, less its own inner disc.
 *
 * @remarks
 * `shape` is already the wall sweep at the outer radius, so occlusion is inherited rather than
 * recomputed. The inner disc is subtracted rather than swept separately because inside it the set
 * level governs and the source draws it natively — a background repaint there would fight the light
 * rather than complete it.
 */
function bandPaths(emitter, emission) {
  const path = emitter.path(SCALE);
  if (!path?.length) return null;
  if (emission.inner <= 0) return [path];

  // Foundry's own density heuristic, so a large inner radius does not get a visibly faceted hole
  // (`circle-extension.mjs:138`).
  const core = new PIXI.Circle(emitter.source.x, emitter.source.y, emission.inner).toPolygon({
    density: PIXI.Circle.approximateVertexDensity(emission.inner),
  });
  const paths = difference([path], [toClipperPath(core, SCALE)]);
  return paths.length ? paths : null;
}

/**
 * Cells for every place two or more relative bands overlap.
 *
 * @remarks
 * Exists because the illumination layer blends `MAX_COLOR` (`base-light-source.mjs:72`) — two
 * overlapping dim bands composite as one dim band, so the renderer cannot show a sum on its own.
 * The shader floors both zones at the background
 * (`computedDimColor = max(computedDimColor, computedBackgroundColor)`), so painting the overlap
 * into the darkness-level texture at the summed tier makes a brighter background win over the light
 * drawn on top of it — the right pixel, through machinery §7.0 already built.
 *
 * Combinations rather than a coverage count, because `steps` and `cap` are per-source levers
 * (§3.2.1) and a count cannot express either. Bounded four ways, in this order, each bound cheaper
 * than the one after it:
 *
 *   1. Fewer than two bands on the scene at all — the single-light case pays nothing.
 *   2. Bounding boxes, before any Clipper call. Band geometry is built only for emitters whose
 *      extent meets another's, so a scene of scattered torches costs `n²` integer comparisons and
 *      zero ops.
 *   3. Bounding boxes again, per combination, as the search deepens.
 *   4. Depth, at {@link MAX_STACK_DEPTH}.
 *
 * Emitted nested rather than disjoint, deliberately: the darkness-level container sorts descending,
 * so the lowest level wins where meshes overlap (`illumination-effects.mjs:106-110`). A three-band
 * region inside a two-band region is brighter, so it wins by construction and no difference op is
 * needed to carve it out.
 *
 * @param {object[]} emitters
 * @param {number} base - The ambient tier these bands raise from
 * @param {object[]} governed - Suppressor regions, as Clipper paths. Where a darkness governs, the
 *   `dark` cells have already said what the ground is.
 * @returns {object[]} Cells of kind `stack`
 */
function emitStacks(emitters, base, governed) {
  if (emitters.length < 2) return [];

  // --- Candidates, by geometry-free tests only. ---
  const candidates = [];
  for (const emitter of emitters) {
    const emission = normaliseEmission(emitter.emission);
    if (emission.steps <= 0 || emission.outer <= emission.inner) continue;
    // A band that cannot raise the ambient even one rung has nothing to contribute to a sum.
    if (emission.cap <= base) continue;
    const box = bandBox(emitter);
    if (box) candidates.push({ emitter, emission, box });
  }
  if (candidates.length < 2) return [];

  // --- Pairwise box rejection, still before Clipper. ---
  const overlapping = candidates.filter((c, i) =>
    candidates.some((other, j) => i !== j && boxesOverlap(c.box, other.box))
  );
  if (overlapping.length < 2) return [];

  // --- Only now does anything cost an op. ---
  const bands = [];
  for (const candidate of overlapping) {
    const paths = bandPaths(candidate.emitter, candidate.emission);
    if (paths) bands.push({ ...candidate, paths });
  }
  if (bands.length < 2) return [];

  const cells = [];

  /**
   * @param {number[]} indices - Bands in the current combination
   * @param {object[]} paths - Their intersection
   * @param {object} box - That intersection's extent
   */
  const extend = (indices, paths, box) => {
    if (indices.length >= MAX_STACK_DEPTH) return;
    for (let j = indices[indices.length - 1] + 1; j < bands.length; j++) {
      const next = bands[j];
      if (!boxesOverlap(box, next.box)) continue;

      const inside = intersection(paths, next.paths);
      if (!inside.length) continue;

      const combo = [...indices, j];
      const steps = combo.reduce((sum, i) => sum + bands[i].emission.steps, 0);
      // `max` of the caps, never `min` — a cap says what that source can do alone, so the most
      // capable covering band sets the ceiling (§3.2.1).
      const ceiling = combo.reduce((max, i) => Math.max(max, bands[i].emission.cap), TIER.DARK);
      const tier = Math.max(base, Math.min(stepTier(base, steps), ceiling));

      // What the brightest single band already delivers here. The bands composite by `MAX_COLOR`, so
      // this is a `max` over them, not the sum — the sum is what the model resolves to, and the gap
      // between the two is all this cell has to add.
      const bandRungs = combo.reduce(
        (max, i) =>
          Math.max(
            max,
            Math.min(stepTier(base, bands[i].emission.steps), bands[i].emission.cap) - base
          ),
        0
      );

      // Two ways a combination has nothing to contribute, and they are different:
      //
      //   `tier <= base`             the model says this overlap is no brighter than open
      //                              ground — a third torch under a shared cap of Normal.
      //   `tier <= base + bandRungs` it *is* brighter than open ground, and one of the bands
      //                              already reaches it unaided. Nothing left to add.
      if (tier > base && tier > base + bandRungs) {
        const open = governed.length ? difference(inside, governed) : inside;
        for (const { outer, holes } of groupRings(toPolygons(open))) {
          cells.push({
            kind: "stack",
            polygon: outer,
            holes,
            emitter: null,
            suppressor: null,
            emission: null,
            tier,
            // The ambient this overlap was summed from, and the domain's base — this function is
            // already called once per domain (§10.7), so a stack cell has always known the right
            // answer and simply never carried it to `light-ramps.rampsFrom`, whose
            // `cell.base ?? sceneTier` then fell through to the scene's tier. Stamped here rather
            // than by `stampDomains`: the one cell kind that already knows. See `baseFor`.
            base,
            // The emitters whose bands made this region, and the renderer needs every one. A stack
            // cell is drawn by cloning each at a raised level and letting `MAX_COLOR` pick the
            // brightest, which reproduces `max(falloff_i)` with the rung added and so matches the
            // curve on the far side of the boundary. One clone would match only where that
            // particular light happened to be strongest.
            emitters: combo.map((i) => bands[i].emitter),
            bands: combo.length,
            steps,
          });
        }
      }

      // Deeper only while another rung is still reachable. A combination already at its ceiling
      // cannot be improved by adding a band.
      if (tier < ceiling) extend(combo, inside, boundsOfPaths(inside));
    }
  };

  for (let i = 0; i < bands.length - 1; i++) extend([i], bands[i].paths, bands[i].box);
  return cells;
}

function finish(cells, t0, extra) {
  return {
    generation: version(),
    cells,
    stats: {
      cells: cells.length,
      byKind: cells.reduce((acc, c) => ((acc[c.kind] = (acc[c.kind] ?? 0) + 1), acc), {}),
      annuli: holeCount,
      // Non-zero means a cell is rendering over-bright: the splitter could not resolve its holes and
      // dropped them. See `splitAnnuli`.
      droppedHoles,
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
 * The registry generation alone is not sufficient, and assuming it was is a bug this nearly shipped
 * with. A light-bearing token walking across the scene does not stale the registry — position is
 * read live (see `affectsRegistry`) — but it does change the field, since every cell is cut from
 * `source.shape`.
 *
 * Foundry allocates a new polygon object each time it re-runs `_createShapes`, at the end of every
 * move, wall edit and door toggle. So comparing shape references catches all of it with no
 * bookkeeping and nothing to remember to invalidate — the trick `Entry#path` uses one level down.
 *
 * Ambient brightness rides along because it sets the tier `dark` cells fill at, and it slides
 * continuously during a darkness animation.
 */
function currentSignature() {
  // `areas.version()` and not the areas themselves: a region's geometry lives on the document rather
  // than a per-frame object, so there is no reference that changes when it moves. The counter is
  // bumped by the region hooks in `model/areas.mjs`, the only thing that can change any of it.
  const parts = [version(), ambientBrightness(), areas.version()];
  for (const entry of registryEmitters()) {
    // The global source is excluded. It contributes nothing: its domain is the scene rect, fixed per
    // scene (see {@link ambientDomain}), and its brightness rides in through `ambientBrightness()`
    // above.
    //
    // It was also load-bearing under the `customPolygon` version of §7.0, where its `shape` was this
    // module's own output and was reallocated by every `_createShapes` — so including it made the
    // signature differ from itself on every pass: recompute → repaint → new shape → recompute,
    // forever. That version is gone, but the exclusion is right on its own terms.
    if (entry.isGlobal) continue;
    parts.push(entry.shape);
  }
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
 * Still a whole-field cache: any change recomputes everything. §8.3 is where that gets smarter —
 * the measured 4.4 ms (§9.6) is affordable once, not once per token step. What this buys is
 * correctness plus a free win: comparing ~50 object references costs nothing next to a recompute,
 * and most frames change nothing at all.
 *
 * @returns {{generation: number, cells: Cell[], stats: object}}
 */
export function get() {
  const next = currentSignature();
  if (cached && signatureMatches(next)) return cached;
  signature = next;
  return (cached = compute());
}

/**
 * Adopt the current geometry as the baseline without recomputing the field.
 *
 * @remarks
 * Closes the renderer's oldest feedback loop, unnoticed while each turn of it was cheap and a
 * 200 ms-per-frame stall once §6.4.2's feather and §6.4.3's clipped-light soft edges made a turn
 * expensive (2026-08-23, on an idle scene).
 *
 * The loop: `rebuild` re-initialises every source whose clip changed, `initialize` re-runs
 * `_createShapes`, and `_createShapes` allocates a new `shape` polygon. Shapes are the signature
 * (see {@link currentSignature}), so re-initialising invalidates the very field that asked for it —
 * recompute, restage, reallocate, forever, with nothing on the scene changing.
 *
 * The re-sweep is semantically a no-op: same walls, same radius, same points, a different object. So
 * the honest fix is to tell the cache that, rather than stop re-initialising (which is what applies
 * a new clip) or compare polygons by value (which costs more than the rebuild it saves).
 *
 * Narrow by construction: it only suppresses a recompute this module's own re-mesh caused. If
 * something genuinely changed in the same tick, the hook that carried it fires again and the next
 * frame picks it up.
 */
export function resync() {
  signature = currentSignature();
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
 * Reports the inputs to `resolveRegions` and the emitter classification side by side: which
 * emitters break each suppressor, how much of the region survived, and which emitters cancel
 * themselves against it. Cell counts alone cannot distinguish "the daylight was never considered a
 * breaker" from "it was, and the geometry came out empty", and those need different fixes.
 *
 * @returns {object}
 */
export function explain() {
  const hasShape = (e) => e.shape?.points?.length > 0;
  const emitters = registryEmitters().filter((e) => !e.isGlobal && hasShape(e));
  const suppressors = [...registrySuppressors()].filter(hasShape).sort((a, b) => b.level - a.level);

  // Area, not path count. A circle with a bite out of it is still one path, so counting paths
  // cannot tell carved from untouched — the mistake the first version of this made.
  const areaOf = (paths) =>
    paths.reduce((sum, p) => sum + Math.abs(ClipperLib.Clipper.Area(p)), 0) / (SCALE * SCALE);
  const pct = (a, b) => (b > 0 ? +((1 - a / b) * 100).toFixed(1) : 0);

  opCount = 0;
  holeCount = 0;
  droppedHoles = 0;
  const carved = carveRegions(suppressors);
  const live = resolveRegions(carved.regions, emitters);

  // Emitter side: how much of each light survived into `clip` cells. A daylight overlapping a
  // darkness that is not losing area means `selfCancelled` is not subtracting.
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
    // `removedPct: 0` on both sides is ambiguous alone: it reads the same whether the subtraction is
    // broken or the shapes barely touch. The gap between what the model sees and what is on screen
    // is real — a darkness source renders at `radius + padding` through `_visualShape`
    // (`point-darkness-source.mjs:132-135`), so its violet disc is wider than the `shape` the model
    // measures.
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
