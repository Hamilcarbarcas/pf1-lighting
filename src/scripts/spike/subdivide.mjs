/**
 * Subdivision measurement — DESIGN.md §6.1, §6.2, §9.1.
 *
 * The last unmeasured piece of the renderer. Every churn measurement (§9.2-9.5) timed source
 * construction; none touched the polygon boolean algebra deciding which source applies where. That
 * algebra is now the largest unbudgeted slice.
 *
 * §6.2 says cuts come from suppressor and umbra geometry only, never tier boundaries. With `U` =
 * union of suppressors and `S_k` = one suppressor band, the cells are:
 *
 *   1. `E \ U`      per emitter — the unsuppressed part, rendered by clipping the real source so
 *                   its falloff and animation survive (§6.1 step 2).
 *   2. `E ∩ S_k`    per emitter per band — the reduced-tier part.
 *   3. `U \ ∪E`     one cell — Supernatural Dark fill, a synthetic source (§6.1 step 3).
 *
 * Cell 3 is the one to watch. It needs a union of every emitter polygon on the scene, and those are
 * swept polygons with real vertex counts rather than circles.
 *
 * Two things this harness exists to catch.
 *
 * Multi-path results: `PIXI.Polygon#intersectPolygon` returns `solution[0]` and discards the rest
 * (`polygon-extension.mjs:196`). A difference against a suppressor routinely yields several paths,
 * so the convenience wrapper is unusable here and everything below goes through `ClipperLib`
 * directly. The harness counts extra paths to record how often it would have mattered.
 *
 * Annular cells: a suppressor sitting wholly inside an emitter makes `E \ S` an annulus — two paths,
 * the inner one a hole. A source shape cannot express that, `PolygonMesher` taking a single flat
 * ring (`polygon-mesher.mjs:23`) and generating holes only internally during offsetting. Leaving `E`
 * whole does not dodge it either, since `MAX_COLOR` would let the bright ring win over the
 * reduced-tier cell inside. So annuli must be split, and this counts how often that is needed.
 *
 * Budget from §9.1: the whole field recompute under 16 ms, of which construction costs ~3 ms for 60
 * pooled sources. Call ~8 ms the ceiling for subdivision alone.
 */

import { isSynthetic } from "../constants.mjs";

/** Core uses 100 everywhere it touches Clipper (`common/constants.mjs:2146`). */
const SCALE = 100;

const CT = () => ClipperLib.ClipType;
const PT = () => ClipperLib.PolyType;
const FILL = () => ClipperLib.PolyFillType.pftNonZero;

/* -------------------------------------------- */
/*  Clipper helpers                             */
/* -------------------------------------------- */

/** @returns {ClipperLib.IntPoint[]} */
function toPath(poly) {
  const pts = poly.points ?? poly;
  const path = [];
  for (let i = 0; i < pts.length; i += 2) {
    path.push({ X: Math.round(pts[i] * SCALE), Y: Math.round(pts[i + 1] * SCALE) });
  }
  return path;
}

/**
 * Run one boolean op over path arrays, returning all solution paths.
 *
 * The reason `intersectPolygon` is unusable here — see the file header.
 *
 * @param {ClipperLib.IntPoint[][]} subject
 * @param {ClipperLib.IntPoint[][]} clip
 * @param {number} clipType
 * @returns {ClipperLib.IntPoint[][]}
 */
let opCount = 0;

function boolOp(subject, clip, clipType) {
  opCount++;
  const c = new ClipperLib.Clipper();
  c.AddPaths(subject, PT().ptSubject, true);
  if (clip.length) c.AddPaths(clip, PT().ptClip, true);
  const solution = new ClipperLib.Paths();
  c.Execute(clipType, solution, FILL(), FILL());
  return solution;
}

/**
 * Union a batch of paths in one Execute rather than folding pairwise.
 *
 * Core does the same for region shapes (`documents/region.mjs:224-244`). Pairwise folding re-scales
 * and re-sorts the accumulated result on every step; a single `AddPaths` lets Clipper sweep them all
 * together.
 */
function unionAll(paths) {
  if (paths.length === 0) return [];
  if (paths.length === 1) return [paths[0]];
  return boolOp(paths, [], CT().ctUnion);
}

/**
 * Classify a solution: how many rings, and how many of them are holes.
 *
 * A hole runs opposite to its parent. `ClipperLib.Clipper.Orientation` is the test core uses, so
 * this matches what the renderer would see.
 */
function classify(solution) {
  if (solution.length <= 1) return { paths: solution.length, holes: 0 };
  const outer = ClipperLib.Clipper.Orientation(solution[0]);
  let holes = 0;
  for (let i = 1; i < solution.length; i++) {
    if (ClipperLib.Clipper.Orientation(solution[i]) !== outer) holes++;
  }
  return { paths: solution.length, holes };
}

const vertexCount = (solution) => solution.reduce((n, p) => n + p.length, 0);

/** Do two PIXI.Rectangles overlap? The pre-filter under test in `filtered` mode. */
function boundsOverlap(a, b) {
  return !(a.right < b.left || b.right < a.left || a.bottom < b.top || b.bottom < a.top);
}

function boundsOf(path) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of path) {
    if (p.X < minX) minX = p.X;
    if (p.X > maxX) maxX = p.X;
    if (p.Y < minY) minY = p.Y;
    if (p.Y > maxY) maxY = p.Y;
  }
  return new PIXI.Rectangle(minX, minY, maxX - minX, maxY - minY);
}

/* -------------------------------------------- */
/*  Scene inputs                                */
/* -------------------------------------------- */

/**
 * Real emitter polygons from the live scene.
 *
 * Deliberately the real swept shapes rather than generated circles: vertex count drives Clipper
 * cost, and a wall-heavy scene produces shapes nothing synthetic would imitate. This module's own
 * synthetic sources are excluded (§6.6).
 */
export function emitterPaths() {
  const out = [];
  for (const source of canvas.effects.lightSources) {
    if (isSynthetic(source)) continue;
    if (!source.active || source.isPreview) continue;
    const shape = source.shape;
    if (!shape?.points?.length) continue;
    out.push(toPath(shape));
  }
  return out;
}

/**
 * Suppressor polygons: real darkness sources if the scene has them, otherwise generated
 * ones so the harness runs anywhere.
 *
 * @param {object} options
 * @param {number} options.count - How many to generate if the scene has none
 * @param {number} options.vertices - Ring density for generated suppressors
 * @param {number} options.radius - Radius in grid squares for generated suppressors
 */
export function suppressorPaths({ count = 2, vertices = 24, radius = 4 } = {}) {
  const real = [];
  for (const source of canvas.effects.darknessSources) {
    if (isSynthetic(source)) continue;
    if (!source.active || source.isPreview) continue;
    if (source.shape?.points?.length) real.push(toPath(source.shape));
  }
  if (real.length) return { paths: real, generated: false };

  // Place generated suppressors on top of real lights where possible: overlap is the expensive case
  // and the only one producing interesting cells.
  const lights = [...canvas.effects.lightSources].filter((s) => !isSynthetic(s) && s.active);
  const grid = canvas.grid.size;
  const r = grid * radius;
  const paths = [];
  for (let i = 0; i < count; i++) {
    const host = lights[i % Math.max(1, lights.length)];
    const cx = host?.x ?? canvas.dimensions.sceneX + grid * (6 + i * 5);
    const cy = host?.y ?? canvas.dimensions.sceneY + grid * (6 + i * 5);
    const pts = [];
    for (let v = 0; v < vertices; v++) {
      const a = (v / vertices) * Math.PI * 2;
      pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    paths.push(toPath(new PIXI.Polygon(pts)));
  }
  return { paths, generated: true };
}

/* -------------------------------------------- */
/*  The subdivision itself                      */
/* -------------------------------------------- */

/**
 * Compute one full subdivision and report what it produced.
 *
 * @param {object} options
 * @param {ClipperLib.IntPoint[][]} options.emitters
 * @param {ClipperLib.IntPoint[][]} options.suppressors
 * @param {number} options.bands - Suppressor bands per §3.3.1. Each band is an
 *   independent intersection against every overlapping emitter.
 * @param {"none"|"union"|"tight"} options.filter - How hard to pre-filter before any Clipper work.
 *   See {@link run} for what each level means.
 * @returns {object} Cell counts, annulus counts, and a per-phase timing breakdown
 */
function subdivide({ emitters, suppressors, bands, filter }) {
  const timings = {};
  const t = (key, fn) => {
    const t0 = performance.now();
    const result = fn();
    timings[key] = (timings[key] ?? 0) + (performance.now() - t0);
    return result;
  };

  let cells = 0;
  let annuli = 0;
  let extraPaths = 0;
  let outVertices = 0;
  let pairsTested = 0;
  let pairsClipped = 0;

  // Measured 2026-08-21: every Clipper op on these polygons costs ~0.055 ms regardless of what is
  // clipped against what. So op count is the cost model, and every optimisation here is an op-count
  // reduction. Reported so the model can be checked as the inputs change.
  opCount = 0;

  // --- Union the suppressors. Small N; expected cheap, measured anyway. ---
  const union = t("unionSuppressors", () => unionAll(suppressors));
  if (!union.length) return { cells, annuli, extraPaths, outVertices, pairsTested, pairsClipped, timings };

  // One box around everything (the `union` filter level) versus one box per ring (`tight`). With two
  // suppressors at opposite ends of a map the single box also covers the gap between them, so every
  // emitter in that gap passes the filter and then clips against nothing.
  const unionBounds = boundsOf(union.flat());
  const unionRingBounds = union.map(boundsOf);

  // Bands are concentric fractions of each suppressor. Real bands come from §3.3.1 geometry; scaling
  // here keeps the op count and overlap pattern honest without needing the model layer to exist.
  const bandPaths = [];
  const bandBounds = [];
  for (let b = 0; b < bands; b++) {
    const scale = 1 - b / (bands + 1);
    if (scale >= 1) {
      bandPaths.push(union);
      bandBounds.push(unionRingBounds);
      continue;
    }
    const paths = union.map((path) => {
      const bb = boundsOf(path);
      const cx = bb.x + bb.width / 2;
      const cy = bb.y + bb.height / 2;
      return path.map((p) => ({
        X: Math.round(cx + (p.X - cx) * scale),
        Y: Math.round(cy + (p.Y - cy) * scale),
      }));
    });
    bandPaths.push(paths);
    bandBounds.push(paths.map(boundsOf));
  }

  /** Does this emitter's box touch any box in the list? */
  const touchesAny = (eb, list) => list.some((b) => boundsOverlap(eb, b));

  // --- Cells 1 and 2, per emitter. ---
  const overlapping = [];
  for (const emitter of emitters) {
    pairsTested++;
    const eb = boundsOf(emitter);

    // The pre-filter under test: on a real scene most emitters are nowhere near a suppressor, and a
    // rectangle test is free next to a Clipper sweep.
    const near =
      filter === "none" ||
      (filter === "union" ? boundsOverlap(eb, unionBounds) : touchesAny(eb, unionRingBounds));
    if (!near) {
      cells++; // unaffected — rendered by leaving the real source alone
      continue;
    }
    overlapping.push(emitter);
    pairsClipped++;

    // Cell 1 — the unsuppressed remainder.
    const remainder = t("difference", () => boolOp([emitter], union, CT().ctDifference));
    const cls = classify(remainder);
    if (cls.paths) {
      cells += cls.paths - cls.holes;
      annuli += cls.holes;
      if (cls.paths > 1) extraPaths += cls.paths - 1;
      outVertices += vertexCount(remainder);
    }

    // Cell 2 — one per band. Intersections are two thirds of all ops, so the count lives here: bands
    // are concentric, and an emitter clipping the outer one very often misses the inner.
    for (let b = 0; b < bandPaths.length; b++) {
      const band = bandPaths[b];
      if (filter === "tight" && !touchesAny(eb, bandBounds[b])) continue;
      const inner = t("intersection", () => boolOp([emitter], band, CT().ctIntersection));
      const icls = classify(inner);
      if (!icls.paths) continue;
      cells += icls.paths - icls.holes;
      annuli += icls.holes;
      if (icls.paths > 1) extraPaths += icls.paths - 1;
      outVertices += vertexCount(inner);
    }
  }

  // --- Cell 3 — the Supernatural Dark fill. The suspected hot spot. ---
  const fillInputs = filter === "none" ? emitters : overlapping;
  const emitterUnion = t("unionEmitters", () => unionAll(fillInputs));
  const fill = t("fillDifference", () =>
    emitterUnion.length ? boolOp(union, emitterUnion, CT().ctDifference) : union
  );
  const fcls = classify(fill);
  cells += fcls.paths - fcls.holes;
  annuli += fcls.holes;
  outVertices += vertexCount(fill);

  return { cells, annuli, extraPaths, outVertices, pairsTested, pairsClipped, ops: opCount, timings };
}

/* -------------------------------------------- */
/*  Harness                                     */
/* -------------------------------------------- */

const stats = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    min: +sorted[0].toFixed(2),
    // Median, not mean: one GC spike inverted a ranking in the churn harness and produced a wrong
    // headline. Same guard here.
    median: +sorted[Math.floor(sorted.length / 2)].toFixed(2),
    max: +sorted[sorted.length - 1].toFixed(2),
    mean: +(sum / sorted.length).toFixed(2),
  };
};

/**
 * Measure the subdivision on the current scene.
 *
 * Modes, in increasing order of how hard they pre-filter. All three must produce the same cell
 * count: a mode that is faster and produces fewer cells is dropping real geometry rather than saving
 * work.
 *
 *   naive     No pre-filter. Every emitter clipped against the suppressor union, and the
 *             Supernatural Dark fill unioned over every emitter on the scene.
 *   filtered  One bounding box around the whole suppressor union. Cheap, but with
 *             scattered suppressors that box also covers the empty gaps between them.
 *   tight     One box per union ring, plus a per-band box test before each intersection.
 *             Targets the two thirds of ops that are band intersections.
 *
 * @param {object} [options]
 * @param {number} [options.iterations=20]
 * @param {number} [options.warmup=5] - Untimed iterations before each mode. Measured 2026-08-21:
 *   without this, whichever mode runs first absorbs the JIT warm-up for the rest, and a second
 *   invocation in the same page session came in 1.9× faster than the first on byte-identical
 *   geometry. That swing was larger than every difference between modes.
 * @param {number} [options.suppressors=2] - Generated only if the scene has no real ones
 * @param {number} [options.bands=2] - §3.3.1
 * @param {number} [options.vertices=24] - Ring density for generated suppressors
 * @param {number} [options.radius=4] - Generated suppressor radius, in grid squares. A deeper
 *   darkness is 60 ft — 12 squares on a 5 ft grid — and a large suppressor overlapping most of the
 *   scene's lights is the worst case, so measure there too.
 * @param {("naive"|"filtered"|"tight")[]} [options.modes]
 * @returns {object|null} Timing summary, also printed
 */
export function run({
  iterations = 20,
  warmup = 5,
  suppressors = 2,
  bands = 2,
  vertices = 24,
  radius = 4,
  modes = ["naive", "filtered", "tight"],
} = {}) {
  if (!canvas?.ready) {
    ui.notifications.warn("PF1 Lighting | No active canvas.");
    return null;
  }

  const emitters = emitterPaths();
  const { paths: supPaths, generated } = suppressorPaths({ count: suppressors, vertices, radius });

  if (!emitters.length) {
    ui.notifications.warn("PF1 Lighting | No active light sources on this scene.");
    return null;
  }
  if (!supPaths.length) {
    ui.notifications.warn("PF1 Lighting | No suppressors to subdivide against.");
    return null;
  }

  const emitterVertices = emitters.reduce((n, p) => n + p.length, 0);
  const results = {};

  for (const mode of modes) {
    const totals = [];
    const phases = {};
    let shape = null;
    const filter = mode === "naive" ? "none" : mode === "filtered" ? "union" : "tight";

    for (let i = 0; i < warmup; i++) {
      subdivide({ emitters, suppressors: supPaths, bands, filter });
    }

    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      const r = subdivide({ emitters, suppressors: supPaths, bands, filter });
      totals.push(performance.now() - t0);
      for (const [key, ms] of Object.entries(r.timings)) {
        (phases[key] ??= []).push(ms);
      }
      shape = r;
    }

    results[mode] = {
      mode,
      totalMs: stats(totals),
      phases: Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, stats(v).median])),
      cells: shape.cells,
      annuli: shape.annuli,
      extraPaths: shape.extraPaths,
      outVertices: shape.outVertices,
      clipped: `${shape.pairsClipped}/${shape.pairsTested}`,
      ops: shape.ops,
      msPerOp: +(stats(totals).median / Math.max(shape.ops, 1)).toFixed(3),
      // Cells are geometry, so no pre-filter reduces them, but each still has to become a source.
      // At the pooled ~0.05 ms/source from §9.5 the cell count is a budget line of its own, and on a
      // wide-suppressor scene it outweighs the subdivision that produced it.
      estConstructionMs: +(shape.cells * 0.05).toFixed(1),
      estFrameMs: +(stats(totals).median + shape.cells * 0.05).toFixed(1),
      withinBudget: stats(totals).median + shape.cells * 0.05 <= 16,
    };
  }

  console.error(
    `PF1 Lighting | subdivision — ${emitters.length} emitters (${emitterVertices} verts), ` +
      `${supPaths.length} suppressor${supPaths.length === 1 ? "" : "s"}` +
      `${generated ? " (generated)" : " (real)"}, ${bands} bands × ${iterations} iterations ` +
      `(+${warmup} warmup). 16 ms frame budget, shared with ~0.05 ms/cell construction.`
  );
  console.table(
    Object.values(results).map((r) => ({
      mode: r.mode,
      "median ms": r.totalMs.median,
      "mean ms": r.totalMs.mean,
      "max ms": r.totalMs.max,
      cells: r.cells,
      annuli: r.annuli,
      "extra paths": r.extraPaths,
      "out verts": r.outVertices,
      "emitters clipped": r.clipped,
      ops: r.ops,
      "ms/op": r.msPerOp,
      "est. frame ms": r.estFrameMs,
      budget: r.withinBudget ? "within" : "OVER",
    }))
  );

  for (const r of Object.values(results)) {
    // Plain text alongside the table: console.table renders as a widget that does not survive a
    // copy-paste, and the cell/annulus counts are the point of the run.
    console.error(
      `PF1 Lighting | ${r.mode}: median ${r.totalMs.median} ms (mean ${r.totalMs.mean}, ` +
        `max ${r.totalMs.max}) — ${r.cells} cells, ${r.annuli} annuli, ` +
        `${r.extraPaths} extra paths, ${r.outVertices} out verts, ` +
        `${r.clipped} emitters clipped, ${r.ops} ops @ ${r.msPerOp} ms; ` +
        `+${r.estConstructionMs} ms est. construction = ${r.estFrameMs} ms of 16 — ` +
        `${r.withinBudget ? "within" : "OVER"} budget`
    );
    console.error(`PF1 Lighting | ${r.mode} phase medians (ms):`, JSON.stringify(r.phases));
  }

  const base = results.naive;
  if (base) {
    for (const r of Object.values(results)) {
      if (r === base) continue;
      const factor = +(base.totalMs.median / Math.max(r.totalMs.median, 0.001)).toFixed(2);
      const opFactor = +(base.ops / Math.max(r.ops, 1)).toFixed(2);
      console.error(
        `PF1 Lighting | ${r.mode} is ${factor}× faster than naive (by median), ` +
          `on ${opFactor}× fewer ops`
      );
      // A pre-filter may only remove work, never geometry. Faster with fewer cells is a correctness
      // bug wearing an optimisation's clothes.
      if (r.cells !== base.cells) {
        console.error(
          `PF1 Lighting | WARNING — ${r.mode} produced ${r.cells} cells vs naive's ` +
            `${base.cells}. That pre-filter is not conservative; it is dropping real cells.`
        );
      }
    }
  }

  const annuli = Math.max(...Object.values(results).map((r) => r.annuli));
  if (annuli > 0) {
    console.error(
      `PF1 Lighting | ${annuli} annular cell(s). A source shape cannot hold a hole ` +
        `(polygon-mesher.mjs:23) — these need splitting before they can be rendered.`
    );
  }

  return { emitters: emitters.length, emitterVertices, suppressors: supPaths.length, bands, results };
}
