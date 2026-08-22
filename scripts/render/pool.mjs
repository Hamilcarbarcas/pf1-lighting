/**
 * Pooled synthetic sources. DESIGN.md §9.5 — a hard requirement, not an optimisation.
 *
 * Measured 2026-08-21: source *construction* dominates the renderer's cost, not geometry
 * and not the wall sweep. Re-`initialize()`ing an existing source instead of creating a
 * new one is worth ~3× on its own and ~12× combined with soft edges off, taking a
 * synthetic fill to ~0.05 ms. So the renderer allocates up to the worst-case cell count
 * once and reuses; it never churns.
 *
 * Two pools, because a Supernatural Dark fill is a *darkness* source and everything else
 * is a light source, and the two live in different collections.
 */

import { MODULE_ID, SYNTHETIC_MARK } from "../constants.mjs";
import { setLevel } from "./clip.mjs";

/** Classes are built lazily so we extend whatever `limits` and our own mixins installed. */
const classes = { light: null, darkness: null };

function syntheticClass(kind) {
  if (classes[kind]) return classes[kind];

  const Base = kind === "darkness" ? CONFIG.Canvas.darknessSourceClass : CONFIG.Canvas.lightSourceClass;

  classes[kind] = class extends Base {
    [SYNTHETIC_MARK] = true;

    /** Polygon supplied by the renderer, used instead of sweeping. */
    directPolygon = null;

    /**
     * Off by default. §9.5 — once construction is pooled away, `PolygonMesher`'s Clipper
     * offsetting passes become the dominant remaining cost, worth ~3.9×. Soft edges only
     * matter on real sources where a wall-cut shadow edge shows; a synthetic fill's
     * boundaries are suppressor and umbra edges, which §6.2 wants sharp anyway.
     */
    softEdges = false;

    /** @override */
    _initializeSoftEdges() {
      super._initializeSoftEdges();
      if (!this.softEdges) this._flags.renderSoftEdges = false;
    }

    /** @override */
    _createShapes() {
      if (!this.directPolygon) return super._createShapes();

      // `PointSourcePolygon.create()` is new → initialize() → compute(), and only
      // compute() sweeps (`source-polygon.mjs:76-81`). The polygon we were handed came
      // out of the subdivision, which derived it from already-swept shapes — wall
      // occlusion is *already baked in*. Sweeping again would re-derive what we have.
      this._deleteEdges?.();
      const config = this._getPolygonConfiguration();
      const PolygonClass = CONFIG.Canvas.polygonBackends[this.constructor.sourceType];

      const poly = new PolygonClass();
      poly.initialize(this.origin, config);
      poly.points = Array.from(this.directPolygon.points ?? this.directPolygon);
      poly.bounds = poly.getBounds();
      this.shape = poly;
    }
  };

  Object.defineProperty(classes[kind], "name", {
    value: kind === "darkness" ? "PF1LightingFillDarkness" : "PF1LightingFillLight",
  });
  return classes[kind];
}

/* -------------------------------------------- */

const pools = { light: [], darkness: [] };
const inUse = { light: 0, darkness: 0 };

/**
 * Take the next source from a pool, growing it if needed.
 *
 * @param {"light"|"darkness"} kind
 * @returns {object}
 */
function take(kind) {
  const pool = pools[kind];
  const index = inUse[kind]++;

  if (index < pool.length) return pool[index];

  const Cls = syntheticClass(kind);
  const source = new Cls({ sourceId: `${MODULE_ID}.fill.${kind}.${index}` });
  pool.push(source);
  return source;
}

/**
 * Begin a rebuild. Everything handed out since the last call is considered free again.
 *
 * Sources are not destroyed — that is the whole point — so anything left unclaimed at
 * {@link finish} is deactivated in place and reused next time.
 */
export function begin() {
  inUse.light = 0;
  inUse.darkness = 0;
}

/**
 * Configure one synthetic fill.
 *
 * @param {object} options
 * @param {"light"|"darkness"} options.kind
 * @param {PIXI.Polygon} options.polygon - Cell geometry; used instead of a wall sweep
 * @param {number} options.x - Origin, scene pixels
 * @param {number} options.y
 * @param {number} [options.elevation]
 * @param {object} [options.radii] - `{bright, normal, dim}` in pixels, for a `reduced`
 *   cell that keeps its gradient (§6.2.2). Omit for a flat fill.
 * @param {number} [options.level] - Foundry lighting level for a flat fill (§6.2.3)
 * @param {number} [options.color]
 * @returns {object} The configured source
 */
export function fill({ kind, polygon, x, y, elevation = 0, radii, level, color }) {
  const source = take(kind);
  source.directPolygon = polygon;

  const bounds = polygon.getBounds?.() ?? null;
  // A flat fill has no falloff to speak of: make the radius comfortably cover the cell
  // and let `attenuation: 0` keep it uniform out to the clip boundary.
  const span = bounds
    ? Math.hypot(Math.max(Math.abs(bounds.x - x), Math.abs(bounds.right - x)),
                 Math.max(Math.abs(bounds.y - y), Math.abs(bounds.bottom - y))) + 1
    : canvas.dimensions.maxR;

  const data = {
    x,
    y,
    elevation,
    radius: radii ? Math.max(radii.dim ?? 0, span) : span,
    dim: radii ? (radii.dim ?? 0) : span,
    bright: radii ? (radii.normal ?? 0) : span,
    attenuation: radii ? 0.5 : 0,
    ...(color !== undefined ? { color } : {}),
  };

  // Pin the rendered tier. §6.2.3 — our five tiers are exactly Foundry's levels, so this
  // is an assignment rather than an approximation. Set before `initialize` so the first
  // uniform update already carries it.
  setLevel(source, level);

  source.initialize(data);
  source.add();
  return source;
}

/**
 * End a rebuild: park every source the rebuild didn't claim.
 *
 * Parked rather than destroyed — deactivating costs nothing and keeps the allocation for
 * the next frame, which is the entire reason this module exists.
 */
export function finish() {
  for (const kind of ["light", "darkness"]) {
    const pool = pools[kind];
    // `remove()` detaches from the effects collection, which is what makes a source
    // inactive — `active` is a getter over `#attached && !disabled && !suppressed`
    // (`base-effect-source.mjs:162`) and cannot be assigned.
    for (let i = inUse[kind]; i < pool.length; i++) pool[i].remove();
  }
}

/** Destroy every pooled source. Scene teardown only. */
export function dispose() {
  for (const kind of ["light", "darkness"]) {
    for (const source of pools[kind]) source.destroy();
    pools[kind] = [];
    inUse[kind] = 0;
  }
  classes.light = null;
  classes.darkness = null;
}

/** Debug readout. */
export function stats() {
  return {
    light: { pooled: pools.light.length, inUse: inUse.light },
    darkness: { pooled: pools.darkness.length, inUse: inUse.darkness },
  };
}
