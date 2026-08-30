/**
 * Spill falloffs as **one interpolated mesh each**. DESIGN.md §7.0 step 5.
 *
 * ## What this replaces
 *
 * §7.0 made the ground's brightness a field, and everything since drew that field as *flat regions
 * plus a blur*. For a §3.4 spill that is the wrong representation, and three separate attempts to
 * make a falloff read as a gradient all failed against it rather than against their own mechanism:
 *
 * - **Widening the blur** spread each step further and added none. §6.4.2a's mechanism is one
 *   mesh's rim fading to reveal *the mesh beneath*, and beneath a stripe is only the next stripe.
 * - **Sub-rings** worked and were declined on looks — a linear ramp across a whole band leaves no
 *   plateau, so it reads as a smear rather than as a light level.
 * - **The blur's tap count** was the visible banding: `PIXI.BlurFilter` spreads a fixed number of
 *   taps across its width, so a wide blur samples five points eleven pixels apart.
 *
 * A blur is an approximation of a gradient by a filter. The rasteriser draws one for free: the
 * level moves from a shader **uniform** to a per-vertex **attribute**, and every triangle is
 * interpolated barycentrically at no extra pass. The consequence that matters is not smoothness,
 * it is mesh count — a whole falloff becomes one mesh with one draw and no filter, against 69
 * meshes and 55 filtered render passes before it.
 *
 * ## It is the pool for everything that composites, not just spill
 *
 * The header above is the origin story; the file has since become the shared mesh pool for every
 * pass that layers over the ground partition. Four producers, one buffer layout, one shader:
 *
 * | `kind` | Producer | Blend | What it is |
 * | --- | --- | --- | --- |
 * | *(none)* | `model/spill.mjs` | normal | §3.4's window falloffs |
 * | `light` | `render/light-ramps.mjs` | `MIN_COLOR` | a light's zones (§7.0 step 6) |
 * | `halo` | `render/halo.mjs` | `MIN_COLOR` | ground boundaries, when the field blur is off |
 * | `clamp` | `render/paint.mjs` | `MAX_COLOR` | umbra and unseen ground |
 *
 * Two payload shapes, and the difference is which half is expensive. Spill carries a **distance**
 * per vertex and is mapped here, because its geometry costs a scene rebuild and its mapping is a
 * slider. The rest carry finished **levels**, because their geometry is cheap enough to redo
 * whenever they move.
 *
 * **No mesh here is ever blurred.** §6.4.4 blurs the whole container in one pass instead, and a
 * filter on a `MIN_COLOR` mesh is actively wrong besides: a blur fades the rim toward zero in
 * premultiplied colour, and zero in this channel is the brightest value there is.
 */

import { MODULE_ID } from "../constants.mjs";
import { containsPoint } from "../geometry.mjs";
import { stepTier } from "../model/tiers.mjs";
import * as spill from "../model/spill.mjs";
import { GRADIENT_SORT, classes } from "./darkness-shaders.mjs";
import * as lightRamps from "./light-ramps.mjs";
import { levelAtDistance, width as transitionWidth } from "./transition.mjs";
import { darknessFor } from "./levels.mjs";

/* -------------------------------------------- */
/*  The profile                                 */
/* -------------------------------------------- */

/**
 * The level at a distance out from §3.4's lit wedge.
 *
 * @remarks
 * A thin wrapper since §6.4.3: the ladder is turned into contiguous zones in **scene pixels** and
 * handed to the one profile every producer shares, so a spill band boundary fades over exactly the
 * same distance as a light's zone boundary or a room's edge.
 *
 * The wedge itself is the first zone and runs to `-Infinity`, which is what puts the transition
 * *centred* on its own boundary rather than starting there.
 *
 * @param {number} d - Distance out from the wedge, scene pixels
 * @param {number[]} levels - `levels[k]` is band `k`'s darkness level; `levels[0]` is the wedge
 * @param {number} band - Band width, scene pixels
 */
function levelAt(d, levels, band) {
  const zones = [{ r0: -Infinity, r1: 0, level: levels[0] }];
  for (let k = 1; k < levels.length; k++) {
    zones.push({ r0: (k - 1) * band, r1: k * band, level: levels[k] });
  }
  return levelAtDistance(d, zones);
}

/** `levels[k]` for one ramp — the tier ladder §3.4 walks down from the spill tier. */
function ladderFor(ramp) {
  const out = [];
  for (let k = 0; k <= ramp.steps; k++) out.push(darknessFor(stepTier(ramp.spillTier, -k)).level);
  return out;
}

/* -------------------------------------------- */
/*  Pool                                        */
/* -------------------------------------------- */

/** @type {object[]} */
const pool = [];
let used = 0;
let lastVersion = null;
let lastProfile = null;
let lastStats = null;

/**
 * Everything `RegionMesh` and the gradient shader read off a Region.
 *
 * @remarks
 * The same five properties `darkness-texture.regionStub` enumerates, and enumerated again rather
 * than shared for the reason that file gives: a missing one throws **inside PIXI's render loop**,
 * once per frame, blacking the canvas out instead of producing an attributable error. The only
 * difference is `testPoint`, which answers from the ramp's outline rather than from a cell's rings.
 */
function regionStub(entry) {
  const inside = (point) =>
    entry.active && containsPoint(entry.outline, { x: point.x, y: point.y });

  return {
    geometry: entry.geometry,
    bounds: entry.bounds,
    document: {
      testPoint: inside,
      polygonTree: { testPoint: inside },
      elevation: { bottom: -Infinity, top: Infinity },
    },
  };
}

function create(index) {
  const RegionMesh = foundry.canvas.placeables?.regions?.RegionMesh;
  const shaders = classes();
  const container = canvas.effects?.illumination?.darknessLevelMeshes;
  if (!RegionMesh || !shaders || !container) {
    console.error(`${MODULE_ID} | gradient: canvas is missing a required container.`);
    return null;
  }

  const geometry = new PIXI.Geometry();
  geometry.addAttribute("aVertexPosition", new PIXI.Buffer(new Float32Array(0), false, false), 2);
  // **The whole feature, in one line.** PIXI binds attributes to the shader by name, so a geometry
  // carrying this and a program declaring it need nothing else — `RegionMesh#_render` hands the
  // geometry straight to `renderer.geometry.bind(geometry, shader)`.
  geometry.addAttribute("aLevel", new PIXI.Buffer(new Float32Array(0), false, false), 1);
  geometry.addIndex(new PIXI.Buffer(new Uint32Array(0), false, true));
  geometry.refCount = 0;
  // Foundry's own `RegionGeometry` defines this and `_render` calls it unconditionally; PIXI does
  // not. Our buffers are uploaded by PIXI's dirty tracking, so it is a no-op.
  geometry._updateBuffers = () => {};

  const entry = {
    active: false,
    id: null,
    geometry,
    bounds: new PIXI.Rectangle(),
    outline: [],
    vertices: 0,
    triangles: 0,
    blur: null,
    /** `"light"`, `"clamp"`, or undefined for a §3.4 ground ramp. */
    kind: undefined,
  };
  entry.stub = regionStub(entry);
  entry.mesh = new RegionMesh(entry.stub, shaders.gradient);
  entry.mesh.name = `${MODULE_ID}.gradient.${index}`;
  entry.mesh.visible = false;

  container.addChild(entry.mesh);
  pool.push(entry);
  return entry;
}

/**
 * Attach or detach the mesh's anti-aliasing blur.
 *
 * @remarks
 * **No mesh here is blurred at all.** Every wide-blur setting this file replaced
 * existed to fake the gradient the mesh now draws; what is left for a filter to do is the same job
 * it does on every other ground mesh — take the aliasing off the silhouette, which here is the
 * wedge's flanks and wherever a wall cut it. The falloff *inside* the mesh is not a boundary any
 * more and there is nothing there for a blur to soften.
 */
function syncFilter(entry) {
  // **No ramp mesh is ever blurred, since §6.4.3.** Every one of them already carries its own
  // transition as a per-vertex ramp, so a filter on top would be a second, differently-shaped
  // softening of the same edge — which is exactly the piecemeal look this replaced. It is also
  // unsafe on a blended mesh: a blur fades the rim toward zero in premultiplied colour, and zero
  // in this channel is the brightest value there is, so `MIN` would ring every light in white.
  const mesh = entry.mesh;
  if (mesh && !mesh._destroyed && mesh.filters?.length) mesh.filters = null;
}

function dropFilter(entry) {
  if (!entry?.blur) return;
  canvas?.blurFilters?.delete(entry.blur);
  if (entry.mesh && !entry.mesh._destroyed) entry.mesh.filters = null;
  try {
    entry.blur.destroy();
  } catch {
    /* already gone with the renderer */
  }
  entry.blur = null;
}

function park(entry) {
  entry.active = false;
  entry.id = null;
  entry.kind = undefined;
  entry.outline = [];
  entry.mesh.visible = false;
}

/**
 * Put a ramp's levels into the attribute buffer.
 *
 * @remarks
 * **Two payload shapes, and the difference is which half is expensive.** §3.4's ramp carries a
 * *distance* per vertex and is mapped here, because its geometry costs a scene rebuild and its
 * mapping is a slider — so a slider must not move a vertex. A §7.0 step 6 light carries finished
 * *levels*, because its geometry is arithmetic that gets redone whenever the light moves anyway,
 * and keeping the mapping separate would buy nothing.
 */
function uploadLevels(entry, ramp) {
  if (ramp.levels) {
    entry.geometry.getBuffer("aLevel").update(ramp.levels);
    entry.mesh.shader.nominal = ramp.nominal ?? ramp.levels[0] ?? 0;
    entry.mesh.shader.sortLevel = ramp.sortLevel ?? GRADIENT_SORT;
    return;
  }

  const levels = ladderFor(ramp);
  const band = ramp.band || 1;
  const dists = ramp.dists;
  const out = new Float32Array(dists.length);
  for (let i = 0; i < dists.length; i++) out[i] = levelAt(dists[i], levels, band);
  entry.geometry.getBuffer("aLevel").update(out);

  // What `getDarknessLevel` reports for a point inside this mesh. There is no single honest answer
  // over a gradient — see the note on the shader — so it is the ladder's midpoint, and the API's
  // approximation is documented rather than papered over.
  entry.mesh.shader.nominal = levels[Math.floor(levels.length / 2)] ?? levels[0];
  // Brighter ramps sort later and so win where two windows light the same floor, which is §3.4's
  // `AT_LEAST` rule as nearly as a draw order can express it.
  entry.mesh.shader.sortLevel = GRADIENT_SORT + levels[0];
}

function apply(entry, ramp) {
  entry.active = true;
  entry.id = ramp.id;
  // Assigned unconditionally, like every other per-entry flag — this project's recurring pooling
  // bug is a reused entry keeping the treatment of the thing it used to be.
  entry.kind = ramp.kind;
  entry.outline = ramp.outline ?? [];
  entry.vertices = ramp.vertices.length / 2;
  entry.triangles = ramp.triangles;

  entry.geometry.getBuffer("aVertexPosition").update(ramp.vertices);
  entry.geometry.getIndex().update(ramp.indices);
  uploadLevels(entry, ramp);

  entry.bounds.copyFrom(ramp.bounds);
  // `_calculateBounds` reads `region.bounds`, which PIXI has no way to know just changed.
  entry.mesh._boundsID++;

  // **The blend mode is the architecture** (§7.0 step 6). A ground ramp overwrites; a light
  // blends `MIN_COLOR`, so brightest wins per fragment; a clamp blends `MAX_COLOR`, so darkest
  // does. Together with the sort ladder in `render/darkness-shaders.mjs` that is the whole
  // composition rule, and none of it involves cutting one region out of another.
  const blend = ramp.blendMode ? PIXI.BLEND_MODES[ramp.blendMode] : PIXI.BLEND_MODES.NORMAL;
  entry.mesh.blendMode = blend ?? PIXI.BLEND_MODES.NORMAL;

  syncFilter(entry);
  entry.mesh.visible = true;
}

/* -------------------------------------------- */
/*  Public API                                  */
/* -------------------------------------------- */

/** Have the containers been replaced under us? Same reasoning as `darkness-texture.stale`. */
function stale() {
  const first = pool[0];
  if (!first) return false;
  return (
    first.mesh._destroyed === true ||
    first.mesh.parent !== canvas.effects?.illumination?.darknessLevelMeshes
  );
}

/**
 * Is a §3.4 **spill** falloff currently drawn as a gradient?
 *
 * @remarks
 * `darkness-texture.paint` asks before it skips a spill cell: with no gradient mesh on the map,
 * the flat bands are all there is and skipping them would leave the spill unpainted.
 *
 * **Narrowed to spill entries when §7.0 step 6 landed.** A count of drawn meshes was the same
 * question while spill was the only producer; it stopped being one the moment lights and clamps
 * joined the pool, and the failure would have been silent — a scene with torches and no windows
 * would have reported "yes" and skipped bands that nothing was drawing.
 */
export const isActive = () => pool.some((entry) => entry.active && !entry.kind);

/**
 * Bring the gradient meshes into line with `spill.ramps()`.
 *
 * @remarks
 * Gated on `spill.version()` and on the profile, so the common repaint — an observer moving —
 * costs two comparisons. That gate is the point of the whole design: the shadow clamp is applied
 * by *overpainting* rather than by cutting this geometry, so nothing here has to move when a token
 * does.
 *
 * @param {object} [options]
 * @param {boolean} [options.force]
 * @returns {number} How many ramps are drawn
 */
export function sync(extra = [], { force = false } = {}) {
  if (!canvas?.ready) return 0;

  if (stale()) {
    for (const entry of pool) dropFilter(entry);
    pool.length = 0;
    used = 0;
    lastVersion = null;
  }

  // §3.4's window falloffs, plus whatever the caller assembled — §7.0 step 6's light and clamp
  // meshes. They are passed in rather than pulled from here because they depend on the *cells*,
  // and cells belong to `render/paint.mjs`; reaching back for them would make this file depend on
  // the pass that calls it.
  const ramps = [...(spill.isEnabled() ? spill.ramps() : []), ...extra];

  // **Only the cached half is gated.** `spill.ramps()` is a pure cache read keyed on
  // `spill.version()`, so it can be skipped; `extra` is rebuilt by its caller every time and the
  // caller is itself gated on the field and the point of view (`paint.repaint`). Gating on the
  // spill version alone here would drop light meshes on the floor whenever a token moved without
  // a window changing, which is every token move.
  const profile = `${transitionWidth()}|${spill.ramps().length ? ladderFor(spill.ramps()[0]).join(",") : ""}`;
  if (!force && !extra.length && lastVersion === spill.version() && lastProfile === profile) {
    return used;
  }
  lastVersion = spill.version();
  lastProfile = profile;

  const t0 = performance.now();

  let index = 0;
  for (const ramp of ramps) {
    const entry = pool[index] ?? create(index);
    if (!entry) break;
    apply(entry, ramp);
    index++;
  }
  for (let i = index; i < pool.length; i++) park(pool[i]);
  used = index;

  lastStats = {
    ramps: used,
    // The three kinds, so a missing pass is visible without reading the map. `lights: 0` with
    // torches on the scene means §7.0 step 6 is off or every light collapsed to its ground tier;
    // `clamps: 0` with an observer looking through a wall means the fog guard is not running.
    spill: pool.filter((e) => e.active && !e.kind).length,
    lights: pool.filter((e) => e.active && e.kind === "light").length,
    clamps: pool.filter((e) => e.active && e.kind === "clamp").length,
    pooled: pool.length,
    vertices: pool.reduce((n, e) => n + (e.active ? e.vertices : 0), 0),
    triangles: pool.reduce((n, e) => n + (e.active ? e.triangles : 0), 0),
    transitionWidth: transitionWidth(),
    // §7.0 step 6's cache. `builds` staying flat while a token is dragged is the whole reason a
    // light's grid is affordable to rebuild at all — see `light-ramps.cacheKey`.
    light: lightRamps.stats(),
    ms: Math.round((performance.now() - t0) * 100) / 100,
  };
  return used;
}

/**
 * Re-map every drawn ramp's levels without touching its geometry.
 *
 * Wired to the plateau setting and to the tier table, both of which change *what a distance means*
 * and neither of which moves a vertex.
 */
export function remap() {
  if (!canvas?.ready || !used) return 0;
  const ramps = spill.ramps();
  let touched = 0;
  for (const ramp of ramps) {
    const entry = pool.find((e) => e.active && e.id === ramp.id);
    if (!entry) continue;
    uploadLevels(entry, ramp);
    touched++;
  }
  return touched;
}

/** Re-sync every filter — the ground-softening setting's `onChange` reaches this too. */
export function refreshFilters() {
  let touched = 0;
  for (const entry of pool) {
    if (entry.mesh?._destroyed) continue;
    syncFilter(entry);
    touched++;
  }
  return touched;
}

/** Park every mesh. */
export function clear() {
  if (!used && !pool.length) return;
  for (const entry of pool) park(entry);
  used = 0;
  lastVersion = null;
  lastProfile = null;
}

function refresh() {
  canvas?.effects?.illumination?.invalidateDarknessLevelContainer(true);
}

/** Destroy every mesh. Scene teardown only — same guards as `darkness-texture.dispose`. */
export function dispose() {
  for (const entry of pool) {
    dropFilter(entry);
    if (!entry.mesh || entry.mesh._destroyed) continue;
    try {
      entry.mesh.destroy();
    } catch {
      /* the container went first */
    }
  }
  pool.length = 0;
  used = 0;
  lastVersion = null;
  lastProfile = null;
}

/**
 * Debug readout.
 *
 * @remarks
 * `ramps` above zero with `triangles` at zero is the state worth naming: the meshes exist and
 * claim ground they never paint, which is what a failed triangulation looks like from every other
 * angle. `sampled` is the texture read back at the cursor, which is the only number here that
 * proves a shader ran — see `darkness-texture.meshAt` on why the two can disagree.
 */
export function stats() {
  const report = {
    enabled: spill.isEnabled(),
    ...(lastStats ?? { note: "no sync has run" }),
    // The sort ladder, as it actually reached the meshes. Anything here at or below a flat mesh's
    // level would be painted over by ordinary ground — see `render/darkness-shaders.mjs`.
    sortLevels: pool.filter((e) => e.active).map((e) => +e.mesh.shader.sortLevel.toFixed(3)),
    blurred: pool.filter((e) => e.active && e.mesh?.filters?.length).length,
    dlChildren: canvas?.effects?.illumination?.darknessLevelMeshes?.children?.length ?? null,
  };
  console.error(`${MODULE_ID} | spill gradient`, report);
  return report;
}
