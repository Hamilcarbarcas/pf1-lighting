/**
 * A read-through cache over `game.settings.get`. DESIGN.md §9.8.1.
 *
 * `game.settings.get` is not a property read. A world-scoped read goes `ClientSettings#get` →
 * `WorldSettings#getSetting`, which is a linear scan over every Setting document in the world,
 * allocating a template string and a closure per call
 * (`client/documents/collections/world-settings.mjs:35`). Measured 2026-08-28 at 14.7 µs per call.
 *
 * Harmless at the rates a settings read is designed for, ruinous here. Every detection-mode
 * `_testPoint` asks `isPerceptionEnabled()` (two reads) and the patched `testInsideLight` asks
 * again, so one visibility refresh over ~1,000 test points made ~4,150 reads, about 61 ms. A drag
 * profile counted 723,202 reads, p95 frame 81 ms with ~90 ms clusters one per refresh — the single
 * largest cost in the module, larger than the whole paint pass.
 *
 * Invalidation takes every route a value can change by rather than trusting one:
 *
 * | Route | Hook |
 * | --- | --- |
 * | world setting updated, by anyone, including remotely | `updateSetting` |
 * | world setting written for the first time | `createSetting` |
 * | client setting written | `clientSettingChanged` |
 *
 * World-scope writes go through `Setting#update` or `Setting.create` (`#setWorld`), so the document
 * hooks fire for a change made on any client — that is what carries a GM's toggle to a player's
 * cache. Client-scope writes never touch a document and fire `clientSettingChanged` instead
 * (`client-settings.mjs:321`). Between them, no write escapes.
 *
 * Invalidation is wholesale, not per key: a few dozen entries, and a settings change is a
 * human-scale event. Partial invalidation would buy nothing and would have to be right about which
 * key a hook names.
 *
 * Booleans and numbers only. Object-valued settings — the preset table, the spill config — would
 * be handed out by reference, and a mutating caller would corrupt every later reader and the
 * stored value. Those keep using `game.settings.get`; none is on a hot path. {@link read} does not
 * enforce this — it is a rule about call sites.
 *
 * A miss caused by a throw is not cached. Reads happen during `init` before every setting is
 * registered, and caching the fallback would pin the wrong value for the session.
 */

import { MODULE_ID } from "./constants.mjs";

/** @type {Map<string, unknown>} */
const cache = new Map();

let hits = 0;
let misses = 0;
let invalidations = 0;

/**
 * A module setting, cached.
 *
 * @param {string} key - The setting key, without the namespace
 * @param {unknown} [fallback] - Returned if the setting is not registered yet. Not cached.
 * @returns {unknown}
 */
export function read(key, fallback) {
  if (cache.has(key)) {
    hits++;
    return cache.get(key);
  }
  let value;
  try {
    value = game.settings.get(MODULE_ID, key);
  } catch {
    // Pre-registration. Answer, but do not remember — see the header.
    return fallback;
  }
  misses++;
  cache.set(key, value);
  return value;
}

/** A cached setting as a strict boolean, which is how nearly every caller wants it. */
export const flag = (key, fallback = false) => read(key, fallback) === true;

/**
 * A cached setting as a finite number, falling back when it is not one.
 *
 * @param {string} key
 * @param {number} fallback
 * @returns {number}
 */
export function number(key, fallback) {
  const value = read(key, fallback);
  return Number.isFinite(value) ? value : fallback;
}

/** Drop everything. Safe at any time — the next read re-fetches. */
export function invalidate() {
  if (cache.size) invalidations++;
  cache.clear();
}

export function registerHooks() {
  // Both document routes plus the client one — see the header table. No write escapes, and a
  // wholesale clear costs one re-read per key.
  Hooks.on("updateSetting", invalidate);
  Hooks.on("createSetting", invalidate);
  Hooks.on("clientSettingChanged", invalidate);
}

/**
 * Debug readout.
 *
 * @remarks
 * `hitRate` near 1 is the point. `invalidations` climbing while nobody touches settings means
 * something is writing one on a loop, turning the cache into pure overhead — the failure worth
 * seeing, and invisible in the timings alone.
 */
export function stats() {
  const total = hits + misses;
  return {
    cached: cache.size,
    hits,
    misses,
    invalidations,
    hitRate: total ? +(hits / total).toFixed(4) : null,
    keys: [...cache.keys()].sort(),
  };
}
