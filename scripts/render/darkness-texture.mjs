/**
 * Painting the model's tiers into Foundry's **darkness-level texture**. DESIGN.md §7.0.
 *
 * The renderer's other half expresses "this area is Dim" by synthesising a *light source* — an
 * object with an origin, a falloff, a wall sweep, a darkness band and a dozen uniforms — where
 * what the model actually has is a number. Every seam bug of 2026-08-23 was a property of
 * `GlobalLightSource` that a stand-in had failed to clone.
 *
 * Foundry has exactly one channel shaped like *"here is my computed field, please render it"*:
 * `canvas.effects.illumination.darknessLevelMeshes`, a cached container rendered to a texture
 * and handed to every lighting **and vision** shader as `darknessLevelTexture`. That second
 * word is the whole reason this file exists. A region written here keeps its brightness
 * *through* a vision source's paint, so god's eye, *true seeing* and see-in-darkness all still
 * show the map's light levels instead of flattening them — which a light fill structurally
 * cannot do, because `vision.sight` is not gated by `light.mask` and revealing is the same act
 * as brightening (§4.5.1).
 *
 * ## Two meshes per region, and they answer different questions
 *
 * Core's own "Adjust Darkness Level" behaviour makes a pair, and so do we
 * (`data/region-behaviors/adjust-darkness-level.mjs:68-85`):
 *
 * | Mesh | Container | Question |
 * | --- | --- | --- |
 * | `AdjustDarknessLevelRegionShader` | `illumination.darknessLevelMeshes` | how **bright** is this ground |
 * | `IlluminationDarknessLevelRegionShader` | `visibility.vision.light.global.meshes` | does global light **reveal** it |
 *
 * The second is only created where the answer is *no*. `#refreshDynamicIllumination`
 * (`groups/visibility.mjs:643-651`) walks that container and flips a mesh to `ERASE` when its
 * darkness level falls outside the global light's band — so a mesh there cuts the region out of
 * what global illumination lets a creature see, which is exactly what a *darkness* should do to
 * a normal-sighted observer, while darkvision (which comes from `vision.sight`) is untouched.
 *
 * ## Overlap is not allowed, and the container enforces the opposite of what you'd guess
 *
 * `invalidateDarknessLevelContainer` sorts both containers by darkness level **descending**, so
 * where meshes overlap the *lowest* level wins — the brightest, not the darkest
 * (`illumination-effects.mjs:106-110`). Our cells partition space by treatment (§6.1), so this
 * never bites; but it means a region painted over a scene-wide ambient mesh would be **erased
 * by it**, not layered on top. Hence one mesh per cell and no base layer.
 *
 * The texture is cleared to `canvas.environment.darknessLevel`, so anywhere we paint nothing
 * keeps the scene's own value.
 *
 * ## Duck-typing a Region
 *
 * `RegionMesh` wants a Region placeable and we have bare polygons. It reads five things, and a
 * missing one throws **inside PIXI's render loop** — once per frame, blacking the canvas out
 * rather than producing an attributable error. They are enumerated in {@link regionStub} rather
 * than discovered, after two were found one crash at a time during the spike.
 */

import { MODULE_ID } from "../constants.mjs";
import { containsPoint } from "../geometry.mjs";
import { darknessFor } from "./levels.mjs";

/**
 * `AdjustDarknessLevelRegionBehaviorType.MODES.OVERRIDE` — the level *is* the number, rather
 * than a modifier on the scene's. The model has already resolved what the ground should be.
 */
const MODE_OVERRIDE = 0;

/**
 * The modifier given to an erasing illumination mesh.
 *
 * @remarks
 * Core expresses "this region is not lit by global light" as *outside the global light's
 * darkness band* (`visibility.mjs:646`), and going through its own test is what also sets
 * `#needsContainment` — a private field that enables the fence filter keeping an `ERASE` blend
 * inside the container. Setting `blendMode` by hand would skip that.
 *
 * `-1` is below **every** possible band because `darkness.min` is an `AlphaField` and so is
 * never negative (`common/data/data.mjs:64`). The upper bound is not usable for this: its
 * default is 1 and nothing exceeds it.
 *
 * This value only ever reaches the band comparison. The erasing shader's fragment program
 * writes `vec4(1.0)` and never reads the level, and the *brightness* of the region is carried
 * by the other mesh of the pair.
 */
const ERASE_MODIFIER = -1;

/**
 * Modifier for a parked illumination mesh.
 *
 * @remarks
 * Zero rather than {@link ERASE_MODIFIER} because `#refreshDynamicIllumination` walks *every*
 * child of the container, visible or not, and a parked mesh left out of band would keep setting
 * `#needsContainment` and so keep the fence filter on for nothing. Zero is inside the default
 * band; a GM who has raised `darkness.min` above it costs a redundant filter and nothing more,
 * since a parked mesh does not draw.
 */
const PARKED_MODIFIER = 0;

/** Pool of mesh pairs, reused across rebuilds. @type {object[]} */
const pool = [];
let used = 0;

/* -------------------------------------------- */
/*  Geometry                                    */
/* -------------------------------------------- */

/**
 * Everything `RegionMesh` and its shaders read off a Region, enumerated in one place.
 *
 * @remarks
 * Listed rather than discovered. A stub that satisfies the constructor but not a later reader
 * throws inside the render loop, so "add the next missing property when it crashes" costs a
 * canvas blackout and a reload per property.
 *
 * | Property | Read by |
 * | --- | --- |
 * | `geometry` | ctor `refCount`, `_render` bind (`regions/mesh.mjs:22`, `:180`, `:213`) |
 * | `bounds` | `_calculateBounds` (`:192`) |
 * | `document.elevation` | `AbstractDarknessLevelRegionShader#_preRender` (`adjust-darkness-level.mjs:57`) |
 * | `document.polygonTree` | `containsPoint` (`:204`) |
 * | `document.testPoint` | `EffectsCanvasGroup#getDarknessLevel` (`effects.mjs:394`) |
 *
 * The two `testPoint`s answer `false` while the entry is parked, so
 * `canvas.effects.getDarknessLevel()` never reports a level from a mesh that is not drawing.
 */
function regionStub(entry) {
  // Even-odd across outer and holes together, not "inside the outer ring". A point in an
  // ambient cell's hole is inside a *darkness*, and answering `true` there would make
  // `canvas.effects.getDarknessLevel()` report the ambient level over a darkness — the exact
  // inversion, and in the one place a caller has no way to notice.
  const inside = (point) =>
    entry.active && containsPoint(entry.rings, { x: point.x, y: point.y });

  return {
    geometry: entry.geometry,
    bounds: entry.bounds,
    document: {
      testPoint: inside,
      polygonTree: { testPoint: inside },

      // **Required, and its absence throws once per frame.** `_preRender` destructures it
      // unguarded. Unbounded is safe: `mapElevation` binary-searches a sorted table and
      // returns 0 below its first entry (`masks/depth.mjs:55-57`), converging to the extremes.
      elevation: { bottom: -Infinity, top: Infinity },
    },
  };
}

/**
 * Triangulate a cell into the buffers `RegionGeometry` exposes, updating them in place.
 *
 * @remarks
 * **Holes are the point.** `PIXI.utils.earcut(vertices, holeIndices, 2)` takes them natively,
 * which is what lets an `ambient` cell stay a single mesh — "the scene, less every darkness on
 * it" is one outer ring with N holes, and that shape is the entire reason §6.2.1's annulus
 * splitting existed. A mesh does not need it; a light source did. Every full-width horizontal
 * artefact of 2026-08-23 came from those cuts, so removing them is the fix rather than making
 * the seams meet better.
 *
 * Clipper already emits holes with the opposite winding to their outer, which is what earcut
 * wants, so the rings pass through untouched.
 *
 * Buffers are updated rather than replaced so the pool never churns GPU allocations. PIXI
 * re-uploads on `Buffer#update` and grows the underlying store when the data outgrows it
 * (`GeometrySystem#updateBuffers`), so a cell changing vertex count needs nothing special.
 */
function setGeometry(entry, outer, holes) {
  let points = outer.points;
  let holeIndices = null;

  if (holes?.length) {
    points = Array.from(outer.points);
    holeIndices = [];
    for (const hole of holes) {
      if (!(hole?.points?.length >= 6)) continue;
      holeIndices.push(points.length / 2);
      for (const value of hole.points) points.push(value);
    }
    if (!holeIndices.length) holeIndices = null;
  }

  const indices = PIXI.utils.earcut(points, holeIndices, 2);

  entry.vertices = points.length / 2;
  entry.triangles = indices.length / 3;
  entry.holes = holeIndices?.length ?? 0;

  entry.geometry.getBuffer("aVertexPosition").update(new Float32Array(points));
  // Uint32 unconditionally: v13 requires WebGL2, where 32-bit indices are core, and a buffer
  // that changed integer width between rebuilds would need the geometry rebound.
  entry.geometry.getIndex().update(new Uint32Array(indices));

  entry.bounds.copyFrom(outer.getBounds());
  // `_calculateBounds` reads `region.bounds`, which PIXI has no way to know just changed.
  entry.dl._boundsID++;
  entry.il._boundsID++;
}

/* -------------------------------------------- */
/*  Pool                                        */
/* -------------------------------------------- */

function meshClass() {
  const regions = foundry.canvas.placeables?.regions ?? foundry.canvas.regions;
  return regions?.RegionMesh ?? null;
}

/**
 * Build one mesh pair and attach it to both containers.
 *
 * @returns {object|null} The pool entry, or `null` if the canvas cannot host it
 */
function create(index) {
  const RegionMesh = meshClass();
  const shaders = foundry.canvas.rendering?.shaders;
  const dlContainer = canvas.effects?.illumination?.darknessLevelMeshes;
  const ilContainer = canvas.visibility?.vision?.light?.global?.meshes;
  if (!RegionMesh || !shaders || !dlContainer || !ilContainer) {
    console.error(`${MODULE_ID} | darkness texture: canvas is missing a required container.`);
    return null;
  }

  const geometry = new PIXI.Geometry();
  geometry.addAttribute(
    "aVertexPosition",
    new PIXI.Buffer(new Float32Array(0), false, false),
    2
  );
  geometry.addIndex(new PIXI.Buffer(new Uint32Array(0), false, true));
  // `RegionMesh` manages this and disposes the geometry when it reaches zero.
  geometry.refCount = 0;
  // Foundry's own `RegionGeometry` defines this; PIXI does not, and `_render` calls it
  // unconditionally. Our buffers are uploaded by PIXI's own dirty tracking, so it is a no-op.
  geometry._updateBuffers = () => {};

  const entry = {
    active: false,
    // Outer first, then holes — the argument order `containsPoint` wants and the order the
    // geometry was built in.
    rings: [],
    level: null,
    erase: false,
    vertices: 0,
    triangles: 0,
    holes: 0,
    geometry,
    bounds: new PIXI.Rectangle(),
  };
  entry.stub = regionStub(entry);

  entry.dl = new RegionMesh(entry.stub, shaders.AdjustDarknessLevelRegionShader);
  entry.il = new RegionMesh(entry.stub, shaders.IlluminationDarknessLevelRegionShader);
  entry.dl.name = `${MODULE_ID}.dl.${index}`;
  entry.il.name = `${MODULE_ID}.il.${index}`;
  for (const mesh of [entry.dl, entry.il]) {
    mesh.shader.mode = MODE_OVERRIDE;
    mesh.visible = false;
  }
  // No blur filter, unlike core's behaviour: §6.2 wants suppressor edges sharp, and a blurred
  // boundary would put a gradient across the one thing the model is asserting a step in.

  dlContainer.addChild(entry.dl);
  ilContainer.addChild(entry.il);
  pool.push(entry);
  return entry;
}

function take(index) {
  return pool[index] ?? create(index);
}

/**
 * Has the canvas replaced the containers under us?
 *
 * @remarks
 * The layers are rebuilt on every scene draw, so a pool held across one points at meshes that
 * were destroyed with their parent. `canvasTearDown` normally clears it first, but hook order
 * is not ours to guarantee and the failure is silent — a full pool of dead meshes paints
 * nothing and reports itself healthy. Checking the first entry is enough: they are all attached
 * and detached together.
 */
function stale() {
  const first = pool[0];
  if (!first) return false;
  return (
    first.dl._destroyed === true ||
    first.dl.parent !== canvas.effects?.illumination?.darknessLevelMeshes
  );
}

/** Stop an entry contributing, without giving up its allocation. */
function park(entry) {
  entry.active = false;
  entry.rings = [];
  entry.level = null;
  entry.erase = false;
  entry.dl.visible = false;
  entry.il.visible = false;
  // Invisible is not enough on its own — see {@link PARKED_MODIFIER}.
  entry.il.shader.modifier = PARKED_MODIFIER;
}

/**
 * Debug switch: paint brightness but never cut global illumination's reveal.
 *
 * @remarks
 * An A/B for one specific confusion, added 2026-08-23. Every region painted darker than Dim
 * gets a **second** mesh in the visibility mask, blended `ERASE`, which removes it from what
 * global light reveals (`groups/visibility.mjs:643-651`). That boundary is binary and lives in
 * a different container from the brightness — so the §6.4.1 blur cannot touch it, and a
 * *darkness* disc can keep a hard rim while every other transition on the map is soft.
 *
 * The distinguishing experiment, because the two candidate causes need opposite fixes: turn the
 * erase off and see whether the disc softens. If it does, the reveal boundary is the culprit.
 * If it does not, the blur is not reaching the texture at all.
 *
 * Not a setting — with this on, a *darkness* on a globally-lit map stops being dark, which is
 * the whole thing §7.0 exists to fix.
 */
let eraseDisabled = false;

/** @param {boolean} disabled @returns {boolean} The flag now in force */
export function setEraseDisabled(disabled) {
  eraseDisabled = !!disabled;
  return eraseDisabled;
}

export const isEraseDisabled = () => eraseDisabled;

function apply(entry, outer, holes, level, erase) {
  if (eraseDisabled) erase = false;
  entry.active = true;
  entry.rings = holes?.length ? [outer, ...holes] : [outer];
  entry.level = level;
  entry.erase = erase;

  setGeometry(entry, outer, holes);

  entry.dl.visible = true;
  entry.dl.shader.modifier = level;
  // `getDarknessLevel` reads the *uniform*, which `_preRender` only writes when the mesh is
  // drawn (`effects.mjs:395`). Setting it here keeps a point query correct on the same tick
  // the cell was painted, rather than one frame behind.
  entry.dl.shader.uniforms.darknessLevel = level;

  entry.il.visible = erase;
  entry.il.shader.modifier = erase ? ERASE_MODIFIER : PARKED_MODIFIER;
}

/* -------------------------------------------- */
/*  Public API                                  */
/* -------------------------------------------- */

/**
 * Paint a set of cells, replacing whatever was painted before.
 *
 * @param {{polygon: PIXI.Polygon, holes?: PIXI.Polygon[], tier: number}[]} cells
 * @returns {number} How many cells were painted
 */
export function paint(cells) {
  if (!canvas?.ready) return 0;
  if (stale()) {
    pool.length = 0;
    used = 0;
  }

  let index = 0;
  for (const cell of cells) {
    const polygon = cell.polygon;
    // A ring needs three points to enclose anything; earcut on fewer yields no triangles and
    // a mesh that silently draws nothing.
    if (!(polygon?.points?.length >= 6)) continue;
    const entry = take(index);
    if (!entry) break;
    const { level, erase } = darknessFor(cell.tier);
    apply(entry, polygon, cell.holes, level, erase);
    index++;
  }

  for (let i = index; i < pool.length; i++) park(pool[i]);
  used = index;

  refresh();
  return used;
}

/** Park every mesh, handing the scene back to its own darkness level. */
export function clear() {
  if (!used && !pool.length) return;
  for (const entry of pool) park(entry);
  used = 0;
  refresh();
}

/**
 * Ask the container to re-render and re-sort.
 *
 * @remarks
 * `force`, because `hasDynamicDarknessLevel` is a child *count* and our children are pooled —
 * they stay attached while parked, so the count never reaches zero and never proves anything
 * either way. It also marks the vision mask dirty when global light is active, which is what
 * carries an `ERASE` change through.
 *
 * Deliberately **not** a `canvas.perception.update` call: the renderer makes exactly one at the
 * end of its rebuild, and adding a second here is how the last cycle of self-triggering
 * rebuilds started (see `renderer.rebuild`).
 */
function refresh() {
  canvas.effects?.illumination?.invalidateDarknessLevelContainer(true);
}

/**
 * Destroy every mesh. Scene teardown only.
 *
 * @remarks
 * Guarded, because the containers these live in belong to the canvas layers and are rebuilt on
 * every scene change — so by the time this runs the meshes may already have been destroyed
 * from underneath us. Dropping our references is the part that has to happen; the `destroy()`
 * is a courtesy to the GPU buffers when we get there first.
 */
export function dispose() {
  for (const entry of pool) {
    for (const mesh of [entry.dl, entry.il]) {
      if (!mesh || mesh._destroyed) continue;
      try {
        mesh.destroy();
      } catch {
        /* the container went first */
      }
    }
  }
  pool.length = 0;
  used = 0;
}

/**
 * Which pooled mesh claims a point, and what the **rendered texture** actually says there.
 *
 * @remarks
 * **`canvas.effects.getDarknessLevel` and the shader do not read the same thing**, and that gap
 * is where a whole class of bug hides. The JS query walks our meshes calling
 * `region.document.testPoint` — a ring test on the *polygon* — and returns a shader uniform.
 * Every shader that cares samples `texture2D(darknessLevelTexture, …)`, which is the polygon
 * **after earcut, rasterisation and the container's sort**. A mesh whose geometry failed to
 * triangulate, or that never rendered, answers the first and not the second.
 *
 * Worth having because the difference is invisible from every other angle: the model is right,
 * the cell is right, the point query is right, and the screen is wrong.
 *
 * `pixel` costs a GPU→CPU readback, so this is a console tool and nothing else may call it.
 *
 * @param {number} [x]
 * @param {number} [y]
 */
export function meshAt(x, y) {
  if (!canvas?.ready) return null;
  const point = x === undefined ? canvas.mousePosition : { x, y };

  const claims = pool
    .filter((entry) => entry.active && containsPoint(entry.rings, point))
    .map((entry) => ({
      name: entry.dl.name,
      level: entry.level,
      erase: entry.erase,
      rings: entry.rings.length,
      holes: entry.holes,
      vertices: entry.vertices,
      // Zero here with the point inside the polygon is the failure this readout exists for:
      // earcut produced nothing, so the mesh claims ground it never paints.
      triangles: entry.triangles,
      visible: entry.dl.visible,
      inBounds: entry.bounds.contains(point.x, point.y),
    }));

  let pixel = null;
  try {
    const texture = canvas.effects.illumination.renderTexture;
    const screen = canvas.stage.worldTransform.apply({ x: point.x, y: point.y });
    const frame = new PIXI.Rectangle(Math.round(screen.x), Math.round(screen.y), 1, 1);
    pixel = canvas.app.renderer.extract.pixels(texture, frame)?.[0] / 255;
  } catch (error) {
    console.error(`${MODULE_ID} | texture readback failed`, error);
  }

  const report = {
    point: { x: Math.round(point.x), y: Math.round(point.y) },
    // What the meshes claim.
    claims,
    // What the JS query answers — `effects.mjs:391-396`.
    queried: canvas.effects.getDarknessLevel({ x: point.x, y: point.y, elevation: 0 }),
    // **What the shaders actually sample.** Disagreeing with `queried` is the finding.
    pixel,
    sceneDarkness: canvas.environment?.darknessLevel ?? null,
  };
  console.error(`${MODULE_ID} | mesh at`, report);
  return report;
}

/**
 * Debug readout.
 *
 * @remarks
 * Reports the *sample* alongside the pool because "the mesh exists" and "the texture carries
 * its value" are different claims, and only the second one is what any shader sees.
 */
export function status(x, y) {
  const point =
    x === undefined ? (canvas?.mousePosition ?? { x: 0, y: 0 }) : { x, y };

  const report = {
    painted: used,
    pooled: pool.length,
    erasing: pool.filter((e) => e.active && e.erase).length,
    levels: pool.filter((e) => e.active).map((e) => e.level),
    // Above zero is the observable proof that the ambient complement is one mesh rather than
    // a stack of full-width strips — the difference §6.2.1's splitting used to force.
    holes: pool.reduce((sum, e) => sum + (e.active ? e.holes : 0), 0),
    triangles: pool.reduce((sum, e) => sum + (e.active ? e.triangles : 0), 0),
    dlChildren: canvas?.effects?.illumination?.darknessLevelMeshes?.children?.length ?? null,
    ilChildren: canvas?.visibility?.vision?.light?.global?.meshes?.children?.length ?? null,
    sceneDarkness: canvas?.environment?.darknessLevel ?? null,
    // What Foundry itself reports at the point — the read-back that proves the texture took.
    sampled: canvas?.ready
      ? canvas.effects.getDarknessLevel({ x: point.x, y: point.y, elevation: 0 })
      : null,
  };
  console.error(`${MODULE_ID} | darkness texture`, report);
  return report;
}
