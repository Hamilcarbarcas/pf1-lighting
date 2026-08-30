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
import { HARD_EDGES, HIDDEN } from "../constants.mjs";
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
 * @param {object} [options.emission] - `{tier, inner, outer, steps, cap}` for a `reduced` cell
 *   that keeps its two zones (§3.2.1). Omit for a flat fill.
 * @param {number} [options.level] - Foundry lighting level for a flat fill (§6.2.3)
 * @param {number} [options.bandLevel] - Foundry lighting level for the **outer band**, when it
 *   differs from `level`. `dimLevelCorrection` and `brightLevelCorrection` are separate
 *   uniforms, so a light's two zones can carry two different tiers natively.
 * @param {{inner: number, band: number, base: number}} [options.tiers] - The same two zones as
 *   **tiers**, plus the ground tier beneath them (§6.2.9). Passed alongside `level`/`bandLevel`
 *   rather than instead of them: the levels are what Foundry's relative path uses, and it is what
 *   runs with the global-illumination takeover off.
 * @param {number} [options.color]
 * @param {number} [options.attenuation] - Override the falloff. Supply the **emitter's own**
 *   value whenever this fill is standing in for a real light over part of its footprint: the
 *   falloff curve is what makes the clone's edge line up with the original's, and a default
 *   would put a step between them.
 * @param {boolean} [options.softEdges] - Feather the clip boundary. Off by default (§9.5 —
 *   `PolygonMesher`'s offsetting is the dominant remaining cost once construction is pooled),
 *   on for a fill that has to blend into a neighbouring light rather than abut a region edge.
 * @param {boolean} [options.hardEdges] - Force hard edges, for one piece of a split cell whose
 *   halves must abut exactly. Defaults to the inverse of `softEdges`, and is **always
 *   assigned** — see the note in the body.
 * @param {object} [options.animation] - The emitter's animation config, for a split cell's
 *   clones. Omitted leaves the clone still, which is what a split animated light must not be.
 * @param {number} [options.seed] - Keeps a clone in phase with the piece it was split from
 * @param {boolean} [options.hidden] - Withhold the mesh. **The only thing that stops a
 *   *darkness* clone drawing** — alpha and strength do not (§6.2.3) — and, like the edge flags,
 *   always assigned. Defaults to visible.
 * @returns {object} The configured source
 */
export function fill({
  kind,
  polygon,
  x,
  y,
  elevation = 0,
  emission,
  level,
  bandLevel,
  tiers,
  color,
  attenuation,
  softEdges = false,
  hardEdges = !softEdges,
  animation,
  seed,
  hidden = false,
}) {
  const source = take(kind);
  source.directPolygon = polygon;

  // **The third flag that has to be assigned on every fill, and the third time this has bitten**
  // (found 2026-08-25). Nothing ever wrote `HIDDEN` here, so a pooled *darkness* clone was
  // always drawn — at full strength, because `setStrength(0)` is not an "off" switch for a
  // darkness source (§6.2.3; alpha 0 still darkens). The renderer hides the *real* source of a
  // split `dark` cell and then cloned the remaining pieces without hiding them, so an annulus —
  // which is to say **any darkness containing another darkness** — rendered one half correctly
  // and the other half black.
  //
  // The pattern is now unmistakable: `animation`, `HARD_EDGES`, and this. **Every per-source
  // property a pooled fill can carry must be assigned on every fill**, and a default of "leave
  // whatever the last tenant set" is never right.
  source[HIDDEN] = hidden;

  // **Both edge flags, always, and before `initialize`.** Two bugs lived here, found 2026-08-23
  // while chasing hard arcs that survived turning soft edges on:
  //
  //   *Sticky.* Nothing ever cleared `HARD_EDGES`, so a pool slot once used for a split cell's
  //   clone kept it for the rest of the session, and every later fill in that slot rendered
  //   hard whatever it asked for. Exactly the failure the `animation` note below already
  //   describes — the principle was written down and this flag was missed.
  //
  //   *Late.* The renderer set it with `clip.setHardEdges` **after** `fill` returned, and
  //   `_initializeSoftEdges` runs inside `initialize()` from `_configure`
  //   (`rendered-effect-source.mjs:243`). So the flag always landed one rebuild behind the
  //   geometry it was meant to describe.
  source.softEdges = softEdges;
  source[HARD_EDGES] = hardEdges;

  const bounds = polygon.getBounds?.() ?? null;
  // A flat fill has no falloff to speak of: make the radius comfortably cover the cell
  // and let `attenuation: 0` keep it uniform out to the clip boundary.
  const span = bounds
    ? Math.hypot(Math.max(Math.abs(bounds.x - x), Math.abs(bounds.right - x)),
                 Math.max(Math.abs(bounds.y - y), Math.abs(bounds.bottom - y))) + 1
    : canvas.dimensions.maxR;

  // A flat fill is bright out to the clip boundary; a `reduced` cell keeps the emitter's own
  // two radii, because since §3.2.1 reduction is a change of *tier* and leaves the geometry
  // alone. The gradient survives for free.
  //
  // These used to be overridable, so a fill could stand in for global illumination at the
  // singleton's own `dim: maxR, bright: 0`. That whole idea is gone (§7.0): ambient is a
  // *number*, and it now goes into the darkness-level texture rather than being impersonated
  // by a light source. Four bugs came out of cloning `GlobalLightSource` property by property,
  // and the fix was to stop needing to.
  const useDim = emission ? (emission.outer ?? 0) : span;
  const useBright = emission ? (emission.inner ?? 0) : span;

  const data = {
    x,
    y,
    elevation,
    radius: Math.max(useDim, useBright, emission ? 0 : span),
    dim: useDim,
    bright: useBright,
    attenuation: attenuation ?? (emission ? 0.5 : 0),
    // **Every key here is assigned unconditionally, and that is load-bearing.**
    //
    // `BaseEffectSource#initialize` writes only the keys the payload *mentions*, and `reset`
    // defaults to `false` (`base-effect-source.mjs:126160-126174`):
    //
    // ```js
    // for ( const key in data ) {
    //   if ( !(key in this.data) ) continue;
    //   this.data[key] = data[key] ?? this.constructor.defaultData[key];
    // }
    // ```
    //
    // So on a **pooled** source an omitted key silently keeps the previous occupant's value. The
    // `??` in that loop is the escape hatch: passing an explicit `null` resolves to the class
    // default, which is the reset a fresh source would have got.
    //
    // `animation` was written this way from the start, because a clone reused from an animated
    // light into a still one kept flickering. `color` and `seed` were spread in conditionally and
    // had the identical bug — reported 2026-08-28 as an **orange tint on ground no orange light
    // reached**, matching a lamp elsewhere on the map, surviving that lamp being switched off,
    // clearing on F5 and returning after churning global illumination and doors.
    //
    // Every symptom follows from the omission. The tint belongs to the pool slot rather than to any
    // live source, which is why disabling the light did nothing and why reloading fixed it; and it
    // needs pool *reuse* to appear, which is why it was intermittent and why churning the cell
    // partition provoked it. The three call sites in `render/renderer.mjs` pass
    // `source.data?.color ?? undefined`, and an uncoloured light's `data.color` is `null` — so the
    // key vanished exactly when the payload most needed to say *no colour*.
    color: color ?? null,
    animation: animation ?? { type: null, speed: 5, intensity: 5, reverse: false },
    seed: seed ?? null,
  };

  // Pin the rendered tier. §6.2.3 — our five tiers are exactly Foundry's levels, so this
  // is an assignment rather than an approximation. Set before `initialize` so the first
  // uniform update already carries it.
  setLevel(source, level, bandLevel, tiers);

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
