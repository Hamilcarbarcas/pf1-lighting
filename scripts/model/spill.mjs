/**
 * Light spill through apertures — windows and open doors. DESIGN.md §3.4.
 *
 * A *Restrict Global Illumination* region (§10.7) makes a room dark by moving the ambient tier
 * inside it. That is correct and it is half a room: a window in the wall should still let the
 * outdoor light in, falling off with distance rather than stopping dead at the boundary.
 *
 * ## What this is, in the model
 *
 * **Ambient areas with computed polygons.** Not emitters — see §3.4 for why the original
 * `SpillEmitter` framing was retired. Each band is an `AT_LEAST` area at its own tier, folded by
 * `areas.ambientTierAt` beside the drawn ones, which is what makes Patrick's requirement — that
 * spill be treated identically to global illumination by every other facet of the module — true
 * by construction rather than by resemblance:
 *
 * - the contest, `evaluate()`, suppressors, umbra, perception, detection and the readout all
 *   read the ambient through that one function, so none of them can accidentally skip spill;
 * - `AT_LEAST` *is* §3.4's max-combine-only rule — spill may raise a level and can express
 *   nothing else, so two windows lighting the same floor compose with no special case;
 * - §7.0's shader discards global light per fragment wherever the darkness-level texture reads
 *   darker than `globalLightCutoff`, so painting a Bright band inside a Dark room makes the
 *   scene's *own* global light source stop discarding and light it. The spill is not rendered
 *   like global illumination; it is rendered *by* it.
 *
 * ## Walls that pass light never trim anything
 *
 * Every wall-derived shape here is a `type: "light"` sweep, and `_testEdgeInclusion` drops any
 * edge whose `light` is `NONE` before it can occlude (`geometry/clockwise-sweep.mjs:244`). So a
 * second window, or another open door, lets the spill straight through — and it must, because
 * that is the *same* predicate {@link isAperture} uses to find a window in the first place. The
 * two cannot disagree. Nothing else in this file consults a wall: the dilation is a Minkowski
 * sum and the region clip is a polygon.
 *
 * ## The one ordering constraint
 *
 * Spill folds **after** the drawn regions. `field.ambientDomains` applies areas in list order
 * and the modes do not commute — a Bright spill into a room clamped Dark is
 * `max(min(Bright, Dark), Bright)` only if the `AT_LEAST` runs second. Reversed, the clamp eats
 * the spill and the feature silently does nothing. {@link areas} is appended by
 * `areas.registerProvider`, which is called last for exactly this reason.
 */

import { MODULE_ID } from "../constants.mjs";
import {
  CLIPPER_SCALE,
  containsPoint,
  difference,
  fromClipperPaths,
  intersection,
  toClipperPath,
  union,
} from "../geometry.mjs";
import { TIER, TIER_NAME, resolveTier, stepTier } from "./tiers.mjs";
import { contest } from "./contest.mjs";
import {
  ambientTier as sceneAmbientTier,
  emittersAt,
  suppressorsAt,
  version as registryVersion,
} from "./registry.mjs";
import * as areas from "./areas.mjs";

const SCALE = CLIPPER_SCALE;

export const SETTING_ENABLED = "spillEnabled";
export const SETTING_ANGLE = "spillAngle";
export const SETTING_BAND = "spillBandWidth";
export const SETTING_RADIUS = Object.freeze({
  [TIER.BRIGHT]: "spillRadiusBright",
  [TIER.NORMAL]: "spillRadiusNormal",
  [TIER.DIM]: "spillRadiusDim",
});

/**
 * How far off the wall the ambient is sampled, in grid squares.
 *
 * @remarks
 * The one tolerance in the eligibility test, and it is a tolerance for *authoring* rather than
 * for arithmetic: a region outline traced by hand does not land on the wall it describes. Too
 * small and a sloppily drawn region reads as having the same ambient on both sides of its own
 * window; too large and the probe jumps a narrow corridor into a third space. Half a square is
 * a foot or two at any normal scale, and comfortably inside the thinnest room anyone draws.
 */
const PROBE_SQUARES = 0.5;

/**
 * How far inside the wall the sweep origin sits, in pixels.
 *
 * @remarks
 * A sweep origin lying exactly *on* an edge is the classic degenerate case for
 * `ClockwiseSweepPolygon` — the vertex is collinear with itself and the sweep can return a
 * degenerate or inverted polygon. Small enough not to matter geometrically, large enough to be
 * unambiguous at Clipper's integer scale.
 */
const ORIGIN_OFFSET = 4;

/**
 * Most sample origins along one aperture.
 *
 * @remarks
 * **A window is an area light, not a point** (§7.2), and the first build got this wrong in a way
 * that showed immediately: one origin makes the lit wedge a *point* at the wall, widening from
 * nothing, when it should start at the window's full width. The shape is fixed analytically by
 * {@link wedgePath}; these origins exist for the other half of the same fact — occlusion sampled
 * from one point mis-judges a wide window next to a corner.
 */
const MAX_ORIGINS = 6;

/** Segments per flank arc when tracing the wedge. */
const ARC_STEPS = 8;

/**
 * Most wall corners a single aperture's spill will bend around.
 *
 * @remarks
 * A cap for cost, not for correctness — each corner is a sweep. It can be this loose because the
 * candidates are filtered by *relevance* first (see {@link cornersFor}) and the sweeps are small:
 * a corner sweep needs only {@link bendRadius}, not the aperture's full reach.
 *
 * **Raised from 8 after play-testing, 2026-08-26**, together with the filter that made the number
 * almost stop mattering. At 8, ranked by distance from the window, a T-shaped room spent every
 * slot on corners of the near wall and culled the one at the mouth of the far leg — the only one
 * that could get light into the marked area. The cap was doing the filtering, badly.
 */
const MAX_CORNERS = 24;

/**
 * Iso-lines generated per band for the render ramp — DESIGN.md §7.0 step 5.
 *
 * @remarks
 * **Rings are kept as *tessellation* and dropped as *levels*.** The model's bands are still the
 * bands: `evaluate()`, perception and every mechanical consumer see the discrete ladder §3.4
 * specifies. These are finer offsets of the same wedge, and they exist only so the triangulator
 * has small polygons whose vertices sit on known iso-lines — the level is then a per-vertex
 * attribute and the rasteriser interpolates it (`render/gradient.mjs`).
 *
 * Four is where the linear interpolation stops being the limiting factor: a plateau-and-ramp
 * profile across one band is sampled at quarter-band spacing, which is finer than the profile's
 * own curvature. Raising it costs one polygon offset and two boolean ops per ring per window, at
 * **rebuild** time only — the ramp geometry does not move when an observer does.
 */
const RAMP_STEPS = 4;

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

/** Cone radius in feet for a spill of this tier. Keyed on the *initial* tier only — §3.4. */
const radiusFeet = (tier) => Number(setting(SETTING_RADIUS[tier], 0)) || 0;

const bandFeet = () => Number(setting(SETTING_BAND, 10)) || 10;

const coneAngle = () => Number(setting(SETTING_ANGLE, 105)) || 105;


/** Feet to scene pixels. */
const toPixels = (feet) => feet * (canvas?.dimensions?.distancePixels ?? 1);

/* -------------------------------------------- */
/*  State                                       */
/* -------------------------------------------- */

/** @type {{id: string, derived: true, mode: string, tier: number, paths: object[][], polygons: PIXI.Polygon[]}[]} */
let cache = [];

/**
 * One triangulated falloff per window, for the renderer — DESIGN.md §7.0 step 5.
 *
 * @remarks
 * Kept beside {@link cache} rather than inside it because the two are consumed by different halves
 * of the module and on different clocks. `cache` is the **model**: discrete bands, folded as
 * ambient areas, read by `evaluate()` and everything downstream of it. This is the **picture**:
 * one mesh per window carrying a distance per vertex, rebuilt only when the geometry is.
 *
 * @type {object[]}
 */
let rampCache = [];

let generation = 0;
let lastStats = null;
let scheduled = false;
let dirty = true;

/** `epoch:registryVersion:sceneTier` of the last real rebuild — see {@link rebuild}. */
let lastSignature = null;

/**
 * Bumped whenever cached **geometry** goes stale — walls, regions, settings.
 *
 * @remarks
 * The two clocks of §3.4. A window's two sweeps are the expensive part and depend only on walls
 * and the region outline; its *tier* additionally depends on the ambient and on suppressors,
 * because the contest is in the loop, and a darkness carried past a window moves it. Keying the
 * sweep cache on this rather than on a full rebuild is what keeps a tier change from re-sweeping
 * a scene that has not moved.
 */
let geometryEpoch = 0;

/** @type {Map<string, object>} edge id → cached sweeps for the current {@link geometryEpoch} */
const sweepCache = new Map();

export const version = () => generation;

/** Every band currently in effect, as ambient areas. Pure cache read — never rebuilds. */
export function spillAreas() {
  return cache;
}

/**
 * Every window's falloff as a triangulated gradient — `render/gradient.mjs`'s only input.
 *
 * Pure cache read. See {@link rampCache}.
 */
export function ramps() {
  return rampCache;
}

/* -------------------------------------------- */
/*  Eligibility                                 */
/* -------------------------------------------- */

/**
 * Could this edge be a window?
 *
 * @remarks
 * **`type === "wall"` is not optional.** `Edge.light` defaults to `NONE` for every edge type
 * (`geometry/edges/edge.mjs:41`), and this module puts its own umbra edges into `canvas.edges`
 * with exactly that (`vision/umbra-edges.mjs`). Without the type test every umbra boundary on
 * the scene reads as a window.
 *
 * **Open doors need no special case.** `Wall##createEdge` zeroes all four restrictions while
 * `isOpen` (`placeables/wall.mjs:225`), so a door's edge stays in the collection with its
 * geometry intact and qualifies exactly while it is open.
 */
function isAperture(edge) {
  if (edge?.type !== "wall") return false;
  return edge.light === CONST.WALL_SENSE_TYPES.NONE;
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

/**
 * The ambient tier ignoring spill's own contribution.
 *
 * @remarks
 * **The back door onto "spill must not feed spill".** `ambientTierAt` folds every area including
 * the bands this file produced last time, so reading it plainly would make a previously-lit
 * patch report the spill tier, the `spillTier > interiorTier` guard go false, and the feature
 * switch itself off one rebuild after it started working. Excluding derived areas is what keeps
 * the interior tier meaning *the room*, which is the quantity the guard is about.
 */
const roomTier = (point, base) => areas.ambientTierAt(point, base, { derived: false });

/**
 * The spill tier just outside a window: the **ambient emitter alone**, run through the contest.
 *
 * @remarks
 * Not `evaluate()`, and the difference is the whole feature. A candle on the windowsill already
 * shines through the window — the edge passes light, Foundry sweeps it, and §7.1 notes as much
 * in its own parenthesis — so reading the full emitter set would spill forty feet of *bright*
 * from a candle and double-count light that is already being drawn. Global illumination is the
 * only thing with no geometry to stream through the gap, so it is the only thing spill is for.
 *
 * Running the *contest* rather than reading the ambient directly is what makes a darkness over
 * the window work: the spell clamps the ambient at that point and the spill starts one or two
 * rungs lower, with `floor`, eligibility and *daylight* cancellation honoured by the code that
 * already owns those rules.
 */
function spillTierAt(point) {
  // Flattened exactly as `evaluate()` flattens it, and for the reason its comment gives: the
  // contest reads config fields off the emitter itself, so an entry handed over unflattened
  // arrives with no `kind`, no `level` and no `cancelsDarkness`, and every rule that tests one
  // silently takes its default branch.
  const ambientOnly = emittersAt(point)
    .filter(({ entry }) => entry?.isGlobal)
    .map(({ entry, ...rest }) => ({ ...entry, entry, ...rest }));

  if (!ambientOnly.length) return null;
  const { B, applied, winner } = contest(ambientOnly, suppressorsAt(point));
  return resolveTier(B, { suppressed: applied, floor: winner?.floor });
}

/* -------------------------------------------- */
/*  Geometry                                    */
/* -------------------------------------------- */

const rotate = (v, a) => ({
  x: v.x * Math.cos(a) - v.y * Math.sin(a),
  y: v.x * Math.sin(a) + v.y * Math.cos(a),
});

/** One wall-occluded sweep, as a single-element Clipper path list. */
function sweepPath(origin, radius) {
  const Poly = CONFIG.Canvas.polygonBackends.light;
  // `type: "light"` is what makes a window transparent to another window's spill — see the file
  // header. Any change here has to keep that property.
  return toClipperPath(Poly.create(origin, { type: "light", radius, angle: 360 }), SCALE);
}

/**
 * Sample origins along the aperture, pushed inward off the wall.
 *
 * @remarks
 * Placed at `(i + 0.5) / count` rather than at `i / (count - 1)`, so none of them lands on the
 * window's own endpoints — which are wall vertices, and a sweep origin sitting on one is the
 * degenerate case `ORIGIN_OFFSET` exists to avoid in the other axis.
 */
function originsAlong(edge, n, length) {
  const step = canvas?.dimensions?.size ?? 100;
  const count = Math.min(MAX_ORIGINS, Math.max(2, Math.round(length / step) + 1));
  const out = [];
  for (let i = 0; i < count; i++) {
    const f = (i + 0.5) / count;
    const p = {
      x: edge.a.x + (edge.b.x - edge.a.x) * f,
      y: edge.a.y + (edge.b.y - edge.a.y) * f,
    };
    out.push(offsetPoint(p, n, ORIGIN_OFFSET));
  }
  return out;
}

/**
 * The lit wedge, at the window's **full width** — the cone swept along the aperture.
 *
 * @remarks
 * Analytic rather than swept, and that is the fix for the first thing play-testing found
 * (Patrick, 2026-08-26: *"the cone comes almost to a point, when it should have a starting width
 * of the entire length of the window"*). A `ClockwiseSweepPolygon` emanates from a point, so a
 * single cone is a *point* at the wall however many samples are unioned behind it — adjacent
 * cones only close their scallops some way in, and the window's own width is never expressed.
 *
 * What is wanted is the Minkowski sum of the aperture segment with the cone, and because a
 * circular sector is convex and a segment is convex, that sum is just their convex hull:
 *
 *   `a` → a's outer flank → arc about `a` round to the normal → the straight tangent across to
 *   `b` → arc about `b` out to b's flank → `b` → back along the window.
 *
 * Occlusion is not this function's job; it comes from intersecting with the sampled sweeps.
 *
 * The near edge is pushed `ORIGIN_OFFSET` **outside** the wall so the region clip lands exactly
 * on the wall rather than a rounding error short of it — which is also what retired the separate
 * aperture quad the first build needed.
 */
function wedgePath(edge, n, radius, angleDeg) {
  const half = ((angleDeg / 2) * Math.PI) / 180;

  const t = { x: edge.b.x - edge.a.x, y: edge.b.y - edge.a.y };
  const length = Math.hypot(t.x, t.y) || 1;
  t.x /= length;
  t.y /= length;

  // Which rotation sense leans *away* from `b`. `n` is perpendicular to `t`, but whether a
  // positive rotation turns toward `b` or away from it depends on the edge's own winding, so it
  // is measured rather than assumed.
  const probe = rotate(n, half);
  const sigma = probe.x * t.x + probe.y * t.y < 0 ? 1 : -1;

  const a = offsetPoint(edge.a, n, -ORIGIN_OFFSET);
  const b = offsetPoint(edge.b, n, -ORIGIN_OFFSET);
  const points = [a.x, a.y];

  for (let i = 0; i <= ARC_STEPS; i++) {
    const d = rotate(n, sigma * half * (1 - i / ARC_STEPS));
    points.push(a.x + d.x * radius, a.y + d.y * radius);
  }
  for (let i = 0; i <= ARC_STEPS; i++) {
    const d = rotate(n, -sigma * half * (i / ARC_STEPS));
    points.push(b.x + d.x * radius, b.y + d.y * radius);
  }
  points.push(b.x, b.y);

  return toClipperPath(new PIXI.Polygon(points), SCALE);
}

/**
 * How far a band can travel around a corner, and therefore how far a corner sweep must see.
 *
 * @remarks
 * Every band is `white ⊕ k·d` with `k` at most `N`, so the dilation is the distance bound and a
 * corner sweep only has to supply *visibility* out to that same distance. One band's width of
 * slack covers the corner sitting slightly off `white` rather than exactly on its boundary.
 *
 * This is what makes {@link MAX_CORNERS} affordable: these sweeps are a fraction of the
 * aperture's own reach, and a `ClockwiseSweepPolygon` costs by the edges in its bounds.
 */
const bendRadius = () => toPixels(bandFeet() * 3);

/**
 * Wall corners the spill can bend around.
 *
 * @remarks
 * **The second thing play-testing found** (Patrick, 2026-08-26: *"the dimmer bands aren't
 * offsetting from all sides of the initial cone, it's not counting the sides that exist because
 * they were trimmed by walls"*), and it was a design error rather than a slip. The first build
 * clipped the bands to a visibility sweep taken from **the same origin as the cone** — so every
 * shadow edge of the cone was also an edge of the clip, the dilation could never cross one, and
 * a band could only ever appear past the cone's angular or radial limit. In the direction of a
 * wall-cut edge there was nothing at all, which is exactly what the screenshot showed.
 *
 * Light gets into that shadow by bending round the corner that cast it, so the clip has to admit
 * what those corners can see.
 *
 * ## Two tests, and the second one is the whole trick
 *
 * A corner qualifies if it is **visible from the aperture** — one that no light reaches has
 * nothing to bend — *and* if it is **near the lit wedge**, within one band ladder of it.
 *
 * The second test is what the first pass was missing, and its absence was reported as bands
 * still not reaching (2026-08-26, second screenshot). Ranking candidates by distance from the
 * *window* sounds like relevance and is not: the corners nearest a window are the jambs and the
 * near wall, which cast nothing into the room, while the corner that actually gates a far leg is
 * by definition far away. With `MAX_CORNERS` at 8 the useful corner was culled by a queue full
 * of useless ones.
 *
 * Proximity to the **lit region** is the honest test, because a band cannot reach a corner it is
 * not near — the dilation says so. Taken against the wedge at `maxRadius`, so the answer is the
 * same for every tier and can be cached with the sweeps.
 */
function cornersFor(visPolygons, origins, relevant) {
  const found = [];

  for (const edge of canvas.edges.values()) {
    // Only edges that actually stop light cast a shadow worth bending around — and an aperture
    // never does, which is the same predicate `isAperture` reads.
    if (edge.light === CONST.WALL_SENSE_TYPES.NONE) continue;

    for (const p of [edge.a, edge.b]) {
      let nearest = origins[0];
      let best = Infinity;
      for (const o of origins) {
        const d = (p.x - o.x) ** 2 + (p.y - o.y) ** 2;
        if (d < best) {
          best = d;
          nearest = o;
        }
      }

      // **Every test below runs on the nudged point, never on the corner itself** — see the
      // note on this function. The nudge is also the sweep origin, so there is exactly one
      // point per corner and no way for the tested point and the swept point to disagree.
      const probe = probeToward(p, nearest, Math.sqrt(best));

      // Cheapest first: a corner the bands could never reach is most of them.
      if (!containsPoint(relevant, probe)) continue;
      if (!containsPoint(visPolygons, probe)) continue;

      found.push({ probe, d: best });
    }
  }

  // Nearest-first only decides which survive the cap, and after the relevance filter the cap
  // rarely bites at all.
  found.sort((x, y) => x.d - y.d);
  return found.slice(0, MAX_CORNERS).map(({ probe }) => probe);
}

/**
 * A corner pulled `ORIGIN_OFFSET` toward the light.
 *
 * @remarks
 * **This is what makes the corner test deterministic, and testing the raw corner instead was the
 * "erratic" bug** (Patrick, 2026-08-27: spill working, then not, after nudging a free-standing
 * wall one square).
 *
 * A corner that casts a shadow is, by construction, a **vertex of `vis`** — the sweep turns at
 * exactly that point. Ray-crossing containment at a polygon's own vertex is the classic
 * degenerate case: it answers by floating-point accident, so whether the corner that gates a
 * room was admitted depended on where the wall happened to sit. Moving it one square re-rolled
 * the dice. It looked like "some edges aren't being looked at", and they were — they were being
 * looked at and getting an arbitrary answer.
 *
 * Nudging first makes the answer exact rather than merely likelier, and the reason is a property
 * of the shape: each sample's sweep is **star-shaped about its own origin**, so the whole segment
 * from an origin to any point of that sweep lies inside it. A corner on the boundary therefore
 * moves strictly *into* `vis`, every time, for any offset up to the full distance. A corner that
 * is genuinely occluded stays outside, because a few pixels do not cross a wall.
 */
function probeToward(p, origin, distance) {
  const len = distance || Math.hypot(origin.x - p.x, origin.y - p.y) || 1;
  const step = Math.min(ORIGIN_OFFSET, len * 0.5);
  return {
    x: p.x + ((origin.x - p.x) / len) * step,
    y: p.y + ((origin.y - p.y) / len) * step,
  };
}

/**
 * Minkowski offset by `delta` scene pixels — positive dilates, negative erodes.
 *
 * @remarks
 * `arcTolerance` is in *scaled* units, so Clipper's own default of 0.25 means a quarter of a
 * hundredth of a pixel here and buries the result in vertices. Half a pixel is well under what
 * the blur smooths over.
 *
 * **The vertices of the result are all at exactly `delta` from the input**, which is the single
 * property {@link rampFor} is built on: an offset boundary *is* an iso-line of the distance
 * field, so a vertex on one needs no distance query at all.
 */
function offsetPaths(paths, delta) {
  if (!paths.length || !delta) return paths;
  const co = new ClipperLib.ClipperOffset(2, 0.5 * SCALE);
  co.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const out = new ClipperLib.Paths();
  co.Execute(out, delta * SCALE);
  return out;
}

/** Dilation only — the sense every existing call site uses. */
function dilate(paths, delta) {
  return delta > 0 ? offsetPaths(paths, delta) : paths;
}

/* -------------------------------------------- */
/*  The render ramp — §7.0 step 5               */
/* -------------------------------------------- */

/**
 * Per-vertex distances for one Clipper ring, from the iso-line lookup.
 *
 * @remarks
 * A ring is `(white ⊕ t) ∩ domain` minus the previous one, so its vertices come from three
 * places. Two are exact: a vertex of the outer offset is at `t`, a vertex of the inner offset is
 * at `t − δ`, and both are in `lookup` by their **integer** Clipper coordinate — Clipper works in
 * integers, so the match is exact rather than approximate.
 *
 * The third is a vertex of the *domain* — a wall corner, or a crossing where the domain boundary
 * cuts across the band. Its distance is unknown, but it is known to lie between the two iso-lines
 * the band is bounded by, so the error is at most one ring width whatever we do. Interpolating by
 * arc length between the nearest known vertices either way around the loop makes it exact at both
 * ends of a wall-cut edge and monotone along it, which is what stops a wall reading as a level
 * change of its own.
 *
 * @param {{X: number, Y: number}[]} path
 * @param {Map<string, number>} lookup - Integer `"X,Y"` → distance
 * @param {number} fallback - Used when a ring has no known vertex at all
 * @returns {Float64Array}
 */
function ringDistances(path, lookup, fallback) {
  const n = path.length;
  const out = new Float64Array(n);
  const known = new Uint8Array(n);
  let hits = 0;

  for (let i = 0; i < n; i++) {
    const value = lookup.get(`${path[i].X},${path[i].Y}`);
    if (value !== undefined) {
      out[i] = value;
      known[i] = 1;
      hits++;
    }
  }
  if (hits === n) return out;
  if (!hits) {
    out.fill(fallback);
    return out;
  }

  // Cumulative chord length, so the interpolation is by distance along the ring rather than by
  // vertex count — an offset arc is finely sampled and a straight wall is two points, and
  // counting vertices would weight them the same.
  const len = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const a = path[i];
    const b = path[(i + 1) % n];
    len[i + 1] = len[i] + Math.hypot(b.X - a.X, b.Y - a.Y);
  }
  const total = len[n] || 1;

  // Nearest known vertex each way, cyclically. Two passes each, so the wrap-around is covered
  // without the quadratic scan the obvious version does.
  const prev = new Int32Array(n);
  const next = new Int32Array(n);
  let last = -1;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      if (known[i]) last = i;
      prev[i] = last;
    }
  }
  let ahead = -1;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = n - 1; i >= 0; i--) {
      if (known[i]) ahead = i;
      next[i] = ahead;
    }
  }

  const arc = (from, to) => (len[to] - len[from] + total) % total;

  for (let i = 0; i < n; i++) {
    if (known[i]) continue;
    const p = prev[i];
    const q = next[i];
    if (p < 0 || q < 0) {
      out[i] = fallback;
      continue;
    }
    const before = arc(p, i);
    const after = arc(i, q);
    const t = before + after > 0 ? before / (before + after) : 0.5;
    out[i] = out[p] + (out[q] - out[p]) * t;
  }
  return out;
}

/**
 * Triangulate one `{outer, holes}` group, appending to the payload buffers.
 *
 * @remarks
 * `PIXI.utils.earcut(points, holeIndices, 2)` natively, exactly as `darkness-texture.setGeometry`
 * does — the distances are concatenated in lockstep with the points so a vertex index means the
 * same thing in both arrays.
 */
function appendGroup(group, out) {
  const points = [];
  const dists = [];
  const holeIndices = [];

  const push = (ring, isHole) => {
    if (!(ring?.path?.length >= 3)) return;
    if (isHole) holeIndices.push(points.length / 2);
    for (let i = 0; i < ring.path.length; i++) {
      points.push(ring.path[i].X / SCALE, ring.path[i].Y / SCALE);
      dists.push(ring.dist[i]);
    }
  };

  push(group.outer, false);
  for (const hole of group.holes) push(hole, true);
  if (points.length < 6) return;

  const indices = PIXI.utils.earcut(points, holeIndices.length ? holeIndices : null, 2);
  if (!indices.length) return;

  const base = out.vertices.length / 2;
  for (const value of points) out.vertices.push(value);
  for (const value of dists) out.dists.push(value);
  for (const index of indices) out.indices.push(base + index);
}

/**
 * Split a Clipper solution into `{outer, holes}` groups, keeping each ring's distances with it.
 *
 * @remarks
 * A near-twin of `geometry.groupRings`, and separate for one reason: that one takes and returns
 * `PIXI.Polygon`s, and everything here has to stay on the **integer** Clipper path so the iso-line
 * lookup can match a coordinate exactly. Converting to floats and back would round.
 */
function groupWithDistances(paths, lookup, fallback) {
  const rings = [];
  for (const path of paths) {
    if (!path || path.length < 3) continue;
    // Shoelace on the integer path; the sign is the winding and that is all it is read for.
    let sum = 0;
    for (let i = 0; i < path.length; i++) {
      const a = path[i];
      const b = path[(i + 1) % path.length];
      sum += a.X * b.Y - b.X * a.Y;
    }
    rings.push({ path, dist: ringDistances(path, lookup, fallback), area: sum });
  }
  if (!rings.length) return [];

  // Which winding means "outer" is read off the largest ring rather than assumed, for the reason
  // `geometry.splitRings` gives: the sign depends on the coordinate convention.
  let outerSign = 0;
  let largest = 0;
  for (const ring of rings) {
    if (Math.abs(ring.area) > largest) {
      largest = Math.abs(ring.area);
      outerSign = Math.sign(ring.area);
    }
  }

  const outers = rings.filter((ring) => Math.sign(ring.area) === outerSign);
  const holes = rings.filter((ring) => Math.sign(ring.area) !== outerSign);
  if (outers.length === 1) return [{ outer: outers[0], holes }];

  const inside = (ring, point) => {
    let hit = false;
    const p = ring.path;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      if (p[i].Y > point.Y !== p[j].Y > point.Y) {
        const x = ((p[j].X - p[i].X) * (point.Y - p[i].Y)) / (p[j].Y - p[i].Y) + p[i].X;
        if (point.X < x) hit = !hit;
      }
    }
    return hit;
  };

  return outers.map((outer) => ({
    outer,
    holes: holes.filter((hole) => inside(outer, hole.path[0])),
  }));
}

/**
 * One window's falloff as a single triangulated mesh carrying a distance per vertex.
 *
 * @remarks
 * **Geometry and distance only — no levels.** The mapping from distance to a darkness level is a
 * *rendering* decision (which tier table is in force, how much of a band is plateau and how much
 * is ramp), and putting it here would mean rebuilding the whole scene's spill geometry every time
 * a slider moved. `render/gradient.mjs` owns it and re-maps the buffer in a loop instead.
 *
 * The ring set runs from half a band **inside** `white` out to the model's own outer limit, so the
 * mesh covers every band exactly and the transition centred on `white`'s own boundary has geometry
 * on both sides of it. Rings inside `white` are erosions — the same `ClipperOffset` call with a
 * negative delta — and the innermost piece is a flat core, which is correct: the wedge is one
 * brightness until the first transition begins.
 *
 * @returns {object|null} The ramp payload, or `null` if nothing triangulated
 */
function rampFor({ id, white, domain, band, spillTier, steps }) {
  const delta = band / RAMP_STEPS;
  if (!(delta > 0)) return null;

  const inner = Math.ceil(RAMP_STEPS / 2);
  const lookup = new Map();
  const shells = [];

  for (let m = -inner; m <= steps * RAMP_STEPS; m++) {
    const t = m * delta;
    const shell = m === 0 ? white : offsetPaths(white, t);
    if (!shell.length) continue;

    // Every vertex of an offset boundary is at exactly `t` — the property the whole scheme rests
    // on. Recorded **before** the domain clip, because that clip is what introduces the vertices
    // this cannot answer for.
    for (const path of shell) {
      for (const point of path) lookup.set(`${point.X},${point.Y}`, t);
    }

    // Only a dilation can leave the domain: `white` is already inside it, and an erosion of
    // `white` is inside `white`.
    shells.push({ t, paths: t > 0 ? intersection(shell, domain) : shell });
  }
  if (!shells.length) return null;

  const out = { vertices: [], dists: [], indices: [] };
  let previous = null;
  let outermost = null;

  for (const { t, paths } of shells) {
    if (!paths.length) continue;
    const ring = previous ? difference(paths, previous) : paths;
    previous = paths;
    outermost = paths;
    if (!ring.length) continue;
    // A ring with no known vertex at all can only be a sliver the domain clipped out of the middle
    // of the band; its own midpoint is the best available answer and is at most δ/2 out.
    for (const group of groupWithDistances(ring, lookup, t - delta / 2)) appendGroup(group, out);
  }

  if (out.indices.length < 3) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < out.vertices.length; i += 2) {
    const x = out.vertices[i];
    const y = out.vertices[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  return {
    id,
    spillTier,
    steps,
    band,
    // **The mesh's silhouette, kept for point queries and nothing else.** A triangle soup cannot
    // answer `canvas.effects.getDarknessLevel`'s containment test cheaply, and the outermost shell
    // is exactly the union of every triangle by construction.
    outline: fromClipperPaths(outermost ?? [], SCALE),
    vertices: new Float32Array(out.vertices),
    dists: new Float32Array(out.dists),
    // Uint32 unconditionally: v13 requires WebGL2, where 32-bit indices are core.
    indices: new Uint32Array(out.indices),
    bounds: new PIXI.Rectangle(minX, minY, maxX - minX, maxY - minY),
    triangles: out.indices.length / 3,
  };
}

/**
 * Everything about a window that depends only on walls: the sample origins, what they can see,
 * and what the spill may bend around.
 *
 * @remarks
 * Cached against {@link geometryEpoch}. This is the expensive half — up to
 * `MAX_ORIGINS + MAX_CORNERS` sweeps — and none of it moves when only the *tier* changes, which
 * is what lets a darkness drifting past a window cost a handful of boolean ops rather than a
 * re-sweep of the scene.
 *
 * Swept at the widest radius any tier could ask for, taken as a **max over all three caps**
 * rather than from Bright. They are free-form numbers in a settings window: nothing stops a GM
 * giving Normal a longer reach than Bright, and reading Bright alone would silently clip
 * Normal's spill to a radius it never asked for. A narrower tier needs no re-sweep, because the
 * wedge and the dilation are what bound reach — the sweep only ever supplies occlusion.
 */
function sweepsFor(edge, n, length, epoch) {
  const cached = sweepCache.get(edge.id);
  if (cached && cached.epoch === epoch) return cached;

  const maxRadius = toPixels(
    Math.max(...Object.keys(SETTING_RADIUS).map((tier) => radiusFeet(tier))) + 2 * bandFeet()
  );

  const origins = originsAlong(edge, n, length);

  // Union of the samples: a wide window sees round a corner that any one point on it does not.
  const vis = union(origins.map((o) => sweepPath(o, maxRadius)));
  const visPolygons = fromClipperPaths(vis, SCALE);

  // The widest this aperture's lit region could ever be, plus the furthest a band can travel out
  // of it. Everything a corner could matter to is inside this, and it does not depend on the
  // tier — which is what keeps the corner set cacheable alongside the sweeps.
  const litMax = intersection([wedgePath(edge, n, maxRadius, coneAngle())], vis);
  const relevant = fromClipperPaths(dilate(litMax, bendRadius()), SCALE);

  const corners = cornersFor(visPolygons, origins, relevant);
  const bend = corners.length
    ? union([...vis, ...corners.map((c) => sweepPath(c, bendRadius()))])
    : vis;

  const entry = { epoch, maxRadius, origins, vis, bend, corners: corners.length };
  sweepCache.set(edge.id, entry);
  return entry;
}

/* -------------------------------------------- */
/*  One window                                  */
/* -------------------------------------------- */

/**
 * Resolve one candidate edge into its bands, or `null` if it is not a window.
 *
 * @returns {{bands: {tier: number, paths: object[][]}[], ramp: object|null}|null}
 */
function bandsFor(edge, sceneTier, epoch) {
  const f = frame(edge);
  if (!f) return null;

  const probe = (canvas?.dimensions?.size ?? 100) * PROBE_SQUARES;
  const plus = offsetPoint(f.mid, f.n, probe);
  const minus = offsetPoint(f.mid, f.n, -probe);

  const tierPlus = roomTier(plus, sceneTier);
  const tierMinus = roomTier(minus, sceneTier);

  // Same ambient on both sides: an interior wall, or a window in open air. Either way there is
  // nothing to spill, and this is also what turns the whole feature off at nightfall — once the
  // sky is darker than the room, no window on the scene qualifies.
  if (tierPlus === tierMinus) return null;

  // Inward points at the darker side; the brighter side is where the light comes from.
  const inwardSign = tierPlus < tierMinus ? 1 : -1;
  const n = { x: f.n.x * inwardSign, y: f.n.y * inwardSign };
  const inside = inwardSign > 0 ? plus : minus;
  const outside = inwardSign > 0 ? minus : plus;
  const interiorTier = Math.min(tierPlus, tierMinus);

  const spillTier = spillTierAt(outside);
  if (spillTier === null) return null;

  // §3.4's guard, and the same comparison as eligibility. A Bright scene clamped to Dim indoors
  // with a *deeper darkness* over the window gives Dim against Dim: nothing to do, correctly.
  if (spillTier <= interiorTier) return null;

  // Bands run from the spill tier down to whichever is higher: one rung above the room, or Dim.
  // Dim is not a preference — `globalLightCutoff` is the Dim threshold and `darknessFor` erases
  // below it, so there is no rung underneath for global illumination to reach.
  const floor = Math.max(interiorTier + 1, TIER.DIM);
  if (spillTier < floor) return null;
  const count = spillTier - floor + 1;

  const radius = toPixels(radiusFeet(spillTier));
  if (!(radius > 0)) return null;
  const band = toPixels(bandFeet());
  const steps = count - 1;

  // The regions that make this room an interior. Clipping to them is what stops the spill
  // leaking back out of its own window, and it is the only non-wall trim in the construction.
  const enclosing = areas
    .areas()
    .filter((area) => !area.derived && areas.covers(area, inside));
  if (!enclosing.length) return null;
  const regionPaths = union(enclosing.flatMap((area) => areas.pathsFor(area, SCALE)));
  if (!regionPaths.length) return null;

  const sweeps = sweepsFor(edge, n, f.length, epoch);

  // The lit wedge: full window width at the wall, occluded by what the aperture can see. No
  // radius clip — `wedgePath` is already bounded by `radius`.
  const white = intersection(
    intersection([wedgePath(edge, n, radius, coneAngle())], sweeps.vis),
    regionPaths
  );
  if (!white.length) return null;

  // **Bands get the wider domain, the wedge does not.** `vis` is what the window itself can see,
  // so clipping the bands to it would confine them to the wedge's own shadow edges — the bug the
  // first build had. `bend` adds what the corners casting those shadows can see, which is how
  // light gets into the shadow at all.
  const domain = intersection(sweeps.bend, regionPaths);

  const out = [{ tier: spillTier, paths: white }];
  let previous = white;

  for (let k = 1; k <= steps; k++) {
    // Dilating `white` by `k · d` rather than the previous band by `d`, so rounding does not
    // compound across the ladder and each band is exactly the offset §3.4 specifies. The
    // dilation is also the only distance bound the bands have — every clip above is visibility.
    const grown = intersection(dilate(white, k * band), domain);
    if (!grown.length) break;
    const ring = difference(grown, previous);
    if (ring.length) out.push({ tier: stepTier(spillTier, -k), paths: ring });
    previous = grown;
  }

  // The same wedge again at quarter-band resolution, for the renderer alone (§7.0 step 5). The
  // bands above are the **model**; this is the picture, and it is built here because this is where
  // `white` and `domain` exist. A window whose ramp fails to triangulate still gets its bands —
  // `render/gradient.mjs` falls back to painting them flat.
  const ramp = rampFor({
    id: `${MODULE_ID}.spill.${edge.id}`,
    white,
    domain,
    band,
    spillTier,
    steps,
  });

  return { bands: out, ramp };
}

/* -------------------------------------------- */
/*  Rebuild                                     */
/* -------------------------------------------- */

/**
 * Mark the bands stale. `geometry` also drops the cached sweeps.
 *
 * @remarks
 * **Deliberately does not clear {@link cache}.** The last good bands stay on screen until new
 * ones replace them, which matters because {@link schedule} declines to rebuild while the walls
 * layer is open: clearing here would make every lit room go dark the moment a GM picked up the
 * wall tool, and stay dark until they put it down. Stale spill for the length of an edit is a
 * far better failure than no spill.
 */
export function invalidate({ geometry = false } = {}) {
  if (geometry) {
    geometryEpoch++;
    sweepCache.clear();
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
  const nextRamps = [];
  let candidates = 0;
  let windows = 0;
  // Origins plus bending corners, summed over the windows that produced bands. The number to
  // watch if a wall edit feels slow: each one is a `ClockwiseSweepPolygon`, and the geometry
  // epoch drops the whole cache on every wall change.
  let sweeps = 0;

  const publish = (stats) => {
    cache = next;
    rampCache = nextRamps;
    dirty = false;
    generation++;
    areas.invalidate();
    return (lastStats = stats);
  };

  if (!isEnabled() || !canvas?.ready || !canvas.edges) {
    return publish({ enabled: isEnabled(), candidates: 0, windows: 0, bands: 0, rings: 0, ms: 0 });
  }

  // No point: `ambientTier` returns the scene's own tier untouched, which is the base every
  // room-versus-outside comparison below is folded from.
  const sceneTier = sceneAmbientTier();
  const epoch = geometryEpoch;

  // Nothing this depends on has moved. `initializeLightSources` fires for reasons that have
  // nothing to do with spill — a light re-initialising in place, a canvas refresh — and the
  // whole ladder is cheap only relative to how often that is. Same idea as `field.get()`
  // returning the same object when its signature is unchanged.
  const signature = `${epoch}:${registryVersion()}:${sceneTier}`;
  if (signature === lastSignature && cache.length) {
    dirty = false;
    return lastStats;
  }
  lastSignature = signature;

  for (const edge of canvas.edges.values()) {
    if (!isAperture(edge)) continue;
    candidates++;

    const result = bandsFor(edge, sceneTier, epoch);
    if (!result?.bands?.length) continue;
    windows++;
    sweeps += (sweepCache.get(edge.id)?.origins?.length ?? 0) + (sweepCache.get(edge.id)?.corners ?? 0);
    if (result.ramp) nextRamps.push(result.ramp);

    for (const { tier, paths } of result.bands) {
      next.push({
        id: `${MODULE_ID}.spill.${edge.id}.${tier}`,
        derived: true,
        mode: areas.MODE.AT_LEAST,
        tier,
        paths,
        polygons: fromClipperPaths(paths, SCALE),
      });
    }
  }

  return publish({
    enabled: true,
    candidates,
    windows,
    sweeps,
    bands: next.length,
    rings: next.reduce((n, area) => n + area.paths.length, 0),
    // §7.0 step 5. One gradient mesh per window, against `bands` flat meshes without it — and
    // `ramps` below `windows` means some window failed to triangulate and is being painted flat.
    ramps: nextRamps.length,
    rampTriangles: nextRamps.reduce((n, ramp) => n + ramp.triangles, 0),
    ms: Math.round((performance.now() - t0) * 100) / 100,
  });
}

/**
 * Coalesce to one rebuild per frame.
 *
 * @remarks
 * **The walls-layer suppression is deliberately not here** (Patrick, 2026-08-26: *"let's disable
 * the rebuild suppress when editing walls — I want to see what kind of latency this actually
 * creates"*). Wall editing is the worst case by construction: every change bumps the geometry
 * epoch, which drops the sweep cache, so each edit re-sweeps every window on the scene. If it
 * turns out to need a brake, the brake is one `if` and the hook to lift it is already written
 * (`deactivateWallsLayer`) — measuring first is the cheaper order.
 */
export function schedule({ geometry = false } = {}) {
  invalidate({ geometry });
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    if (!dirty) return;
    rebuild();
    if (canvas?.ready) canvas.perception.update({ refreshLighting: true, refreshVision: true });
  });
}

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

export function registerSettings() {
  const numeric = (key, name, hint, dflt, range) =>
    game.settings.register(MODULE_ID, key, {
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

  numeric(SETTING_ANGLE, "Spill cone angle", "How wide the brightest wedge reads, in degrees.", 105, {
    min: 30,
    max: 180,
    step: 5,
  });
  numeric(SETTING_RADIUS[TIER.BRIGHT], "Max spill radius — Bright", "Feet.", 40, { min: 0, max: 200, step: 5 });
  numeric(SETTING_RADIUS[TIER.NORMAL], "Max spill radius — Normal", "Feet.", 20, { min: 0, max: 200, step: 5 });
  numeric(SETTING_RADIUS[TIER.DIM], "Max spill radius — Dim", "Feet.", 10, { min: 0, max: 200, step: 5 });
  numeric(SETTING_BAND, "Band width", "Feet per tier step as the spill falls off.", 10, {
    min: 5,
    max: 60,
    step: 5,
  });
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

  // Kept while rebuilds during wall editing are unsuppressed — it is a no-op in that state, and
  // it is the hook a brake would need if the latency turns out to warrant one. See `schedule`.
  Hooks.on("deactivateWallsLayer", () => {
    if (dirty) schedule();
  });

  // A darkness moving over a window changes what spills through it, and nothing about the walls.
  Hooks.on("initializeLightSources", tiers);
  Hooks.on("updateScene", (_doc, changed) => {
    if ("environment" in changed || "darkness" in changed || "grid" in changed) tiers();
  });

  Hooks.on("canvasTearDown", () => {
    sweepCache.clear();
    cache = [];
    lastSignature = null;
    dirty = true;
  });

  // Appended last, so spill folds *after* the drawn regions — see the file header.
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
 * screen. `candidates` above zero with `windows` at zero is the ordinary night-time state and
 * also what a mis-drawn region looks like; `visible: false` means the model has moved and the
 * map cannot, because §7.0's texture is the only channel that can brighten a restricted region.
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
      angle: coneAngle(),
      band: bandFeet(),
      radius: {
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
 * `AT_LEAST` folds them to the brightest. The first row is therefore the tier this point
 * actually gets from spill.
 */
export function at(point) {
  return cache
    .filter((area) => containsPoint(area.polygons, point))
    .sort((a, b) => b.tier - a.tier)
    .map((area) => ({ tier: TIER_NAME[area.tier], id: area.id }));
}
