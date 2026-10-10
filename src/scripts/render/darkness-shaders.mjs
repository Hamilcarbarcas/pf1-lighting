/**
 * The two shaders the darkness-level texture is painted with. DESIGN.md §7.0 step 5.
 *
 * Core has exactly one, `AdjustDarknessLevelRegionShader`, and it writes a uniform:
 *
 * ```glsl
 * gl_FragColor = vec4(darknessLevel, 0.0, 0.0, 1.0) * tintAlpha * depth;
 * ```
 *
 * One mesh, one brightness. That is why every brightness field this module draws had to be chopped
 * into flat pieces first, and the whole cause of the banding §3.4 chased through three failed
 * fixes — widening the blur, sub-ringing the bands, raising the blur's tap count. A blur
 * approximates a gradient with a filter; the rasteriser interpolates for free.
 *
 * So there are two:
 *
 * | Class | Writes | Used for |
 * | --- | --- | --- |
 * | {@link sortable} | `modifier`, a constant | ordinary ground cells — a region boundary is a genuine step |
 * | {@link gradient} | `aLevel`, per vertex | a §3.4 spill falloff, genuinely continuous |
 *
 * A third, `illumination`, is core's erasing shader with a roof-only switch for the sky (§6.2.12).
 * It paints no level and takes no part in the ladder below.
 *
 * `darknessLevel` is a sort key here, not a colour. `invalidateDarknessLevelContainer` orders the
 * container by `shader.darknessLevel` descending (`illumination-effects.mjs:106-110`), so the
 * darkest child draws first and the brightest last — where meshes overlap, brightest wins. Core's
 * shader derives that getter from the same `modifier` it paints with, coupling what a mesh paints
 * to where it sits.
 *
 * A gradient mesh has no single level to report, and must sit underneath the flat meshes rather
 * than compete with them: §3.4's bands are painted by one gradient mesh over their whole extent,
 * and the pieces an umbra or wall clamps down are painted flat on top. That is the one deliberate
 * two-mesh overlap in the module, and it removes the need to re-cut the gradient's geometry every
 * time an observer moves.
 *
 * Both classes therefore separate the meanings: `sortLevel` is where the mesh sits,
 * `modifier` / `aLevel` is what it paints. The ladder:
 *
 * ```
 *   7      the sky                  (bottom; shows only where a roof skips the ground, §6.2.12)
 *   6      the seam backstop        (retired, see darkness-texture.backstopFor)
 *   4‥5    §3.4 spill gradients     (brighter spill sorts later, so it wins an overlap)
 *   2‥3    ordinary ground cells    (a partition, so their order among themselves is moot)
 *   1      light contributions      MIN_COLOR — brightest wins
 *   0.5    ground halos             MIN_COLOR — the brighter cell's edge bleeds outward
 *   0      clamps                   MAX_COLOR — darkest wins, drawn last
 * ```
 *
 * Every real darkness level is ≤ 1 by construction (`AlphaField`), so nothing a GM can set moves a
 * flat mesh out of its band. Below the ground the order stops being about levels and becomes the
 * composition order of §7.0 step 6 and §6.4.3: soften, then light, then clamp.
 */

import { MODULE_ID } from "../constants.mjs";

/** Cached once the canvas exists — `PIXI.settings` is read at class definition. @type {object|null} */
let built = null;

/**
 * Where the gradient meshes sit in the container's sort, and where the backstop sits under them.
 *
 * @remarks
 * Exported because `render/darkness-texture.mjs` sets the backstop's and `render/gradient.mjs` sets
 * its meshes', and a ladder split across two files that do not import each other is how the order
 * silently inverts. The gradient band is `[GRADIENT_SORT, GRADIENT_SORT + 1)` — a mesh adds its own
 * brightest darkness level, so a Bright spill sorts after a Dim one and paints over it where two
 * windows light the same floor.
 */
export const GRADIENT_SORT = 4;
export const BACKSTOP_SORT = 6;

/**
 * The sky: a scene-wide mesh at the outdoor ambient level, drawn before everything else.
 *
 * @remarks
 * The ground partition covers the scene rect opaquely, so the sky is visible nowhere a ground mesh
 * draws. It exists for the pixels where none does: under a light-restricting roof, every ground mesh
 * fails the depth test and the roof would otherwise read the container's clear color. §6.2.12.
 */
export const SKY_SORT = 7;

/**
 * The elevation band a mesh claims, as core's depth test reads it.
 *
 * @remarks
 * `AbstractDarknessLevelRegionShader#_preRender` maps `region.document.elevation` through
 * `canvas.masks.depth`, and every fragment program here discards where a light-restricting roof
 * above `top` covers the pixel (`adjust-darkness-level.mjs:86-88`), the same test a light source
 * runs against its own elevation (`base-lighting.mjs:394`). An unbounded band passes everywhere,
 * which painted the rooms under a roof onto the roof. §6.2.12.
 *
 * The field is planar (§3.6), so everything it derives sits at ground. A fully faded roof writes no
 * `g` and passes the ground band again, which is what lets the room show through while a token
 * stands under it.
 */
export const GROUND_ELEVATION = Object.freeze({ bottom: -Infinity, top: 0 });

/** The sky's band: outdoors, so it reaches every roof. */
export const SKY_ELEVATION = Object.freeze({ bottom: -Infinity, top: Infinity });

/**
 * A light's band: its own elevation at both ends, which is exactly core's light test.
 *
 * @param {number} elevation
 * @returns {{bottom: number, top: number}}
 */
export const elevationBand = (elevation) =>
  Number.isFinite(elevation) ? { bottom: elevation, top: elevation } : GROUND_ELEVATION;

/**
 * The ordinary ground cells' band, added to the level they paint.
 *
 * @remarks
 * These used to sort on the raw level (`sortLevel = null`, core's behaviour), putting them in
 * `[0, 1]`. §7.0 step 6 needs two passes underneath them in draw order, so the whole band moved up
 * and the two new ones took the space below. Their order among themselves has never mattered — the
 * cells partition space (§6.1).
 */
export const GROUND_SORT = 2;

/**
 * Light contributions — drawn after every ground mesh, blended `MIN_COLOR`.
 *
 * @remarks
 * `MIN` on the red channel is brightest-wins per fragment, the channel holding a darkness level.
 * That is §3.2.1's combine rule for lights exactly, and taking it from the blend equation rather
 * than the container's sort lets two lights overlap without one's tail erasing the other's core.
 */
export const LIGHT_SORT = 1;

/**
 * Ground halos — after the flat cells they soften, before the lights that composite over them.
 *
 * @remarks
 * Its own constant rather than arithmetic on the two either side, which is how it first collided
 * with {@link LIGHT_SORT} exactly. A tie is an arbitrary draw order; both being `MIN_COLOR` meant
 * it happened not to matter, but a ladder whose rungs derive from each other is one edit away from
 * mattering.
 */
export const HALO_SORT = 0.5;

/**
 * Clamps — umbra and unseen ground — drawn last, blended `MAX_COLOR`.
 *
 * @remarks
 * `MAX` is darkest-wins, what a clamp means (§4.3): nothing between two points can make the far one
 * brighter. Drawn after the lights, so a torch behind a wall cannot shine through fog — the failure
 * §4.3.1 prevents, which moving light into this texture would otherwise reintroduce by a new route,
 * the texture being deliberately not vision-masked (§6.2.7).
 */
export const CLAMP_SORT = 0;

function build() {
  const shaders = foundry.canvas?.rendering?.shaders;
  const Adjust = shaders?.AdjustDarknessLevelRegionShader;
  if (!Adjust || !shaders?.IlluminationDarknessLevelRegionShader) {
    console.error(`${MODULE_ID} | darkness shaders: core's darkness-level region shaders are missing.`);
    return null;
  }

  /**
   * Core's shader with the sort key detached from the painted value.
   *
   * @remarks
   * `AdjustDarknessLevelRegionShader#_preRender` assigns
   * `uniforms.darknessLevel = this.darknessLevel`, so overriding the getter alone would paint the
   * sort key. The uniform is put back from `modifier`, which is the painted level outright since
   * every mesh this module makes runs in `MODES.OVERRIDE`.
   */
  class SortableDarknessRegionShader extends Adjust {
    /** Sort position override, or `null` to sort by the level painted — core's own behaviour. */
    sortLevel = null;

    /** @override — the sort key. */
    get darknessLevel() {
      return this.sortLevel ?? this.modifier;
    }

    /** @override */
    _preRender(mesh, renderer) {
      super._preRender(mesh, renderer);
      this.uniforms.darknessLevel = this.modifier;
    }
  }

  /**
   * One mesh, a level per vertex, interpolated across every triangle by the rasteriser.
   *
   * @remarks
   * The vertex program is `RegionShader`'s with `aLevel` added and the two coordinate varyings the
   * fragment never reads dropped. Their uniforms are still assigned by `RegionShader#_preRender`
   * and are simply absent from the compiled program, which PIXI skips — it builds its uniform sync
   * from the program's reflection, not from the object.
   *
   * `uniforms.darknessLevel` is carried but never read by the fragment program. It exists for
   * `EffectsCanvasGroup#getDarknessLevel`, which walks the container and returns that uniform off
   * the first mesh claiming a point (`effects.mjs:391-396`). A gradient has no single honest
   * answer, so it reports the ramp's nominal level — documented rather than faked, see §7.0 step 5.
   * Nothing in this module reads it; `evaluate()` is the authority.
   */
  class GradientDarknessRegionShader extends Adjust {
    /** @override */
    static vertexShader = `
    precision ${PIXI.settings.PRECISION_VERTEX} float;

    attribute vec2 aVertexPosition;
    attribute float aLevel;

    uniform mat3 translationMatrix;
    uniform mat3 projectionMatrix;
    uniform vec2 screenDimensions;

    varying vec2 vScreenCoord;
    varying float vLevel;

    void main() {
      vec3 tPos = translationMatrix * vec3(aVertexPosition, 1.0);
      vScreenCoord = tPos.xy / screenDimensions;
      vLevel = aLevel;
      gl_Position = vec4((projectionMatrix * tPos).xy, 0.0, 1.0);
    }
  `;

    /** @override */
    static fragmentShader = `
    precision ${PIXI.settings.PRECISION_FRAGMENT} float;

    uniform sampler2D depthTexture;
    uniform float top;
    uniform float bottom;
    uniform vec4 tintAlpha;

    varying vec2 vScreenCoord;
    varying float vLevel;

    void main() {
      vec2 depthColor = texture2D(depthTexture, vScreenCoord).rg;
      float depth = step(depthColor.g, top) * step(bottom, (254.5 / 255.0) - depthColor.r);
      // Discarded, not multiplied by zero as core does. Light and halo meshes blend MIN_COLOR, and
      // min(0, dst) is 0, the brightest level: a fragment the roof test rejected painted the roof at
      // full brightness (§6.2.12).
      if ( depth < 0.5 ) discard;
      gl_FragColor = vec4(clamp(vLevel, 0.0, 1.0), 0.0, 0.0, 1.0) * tintAlpha;
    }
  `;

    /** Where this mesh sits in the container's sort — see the header's ladder. */
    sortLevel = GRADIENT_SORT;

    /** What `getDarknessLevel` should report for a point inside this ramp. */
    nominal = 0;

    /** @override — the sort key. */
    get darknessLevel() {
      return this.sortLevel;
    }

    /** @override */
    _preRender(mesh, renderer) {
      super._preRender(mesh, renderer);
      this.uniforms.darknessLevel = this.nominal;
    }
  }

  /**
   * Core's erasing illumination shader, with a switch to draw on roofs only. §6.2.12.
   *
   * @remarks
   * The sky's half of a pair. Its brightness mesh can be unbounded because the ground partition
   * paints over it everywhere but a roof; its erase mesh cannot, because nothing un-erases. A
   * scene-wide erase at night would cut global light's reveal out of a vault an area sets brighter
   * than the sky. `roofOnly` keeps it to pixels where a roof above ground is unfaded: exactly the
   * pixels where every ground mesh, and so every ground erase, fails the depth test.
   *
   * One class with a uniform rather than a second class, because pool entries change role between
   * paints and `RegionMesh#setShaderClass` builds a fresh shader, dropping `mode` and `modifier`.
   */
  const Illumination = shaders.IlluminationDarknessLevelRegionShader;
  class RoofAwareIlluminationShader extends Illumination {
    /** @override */
    static fragmentShader = `
    precision ${PIXI.settings.PRECISION_FRAGMENT} float;

    uniform sampler2D depthTexture;
    uniform float top;
    uniform float bottom;
    uniform float ground;
    uniform bool roofOnly;
    uniform vec4 tintAlpha;
    varying vec2 vScreenCoord;

    void main() {
      vec2 depthColor = texture2D(depthTexture, vScreenCoord).rg;
      float depth = roofOnly
        ? step(ground + (0.5 / 255.0), depthColor.g)
        : step(depthColor.g, top) * step(bottom, (254.5 / 255.0) - depthColor.r);
      gl_FragColor = vec4(1.0) * tintAlpha * depth;
    }
  `;

    /** @override */
    static defaultUniforms = {
      ...super.defaultUniforms,
      ground: 0,
      roofOnly: false,
    };

    /** Draw only where a roof above ground covers the pixel. */
    roofOnly = false;

    /** @override */
    _preRender(mesh, renderer) {
      super._preRender(mesh, renderer);
      this.uniforms.ground = canvas.masks.depth.mapElevation(GROUND_ELEVATION.top);
      this.uniforms.roofOnly = this.roofOnly;
    }
  }

  return {
    sortable: SortableDarknessRegionShader,
    gradient: GradientDarknessRegionShader,
    illumination: RoofAwareIlluminationShader,
  };
}

/**
 * The shader classes, built on first use.
 *
 * @remarks
 * Lazy because every program interpolates `PIXI.settings.PRECISION_*` at class-definition time and
 * this module is imported at `init`, before Foundry has configured PIXI. Core's own shaders get
 * away with it by living in the client bundle, which loads later.
 *
 * @returns {{sortable: Function, gradient: Function, illumination: Function}|null}
 */
export function classes() {
  return (built ??= build());
}
