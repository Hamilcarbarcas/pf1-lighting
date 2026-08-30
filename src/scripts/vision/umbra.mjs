/**
 * Umbra geometry — DESIGN.md §4.3, §8.2 step 6.
 *
 * The region an observer cannot see clearly because a magical darkness lies between them and it.
 * The piece that makes the whole model observer-relative, fixing §2.3's motivating failure case:
 * ground beyond a darkness reading bright to a darkvision token looking through it.
 *
 * Difference of sweeps, not tangent cones. §4.3 originally specified constructing the tangent cone
 * from the observer around each suppressor's polygon; unnecessary now that sight-blocking edges
 * exist, since a sweep that stops at a darkness boundary is precisely the complement of the region
 * beyond it.
 *
 * ```
 * umbra at tier T  =  the observer's reach  −  that reach swept respecting every region at
 *                                              least as dark as T
 * ```
 *
 * Better than cones on four counts:
 *
 *   - non-convex darkness needs no tangent-line maths;
 *   - multiple suppressors resolve in one pass per tier, with no union step;
 *   - every sweep is configured identically, so nothing can drift between them;
 *   - the observer-inside case falls out with no branch — their truncated sweep is the bubble, so
 *     the difference is everything else, i.e. the 360° umbra §4.3 insists must not be
 *     special-cased.
 *
 * Walls are excluded from both sweeps — see {@link umbraFor}. The umbra says where darkness lies
 * between two points; whether a wall also does is a different question, already answered elsewhere
 * in both the detection path and the render path.
 *
 * The ladder, and why nesting gives per-tier umbra for free. Edges are ranked by how dark the region
 * behind them is (`UMBRA_RANK`), and a sweep at rank R respects every edge ranked R or above
 * (`clockwise-sweep.mjs:236`). So sweeping at successive ranks yields nested results — the
 * Dim-and-darker umbra contains the Dark-and-darker umbra — and peeling each off the next turns
 * nesting into disjoint regions, each carrying its own clamp.
 *
 * | | Rank |
 * | --- | --- |
 * | Normal region | 1 |
 * | Dim region | 2 |
 * | Dark region | 3 |
 * | Supernatural Dark region | 4 |
 * | Ordinary vision sweep | 4 — blocked only by Supernatural Dark |
 * | Light-independent sight | 5 — blocked by nothing |
 *
 * Supernatural Dark is a rung like any other. It once was not — on the argument that `los` already
 * stops there, so the region beyond is invisible and needs no clamp — which confused not reachable
 * by sight with not drawn. See {@link umbraTiersPresent}.
 *
 * Cost is one sweep for the base plus one per tier actually present, which on an ordinary scene is
 * two.
 *
 * Walls stay immune throughout: `_determineEdgeTypes` registers them at `-Infinity`
 * (`clockwise-sweep.mjs:101`), so no rung of this ladder can unblock one.
 *
 * `perceivedTier` clamps its god's-eye answer to whatever region the point falls in
 * ({@link clampAt}), which makes every detection mode observer-relative at once, since they all
 * route through it. Nothing here touches rendering: a lit room seen through a darkness stops
 * revealing the tokens in it but still looks lit. That half is §7.1, and the two are independent
 * rather than one a subset of the other.
 *
 * The edges come from cells — see `umbra-edges.mjs`. Derived from `field()` cells rather than from
 * suppressor shapes, which is what makes a daylight-cancelled slice cast nothing and a two-band
 * suppressor cast two different strengths. The ranks swept here are read from the same cells, so the
 * two cannot drift.
 */

import {
  CLIPPER_SCALE,
  containsPoint,
  difference,
  fromClipperPaths,
  intersection,
  splitRings,
  toClipperPath,
} from "../geometry.mjs";
import { TIER, TIER_NAME } from "../model/tiers.mjs";
import { castsUmbra } from "../model/contest.mjs";
import * as field from "../model/field.mjs";
import { MODULE_ID, VISION_RANK, umbraRank } from "../constants.mjs";
import { t } from "../i18n.mjs";
import { flag } from "../settings-cache.mjs";
import { isPerceptionEnabled, visualDarkSightRange } from "./perception.mjs";
import { stats as edgeStats } from "./umbra-edges.mjs";

/**
 * Umbra tiers actually present on the scene, darkest first.
 *
 * @remarks
 * Read off the field's cells, not off the suppressors, because a suppressor no longer has a single
 * tier — a two-band source has two, and a region cancelled by a daylight has none. `umbra-edges.mjs`
 * ranks its edges the same way, from the same cells, so the ranks swept here and the ranks emitted
 * there cannot drift.
 *
 * Supernatural Dark is included, corrected 2026-08-23. It was excluded on the argument that
 * `VISION_RANK.NORMAL` already blocks at that rank, so the region beyond is absent from `los` and
 * there is nothing to clamp. Absent from `los` does not mean absent from the picture: the region
 * still carries whatever tier the god's-eye field gave it, the darkness-level texture paints that
 * scene-wide, and the fog layer shows it. The result was an observer standing inside a deeper
 * darkness faintly making out every darkness bubble on the map, and ground behind one rendering
 * merely dimmer rather than dark.
 *
 * Excluding it also broke the peeling: with no Supernatural rung the region beyond a supernatural
 * bubble fell through to whatever the next rank down claimed, disturbing the other umbrae.
 *
 * Nothing is ranked above it, so it needs a base sweep that no darkness stops — see
 * {@link umbraFor}, which sweeps the base at `VISION_RANK.PIERCING`.
 */
function umbraTiersPresent() {
  const ranks = new Set();
  for (const cell of field.get().cells) {
    // `dark` alone since 2026-08-29 — `reduced` was tested here too and is retired (§4.1.1a).
    if (cell.kind !== "dark") continue;
    if (!cell.suppressor || !castsUmbra(cell.suppressor)) continue;
    const rank = umbraRank(cell.tier);
    if (rank > 0) ranks.add(rank);
  }
  // Darkest first, so nesting can be peeled outward.
  return [...ranks].sort((a, b) => b - a);
}

/** The tier a rank corresponds to. Inverse of {@link umbraRank}. */
function tierOfRank(rank) {
  for (const tier of [TIER.SUPERNATURAL_DARK, TIER.DARK, TIER.DIM, TIER.NORMAL]) {
    if (umbraRank(tier) === rank) return tier;
  }
  return TIER.DARK;
}

/**
 * Does this observer see umbra at all?
 *
 * @remarks
 * Only see in darkness is wholly exempt, because only it is unbounded. It sweeps above every
 * darkness rank, so its reach ignores the edges the difference is taken against and the result would
 * be empty anyway; skipping the sweep is cheaper than proving that.
 *
 * True seeing shares the faculty and not the reach — §4.5.1: a range, not a flag — so exempting it
 * outright meant a creature with 60 ft of true seeing cast and received no umbra anywhere on the map
 * (2026-08-23). The bounded case is handled in {@link umbraFor} by cutting the exempt disc out of
 * the umbra rather than by skipping it, which is the only version right at both ends of the range.
 *
 * `visualDarkSightRange`, not `darkSightRange`, and that difference is blindsight. The wider
 * function includes it, so a blindsighted creature was exempted from umbra altogether. Wrong twice
 * over: blindsight is not sight — it perceives without seeing, saying nothing about how brightly lit
 * a place looks — and it is range-bounded too.
 */
function subjectToUmbra(source) {
  return isPerceptionEnabled() && visualDarkSightRange(source) !== Infinity;
}

/** A circle as a Clipper path. Used to cut a bounded sight exemption out of the umbra. */
function discPath(x, y, radius, segments = 60) {
  const path = new Array(segments);
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    path[i] = {
      X: Math.round((x + Math.cos(angle) * radius) * CLIPPER_SCALE),
      Y: Math.round((y + Math.sin(angle) * radius) * CLIPPER_SCALE),
    };
  }
  return path;
}

/**
 * The umbra-casting ground the observer is **standing on**. DESIGN.md §4.3.
 *
 * @remarks
 * The 360° case has a floor, and it was missing. `umbraFor` builds each region as `los −
 * sweep(rank)`, and a sweep taken from inside a darkness is stopped by that darkness's own edges, so
 * `sweep` is the disc and every region it produces is the ground outside it. The disc the observer
 * occupies therefore appeared in no region at all, which the consumers read as not in umbra:
 *
 * - `umbra-mask` hides only regions clamped below `SIGHT_TIER`, so everything the observer looked
 *   through the darkness at went black, while the darkness they were standing in kept the god's-eye
 *   texture — the faintly legible `ambientDarkness` ground;
 * - which renders the whole disc uniformly brighter than the map around it (2026-08-29), drawing the
 *   one shape a creature blinded by that darkness should be least able to see.
 *
 * The rule reads the same from either side: a creature in magical darkness sees nothing there,
 * neither the ground beyond it nor the ground under its own feet. Clamping the disc to its own tier
 * is a no-op for the darkness-level texture, which already paints that tier; what it changes is that
 * the mask now treats it like the rest of the umbra.
 *
 * From the field's cells, like `umbraTiersPresent` and `umbra-edges`, so the tier here cannot drift
 * from the tier swept for. Intersected with `los` — which already has any bounded true-seeing disc
 * cut out of it — so a creature that can see in its own square keeps that exemption without this
 * needing to know the faculty exists.
 *
 * @param {{x: number, y: number}} origin
 * @param {object[]} losPath - The observer's reach, exemptions already removed
 * @returns {{polygons: PIXI.Polygon[], clamp: number}|null}
 */
function standingIn(origin, losPath) {
  // Carved regions are disjoint (`field.carveRegions`), so in practice one cell claims the point.
  // Collected as a list anyway because a `dark` cell is split per ambient domain and per annulus,
  // and two pieces of one darkness meeting at the observer's feet must not resolve to whichever the
  // cell order happened to put first.
  const under = [];
  let darkest = null;
  for (const cell of field.get().cells) {
    if (cell.kind !== "dark") continue;
    if (!cell.suppressor || !castsUmbra(cell.suppressor)) continue;
    if (umbraRank(cell.tier) <= 0) continue;
    if (!containsPoint([cell.polygon, ...(cell.holes ?? [])], origin)) continue;
    under.push(cell);
    if (darkest === null || cell.tier < darkest) darkest = cell.tier;
  }
  if (darkest === null) return null;

  // Bounded by what the observer could reach in the first place: beyond a wall is somebody else's
  // problem, and `los` is where the bounded true-seeing exemption already lives.
  const paths = under
    .filter((cell) => cell.tier === darkest)
    .map((cell) => toClipperPath(cell.polygon, CLIPPER_SCALE));
  const inside = intersection(paths, losPath);
  if (!inside.length) return null;

  const polygons = fromClipperPaths(inside, CLIPPER_SCALE);
  return polygons.length ? { polygons, clamp: darkest } : null;
}

/** Fast-path hits and sweep fallbacks for {@link unobstructedReach}, for {@link stats}. */
let reachDirect = 0;
let reachSwept = 0;

/**
 * The observer's unobstructed reach, without running a sweep. DESIGN.md §9.9.
 *
 * @remarks
 * The base sweep cannot be blocked by anything, and was costing a full sweep to say so. `umbraFor`
 * configures it with `edgeOptions.wall = false` and `priority: VISION_RANK.PIERCING`, which outranks
 * every darkness rank, so `_determineEdgeTypes` admits no edge at all and `ClockwiseSweepPolygon`
 * walks `_identifyEdges` → the edge quadtree → `_executeSweep` → the vertex sort to return the
 * boundary box it started from.
 *
 * Measured 2026-08-28, on the frame that produced a 570 ms stall: the sweep came back with four
 * points and the area of the scene rect. It is in the stack of the spike itself — `_testPoint →
 * perceives → perceivedTier → clampAt → regionsFor → umbraFor → create → _compute` — because
 * `regionsFor` misses whenever an observer's `los` is replaced, which for a moving token is every
 * vision refresh, and the rebuild then happens inside a detection test.
 *
 * The bounding box is asked of core rather than reconstructed. `_defineBoundingBox` is `sceneRect`
 * or `rect` depending on the `innerBounds` edge behaviour, intersected with every boundary shape,
 * then `.ceil().pad(1)` (`clockwise-sweep.mjs:269-273`); replicating that here would be a second
 * copy of a derivation that can change underneath. `initialize()` computes it and does not sweep;
 * `compute()` is what calls `_compute` (`source-polygon.mjs:76-80`). So the fast path is core's own
 * answer with only the walk skipped.
 *
 * 360° only. A limited-angle source carries a cone in `boundaryShapes` and its swept result is that
 * cone rather than the box, so it falls back to the real sweep — correct and rare.
 *
 * Falls back on anything unexpected: a wrong answer here would silently mis-shape every umbra.
 *
 * @param {{x: number, y: number}} origin
 * @param {object} config - The sweep configuration, already carrying `priority` and `edgeOptions`
 * @returns {PIXI.Polygon|null} The reach, or `null` to sweep for it
 */
function unobstructedReach(origin, config) {
  // A cone is not its bounding box.
  if ((config.angle ?? 360) < 360) return null;
  try {
    const cls = CONFIG.Canvas.polygonBackends.sight;
    const poly = new cls();
    // A copy, because `initialize` writes `boundingBox` and the defaulted edge types back into it
    // and the caller reuses this object for the rank sweeps below.
    poly.initialize(origin, { ...config });

    const box = poly.config?.boundingBox;
    if (!(box?.width > 0 && box?.height > 0)) return null;

    // The bounding box is the answer plus a pixel. `_defineBoundingBox` ends `.ceil().pad(1)` so it
    // always contains the origin (`clockwise-sweep.mjs:269-273`), while the sweep's own output
    // follows the boundary edges, which are the unpadded rect. Returning the box gave a polygon one
    // pixel proud on every side (2026-08-28: 31,206,004 against the sweep's 31,183,600, a ratio of
    // 1.000718) — a hairline of umbra around the map edge, the kind of one-pixel seam §6.4 exists to
    // remove.
    //
    // Which rect the boundary uses is core's decision, exposed as `useInnerBounds`
    // (`clockwise-sweep.mjs:53`, set from the `innerBounds` edge behaviour in `initialize`), so it is
    // read rather than guessed.
    const rect = poly.useInnerBounds ? canvas.dimensions?.sceneRect : canvas.dimensions?.rect;
    if (!(rect?.width > 0 && rect?.height > 0)) return null;

    // The box must still contain that rect, or a boundary shape is clipping the reach — a radius
    // smaller than the map, or a shape a future caller adds. The result is then not a rectangle and
    // there is nothing to shortcut, so sweep for it. With `radius = maxR` this always passes, which
    // is why the fast path is the normal one.
    if (
      box.x > rect.x ||
      box.y > rect.y ||
      box.right < rect.right ||
      box.bottom < rect.bottom
    ) {
      return null;
    }

    return rect.toPolygon();
  } catch (error) {
    console.error("PF1 Lighting | unobstructed reach fast path failed; falling back to a sweep", error);
    return null;
  }
}

/**
 * The umbra for one observer, as a list of regions.
 *
 * @remarks
 * Disjoint regions, each with its own clamp. One observer genuinely has several: a two-band
 * suppressor casts a weaker umbra from its rim than from its core, and a region cancelled by a
 * daylight casts none at all. Consumers must never assume one tier.
 *
 * @param {PointVisionSource} source
 * @returns {{regions: {polygons: PIXI.Polygon[], clamp: number}[], ms: number}}
 */
export function umbraFor(source) {
  const t0 = performance.now();
  const empty = { regions: [], ms: 0 };

  if (!source?.los || !subjectToUmbra(source)) return empty;

  const ranks = umbraTiersPresent();
  if (!ranks.length) return empty;

  // Both sweeps ignore walls, and the base is swept rather than reusing `los`. An umbra is a
  // statement about darkness, not about visibility, and letting walls into it produced wall-shaped
  // bites in the painted shadow (2026-08-23: an L-shaped notch of full brightness cut through a
  // darkness's umbra).
  //
  // Wrong geometry rather than merely ugly, for two reasons. The umbra is painted into a scene-wide
  // texture, so its boundary is visible wherever that ground is otherwise shown — the wall
  // silhouette leaks into the picture as a lighting feature, which it is not. And nothing is lost: a
  // point a wall hides is already unreachable, so clamping it changes no verdict.
  // `DetectionMode#_testLOS` fails there whatever this returns.
  //
  // `edgeOptions: {wall: false}` is core's own opt-out — `_determineEdgeTypes` skips any edge type
  // set `false` (`clockwise-sweep.mjs:97-103`) — so this is configuration, not a patch. The cost is
  // one extra sweep per observer, because `source.los` respects walls and can no longer serve as the
  // base.
  const base = { ...source._getPolygonConfiguration() };
  base.edgeOptions = { ...(base.edgeOptions ?? {}), wall: false };

  // Do not inherit a blindness-collapsed radius; the reason is circular reasoning.
  //
  // `PointVisionSource#_getPolygonConfiguration` sets `radius` to `externalRadius` — the token's own
  // footprint — whenever `blinded.darkness` is set (`point-vision-source.mjs:289-290`). Correct for
  // `los`, self-defeating here: §4.5.1 blinds a creature because it is standing in supernatural
  // darkness, so inheriting that collapses the umbra of the very bubble the observer is inside to
  // nothing. The 360° observer-inside case §4.3 insists must not be special-cased was being deleted
  // by a special case elsewhere.
  //
  // `maxR` is not a widening: it is what the same method returns for an unblinded source, so this
  // restores the observer's reach rather than inventing one. What the creature can see is still
  // bounded by `los` and by the detection modes, neither of which this touches.
  if (source.data?.disabled || source.suppressed) return empty;
  base.radius = canvas.dimensions.maxR;

  // `PIERCING`, so no darkness stops the base. The difference is only meaningful against a reach
  // every rank can be subtracted from, and Supernatural Dark is now a rank (`umbraTiersPresent`) —
  // sweeping the base at `NORMAL` would have it stopped by the very edges the darkest rung needs to
  // measure, and `los − los` is empty. At `PIERCING` the base is the observer's unobstructed reach:
  // sight radius and angle, nothing else.
  const baseConfig = { ...base, priority: VISION_RANK.PIERCING };
  // Nothing can block this one — see {@link unobstructedReach} — so it is built rather than swept
  // wherever that holds, which removes one full sweep per observer per movement.
  let unshadowed = unobstructedReach(source.origin, baseConfig);
  if (unshadowed) reachDirect++;
  else {
    reachSwept++;
    try {
      unshadowed = CONFIG.Canvas.polygonBackends.sight.create(source.origin, baseConfig);
    } catch (error) {
      console.error("PF1 Lighting | umbra base sweep failed", error);
      return empty;
    }
  }

  let losPath = [toClipperPath(unshadowed, CLIPPER_SCALE)];

  // A bounded light-independent sight is a hole in the umbra, not an exemption from it. True seeing
  // out to 60 ft means darkness constrains nothing inside that circle and everything outside it, so
  // cutting the disc out of the base is the rule — and the peeling below inherits the exemption for
  // free, every rank's region being derived from this path.
  //
  // Distance from the observer to the point, matching `withinDarkSight` in `perception.mjs`, so the
  // render and the detection verdict cannot disagree about where the faculty reaches.
  const exempt = visualDarkSightRange(source);
  if (Number.isFinite(exempt) && exempt > 0) {
    losPath = difference(losPath, [discPath(source.x, source.y, exempt)]);
    if (!losPath.length) return empty;
  }

  const regions = [];

  // Darkest first. A sweep at rank R respects every edge ranked R or above, so `los − sweep` grows
  // monotonically as R falls — each tier's umbra contains every darker one. Peeling the previous
  // (darker) result off each result turns that nesting into disjoint regions, so a point lands in
  // exactly one and gets the darkest clamp that applies to it.
  let darker = null;

  for (const rank of ranks) {
    let blocked;
    try {
      // The same configuration as the base sweep above, so angle, threshold and externalRadius
      // cannot drift from the real one; `priority` is the only difference.
      blocked = CONFIG.Canvas.polygonBackends.sight.create(source.origin, { ...base, priority: rank });
    } catch (error) {
      console.error("PF1 Lighting | umbra probe sweep failed", error);
      continue;
    }

    const cumulative = difference(losPath, [toClipperPath(blocked, CLIPPER_SCALE)]);
    if (!cumulative.length) {
      darker = cumulative;
      continue;
    }

    const own = darker?.length ? difference(cumulative, darker) : cumulative;
    darker = cumulative;

    const polygons = fromClipperPaths(own, CLIPPER_SCALE);
    if (polygons.length) regions.push({ polygons, clamp: tierOfRank(rank) });
  }

  // The ground under the observer's own feet — see {@link standingIn}. Disjoint from everything
  // above by construction: every region there is `los − sweep`, and the sweep taken from inside
  // the disc is the disc, so none of them can contain it.
  const floor = standingIn(source.origin, losPath);
  if (floor) regions.push(floor);

  return { regions, ms: Math.round((performance.now() - t0) * 100) / 100 };
}

/* -------------------------------------------- */
/*  Consumption — DESIGN.md §4.3 stage B         */
/* -------------------------------------------- */

export const SETTING_UMBRA = "umbraPerception";

/**
 * Does the umbra actually change what a creature can see?
 *
 * @remarks
 * A separate switch from perception itself, because the two fail differently and the only reliable
 * way to tell them apart is to turn one off. Perception wrong means the model is wrong at a point;
 * umbra wrong means the geometry between two points is wrong. With one setting the symptom is
 * identical — that token should not be visible — and the bisection costs a session.
 */
export function isUmbraPerceptionEnabled() {
  // Cached — `regionsFor` asks on every point query, so this is on the same hot path as
  // `isPerceptionEnabled`. See `settings-cache.mjs`.
  return flag(SETTING_UMBRA, true);
}

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTING_UMBRA, {
    name: "PF1LIGHTING.Setting.umbraPerception.Name",
    hint: "PF1LIGHTING.Setting.umbraPerception.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => {
      cache = new WeakMap();
      if (canvas?.ready) canvas.perception.update({ refreshVision: true });
    },
  });
}

/**
 * @type {WeakMap<object, {field: object, los: object, regions: object[]}>}
 *
 * Resolved umbra per observer.
 *
 * @remarks
 * Keyed on identity, not on a frame. A sweep is the expensive half of building a source (§9.4) and
 * this does one per tier present, so recomputing per frame during a token drag is the one thing that
 * would make umbra unaffordable. Both dependencies announce themselves by becoming a different
 * object:
 *
 *   - `field.get()` returns the same object until something in the scene changes it, which is the
 *     existing signature check and already covers every source moving or changing;
 *   - `source.los` is replaced by `_createShapes`, not mutated, so an observer stepping one pixel
 *     invalidates its own entry and nobody else's.
 *
 * Comparing two references is cheap enough to do on every point query, which is what lets the clamp
 * sit inside `perceivedTier` without a second cache layer above it.
 */
let cache = new WeakMap();

/** Axis-aligned bounds, for rejecting a point without walking hundreds of vertices. */
function boundsOf(polygons) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const polygon of polygons) {
    const pts = polygon.points;
    for (let i = 0; i < pts.length; i += 2) {
      if (pts[i] < minX) minX = pts[i];
      if (pts[i] > maxX) maxX = pts[i];
      if (pts[i + 1] < minY) minY = pts[i + 1];
      if (pts[i + 1] > maxY) maxY = pts[i + 1];
    }
  }
  return { minX, minY, maxX, maxY };
}

/**
 * This observer's umbra regions, cached.
 *
 * @param {PointVisionSource|null} source
 * @returns {{polygons: PIXI.Polygon[], clamp: number, bounds: object}[]}
 */
export function regionsFor(source) {
  if (!source?.los || !isUmbraPerceptionEnabled()) return [];

  const currentField = field.get();
  const hit = cache.get(source);
  if (hit && hit.field === currentField && hit.los === source.los) return hit.regions;

  const regions = umbraFor(source).regions.map((region) => ({
    ...region,
    bounds: boundsOf(region.polygons),
  }));

  cache.set(source, { field: currentField, los: source.los, regions });
  return regions;
}

/**
 * Re-entrancy guard, same reasoning as `blindness.mjs`.
 *
 * @remarks
 * Building the umbra runs a sweep and may recompute the field, and this is called from inside
 * visibility testing. Neither path touches a vision source today, so there is no known cycle, but
 * the failure mode of one would be a hung canvas rather than a wrong pixel.
 */
let resolving = false;

/**
 * The tier a point is clamped to for this observer, or `null` if it is not in shadow.
 *
 * @remarks
 * Clamp, not reduce (2026-08-22): nothing is seen through a darkness more clearly than the darkness
 * allows. The umbra of a Dark bubble makes everything beyond it Dark — not one step below whatever
 * it already was, and not darker than the bubble either. A torch burning on the far side of a
 * darkness is reduced to the spell's own level and no further.
 *
 * Regions are constructed disjoint, so at most one should match; the darkest is taken anyway rather
 * than the first, so a geometry bug that overlapped two regions shows up as a conservative answer
 * rather than one depending on iteration order.
 *
 * @param {{x: number, y: number}} point
 * @param {PointVisionSource|null} source
 * @returns {number|null} A {@link TIER} value, or null
 */
export function clampAt(point, source) {
  if (resolving) return null;
  resolving = true;
  try {
    const regions = regionsFor(source);
    if (!regions.length) return null;

    let clamp = null;
    for (const { bounds, polygons, clamp: tier } of regions) {
      if (clamp !== null && tier >= clamp) continue;
      if (point.x < bounds.minX || point.x > bounds.maxX) continue;
      if (point.y < bounds.minY || point.y > bounds.maxY) continue;
      if (!containsPoint(polygons, point)) continue;
      clamp = tier;
    }
    return clamp;
  } catch (error) {
    // Never the reason a token cannot be tested for visibility. Failing open means no shadow, which
    // is the pre-umbra behaviour rather than a new one.
    console.error("PF1 Lighting | umbra clamp failed", error);
    return null;
  } finally {
    resolving = false;
  }
}

/** Drop every cached umbra. For settings changes and console pokes. */
export function invalidate() {
  cache = new WeakMap();
}

/**
 * Is the cache actually hitting?
 *
 * @remarks
 * `stats().ms` cannot answer this. `all()` goes through {@link umbraFor} directly, on purpose — it is
 * the geometry view and has to keep working with `umbraPerception` switched off, when
 * {@link regionsFor} deliberately returns nothing. So every call to `stats()` pays a full rebuild,
 * and reading its timing as evidence about the cache measures the one path that never touches it
 * (2026-08-22).
 *
 * This exercises the real path, the one `perceivedTier` calls hundreds of times per vision refresh,
 * and the number that matters is the ratio rather than the absolute. A hit is a `field` signature
 * comparison and two reference checks; a miss is a sweep, three orders of magnitude apart. Anything
 * in between means something is invalidating that should not be.
 *
 * Invalidates the live cache to get an honest cold number, then leaves it warm again. Same bargain
 * as `field.stats()`, which also computes fresh rather than reporting a cached answer.
 */
export function cacheProbe({ budgetMs = 2, maxIterations = 100_000 } = {}) {
  const sources = [...(canvas?.effects?.visionSources ?? [])].filter((s) => s.active);
  if (!sources.length) return { observers: 0, note: "no active vision sources — god's eye" };

  invalidate();
  const t0 = performance.now();
  for (const source of sources) regionsFor(source);
  const cold = performance.now() - t0;

  // Self-scaling in both directions, necessarily. A working cache is faster than
  // `performance.now()` can resolve — a fixed 50 iterations reported `warmMs: 0` and `speedup:
  // Infinity`, true but useless to compare a later run against. A broken cache is a sweep per call,
  // where a fixed high count would freeze the client for a second. Doubling until the elapsed time
  // is measurable satisfies both: it stops after two passes when each one costs a sweep.
  const t1 = performance.now();
  let iterations = 0;
  let batch = 32;
  let elapsed = 0;
  while (elapsed < budgetMs && iterations < maxIterations) {
    for (let i = 0; i < batch; i++) for (const source of sources) regionsFor(source);
    iterations += batch;
    elapsed = performance.now() - t1;
    batch *= 2;
  }
  const warm = elapsed / iterations;

  return {
    observers: sources.length,
    coldMs: Math.round(cold * 1000) / 1000,
    // Per pass over every observer. Six decimals because a hit is genuinely sub-microsecond.
    warmMs: Math.round(warm * 1e6) / 1e6,
    iterations,
    speedup: warm > 0 ? Math.round(cold / warm) : Infinity,
    // A hit should be far below the cost of one sweep. Missing every time is a correctness signal as
    // much as a performance one: an identity assumed stable is not.
    hitting: warm * 10 < cold,
  };
}

/**
 * Umbra for every active observer.
 *
 * @remarks
 * Per observer, deliberately not unioned. §5.3's union semantics are `max` over observers of the
 * resolved brightness, which is not the union of their umbrae — a point shadowed for one creature
 * and lit for another is lit, and unioning the shadows would say the opposite.
 *
 * @returns {{source: PointVisionSource, regions: {polygons: PIXI.Polygon[], clamp: number}[]}[]}
 */
export function all() {
  const out = [];
  for (const source of canvas?.effects?.visionSources ?? []) {
    if (!source.active) continue;
    const result = umbraFor(source);
    if (!result.regions.length) continue;
    out.push({ source, ...result });
  }
  return out;
}

/** Console readout. */
export function stats() {
  const t0 = performance.now();
  const results = all();
  const report = {
    // Geometry exists whenever there is a magical darkness; whether it does anything is a separate
    // switch, and reading the overlay without this is how "the umbra draws but changes nothing"
    // becomes a bug hunt.
    affectsPerception: isUmbraPerceptionEnabled() && isPerceptionEnabled(),
    tiersPresent: umbraTiersPresent().map((rank) => TIER_NAME[tierOfRank(rank)]),
    // §9.9. `baseSweeps` above zero means something is blocking a sweep that by construction nothing
    // can block, or a limited-angle observer is on the scene — the first a correctness question, the
    // second ordinary. See {@link unobstructedReach}.
    baseDirect: reachDirect,
    baseSweeps: reachSwept,
    edges: edgeStats(),
    observers: results.length,
    // Cold every time: `all()` rebuilds rather than reading the cache, so this is the full recompute
    // cost and says nothing about whether the cache works. Use `cacheProbe()` for that.
    rebuildMs: Math.round((performance.now() - t0) * 100) / 100,
    cache: cacheProbe(),
    perObserver: results.map((r) => ({
      id: r.source.sourceId,
      regions: r.regions.length,
      clamps: r.regions.map((region) => region.clamp),
      polygons: r.regions.reduce((n, region) => n + region.polygons.length, 0),
      points: r.regions.reduce(
        (n, region) => n + region.polygons.reduce((m, p) => m + p.points.length / 2, 0),
        0
      ),
    })),
  };
  console.error("PF1 Lighting | umbra", report);
  return report;
}

/* -------------------------------------------- */
/*  Debug overlay                               */
/* -------------------------------------------- */

let graphics = null;

/**
 * Draw the umbra.
 *
 * @remarks
 * Shipped before anything consumed the geometry, and that ordering is the point. Every expensive
 * mistake on this project was a plausible mechanism that turned out not to be the cause, found only
 * once the thing could be seen rather than inferred. Umbra is pure geometry, the category a console
 * readout is worst at — a polygon with the right area and the wrong shape reads identically in
 * `stats()`.
 */
export function draw() {
  if (!canvas?.ready) return;
  clear();

  const results = all();
  if (!results.length) {
    ui.notifications.info(t("Notify.NoUmbra"));
    return;
  }

  graphics = new PIXI.Graphics();
  graphics.eventMode = "none";
  canvas.interface.addChild(graphics);

  // Coloured by clamp tier, not one flat red — once regions carry different tiers, a single
  // colour would hide the very thing the overlay exists to show.
  const TIER_COLOUR = {
    [TIER.SUPERNATURAL_DARK]: 0x8822aa,
    [TIER.DARK]: 0xcc3366,
    [TIER.DIM]: 0xdd8844,
    [TIER.NORMAL]: 0xddcc44,
  };

  for (const { regions } of results) {
    for (const { polygons, clamp } of regions) {
      const colour = TIER_COLOUR[clamp] ?? 0xcc3366;

      // Holes are punched, not painted. An observer standing inside a darkness has that bubble as a
      // hole in their own 360° umbra, and filling it reads as a doubly-shaded patch exactly where
      // the umbra does not apply — the overlay saying the opposite of the truth in the one case
      // hardest to reason about.
      const { outers, holes } = splitRings(polygons);

      graphics.lineStyle(2, colour, 0.9);
      graphics.beginFill(colour, 0.2);
      for (const polygon of outers) {
        if (polygon.points?.length) graphics.drawPolygon(polygon.points);
      }
      for (const polygon of holes) {
        if (!polygon.points?.length) continue;
        graphics.beginHole();
        graphics.drawPolygon(polygon.points);
        graphics.endHole();
      }
      graphics.endFill();
    }
  }

  stats();
}

/** Remove the overlay. */
export function clear() {
  if (!graphics) return;
  graphics.destroy();
  graphics = null;
}
