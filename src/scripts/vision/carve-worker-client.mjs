/**
 * The main thread's side of carve-worker.js. DESIGN.md §9.14.
 *
 * One job at a time, and per observer only the newest job waits, since an older one would be stale
 * before it started.
 */

import { MODULE_ID } from "../constants.mjs";
import { CLIPPER_SCALE } from "../geometry.mjs";

const WORKER_PATH = `modules/${MODULE_ID}/src/scripts/vision/carve-worker.js`;

/** A job this late means the worker is stuck, and the observer's view would never update. */
const WATCHDOG_MS = 3000;
/** Rings the worker may hold before both sides start over. */
const MAX_RINGS = 4096;

let worker = null;
let failed = false;
let nextJob = 1;
let nextRing = 1;
let ringsSent = 0;
let ringIds = new WeakMap();
let inFlight = null;
let watchdog = null;
const waiting = new Map();
const stats = { submitted: 0, superseded: 0, completed: 0, failures: 0, lastMs: 0, maxMs: 0, totalMs: 0 };

function start() {
  if (worker || failed) return !!worker;
  try {
    const url = new URL(foundry.utils.getRoute(WORKER_PATH), window.location.href).href;
    worker = new Worker(url, { name: `${MODULE_ID} view cut` });
    worker.onmessage = onMessage;
    worker.onerror = (event) => fail(event.message ?? "worker error");
    worker.onmessageerror = () => fail("unreadable worker message");
    return true;
  } catch (error) {
    fail(error.message);
    return false;
  }
}

/** Give up on the worker: everything outstanding is told to do its own work. */
function fail(reason) {
  console.error(`PF1 Lighting | view cut worker failed (${reason}); cutting on the main thread.`);
  failed = true;
  stats.failures++;
  clearTimeout(watchdog);
  worker?.terminate();
  worker = null;
  const outstanding = [...(inFlight ? [inFlight] : []), ...waiting.values()];
  inFlight = null;
  waiting.clear();
  for (const job of outstanding) job.done(null);
}

function onMessage({ data }) {
  const job = inFlight;
  if (!job || (data.id !== job.id)) return;
  clearTimeout(watchdog);
  inFlight = null;
  if (data.error) return fail(data.error);
  stats.completed++;
  stats.lastMs = +data.ms.toFixed(1);
  stats.maxMs = Math.max(stats.maxMs, stats.lastMs);
  stats.totalMs += data.ms;
  job.done({ light: data.light, sight: data.sight, ms: data.ms });
  sendNext();
}

function forgetRings() {
  ringIds = new WeakMap();
  ringsSent = 0;
  worker?.postMessage({ type: "clear" });
}

// Packed when sent, not when submitted, so a superseded job costs nothing.
function send(job) {
  if (ringsSent > MAX_RINGS) forgetRings();
  const defIds = [];
  const fresh = [];
  const buffers = [];
  const ringId = (path) => {
    let id = ringIds.get(path);
    if (id === undefined) {
      id = nextRing++;
      ringIds.set(path, id);
      ringsSent++;
      defIds.push(id);
      fresh.push(path);
    }
    return id;
  };
  const layer = ({ polygon, removed, keep }) => {
    const flat = polygon ? new Float64Array(polygon.points) : null;
    if (flat) buffers.push(flat.buffer);
    return { polygon: flat, removed: removed.map(ringId), keep: keep.map(ringId) };
  };
  const light = layer(job.light);
  const sight = layer(job.sight);
  // New rings share one buffer: transferring one per ring costs more than the rest of the send.
  const sizes = new Uint32Array(fresh.length);
  let total = 0;
  fresh.forEach((path, i) => total += (sizes[i] = path.length * 2));
  const data = new Float64Array(total);
  let at = 0;
  for (const path of fresh) {
    for (let i = 0; i < path.length; i++) {
      data[at++] = path[i].X;
      data[at++] = path[i].Y;
    }
  }
  buffers.push(sizes.buffer, data.buffer);
  inFlight = job;
  watchdog = setTimeout(() => fail("no answer"), WATCHDOG_MS);
  worker.postMessage({ id: job.id, scale: CLIPPER_SCALE, light, sight, defIds, sizes, data }, buffers);
}

function sendNext() {
  if (inFlight || !worker) return;
  const next = waiting.entries().next();
  if (next.done) return;
  const [key, job] = next.value;
  waiting.delete(key);
  send(job);
}

/** Can a job be sent? Starts the worker on first use. */
export const available = () => start();

/**
 * Cut one observer's view off the main thread.
 *
 * @param {object} key  Whose job this is; a newer job with the same key replaces one still waiting
 * @param {object} job
 * @param {{polygon: PIXI.Polygon|null, removed: object[][], keep: object[][]}} job.light  Rings are Clipper paths
 * @param {{polygon: PIXI.Polygon|null, removed: object[][], keep: object[][]}} job.sight
 * @param {(result: {light: object, sight: object, ms: number}|null) => void} done  Each layer is
 *   `{live: Float64Array[]|null, preview: Float64Array[]}` in canvas coordinates; null when the worker failed
 */
export function submit(key, { light, sight }, done) {
  stats.submitted++;
  if (waiting.has(key)) stats.superseded++;
  waiting.delete(key);
  waiting.set(key, { id: nextJob++, light, sight, done });
  sendNext();
}

/** The scene is going: drop what's waiting and the rings the worker holds. */
export function reset() {
  waiting.clear();
  forgetRings();
}

export const workerStats = () => ({
  ...stats,
  avgMs: stats.completed ? +(stats.totalMs / stats.completed).toFixed(1) : 0,
  totalMs: Math.round(stats.totalMs),
  running: !!worker,
  failed,
});
