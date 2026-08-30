/**
 * **The geodesic spill probe.** DESIGN.md §3.4.1.
 *
 * Draws `model/geodesic.mjs`'s distance field straight onto the canvas, one rectangle per cell,
 * before any of it is wired into `model/spill.mjs`. Hamilcarbarcas, 2026-08-27: *"Go ahead and build the
 * rasteriser and let's resolve these uncertainties."*
 *
 * It exists for the reason `ui/cell-overlay.mjs` exists — geometry is the one thing a console
 * readout is bad at — but it has a second job that overlay does not. Three of the open questions
 * are settled by *looking at the raster*, not by looking at the result:
 *
 * - **The obstacles.** Red is the set of severed cell-to-cell links — see {@link paintLinks}. A
 *   continuous hatch along a wall is that wall sealed; a break in the hatch is somewhere light can
 *   get through, which is a doorway when you meant one and a bug when you did not.
 * - **The cone.** `graze` is anisotropy, not a boundary (see `geodesic.coneSpeed`), so its effect is
 *   only visible as a change in *contour shape* near the window. Two draws at different `graze` are
 *   the comparison; the number alone says nothing.
 * - **The ladder.** Per-tier band widths make the contour spacing uneven by design. Whether that
 *   reads as three brightnesses or as an arbitrary gradient is an eye question.
 *
 * Deliberately **not** hooked to anything. It draws when called and clears when told; nothing
 * invalidates it, because a probe that redraws itself during a wall drag is a probe you cannot hold
 * still and compare against.
 */

import { MODULE_ID } from "../constants.mjs";
import { TIER, TIER_NAME } from "../model/tiers.mjs";
import * as geodesic from "../model/geodesic.mjs";
import { SETTING_RADIUS, apertureInfo, isAperture } from "../model/spill.mjs";
import { ambientTier as sceneAmbientTier } from "../model/registry.mjs";

/**
 * Colour per tier.
 *
 * @remarks
 * Warm to cool down the ladder, and **not** `cell-overlay`'s palette: that one colours by *kind*
 * (ambient, clip, reduced), and two overlays using one colour for different meanings on the same
 * canvas is how a debugging session goes wrong. Blocked cells are the only red on either.
 */
const TIER_COLOUR = {
  [TIER.BRIGHT]: 0xffd94a,
  [TIER.NORMAL]: 0x9ee06a,
  [TIER.DIM]: 0x5aa9ff,
  [TIER.DARK]: 0x6a5acd,
};

const BLOCKED_COLOUR = 0xff3355;

/**
 * Speed at 90° off the window's normal. **1 means no cone at all.**
 *
 * @remarks
 * Hamilcarbarcas, 2026-08-27, after looking at both: *"let's leave graze out this time around (so set to
 * 1)"*. So the shipped falloff is pure geodesic distance, and `spillAngle` has no consumer.
 *
 * The mechanism is kept rather than deleted, and it is worth being clear about why that is not
 * hedging. `coneSpeed` is the only place in the module that can express *direction* at all: it is
 * the `F` term of `|∇d| = 1/F`, so it charges travel rather than clipping geometry, and the
 * marcher's refraction toward fast ground comes free with it. Deleting it would delete the lever,
 * not the setting. Nothing calls it while this is 1 — the speed array is never even allocated.
 *
 * For comparison, `game.pf1Lighting.geodesic.draw({ graze: 0.45 })` is roughly a 105° plateau
 * tapering to half reach along the wall face.
 */
const DEFAULT_GRAZE = 1;

let layer = null;

function ensure() {
  if (layer && !layer.destroyed) return layer;
  layer = new PIXI.Container();
  layer.eventMode = "none";
  canvas.interface.addChild(layer);
  return layer;
}

export function clear() {
  if (layer && !layer.destroyed) layer.destroy({ children: true });
  layer = null;
  return { cleared: true };
}

const read = (key, fallback) => {
  try {
    const value = game.settings.get(MODULE_ID, key);
    return value ?? fallback;
  } catch {
    return fallback;
  }
};

/**
 * Band widths per tier, in feet.
 *
 * @remarks
 * **Reading `spillRadius*` under §3.4.1's meaning rather than §3.4's** (Hamilcarbarcas, 2026-08-27:
 * *"rather than a straight band width, the value of each brightness can tell you how large the band
 * of that brightness is"*). The same three stored numbers; what changes is that 40 now means
 * *bright light carries forty feet before it reads as normal* instead of *a bright spill's cone is
 * forty feet long*.
 *
 * The window labels and hints still describe the old meaning and are deliberately left alone until
 * the swap lands — relabelling now would make *Configure Light Spill* lie about the feature that is
 * still running.
 */
function widthTable(overrides = null) {
  const table = {};
  for (const tier of geodesic.SPILL_TIERS) table[tier] = Number(read(SETTING_RADIUS[tier], 0)) || 0;
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      const tier = Number.isFinite(Number(key)) ? Number(key) : TIER[String(key).toUpperCase()];
      if (tier !== undefined) table[tier] = Number(value) || 0;
    }
  }
  return table;
}

/**
 * Draw the geodesic field for every window on the scene.
 *
 * @param {object} [options]
 * @param {number} [options.graze=1] - Speed at 90° off the normal. `1` is no cone at all — pure
 *   geodesic distance, which is what ships. Below 1 tapers the reach toward the wall face.
 * @param {number} [options.angle=105] - Cone angle in degrees. Only consulted when `graze < 1`; the
 *   `spillAngle` setting it used to read was deleted with the old construction, so this is now a
 *   probe argument and nothing else.
 * @param {Record<string|number, number>} [options.widths] - Per-tier band widths in feet, e.g.
 *   `{bright: 40, normal: 20, dim: 10}`. Defaults to the three stored radii.
 * @param {"tier"|"distance"} [options.mode="tier"] - `tier` paints the ladder flat; `distance`
 *   paints the raw field as a continuous ramp, which is what the contour step will actually cut.
 * @param {boolean} [options.walls=true] - Paint the rasterised obstacles red.
 * @param {number} [options.alpha=0.5]
 */
export function draw({
  graze = DEFAULT_GRAZE,
  angle = null,
  widths = null,
  mode = "tier",
  walls = true,
  alpha = 0.5,
} = {}) {
  if (!canvas?.ready) return { drawn: false, reason: "canvas not ready" };

  clear();
  const root = ensure();

  const sceneTier = sceneAmbientTier();
  const table = widthTable(widths);
  const halfAngle = ((Number(angle ?? 105) / 2) * Math.PI) / 180;

  const report = {
    cell: geodesic.cellSize(),
    graze,
    angleDeg: Math.round(((halfAngle * 2) / Math.PI) * 180),
    widths: Object.fromEntries(
      geodesic.SPILL_TIERS.map((tier) => [TIER_NAME[tier], table[tier]])
    ),
    candidates: 0,
    windows: 0,
    apertures: [],
    ms: 0,
  };

  const t0 = performance.now();

  for (const edge of canvas.edges.values()) {
    if (!isAperture(edge)) continue;
    report.candidates++;

    const info = apertureInfo(edge, sceneTier);
    if (!info) continue;

    const steps = geodesic.ladder(info.spillTier, info.floor, table);
    if (!steps.length) continue;

    const result = geodesic.fill({
      a: edge.a,
      b: edge.b,
      normal: info.normal,
      steps,
      region: info.regionPolygons,
      halfAngle,
      graze,
    });
    if (!result) continue;

    const row = {
      edge: edge.id,
      spill: TIER_NAME[info.spillTier],
      room: TIER_NAME[info.interiorTier],
      floor: TIER_NAME[info.floor],
      reachFt: geodesic.reachOf(steps),
      seeds: result.seeds,
      visited: result.visited ?? 0,
      cells: result.grid.size,
      ms: result.ms,
    };

    if (!result.dist) {
      // The failure that matters, and the one the probe exists to make visible rather than to
      // report as a zero: the opening was narrower than the wall raster's own erosion.
      row.reason = result.reason;
      report.apertures.push(row);
      if (walls) paintLinks(root, result, alpha);
      continue;
    }

    report.windows++;
    row.byTier = paintField(root, result, { mode, alpha });
    row.cutLinks = { walls: result.wallLinks, region: result.boundaryLinks };
    if (walls) paintLinks(root, result, Math.min(1, alpha * 1.4));
    report.apertures.push(row);
  }

  report.ms = Math.round((performance.now() - t0) * 100) / 100;
  console.error(`${MODULE_ID} | geodesic probe`, report);
  return report;
}

/**
 * One `Graphics` per tier, rectangles batched inside it.
 *
 * @remarks
 * Grouped by colour rather than drawn cell by cell in field order: a `Graphics` starts a new batch
 * on every `beginFill`, so per-cell fills would produce one draw call per cell and ten thousand of
 * them will drop a frame. Grouped, it is one batch per tier however many cells there are.
 */
function paintField(root, result, { mode, alpha }) {
  const { grid, dist, steps, feetToPixels } = result;
  const { cell } = grid;
  const byTier = {};

  if (mode === "distance") {
    // The raw field, as a continuous ramp over the whole ladder. This is what marching squares will
    // cut, so a contour that is going to come out ragged is already visible here as noise.
    const g = new PIXI.Graphics();
    const reach = result.reach || 1;
    for (let i = 0; i < grid.size; i++) {
      const d = dist[i];
      if (!Number.isFinite(d)) continue;
      const t = Math.min(1, d / reach);
      const v = Math.round((1 - t) * 255);
      const p = geodesic.centerOf(grid, i);
      g.beginFill((v << 16) | (v << 8) | v, alpha);
      g.drawRect(p.x - cell / 2, p.y - cell / 2, cell, cell);
      g.endFill();
    }
    root.addChild(g);
    return { distance: true };
  }

  for (const step of steps) {
    const g = new PIXI.Graphics();
    g.beginFill(TIER_COLOUR[step.tier] ?? 0xffffff, alpha);
    let count = 0;
    for (let i = 0; i < grid.size; i++) {
      const d = dist[i];
      if (!Number.isFinite(d)) continue;
      const feet = d / feetToPixels;
      if (feet < step.from || feet >= step.until) continue;
      const p = geodesic.centerOf(grid, i);
      g.drawRect(p.x - cell / 2, p.y - cell / 2, cell, cell);
      count++;
    }
    g.endFill();
    if (count) root.addChild(g);
    else g.destroy();
    byTier[TIER_NAME[step.tier]] = count;
  }
  return byTier;
}

/**
 * The severed links — what the marcher was actually told it may not do.
 *
 * @remarks
 * **The most useful thing on the overlay, and the reason it is on by default.** Everything else
 * shows what the algorithm decided; this shows what it was given, and reading a bad input off the
 * output is exactly the mistake §6.4.2 records.
 *
 * Drawn as the link itself, centre to centre, rather than as a filled cell. That is not decoration:
 * under blocked cells the red was a *strip of ground the fill had lost*, and it was right to draw it
 * as area because area is what it cost. A cut link costs no ground — it is a severed connection —
 * and drawing it as a stroke across the wall line says so. A continuous red hatch along a wall is
 * the wall sealed; a break in the hatch is a gap light can pass, whether that is a doorway or a bug.
 */
function paintLinks(root, result, alpha) {
  const { grid, links } = result;
  const { cols, rows, cell } = grid;
  const g = new PIXI.Graphics();
  g.lineStyle({ width: Math.max(1, cell * 0.18), color: BLOCKED_COLOUR, alpha });
  let count = 0;

  for (let iy = 0; iy < rows; iy++) {
    for (let ix = 0; ix < cols; ix++) {
      const i = iy * cols + ix;
      const p = geodesic.centerOf(grid, i);
      if (ix < cols - 1 && links.h[i]) {
        g.moveTo(p.x, p.y);
        g.lineTo(p.x + cell, p.y);
        count++;
      }
      if (iy < rows - 1 && links.v[i]) {
        g.moveTo(p.x, p.y);
        g.lineTo(p.x, p.y + cell);
        count++;
      }
    }
  }

  if (count) root.addChild(g);
  else g.destroy();
  return count;
}

/**
 * The two draws worth comparing, side by side in the console.
 *
 * @remarks
 * `graze: 1` is the honest control. Pure geodesic distance is a complete answer on its own, and the
 * cone is a *quality* adjustment on top of it — so the question "is the cone worth its knob" is
 * answered by drawing without it first and seeing whether the wall beside the window looks wrong.
 */
export function compare(options = {}) {
  console.error(`${MODULE_ID} | geodesic — no cone (graze: 1), which is the shipped behaviour`);
  const plain = draw({ ...options, graze: 1 });
  return { plain, next: `game.pf1Lighting.geodesic.draw({ graze: 0.45 })` };
}
