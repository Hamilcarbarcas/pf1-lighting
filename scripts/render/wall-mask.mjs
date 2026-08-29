/**
 * **Where the brightness field must not be blurred.** DESIGN.md §6.4.7.
 *
 * Hamilcarbarcas, 2026-08-27: *"I want to be able to turn off blurring on lines created by walls. That way
 * a lit interior room won't bleed light outside, and a dark room won't have light from around it
 * bleeding over the walls."*
 *
 * ## The bleed is the blur doing its job in the wrong place
 *
 * A light's mesh already stops exactly at the wall — `source.shape` is a wall-clipped sweep, and
 * that part has always been right. §6.4.4 then blurs the **composited field**, and a convolution
 * does not know what a wall is: it mixes the lit fragment inside the room with the unlit one
 * outside, in both directions, across roughly one `transitionWidth`. So the room glows through its
 * own walls, and a dark room picks up the corridor outside it.
 *
 * Every other boundary in the field *wants* that treatment. This one does not, and a wall is the
 * one case where the hard edge is also the physically right answer: a wall casts a sharp shadow at
 * its own surface.
 *
 * ## Why a mask of segments, and not per-mesh metadata
 *
 * The first instinct is to have each producer record which of its boundary vertices came from a
 * wall — `light-ramps` could do it cheaply, since a sweep vertex closer to the origin than
 * `source.radius` is wall-derived by construction. That would be per-mesh work on every repaint,
 * for every light, and it would still miss every boundary produced by something other than a light.
 *
 * `canvas.edges` already holds the answer for the whole scene: a collection of `Edge` objects with
 * `a`, `b` and a per-sense restriction (`edge.light`). Drawing those segments into one screen-sized
 * texture is a single `Graphics` pass, independent of how many meshes the field has, and it is
 * rebuilt only when the edges themselves change. **The walls are scene data, not mesh data**, and
 * asking the meshes was the more expensive way to learn something the scene already knew.
 *
 * ## What the width means
 *
 * The band is drawn `BAND × transitionWidth` wide, centred on the wall, because that is the reach
 * of the thing it has to defeat: a Gaussian's visible extent is about twice its strength, and
 * `render/texture-blur.mjs` runs at `width() / 2`, so brightness travels about one `width()` past
 * any hard edge. Covering one `width()` on each side is what makes the suppression complete rather
 * than merely reduced.
 *
 * That the band also un-blurs *other* boundaries which happen to run within a wall's width is
 * accepted, and is mostly the same boundary anyway — the light's own cut edge lies along the wall.
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
 * A `CachedContainer` for the same reason `DarknessLevelContainer` is one, and added to
 * `canvas.masks` for the same reason: it inherits the stage transform, so a `Graphics` holding
 * **world** coordinates rasterises into a **screen**-sized texture that the filter can sample at
 * screen UVs. That is the whole trick, and it is core's, not ours.
 *
 * `RED` because one channel is all a mask needs, and `LINEAR` rather than `NEAREST` — unlike the
 * darkness levels, this value is lerped against rather than read as a quantity, so a smooth ramp
 * at the band's own edge is worth more than an exact texel.
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
 * **`edge.light`, not `edge.sight`.** The field this protects is a *brightness* field, so the
 * question is whether light crosses the edge — a window that blocks sight but passes light should
 * blur normally, and §3.4's whole spill feature exists because that case is real.
 *
 * Scene-bounds edges are included rather than filtered out. They restrict light in exactly the same
 * way and the field has no business bleeding past the scene rect either.
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
 * The width is part of the signature, not just the edge set: `transitionWidth` is a live setting
 * and a band drawn at the old width would silently under- or over-cover.
 *
 * `alpha: 1` on a `RED` target writes 1.0 to the channel; the filter reads it as "fully sharp
 * here". Round caps and joins so a corner between two walls has no gap for brightness to squeeze
 * through — the one artefact that would look like the feature half-working.
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
  // `refreshEdges` is the flag core raises whenever the edge collection is rebuilt — a wall added,
  // moved, deleted, or a door opened. Hooking the *edges* rather than the walls means a door
  // toggling light restriction is caught without knowing that a door is a thing.
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

/** Scene teardown — the container goes with `canvas.masks`, so this only drops our references. */
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
 * `segments: 0` on a scene with walls is the interesting failure and means every edge reported
 * `light === NONE` — a scene whose walls are all set to pass light, or a Foundry that renamed the
 * property. Compare against `canvas.edges.size`.
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
