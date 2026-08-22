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

import { CLIP, HARD_EDGES, HIDDEN, LEVEL, RENDER_SHAPE, STRENGTH, isSynthetic } from "../constants.mjs";

let applied = false;

/**
 * Render this source at a specific Foundry lighting level, or `undefined` for its class
 * default.
 *
 * @param {object} source
 * @param {number|undefined} level
 * @returns {boolean} Whether the assignment changed anything
 */
export function setLevel(source, level) {
  if (source[LEVEL] === level) return false;
  source[LEVEL] = level;
  return true;
}

/**
 * Scale how hard a darkness source darkens, 0..1 of its authored strength.
 *
 * @param {object} source
 * @param {number|undefined} strength
 * @returns {boolean} Whether the assignment changed anything
 */
export function setStrength(source, strength) {
  if (source[STRENGTH] === strength) return false;
  source[STRENGTH] = strength;
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
  if (source[CLIP] === polygon) return false;
  source[CLIP] = polygon ?? null;
  return true;
}

/** The clip currently assigned to a source, if any. */
export function assigned(source) {
  return source?.[CLIP] ?? null;
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
        const corrected = this.constructor.getCorrectedLevel(level);
        shader.uniforms.dimLevelCorrection = corrected;
        shader.uniforms.brightLevelCorrection = corrected;
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
        const strength = this[STRENGTH];
        if (strength === undefined) return;
        const u = this.layers?.darkness?.shader?.uniforms;
        if (!u) return;
        u.colorationAlpha = this.data.alpha * 2 * Math.clamp(strength, 0, 1);
      }

      /**
       * @override
       * Withhold every mesh when the source is hidden.
       *
       * @see HIDDEN — this is the only reliable way to stop a darkness source drawing.
       * Zeroing `colorationAlpha` leaves it visibly dark, so the shader must darken
       * through something else as well.
       */
      _drawMesh(layerId) {
        if (!this[HIDDEN]) return super._drawMesh(layerId);
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
