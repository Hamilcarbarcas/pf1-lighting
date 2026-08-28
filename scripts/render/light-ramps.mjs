/**
 * A light's brightness as a **region in the darkness-level texture**. DESIGN.md §7.0 step 6.
 *
 * ## Why a light cannot hold a fixed brightness while a light source draws it
 *
 * §6.2.9 made a light's *zone colours* absolute and Patrick reported it still was not right. It
 * was not, and the reason is one line further down the same shader. `FALLOFF` and `FRAGMENT_END`
 * (`base-lighting.mjs:347`, `illumination-lighting.mjs:13`):
 *
 * ```glsl
 * if ( attenuation != 0.0 ) depth *= smoothstep(1.0, 1.0 - attenuation, dist);
 * gl_FragColor = vec4(mix(computedBackgroundColor, finalColor, depth), 1.0);
 * ```
 *
 * plus `SWITCH_COLOR`, which blends the two zones across 72% of the ratio at the default
 * attenuation. **A Foundry light is a radial falloff by construction.** Its nominal level is
 * reached only at the very centre; everywhere else is an interpolation toward the background. So
 * "each level has a fixed brightness" is not a thing that can be true of a rendered light source,
 * however exactly its endpoint colours are pinned — which is what §6.2.9 pinned.
 *
 * The model has always known the answer: a light has two zones, each at a tier. This file draws
 * that instead, in the one place the module already expresses brightness as a number.
 *
 * ## The geometry, and why it needs no Clipper in the common case
 *
 * A `ClockwiseSweepPolygon` is **star-shaped about its own origin** — the property §3.4 already
 * leans on for its corner probes. So scaling every boundary vertex toward the origin stays inside
 * the polygon, and a set of scale factors gives a radial grid: consecutive rings share a vertex
 * count and an index correspondence, so each band is a quad strip and each quad is two triangles.
 * No boolean ops, no triangulator.
 *
 * The level per vertex is **analytic** — `|v − origin|` through {@link levelAtRadius} — which is
 * the difference from §3.4's ramp and the reason this file is short. Spill has to recover the
 * distance to an arbitrary polygon from the iso-lines that produced it; a light's distance field
 * is a closed form, so any vertex, however it was produced, can be asked directly.
 *
 * That last point is what makes the clipped case cheap too. A light with a *darkness* cut out of
 * it is no longer star-shaped, so the strip has to be intersected with the cell — but the levels
 * still come from the same closed form, with nothing to look up. `cell.clipped` selects the path,
 * and it is false for every light that is not standing in a suppressor's way, which is nearly all
 * of them.
 *
 * ## What the light source still does
 *
 * Colour, animation, and revealing. Only the *illumination* contribution is withheld, by handing
 * the source zone tiers equal to the ground it stands on (§6.2.9's `UNLIT` case, which already
 * paints exactly the background). `canvas.visibility` reads a light's **polygon**, not its
 * illumination mesh, so what a creature can see by is untouched.
 */

import { MODULE_ID } from "../constants.mjs";
import {
  CLIPPER_SCALE,
  containsPoint,
  difference,
  fromClipperPaths,
  groupRings,
  intersection,
  toClipperPath,
} from "../geometry.mjs";
import { TIER, darknessTable, stepTier } from "../model/tiers.mjs";
import { LIGHT_SORT } from "./darkness-shaders.mjs";
import * as fieldBlur from "./texture-blur.mjs";
import { levelAtDistance, width } from "./transition.mjs";

export const SETTING_LIGHT_TEXTURE = "lightsInTexture";

/**
 * Radial subdivisions across a light's whole radius.
 *
 * @remarks
 * The tessellation has to be fine enough that a linear interpolation between two rings tracks the
 * profile's curvature, and the profile's tightest feature is a transition — one
 * `transition.width()`, three quarters of a square by default. Sixteen puts several rings inside
 * it on any light worth drawing.
 *
 * Cost is linear and small: a light with 60 boundary vertices costs 16 × 60 vertices and twice
 * that many triangles, all built by arithmetic. It is the *clipped* path that is worth counting,
 * and that one is bounded by how many lights stand inside a darkness.
 */
const RADIAL_STEPS = 16;

export function isEnabled() {
  try {
    return (
      game.settings.get(MODULE_ID, SETTING_LIGHT_TEXTURE) === true &&
      game.settings.get(MODULE_ID, "ambientTakeover") === true
    );
  } catch {
    return false;
  }
}

/**
 * Are band overlaps drawn? `render/renderer.mjs` owns the setting.
 *
 * @remarks
 * **Read by key rather than by import, and that is a deliberate ugliness.** `render/renderer.mjs`
 * imports this file, so importing `SETTING_SHOW_STACKS` back would make a cycle between peers —
 * the thing every seam in this module (`soften.setGroundRefresh`, `transition.setRefresh`,
 * `perception.setUmbraModel`) exists to avoid. A one-line injector for a boolean read would be more
 * machinery than the duplication costs, so the string is repeated and both ends say so.
 */
function stacksEnabled() {
  try {
    // Owner: `SETTING_SHOW_STACKS` in `render/renderer.mjs`.
    return game.settings.get(MODULE_ID, "showStackedOverlaps") === true;
  } catch {
    return false;
  }
}

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTING_LIGHT_TEXTURE, {
    name: "Draw lights as brightness regions",
    hint:
      "Paints each light's two zones into the same brightness map the ground uses, instead of " +
      "letting Foundry draw it as a radial falloff. A Normal-lit ring is then the same brightness " +
      "as ground at Normal, everywhere, with a controlled transition rather than a fade toward " +
      "whatever is underneath. Lights keep their colour and animation. Requires Model global " +
      "illumination.",
    scope: "world",
    // No control surface, matching the module's other corrections of core behaviour.
    config: false,
    type: Boolean,
    default: true,
    onChange: () => {
      if (canvas?.ready) canvas.perception.update({ initializeLighting: true, refreshLighting: true });
    },
  });
}

/* -------------------------------------------- */
/*  The profile                                 */
/* -------------------------------------------- */

/**
 * The darkness level at a distance from the light's origin.
 *
 * @remarks
 * A thin wrapper now: §6.4.3 moved the profile into `render/transition.mjs` so a light's zone
 * boundary, a spill band and a room's edge all fade over the same distance. What is left here is
 * the one thing that is specific to a light — `trailing`, which finishes the outermost ramp *at*
 * the rim instead of straddling it, because there is no geometry past it to carry the other half.
 * That is also what makes the mesh's own silhouette invisible: it hands back exactly the ground
 * level at its edge.
 *
 * @param {number} r - Distance from the origin, scene pixels
 * @param {{r0: number, r1: number, level: number}[]} zones
 */
export function levelAtRadius(r, zones) {
  return levelAtDistance(r, zones, { trailing: true });
}

/**
 * A light's two zones as radii and levels, plus the ground it hands back to.
 *
 * @remarks
 * Radii come from `source.radius` and `source.ratio` rather than from `emission.inner`/`outer`,
 * which are the authored values in scene *distance* units. Those two are what the shader itself
 * uses — `dist` is normalised against `radius` and `ratio` is the switch point — so taking them
 * keeps this in step with the light Foundry would have drawn, with no unit conversion to get
 * wrong.
 *
 * `max` against the ground tier throughout, because a light may not darken (§3.2.1). A torch at
 * noon collapses to three zones all at the ground's level, which draws nothing visible and is the
 * right answer.
 */
function zonesFor(source, emission, base) {
  const outer = source.radius;
  if (!(outer > 0)) return null;
  const inner = outer * (source.ratio ?? 0);

  const table = darknessTable();
  const level = (tier) => table[Math.max(tier, base)] ?? table[TIER.DARK];

  const bandTier = Math.max(
    base,
    Math.min(stepTier(base, emission.steps ?? 1), emission.cap ?? emission.tier)
  );

  return [
    { r0: 0, r1: inner, level: level(emission.tier) },
    { r0: inner, r1: outer, level: level(bandTier) },
    // The ground the light sits on. Its only job is to be the value the outermost ramp arrives at.
    { r0: outer, r1: Infinity, level: table[base] ?? table[TIER.DARK] },
  ];
}

/* -------------------------------------------- */
/*  Geometry                                    */
/* -------------------------------------------- */

/**
 * The light's boundary pulled in to an absolute radius, clamped per spoke.
 *
 * @remarks
 * **Absolute radii, not a fraction of each spoke** (Patrick, 2026-08-27: *"odd behavior when the
 * gradient occurs over a wall"*). Scaling every boundary vertex by the same factor is the obvious
 * construction and it puts the ring boundaries in the wrong place: on a wall-cut sweep, a spoke
 * that stops short at a wall and one that runs the full radius get their `m`th sample at very
 * different distances, so a "ring" is not an iso-radius line at all. The level is still exact at
 * each vertex — it comes from the true distance — but the triangle *between* two such vertices
 * spans a large range of radius and interpolates linearly across it, which is what drew the
 * straight-edged bands running parallel to the wall.
 *
 * Sampling at `min(m · step, spokeLength)` makes every ring a true circle wherever there is room
 * for one, and collapses the surplus samples onto the wall where there is not. Those collapsed
 * quads are degenerate and rasterise to nothing, which is cheaper than the branch to avoid them.
 */
function ringAt(points, origin, radius) {
  const n = points.length / 2;
  const out = new Array(n * 2);
  for (let i = 0; i < n; i++) {
    const dx = points[i * 2] - origin.x;
    const dy = points[i * 2 + 1] - origin.y;
    const r = Math.hypot(dx, dy) || 1;
    const t = Math.min(1, radius / r);
    out[i * 2] = origin.x + dx * t;
    out[i * 2 + 1] = origin.y + dy * t;
  }
  return out;
}

/**
 * Emit the radial grid of a star-shaped polygon directly as triangles.
 *
 * @remarks
 * The fast path, and it is the common one: no Clipper, no triangulator, no distance lookup. Ring
 * `m` is {@link ringAt} at `m · step`; consecutive rings share an index, so a band is a quad strip
 * and the innermost is a fan.
 */
function emitStar(points, origin, out, levelAt, step) {
  const n = points.length / 2;
  if (n < 3) return;

  const base = out.vertices.length / 2;

  for (let m = 0; m <= RADIAL_STEPS; m++) {
    const ring = ringAt(points, origin, m * step);
    for (let i = 0; i < n; i++) {
      const x = ring[i * 2];
      const y = ring[i * 2 + 1];
      out.vertices.push(x, y);
      out.levels.push(levelAt(Math.hypot(x - origin.x, y - origin.y)));
    }
  }

  for (let m = 1; m <= RADIAL_STEPS; m++) {
    const inner = base + (m - 1) * n;
    const outer = base + m * n;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      out.indices.push(inner + i, outer + i, outer + j);
      out.indices.push(inner + i, outer + j, inner + j);
    }
  }
}

/**
 * The same grid, cut to a cell that is no longer star-shaped.
 *
 * @remarks
 * Reached only when a suppressor has taken a bite out of the light (`cell.clipped`), which is why
 * it is allowed to cost `RADIAL_STEPS` boolean ops.
 *
 * **The rings are annuli and must be triangulated as annuli.** This is where a light overlapping a
 * *darkness* lost its gradient entirely and came back as concentric hard steps (Patrick,
 * 2026-08-27, who located it by moving the light off the darkness and watching the gradient
 * return). `difference` hands back an outer ring *and* its inner boundary as a separately-wound
 * path; earcutting each on its own — with no hole indices — turns the hole into a **solid disc**,
 * so every band filled itself in from the centre. Each of those discs is flat, because all of its
 * vertices sit at one radius, and `MIN` over a stack of flat discs is a staircase.
 *
 * `groupRings` pairs each outer with its holes, which is the same call `render/halo.mjs` and the
 * clamp meshes already make. The levels were never wrong; the triangles were.
 */
function emitClipped(points, origin, cellPaths, out, levelAt, step) {
  const n = points.length / 2;
  if (n < 3) return;

  const clipperRing = (radius) => {
    const ring = ringAt(points, origin, radius);
    const path = new Array(n);
    for (let i = 0; i < n; i++) {
      path[i] = {
        X: Math.round(ring[i * 2] * CLIPPER_SCALE),
        Y: Math.round(ring[i * 2 + 1] * CLIPPER_SCALE),
      };
    }
    return path;
  };

  let previous = null;
  for (let m = 1; m <= RADIAL_STEPS; m++) {
    const ring = clipperRing(m * step);
    const band = previous ? difference([ring], [previous]) : [ring];
    previous = ring;
    if (!band.length) continue;

    const solution = intersection(band, cellPaths);
    if (!solution.length) continue;

    for (const group of groupRings(fromClipperPaths(solution, CLIPPER_SCALE))) {
      const ringPoly = group.outer;
      if (!(ringPoly?.points?.length >= 6)) continue;
      const flat = group.holes?.length ? Array.from(ringPoly.points) : ringPoly.points;
      const holeIndices = [];
      for (const hole of group.holes ?? []) {
        if (!(hole?.points?.length >= 6)) continue;
        holeIndices.push(flat.length / 2);
        for (const value of hole.points) flat.push(value);
      }

      const indices = PIXI.utils.earcut(flat, holeIndices.length ? holeIndices : null, 2);
      if (!indices.length) continue;

      const start = out.vertices.length / 2;
      for (let i = 0; i < flat.length; i += 2) {
        out.vertices.push(flat[i], flat[i + 1]);
        out.levels.push(levelAt(Math.hypot(flat[i] - origin.x, flat[i + 1] - origin.y)));
      }
      for (const index of indices) out.indices.push(start + index);
    }
  }
}

/**
 * The two zones as flat regions — the §6.4.4 path.
 *
 * @remarks
 * The inner zone is a circle cut to whatever the light covers; the band is the rest of it. Both are
 * constant, so the mesh carries one level per vertex only because that is the buffer layout this
 * pool speaks.
 *
 * `density: 120` on the circle rather than the sweep's own resolution: the sweep is subdivided for
 * *occlusion*, which is a different question from how round a bright zone needs to look, and it is
 * the one number that decides whether the inner boundary reads as a circle. It is cheap — the ring
 * is generated, intersected once and triangulated once.
 */
function emitFlat(cell, source, zones, out) {
  const region = [];
  const base = cell.clipped && cell.polygon ? cell.polygon : source.shape;
  const path = toClipperPath(base, CLIPPER_SCALE);
  if (path.length < 3) return;
  region.push(path);
  for (const hole of cell.clipped ? (cell.holes ?? []) : []) {
    const p = toClipperPath(hole, CLIPPER_SCALE);
    if (p.length >= 3) region.push(p);
  }

  const inner = zones[0].r1;
  const disc =
    inner > 0
      ? intersection(
          [toClipperPath(new PIXI.Circle(source.x, source.y, inner).toPolygon({ density: 120 }), CLIPPER_SCALE)],
          region
        )
      : [];

  // The band is everything the light covers that the inner zone does not. Cut rather than drawn
  // underneath, so the two do not overlap and the blur sees one boundary at each radius instead of
  // a hidden second one.
  const band = disc.length ? difference(region, disc) : region;

  const add = (paths, level) => {
    for (const { outer, holes } of groupRings(fromClipperPaths(paths, CLIPPER_SCALE))) {
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
      const start = out.vertices.length / 2;
      for (let i = 0; i < points.length; i += 2) {
        out.vertices.push(points[i], points[i + 1]);
        out.levels.push(level);
      }
      for (const i of tri) out.indices.push(start + i);
    }
  };

  add(band, zones[1].level);
  if (disc.length) add(disc, zones[0].level);
}

/**
 * One light's brightness as a ramp payload, in `render/gradient.mjs`'s own shape.
 *
 * @remarks
 * **Levels, not distances.** §3.4's payload carries distances and lets the renderer map them,
 * because a spill's geometry is expensive and its mapping is a slider. A light is the other way
 * round: the geometry is cheap arithmetic and gets rebuilt whenever the light moves anyway, so
 * there is nothing to gain by keeping the mapping separate and the buffer can be final.
 *
 * @returns {object|null}
 */
export function rampFor(cell, base) {
  const source = cell.emitter?.source;
  const emission = cell.emission ?? cell.emitter?.emission;
  if (!source || !emission) return reject("no source or emission");

  const zones = zonesFor(source, emission, base);
  if (!zones) return reject("radius is zero");

  // Nothing to draw: every zone resolved to the ground it stands on. A torch at noon.
  const ground = zones[zones.length - 1].level;
  if (zones.every((zone) => zone.level === ground)) {
    return reject(`no brighter than its ground (tier ${base})`);
  }

  // **The source's own shape, not the cell's**, so the grid is built on something star-shaped.
  // The cell is what it is then cut to, and only when the two differ.
  const shape = source.shape;
  const points = shape?.points;
  if (!(points?.length >= 6)) return reject("source has no polygon");

  const origin = { x: source.x, y: source.y };
  const levelAt = (r) => levelAtRadius(r, zones);

  // One step of radius per ring, in scene pixels, so a ring is an iso-radius line rather than a
  // fraction of however far each spoke happens to reach.
  const step = source.radius / RADIAL_STEPS;

  const out = { vertices: [], levels: [], indices: [] };

  // §6.4.4 — with the field blur doing the softening, a light does not need a ramp of its own.
  // **Two flat zones and let the blur find both boundaries.** That is not merely cheaper; it is
  // what removes the faceting (Patrick, 2026-08-27: *"with bigger light sources the polygons start
  // to show"*). The radial grid subdivides by `radius / RADIAL_STEPS`, so a band's thickness grows
  // with the light — and between two rings the level interpolates along the **chords** of a
  // polygonalised circle rather than along its radius, which turns the iso-level contours into a
  // polygon whose facets widen with the light. Exactly the two-ring failure `render/halo.mjs` hit,
  // scaled by radius. Flat zones have no interior interpolation at all, so there is nothing to
  // facet, and the circle they are cut from can be generated at whatever density we like rather
  // than inherited from the wall sweep.
  if (fieldBlur.isEnabled()) {
    emitFlat(cell, source, zones, out);
    if (out.indices.length < 3) return reject("triangulated to nothing");
  } else if (cell.clipped && cell.polygon) {
    const paths = [toClipperPath(cell.polygon, CLIPPER_SCALE)];
    for (const hole of cell.holes ?? []) {
      const path = toClipperPath(hole, CLIPPER_SCALE);
      if (path.length >= 3) paths.push(path);
    }
    emitClipped(points, origin, paths, out, levelAt, step);
    if (out.indices.length < 3) return reject("triangulated to nothing");
  } else {
    emitStar(points, origin, out, levelAt, step);
    if (out.indices.length < 3) return reject("triangulated to nothing");
  }

  const bounds = shape.getBounds?.() ?? shape.bounds;

  return {
    id: `${MODULE_ID}.light.${source.sourceId ?? source.object?.id ?? "?"}.${cell.index ?? 0}`,
    kind: "light",
    // **`MIN_COLOR` is *half* of §3.2.1, and the comment here used to claim it was all of it.**
    // The channel holds a darkness level, so `min` is brightest-wins per fragment, which is
    // exactly the `A = max(every covering inner zone)` half — set levels contend, light does not
    // stack (§4.2). Correct, and it is why two torches can overlap at all.
    //
    // What it cannot express is the other half. Relative **bands sum**:
    //
    //     result = max(A, min(A + Σsteps, max(caps)))
    //
    // and a blend equation that takes the brightest of two inputs can never produce a result
    // brighter than either. Patrick, 2026-08-27: *"overlapping lights can create an area of
    // brighter light... they provide +1 to the light level, to the maximum of normal, so 2 dim
    // overlaps should be rendered to normal."* Two Dim bands sum to +2 capped at Normal; this
    // draws them as Dim.
    //
    // **Which is why the summing does not live here.** `model/field.mjs` emits a `stack` cell for
    // every band overlap and `render/renderer.mjs` draws it — one clone per participating emitter,
    // at that emitter's own origin and attenuation, with the band raised to the resolved tier.
    // That work exists and is complete; it is gated behind `showStackedOverlaps`, which defaults
    // to **false**. So the missing brightening is a switch, not a gap.
    //
    // Open, and the reason this note is here rather than only in the design doc: those clones
    // still draw on the **illumination** layer with a constant tier colour, which is the exact
    // path §6.4.6's `withheld()` finding identified as re-lighting a region and cutting off hard
    // at the clip boundary. They were not revisited when §7.0 step 6 moved every other light into
    // the texture. If turning the switch on produces a flat plateau or a hard rim, the fix is to
    // route the overlap through this file like everything else.
    blendMode: "MIN_COLOR",
    sortLevel: LIGHT_SORT,
    // What `getDarknessLevel` reports inside this light. The inner zone, which is the one a caller
    // asking about a torch means.
    nominal: zones[0].level,
    vertices: new Float32Array(out.vertices),
    levels: new Float32Array(out.levels),
    indices: new Uint32Array(out.indices),
    bounds: new PIXI.Rectangle(bounds.x, bounds.y, bounds.width, bounds.height),
    // A point query answers from the light's own polygon, which is exactly the ground it covers.
    outline: [shape],
    // **For `ui/cell-overlay.levels` and nothing else.** A light is a brightness region since
    // §7.0 step 6, so an overlay that shows the ground and not the lights is showing half the map
    // — which is exactly what it did, and what sent this round of diagnosis at the geometry
    // instead of at the tool (Patrick, 2026-08-27).
    debug: {
      x: origin.x,
      y: origin.y,
      shape,
      inner: zones[0].r1,
      outer: zones[1].r1,
      base,
      // What the light actually covers: its own sweep, or the cell if a suppressor bit into it.
      // The overlay needs this to resolve a partition rather than stack outlines.
      region: cell.clipped && cell.polygon ? cell.polygon : shape,
      innerTier: Math.max(emission.tier, base),
      bandTier: Math.max(
        base,
        Math.min(stepTier(base, emission.steps ?? 1), emission.cap ?? emission.tier)
      ),
    },
    triangles: out.indices.length / 3,
    clipped: cell.clipped === true,
  };
}

/* -------------------------------------------- */
/*  Cache                                       */
/* -------------------------------------------- */

/** @type {Map<string, {key: string, ramp: object|null}>} */
const cache = new Map();
let builds = 0;
let reuses = 0;

/**
 * Why lights produced no mesh, counted by reason.
 *
 * @remarks
 * **Added after `lights: 0` cost a round of guessing** (2026-08-27). Every rejection in
 * {@link rampFor} is legitimate on its own terms — a torch at noon *should* draw nothing — so a
 * count of zero is indistinguishable from a fault without knowing which branch produced it. The
 * reasons are strings rather than codes because the useful one carries a number with it: *"no
 * brighter than its ground (tier 3)"* names the bug and the value in the same breath.
 */
let rejects = {};

function reject(reason) {
  rejects[reason] = (rejects[reason] ?? 0) + 1;
  return null;
}

/**
 * Everything a ramp's geometry and levels depend on, as one comparable key.
 *
 * @remarks
 * **This is what keeps a token drag affordable.** `paint.repaint` runs whenever the field or any
 * observer's line of sight changes, which during a drag is every frame; without this, every light
 * on the map would rebuild its grid on each of them to produce the identical buffers.
 *
 * `source.shape` is compared by **identity**, not by value — `_createShapes` replaces it rather
 * than mutating it, which is the same trick `field.currentSignature` and the umbra cache already
 * use. So a torch that moved gets a new shape and rebuilds; a torch that did not, does not, even
 * though the observer walking past it re-ran the whole pass.
 *
 * `darknessTable()` likewise: `setDarknessTable` swaps the object, so a retune invalidates every
 * light without anyone having to remember to.
 */
function cacheKey(cell, base, shape) {
  const e = cell.emission ?? {};
  return [
    base,
    e.tier,
    e.steps,
    e.cap,
    cell.clipped ? cell.polygon : null,
    shape,
    darknessTable(),
    width(),
    fieldBlur.isEnabled(),
  ]
    .map((part) => (typeof part === "object" && part !== null ? objectId(part) : String(part)))
    .join("|");
}

/** Stable per-object ids, so identity comparison survives being stringified into a key. */
const ids = new WeakMap();
let nextId = 1;
function objectId(object) {
  let id = ids.get(object);
  if (id === undefined) ids.set(object, (id = nextId++));
  return `#${id}`;
}

/**
 * Minkowski offset in scene pixels; negative erodes. Mirrors `render/paint.mjs`'s, `jtMiter` for
 * the same reason: a round join curves every corner and facets a circle at small deltas.
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
 * A band overlap, as a region in the brightness field. §3.2.1's `Σn` half.
 *
 * @remarks
 * Patrick, 2026-08-27: *"I want those areas to be incorporated into `render.texture` and rendered
 * that way rather than illuminated individually."*
 *
 * ## Why the flat fill is right now, having been wrong before
 *
 * `render/renderer.mjs` drew these by **cloning** every participating light — same origin, radii
 * and attenuation, band raised to the resolved tier — and its note says why a flat fill was tried
 * first and rejected: a Foundry light is very nearly all gradient (`SWITCH_COLOR` blends the two
 * zones across 72% of the ratio, `FALLOFF` ramps the outer half on top), so *"a plateau butted
 * against that reads as a step however accurate its value"*.
 *
 * **That premise died with §7.0 step 6.** A light in this file is not a falloff any more; with the
 * field blur on it is {@link emitFlat}'s two flat zones. A flat overlap butted against flat zones
 * is the same kind of thing as its neighbours, and the blur finds this boundary exactly as it finds
 * theirs. The clones were solving a problem that the takeover had already removed.
 *
 * It also puts the overlap where every other brightness lives. One field, one blur, one point
 * query — and `getDarknessLevel` inside an overlap now reports the tier the model says is there
 * instead of the brighter of the two lights under it.
 *
 * ## The collar, and when it is drawn
 *
 * With the blur off there is nothing else to soften the region's rim, so it gets a collar of its
 * own: the interior at the resolved level, a `transition.width()` band fading to **1.0** at the
 * edge. One is the darkest value the channel holds and `min(x, 1)` is `x`, so the collar's outer
 * end contributes nothing and whatever light lies beneath comes back through — the `MIN` mirror of
 * the `MAX` trick `render/paint.mjs`'s `clampRamps` plays, and the same construction.
 *
 * With the blur **on** the collar is skipped, or the boundary would be softened twice at two
 * different widths — the state §6.4.3 exists to end, and the reason `render/halo.mjs` emits
 * nothing in that mode.
 *
 * @param {object} cell - A `stack` cell: `polygon`, `tier`, `base`, `holes`
 * @param {number} base - The ground tier beneath it
 * @param {number} index
 * @returns {object|null}
 */
function stackRampFor(cell, base, index) {
  if (!(cell.polygon?.points?.length >= 6)) return reject("stack cell has no polygon");

  const table = darknessTable();
  const level = table[Math.max(cell.tier, base)] ?? table[TIER.DARK];
  const ground = table[base] ?? table[TIER.DARK];

  // Nothing to draw: the overlap resolved no brighter than the ground it sits on. Two torches at
  // noon, and the common case on a lit map.
  if (!(level < ground)) return reject(`overlap no brighter than its ground (tier ${base})`);

  const region = [toClipperPath(cell.polygon, CLIPPER_SCALE)];
  if (region[0].length < 3) return reject("stack cell degenerate");
  for (const hole of cell.holes ?? []) {
    const path = toClipperPath(hole, CLIPPER_SCALE);
    if (path.length >= 3) region.push(path);
  }

  const half = fieldBlur.isEnabled() ? 0 : width();
  const core = half > 0 ? offsetPaths(region, -half) : region;
  const collar = half > 0 && core.length ? difference(region, core) : [];
  const coreRings = collar.length ? fromClipperPaths(core, CLIPPER_SCALE) : null;

  const out = { vertices: [], levels: [], indices: [] };

  const add = (paths, levelFor) => {
    for (const { outer, holes } of groupRings(fromClipperPaths(paths, CLIPPER_SCALE))) {
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
      const start = out.vertices.length / 2;
      for (let i = 0; i < points.length; i += 2) {
        out.vertices.push(points[i], points[i + 1]);
        out.levels.push(levelFor({ x: points[i], y: points[i + 1] }));
      }
      for (const i of tri) out.indices.push(start + i);
    }
  };

  add(core.length ? core : region, () => level);
  // A vertex still inside the eroded core is the inner end of the ramp, everything else the outer.
  if (collar.length) add(collar, (point) => (containsPoint(coreRings, point) ? level : 1));

  if (out.indices.length < 3) return reject("stack triangulated to nothing");

  // **Computed from the vertices, not asked of the polygon.** A cell's `polygon` is a plain
  // `PIXI.Polygon` — Clipper output, not a sweep — so it has neither `getBounds()` nor `bounds`,
  // and the `?? shape.bounds` idiom `rampFor` uses above would hand the pool `undefined` and cull
  // the mesh out of existence.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < out.vertices.length; i += 2) {
    if (out.vertices[i] < minX) minX = out.vertices[i];
    if (out.vertices[i] > maxX) maxX = out.vertices[i];
    if (out.vertices[i + 1] < minY) minY = out.vertices[i + 1];
    if (out.vertices[i + 1] > maxY) maxY = out.vertices[i + 1];
  }
  const bounds = new PIXI.Rectangle(minX, minY, maxX - minX, maxY - minY);

  return {
    id: `${MODULE_ID}.stack.${index}`,
    kind: "light",
    // Same blend as a light, and the reason it works: `min` is brightest-wins per fragment, the
    // overlap's level is brighter than either band beneath it, so it simply wins where it lands.
    blendMode: "MIN_COLOR",
    sortLevel: LIGHT_SORT,
    nominal: level,
    vertices: new Float32Array(out.vertices),
    levels: new Float32Array(out.levels),
    indices: new Uint32Array(out.indices),
    bounds,
    // So `getDarknessLevel` answers from the overlap rather than from the lights under it.
    outline: [cell.polygon],
    debug: {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
      region: cell.polygon,
      inner: 0,
      base,
      innerTier: cell.tier,
      bandTier: cell.tier,
      stack: true,
    },
  };
}

/**
 * Every light-bearing cell in the field, as ramps.
 *
 * @param {object[]} cells
 * @param {number} sceneTier
 * @returns {object[]}
 */
export function rampsFrom(cells, sceneTier) {
  if (!isEnabled()) {
    cache.clear();
    return [];
  }
  rejects = {};

  const out = [];
  const live = new Set();
  let index = 0;
  let stackIndex = 0;
  stackCells = 0;
  stackRamps = 0;

  for (const cell of cells) {
    // **Band overlaps, in the same field as everything else** (§3.2.1's `Σn`). Keyed by index
    // rather than by source id — an overlap belongs to no single light — so it is rebuilt each
    // pass rather than cached. That is the honest cost: the region's *shape* changes whenever
    // either light moves, which is precisely when the cache would have to be invalidated anyway.
    if (cell.kind === "stack") {
      stackCells++;
      if (!stacksEnabled()) {
        // **Recorded, not skipped silently.** A `stack` cell present in the field and absent from
        // the picture is exactly the state that cost this project two wrong diagnoses; the switch
        // being off has to be as visible as any other reason a ramp was not built.
        reject("showStackedOverlaps is off");
        continue;
      }
      // **Its own counter, and this is not tidiness.** A light's cache id is
      // `${sourceId}.${index}`, so letting stack cells consume values from `index` would shift
      // every light's id the moment an overlap appeared or vanished — a whole-scene cache miss
      // on the frame a token walks two torches together, which is the worst possible frame for it.
      const ramp = stackRampFor(cell, cell.base ?? sceneTier, stackIndex++);
      if (ramp) {
        stackRamps++;
        out.push(ramp);
      }
      continue;
    }

    if (cell.kind !== "clip" && cell.kind !== "reduced") continue;
    const source = cell.emitter?.source;
    if (!source) continue;

    const base = cell.base ?? sceneTier;
    const id = `${source.sourceId ?? source.object?.id ?? "?"}.${index++}`;
    live.add(id);

    const key = cacheKey(cell, base, source.shape);
    const hit = cache.get(id);
    if (hit?.key === key) {
      reuses++;
      if (hit.ramp) out.push(hit.ramp);
      continue;
    }

    builds++;
    const ramp = rampFor({ ...cell, index }, base);
    // `null` is cached too: "this light contributes nothing" is an answer worth not recomputing,
    // and it is the common one at noon.
    cache.set(id, { key, ramp });
    if (ramp) out.push(ramp);
  }

  for (const id of [...cache.keys()]) if (!live.has(id)) cache.delete(id);
  return out;
}

/** Band-overlap cells seen in the last pass, and how many became ramps. */
let stackCells = 0;
let stackRamps = 0;

/** Debug counters — `builds` staying flat during a token drag is the cache doing its job. */
export function stats() {
  return {
    enabled: isEnabled(),
    cached: cache.size,
    builds,
    reuses,
    // **§3.2.1's `Σn`, as it stands in the picture.** `stackCells` above `stacks` means the field
    // found band overlaps that did not become ramps, and `rejects` below says why — most often
    // the switch, which defaulted to `false` until 2026-08-27 and is therefore stored as `false`
    // in any world whose settings form has ever been saved.
    stackCells,
    stacks: stackRamps,
    stacksEnabled: stacksEnabled(),
    radialSteps: RADIAL_STEPS,
    // **The line to read when `lights` is 0.** Empty with a cache full of entries means every one
    // was reused from a previous pass, so the reasons belong to that pass — force a repaint first.
    rejected: { ...rejects },
  };
}

export function invalidate() {
  cache.clear();
}
