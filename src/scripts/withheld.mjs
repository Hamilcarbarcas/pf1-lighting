/**
 * Withheld regions: other code names areas an observer must not be shown. DESIGN.md §4.3.2.
 *
 * A provider is a function of one vision source returning polygons. This module carves them out of
 * that observer's contribution to the vision mask (`vision/umbra-mask.mjs`) and, where a region is
 * withheld from every layer, paints it as unseen ground (`render/paint.mjs`). It never learns what a
 * region means: astora-mod's wall umbras are the first provider, and the heights behind them stay
 * astora-mod's business (§3.6 keeps this module planar).
 *
 * Top level rather than under `vision/` or `render/`, since both import it.
 *
 * Render only, like §4.3.1's unseen ground: `perceivedTier` and detection never read this.
 */

import { CLIPPER_SCALE, toClipperPath } from "./geometry.mjs";

/** The two graphics a region can be withheld from. */
export const LAYERS = Object.freeze({
  /** `vision.light.mask`, drawn from `visionSource.light`: light perception. */
  LIGHT: "light",
  /** `vision.sight`, drawn from `visionSource.shape`: darkvision and other light-independent sight. */
  SIGHT: "sight",
});

const VALID_LAYERS = new Set(Object.values(LAYERS));

/** @type {Map<string, {provider: Function, layers: Set<string>}>} */
const providers = new Map();

/**
 * Bumped on registration changes and {@link invalidate}. Paint's signature includes it, since a
 * provider's output can change without any observer's `los` being replaced.
 */
let generation = 0;

/** Provider ids that threw during the current generation, so a fault logs once, not per frame. */
const failed = new Set();

/**
 * Per-source cache of collected regions. A provider's contract is "cheap for the same `los`", and
 * converting its polygons to Clipper paths is not, so the conversion is cached here on the same
 * identity plus the generation.
 *
 * @type {WeakMap<object, {los: object, generation: number, value: Collected}>}
 */
const cache = new WeakMap();

/**
 * @typedef {object} Collected
 * @property {object[][]} light   Clipper paths withheld from light perception
 * @property {object[][]} sight   Clipper paths withheld from sight
 * @property {object[][]} unseen  Clipper paths withheld from every layer: unseen ground for paint
 * @property {PIXI.Polygon[]} unseenPolygons  The same, as polygons, for point queries
 * @property {Record<string, number>} byProvider  Polygon counts, for diagnostics
 */

const EMPTY_COLLECTED = Object.freeze({
  light: [], sight: [], unseen: [], unseenPolygons: [], byProvider: Object.freeze({}),
});

/**
 * Register a provider.
 *
 * @param {string} id                Unique, conventionally `${moduleId}.${name}`
 * @param {(source: PointVisionSource) => PIXI.Polygon[]|null} provider
 *   Must be cheap on repeated calls with the same `source.los`. Polygons may overlap; their union is
 *   implied. Null or empty means nothing withheld for this observer.
 * @param {object} [options]
 * @param {string[]} [options.layers]  Subset of {@link LAYERS}; both by default
 * @returns {() => void} Unregisters
 */
export function register(id, provider, { layers = Object.values(LAYERS) } = {}) {
  if (!id || (typeof id !== "string")) throw new Error("withheld.register: id must be a string");
  if (typeof provider !== "function") throw new Error("withheld.register: provider must be a function");
  const set = new Set(layers);
  if (!set.size || [...set].some((l) => !VALID_LAYERS.has(l))) {
    throw new Error(`withheld.register: layers must be a non-empty subset of ${[...VALID_LAYERS].join(", ")}`);
  }
  providers.set(id, { provider, layers: set });
  invalidate();
  return () => unregister(id);
}

/** Remove a provider. */
export function unregister(id) {
  if (providers.delete(id)) invalidate();
}

/**
 * Something other than an observer's `los` changed what a provider returns. Never asks for
 * `initializeLighting`, which would close §8.3's loop.
 */
export function invalidate() {
  generation++;
  failed.clear();
  if (canvas?.ready) canvas.perception.update({ initializeVision: true, refreshVision: true });
}

export const currentGeneration = () => generation;

export const hasProviders = () => providers.size > 0;

/** Registered ids and their layers, for the console. */
export function list() {
  return [...providers].map(([id, { layers }]) => ({ id, layers: [...layers] }));
}

/**
 * Everything withheld from one observer, by layer. Fails open per provider: a throw is logged once
 * per generation and that provider contributes nothing.
 *
 * @param {PointVisionSource} source
 * @returns {Collected}
 */
export function collect(source) {
  if (!providers.size || !source?.los) return EMPTY_COLLECTED;

  const hit = cache.get(source);
  if (hit && (hit.los === source.los) && (hit.generation === generation)) return hit.value;

  const value = { light: [], sight: [], unseen: [], unseenPolygons: [], byProvider: {} };
  for (const [id, { provider, layers }] of providers) {
    let polygons;
    try {
      polygons = provider(source);
    } catch (error) {
      if (!failed.has(id)) {
        failed.add(id);
        console.error(`PF1 Lighting | withheld provider "${id}" failed; it contributes nothing`, error);
      }
      continue;
    }
    if (!polygons?.length) continue;

    const everyLayer = layers.size === VALID_LAYERS.size;
    let count = 0;
    for (const polygon of polygons) {
      const path = toClipperPath(polygon, CLIPPER_SCALE);
      if (path.length < 3) continue;
      if (layers.has(LAYERS.LIGHT)) value.light.push(path);
      if (layers.has(LAYERS.SIGHT)) value.sight.push(path);
      if (everyLayer) {
        value.unseen.push(path);
        value.unseenPolygons.push(polygon instanceof PIXI.Polygon ? polygon : new PIXI.Polygon(polygon.points));
      }
      count++;
    }
    if (count) value.byProvider[id] = count;
  }

  cache.set(source, { los: source.los, generation, value });
  return value;
}

/**
 * Is this point withheld from every layer for this observer? Any polygon containing it counts,
 * which is the implied union.
 */
export function unseenFor(source, point) {
  for (const polygon of collect(source).unseenPolygons) {
    if (polygon.contains(point.x, point.y)) return true;
  }
  return false;
}
