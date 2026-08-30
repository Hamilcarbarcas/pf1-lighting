/**
 * Where the brightness field must not be blurred. DESIGN.md §6.4.7.
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
 * The band is `BAND × transitionWidth` wide, centred on the wall, matching the reach of what it
 * defeats: a Gaussian's visible extent is about twice its strength and `render/texture-blur.mjs`
 * runs at `width() / 2`, so brightness travels about one `width()` past any hard edge. One
 * `width()` each side makes the suppression complete rather than merely reduced.
 *
 * The band also un-blurs other boundaries running within a wall's width. Accepted, and mostly the
 * same boundary anyway — the light's own cut edge lies along the wall.
 */

import { MODULE_ID } from "../constants.mjs";
import { width as transitionWidth } from "./transition.mjs";

/**
 * Half-widths of the sharp band, in multiples of the transition width.
 *
 * @remarks
 * Two, so the band spans one `transitionWidth` on each side of the wall. Less leaves a visible
 * remnant of the bleed; more starts un-blurring boundaries that have nothing to do with the wall.
 */
const BAND = 2;

let container = null;
let graphics = null;
let dirty = true;
let lastWidth = null;
let segments = 0;

/**
 * The mask container, built on first use.
 *
 * @remarks
 * A `CachedContainer` in `canvas.masks`, for the reason `DarknessLevelContainer` is one: it
 * inherits the stage transform, so a `Graphics` holding world coordinates rasterises into a
 * screen-sized texture the filter samples at screen UVs. Core's trick, not this module's.
 *
 * `RED` because one channel is all a mask needs. `LINEAR` rather than `NEAREST` — unlike the
 * darkness levels this value is lerped against rather than read as a quantity, so a smooth ramp at
 * the band's edge beats an exact texel.
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
 * `edge.light`, not `edge.sight`. This protects a brightness field, so the question is whether
 * light crosses the edge — a window that blocks sight but passes light should blur normally, which
 * is what §3.4's spill feature exists for.
 *
 * Scene-bounds edges are included rather than filtered out: they restrict light the same way, and
 * the field has no business bleeding past the scene rect either.
 */
function* blocking() {
  const edges = canvas?.edges;
  if (!edges) return;
  const NONE = CONST.WALL_SENSE_TYPES.NONE;
  for (const edge of edges.values()) {
    if ((edge.light ?? NONE) === NONE) continue;
    if (!edge.a || !edge.b) continue;
    yield edge;
  }
}

/**
 * Redraw the segments if anything they depend on has moved.
 *
 * @remarks
 * The width is part of the signature, not just the edge set: `transitionWidth` is a live setting,
 * and a band drawn at the old width silently under- or over-covers.
 *
 * `alpha: 1` on a `RED` target writes 1.0 to the channel, read by the filter as fully sharp. Round
 * caps and joins so a corner between two walls leaves no gap for brightness to squeeze through —
 * the artefact that would look like the feature half-working.
 */
export function sync({ force = false } = {}) {
  const target = ensure();
  if (!target) return null;

  const band = transitionWidth() * BAND;
  if (!force && !dirty && lastWidth === band) return { segments, band };

  dirty = false;
  lastWidth = band;
  segments = 0;

  graphics.clear();
  if (band > 0) {
    graphics.lineStyle({
      width: band,
      color: 0xffffff,
      alpha: 1,
      cap: PIXI.LINE_CAP.ROUND,
      join: PIXI.LINE_JOIN.ROUND,
    });
    for (const edge of blocking()) {
      graphics.moveTo(edge.a.x, edge.a.y);
      graphics.lineTo(edge.b.x, edge.b.y);
      segments++;
    }
  }

  target.renderDirty = true;
  return { segments, band };
}

/** The texture a filter samples, or `null` before the first sync. */
export function texture() {
  return container && !container.destroyed ? container.renderTexture : null;
}

/** Mark the segments stale — the edges moved, or the width changed. */
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
}

/** Scene teardown. The container goes with `canvas.masks`; this only drops the local references. */
export function dispose() {
  container = null;
  graphics = null;
  dirty = true;
  lastWidth = null;
}

/**
 * Debug readout.
 *
 * @remarks
 * `segments: 0` on a scene with walls is the interesting failure: every edge reported
 * `light === NONE`, meaning walls all set to pass light, or a Foundry that renamed the property.
 * Compare against `canvas.edges.size`.
 */
export function status() {
  const report = {
    segments,
    edges: canvas?.edges?.size ?? null,
    band: lastWidth,
    attached: !!container && !container.destroyed,
    dirty,
  };
  console.error(`${MODULE_ID} | wall mask`, report);
  return report;
}
