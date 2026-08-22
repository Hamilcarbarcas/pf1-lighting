/**
 * Vertical slice, step 5 — source churn measurement. DESIGN.md §8.1, §9.2-9.4.
 *
 * The renderer design (§6.1) creates and destroys synthetic sources on every field
 * recompute. Measurements so far:
 *
 *   empty scene   ~0.12 ms/source
 *   town scene    ~0.60 ms/source   — wall sweeps
 *   direct mode   ~0.34 ms/source   — skipping the sweep saves ~40%, not ~100%
 *
 * So the sweep is *not* the dominant cost. This harness isolates what is.
 *
 * Modes:
 *   sweep      Foundry's normal path. What a real placed light costs.
 *   constrain  Sweep, then narrow with Clipper. The §6.1 step-2 cost.
 *   direct     Supply the polygon, skip the sweep. The §6.1 step-3 cost.
 *   reuse      Re-`initialize()` existing sources instead of create/destroy. Isolates
 *              construction, mesh allocation and shader setup from geometry work.
 *
 * Budget to beat, from §9.1: a full field recompute under 16 ms.
 */

import * as synthetic from "./synthetic.mjs";

const stats = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    min: +sorted[0].toFixed(2),
    median: +sorted[Math.floor(sorted.length / 2)].toFixed(2),
    max: +sorted[sorted.length - 1].toFixed(2),
    mean: +(sum / sorted.length).toFixed(2),
  };
};

/** Scatter positions deterministically across the scene. */
function positionFor(n) {
  const { sceneWidth, sceneHeight, sceneX, sceneY } = canvas.dimensions;
  return {
    x: sceneX + ((n * 137) % Math.max(1, sceneWidth)),
    y: sceneY + ((n * 271) % Math.max(1, sceneHeight)),
  };
}

function measureCreateDestroy(mode, count, iterations) {
  const grid = canvas.grid.size;
  const spawnTimes = [];
  const clearTimes = [];

  for (let i = 0; i < iterations; i++) {
    // redraw: false throughout — a perception update per source would measure
    // Foundry's refresh queue rather than the cost of building sources.
    const t0 = performance.now();
    for (let n = 0; n < count; n++) {
      const { x, y } = positionFor(n);
      synthetic.spawn({
        id: `churn-${n}`,
        x,
        y,
        dim: grid * 4,
        bright: grid * 2,
        constrainTo: mode === "constrain" ? new PIXI.Circle(x, y, grid * 3) : null,
        polygon: mode === "direct" ? synthetic.ngon(x, y, grid * 3) : null,
        redraw: false,
      });
    }
    spawnTimes.push(performance.now() - t0);

    const t1 = performance.now();
    synthetic.clear({ redraw: false });
    clearTimes.push(performance.now() - t1);
  }

  return { spawnMs: stats(spawnTimes), clearMs: stats(clearTimes) };
}

/**
 * Re-initialise a fixed pool of sources rather than recreating them.
 *
 * If this is much cheaper than `direct`, the cost is construction and mesh/shader
 * allocation, and the renderer should pool sources rather than churn them.
 */
function measureReuse(count, iterations) {
  const grid = canvas.grid.size;
  const spawnTimes = [];

  // Build the pool once, outside the timed section.
  for (let n = 0; n < count; n++) {
    const { x, y } = positionFor(n);
    synthetic.spawn({
      id: `churn-${n}`,
      x,
      y,
      dim: grid * 4,
      bright: grid * 2,
      polygon: synthetic.ngon(x, y, grid * 3),
      redraw: false,
    });
  }
  const pool = synthetic.list();

  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    for (let n = 0; n < pool.length; n++) {
      const { x, y } = positionFor(n + i); // move them so the work is real
      const source = pool[n];
      source.directPolygon = synthetic.ngon(x, y, grid * 3);
      source.initialize({ x, y, radius: grid * 4, dim: grid * 4, bright: grid * 2 });
    }
    spawnTimes.push(performance.now() - t0);
  }

  synthetic.clear({ redraw: false });
  return { spawnMs: stats(spawnTimes), clearMs: stats([0]) };
}

/**
 * Compare source-construction paths.
 *
 * @param {object} [options]
 * @param {number} [options.count=30] - Sources per batch
 * @param {number} [options.iterations=20] - Batches per mode
 * @param {("sweep"|"constrain"|"direct"|"reuse")[]} [options.modes]
 * @param {boolean} [options.softEdges] - Force `canvas.performance.lightSoftEdges` for
 *   the duration. Pass false to isolate the cost of `PolygonMesher`'s Clipper
 *   offsetting passes (`ceil(|EDGE_OFFSET| / 3)` of them per source).
 * @returns {object} Timing summary, also printed to the console
 */
export function run({
  count = 30,
  iterations = 20,
  modes = ["sweep", "constrain", "direct", "reuse"],
  softEdges,
} = {}) {
  if (!canvas?.ready) {
    ui.notifications.warn("PF1 Lighting | No active canvas.");
    return null;
  }

  const priorSoftEdges = canvas.performance.lightSoftEdges;
  if (softEdges !== undefined) canvas.performance.lightSoftEdges = softEdges;
  // Captured before the finally block restores it — reporting the restored value made
  // every run claim softEdges=true regardless of what was measured.
  const measuredSoftEdges = canvas.performance.lightSoftEdges;

  const results = {};
  try {
    for (const mode of modes) {
      const raw = mode === "reuse" ? measureReuse(count, iterations) : measureCreateDestroy(mode, count, iterations);
      results[mode] = {
        mode,
        ...raw,
        // Median, not mean — a single GC spike otherwise dominates and inverts the
        // ranking. That bug produced a misleading headline on the first run.
        perSourceMs: +(raw.spawnMs.median / count).toFixed(3),
        withinBudget: raw.spawnMs.median <= 16,
      };
    }
  } finally {
    canvas.performance.lightSoftEdges = priorSoftEdges;
    synthetic.refresh();
  }

  const table = Object.values(results).map((r) => ({
    mode: r.mode,
    "median ms": r.spawnMs.median,
    "mean ms": r.spawnMs.mean,
    "max ms": r.spawnMs.max,
    "per source ms": r.perSourceMs,
    budget: r.withinBudget ? "within" : "OVER",
  }));

  console.error(
    `PF1 Lighting | churn — ${count} sources × ${iterations} iterations, ` +
      `softEdges=${measuredSoftEdges} (§9.1 target 16 ms)`
  );
  console.table(table);

  const base = results.sweep ?? results.direct;
  for (const r of Object.values(results)) {
    if (r === base) continue;
    const factor = +(base.perSourceMs / Math.max(r.perSourceMs, 0.0001)).toFixed(2);
    console.error(`PF1 Lighting | ${r.mode} is ${factor}× ${base.mode} per source (by median)`);
  }

  return { count, iterations, budgetMs: 16, softEdges: measuredSoftEdges, results };
}
