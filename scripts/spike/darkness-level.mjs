/**
 * Spike: can the **darkness-level texture** carry our five tiers? DESIGN.md §7.0.
 *
 * The renderer currently expresses "this area is Dim" by synthesising a *light source*, which
 * is an object with an origin, a falloff, a wall sweep, a darkness band and a dozen uniforms —
 * where what we actually have is a number. Every seam bug in §7.0 was a property of
 * `GlobalLightSource` that a stand-in had not cloned.
 *
 * Foundry has exactly one channel shaped like "here is my computed field, please render it":
 * `canvas.effects.illumination.darknessLevelMeshes`, a cached container rendered to a texture
 * that **every** lighting and vision shader samples per fragment
 * (`base-lighting.mjs` `COMPUTE_ILLUMINATION`). Because the *vision* shaders sample it too, a
 * region written there keeps its brightness through a vision source's paint — which is the one
 * property Patrick's requirement needs and no light fill has.
 *
 * ## What this spike answers, and what it does not
 *
 * It answers one question: **do five distinct tiers land visibly distinctly on a `[0,1]`
 * scalar, on a real scene?** Darkness level is not the inverse of brightness — it feeds
 * `mix(ambientDaylight, ambientDarkness, level)` and then the scene's `weights` decide what
 * dim and bright mean relative to that — so the mapping is an empirical question, not an
 * algebraic one.
 *
 * It does not attempt tiers, cells, or any integration. If the bands are not distinguishable
 * the whole approach dies here, cheaply.
 *
 * ## How core does it, and the one thing we cannot reuse
 *
 * `AdjustDarknessLevelRegionBehaviorType` creates **two** meshes per region
 * (`adjust-darkness-level.mjs:68-85`): one with `AdjustDarknessLevelRegionShader` into
 * `illumination.darknessLevelMeshes`, and one with `IlluminationDarknessLevelRegionShader`
 * into `visibility.vision.light.global.meshes`. Both need `shader.mode` and `shader.modifier`.
 * Both are needed: the first writes the texture, the second keeps global illumination
 * consistent with it.
 *
 * `RegionMesh` wants a **Region placeable**, and we have bare polygons. But it only ever
 * touches `region.geometry` — `refCount`, `_updateBuffers()`, and binding
 * (`regions/mesh.mjs:22`, `:180-185`) — so a duck-typed stub carrying a `PIXI.Geometry` with
 * an `aVertexPosition` attribute is sufficient. `EffectsCanvasGroup#getDarknessLevel` also
 * calls `mesh.region.document.testPoint` (`effects.mjs:394`), so the stub carries that too or
 * it throws for every caller, not just ours.
 */

import { MODULE_ID } from "../constants.mjs";

/** Meshes this spike owns, by id, so it can clean up after itself. */
const drawn = new Map();

/**
 * Triangulate a polygon into the buffers `RegionGeometry` exposes.
 *
 * @remarks
 * `PIXI.utils.earcut` is what PIXI's own graphics path uses, and a convex-fan would be wrong
 * for the concave cells the real thing would eventually feed in.
 */
function geometryOf(polygon) {
  const points = Array.from(polygon.points ?? polygon);
  const indices = PIXI.utils.earcut(points, null, 2);

  const geometry = new PIXI.Geometry();
  geometry.addAttribute("aVertexPosition", new PIXI.Buffer(new Float32Array(points), true, false), 2);
  geometry.addIndex(new PIXI.Buffer(new Uint16Array(indices), true, true));
  // `RegionMesh` manages this and disposes the geometry when it hits zero.
  geometry.refCount = 0;
  // Called before every bind; our buffers are static, so there is nothing to update.
  geometry._updateBuffers = () => {};
  return geometry;
}

/**
 * Everything `RegionMesh` and its shaders read off a Region, enumerated in one place.
 *
 * @remarks
 * Listed rather than discovered, after finding two of them one crash at a time. A stub that
 * satisfies the constructor but not a later reader throws **inside PIXI's render loop**, once
 * per frame, which blacks the canvas out instead of producing an attributable error — so
 * "add the next missing property when it crashes" is an unusually expensive loop here.
 *
 * | Property | Read by |
 * | --- | --- |
 * | `geometry` | ctor `refCount`, `_render` bind (`regions/mesh.mjs:22`, `:180`, `:213`) |
 * | `bounds` | `_calculateBounds` (`:192`) |
 * | `document.elevation` | `AbstractDarknessLevelRegionShader#_preRender` |
 * | `document.polygonTree` | `containsPoint` (`:204`) |
 * | `document.testPoint` | `EffectsCanvasGroup#getDarknessLevel` (`effects.mjs:394`) |
 */
function regionStub(polygon, geometry) {
  const bounds = polygon.getBounds();

  return {
    geometry,

    // `_calculateBounds` destructures `{left, top, right, bottom}` (`regions/mesh.mjs:192`).
    // A `PIXI.Rectangle` has all four as getters, so its own bounds serve directly.
    bounds,

    document: {
      // `getDarknessLevel` walks every mesh calling this. Answering honestly keeps
      // `canvas.effects.getDarknessLevel(point)` correct over our regions as well as core's.
      testPoint: (point) => polygon.contains(point.x, point.y),

      // **Required, and its absence throws inside the render loop.**
      // `AbstractDarknessLevelRegionShader#_preRender` destructures it unguarded
      // (`region/adjust-darkness-level.mjs:57`), so a stub without it throws once per frame
      // and blacks out the canvas rather than failing at construction.
      //
      // Unbounded is safe: `mapElevation` binary-searches a sorted table and returns 0 below
      // its first entry (`masks/depth.mjs:55-57`), converging to the top for +Infinity.
      elevation: { bottom: -Infinity, top: Infinity },

      // `RegionMesh#containsPoint` (`regions/mesh.mjs:204`). Not on the render path, but a
      // hit test on a container that is a child of the canvas will reach it eventually.
      polygonTree: {
        testPoint: (point) => polygon.contains(point.x, point.y),
      },
    },
  };
}


/**
 * Paint one polygon at an absolute darkness level.
 *
 * @param {PIXI.Polygon} polygon
 * @param {number} level - 0 (full daylight) .. 1 (full darkness)
 * @param {string} id
 */
export function paint(polygon, level, id) {
  // **A stub missing anything `_preRender` reads throws once per frame inside PIXI's render
  // loop and blacks the canvas out** — recoverable only from the console. The two readers are
  // `AbstractDarknessLevelRegionShader#_preRender` (`elevation`) and
  // `EffectsCanvasGroup#getDarknessLevel` (`testPoint`); both are covered in `regionStub`.
  const shaders = foundry.canvas.rendering.shaders;
  const RegionMesh = foundry.canvas.placeables.regions?.RegionMesh ?? foundry.canvas.regions?.RegionMesh;
  if (!RegionMesh) {
    console.error(`${MODULE_ID} | RegionMesh not found; spike cannot run.`);
    return null;
  }

  clear(id);

  const geometry = geometryOf(polygon);
  const region = regionStub(polygon, geometry);

  // OVERRIDE, so the number on screen is the number asked for rather than a modifier on the
  // scene's own level — the point is to see where the tiers *land*.
  const MODE_OVERRIDE = 0;

  const dl = new RegionMesh(region, shaders.AdjustDarknessLevelRegionShader);
  dl.name = id;
  dl.shader.mode = MODE_OVERRIDE;
  dl.shader.modifier = level;
  canvas.effects.illumination.darknessLevelMeshes.addChild(dl);

  const ill = new RegionMesh(region, shaders.IlluminationDarknessLevelRegionShader);
  ill.name = id;
  ill.shader.mode = MODE_OVERRIDE;
  ill.shader.modifier = level;
  canvas.visibility.vision.light.global.meshes.addChild(ill);

  drawn.set(id, [dl, ill]);
  return { id, level };
}

/** Remove one painted region, or all of them. */
export function clear(id) {
  const ids = id === undefined ? [...drawn.keys()] : [id];
  for (const key of ids) {
    for (const mesh of drawn.get(key) ?? []) mesh.destroy();
    drawn.delete(key);
  }
  refresh();
}

function refresh() {
  canvas.effects.illumination.invalidateDarknessLevelContainer(true);
  canvas.perception.update({
    refreshLighting: true,
    refreshVision: canvas.environment.globalLightSource.active,
  });
}

/**
 * Draw a row of test bands across the scene, one per level.
 *
 * @remarks
 * The whole spike. Look at the result with **nothing selected** (god's eye), then with a
 * normal-vision token, then with a darkvision or true-seeing token. The question is whether
 * the bands stay distinguishable in all three — that is exactly what a light fill fails to do,
 * and the only reason to consider this mechanism at all.
 *
 * @param {number[]} [levels] - Darkness levels to sample, 0..1
 */
export function bands(levels = [0, 0.25, 0.5, 0.75, 1]) {
  if (!canvas?.ready) return null;
  clear();

  const rect = canvas.dimensions.sceneRect;
  const width = rect.width / levels.length;

  const report = [];
  for (let i = 0; i < levels.length; i++) {
    const x = rect.x + i * width;
    // A vertical stripe per level, full scene height, so every band crosses whatever lighting
    // and terrain the scene already has rather than sitting on a clean patch.
    const polygon = new PIXI.Polygon([
      x, rect.y,
      x + width, rect.y,
      x + width, rect.y + rect.height,
      x, rect.y + rect.height,
    ]);
    report.push(paint(polygon, levels[i], `${MODULE_ID}.spike.band.${i}`));
  }

  refresh();
  console.error(`${MODULE_ID} | darkness-level bands`, {
    levels,
    // What the model would have to hit. Compare against what the bands actually look like.
    note: "left→right = darkness 0..1. Check god's eye, normal vision, and darkvision.",
    hasDynamicDarknessLevel: canvas.effects.illumination.hasDynamicDarknessLevel,
  });
  return report;
}

/** What darkness level does Foundry itself report at a point? Confirms the texture took. */
export function sample(x, y) {
  const point = x === undefined ? canvas.mousePosition : { x, y };
  const level = canvas.effects.getDarknessLevel({ ...point, elevation: 0 });
  console.error(`${MODULE_ID} | darkness level at`, point, "=", level);
  return level;
}
