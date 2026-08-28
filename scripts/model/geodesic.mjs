/**
 * **Geodesic distance on a grid** — the quantity §3.4 has been approximating. DESIGN.md §3.4.1.
 *
 * Patrick, 2026-08-27: *"the current implementation of determining the regions to brighten and by
 * how much are pretty broken right now, so I want to explore alternative means."*
 *
 * ## What was actually wrong
 *
 * The built construction is `band_k = ((white ⊕ k·d) ∩ bend ∩ region) \ band_{k-1}`. A Minkowski
 * dilation measures **Euclidean** distance and a sweep union measures **reachability**, so a band's
 * brightness is decided by straight-line distance and then merely *masked* by what can be seen.
 * Light that turns a corner therefore arrives having been charged for the distance **through the
 * wall**.
 *
 * Every symptom follows from that one substitution. Bands bend around exactly one corner, because a
 * second bend would need a second visibility union. `MAX_CORNERS` and a relevance heuristic exist to
 * pick which corners matter — a hand-rolled shortest-path search with a cap on it. `probeToward`
 * exists because containment at a sweep's own vertex is degenerate. And the L-shaped-room slivers
 * are `vis`/`bend` being cut against the region outline.
 *
 * The quantity all of that is reaching for is **geodesic distance**: the length of the shortest path
 * from the aperture through open floor. Given it as a field, `tier = spillTier − steps(d)` is the
 * entire rule, and corner bending, corner *selection*, multiple bends and the region clip all stop
 * being cases at all.
 *
 * ## Fast marching, not flood fill
 *
 * Flood fill (BFS, uniform cost) and 8-neighbour Dijkstra both measure distance in discrete steps,
 * and it shows two ways:
 *
 * - **Anisotropy.** 8-neighbour chamfer distance is up to 7.6% long on the diagonals, so a 40 ft
 *   contour is off by 3 ft *depending on direction* — a third of a band. The boundary comes out
 *   visibly octagonal, and blurring it leaves an octagon with soft edges.
 * - **The diagonal leak.** A diagonal step between two diagonally-adjacent blocked cells squeezes
 *   through a wall corner. That is light passing through a wall, which is the one failure this
 *   module cannot ship.
 *
 * {@link march} solves the eikonal equation |∇d| = 1/F by the fast marching method instead. The
 * update is **4-neighbour and upwind**, so there is no diagonal to leak through, and it solves the
 * local quadratic rather than taking a step, so it is more accurate than 16-neighbour Dijkstra for
 * less code.
 *
 * ## Measured — 2026-08-27
 *
 * Against an analytic point source in open field, worst relative error over a 100–800 px annulus.
 * On-axis is exact in every variant; the diagonal is where a grid scheme shows its metric.
 *
 * | scheme                     | on-axis | on-diagonal |
 * |----------------------------|---------|-------------|
 * | first order                | 0.00%   | 6.92%       |
 * | first order + 8-cell collar| 0.00%   | 1.69%       |
 * | **second order**           | 0.00%   | **2.47%**   |
 * | second order + collar      | 0.00%   | 2.23%       |
 *
 * First order is no better than the 8-neighbour Dijkstra it was chosen over — the error is the
 * point-source singularity, not the neighbourhood — and seeding an analytic collar of exact
 * distances only pushes that singularity outward, buying accuracy logarithmically for cells
 * linearly. The second-order one-sided difference gets there in the update instead, and once it is
 * in, **the collar buys 0.24%**. So the seeding stays as simple as it looks: one cell per sample
 * across the opening, no collar, no analytic initialisation. 2.47% of a 70 ft ladder is 1.7 ft,
 * comfortably inside a 10 ft band and inside the field blur.
 *
 * Cost, warm, 70 ft ladder with obstacles, per aperture:
 *
 * | cell size        | grid   | visited | best   |
 * |------------------|--------|---------|--------|
 * | 50 px (2.5 ft)   |  3,596 |   1,623 | 0.25 ms|
 * | **25 px (1.25 ft)** | 13,908 | 8,269 | **1.70 ms** |
 * | 12.5 px          | 54,692 |  38,818 | 8.90 ms|
 *
 * Against ~3.5 ms of `ClockwiseSweepPolygon` per window today (§9.4) that is a factor of two, not
 * the order of magnitude first estimated — the estimate assumed a cheaper per-cell constant than a
 * second-order solve with a heap actually has. It is still the cheaper construction, it is charged
 * on the same clock (rebuild, never per frame), and unlike the sweeps it has **no term that grows
 * with wall count**: `MAX_CORNERS` exists because the old cost did.
 *
 * The 12.5 px row is why {@link DEFAULT_CELL} is 25 and why halving it is a decision rather than a
 * default: four times the cells, five times the time.
 *
 * ## What lives here and what does not
 *
 * Pure model arithmetic: no PIXI, no rendering, no settings beyond the cell size, and no knowledge
 * of what an aperture *is*. `model/spill.mjs` decides which edges are windows and what tier they
 * carry; this turns a segment and a wall set into a distance field. The contour step that turns a
 * field back into polygons for `areas` is deliberately **not** here yet — see the note on
 * {@link ladder}.
 */

import { MODULE_ID } from "../constants.mjs";
import { TIER } from "./tiers.mjs";

export const SETTING_CELL = "spillCellSize";

/**
 * Grid resolution in scene pixels.
 *
 * @remarks
 * 25 px is a quarter of a standard grid square — 1.25 ft at 5 ft/square — so a 10 ft band is eight
 * cells across and a 5 ft doorway is four. Patrick, 2026-08-27: *"Let's start with 25 pixel cells
 * and see how it looks."*
 *
 * **What this costs is contour precision, not floor.** Walls are cut links rather than blocked cells
 * ({@link cutLinks}), so no ground is eaten at any resolution and there is no minimum passable gap
 * worth speaking of. What remains is that a brightness boundary can only be placed to within half a
 * cell — 0.6 ft here — which is far below the transition width every boundary is drawn with anyway.
 *
 * The earlier concern, that a coarse grid closes a narrow doorway, belonged to the blocked-cell
 * design and went with it.
 */
const DEFAULT_CELL = 25;

export function cellSize() {
  try {
    const value = Number(game.settings.get(MODULE_ID, SETTING_CELL));
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_CELL;
  } catch {
    return DEFAULT_CELL;
  }
}

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTING_CELL, {
    name: "Spill grid resolution",
    hint:
      "How finely the spill's distance field is sampled, in pixels. Smaller places the edges " +
      "between brightnesses more precisely and costs about five times as much for each halving. " +
      "The symptom of too coarse is a brightness edge that does not quite follow the wall it " +
      "should be running along.",
    scope: "world",
    config: false,
    type: Number,
    default: DEFAULT_CELL,
    range: { min: 5, max: 100, step: 5 },
    onChange: () => Hooks.callAll(`${MODULE_ID}.geodesicResolutionChanged`),
  });
}

/* -------------------------------------------- */
/*  The grid                                    */
/* -------------------------------------------- */

/**
 * A cell grid covering `rect`, snapped outward to cell multiples.
 *
 * @remarks
 * Snapped rather than fitted so that two grids built from overlapping rects agree about where the
 * cell boundaries are. Nothing depends on that yet — each aperture gets its own grid — but the
 * moment two apertures in one room share a march (see {@link fill}) they have to be on the same
 * lattice or their fields cannot be compared cell for cell.
 *
 * @param {{x: number, y: number, width: number, height: number}} rect
 * @param {number} [cell]
 */
export function makeGrid(rect, cell = cellSize()) {
  const x0 = Math.floor(rect.x / cell) * cell;
  const y0 = Math.floor(rect.y / cell) * cell;
  const cols = Math.max(1, Math.ceil((rect.x + rect.width - x0) / cell));
  const rows = Math.max(1, Math.ceil((rect.y + rect.height - y0) / cell));
  return { x0, y0, cols, rows, cell, size: cols * rows };
}

/** Centre of a cell, in scene pixels. */
export function centerOf(grid, index) {
  const ix = index % grid.cols;
  const iy = (index - ix) / grid.cols;
  return { x: grid.x0 + (ix + 0.5) * grid.cell, y: grid.y0 + (iy + 0.5) * grid.cell };
}

/** Cell containing a scene point, or `-1` if it is off the grid. */
export function indexAt(grid, x, y) {
  const ix = Math.floor((x - grid.x0) / grid.cell);
  const iy = Math.floor((y - grid.y0) / grid.cell);
  if (ix < 0 || iy < 0 || ix >= grid.cols || iy >= grid.rows) return -1;
  return iy * grid.cols + ix;
}

/* -------------------------------------------- */
/*  Rasterising the obstacles                   */
/* -------------------------------------------- */

/**
 * Do two segments cross?
 *
 * @remarks
 * Sign-of-cross-product on both sides, with **`<= 0` rather than `< 0` on purpose**: a wall that
 * merely touches a link, or lies exactly along one, counts as crossing it. Blocking is the safe
 * direction to be wrong in — a spurious block costs one cell of detour and a missed one is light
 * through a wall.
 *
 * The case cannot arise from grid alignment anyway. Cell centres sit at half-cell offsets from
 * multiples of the cell size and Foundry snaps walls to multiples of half a grid square, so an exact
 * coincidence needs a scene whose dimensions defeat both.
 */
function crosses(ax, ay, bx, by, cx, cy, dx, dy) {
  const abx = bx - ax;
  const aby = by - ay;
  const cdx = dx - cx;
  const cdy = dy - cy;
  const r1 = abx * (cy - ay) - aby * (cx - ax);
  const r2 = abx * (dy - ay) - aby * (dx - ax);
  const r3 = cdx * (ay - cy) - cdy * (ax - cx);
  const r4 = cdx * (by - cy) - cdy * (bx - cx);
  return r1 * r2 <= 0 && r3 * r4 <= 0;
}

/**
 * Visit every cell a segment passes through.
 *
 * @remarks
 * Amanatides–Woo voxel traversal, which is the *supercover* walk rather than Bresenham's: it visits
 * every cell the segment **enters**, including both cells at a diagonal crossing. Bresenham picks
 * one cell per column and skips a cell at steep diagonals, and a skipped cell is a wall with a hole
 * in it.
 */
function walkCells(grid, ax, ay, bx, by, visit) {
  const { x0, y0, cols, rows, cell } = grid;

  const px = (ax - x0) / cell;
  const py = (ay - y0) / cell;
  const qx = (bx - x0) / cell;
  const qy = (by - y0) / cell;

  // Whole-segment rejection. Most edges on a scene are nowhere near any one aperture's grid.
  if (Math.max(px, qx) < 0 || Math.min(px, qx) > cols) return;
  if (Math.max(py, qy) < 0 || Math.min(py, qy) > rows) return;

  const dx = qx - px;
  const dy = qy - py;

  let ix = Math.floor(px);
  let iy = Math.floor(py);
  const ex = Math.floor(qx);
  const ey = Math.floor(qy);

  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const tDeltaX = stepX ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = stepY ? Math.abs(1 / dy) : Infinity;
  let tMaxX = stepX ? (stepX > 0 ? ix + 1 - px : px - ix) * tDeltaX : Infinity;
  let tMaxY = stepY ? (stepY > 0 ? iy + 1 - py : py - iy) * tDeltaY : Infinity;

  const at = () => {
    if (ix >= 0 && iy >= 0 && ix < cols && iy < rows) visit(ix, iy);
  };

  at();
  // Bounded by the Manhattan span plus slack: a traversal cannot take more steps than that, and a
  // NaN coordinate would otherwise spin forever.
  const limit = Math.abs(ex - ix) + Math.abs(ey - iy) + 4;
  for (let n = 0; n < limit && (ix !== ex || iy !== ey); n++) {
    if (tMaxX < tMaxY) {
      ix += stepX;
      tMaxX += tDeltaX;
    } else {
      iy += stepY;
      tMaxY += tDeltaY;
    }
    at();
  }
}

/**
 * Cut every cell-to-cell link a segment crosses.
 *
 * @remarks
 * **Links, not cells — and this replaced blocked cells on 2026-08-27.** Patrick: *"my only concern
 * for this is the cells marked as walls leaving black strips where the walls are… is there a way to
 * fill them from their neighbouring cells (and be smart enough to not pull from the neighbour on the
 * wrong side of the wall)?"*
 *
 * The concern was right, and worse than the raw number looks: §6.4.7 disables the field blur in a
 * band centred on every light-blocking wall, so a one-cell strip of unreachable ground would land
 * in the one place nothing smooths it.
 *
 * **Filling from a neighbour cannot fix it, because a blocked cell straddles the wall.** The strip
 * is centred on the wall, so there is no correct side to pull from: take the lit side and brightness
 * moves half a cell into the dark room, take the dark side and a shadow moves half a cell into the
 * lit one. Either way the wall has moved.
 *
 * So do not block ground at all. A wall is not a place — it is a **barrier between** places, and
 * that is exactly a graph edge. Every cell keeps a value; what a wall removes is the ability to step
 * across it. `h[i]` is the link from cell `i` to `i+1`, `v[i]` from `i` to `i+cols`.
 *
 * Three things fall out:
 *
 * - **No erosion.** Both sides of a wall get their true distance and the discontinuity lands exactly
 *   on the wall, which is what §6.4.7 wants to keep sharp.
 * - **No leak, provably.** Any 4-connected path from one side of a wall to the other is a continuous
 *   polyline through cell centres, so it must intersect the wall; the intersection lies on some
 *   link; every link the wall crosses is cut. That is a stronger guarantee than supercover cells
 *   gave, which rested on the rasteriser not skipping one.
 * - **Narrow openings survive.** The doorway-erosion failure mode disappears with the erosion: a gap
 *   about a cell wide still leaves an uncut link, where blocked cells needed three.
 *
 * Testing all four links of each visited cell is deliberately redundant — a link is reachable from
 * either of the two cells it joins — but it is what makes completeness obvious rather than argued:
 * the crossing point lies in some visited cell, and that cell tests the link from its own side.
 *
 * ## Measured — 2026-08-27, at 25 px cells
 *
 * A solid wall slid across the lattice at eight offsets leaked at **none** of them, and a sealed
 * diamond rotated through thirty angles contained its fill at every one. A gap passes from **two
 * cells** wide:
 *
 * | gap | | passes |
 * |------|--------|--------|
 * | 25 px | 1.25 ft | 0 / 8 offsets |
 * | 50 px | 2.5 ft | 8 / 8 |
 * | 100 px | 5 ft | 8 / 8 |
 *
 * So the practical floor is 2.5 ft at the default resolution — under a door, and under the narrowest
 * arrow slit anyone draws. The 1.25 ft row closing is the conservatism in {@link crosses} biting at
 * the one-cell scale, and it is the right way round: a slot that narrow refusing to pass light is a
 * defensible answer, and a wall that leaks is not.
 *
 * @returns {number} Links newly cut
 */
function cutLinks(grid, links, ax, ay, bx, by) {
  const { x0, y0, cols, rows, cell } = grid;
  const { h, v } = links;
  let cut = 0;

  walkCells(grid, ax, ay, bx, by, (ix, iy) => {
    const i = iy * cols + ix;
    const cx = x0 + (ix + 0.5) * cell;
    const cy = y0 + (iy + 0.5) * cell;

    if (ix < cols - 1 && !h[i] && crosses(ax, ay, bx, by, cx, cy, cx + cell, cy)) {
      h[i] = 1;
      cut++;
    }
    if (ix > 0 && !h[i - 1] && crosses(ax, ay, bx, by, cx - cell, cy, cx, cy)) {
      h[i - 1] = 1;
      cut++;
    }
    if (iy < rows - 1 && !v[i] && crosses(ax, ay, bx, by, cx, cy, cx, cy + cell)) {
      v[i] = 1;
      cut++;
    }
    if (iy > 0 && !v[i - cols] && crosses(ax, ay, bx, by, cx, cy - cell, cx, cy)) {
      v[i - cols] = 1;
      cut++;
    }
  });

  return cut;
}

/** An empty link set for a grid. */
export const emptyLinks = (grid) => ({
  h: new Uint8Array(grid.size),
  v: new Uint8Array(grid.size),
});

/**
 * Every light-blocking edge on the scene, cut into the link set.
 *
 * @remarks
 * **`edge.light`, not `edge.sight`** — the same predicate `render/wall-mask.mjs` uses and for the
 * same reason. The field is a *brightness* field, so the question is whether light crosses. A window
 * that blocks sight but passes light must let spill through, which is the entire feature.
 *
 * It is also, necessarily, the same predicate `spill.isAperture` reads, so an aperture can never
 * both seed a fill and block it.
 */
export function blockingLinks(grid, { skip = null, links = emptyLinks(grid) } = {}) {
  const NONE = CONST.WALL_SENSE_TYPES.NONE;
  let edges = 0;
  let cut = 0;

  for (const edge of canvas?.edges?.values() ?? []) {
    if ((edge.light ?? NONE) === NONE) continue;
    if (!edge.a || !edge.b) continue;
    if (skip?.(edge)) continue;
    edges++;
    cut += cutLinks(grid, links, edge.a.x, edge.a.y, edge.b.x, edge.b.y);
  }
  return { links, edges, cut };
}

/**
 * Cut every link crossing a region outline, so the fill cannot leave the room.
 *
 * @remarks
 * **The region clip becomes a barrier rather than a boolean operation**, and that is where the
 * sliver failure goes. Today the bands are built and then intersected with the region outline, so a
 * band running along a region edge is cut into alternating thin pieces by rounding. A fill that
 * cannot step out of the room produces no sliver, because there is no intersection to produce one.
 *
 * Cutting the boundary rather than blocking the cells outside it is the same choice
 * {@link cutLinks} makes and for the same reason: a region outline usually runs along a wall, so
 * blocking by cell would erode floor at the room's own edge — the exact strip this was rewritten to
 * remove.
 *
 * A ring wholly outside the grid contributes nothing, which is correct: the room then covers the
 * whole grid locally and there is nothing to leak into.
 */
export function cutRegionBoundary(grid, links, polygons) {
  if (!polygons?.length) return 0;
  let cut = 0;
  for (const polygon of polygons) {
    const pts = polygon?.points ?? [];
    if (pts.length < 6) continue;
    for (let i = 0; i < pts.length; i += 2) {
      const j = (i + 2) % pts.length;
      cut += cutLinks(grid, links, pts[i], pts[i + 1], pts[j], pts[j + 1]);
    }
  }
  return cut;
}

/* -------------------------------------------- */
/*  The march                                   */
/* -------------------------------------------- */

/**
 * Binary min-heap over `(key, cell)`, with lazy deletion.
 *
 * @remarks
 * Lazy rather than decrease-key: a cell whose distance improves is pushed again and the stale entry
 * is skipped on pop by comparing against the live `dist`. That trades a bounded amount of memory for
 * not having to maintain a position index, and in a fast march each cell is pushed about 1–2 times
 * because the front only ever moves outward.
 */
class MinHeap {
  constructor(capacity = 1024) {
    this.keys = new Float64Array(capacity);
    this.vals = new Int32Array(capacity);
    this.n = 0;
  }

  #grow() {
    const keys = new Float64Array(this.keys.length * 2);
    const vals = new Int32Array(this.vals.length * 2);
    keys.set(this.keys);
    vals.set(this.vals);
    this.keys = keys;
    this.vals = vals;
  }

  push(key, val) {
    if (this.n === this.keys.length) this.#grow();
    let i = this.n++;
    this.keys[i] = key;
    this.vals[i] = val;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      const k = this.keys[p];
      const v = this.vals[p];
      this.keys[p] = this.keys[i];
      this.vals[p] = this.vals[i];
      this.keys[i] = k;
      this.vals[i] = v;
      i = p;
    }
  }

  /** @returns {number} The cell, with its key in {@link topKey}; `-1` when empty. */
  pop() {
    if (!this.n) return -1;
    const val = this.vals[0];
    this.topKey = this.keys[0];
    this.n--;
    if (!this.n) return val;
    this.keys[0] = this.keys[this.n];
    this.vals[0] = this.vals[this.n];
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < this.n && this.keys[l] < this.keys[m]) m = l;
      if (r < this.n && this.keys[r] < this.keys[m]) m = r;
      if (m === i) break;
      const k = this.keys[m];
      const v = this.vals[m];
      this.keys[m] = this.keys[i];
      this.vals[m] = this.vals[i];
      this.keys[i] = k;
      this.vals[i] = v;
      i = m;
    }
    return val;
  }
}

const FROZEN = 2;

/**
 * Fast marching method — geodesic distance from a seed set, in scene pixels.
 *
 * @remarks
 * ## The update
 *
 * For a cell with best frozen horizontal neighbour `a` and vertical `b`, and local slowness
 * `h = cell / F`, the eikonal |∇d| = 1/F discretises to
 *
 * ```
 * max(0, T − a)² + max(0, T − b)² = h²
 * ```
 *
 * which has the two branches below: when the neighbours differ by more than `h` the front is
 * effectively one-dimensional and `T = min(a,b) + h`; otherwise the quadratic's larger root applies.
 * That second branch is the whole reason this is not Dijkstra — it interpolates the front's
 * *direction* from two axes instead of stepping along one, which is what removes the anisotropy.
 *
 * ## Occlusion needs no special case
 *
 * A cut link is simply a neighbour that does not exist, handled by the same test that handles the
 * edge of the grid. Nothing about a wall is a *place*, so nothing about a wall needs a value.
 *
 * **The second-order reach is gated too, and forgetting that is a light leak.** The `t₂` term reads
 * two cells upwind, so it must check the link between the first and second neighbour as well as the
 * one it stepped over — otherwise a cell against a wall would take a derivative through it and
 * brighten from the far side.
 *
 * @param {object} options
 * @param {object} options.grid
 * @param {{h: Uint8Array, v: Uint8Array}} options.links - Cut links; see {@link cutLinks}
 * @param {{index: number, value: number}[]} options.seeds - `value` in scene pixels
 * @param {Float32Array|null} [options.speed] - 0..1 per cell; `null` means 1 everywhere
 * @param {number} [options.maxDistance] - Stop once the front passes this, in scene pixels
 * @returns {{dist: Float32Array, visited: number, pushes: number}}
 */
export function march({ grid, links, seeds, speed = null, maxDistance = Infinity }) {
  const { cols, rows, cell, size } = grid;
  const linkH = links.h;
  const linkV = links.v;
  const dist = new Float32Array(size).fill(Infinity);
  const state = new Uint8Array(size);
  const heap = new MinHeap(Math.min(size, 4096));

  let pushes = 0;
  for (const { index, value } of seeds) {
    if (index < 0 || index >= size) continue;
    if (value >= dist[index]) continue;
    dist[index] = value;
    // **Push the stored value, never the computed one.** `dist` is a Float32Array and the heap keys
    // are float64, so pushing `value` would compare a full-precision key against a rounded `dist` on
    // pop. Where the rounding went down, a live entry reads as stale, gets skipped, and the cell
    // never freezes — which shows up as pinholes and ragged fronts rather than as an error.
    heap.push(dist[index], index);
    pushes++;
  }

  const solve = (j) => {
    const jx = j % cols;
    const jy = (j - jx) / cols;

    // Slowness at the cell being solved. A speed of 0 would be an infinitely slow cell; clamped
    // rather than guarded, because a zero here is a caller's mistake and an unreachable cell is a
    // less confusing symptom than a NaN spreading through the field.
    const h = cell / Math.max(1e-3, speed ? speed[j] : 1);

    // Per axis: the nearer of the two directions, then one *further along that same direction* for
    // the second-order term. `x2 <= x1` is the monotonicity test — a second neighbour further from
    // the source than the first is not upwind and its difference is meaningless.
    // Each `t₂` test repeats its `t₁` link test one cell further along. That second check is the
    // one a reader is tempted to drop, and dropping it takes a derivative straight through a wall.
    let x1 = Infinity;
    let x2 = Infinity;
    if (jx > 0 && !linkH[j - 1] && state[j - 1] === FROZEN) {
      x1 = dist[j - 1];
      if (jx > 1 && !linkH[j - 2] && state[j - 2] === FROZEN && dist[j - 2] <= x1) x2 = dist[j - 2];
    }
    if (jx < cols - 1 && !linkH[j] && state[j + 1] === FROZEN && dist[j + 1] < x1) {
      x1 = dist[j + 1];
      x2 =
        jx < cols - 2 && !linkH[j + 1] && state[j + 2] === FROZEN && dist[j + 2] <= x1
          ? dist[j + 2]
          : Infinity;
    }

    let y1 = Infinity;
    let y2 = Infinity;
    if (jy > 0 && !linkV[j - cols] && state[j - cols] === FROZEN) {
      y1 = dist[j - cols];
      if (
        jy > 1 &&
        !linkV[j - 2 * cols] &&
        state[j - 2 * cols] === FROZEN &&
        dist[j - 2 * cols] <= y1
      ) {
        y2 = dist[j - 2 * cols];
      }
    }
    if (jy < rows - 1 && !linkV[j] && state[j + cols] === FROZEN && dist[j + cols] < y1) {
      y1 = dist[j + cols];
      y2 =
        jy < rows - 2 &&
        !linkV[j + cols] &&
        state[j + 2 * cols] === FROZEN &&
        dist[j + 2 * cols] <= y1
          ? dist[j + 2 * cols]
          : Infinity;
    }

    if (x1 === Infinity && y1 === Infinity) return Infinity;

    // ΣA(T − b)² = h², assembled per axis. First order contributes `(T − t₁)²`; second order uses
    // the one-sided difference `(3T − 4t₁ + t₂)/2`, which is `(3/2)(T − (4t₁ − t₂)/3)` and so
    // contributes `(9/4)(T − b)²` with `b = (4t₁ − t₂)/3`.
    let A = 0;
    let B = 0;
    let C = -h * h;
    let bound = -Infinity;

    const add = (t1, t2) => {
      if (t1 === Infinity) return;
      if (t2 === Infinity) {
        A += 1;
        B -= 2 * t1;
        C += t1 * t1;
      } else {
        const b = (4 * t1 - t2) / 3;
        A += 2.25;
        B -= 4.5 * b;
        C += 2.25 * b * b;
      }
      // The solution must lie downwind of every neighbour it was built from; otherwise that axis
      // was not upwind after all and the two-axis form does not apply.
      if (t1 > bound) bound = t1;
    };

    add(x1, x2);
    add(y1, y2);

    const oneAxis = Math.min(x1, y1) + h;
    const disc = B * B - 4 * A * C;
    if (disc < 0) return oneAxis;
    const T = (-B + Math.sqrt(disc)) / (2 * A);
    return T < bound ? oneAxis : T;
  };

  let visited = 0;
  for (;;) {
    const i = heap.pop();
    if (i < 0) break;
    if (state[i] === FROZEN) continue;
    // Stale entry: this cell was pushed again at a lower distance and has already been handled.
    if (heap.topKey > dist[i]) continue;
    if (heap.topKey > maxDistance) break;

    state[i] = FROZEN;
    visited++;

    const ix = i % cols;
    const iy = (i - ix) / cols;

    const relax = (j) => {
      if (state[j] === FROZEN) return;
      const t = solve(j);
      if (t < dist[j]) {
        dist[j] = t;
        // The stored value, not `t` — see the seeding loop above.
        heap.push(dist[j], j);
        pushes++;
      }
    };

    if (ix > 0 && !linkH[i - 1]) relax(i - 1);
    if (ix < cols - 1 && !linkH[i]) relax(i + 1);
    if (iy > 0 && !linkV[i - cols]) relax(i - cols);
    if (iy < rows - 1 && !linkV[i]) relax(i + cols);
  }

  return { dist, visited, pushes };
}

/* -------------------------------------------- */
/*  Distance → tier                             */
/* -------------------------------------------- */

/**
 * The falloff ladder: how far each brightness carries before it steps down.
 *
 * @remarks
 * **Per-tier band widths, not one width and a per-tier radius** (Patrick, 2026-08-27: *"rather than
 * a straight band width, the value of each brightness can tell you how large the band of that
 * brightness is"*). It is not messy; it is a cumulative sum, and it is the better reading of the
 * three numbers `spillRadius*` already hold.
 *
 * The old scheme said both things at once: a cone radius keyed on the *initial* tier, and a separate
 * uniform band width for every step after it. Those double-count the falloff and disagree about
 * which one is the distance limit. Under this one there is a single statement — *bright light
 * carries 40 ft before it reads as normal, normal carries 20, dim carries 10* — and the total reach
 * is whatever that sums to. A Bright spill runs 40 / 20 / 10 for 70 ft; a Normal spill runs 20 / 10
 * for 30 ft, with no separate rule making it shorter.
 *
 * `floorTier` is `max(interiorTier + 1, TIER.DIM)` at the call site, and Dim is not a preference:
 * `globalLightCutoff` is the Dim threshold and `darknessFor` erases below it, so there is no rung
 * underneath for global illumination to reach.
 *
 * > **The contour step is still to come.** This maps a distance to a tier; turning the field back
 * > into polygons for `areas` is marching squares at each `until` boundary, and it is deliberately
 * > not written until the field itself has been looked at. Patrick, 2026-08-27: the lighting
 * > decision stays with the levels overlay, so spill supplies geometry and nothing else.
 *
 * @param {number} spillTier
 * @param {number} floorTier
 * @param {Record<number, number>} widthsFeet - Keyed by {@link TIER}
 * @returns {{tier: number, from: number, until: number}[]} Cumulative, in **feet**
 */
export function ladder(spillTier, floorTier, widthsFeet) {
  const steps = [];
  let acc = 0;
  for (let tier = spillTier; tier >= floorTier; tier--) {
    const width = Number(widthsFeet?.[tier]) || 0;
    if (width <= 0) break;
    steps.push({ tier, from: acc, until: (acc += width) });
  }
  return steps;
}

/* -------------------------------------------- */
/*  Field → polygons                            */
/* -------------------------------------------- */

/**
 * Marching squares: the boundary of `dist < threshold`, as closed rings in scene pixels.
 *
 * @remarks
 * This is the step that hands the field back to the rest of the module as ordinary geometry
 * (Patrick, 2026-08-27: *"draw polygons out of those coloured fields, add them to the underlying
 * brightness model, and call it a day"*). Everything downstream then reads spill the way it already
 * reads a drawn region — no new plumbing, and the levels overlay keeps making every lighting call.
 *
 * ## The rings are nested, not annular, and that is the whole reason there are no boolean ops here
 *
 * A caller wanting Bright / Normal / Dim bands is tempted to difference each contour against the
 * one inside it. It must not: spill folds as `AT_LEAST` (§3.4), so `max` already does that. Emit the
 * *whole* `d < 40` disc as Bright and the *whole* `d < 60` disc as Normal, and the fold produces
 * Bright in the middle and Normal in the annulus by itself. Differencing would compute the same
 * answer through Clipper, which is where §3.4's slivers came from in the first place.
 *
 * ## Vertices are keyed by edge, not by position
 *
 * Chaining segments into rings by matching coordinates is the classic place a contour comes apart:
 * two cells compute the same crossing and land a float apart. Every crossing here lies on a known
 * lattice edge, so it is keyed by that edge's **integer** index — `2·cell + 0` for the horizontal
 * link, `+ 1` for the vertical. Two cells sharing an edge therefore produce the identical key by
 * construction, and the chain is a `Map` walk with no tolerance in it.
 *
 * ## Where an unreachable neighbour puts the boundary
 *
 * Linear interpolation needs two finite values. Against `Infinity` — the far side of a wall, or
 * ground the ladder never reached — there is nothing to interpolate, so the crossing goes at the
 * **midpoint** of the two cell centres, which is the cell boundary and therefore where the wall is.
 * That is a deliberate rule, not a fallback: it is what makes a spill polygon stop *on* a wall
 * rather than half a cell short of or past it.
 *
 * Saddle cells (two opposite corners inside) are resolved on the average of all four corners, with
 * any `Infinity` making the centre count as outside — the conservative reading, and the one that
 * never joins two lobes that a wall separates.
 *
 * @param {object} grid
 * @param {Float32Array} dist
 * @param {number} threshold - Scene pixels
 * @returns {{x: number, y: number}[][]} Closed rings; holes wind against their outer
 */
export function contour(grid, dist, threshold) {
  const { cols, rows, cell, x0, y0 } = grid;
  if (!(threshold > 0)) return [];

  const vertex = new Map();
  const next = new Map();

  // Fraction along an edge at which the field crosses `threshold`. See the note above on Infinity.
  const cut = (da, db) => {
    if (!Number.isFinite(da) || !Number.isFinite(db)) return 0.5;
    const span = db - da;
    if (Math.abs(span) < 1e-9) return 0.5;
    const t = (threshold - da) / span;
    return t < 0 ? 0 : t > 1 ? 1 : t;
  };

  for (let iy = 0; iy < rows - 1; iy++) {
    for (let ix = 0; ix < cols - 1; ix++) {
      const i0 = iy * cols + ix; // top-left
      const i1 = i0 + 1; // top-right
      const i3 = i0 + cols; // bottom-left
      const i2 = i3 + 1; // bottom-right

      const d0 = dist[i0];
      const d1 = dist[i1];
      const d2 = dist[i2];
      const d3 = dist[i3];

      const b0 = d0 < threshold;
      const b1 = d1 < threshold;
      const b2 = d2 < threshold;
      const b3 = d3 < threshold;

      let code = (b0 ? 1 : 0) | (b1 ? 2 : 0) | (b2 ? 4 : 0) | (b3 ? 8 : 0);
      if (code === 0 || code === 15) continue;

      const left = x0 + (ix + 0.5) * cell;
      const top = y0 + (iy + 0.5) * cell;

      // Edge index → key, registering the crossing point the first time it is asked for.
      const edge = (k) => {
        let key;
        let x;
        let y;
        if (k === 0) {
          key = 2 * i0;
          x = left + cut(d0, d1) * cell;
          y = top;
        } else if (k === 1) {
          key = 2 * i1 + 1;
          x = left + cell;
          y = top + cut(d1, d2) * cell;
        } else if (k === 2) {
          key = 2 * i3;
          x = left + cut(d3, d2) * cell;
          y = top + cell;
        } else {
          key = 2 * i0 + 1;
          x = left;
          y = top + cut(d0, d3) * cell;
        }
        if (!vertex.has(key)) vertex.set(key, { x, y });
        return key;
      };

      // Saddles: join the pair that agrees with the cell's own centre.
      if (code === 5 || code === 10) {
        const finite =
          Number.isFinite(d0) && Number.isFinite(d1) && Number.isFinite(d2) && Number.isFinite(d3);
        const middle = finite && (d0 + d1 + d2 + d3) / 4 < threshold;
        if (code === 5 && middle) code = -5;
        if (code === 10 && middle) code = -10;
      }

      const link = (from, to) => next.set(edge(from), edge(to));

      switch (code) {
        case 1: link(3, 0); break;
        case 2: link(0, 1); break;
        case 3: link(3, 1); break;
        case 4: link(1, 2); break;
        case 5: link(3, 0); link(1, 2); break;
        case -5: link(3, 2); link(1, 0); break;
        case 6: link(0, 2); break;
        case 7: link(3, 2); break;
        case 8: link(2, 3); break;
        case 9: link(2, 0); break;
        case 10: link(0, 1); link(2, 3); break;
        case -10: link(0, 3); link(2, 1); break;
        case 11: link(2, 1); break;
        case 12: link(1, 3); break;
        case 13: link(1, 0); break;
        case 14: link(0, 3); break;
        default: break;
      }
    }
  }

  // Follow the successor map. Every crossing has exactly one outgoing and one incoming segment, so
  // a walk from any unvisited vertex closes on itself.
  const rings = [];
  const seen = new Set();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const ring = [];
    let key = start;
    for (let guard = 0; guard <= next.size; guard++) {
      if (seen.has(key)) break;
      seen.add(key);
      ring.push(vertex.get(key));
      const step = next.get(key);
      if (step === undefined || step === start) break;
      key = step;
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

/** Total reach of a ladder, in feet. */
export const reachOf = (steps) => (steps.length ? steps[steps.length - 1].until : 0);

/** Which tier a distance falls in, or `null` past the end of the ladder. */
export function tierAtDistance(steps, feet) {
  for (const step of steps) if (feet < step.until) return step.tier;
  return null;
}

/* -------------------------------------------- */
/*  The aperture's own shape                    */
/* -------------------------------------------- */

/**
 * Seed cells across an aperture, one cell inside the room.
 *
 * @remarks
 * **Pushed off the wall by a full cell**, so every seed is unambiguously on the room's side of the
 * region boundary that {@link cutRegionBoundary} has just cut. Half a cell would leave the seed
 * point's containing cell decided by rounding, and a seed landing outside the room is a seed with no
 * way back in. One cell is 1.25 ft at the default resolution, so the field reads zero a foot inside
 * the window rather than exactly at it — conservative, and below anything the picture resolves.
 *
 * Sampled at half-cell spacing so no cell of a wide opening is missed, and de-duplicated because
 * that oversamples by construction.
 *
 * > **No blocked-cell test any more, and the doorway failure went with it.** Under blocked cells a
 * > seed could land in the strip a flanking wall had eaten and be discarded, so an opening under
 * > three cells wide produced `seeds: 0` and no spill. Walls are links now
 * > ({@link cutLinks}), no ground is eaten, and a seed can only fail by being off the grid.
 */
export function seedAperture(grid, { a, b, normal }) {
  const seeds = [];
  const seen = new Set();
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  const count = Math.max(2, Math.ceil(length / (grid.cell * 0.5)) + 1);
  const push = grid.cell;

  for (let k = 0; k < count; k++) {
    const t = k / (count - 1);
    const x = a.x + (b.x - a.x) * t + normal.x * push;
    const y = a.y + (b.y - a.y) * t + normal.y * push;
    const index = indexAt(grid, x, y);
    if (index < 0 || seen.has(index)) continue;
    seen.add(index);
    seeds.push({ index, value: 0 });
  }
  return seeds;
}

/**
 * A speed field expressing the spill cone as **anisotropy**, not as a boundary.
 *
 * @remarks
 * ## Correcting the earlier sketch
 *
 * This was described on 2026-08-27 as a *seed cost* — "one line at seed time". That is wrong, and
 * the reason is worth keeping because it is the thing that makes the cone awkward to express at all.
 * Every seed sits in the opening, so the seeds do not differ from one another by direction; there is
 * no angle to charge them for. And a cell hugging the wall five feet to the side of a window is
 * reachable in five feet of open floor whatever the seeds cost, so raising a seed's value changes
 * nothing — the march takes the minimum.
 *
 * Direction is a property of **travel**, so it has to be charged to travel. The eikonal equation
 * already has the term for it: `F`, the local speed. `|∇d| = 1/F` means distance accumulates faster
 * wherever `F < 1`, so making sideways ground slow is what makes sideways light dim.
 *
 * ## What it does
 *
 * `F = 1` within the half-angle of the window's inward normal, falling to `graze` at 90°. So light
 * leaving straight out is charged its true distance and light leaving along the wall face is charged
 * `1/graze` times its distance — at `graze = 0.45`, five feet of sideways travel costs eleven, and a
 * point beside a window is a tier down where before it was at full brightness for the whole first
 * band. That is the correct answer for the wrong-looking case pure geodesic distance produces.
 *
 * The angle stops being a hard wedge boundary that the bands were computed *outside* of, and becomes
 * where the falloff starts. It is a probe argument rather than a setting: `spillAngle` was deleted
 * with the old construction, since nothing reads this while `graze` is 1.
 *
 * > **The known wart.** θ is measured from the aperture geometrically, with no knowledge of walls, so
 * > a cell that is 80° off the normal but lit by bending round a corner is still charged the grazing
 * > rate. The alternative is propagating the path's own direction through the march, which averages
 * > angles badly at a merging front. Left as-is until it is seen to matter: {@link fill} takes
 * > `graze` as a parameter precisely so the case can be judged rather than argued.
 */
export function coneSpeed(grid, { a, b, normal, halfAngle, graze }) {
  const speed = new Float32Array(grid.size).fill(1);
  if (!(graze < 1) || !(halfAngle < Math.PI / 2)) return speed;

  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby || 1;
  const span = Math.PI / 2 - halfAngle;

  for (let i = 0; i < grid.size; i++) {
    const p = centerOf(grid, i);
    // Nearest point on the aperture segment — an area source, not a point (§7.2), so the angle is
    // taken from whichever part of the window the cell actually faces.
    let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const vx = p.x - (a.x + abx * t);
    const vy = p.y - (a.y + aby * t);
    const r = Math.hypot(vx, vy);
    if (r < 1e-6) continue;

    const cos = (vx * normal.x + vy * normal.y) / r;
    const theta = Math.acos(cos < -1 ? -1 : cos > 1 ? 1 : cos);
    if (theta <= halfAngle) continue;

    const f = Math.min(1, (theta - halfAngle) / span);
    speed[i] = 1 + (graze - 1) * f;
  }
  return speed;
}

/* -------------------------------------------- */
/*  One aperture, end to end                    */
/* -------------------------------------------- */

/**
 * Everything above, for one window: grid, obstacles, seeds, speed, march.
 *
 * @remarks
 * The grid is the aperture's own bounding box grown by the ladder's reach, so cost scales with
 * **reach squared** and not with the size of the scene. A 70 ft ladder at 25 px cells is a box about
 * 112 cells on a side — 12,500 cells, of which the march visits the reachable disc.
 *
 * @param {object} options
 * @param {{x: number, y: number}} options.a - Aperture endpoint
 * @param {{x: number, y: number}} options.b - Aperture endpoint
 * @param {{x: number, y: number}} options.normal - Unit inward normal, toward the dark room
 * @param {{tier: number, from: number, until: number}[]} options.steps - From {@link ladder}
 * @param {PIXI.Polygon[]} [options.region] - The enclosing interior; the fill will not leave it
 * @param {number} [options.halfAngle] - Radians; omit for no cone
 * @param {number} [options.graze] - Speed at 90° off the normal; 1 disables the cone
 */
export function fill({ a, b, normal, steps, region = null, halfAngle = null, graze = 1 }) {
  const t0 = performance.now();
  const feetToPixels = canvas?.dimensions?.distancePixels ?? 1;
  const reach = reachOf(steps) * feetToPixels;
  if (!(reach > 0)) return null;

  const cell = cellSize();
  const rect = {
    x: Math.min(a.x, b.x) - reach - cell,
    y: Math.min(a.y, b.y) - reach - cell,
    width: Math.abs(b.x - a.x) + 2 * (reach + cell),
    height: Math.abs(b.y - a.y) + 2 * (reach + cell),
  };
  const grid = makeGrid(rect, cell);

  const { links, edges, cut } = blockingLinks(grid);
  // **After the walls, not before.** Both cut into the same link set and the operation is
  // idempotent, so the order does not change the result — but a region outline that runs along a
  // wall then costs nothing, because those links are already cut.
  const boundary = region ? cutRegionBoundary(grid, links, region) : 0;

  const seeds = seedAperture(grid, { a, b, normal });
  if (!seeds.length) {
    return {
      grid,
      links,
      dist: null,
      steps,
      seeds: 0,
      reason: "the aperture lies off its own grid",
      ms: Math.round((performance.now() - t0) * 100) / 100,
    };
  }

  const speed =
    halfAngle !== null && graze < 1 ? coneSpeed(grid, { a, b, normal, halfAngle, graze }) : null;

  const { dist, visited, pushes } = march({ grid, links, seeds, speed, maxDistance: reach });

  return {
    grid,
    links,
    speed,
    dist,
    steps,
    reach,
    feetToPixels,
    seeds: seeds.length,
    edges,
    wallLinks: cut,
    boundaryLinks: boundary,
    visited,
    pushes,
    ms: Math.round((performance.now() - t0) * 100) / 100,
  };
}

/**
 * A whole room in one march, seeded from every one of its windows at once.
 *
 * @remarks
 * **The shipped entry point; {@link fill} is the single-aperture probe.** Patrick, 2026-08-27:
 * *"one march per room sounds like the smart choice."*
 *
 * The grid is the union of every aperture's bounding box grown by the ladder's reach, so a room with
 * four windows costs one field rather than four — and, more importantly, produces one set of
 * contours. Four fields on four separately-snapped lattices can disagree by a fraction of a cell
 * where they meet, and thin disagreeing polygons folding together is the sliver failure §3.4.1 was
 * written to end.
 *
 * `offset` per seed group is the head start that lets windows at different spill tiers share the
 * march: a Normal window in a Bright room's ladder seeds at the width of the Bright rung, so the
 * ladder reads Normal at its mouth. Cumulative widths are what make that exact rather than
 * approximate.
 *
 * @param {object} options
 * @param {{a: object, b: object, normal: object, offset: number}[]} options.seedGroups
 * @param {{tier: number, from: number, until: number}[]} options.steps
 * @param {PIXI.Polygon[]} [options.region]
 */
export function fillRoom({ seedGroups, steps, region = null }) {
  const t0 = performance.now();
  if (!seedGroups?.length) return null;

  const feetToPixels = canvas?.dimensions?.distancePixels ?? 1;
  const reach = reachOf(steps) * feetToPixels;
  if (!(reach > 0)) return null;

  const cell = cellSize();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { a, b } of seedGroups) {
    minX = Math.min(minX, a.x, b.x);
    minY = Math.min(minY, a.y, b.y);
    maxX = Math.max(maxX, a.x, b.x);
    maxY = Math.max(maxY, a.y, b.y);
  }

  // **The margin is not slack.** `contour` can only close a ring that stays inside the lattice, and
  // the march is capped at `reach`, so one cell of guaranteed-unreachable border is what makes every
  // contour closed. Trimming this would produce open polylines that read as garbage polygons.
  const pad = reach + 2 * cell;
  const grid = makeGrid(
    { x: minX - pad, y: minY - pad, width: maxX - minX + 2 * pad, height: maxY - minY + 2 * pad },
    cell
  );

  const { links, edges, cut } = blockingLinks(grid);
  const boundary = region ? cutRegionBoundary(grid, links, region) : 0;

  const seeds = [];
  for (const group of seedGroups) {
    for (const seed of seedAperture(grid, group)) {
      seeds.push({ index: seed.index, value: seed.value + (group.offset || 0) });
    }
  }
  if (!seeds.length) {
    return { grid, links, dist: null, steps, seeds: 0, reason: "no aperture landed on the grid" };
  }

  const { dist, visited, pushes } = march({ grid, links, seeds, maxDistance: reach });

  return {
    grid,
    links,
    dist,
    steps,
    reach,
    feetToPixels,
    seeds: seeds.length,
    apertures: seedGroups.length,
    edges,
    wallLinks: cut,
    boundaryLinks: boundary,
    visited,
    pushes,
    ms: Math.round((performance.now() - t0) * 100) / 100,
  };
}

/** Tier at a scene point from a completed {@link fill}, or `null` outside its reach. */
export function tierAtPoint(result, point) {
  if (!result?.dist) return null;
  const index = indexAt(result.grid, point.x, point.y);
  if (index < 0) return null;
  const d = result.dist[index];
  if (!Number.isFinite(d)) return null;
  return tierAtDistance(result.steps, d / result.feetToPixels);
}

/** The tiers this file can produce, brightest first — for callers building width tables. */
export const SPILL_TIERS = Object.freeze([TIER.BRIGHT, TIER.NORMAL, TIER.DIM]);
