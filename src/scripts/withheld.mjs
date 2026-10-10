/**
 * Withheld regions: other code names areas an observer must not be shown. DESIGN.md §4.3.2.
 *
 * A provider is a function of one vision source returning polygons. This module carves them out of
 * that observer's contribution to the vision mask (`vision/umbra-mask.mjs`) and, where a region is
 * withheld from every layer, paints it as unseen ground (`render/paint.mjs`). It never learns what a
 * region means: astora-mod's wall umbras are the first provider, and the heights behind them stay
 * astora-mod's business (§3.6 keeps this module planar).
 *
 * The registry itself is shared with `revealed.mjs` (§4.3.3): `region-registry.mjs`.
 *
 * Render only, like §4.3.1's unseen ground: `perceivedTier` and detection never read this.
 */

import { createRegistry, LAYERS } from "./region-registry.mjs";

export { LAYERS };

const registry = createRegistry("withheld");

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
export const register = registry.register;

/** Remove a provider. */
export const unregister = registry.unregister;

/**
 * Something other than an observer's `los` changed what a provider returns. Never asks for
 * `initializeLighting`, which would close §8.3's loop.
 */
export const invalidate = registry.invalidate;

export const currentGeneration = registry.currentGeneration;

export const hasProviders = registry.hasProviders;

/** Registered ids and their layers, for the console. */
export const list = registry.list;

/**
 * Everything withheld from one observer, by layer: `light`, `sight`, and `every` (withheld from every
 * layer, which is what "unseen" means for paint). Fails open per provider.
 */
export const collect = registry.collect;

/** Is this point withheld from every layer for this observer? Non-zero winding, the carve's own rule. */
export const unseenFor = registry.covers;
