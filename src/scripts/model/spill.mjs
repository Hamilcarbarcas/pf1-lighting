/**
 * Light spill through apertures — windows and open doors. DESIGN.md §3.4.
 *
 * A *Restrict Global Illumination* region (§10.7) makes a room dark by moving the ambient tier
 * inside it. That is correct and it is half a room: a window in the wall should still let the
 * outdoor light in, falling off with distance rather than stopping dead at the boundary.
 *
 * Ambient areas with computed polygons, not emitters — see §3.4 for why the original `SpillEmitter`
 * framing was retired. Each band is an `AT_LEAST` area at its own tier, folded by
 * `areas.ambientTierAt` beside the drawn ones, which makes spill identical to global illumination
 * for every other facet of the module by construction rather than by resemblance:
 *
 * - the contest, `evaluate()`, suppressors, umbra, perception, detection and the readout all read
 *   the ambient through that one function, so none of them can accidentally skip spill;
 * - `AT_LEAST` is §3.4's max-combine-only rule — spill may raise a level and can express nothing
 *   else, so two windows lighting the same floor compose with no special case;
 * - §7.0's shader discards global light per fragment wherever the darkness-level texture reads
 *   darker than `globalLightCutoff`, so painting a Bright band inside a Dark room makes the scene's
 *   own global light source stop discarding and light it. The spill is not rendered like global
 *   illumination; it is rendered by it.
 *
 * The shape — §3.4.1, rewritten 2026-08-28: geodesic distance on a grid, not Euclidean dilation.
 * `model/geodesic.mjs` marches a distance field out from every window of a room at once; this file
 * contours it at the ladder's thresholds and hands the polygons over. That replaced a construction
 * which measured brightness by straight-line distance and then merely masked it by visibility, so
 * light that turned a corner arrived having been charged for the distance through the wall. Bands
 * bending around exactly one corner, `MAX_CORNERS` and its relevance heuristic, the nudged-corner
 * containment test and the region-clip slivers were all symptoms of that one substitution, and all
 * are gone rather than fixed.
 *
 * What this file still owns is which edges are windows and how bright they are
 * ({@link apertureInfo}); the geometry lives next door.
 *
 * **Skylights — §3.4.3, 2026-09-15.** A window is not the only kind of opening, and the second kind
 * needed no new geometry. {@link apertureInfo} was always asking "brighter ambient one side, darker
 * the other, nothing opaque between", and a wall edge was only ever one way to be offered that
 * question; {@link regionApertures} offers it the outline of any region whose GM ticked *Openings*.
 * Cut a hole in a darkened room's region and the hole's ring is the one stretch of that outline with
 * no wall under it, so the sky reaches the floor there and falls off into the room from its edge.
 *
 * A hole is the right primitive rather than a lit patch drawn inside the room, and the reason is
 * time of day: a hole is simply ground the room's clamp does not cover, so `ambientTierAt` reads the
 * sky's own tier there and a skylight goes dark at dusk without anyone editing it. An `AT_LEAST`
 * region would have to be re-authored every time the sun moved.
 *
 * Walls that pass light never block anything. `geodesic.blockingLinks` cuts a cell-to-cell link only
 * where `constants.passesLight` is false, the same predicate {@link isAperture} reads to find a
 * window in the first place and `render/wall-mask.mjs` reads to protect the blur. So a second
 * window, or another open door, lets the spill straight through, and the three cannot disagree. A
 * wall is a severed link rather than blocked ground, so it eats no floor and cannot leak: any
 * 4-connected path across a wall must cross a link the wall cut.
 *
 * One ordering constraint: spill folds after the drawn regions. `field.ambientDomains` applies areas
 * in list order and the modes do not commute — a Bright spill into a room clamped Dark is
 * `max(min(Bright, Dark), Bright)` only if the `AT_LEAST` runs second. Reversed, the clamp eats the
 * spill and the feature silently does nothing. {@link areas} is appended by `areas.registerProvider`,
 * called last for exactly this reason.
 */

import { MODULE_ID, passesLight } from "../constants.mjs";
import {
  CLIPPER_SCALE,
  containsPoint,
  fromClipperPaths,
  toClipperPath,
  union,
} from "../geometry.mjs";
import { TIER, TIER_NAME, resolveTier, tierFromDarkness } from "./tiers.mjs";
import { contest } from "./contest.mjs";
import {
  ambientTier as sceneAmbientTier,
  emittersAt,
  suppressorsAt,
  version as registryVersion,
} from "./registry.mjs";
import * as areas from "./areas.mjs";
import * as geodesic from "./geodesic.mjs";

const SCALE = CLIPPER_SCALE;

export const SETTING_ENABLED = "spillEnabled";
export const SETTING_RADIUS = Object.freeze({
  [TIER.BRIGHT]: "spillRadiusBright",
  [TIER.NORMAL]: "spillRadiusNormal",
  [TIER.DIM]: "spillRadiusDim",
});

/**
 * How far off the wall the ambient is sampled, in grid squares.
 *
 * @remarks
 * The one tolerance in the eligibility test, and a tolerance for authoring rather than for
 * arithmetic: a region outline traced by hand does not land on the wall it describes. Too small and
 * a sloppily drawn region reads as having the same ambient on both sides of its own window; too
 * large and the probe jumps a narrow corridor into a third space. Half a square is a foot or two at
 * any normal scale, comfortably inside the thinnest room anyone draws.
 */
const PROBE_SQUARES = 0.5;

/* -------------------------------------------- */
/*  Settings                                    */
/* -------------------------------------------- */

function setting(key, fallback) {
  try {
    const value = game.settings.get(MODULE_ID, key);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

export const isEnabled = () => setting(SETTING_ENABLED, true) === true;

/**
 * How far this brightness carries before it steps down, in feet — §3.4.1.
 *
 * @remarks
 * The key is still `spillRadius*` and the meaning has changed. It used to be the cone radius of a
 * spill starting at this tier; it is now the width of this tier's own band, wherever in a ladder
 * that band falls. A stored 40 / 20 / 10 keeps working and reads better: bright carries forty feet,
 * normal twenty, dim ten, so a bright window reaches seventy.
 */
const radiusFeet = (tier) => Number(setting(SETTING_RADIUS[tier], 0)) || 0;

/* -------------------------------------------- */
/*  State                                       */
/* -------------------------------------------- */

/** @type {{id: string, derived: true, mode: string, tier: number, paths: object[][], polygons: PIXI.Polygon[]}[]} */
let cache = [];

let generation = 0;
let lastStats = null;
let scheduled = false;
let dirty = true;

/** `epoch:registryVersion:sceneTier` of the last real rebuild — see {@link rebuild}. */
let lastSignature = null;

/**
 * Bumped whenever **geometry** goes stale — walls, regions, settings.
 *
 * @remarks
 * Now purely part of {@link rebuild}'s signature. §3.4's two clocks existed because a window's sweeps
 * were expensive and its tier was not, so the sweeps were cached against this and the tier re-run
 * against the registry. §3.4.1's march is cheap enough that nothing is left worth caching separately
 * — a rebuild is one field per room — so this survives only to say something moved, alongside the
 * registry version and the scene tier.
 */
let geometryEpoch = 0;

export const version = () => generation;

/** Every band currently in effect, as ambient areas. Pure cache read — never rebuilds. */
export function spillAreas() {
  return cache;
}

/**
 * Spill's contribution to `render/gradient.mjs` — empty since §3.4.1, deliberately.
 *
 * @remarks
 * §7.0 step 5 gave each window a triangulated mesh carrying a distance per vertex, so the rasteriser
 * interpolated the falloff instead of the field blur approximating it. That machinery was the whole
 * back half of this file — `rampFor`, `ringDistances`, `groupWithDistances` — and it existed to
 * reconstruct distances §3.4.1's field simply has.
 *
 * Not rebuilt on the new field yet, because it may not be needed (2026-08-27): the bands are much
 * wider under per-tier widths — 40 / 20 / 10 ft rather than 40 + 10 + 10 — so each boundary may read
 * correctly on §6.4.4's blur alone, the treatment every other brightness boundary in the module
 * gets. If it bands, the fix is small: ask `geodesic.contour` for thresholds at quarter-band spacing
 * instead of tier spacing and hand the rings over with the distances they already carry.
 *
 * The stub stays rather than the export being deleted: `render/gradient.mjs` is the shared mesh pool
 * for four producers, three of which have nothing to do with spill, and it already treats an empty
 * list as nothing to draw.
 *
 * @returns {object[]} Always empty
 */
export function ramps() {
  return [];
}

/* -------------------------------------------- */
/*  Eligibility                                 */
/* -------------------------------------------- */

/**
 * Could this edge be a window?
 *
 * @remarks
 * `type === "wall"` is not optional. `Edge.light` defaults to `NONE` for every edge type
 * (`geometry/edges/edge.mjs:41`), and this module puts its own umbra edges into `canvas.edges` with
 * exactly that (`vision/umbra-edges.mjs`). Without the type test every umbra boundary on the scene
 * reads as a window.
 *
 * Open doors need no special case. `Wall##createEdge` zeroes all four restrictions while `isOpen`
 * (`placeables/wall.mjs:225`), so a door's edge stays in the collection with its geometry intact and
 * qualifies exactly while it is open.
 *
 * Which light restrictions read as open is {@link passesLight}'s decision, shared with the march and
 * the blur mask so the three cannot disagree — §3.4.2, and where proximity walls are argued.
 */
export function isAperture(edge) {
  if (edge?.type !== "wall") return false;
  return passesLight(edge);
}

/**
 * The two unit normals of an edge, and its midpoint.
 *
 * @returns {{mid: {x: number, y: number}, n: {x: number, y: number}, length: number}|null}
 */
function frame(edge) {
  const dx = edge.b.x - edge.a.x;
  const dy = edge.b.y - edge.a.y;
  const length = Math.hypot(dx, dy);
  if (!(length > 1)) return null;
  return {
    mid: { x: (edge.a.x + edge.b.x) / 2, y: (edge.a.y + edge.b.y) / 2 },
    n: { x: -dy / length, y: dx / length },
    length,
  };
}

const offsetPoint = (p, n, d) => ({ x: p.x + n.x * d, y: p.y + n.y * d });

/** Why candidates were turned away, for {@link stats}. Reset by {@link rebuild}. */
let rejects = {};
const reject = (why) => {
  rejects[why] = (rejects[why] ?? 0) + 1;
  return null;
};

/**
 * Is a light-blocking wall between these two points, other than `self`?
 *
 * @remarks
 * A direct segment test over the quadtree rather than `testCollision`, since §3.4.2 (2026-09-01).
 * The sweep answered this exactly while every aperture was `light === NONE`, because
 * `_testEdgeInclusion` drops such an edge before it can occlude (`geometry/clockwise-sweep.mjs:244`)
 * — so the aperture could not report itself. A threshold wall is an aperture that the sweep *does*
 * include: `testCollision` leaves `useThreshold` at `false` (`geometry/shapes/source-polygon.mjs:185`),
 * and even set, a reverse-proximity wall blocks a source half a grid square away by construction.
 * Every proximity window would therefore reject itself as `occluded`.
 *
 * So the exclusion is named rather than relied upon. The two tests the sweep would have applied and
 * this segment is short enough to need are kept: an edge that passes light does not occlude, and a
 * one-directional wall facing away from the probe does not occlude it
 * (`geometry/clockwise-sweep.mjs:250-254`, in its default `NORMAL` mode).
 *
 * Bounds padded by a pixel because the probe segment is perpendicular to the wall and so is
 * axis-aligned whenever the wall is — a zero-height query rectangle is not a reliable quadtree key.
 *
 * @param {Point} a
 * @param {Point} b
 * @param {Edge} self The aperture under test, which cannot occlude itself
 */
function blockedBetween(a, b, self) {
  const collection = canvas?.edges;
  if (typeof collection?.getEdges !== "function") return false;

  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const bounds = new PIXI.Rectangle(x - 1, y - 1, Math.abs(b.x - a.x) + 2, Math.abs(b.y - a.y) + 2);

  for (const edge of collection.getEdges(bounds, { includeOuterBounds: false })) {
    if (edge === self || !edge.a || !edge.b) continue;
    if (passesLight(edge)) continue;
    if (edge.direction && edge.orientPoint(a) === edge.direction) continue;
    if (foundry.utils.lineSegmentIntersects(a, b, edge.a, edge.b)) return true;
  }
  return false;
}

/**
 * The ambient tier ignoring spill's own contribution.
 *
 * @remarks
 * The back door onto spill-must-not-feed-spill. `ambientTierAt` folds every area including the bands
 * this file produced last time, so reading it plainly would make a previously-lit patch report the
 * spill tier, the `spillTier > interiorTier` guard go false, and the feature switch itself off one
 * rebuild after it started working. Excluding derived areas keeps the interior tier meaning the
 * room, which is the quantity the guard is about.
 */
const roomTier = (point, base) => areas.ambientTierAt(point, base, { derived: false });

/**
 * The spill tier just outside a window: the **ambient emitter alone**, run through the contest.
 *
 * @remarks
 * Not `evaluate()`, and the difference is the whole feature. A candle on the windowsill already
 * shines through the window — the edge passes light and Foundry sweeps it — so reading the full
 * emitter set would spill forty feet of bright from a candle and double-count light already being
 * drawn. Global illumination is the only thing with no geometry to stream through the gap, so it is
 * the only thing spill is for.
 *
 * Running the contest rather than reading the ambient directly is what makes a darkness over the
 * window work: the spell clamps the ambient at that point and the spill starts one or two rungs
 * lower, with `floor`, eligibility and daylight cancellation honoured by the code that already owns
 * those rules.
 */
function spillTierAt(point) {
  // Flattened exactly as `evaluate()` flattens it, for the reason its comment gives: the contest
  // reads config fields off the emitter itself, so an entry handed over unflattened arrives with no
  // `kind`, no `level` and no `cancelsDarkness`, and every rule that tests one silently takes its
  // default branch.
  const ambientOnly = emittersAt(point)
    .filter(({ entry }) => entry?.isGlobal)
    .map(({ entry, ...rest }) => ({ ...entry, entry, ...rest }));

  if (!ambientOnly.length) return null;
  const { B, applied, winner } = contest(ambientOnly, suppressorsAt(point));
  return resolveTier(B, { suppressed: applied, floor: winner?.floor });
}


/* -------------------------------------------- */
/*  One window                                  */
/* -------------------------------------------- */

/**
 * Everything about a candidate edge that does not depend on how the falloff is drawn: is it a
 * window, which way is inward, what tier spills through it, and what room it spills into.
 *
 * @remarks
 * Split out of `bandsFor` on 2026-08-27, and the split line is the point. §3.4.1 replaces the
 * geometry — the wedge, the sweeps, the corner bending, the Minkowski ladder — with a geodesic
 * distance field. None of that touches eligibility or the tier, the parts play-testing has not
 * faulted. Keeping them in one exported function means the new construction and the old one cannot
 * disagree about which walls are windows or how bright a window is, and the probe judging the new
 * geometry judges it against the real answer rather than a copy of it.
 *
 * Takes a **candidate** rather than an `Edge` since §3.4.3. A candidate is `{a, b, edge}`, where
 * `edge` is the wall this came from or `null` for a segment of a region outline. Everything below
 * the first two lines reads only `a` and `b`, which is why a skylight needed no new geometry: the
 * question "is this a boundary with brighter ambient on one side, darker on the other, and nothing
 * opaque between" was always the whole of eligibility, and a wall edge was only ever one way to ask
 * it.
 *
 * `edge: null` is not a weaker case. It means there is no aperture to exclude from
 * {@link blockedBetween}, so **every** wall between the probes counts — which is exactly the
 * guarantee a region outline needs, since a region has no reason to be drawn anywhere near a wall
 * and a wall lying across it must stop the spill dead.
 *
 * @param {{a: Point, b: Point, edge: Edge|null}|Edge} candidate
 * @param {number} sceneTier
 * @returns {object|null} `null` where the candidate is not a window, or has nothing to spill
 */
export function apertureInfo(candidate, sceneTier = sceneAmbientTier()) {
  // An `Edge` passed directly is still accepted — `game.pf1Lighting.spill` probes hand one over,
  // and the wall path below reads more honestly for it. Detected on the presence of the key rather
  // than its value: a region candidate carries `edge: null`, which is a wall it does not have, and
  // `?.edge` cannot tell that from a wall nobody supplied.
  const wrapped = candidate !== null && typeof candidate === "object" && "edge" in candidate;
  const edge = wrapped ? candidate.edge : candidate;
  const segment = wrapped ? { a: candidate.a, b: candidate.b } : candidate;

  // Only a wall has to prove it passes light. A region outline is not a thing light crosses; it is
  // a line on the ground, and what stands on it is `blockedBetween`'s question below.
  if (edge && !isAperture(edge)) return null;
  // `frame` reads `.b.x` off its argument, so a malformed candidate throws rather than returning
  // null. Cheap to answer here, and this is an exported probe entry point.
  if (!segment?.a || !segment?.b) return null;
  const f = frame(segment);
  if (!f) return null;

  const probe = (canvas?.dimensions?.size ?? 100) * PROBE_SQUARES;
  const plus = offsetPoint(f.mid, f.n, probe);
  const minus = offsetPoint(f.mid, f.n, -probe);

  const tierPlus = roomTier(plus, sceneTier);
  const tierMinus = roomTier(minus, sceneTier);

  // Same ambient on both sides: an interior wall, or a window in open air. Either way there is
  // nothing to spill, and this also turns the whole feature off at nightfall — once the sky is
  // darker than the room, no window on the scene qualifies.
  if (tierPlus === tierMinus) return reject("sameAmbient");

  // The ambients must be separated by this edge, not merely differ across it (2026-08-28: exterior
  // walls of an interior space intersecting a wall outside caused light to leak in, and moving those
  // outer walls away from the room cleared it).
  //
  // §3.4 chose the ambient differential over a border test on purpose, and gave the reason:
  // collinearity between a drawn region outline and a drawn wall is a tolerance exercise with no
  // right answer. That still holds. What it missed is that the differential says nothing about what
  // separates the two samples — so any light-passing wall standing within half a grid square of a
  // region's boundary reads as a window into it, however far outside the room it is and however
  // solid the real wall between them. A fence, a cliff edge or scenery parked against a building
  // therefore poured daylight through it, and dragging the same wall a few feet away turned it off.
  //
  // The honest test is neither the border nor the differential alone: can light actually get from
  // one sample to the other? The aperture is excluded by name, so the answer is about what stands
  // behind it: a real window sees nothing between its probes; a wall behind a wall sees the wall.
  if (blockedBetween(plus, minus, edge)) return reject("occluded");

  // Inward points at the darker side; the brighter side is where the light comes from.
  const inwardSign = tierPlus < tierMinus ? 1 : -1;
  const n = { x: f.n.x * inwardSign, y: f.n.y * inwardSign };
  const inside = inwardSign > 0 ? plus : minus;
  const outside = inwardSign > 0 ? minus : plus;
  const interiorTier = Math.min(tierPlus, tierMinus);

  const spillTier = spillTierAt(outside);
  if (spillTier === null) return reject("noAmbientEmitter");

  // §3.4's guard, and the same comparison as eligibility. A Bright scene clamped to Dim indoors with
  // a deeper darkness over the window gives Dim against Dim: nothing to do, correctly.
  if (spillTier <= interiorTier) return reject("notBrighterOutside");

  // Bands run from the spill tier down to whichever is higher: one rung above the room, or Dim. Dim
  // is not a preference — `globalLightCutoff` is the Dim threshold and `darknessFor` erases below
  // it, so there is no rung underneath for global illumination to reach.
  const floor = Math.max(interiorTier + 1, TIER.DIM);
  if (spillTier < floor) return reject("belowDim");

  // The regions that make this room an interior. Clipping to them stops the spill leaking back out
  // of its own window, and is the only non-wall trim in the construction.
  const enclosing = areas.areas().filter((area) => !area.derived && areas.covers(area, inside));
  if (!enclosing.length) return reject("noEnclosingRegion");
  const regionPaths = union(enclosing.flatMap((area) => areas.pathsFor(area, SCALE)));
  if (!regionPaths.length) return reject("emptyRegion");

  // Sorted, so two windows in one room hash to the same key however `areas()` ordered them — the
  // grouping in `roomsOf` is only as reliable as this is stable.
  const regionIds = enclosing.map((area) => area.id ?? area.region?.id ?? "?").sort();

  return {
    edge,
    // The seeded segment, carried explicitly since §3.4.3. `spillFor` used to reach through to
    // `info.edge.a`, which a region outline has no `edge` to offer — and a wall's own endpoints are
    // these anyway, so nothing about the window path changes.
    a: segment.a,
    b: segment.b,
    // What produced this opening, for `stats()`. The rejection tally says why candidates failed;
    // this is the other half — of the ones that passed, which were windows and which were outlines.
    kind: edge ? "wall" : "region",
    frame: f,
    normal: n,
    inside,
    outside,
    interiorTier,
    spillTier,
    floor,
    regionIds,
    regionPaths,
    regionPolygons: fromClipperPaths(regionPaths, SCALE),
  };
}

/* -------------------------------------------- */
/*  Candidates                                  */
/* -------------------------------------------- */

/**
 * How finely a region outline is chopped before probing, in grid squares.
 *
 * @remarks
 * A wall is judged by one probe at its midpoint, which is honest because a wall is uniform along its
 * length — it either passes light or it does not. A region outline is not: one side of a room's ring
 * can be solid masonry and the next a gap, and a single midpoint probe would answer for both.
 *
 * So the outline is cut into segments about a square long and each is judged on its own. One square
 * is the scale walls are drawn at, and it costs one quadtree query per segment — paid only by
 * regions whose GM ticked the box, and only when {@link rebuild}'s signature has actually moved.
 *
 * Not smaller: {@link PROBE_SQUARES} samples half a square either side, so segments much shorter
 * than this have overlapping probes and answer the same question repeatedly.
 */
const SEGMENT_SQUARES = 1;

/**
 * Aperture candidates from region outlines — DESIGN.md §3.4.3, the skylight.
 *
 * @remarks
 * The whole of the feature on the model side, and it adds no geometry: {@link apertureInfo} already
 * asked the right question and had only ever been offered walls to ask it about.
 *
 * **Outer rings and holes alike.** Which of them is an opening is not a property of the winding, and
 * deciding by winding would be wrong in both directions: a hole cut where a wall runs is not an
 * opening, and a gap left in a room's wall line is one. `blockedBetween` is the arbiter, with no
 * aperture to exclude — a region outline has no wall of its own — so **every** wall standing on a
 * segment stops it. That is §3.4.2 unchanged, and it is what makes "a wall still blocks spill,
 * ticked or not" true by construction rather than by a second test agreeing with the first.
 *
 * The ordinary case is therefore that a room region ticked *Openings* produces nothing at all: its
 * outline is drawn along its walls, every segment is occluded, and the count lands in
 * `stats().rejected.occluded`. Cut a hole in the ceiling and that hole's ring is the one place with
 * no wall under it, so it — and only it — seeds.
 *
 * Only non-derived areas are walked. A derived area is spill's own output from last rebuild, and
 * offering it back would be the self-feeding failure `roomTier` exists to prevent, one level up.
 */
function regionApertures(sceneTier) {
  const out = [];
  let candidates = 0;

  const step = (canvas?.dimensions?.size ?? 100) * SEGMENT_SQUARES;
  if (!(step > 0)) return { apertures: out, candidates };

  for (const area of areas.areas()) {
    if (area.derived || !area.spills) continue;

    for (const ring of areas.ringsOf(area)) {
      const pts = ring.points;
      for (let i = 0; i < pts.length; i += 2) {
        const j = (i + 2) % pts.length;
        const ax = pts[i];
        const ay = pts[i + 1];
        const bx = pts[j];
        const by = pts[j + 1];

        // Chopped so a long side is judged piece by piece rather than at its midpoint alone. A ring
        // edge shorter than one segment yields exactly one, which is the common case: Foundry
        // tessellates ellipses and rounded rectangles finely enough that most edges are already
        // below this length.
        const length = Math.hypot(bx - ax, by - ay);
        if (!(length > 1)) continue;
        const pieces = Math.max(1, Math.ceil(length / step));

        for (let k = 0; k < pieces; k++) {
          const t0 = k / pieces;
          const t1 = (k + 1) / pieces;
          candidates++;
          const info = apertureInfo(
            {
              a: { x: ax + (bx - ax) * t0, y: ay + (by - ay) * t0 },
              b: { x: ax + (bx - ax) * t1, y: ay + (by - ay) * t1 },
              edge: null,
            },
            sceneTier
          );
          if (info) out.push(info);
        }
      }
    }
  }

  return { apertures: out, candidates };
}

/* -------------------------------------------- */
/*  One room                                    */
/* -------------------------------------------- */

/**
 * Band width per tier, in feet.
 *
 * @remarks
 * The three stored numbers, read as widths rather than radii (2026-08-27): each brightness value
 * gives the size of that brightness's band. 40 means bright light carries forty feet before it reads
 * as normal, and the total reach is whatever the ladder sums to — 70 ft from Bright, 30 from Normal,
 * 10 from Dim.
 *
 * The old scheme said two things at once, a per-tier cone radius and a separate uniform band width,
 * which double-counted the falloff and disagreed about which was the distance limit. This is one
 * statement, and why `spillBandWidth` no longer exists.
 */
function widthsFeet() {
  const table = {};
  for (const tier of geodesic.SPILL_TIERS) table[tier] = radiusFeet(tier);
  return table;
}

/**
 * Group this scene's windows by the room they spill into.
 *
 * @remarks
 * One march per room, not per window (2026-08-27), for correctness before cost. Two windows lighting
 * one room from separate fills land on separately-snapped grids, so their contours can disagree by a
 * fraction of a cell along a shared boundary — and thin disagreeing polygons folding together is the
 * sliver failure §3.4.1 exists to end. One field per room has one set of contours and nothing to
 * disagree with.
 *
 * Provably the same answer rather than an approximation. Tier is monotone decreasing in distance, so
 * `max over windows of tier(dᵥᵥ)` is `tier(min over windows of dᵥᵥ)`, and the minimum over seeds is
 * what a multi-source march computes. The `AT_LEAST` fold that used to combine separate windows does
 * the same arithmetic one level down.
 *
 * Keyed on the region set, that being what `apertureInfo` resolved as the room and what bounds the
 * fill. Two rooms sharing no region never share a march.
 */
function roomsOf(sceneTier) {
  const rooms = new Map();
  let candidates = 0;

  const admit = (info) => {
    // The enclosing region set, order-independent, so two windows in one room always hash alike.
    const key = info.regionIds.join("|");
    let room = rooms.get(key);
    if (!room) {
      room = { key, apertures: [], regionPolygons: info.regionPolygons, floor: info.floor };
      rooms.set(key, room);
    }
    room.apertures.push(info);
    // A room is only as bright as its darkest reading lets the ladder run — see §3.4's floor.
    if (info.floor > room.floor) room.floor = info.floor;
  };

  for (const edge of canvas.edges.values()) {
    if (!isAperture(edge)) continue;
    candidates++;

    const info = apertureInfo(edge, sceneTier);
    if (info) admit(info);
  }

  // §3.4.3 — the same grouping, from the other candidate source. Deliberately folded into the same
  // rooms rather than marched separately: a room with a window *and* a skylight is one distance
  // field with two seed sets, which is §3.4.1's whole argument for one march per room. Two fields
  // would land on separately-snapped lattices and disagree along the boundary where they meet,
  // which is the sliver failure that rewrite exists to end.
  const fromRegions = regionApertures(sceneTier);
  candidates += fromRegions.candidates;
  for (const info of fromRegions.apertures) admit(info);

  return { rooms: [...rooms.values()], candidates, regionCandidates: fromRegions.candidates };
}

/**
 * One room's spill, as nested ambient areas.
 *
 * @remarks
 * Windows at different tiers share the march via a head start. A room can have a bright window and
 * one under a darkness; rather than a march each, the dimmer window seeds at a cost offset — the
 * cumulative width of every rung between the room's brightest spill tier and its own. A Normal
 * window in a room whose ladder starts at Bright seeds at 40, the width of the Bright rung, so the
 * ladder reads Normal at its mouth exactly as a march of its own would have. Works only because the
 * ladder is cumulative, the second thing per-tier widths bought.
 *
 * The contours are nested and nothing is differenced. Each tier's area is the whole disc inside its
 * threshold, not the annulus. `AT_LEAST` folds by `max`, so nesting produces the bands for free
 * (`geodesic.contour`). Differencing them would compute the same answer through Clipper, which is
 * where the slivers came from.
 *
 * @returns {{areas: object[], fill: object|null}}
 */
function spillFor(room) {
  const table = widthsFeet();
  const brightest = room.apertures.reduce((max, a) => Math.max(max, a.spillTier), TIER.DARK);
  const steps = geodesic.ladder(brightest, room.floor, table);
  if (!steps.length) return { areas: [], fill: null };

  const feetToPixels = canvas?.dimensions?.distancePixels ?? 1;

  // Cumulative width above a tier, in feet — the head start a dimmer window seeds at.
  const offsetFor = (tier) => {
    let sum = 0;
    for (const step of steps) {
      if (step.tier === tier) return sum;
      sum = step.until;
    }
    return sum;
  };

  const seedGroups = room.apertures.map((info) => ({
    a: info.a,
    b: info.b,
    normal: info.normal,
    offset: offsetFor(info.spillTier) * feetToPixels,
  }));

  const fill = geodesic.fillRoom({
    seedGroups,
    steps,
    region: room.regionPolygons,
  });
  if (!fill?.dist) return { areas: [], fill };

  const out = [];
  for (const step of steps) {
    const rings = geodesic.contour(fill.grid, fill.dist, step.until * feetToPixels);
    if (!rings.length) continue;

    // Through `union` rather than used raw: marching squares emits outers and holes wound against
    // each other, and Clipper's NonZero union normalises that into the winding `areas.pathsFor` hands
    // to `field.mjs`, which reads derived paths without normalising them.
    const paths = union(rings.map((ring) => toClipperPath(new PIXI.Polygon(ring.flatMap((p) => [p.x, p.y])), SCALE)));
    if (!paths.length) continue;

    out.push({
      id: `${MODULE_ID}.spill.${room.key}.${step.tier}`,
      derived: true,
      mode: areas.MODE.AT_LEAST,
      tier: step.tier,
      paths,
      polygons: fromClipperPaths(paths, SCALE),
    });
  }

  return { areas: out, fill };
}

/* -------------------------------------------- */
/*  Rebuild                                     */
/* -------------------------------------------- */

/**
 * Mark the bands stale. `geometry` also bumps {@link geometryEpoch}.
 *
 * @remarks
 * Deliberately does not clear {@link cache}. The last good bands stay on screen until new ones
 * replace them, which matters because {@link schedule} declines to rebuild while the walls layer is
 * open: clearing here would make every lit room go dark the moment a GM picked up the wall tool, and
 * stay dark until they put it down. Stale spill for the length of an edit is a far better failure
 * than no spill.
 */
export function invalidate({ geometry = false } = {}) {
  if (geometry) {
    geometryEpoch++;
  }
  dirty = true;
}

/**
 * Recompute every band on the scene.
 *
 * @remarks
 * Ends by invalidating `areas`, which is what actually publishes the result: `areas()` caches
 * its folded list, and `field()` keys its own signature on `areas.version()`. Without it the new
 * bands sit in this module and nothing on the map or in the model ever reads them.
 */
export function rebuild() {
  const t0 = performance.now();
  const next = [];
  let candidates = 0;
  let windows = 0;
  let marched = 0;
  let cells = 0;

  const publish = (stats) => {
    cache = next;
    dirty = false;
    generation++;
    areas.invalidate();
    return (lastStats = stats);
  };

  if (!isEnabled() || !canvas?.ready || !canvas.edges) {
    return publish({ enabled: isEnabled(), candidates: 0, windows: 0, rooms: 0, bands: 0, ms: 0 });
  }

  // No point: `ambientTier` returns the scene's own tier untouched, the base every
  // room-versus-outside comparison below is folded from.
  const sceneTier = sceneAmbientTier();

  // Nothing this depends on has moved. `initializeLightSources` fires for reasons unrelated to spill
  // — a light re-initialising in place, a canvas refresh — and the whole ladder is cheap only
  // relative to how often that is. Same idea as `field.get()` returning the same object when its
  // signature is unchanged.
  const signature = `${geometryEpoch}:${registryVersion()}:${sceneTier}`;
  if (signature === lastSignature && cache.length) {
    dirty = false;
    return lastStats;
  }
  lastSignature = signature;

  rejects = {};
  const found = roomsOf(sceneTier);
  candidates = found.candidates;

  let skylights = 0;
  for (const room of found.rooms) {
    const { areas: produced, fill } = spillFor(room);
    if (!produced.length) continue;
    windows += room.apertures.length;
    skylights += room.apertures.filter((info) => info.kind === "region").length;
    marched++;
    cells += fill?.visited ?? 0;
    next.push(...produced);
  }

  return publish({
    enabled: true,
    candidates,
    // §3.4.3. `regionCandidates: 0` means no region on the scene has *Openings* ticked, which is the
    // first thing to check when a skylight does nothing — it separates "the flag is off" from "the
    // flag is on and every segment was rejected", and those need opposite responses.
    regionCandidates: found.regionCandidates,
    windows,
    // Of those windows, how many came from a region outline rather than a wall. A cut hole that
    // produced nothing leaves this at 0 with `rejected.occluded` high, meaning a wall is standing
    // on the ring — the expected reading for a hole drawn over the wall line rather than inside it.
    skylights,
    // One march covers every window of a room, so `rooms` below `windows` is the ordinary state and
    // the point of §3.4.1's grouping — not a sign anything was skipped.
    rooms: marched,
    cells,
    // Why candidates were turned away. §6.4.2's lesson: a correct no-op and a broken mechanism look
    // identical on screen, so every `return null` in `apertureInfo` is counted instead.
    rejected: { ...rejects },
    bands: next.length,
    rings: next.reduce((n, area) => n + area.paths.length, 0),
    vertices: next.reduce((n, area) => n + area.paths.reduce((m, p) => m + p.length, 0), 0),
    ms: Math.round((performance.now() - t0) * 100) / 100,
  });
}

/* -------------------------------------------- */
/*  The darkness animation                      */
/* -------------------------------------------- */

/** @type {(() => void)|null} Detach for the current canvas's darkness listener. */
let detachDarkness = null;

/**
 * Rebuild when an animated darkness change actually crosses a tier.
 *
 * @remarks
 * See the note in {@link registerHooks} for why `updateScene` alone leaves the bands stale.
 *
 * Compared on the tier, not the level: the event fires on every frame of a ten-second animation and
 * the tier changes at most three times across the sweep. Comparing levels would schedule ~600
 * rebuilds, and `schedule` requests a vision refresh, so the cure would be worse than the disease.
 *
 * Attached per canvas, because `canvas.environment` is rebuilt with the scene — hence the explicit
 * detach rather than relying on the listener dying with the object.
 */
function watchDarkness() {
  unwatchDarkness();
  const environment = canvas?.environment;
  if (typeof environment?.addEventListener !== "function") return;

  const onDarknessChange = (event) => {
    const data = event?.environmentData;
    if (!data) return;
    if (tierFromDarkness(data.darknessLevel) === tierFromDarkness(data.priorDarknessLevel)) return;
    schedule();
  };

  environment.addEventListener("darknessChange", onDarknessChange);
  detachDarkness = () => {
    try {
      environment.removeEventListener("darknessChange", onDarknessChange);
    } catch {
      // The canvas went away underneath; the listener went with it.
    }
    detachDarkness = null;
  };
}

function unwatchDarkness() {
  detachDarkness?.();
}

/**
 * Coalesce to one rebuild per frame.
 *
 * @remarks
 * The walls-layer suppression is deliberately not here (2026-08-26), to see what latency wall editing
 * actually creates. Wall editing is the worst case by construction: every change bumps the geometry
 * epoch and re-marches every room on the scene. If it needs a brake, the brake is one `if` and the
 * hook to lift it is already written (`deactivateWallsLayer`).
 *
 * The perception update is conditional on the rebuild having changed something, as of 2026-08-28.
 * `rebuild` already declines to work when its signature is unmoved — the guard that makes
 * `initializeLightSources` affordable, since it fires for reasons unrelated to spill — but the
 * refresh below used to run regardless, so every one of those no-ops still cost a lighting and
 * vision refresh of the whole canvas.
 *
 * Tolerable while the callers were document hooks; not with a per-frame signal in the mix
 * ({@link watchDarkness}), and a guard depending on every caller filtering perfectly is the wrong
 * shape. `generation` moving is the honest test of whether anything changed, because `rebuild` bumps
 * it exactly when it publishes.
 */
export function schedule({ geometry = false } = {}) {
  invalidate({ geometry });
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    if (!dirty) return;
    const before = generation;
    rebuild();
    if (generation !== before && canvas?.ready) {
      canvas.perception.update({ refreshLighting: true, refreshVision: true });
    }
  });
}

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

export function registerSettings() {
  const numeric = (key, name, hint, dflt, range) =>
    game.settings.register(MODULE_ID, key, {
      // English, not keys: every setting here is `config: false` and edited in Configure Light
      // Spill, which carries its own translated labels. §10.11.
      name,
      hint,
      scope: "world",
      config: false,
      type: Number,
      default: dflt,
      range,
      onChange: () => schedule({ geometry: true }),
    });

  game.settings.register(MODULE_ID, SETTING_ENABLED, {
    name: "Light spill through windows",
    hint:
      "Lets outdoor light in through windows and open doors on the border of an interior " +
      "region, falling off in bands. Requires Model global illumination.",
    scope: "world",
    config: false,
    type: Boolean,
    default: true,
    onChange: () => schedule({ geometry: true }),
  });

  // Three numbers, the whole falloff since §3.4.1. Spill cone angle and Band width were registered
  // here and are gone (2026-08-28). The angle described the wedge the old construction clipped
  // against, and there is no wedge; band width described a uniform step, and each tier now carries
  // its own. Neither had a consumer left, and a live setting that moves nothing is worse than no
  // setting.
  const band = (tier, label, dflt) =>
    numeric(SETTING_RADIUS[tier], `Spill band width — ${label}`, "Feet.", dflt, {
      min: 0,
      max: 200,
      step: 5,
    });
  band(TIER.BRIGHT, "Bright", 40);
  band(TIER.NORMAL, "Normal", 20);
  band(TIER.DIM, "Dim", 10);
}

/**
 * @remarks
 * Walls and regions move geometry; the registry moves only tiers, because the contest is in the
 * loop for `spillTier`. Both are coalesced to one rebuild per frame, and `initializeEdges` is
 * the broad signal that catches a door opening, a wall being deleted and a scene loading alike.
 */
export function registerHooks() {
  const geometry = () => schedule({ geometry: true });
  const tiers = () => schedule();

  for (const hook of ["initializeEdges", "canvasReady"]) Hooks.on(hook, geometry);
  for (const doc of ["Wall", "Region", "RegionBehavior"]) {
    for (const verb of ["create", "update", "delete"]) Hooks.on(`${verb}${doc}`, geometry);
  }

  // Kept while rebuilds during wall editing are unsuppressed — a no-op in that state, and the hook a
  // brake would need if the latency turns out to warrant one. See `schedule`.
  Hooks.on("deactivateWallsLayer", () => {
    if (dirty) schedule();
  });

  // A darkness moving over a window changes what spills through it, and nothing about the walls.
  Hooks.on("initializeLightSources", tiers);
  Hooks.on("updateScene", (_doc, changed) => {
    if ("environment" in changed || "darkness" in changed || "grid" in changed) tiers();
  });

  // `updateScene` is not enough on its own — the sticky-brightness bug (2026-08-28: areas stayed
  // bright after the scene brightness was turned down, until the scene was set to dark).
  //
  // Scene darkness is animated: `Scene##onUpdate` hands a `darknessLevel` change to
  // `canvas.effects.animateDarkness`, which slides `canvas.environment.darknessLevel` over ten
  // seconds by default (`CONFIG.Canvas.darknessToDaylightAnimationMS`). `updateScene` fires once, at
  // the start. {@link schedule} then rebuilds on the next animation frame, when the level has barely
  // moved, so `sceneTier` still reads the old tier, the signature matches, `lastSignature` is
  // stamped with it, and nothing fires again when the animation lands. The bands stay at the tier
  // they were built for, indefinitely.
  //
  // It cleared at Dark because that crosses `globalLightCutoff` and switches the scene's global
  // light source off, firing `initializeLightSources` and moving a different term of the signature.
  // Nothing to do with darkness as such, which is why the failure looked arbitrary.
  //
  // The real signal is a PIXI event on `canvas.environment`, not a Foundry hook — dispatched on
  // every step of the animation with `{darknessLevel, priorDarknessLevel}`. Filtered on the tier
  // rather than the level, because it fires per frame for ten seconds and a rebuild per frame would
  // be far worse than the bug.
  Hooks.on("canvasReady", watchDarkness);

  Hooks.on("canvasTearDown", () => {
    unwatchDarkness();
    cache = [];
    lastSignature = null;
    dirty = true;
  });

  // Appended last, so spill folds after the drawn regions — see the file header.
  areas.registerProvider(spillAreas);
}

/* -------------------------------------------- */
/*  Diagnostics                                 */
/* -------------------------------------------- */

/**
 * What spill found, and the three ways it can correctly do nothing.
 *
 * @remarks
 * §6.4.2's lesson, applied in advance: a correct no-op and a broken mechanism look identical on
 * screen. `candidates` above zero with `windows` at zero is the ordinary night-time state and also
 * what a mis-drawn region looks like; `visible: false` means the model has moved and the map cannot,
 * §7.0's texture being the only channel that can brighten a restricted region.
 */
export function stats() {
  const report = {
    ...(lastStats ?? rebuild()),
    visible: (() => {
      try {
        return game.settings.get(MODULE_ID, "ambientTakeover") === true;
      } catch {
        return false;
      }
    })(),
    registryVersion: registryVersion(),
    geometryEpoch,
    settings: {
      cell: geodesic.cellSize(),
      bandFeet: {
        Bright: radiusFeet(TIER.BRIGHT),
        Normal: radiusFeet(TIER.NORMAL),
        Dim: radiusFeet(TIER.DIM),
      },
    },
    areas: cache.map((area) => ({ tier: TIER_NAME[area.tier], rings: area.paths.length })),
  };
  console.error(`${MODULE_ID} | light spill`, report);
  return report;
}

/**
 * Point query, for the console. Which bands cover a point, brightest first.
 *
 * @remarks
 * Overlap here is ordinary, not a bug: two windows lighting the same floor both claim it, and
 * `AT_LEAST` folds them to the brightest. The first row is the tier this point gets from spill.
 */
export function at(point) {
  return cache
    .filter((area) => containsPoint(area.polygons, point))
    .sort((a, b) => b.tier - a.tier)
    .map((area) => ({ tier: TIER_NAME[area.tier], id: area.id }));
}
