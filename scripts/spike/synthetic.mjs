/**
 * Vertical slice, step 1 — document-less synthetic light sources with injected
 * polygons. DESIGN.md §8.1 and §6.5.
 *
 * Everything in §6.5 was verified by reading v13 source, never by running it. This
 * file is the experiment that turns that into evidence:
 *
 *   - Can a source exist with no backing placeable? (`sourceId`, no `object`)
 *   - Does an injected polygon survive into the render?
 *   - Does our subclass coexist with PF1's and `limits`' mixins?
 *
 * Injection technique: let Foundry sweep normally, then narrow the result with
 * `PointSourcePolygon#applyConstraint`. That clones the polygon and preserves its
 * `config` and `bounds` (source-polygon.mjs:222), so downstream geometry code keeps
 * working. Assigning a bare `PIXI.Polygon` over `shape` would lose both.
 */

import { MODULE_ID, SYNTHETIC_MARK } from "../constants.mjs";

/** Live synthetic sources, keyed by sourceId, so they survive re-initialisation. */
const registry = new Map();

let SyntheticLightSource = null;

/**
 * Build the synthetic source class.
 *
 * Deferred until first use because `CONFIG.Canvas.lightSourceClass` is not final until
 * `canvasInit` — PF1 and `limits` both mix over it. Extending whatever is installed at
 * that moment is what puts us *on top of* them rather than beside them.
 *
 * @returns {typeof foundry.canvas.sources.PointLightSource}
 */
function getSyntheticClass() {
  if (SyntheticLightSource) return SyntheticLightSource;

  const Base = CONFIG.Canvas.lightSourceClass;

  SyntheticLightSource = class extends Base {
    /** @see SYNTHETIC_MARK — lets other code skip our sources. */
    [SYNTHETIC_MARK] = true;

    /** Optional PIXI shape the swept polygon is narrowed to. */
    constrainTo = null;

    /**
     * A polygon used *instead of* sweeping. See {@link buildDirectShape}.
     * @type {PIXI.Polygon|null}
     */
    directPolygon = null;

    /**
     * Whether this source gets Foundry's soft-edge treatment.
     *
     * Defaults **off** for synthetic sources. Measured 2026-08-21 (DESIGN.md §9.5):
     * once source construction is pooled away, `PolygonMesher`'s Clipper offsetting
     * passes — `ceil(|EDGE_OFFSET| / 3)` of them per source — become the dominant
     * remaining cost, worth a ~3.9× difference.
     *
     * Turning them off costs nothing here: soft edges only matter on real light
     * sources, where a wall-cut shadow edge is visible. Synthetic tier fills have
     * deliberately hard boundaries (§6.2 — umbra and darkness edges *should* be sharp).
     *
     * @type {boolean}
     */
    softEdges = false;

    /** @override */
    _initializeSoftEdges() {
      super._initializeSoftEdges();
      if (!this.softEdges) this._flags.renderSoftEdges = false;
    }

    /** @override */
    _createShapes() {
      if (this.directPolygon) return this.#buildDirectShape();
      super._createShapes();
      if (this.constrainTo && this.shape?.applyConstraint) {
        this.shape = this.shape.applyConstraint(this.constrainTo);
      }
    }

    /**
     * Build the source shape from a supplied polygon without running a wall sweep.
     *
     * DESIGN.md §9.3 — the sweep is essentially the entire cost of creating a source
     * on a wall-heavy scene (~0.63-0.83 ms vs ~0.12 ms on an empty one). Synthetic
     * fills never need it: their polygon comes from the subdivision, which was itself
     * derived from already-swept source shapes, so wall occlusion is *already baked
     * in*. Sweeping again re-derives information we have and then discards most of it.
     *
     * `PointSourcePolygon.create()` is `new → initialize() → compute()`
     * (source-polygon.mjs:76-81); only `compute()` sweeps. So we do everything except
     * that, then supply the points ourselves.
     */
    #buildDirectShape() {
      this._deleteEdges?.();
      const config = this._getPolygonConfiguration();
      const polygonClass = CONFIG.Canvas.polygonBackends[this.constructor.sourceType];

      const poly = new polygonClass();
      poly.initialize(this.origin, config);
      poly.points = Array.from(this.directPolygon.points ?? this.directPolygon);
      poly.bounds = poly.getBounds();

      this.shape = poly;
    }
  };

  Object.defineProperty(SyntheticLightSource, "name", { value: "SyntheticLightSource" });
  return SyntheticLightSource;
}

/**
 * Create and attach a synthetic light source.
 *
 * @param {object} options
 * @param {string} options.id - Unique within this module
 * @param {number} options.x - Scene pixel X
 * @param {number} options.y - Scene pixel Y
 * @param {number} [options.elevation=0]
 * @param {number} [options.dim] - Dim radius in pixels; defaults to 6 grid squares
 * @param {number} [options.bright] - Bright radius in pixels; defaults to half of dim
 * @param {number} [options.color] - Tint, e.g. 0xff8800
 * @param {number} [options.alpha=0.5]
 * @param {PIXI.Polygon|PIXI.Circle|PIXI.Rectangle} [options.constrainTo] - Sweep, then
 *   narrow the result to this shape
 * @param {PIXI.Polygon} [options.polygon] - Use this polygon directly and **skip the
 *   wall sweep entirely**. Mutually exclusive with `constrainTo`, and far cheaper — see
 *   DESIGN.md §9.3
 * @param {boolean} [options.redraw=true] - Ask Foundry to refresh lighting afterwards.
 *   Pass false when spawning in bulk and refresh once at the end — otherwise the
 *   perception queue dominates any timing you take around this call.
 * @returns {object} The attached source
 */
export function spawn({
  id,
  x,
  y,
  elevation = 0,
  dim,
  bright,
  color,
  alpha = 0.5,
  constrainTo = null,
  polygon = null,
  softEdges = false,
  redraw = true,
} = {}) {
  const Cls = getSyntheticClass();
  const sourceId = `${MODULE_ID}.synthetic.${id}`;

  // Replacing an existing source of the same id rather than leaking it.
  destroy(id);

  const grid = canvas.grid.size;
  const dimRadius = dim ?? grid * 6;
  const brightRadius = bright ?? dimRadius / 2;

  const source = new Cls({ sourceId });
  source.constrainTo = constrainTo;
  source.directPolygon = polygon;
  source.softEdges = softEdges;

  // initialize() builds the shape; add() attaches and configures. In that order the
  // shape exists before anything tries to render it.
  source.initialize({
    x,
    y,
    elevation,
    radius: dimRadius,
    dim: dimRadius,
    bright: brightRadius,
    alpha,
    ...(color !== undefined ? { color } : {}),
  });
  source.add();

  registry.set(sourceId, {
    source,
    options: { id, x, y, elevation, dim, bright, color, alpha, constrainTo, polygon },
  });
  if (redraw) refresh();
  return source;
}

/**
 * A regular polygon centred on a point — a cheap stand-in for a subdivision cell when
 * testing the no-sweep path.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} radius
 * @param {number} [sides=12]
 * @returns {PIXI.Polygon}
 */
export function ngon(x, y, radius, sides = 12) {
  const points = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    points.push(x + Math.cos(a) * radius, y + Math.sin(a) * radius);
  }
  return new PIXI.Polygon(points);
}

/**
 * Destroy one synthetic source.
 *
 * @param {string} id
 * @returns {boolean} Whether anything was removed
 */
export function destroy(id) {
  const sourceId = `${MODULE_ID}.synthetic.${id}`;
  const entry = registry.get(sourceId);
  if (!entry) return false;
  entry.source.destroy();
  registry.delete(sourceId);
  return true;
}

/**
 * Destroy every synthetic source.
 *
 * @param {object} [options]
 * @param {boolean} [options.redraw=true] - See {@link spawn}; pass false when timing.
 */
export function clear({ redraw = true } = {}) {
  for (const [, entry] of registry) entry.source.destroy();
  registry.clear();
  if (redraw) refresh();
}

/** Currently attached synthetic sources. */
export function list() {
  return [...registry.values()].map((e) => e.source);
}

/** Ask Foundry to redraw lighting. */
export function refresh() {
  canvas.perception.update({ refreshLighting: true });
}

/**
 * Re-attach synthetic sources after Foundry rebuilds its light source collection.
 *
 * `EffectsCanvasGroup#initializeLightSources` iterates the existing collection and
 * fires this hook afterwards, with a docstring explicitly inviting packages to add
 * sources programmatically (effects.mjs:172-175).
 */
export function registerHooks() {
  Hooks.on("initializeLightSources", () => {
    for (const [sourceId, entry] of registry) {
      if (!canvas.effects.lightSources.has(sourceId)) entry.source.add();
      entry.source.initialize();
    }
  });

  // Sources are per-canvas; a scene change invalidates them all.
  Hooks.on("canvasTearDown", () => registry.clear());
}
