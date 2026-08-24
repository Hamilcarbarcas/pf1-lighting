/**
 * Clipping real light sources to their assigned cell. DESIGN.md §6.1, §6.2.4.
 *
 * **Clip, don't replace.** The whole point of the renderer's design is that a torch
 * inside a partially-overlapping *darkness* is still the torch — same flicker, same
 * colour, same falloff — with a bite taken out of it. Replacing it with a synthetic fill
 * would lose all of that, and losing it was never acceptable.
 *
 * **The clip must never touch `shape`.** That was the hardest lesson of the renderer's
 * first day. `shape` has three consumers and only one is drawing:
 *
 * | Consumer | Reads | Effect of clipping it |
 * | --- | --- | --- |
 * | `testPoint` | `base-effect-source.mjs:343-345` | the model forgets where its own lights reach |
 * | visibility mask | `groups/visibility.mjs:562` | **holes in what tokens can see** — black discs that block darkvision |
 * | `_updateGeometry` | `point-effect-source.mjs:173-189` | the one we actually want |
 *
 * So the clipped polygon lives in `RENDER_SHAPE` and is swapped in only around
 * `_updateGeometry`. `applyConstraint` clones and preserves `config` and `bounds`
 * (`source-polygon.mjs:222`), which the mesher needs; assigning a bare `PIXI.Polygon`
 * would lose both.
 */

import {
  CLIP,
  HARD_EDGES,
  HIDDEN,
  LEVEL,
  BAND_LEVEL,
  DARK_ANIMATION,
  RENDER_SHAPE,
  STRENGTH,
  isSynthetic,
} from "../constants.mjs";
import { darknessPadding, edgeOffset } from "./soften.mjs";
import {
  currentSaturation,
  isEnabled as isDesaturationEnabled,
  observerIgnoresDarkness,
  withDesaturation,
} from "./desaturate.mjs";

let applied = false;
let visibilityPatched = false;

/**
 * Give the **visibility mask** the clipped shape too. DESIGN.md §6.2.4, §7.0.
 *
 * @remarks
 * The third consumer in this file's own table, and the one that stayed harmless for months.
 * `CanvasVisibility#refreshVisibility` draws `lightSource.shape` — the *unclipped* polygon —
 * into `vision.light.sources`, `vision.light.mask` and the light cache
 * (`groups/visibility.mjs:542-562`). So a torch clipped away from a darkness still marks its
 * full raw circle as directly seen.
 *
 * Before §7.0 that was invisible: global illumination covered the whole scene, so "revealed"
 * and "not revealed" looked identical on a lit map. Once ambient is cut out of a darkness, the
 * difference becomes a **bright crescent exactly where a light overlaps the darkness** — an
 * area the model calls Dark, that no source paints, and that still renders lit. Reported
 * 2026-08-23, and it survived four wrong hypotheses because every diagnostic to hand described
 * the illumination pipeline, which was working perfectly.
 *
 * ## Why this is not the mistake §6.2.4 warns about
 *
 * That warning is against clipping `shape` **as a property**, which also narrows `testPoint`
 * and the model's own view of each light, and which left "black discs that blocked darkvision".
 * This swaps the field for the duration of *one method* and puts it back, so:
 *
 *   - `testPoint` and the registry are untouched — they never run inside this call;
 *   - **darkvision still reveals the region**, because it comes from the vision-source loop
 *     further down the same method (`visibility.mjs:571+`), which reads a vision source's own
 *     polygon and not a light's.
 *
 * A hole in a *light's* mask contribution is the correct answer: inside a darkness that light
 * genuinely does not let you see. That is the whole claim of the model.
 *
 * **Self-gating.** Only sources carrying a `RENDER_SHAPE` are swapped, and only the renderer
 * ever sets one — so with the renderer off this is a loop over the light sources and nothing
 * else. A prototype patch rather than a class mixin, so it neither races the canvas group's
 * construction nor cares who else has touched `CanvasVisibility`.
 */
export function patchVisibility() {
  if (visibilityPatched) return;
  const proto = foundry.canvas.groups?.CanvasVisibility?.prototype;
  if (!proto?.refreshVisibility) return;
  visibilityPatched = true;

  const original = proto.refreshVisibility;
  proto.refreshVisibility = function pf1LightingRefreshVisibility(...args) {
    const swapped = [];
    for (const source of canvas.effects?.lightSources?.values() ?? []) {
      const render = source[RENDER_SHAPE];
      if (!render) continue;
      swapped.push([source, source.shape]);
      source.shape = render;
    }
    try {
      return original.apply(this, args);
    } finally {
      // Restored unconditionally. A throw inside core's method leaving every light on its
      // clipped shape would break `testPoint` and the model with it — the exact failure
      // §6.2.4 exists to prevent, arrived at from the other direction.
      for (const [source, shape] of swapped) source.shape = shape;
    }
  };
}

/**
 * Render this source at a specific Foundry lighting level, or `undefined` for its class
 * default.
 *
 * @remarks
 * **Two levels, since §3.2.1.** A light's inner zone provides a set level and its outer band
 * raises the prevailing one, so the two zones genuinely differ in tier and Foundry exposes
 * exactly that: `dimLevelCorrection` and `brightLevelCorrection` are separate uniforms
 * (`base-lighting.mjs:368-369`). Passing one value keeps both in step, which is what a flat
 * fill wants.
 *
 * @param {object} source
 * @param {number|undefined} level - The inner zone's level
 * @param {number|undefined} [bandLevel=level] - The outer band's, when it differs
 * @returns {boolean} Whether the assignment changed anything
 */
export function setLevel(source, level, bandLevel = level) {
  if (source[LEVEL] === level && source[BAND_LEVEL] === bandLevel) return false;
  source[LEVEL] = level;
  source[BAND_LEVEL] = bandLevel;
  return true;
}

/**
 * Scale how hard a darkness source darkens, 0..1 of its authored strength.
 *
 * @param {object} source
 * @param {number|undefined} strength
 * @returns {boolean} Whether the assignment changed anything
 */
export function setStrength(source, strength, animationOnly = false) {
  if (source[STRENGTH] === strength && !!source[DARK_ANIMATION] === !!animationOnly) return false;
  source[STRENGTH] = strength;
  source[DARK_ANIMATION] = !!animationOnly;
  // Uniform-only; no shape rebuild needed, but the layer has to be told to re-upload.
  const layer = source.layers?.darkness;
  if (layer) layer.reset = true;
  return true;
}

/**
 * Assign a clip polygon to a source. Pass `null` to clear it.
 *
 * Does **not** re-initialise the source — the caller is expected to be mid-rebuild and
 * to refresh once at the end rather than once per source.
 *
 * @param {object} source
 * @param {PIXI.Polygon|null} polygon
 * @returns {boolean} Whether the assignment changed anything
 */
export function assign(source, polygon) {
  // **Identity only, and deliberately not compared against `source.shape`.** An earlier version
  // filtered out a self-clip here by testing `polygon !== source.shape`, which reads as a tidy
  // optimisation and is a feedback loop: re-initialising a source reallocates `shape`, so the
  // test's answer changes underneath a cached cell and the clip oscillates between the polygon
  // and `null`, restaging the source every frame forever.
  //
  // Whether a cell is a real clip is a fact about how `field()` built it, so `field()` states
  // it — `cell.clipped` — and the caller passes `null` when it is false.
  if (source[CLIP] === polygon) return false;
  source[CLIP] = polygon ?? null;
  return true;
}

/**
 * Stop a source drawing at all, without touching its data, geometry or activity.
 *
 * @see HIDDEN — the source stays in its collection so the model keeps seeing it, and
 * `testPoint` keeps answering; only the meshes are withheld.
 *
 * @param {object} source
 * @param {boolean} hidden
 * @returns {boolean} Whether the assignment changed anything
 */
export function setHidden(source, hidden) {
  if (!!source[HIDDEN] === !!hidden) return false;
  source[HIDDEN] = !!hidden;
  return true;
}

/**
 * Force hard edges on a source, for the pieces of a split cell.
 *
 * @param {object} source
 * @param {boolean} hard
 * @returns {boolean} Whether the assignment changed anything
 */
export function setHardEdges(source, hard) {
  if (!!source[HARD_EDGES] === !!hard) return false;
  source[HARD_EDGES] = !!hard;
  return true;
}

/**
 * Mix clipping into whatever light source class is installed.
 *
 * Called at `canvasInit`, after `limits` and after our own suppression mixin, so this
 * sits on top of both. Note `limits` also narrows `_createShapes` — it constrains, we
 * constrain — so the two compose rather than conflict, and the order only decides which
 * constraint is applied to the other's output.
 */
export function applyMixin() {
  if (applied) return;
  applied = true;

  for (const slot of ["lightSourceClass", "darknessSourceClass"]) {
    const Base = CONFIG.Canvas[slot];
    if (!Base || Base.pf1LightingClipPatched) continue;

    const Patched = class extends Base {
      static pf1LightingClipPatched = true;

      /** Darkness sources take one behaviour lights must not — see `_initialize`. */
      static pf1LightingDarkness = slot === "darknessSourceClass";

      /**
       * @inheritDoc
       * Widen a darkness source's fade band before core derives its border distance from it.
       *
       * @remarks
       * `PointDarknessSource._initialize` computes `borderDistance = radius / (radius +
       * _padding)` (`point-darkness-source.mjs:118`), and `_padding` is a class field fixed at
       * construction — so the fade is a constant number of pixels and a large disc gets a
       * proportionally sharper rim. Assigning here rather than in the constructor is what makes
       * the setting live: `_initialize` re-reads it on every source initialisation.
       *
       * **Only real darkness sources.** `_padding` means something else on a light source, and
       * our own pooled fills bypass the machinery it feeds — their `_createShapes` returns early
       * on `directPolygon` and never builds the padded `_visualShape` the fade band lives in
       * (`render/pool.mjs`). Widening it there would change `borderDistance` with no padded
       * shape to spend it on, which is a fade eating into the fill rather than sitting outside
       * it.
       */
      _initialize(data) {
        if (this.constructor.pf1LightingDarkness && !isSynthetic(this)) {
          this._padding = darknessPadding();
        }
        super._initialize(data);
      }

      /**
       * @override
       * How far this source's clipped edge feathers.
       *
       * @remarks
       * A **getter**, not a value, because it is a live setting: `_updateGeometry` reads
       * `this.constructor.EDGE_OFFSET` afresh each time it meshes
       * (`point-effect-source.mjs:176`), so a getter takes effect on the next source rebuild
       * with nothing to invalidate.
       *
       * Foundry's own is `-8`, which §6.4 already called "tuned very small" — small enough that
       * a clipped light abutting one of our regions read as a hard step (2026-08-23). Every
       * soft-edged source inherits this, our pooled synthetics included, which is the point: a
       * `stack` clone has to feather at the same rate as the light it stands in for.
       */
      static get EDGE_OFFSET() {
        return edgeOffset();
      }

      /**
       * @override
       * Render at a per-source lighting level when one has been assigned.
       *
       * @remarks
       * `_dimLightingLevel` and `_brightLightingLevel` read like instance properties but
       * are taken off `this.constructor` (`base-light-source.mjs:213-214`), so assigning
       * them on a source does nothing — a correction to DESIGN.md §6.2.3, which said to
       * do exactly that. The override therefore goes one layer down, onto the uniforms
       * those statics feed.
       *
       * This is what lets a **darkness** source darken a region by a *specific amount*
       * rather than all the way to black — the mechanism a *darkness* spell needs on a
       * lit map, where the answer is "one step down from ambient", not "unlit".
       */
      _updateCommonUniforms(shader) {
        super._updateCommonUniforms(shader);

        const level = this[LEVEL];
        if (level === undefined) return;
        // The inner zone is Foundry's `bright`; the outer band is its `dim` (§3.2.1).
        shader.uniforms.brightLevelCorrection = this.constructor.getCorrectedLevel(level);
        shader.uniforms.dimLevelCorrection = this.constructor.getCorrectedLevel(
          this[BAND_LEVEL] ?? level
        );
      }

      /**
       * @override
       * Force hard edges when this source is one piece of a split cell.
       *
       * @see HARD_EDGES — two halves that each fade at the cut leave a seam, and
       * overlapping them to hide it makes a bright line instead, because coloration
       * blends additively.
       */
      _initializeSoftEdges() {
        super._initializeSoftEdges();

        // **Undo Foundry's complete-circle exemption for a clipped source**, which §6.2.4's own
        // design otherwise triggers by accident. `_initializeSoftEdges` tests `this.shape`, and
        // `shape` is deliberately left *unclipped* — the cut lives in `RENDER_SHAPE` and reaches
        // only `_updateGeometry`. So a light with a bite taken out of it still reports as a
        // perfect circle, Foundry disables soft edges on that basis, and the one boundary that
        // actually needs a feather — the cut — is the one that never gets one.
        //
        // Reported 2026-08-23: a *darkness* adjacent to a torch has a sharp border at scene
        // darkness 1, where the texture has no brightness step to feather and the visible edge
        // is entirely the clipped light's.
        //
        // Only the circle test is undone; the performance-mode and preview gates stand.
        if (this[RENDER_SHAPE]) {
          this._flags.renderSoftEdges =
            canvas.performance?.lightSoftEdges === true && !this.isPreview;
        }

        if (this[HARD_EDGES]) this._flags.renderSoftEdges = false;
      }

      /**
       * @override
       * Scale the darkness layer's alpha to render a *partial* darkening.
       *
       * @remarks
       * The darkness shader ignores lighting levels — it renders from `color` and
       * `colorationAlpha` (`point-darkness-source.mjs:206-213`). Alpha is therefore the
       * only way to say "darken this area one step" rather than "darken it to black",
       * which is what a *darkness* spell over lit ground needs.
       *
       * Applied here rather than by editing `data.alpha`, so the document's authored
       * value stays intact and nothing has to be restored when the renderer is switched
       * off.
       */
      _updateDarknessUniforms() {
        super._updateDarknessUniforms?.();
        const u = this.layers?.darkness?.shader?.uniforms;
        if (!u) return;

        // Put back the vision mode's colour adjustment, which this shader skips by sampling
        // `canvas.primary.renderTexture` directly. See `render/desaturate.mjs`.
        //
        // **Except when the source is only carrying an animation** (§6.2.6). Desaturating is
        // what darkvision does to *a darkness*, and an animation-only source is not one — the
        // ground under it is at whatever tier the texture says, Normal included. Left in, a
        // *darkness* reducing Bright to Normal went grey for a darkvision observer purely
        // because the GM had picked an animation for it (reported 2026-08-24).
        if ("saturation" in u) u.saturation = this[DARK_ANIMATION] ? 0 : currentSaturation();

        const strength = this[STRENGTH];
        if (strength === undefined) return;

        // **Animation only: neutralise the darkening rather than reduce it.**
        //
        // `finalColor *= mix(color, color * 0.33, darknessLevel) * colorationAlpha`
        // (`darkness-lighting.mjs:119`), where `finalColor` starts as the rendered scene and the
        // animation has already modified it. So the identity is *white at alpha 1* — the source
        // then draws the scene back exactly as it found it, animated.
        //
        // `strength` is the tint: 0 keeps the source out of the way entirely, 1 restores its
        // authored colour and the darkness that comes with it. Interpolating the **colour** is
        // what makes that a dial; interpolating the alpha, which is what the name suggested,
        // runs from "authored" to "pitch black" and has no neutral in it at all.
        if (this[DARK_ANIMATION]) {
          // Read back what `super` just wrote rather than rebuilding it from `data.color`:
          // it is already the resolved rgb, and a fresh array each call, so pulling it toward
          // white cannot compound frame over frame.
          const tint = Math.clamp(strength, 0, 1);
          const rgb = u.color ?? [1, 1, 1];
          u.color = [
            1 + (rgb[0] - 1) * tint,
            1 + (rgb[1] - 1) * tint,
            1 + (rgb[2] - 1) * tint,
          ];
          u.colorationAlpha = 1;
          return;
        }

        u.colorationAlpha = this.data.alpha * 2 * Math.clamp(strength, 0, 1);
      }

      /**
       * @override
       * Wrap whichever shader class was chosen, rather than replacing it.
       *
       * @remarks
       * An animation's `darknessShader` supersedes the layer's `defaultShader`
       * (`rendered-effect-source.mjs:278`), so a GM who picked *Roiling Darkness* would get
       * an unwrapped shader if we substituted a fixed class here. Wrapping the *result*
       * covers the default and all four animated variants with one substitution.
       */
      _configureShaders() {
        const shaders = super._configureShaders();
        if (!isDesaturationEnabled()) return shaders;
        for (const [layer, shader] of Object.entries(shaders)) {
          if (layer === "darkness") shaders[layer] = withDesaturation(shader);
        }
        return shaders;
      }

      /**
       * @override
       * Withhold the mesh when the source is hidden, or when the observer cannot perceive
       * darkness as darkness at all.
       *
       * @see HIDDEN — this is the only reliable way to stop a darkness source drawing.
       * Zeroing `colorationAlpha` leaves it visibly dark, so the shader must darken
       * through something else as well.
       *
       * @remarks
       * The second condition is **blindsight**, and withholding is the whole mechanism —
       * see `observerIgnoresDarkness`. Two attempts to neutralise the bubble *inside* the
       * shader both failed, because what the surrounding ground looks like is painted by the
       * vision source and no term available to a darkness shader reproduces it. Letting the
       * ordinary pipeline draw the ground is not a workaround; it is the only way to get the
       * same answer as the ground next to it.
       */
      _drawMesh(layerId) {
        const suppressed = layerId === "darkness" && observerIgnoresDarkness();
        if (!this[HIDDEN] && !suppressed) return super._drawMesh(layerId);
        const mesh = this.layers?.[layerId]?.mesh;
        if (mesh) mesh.visible = mesh.renderable = false;
        return null;
      }

      /**
       * @override
       * Compute the clipped polygon, but **do not install it as `shape`**.
       *
       * @see RENDER_SHAPE — `shape` also drives `testPoint` and the visibility mask, and
       * clipping it made lights invisible rather than merely unlit.
       */
      _createShapes() {
        super._createShapes();
        this[RENDER_SHAPE] = null;

        // Synthetic sources carry their own geometry already; clipping them again would
        // be applying the cell to itself.
        if (isSynthetic(this)) return;

        const clip = this[CLIP];
        if (!clip || (clip.points?.length ?? 0) < 6) return;

        // Darkness draws from `_visualShape ?? shape` (`point-darkness-source.mjs:165`),
        // so clip whichever it will actually use.
        const base = this._visualShape ?? this.shape;
        if (!base?.applyConstraint) return;

        // `applyConstraint` returns a **new** polygon and preserves `config` and `bounds`
        // (`source-polygon.mjs:222`), which the mesher needs. Never mutate in place:
        // an earlier version emptied a shape the model held a reference to, which
        // removed that suppressor from the field, which blanked all the others.
        this[RENDER_SHAPE] = base.applyConstraint(clip);
      }

      /**
       * @override
       * Mesh the clipped polygon rather than `shape`.
       *
       * @remarks
       * Swapping the field around `super` rather than reimplementing the meshing keeps
       * Foundry's own maths — including `PointDarknessSource`'s padded variant — as the
       * single source of truth for how a source becomes geometry.
       */
      _updateGeometry() {
        const render = this[RENDER_SHAPE];
        if (!render) return super._updateGeometry();

        const shape = this.shape;
        const visual = this._visualShape;
        try {
          this.shape = render;
          this._visualShape = null;
          super._updateGeometry();
        } finally {
          this.shape = shape;
          this._visualShape = visual;
        }
      }
    };

    Object.defineProperty(Patched, "name", { value: `PF1LightingClipped${slot}` });
    CONFIG.Canvas[slot] = Patched;
  }
}
