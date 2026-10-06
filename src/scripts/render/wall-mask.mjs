/**
 * Where the brightness field's blur must stop. DESIGN.md §6.4.7, §6.4.7b.
 *
 * The bleed is the blur doing its job in the wrong place. A light's mesh already stops exactly at
 * the wall — `source.shape` is a wall-clipped sweep — but §6.4.4 blurs the composited field, and a
 * convolution does not know what a wall is: it mixes the lit fragment inside the room with the
 * unlit one outside, both directions, across roughly one `transitionWidth`. So a room glows through
 * its own walls and a dark room picks up the corridor outside.
 *
 * Every other boundary in the field wants that treatment. A wall is the one case where the hard
 * edge is also physically right: a wall casts a sharp shadow at its own surface.
 *
 * A mask of segments rather than per-mesh metadata. Having each producer record which boundary
 * vertices came from a wall is cheap for `light-ramps` — a sweep vertex closer to the origin than
 * `source.radius` is wall-derived by construction — but it is per-mesh work on every repaint, for
 * every light, and still misses every boundary produced by something other than a light.
 * `canvas.edges` already holds the answer for the whole scene: `Edge` objects with `a`, `b` and a
 * per-sense restriction (`edge.light`). Drawing those into one screen-sized texture is a single
 * `Graphics` pass, independent of mesh count, rebuilt only when the edges change. Walls are scene
 * data, not mesh data.
 *
 * Since §6.4.7b (2026-10-06) the texture is a **barrier**, not a band: each wall is a thin line,
 * and `render/texture-blur.mjs` runs a blur whose taps stop at the first barrier they reach. The
 * band chose between a blurred and a sharp field, which seamed every boundary crossing a wall; a
 * blur that cannot see past a wall has no second field to seam against.
 *
 * A wall-height wall is drawn only while some light's own sweep keeps it (§6.4.7a).
 */

import { MODULE_ID, isSynthetic, passesLight } from "../constants.mjs";

/**
 * Line width the barrier is redrawn at, as a multiple of what the blur asked for.
 *
 * @remarks
 * The blur's taps step `spacing` screen pixels at a time, so a line thinner than that can be stepped
 * over. The width is world units on a screen-scaled requirement, so zoom changes it; a redraw is
 * needed only once the drawn line falls under the requirement or grows past {@link SLACK_MAX} times
 * it. Thicker than needed costs only a few unblurred pixels along the wall itself.
 */
const SLACK_DRAW = 1.5;
const SLACK_MAX = 3;

/** The requirement before the blur has first run, in screen pixels. */
const DEFAULT_BARRIER = 4;

let container = null;
let graphics = null;
let dirty = true;
/** Drawn line width, in world units. */
let lineWidth = null;
/** What the blur last asked for, in screen pixels. */
let required = DEFAULT_BARRIER;
let segments = 0;

/** Ids of light-blocking edges with a finite wall-height range, from the last edge pass. */
let bounded = new Set();
/** Signature of the bounded edges some light currently keeps. */
let keptSignature = "";
let kept = new Set();

/**
 * The mask container, built on first use.
 *
 * @remarks
 * A `CachedContainer` in `canvas.masks`, for the reason `DarknessLevelContainer` is one: it
 * inherits the stage transform, so a `Graphics` holding world coordinates rasterises into a
 * screen-sized texture the filter samples at screen UVs. Core's trick, not this module's.
 *
 * `RED` because one channel is all a mask needs. `LINEAR`, read against a 0.5 threshold, so a tap
 * landing between texels still finds a line it is inside.
 */
function ensure() {
  if (container && !container.destroyed) return container;
  if (!canvas?.masks) return null;

  const Base = foundry.canvas.containers.CachedContainer;

  container = new (class WallMaskContainer extends Base {
    static textureConfiguration = {
      scaleMode: PIXI.SCALE_MODES.LINEAR,
      format: PIXI.FORMATS.RED,
      multisample: PIXI.MSAA_QUALITY.NONE,
      mipmap: PIXI.MIPMAP_MODES.OFF,
    };
  })();

  container.autoRender = true;
  container.renderDirty = true;
  graphics = new PIXI.Graphics();
  container.addChild(graphics);
  canvas.masks.addChild(container);
  dirty = true;
  return container;
}

/**
 * Which edges block light, and therefore must not be blurred across.
 *
 * @remarks
 * {@link passesLight}, the module's one answer. This protects a brightness field, so the question is
 * whether light crosses the edge — a window that blocks sight but passes light should blur normally,
 * which is what §3.4's spill feature exists for. Sharing the predicate with `spill.isAperture` is
 * what stops a band being masked away at the very window it came through.
 *
 * No filter on `edge.type`, unlike `spill.isAperture` — anything that restricts light restricts it
 * the same way here. That admits nothing extra in practice: `#defineBoundaries` builds the scene
 * rect's edges with no restrictions at all (`geometry/edges/edges.mjs:148`), so the bounds fall out
 * as light-passing and the blur runs to the edge of the canvas as it always has.
 */
function* blocking() {
  const edges = canvas?.edges;
  if (!edges) return;
  for (const edge of edges.values()) {
    if (passesLight(edge)) continue;
    if (!edge.a || !edge.b) continue;
    if (bounded.has(edge.id) && !kept.has(edge.id)) continue;
    yield edge;
  }
}

/**
 * Does wall-height give this edge a finite range, so some sources pass over or under it?
 *
 * @remarks
 * Such a wall blocks one light and not another, and the mask is scene-wide, so it cannot be judged
 * by itself. Unbounded walls block every light and stay masked unconditionally, which also keeps
 * global illumination from bleeding into a walled interior, where no light source's sweep would
 * ever report the wall.
 *
 * Wall-height off, or its *advanced vision* off for the scene, means it filters nothing, so nothing
 * is bounded.
 */
function heightBounded(edge) {
  const wallHeight = globalThis.WallHeight;
  if (!wallHeight?.getWallBounds || !game.modules.get("wall-height")?.active) return false;
  if (canvas.scene?.flags?.["wall-height"]?.advancedVision === false) return false;
  if (edge.type !== "wall" || !edge.object) return false;
  const { top, bottom } = wallHeight.getWallBounds(edge.object);
  return Number.isFinite(top) || Number.isFinite(bottom);
}

/**
 * The bounded edges at least one light or darkness actually stops at.
 *
 * @remarks
 * Read from each sweep's own `edges` set (`clockwise-sweep.mjs:213`), which holds what survived
 * `_testEdgeInclusion` — wall-height's verdict included. Asking the result rather than re-deriving
 * wall-height's elevation rule means a torch below the wall and a lantern above it each answer
 * for themselves. Synthetic clones are skipped: they stand in for a real source already counted.
 */
function keptBounded() {
  const ids = new Set();
  if (!bounded.size) return ids;
  for (const group of [canvas.effects?.lightSources, canvas.effects?.darknessSources]) {
    for (const source of group ?? []) {
      if (!source.active || isSynthetic(source)) continue;
      const edges = source.shape?.edges;
      if (!edges) continue;
      for (const edge of edges) if (bounded.has(edge.id)) ids.add(edge.id);
    }
  }
  return ids;
}

/** Re-read which bounded walls are kept; marks the mask dirty only when the answer moved. */
function refreshKept() {
  const next = keptBounded();
  const signature = [...next].sort().join(",");
  if (signature === keptSignature) return false;
  kept = next;
  keptSignature = signature;
  dirty = true;
  return true;
}

/** Collect the bounded edge ids. Runs on an edge pass only. */
function collectBounded() {
  bounded = new Set();
  for (const edge of canvas?.edges?.values() ?? []) {
    if (passesLight(edge)) continue;
    if (heightBounded(edge)) bounded.add(edge.id);
  }
}

/** World units per screen pixel at the current zoom. */
function worldPerPixel() {
  return 1 / (canvas?.stage?.scale?.x || 1);
}

/** Is the drawn line still at least as thick as required, and not absurdly thicker? */
function widthHolds() {
  if (lineWidth == null) return false;
  const onScreen = lineWidth / worldPerPixel();
  return onScreen >= required && onScreen <= required * SLACK_MAX;
}

/**
 * Tell the mask how thick, in screen pixels, a barrier must be for the blur not to step over it.
 *
 * @remarks
 * Called by the blur on every application, so a zoom is caught on the next repaint. Redraws only
 * when the drawn width has stopped holding, which during a zoom is a handful of times rather than
 * every frame.
 *
 * @param {number} pixels
 */
export function requireWidth(pixels) {
  if (!(pixels > 0)) return;
  required = pixels;
  if (!widthHolds()) sync();
}

/**
 * Redraw the lines if anything they depend on has moved: the edge set, which bounded walls some
 * light keeps, or the width the blur needs at this zoom.
 *
 * @remarks
 * Round caps and joins so a corner between two walls leaves no gap for a tap to pass through.
 */
export function sync({ force = false } = {}) {
  const target = ensure();
  if (!target) return null;

  if (dirty || force) collectBounded();
  refreshKept();
  if (!force && !dirty && widthHolds()) return { segments, lineWidth };

  dirty = false;
  lineWidth = required * SLACK_DRAW * worldPerPixel();

  graphics.clear();
  graphics.lineStyle({
    width: lineWidth,
    color: 0xff0000,
    alpha: 1,
    cap: PIXI.LINE_CAP.ROUND,
    join: PIXI.LINE_JOIN.ROUND,
  });
  segments = 0;
  for (const edge of blocking()) {
    graphics.moveTo(edge.a.x, edge.a.y);
    graphics.lineTo(edge.b.x, edge.b.y);
    segments++;
  }

  target.renderDirty = true;
  return { segments, lineWidth };
}

/** The texture a filter samples, or `null` before the first sync. */
export function texture() {
  return container && !container.destroyed ? container.renderTexture : null;
}

/** Mark the segments stale: the edges moved. */
export function invalidate() {
  dirty = true;
}

export function registerHooks() {
  // `refreshEdges` is the flag core raises whenever the edge collection is rebuilt — wall added,
  // moved, deleted, or a door opened. Hooking the edges rather than the walls catches a door
  // toggling light restriction without needing to know a door is a thing.
  Hooks.on("canvasReady", () => {
    container = null;
    graphics = null;
    invalidate();
    sync({ force: true });
  });
  for (const hook of ["createWall", "updateWall", "deleteWall", "canvasEdgesRefresh"]) {
    Hooks.on(hook, () => {
      invalidate();
      sync();
    });
  }
  // Which bounded walls are kept depends on the lights, which move without the edges moving. A
  // refresh with no bounded walls on the scene costs one empty-set check.
  Hooks.on("lightingRefresh", () => {
    if (!container || container.destroyed || !bounded.size) return;
    if (refreshKept()) sync();
  });
}

/** Scene teardown. The container goes with `canvas.masks`; this only drops the local references. */
export function dispose() {
  container = null;
  graphics = null;
  dirty = true;
  lineWidth = null;
  required = DEFAULT_BARRIER;
  bounded = new Set();
  kept = new Set();
  keptSignature = "";
}

/**
 * Debug readout.
 *
 * @remarks
 * `segments: 0` on a scene with walls is the interesting failure: every edge reported
 * `light === NONE`, meaning walls all set to pass light, or a Foundry that renamed the property.
 * Compare against `canvas.edges.size`.
 *
 * `heightBounded` counts wall-height walls with a finite range; `heightKept` is how many of them
 * some light currently stops at, and only those are drawn. A low wall every light passes over
 * should be in the first and not the second.
 */
export function status() {
  const report = {
    segments,
    edges: canvas?.edges?.size ?? null,
    heightBounded: bounded.size,
    heightKept: kept.size,
    // Barrier line width on screen, and what the blur's tap spacing requires. `drawn` below
    // `required` means taps can step over a wall.
    drawn: lineWidth == null ? null : +(lineWidth / worldPerPixel()).toFixed(2),
    required: +required.toFixed(2),
    attached: !!container && !container.destroyed,
    dirty,
  };
  console.error(`${MODULE_ID} | wall mask`, report);
  return report;
}
