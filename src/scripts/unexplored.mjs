/**
 * Unexplored regions: other code names parts of an observer's view that show but are never written
 * to fog. DESIGN.md §4.3.4.
 *
 * A sibling of `withheld.mjs` and `revealed.mjs`. astora-mod's roofs are the first provider: a roof
 * below an observer's eye is seen, but the room under it is not, and fog's exploration is planar, so
 * without this the room was recorded as explored by anyone who flew over it. The observer's view is
 * split (`vision/umbra-mask.mjs`): the part inside these regions moves from the live light-perception
 * and sight graphics to their `.preview` children, which show but which fog's commit hides.
 *
 * Render only: what shows, what is lit, paint, and detection are unchanged.
 */

import { createRegistry, LAYERS } from "./region-registry.mjs";

export { LAYERS };

const registry = createRegistry("unexplored");

/**
 * Register a provider. Same contract as `withheld.register`.
 *
 * @param {string} id
 * @param {(source: PointVisionSource) => PIXI.Polygon[]|null} provider
 * @param {object} [options]
 * @param {string[]} [options.layers]  Subset of {@link LAYERS}; both by default
 * @returns {() => void} Unregisters
 */
export const register = registry.register;

export const unregister = registry.unregister;

/** Something other than an observer's `los` changed what a provider returns. */
export const invalidate = registry.invalidate;

export const currentGeneration = registry.currentGeneration;

export const hasProviders = registry.hasProviders;

export const list = registry.list;

/** Everything kept out of fog for one observer, by layer: `light`, `sight`, and `every`. */
export const collect = registry.collect;
