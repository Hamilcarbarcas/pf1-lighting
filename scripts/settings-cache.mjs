/**
 * A read-through cache over `game.settings.get`. DESIGN.md §9.8.1.
 *
 * ## Why this exists — measured 2026-08-28
 *
 * `game.settings.get` is not a property read. For a **world**-scoped setting it goes
 * `ClientSettings#get` → `WorldSettings#getSetting`, and that method is
 *
 * ```js
 * getSetting(key, user=null) { return this.find(s => (s.key === key) && (s.user === user)); }
 * ```
 *
 * — a **linear scan over every Setting document in the world**, allocating a template string and
 * a closure on each call (`client/documents/collections/world-settings.mjs:35`). Measured on
 * Hamilcarbarcas's world at **14.7 µs per call**.
 *
 * That is harmless at the call rates a settings read is designed for and ruinous at ours. Every
 * detection-mode `_testPoint` asks `isPerceptionEnabled()`, which is two reads, and the patched
 * `testInsideLight` asks again — so one visibility refresh over ~1,000 test points made **~4,150
 * reads**, or about **61 ms**. A drag profile counted 723,202 reads and put the p95 frame at
 * 81 ms with a cluster of ~90 ms frames, one per visibility refresh. It was the single largest
 * cost in the module, larger than the whole paint pass.
 *
 * ## Correctness
 *
 * The cache is only as good as its invalidation, so it takes **every** route a value can change
 * by, rather than trusting one:
 *
 * | Route | Hook |
 * | --- | --- |
 * | world setting updated, by anyone, including remotely | `updateSetting` |
 * | world setting written for the first time | `createSetting` |
 * | client setting written | `clientSettingChanged` |
 *
 * World-scope writes go through `Setting#update` or `Setting.create` (`#setWorld`), so the
 * document hooks fire for a change made on any client — which is what makes a GM's toggle reach a
 * player's cache. Client-scope writes never touch a document and fire `clientSettingChanged`
 * instead (`client-settings.mjs:321`). Between them there is no way to write a setting that this
 * does not see.
 *
 * Invalidation is **wholesale**, not per key. The cache holds a few dozen entries and a settings
 * change is a human-scale event; a partial invalidation would buy nothing and would have to be
 * right about which key a hook names.
 *
 * ## What it is not for
 *
 * **Booleans and numbers only.** An object-valued setting — the preset table, the spill config —
 * would be handed out by reference, and a caller that mutated it would corrupt every later reader
 * *and* the stored value. Those keep going through `game.settings.get`, which is fine: none of
 * them is read on a hot path. {@link read} does not enforce this; it is a rule about call sites.
 *
 * A miss caused by a **throw** is not cached. Reads happen during `init` before every setting is
 * registered, and caching the fallback there would pin the wrong value for the session.
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
 * @param {unknown} [fallback] - Returned if the setting is not registered yet. **Not cached.**
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
  // Both document routes plus the client one. See the table in the header; between them there is
  // no way to write a setting that this misses, and a wholesale clear costs one re-read per key.
  Hooks.on("updateSetting", invalidate);
  Hooks.on("createSetting", invalidate);
  Hooks.on("clientSettingChanged", invalidate);
}

/**
 * Debug readout.
 *
 * @remarks
 * `hitRate` near 1 is the whole point. `invalidations` climbing while nobody is touching settings
 * would mean something is writing one on a loop, which would turn this into pure overhead — that
 * is the failure worth being able to see, and it is invisible from the timings alone.
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
