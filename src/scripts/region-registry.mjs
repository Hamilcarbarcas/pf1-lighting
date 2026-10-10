/**
 * Provider registries for per-observer regions: `withheld` (carved out of a view, DESIGN.md §4.3.2)
 * and `revealed` (added to one, §4.3.3). Both share the same contract, caching, and failure
 * handling, so they are built from one factory.
 *
 * A provider is a function of one vision source returning polygons. This module never learns what
 * a region means; the heights behind it stay the consumer's business (§3.6 keeps this module planar).
 */

import { CLIPPER_SCALE, toClipperPath } from "./geometry.mjs";

/** The two graphics a region applies to. */
export const LAYERS = Object.freeze({
  /** `vision.light.mask`, drawn from `visionSource.light`: light perception. */
  LIGHT: "light",
  /** `vision.sight`, drawn from `visionSource.shape`: darkvision and other light-independent sight. */
  SIGHT: "sight",
});

const VALID_LAYERS = new Set(Object.values(LAYERS));

/** Signed crossings of a ring around a point: +1 per counter-clockwise turn, −1 per clockwise. */
function windingNumber(points, x, y) {
  let winding = 0;
  const n = points.length;
  for (let i = 0; i < n; i += 2) {
    const x1 = points[i];
    const y1 = points[i + 1];
    const x2 = points[(i + 2) % n];
    const y2 = points[(i + 3) % n];
    const side = ((x2 - x1) * (y - y1)) - ((x - x1) * (y2 - y1));
    if (y1 <= y) {
      if ((y2 > y) && (side > 0)) winding++;
    } else if ((y2 <= y) && (side < 0)) winding--;
  }
  return winding;
}

/**
 * @typedef {object} Collected
 * @property {object[][]} light   Clipper paths for light perception
 * @property {(number|null)[]} lightElevations  Per `light` path, the `elevation` its polygon carried
 *   (the height of the surface it shows), or null; `revealed` uses it (§4.3.3)
 * @property {object[][]} sight   Clipper paths for sight
 * @property {object[][]} every   Clipper paths registered for every layer
 * @property {PIXI.Polygon[]} everyPolygons  The same, as polygons, for point queries
 * @property {Record<string, number>} byProvider  Polygon counts, for diagnostics
 */

const EMPTY_COLLECTED = Object.freeze({
  light: [], lightElevations: [], sight: [], every: [], everyPolygons: [], byProvider: Object.freeze({}),
});

/**
 * One registry.
 *
 * @param {string} name  For messages: "withheld" or "revealed"
 */
export function createRegistry(name) {
  /** @type {Map<string, {provider: Function, layers: Set<string>}>} */
  const providers = new Map();

  // Bumped on registration changes and invalidate(); paint's signature includes it.
  let generation = 0;

  // Provider ids that threw during the current generation, so a fault logs once, not per frame.
  const failed = new Set();

  // Collected paths per source, on `los` identity plus the generation: a provider's contract is
  // "cheap for the same `los`", and converting its polygons to Clipper paths is not.
  /** @type {WeakMap<object, {los: object, generation: number, value: Collected}>} */
  const cache = new WeakMap();

  /**
   * Something other than an observer's `los` changed what a provider returns. Never asks for
   * `initializeLighting`, which would close §8.3's loop.
   */
  function invalidate() {
    generation++;
    failed.clear();
    if (canvas?.ready) canvas.perception.update({ initializeVision: true, refreshVision: true });
  }

  function register(id, provider, { layers = Object.values(LAYERS) } = {}) {
    if (!id || (typeof id !== "string")) throw new Error(`${name}.register: id must be a string`);
    if (typeof provider !== "function") throw new Error(`${name}.register: provider must be a function`);
    const set = new Set(layers);
    if (!set.size || [...set].some((l) => !VALID_LAYERS.has(l))) {
      throw new Error(`${name}.register: layers must be a non-empty subset of ${[...VALID_LAYERS].join(", ")}`);
    }
    providers.set(id, { provider, layers: set });
    invalidate();
    return () => unregister(id);
  }

  function unregister(id) {
    if (providers.delete(id)) invalidate();
  }

  /** Everything registered for one observer, by layer. Fails open per provider. */
  function collect(source) {
    if (!providers.size || !source?.los) return EMPTY_COLLECTED;

    const hit = cache.get(source);
    if (hit && (hit.los === source.los) && (hit.generation === generation)) return hit.value;

    const value = { light: [], lightElevations: [], sight: [], every: [], everyPolygons: [], byProvider: {} };
    for (const [id, { provider, layers }] of providers) {
      let polygons;
      try {
        polygons = provider(source);
      } catch (error) {
        if (!failed.has(id)) {
          failed.add(id);
          console.error(`PF1 Lighting | ${name} provider "${id}" failed; it contributes nothing`, error);
        }
        continue;
      }
      if (!polygons?.length) continue;

      const everyLayer = layers.size === VALID_LAYERS.size;
      let count = 0;
      for (const polygon of polygons) {
        const path = toClipperPath(polygon, CLIPPER_SCALE);
        if (path.length < 3) continue;
        if (layers.has(LAYERS.LIGHT)) {
          value.light.push(path);
          value.lightElevations.push(Number.isFinite(polygon.elevation) ? polygon.elevation : null);
        }
        if (layers.has(LAYERS.SIGHT)) value.sight.push(path);
        if (everyLayer) {
          value.every.push(path);
          value.everyPolygons.push(polygon instanceof PIXI.Polygon ? polygon : new PIXI.Polygon(polygon.points));
        }
        count++;
      }
      if (count) value.byProvider[id] = count;
    }

    cache.set(source, { los: source.los, generation, value });
    return value;
  }

  /**
   * Is this point inside the every-layer regions for this observer? Non-zero winding summed over every
   * polygon, the rule the carve's Clipper ops apply: overlapping regions union, and a hole wound
   * against its outer ring cancels it.
   */
  function covers(source, point) {
    let winding = 0;
    for (const polygon of collect(source).everyPolygons) winding += windingNumber(polygon.points, point.x, point.y);
    return winding !== 0;
  }

  return {
    register,
    unregister,
    invalidate,
    collect,
    covers,
    currentGeneration: () => generation,
    hasProviders: () => providers.size > 0,
    /** Registered ids and their layers, for the console. */
    list: () => [...providers].map(([id, { layers }]) => ({ id, layers: [...layers] })),
  };
}
