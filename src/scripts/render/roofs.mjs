/**
 * Is a roof over this point, as the screen draws it? DESIGN.md §6.2.12.
 *
 * The render answers this per pixel through core's depth mask: a tile with **Restricts Light** writes
 * its mapped elevation into `canvas.masks.depth`'s green channel, and writes nothing where it is faded
 * (`depth.mjs:398-409`). Which part is faded is GPU state – radial and vision occlusion are masks,
 * hover fade a timer – so a JS reconstruction would be an approximation of the one thing the readout
 * must agree with the screen about.
 *
 * So the answer is read back, one pixel, and only after a JS test has found a light-restricting tile
 * whose opaque pixels cover the point. Off a roof, which is nearly every query, no readback happens.
 */

import { MODULE_ID } from "../constants.mjs";
import { GROUND_ELEVATION } from "./darkness-shaders.mjs";

/** Shared frame for the readback, so a query allocates nothing. Built on first use. */
let frame = null;

/**
 * Light-restricting tiles drawn at this point, highest first.
 *
 * @remarks
 * `containsCanvasPoint` applies the tile's own alpha threshold, the same one its depth pass uses
 * (`textureAlphaThreshold`), so a transparent eave is not a roof here either.
 *
 * @param {{x: number, y: number}} point
 * @returns {{elevation: number, tile: Tile}[]}
 */
function candidates(point) {
  const ground = canvas.masks.depth.mapElevation(GROUND_ELEVATION.top);
  const out = [];
  for (const tile of canvas.tiles?.placeables ?? []) {
    const mesh = tile.mesh;
    if (!mesh?.visible || !mesh.restrictsLight) continue;
    if (!(canvas.masks.depth.mapElevation(mesh.elevation) > ground)) continue;
    if (!tile.bounds?.contains(point.x, point.y)) continue;
    if (!mesh.containsCanvasPoint(point)) continue;
    out.push({ elevation: mesh.elevation, tile });
  }
  return out.sort((a, b) => b.elevation - a.elevation);
}

/**
 * The elevation of the roof drawn over a point, or `null` for open ground or a faded roof.
 *
 * @param {{x: number, y: number}} point - Scene coordinates
 * @returns {number|null}
 */
export function roofAt(point) {
  if (!canvas?.ready || !point) return null;
  const found = candidates(point);
  if (!found.length) return null;

  let g;
  try {
    const screen = canvas.stage.worldTransform.apply({ x: point.x, y: point.y });
    frame ??= new PIXI.Rectangle(0, 0, 1, 1);
    frame.x = Math.round(screen.x);
    frame.y = Math.round(screen.y);
    g = canvas.app.renderer.extract.pixels(canvas.masks.depth.renderTexture, frame)?.[1];
  } catch (error) {
    console.error(`${MODULE_ID} | roof readback failed`, error);
    return null;
  }
  // Off screen, or the mask not drawn yet: say nothing rather than guess.
  if (!Number.isFinite(g)) return null;

  // Faded, or covered only by a roof at ground: the ground band passes there, so the screen shows
  // the room and so must the readout.
  const ground = Math.round(canvas.masks.depth.mapElevation(GROUND_ELEVATION.top) * 255);
  if (g <= ground) return null;

  // The roof the mask recorded, matched by mapped elevation; several tiles can stack.
  const hit = found.find((c) => Math.round(canvas.masks.depth.mapElevation(c.elevation) * 255) === g);
  return (hit ?? found[0]).elevation;
}
