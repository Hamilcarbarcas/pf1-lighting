/**
 * Attenuated ground: other code dims what an observer sees by a depth mesh. DESIGN.md §4.3.6.
 *
 * Seen ground, not withheld: nothing is carved, explored or hidden from detection. A provider returns
 * triangles with a depth per vertex (0 seen, 1 unseen); `render/attenuated.mjs` lowers that
 * observer's share of the vision mask by it. Caps are areas never dimmed past a given depth.
 */

/** @type {Map<string, {provider: Function, caps: Function|null, pending: Function|null}>} */
const providers = new Map();

let generation = 0;
let capsGeneration = 0;
const failed = new Set();

/** Meshes per source, on `los` identity plus the generation. */
/** @type {WeakMap<object, {los: object, generation: number, value: object[]}>} */
const cache = new WeakMap();

/** Caps per source, on `los` identity plus both generations. */
/** @type {WeakMap<object, {los: object, generation: number, caps: number, value: object[]}>} */
const capsCache = new WeakMap();

const EMPTY = Object.freeze([]);

function warnOnce(key, message, error) {
  if (failed.has(key)) return;
  failed.add(key);
  console.error(`PF1 Lighting | ${message}`, error);
}

/** A provider's output changed for a reason other than an observer moving. */
export function invalidate() {
  generation++;
  capsGeneration++;
  failed.clear();
  if (canvas?.ready) canvas.perception.update({ refreshVision: true });
}

/** Only caps changed: redrawn on the next mask render, without a vision refresh. */
export function invalidateCaps() {
  capsGeneration++;
  hooks.capsChanged?.();
}

/** `render/attenuated.mjs` installs its redraw here; avoids an import cycle. */
export const hooks = { capsChanged: null };

/**
 * @param {string} id
 * @param {(source: PointVisionSource) => {points: ArrayLike<number>, depths: ArrayLike<number>,
 *   indices: ArrayLike<number>}|null} provider
 * @param {object} [options]
 * @param {(source: PointVisionSource) => {polygon: PIXI.Polygon, depth: number}[]|null} [options.caps]
 * @param {(source: PointVisionSource) => boolean} [options.pending]  §9.14
 * @returns {() => void} Unregisters
 */
export function register(id, provider, { caps = null, pending = null } = {}) {
  if (!id || (typeof id !== "string")) throw new Error("attenuated.register: id must be a string");
  if (typeof provider !== "function") throw new Error("attenuated.register: provider must be a function");
  if ((caps !== null) && (typeof caps !== "function")) throw new Error("attenuated.register: caps must be a function");
  if ((pending !== null) && (typeof pending !== "function")) throw new Error("attenuated.register: pending must be a function");
  providers.set(id, { provider, caps, pending });
  invalidate();
  return () => unregister(id);
}

export function unregister(id) {
  if (providers.delete(id)) invalidate();
}

export const hasProviders = () => providers.size > 0;
export const currentGeneration = () => generation;
export const list = () => [...providers].map(([id, { caps, pending }]) => ({ id, caps: !!caps, pending: !!pending }));

/** §9.14: is a provider still working out this observer's newest answer? */
export function isPending(source) {
  for (const [id, { pending }] of providers) {
    try {
      if (pending?.(source)) return true;
    } catch (error) {
      warnOnce(`${id}#pending`, `attenuated pending check "${id}" failed`, error);
    }
  }
  return false;
}

/** Every depth mesh for one observer. Fails open per provider. */
export function collect(source) {
  if (!providers.size || !source?.los) return EMPTY;
  const hit = cache.get(source);
  if (hit && (hit.los === source.los) && (hit.generation === generation)) return hit.value;
  const value = [];
  for (const [id, { provider }] of providers) {
    let mesh;
    try {
      mesh = provider(source);
    } catch (error) {
      warnOnce(id, `attenuated provider "${id}" failed; it dims nothing`, error);
      continue;
    }
    if (!mesh?.points?.length || !mesh.indices?.length) continue;
    if (mesh.depths?.length !== mesh.points.length / 2) continue;
    value.push(mesh);
  }
  cache.set(source, { los: source.los, generation, value: value.length ? value : EMPTY });
  return cache.get(source).value;
}

/** Every cap for one observer: `{polygon, depth}`. Fails open per provider. */
export function collectCaps(source) {
  if (!providers.size || !source?.los) return EMPTY;
  const hit = capsCache.get(source);
  if (hit && (hit.los === source.los) && (hit.generation === generation) && (hit.caps === capsGeneration)) return hit.value;
  const value = [];
  for (const [id, { caps }] of providers) {
    if (!caps) continue;
    let out;
    try {
      out = caps(source);
    } catch (error) {
      warnOnce(`${id}#caps`, `attenuated caps "${id}" failed; nothing is capped`, error);
      continue;
    }
    for (const cap of out ?? []) {
      if ((cap?.polygon?.points?.length >= 6) && Number.isFinite(cap.depth)) value.push(cap);
    }
  }
  capsCache.set(source, { los: source.los, generation, caps: capsGeneration, value: value.length ? value : EMPTY });
  return capsCache.get(source).value;
}
