/**
 * Revealed regions: other code names areas an observer is shown beyond its `los`. DESIGN.md §4.3.3.
 *
 * The mirror of `withheld.mjs`. astora-mod's tile reveals are the first provider: the part of a
 * raised tile seen over a wall that wall-height's flat sweep stops at. The rings are drawn into the
 * observer's light-perception and sight `.preview` graphics (`vision/umbra-mask.mjs`), so light still
 * decides what shows, and fog never explores them, since its commit hides the preview graphics.
 * Paint stops painting them as unseen ground (`render/paint.mjs`).
 *
 * Render only: `perceivedTier` and detection never read this.
 */

import { createRegistry, LAYERS } from "./region-registry.mjs";

export { LAYERS };

const registry = createRegistry("revealed");

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

/** Everything revealed to one observer, by layer: `light`, `sight`, and `every`. */
export const collect = registry.collect;

/** Is this point revealed on every layer to this observer? */
export const revealedFor = registry.covers;
