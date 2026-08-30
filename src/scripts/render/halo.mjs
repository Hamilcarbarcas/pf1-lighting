/**
 * Ground boundaries as real ramps instead of a blur. DESIGN.md §6.4.3.
 *
 * The ground cells partition the scene, each flat at its own level, so every boundary between two
 * of them is a step. §6.4.2a softened those with a `PIXI.BlurFilter` per mesh, which §7.0 step 5
 * established cannot produce a gradient: a blur fades a mesh's alpha to reveal what is beneath, so
 * it softens a boundary between two levels but never invents one between them. That is why a spill
 * falloff and a room's edge looked like different mechanisms — they were.
 *
 * This is the per-vertex ramp the other two producers use, applied to the last place still on a
 * filter.
 *
 * A halo is the collar around a cell, from half a transition inside its boundary to half a
 * transition outside, inner edge at the cell's own level and outer edge at whatever cell is found
 * there. Painted `MIN_COLOR`, which is what makes it composable:
 *
 * - the brighter cell's halo bleeds into the darker one, and is the visible transition;
 * - the darker cell's halo over the brighter one is min'd away, every value in it being darker than
 *   what the bright cell already painted.
 *
 * So both cells emit a halo, no coordination is needed, and there is no seam to get wrong — the
 * blend picks the correct half of each pair by itself. The same mechanism §7.0 step 6 uses for two
 * overlapping torches: one rule, applied everywhere brightness meets brightness.
 *
 * Cost: two polygon offsets, one difference and one triangulation per merged region, plus a
 * containment test per outer vertex against the few cells. Ground regions are single digits on an
 * ordinary scene and reach a few dozen only under a heavy umbra — the same order as `applyShadows`,
 * which runs beside it and which §7.0 step 6 records as the thing to remove next.
 */

import { MODULE_ID } from "../constants.mjs";
import {
  CLIPPER_SCALE,
  containsPoint,
  difference,
  fromClipperPaths,
  groupRings,
  toClipperPath,
} from "../geometry.mjs";
import { HALO_SORT } from "./darkness-shaders.mjs";
import { darknessFor } from "./levels.mjs";
import * as fieldBlur from "./texture-blur.mjs";
import { levelAtDistance, width } from "./transition.mjs";

/**
 * Minkowski offset in scene pixels; negative erodes.
 *
 * @remarks
 * `jtMiter`, not `jtRound` (2026-08-27) — round joins made curved transitions ugly and jittery
 * under perspective changes.
 *
 * A round join replaces every vertex with an arc, so a room's corner comes back as a quarter
 * circle, curving where the wall does not. It is also where the faceting came from: Clipper derives
 * its arc segment count from `arcTolerance / delta`, so a fixed tolerance gives progressively fewer
 * segments the smaller the offset. At a half-transition of ~37 px the module's usual `0.5 px`
 * tolerance works out to about nineteen segments for a full circle, which is why a darkness disc
 * came back as a polygon.
 *
 * Miter has neither problem: one point per input vertex, so a corner stays a corner and a circle
 * keeps the resolution its own polygon had — the offset can no longer be coarser than what it
 * offsets. The limit bounds the spike on a sharp reflex corner, past which Clipper squares it off.
 */
function offsetPaths(paths, delta) {
  if (!paths.length || !delta) return paths;
  const co = new ClipperLib.ClipperOffset(2, 0.25);
  co.AddPaths(paths, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
  const out = new ClipperLib.Paths();
  co.Execute(out, delta * CLIPPER_SCALE);
  return out;
}

function cellPaths(cell) {
  const paths = [toClipperPath(cell.polygon, CLIPPER_SCALE)];
  for (const hole of cell.holes ?? []) {
    const path = toClipperPath(hole, CLIPPER_SCALE);
    if (path.length >= 3) paths.push(path);
  }
  return paths;
}

/**
 * The level of whichever cell covers a point, or `null` where none does.
 *
 * @remarks
 * Linear over the cells — right at this size, and it avoids an index that would be rebuilt every
 * repaint anyway. Even-odd across each cell's rings via `containsPoint`, so a point inside a
 * darkness punched out of an ambient cell belongs to the darkness.
 */
function levelAtPoint(point, cells) {
  for (const cell of cells) {
    if (!cell.bounds.contains(point.x, point.y)) continue;
    if (containsPoint(cell.rings, point)) return cell.level;
  }
  return null;
}

/**
 * Rings across the transition, outermost last. More than two, and that is the point.
 *
 * @remarks
 * Two rings give a straight ramp, and at any width worth seeing it looks like one — reported
 * 2026-08-27 at three squares, worst along rounded surfaces. Two rings put every vertex at one of
 * two distances, leaving the rasteriser nothing to interpolate but a line: no S-curve, and worse,
 * the interpolation runs along the chords of a polygonalised circle rather than its radius, so the
 * band scallops with the period of the source polygon. On a curve, which is most boundaries, that
 * is where it shows.
 *
 * Four rings make each band a quarter of the width, so chord error falls with its square, and the
 * levels can carry a real smoothstep instead of a straight line.
 */
const RINGS = 4;

/**
 * One halo per ground region.
 *
 * @remarks
 * One-sided, outward from the boundary. A centred version needs each inner vertex to know what lies
 * beyond the edge, and a point inside the cell cannot be asked that — `levelAtPoint` answers with
 * the cell itself. Ramping outward removes the question: every vertex needing a neighbour is
 * already outside, where the lookup is exact.
 *
 * It composes for the same reason the whole scheme does. Both cells emit a ramp; the bright one's
 * runs outward into the dark and is the visible transition, while the dark one's runs outward into
 * the bright where every value is darker than what is already painted, so `MIN` discards it. The
 * transition therefore always sits on the darker side of a boundary — predictable, and what a light
 * bleeding past an edge looks like.
 *
 * @param {object[]} cells - `{polygon, holes, tier}`, the same list the painter is given
 * @returns {object[]} Ramp payloads in `render/gradient.mjs`'s shape
 */
export function halosFrom(cells) {
  // §6.4.4 — the two are alternatives. Running both softens every boundary twice at two different
  // widths, the state §6.4.3 was written to end.
  if (fieldBlur.isEnabled()) return [];

  const reach = width();
  if (!(reach > 0) || !cells.length) return [];

  const prepared = [];
  for (const cell of cells) {
    if (!(cell?.polygon?.points?.length >= 6) || cell.tier === undefined) continue;
    const rings = cell.holes?.length ? [cell.polygon, ...cell.holes] : [cell.polygon];
    prepared.push({
      cell,
      rings,
      bounds: cell.polygon.getBounds(),
      level: darknessFor(cell.tier).level,
    });
  }
  if (!prepared.length) return [];

  const out = [];
  let index = 0;

  for (const entry of prepared) {
    const paths = cellPaths(entry.cell);
    if (!paths.length) continue;

    const vertices = [];
    const levels = [];
    const indices = [];

    let previous = paths;
    for (let k = 1; k <= RINGS; k++) {
      const distance = (reach * k) / RINGS;
      const grown = offsetPaths(paths, distance);
      if (!grown.length) break;

      const band = difference(grown, previous);
      // Converted once per band, not once per vertex. Inside the vertex loop it re-allocates the
      // whole previous ring per point tested — an O(vertices × ring) allocation storm on the one
      // pass that runs per repaint.
      const innerPolygons = fromClipperPaths(previous, CLIPPER_SCALE);
      previous = grown;
      if (!band.length) continue;

      // The band spans `[(k-1)/RINGS, k/RINGS]` of the transition. Its vertices sit at one end or
      // the other, both outside the cell, so each can be asked directly what it ramps toward.
      const near = ((k - 1) * reach) / RINGS;
      const far = distance;

      for (const group of groupRings(fromClipperPaths(band, CLIPPER_SCALE))) {
        const ring = group.outer;
        if (!(ring?.points?.length >= 6)) continue;
        const points = group.holes?.length ? Array.from(ring.points) : ring.points;
        const holeIndices = [];
        for (const hole of group.holes ?? []) {
          if (!(hole?.points?.length >= 6)) continue;
          holeIndices.push(points.length / 2);
          for (const value of hole.points) points.push(value);
        }

        const tri = PIXI.utils.earcut(points, holeIndices.length ? holeIndices : null, 2);
        if (!tri.length) continue;

        const base = vertices.length / 2;
        for (let i = 0; i < points.length; i += 2) {
          const point = { x: points[i], y: points[i + 1] };
          vertices.push(point.x, point.y);

          // Which end of the band this vertex came off. The band was cut from the previous ring, so
          // an inner-boundary vertex lies inside that ring and an outer-boundary one is a whole
          // band-width outside it. Cheaper and more robust than keeping an index correspondence
          // across a boolean op.
          const inner = near > 0 && containsPoint(innerPolygons, point);
          const d = inner || containsPoint(entry.rings, point) ? near : far;

          const neighbour = levelAtPoint(point, prepared) ?? entry.level;
          levels.push(
            levelAtDistance(d, [
              { r0: -Infinity, r1: 0, level: entry.level },
              { r0: 0, r1: reach, level: neighbour },
              { r0: reach, r1: Infinity, level: neighbour },
            ])
          );
        }
        for (const i of tri) indices.push(base + i);
      }
    }

    if (indices.length < 3) continue;

    out.push({
      id: `${MODULE_ID}.halo.${index++}`,
      kind: "halo",
      blendMode: "MIN_COLOR",
      sortLevel: HALO_SORT,
      nominal: entry.level,
      vertices: new Float32Array(vertices),
      levels: new Float32Array(levels),
      indices: new Uint32Array(indices),
      bounds: entry.bounds.clone().pad(reach),
      // No outline: a halo straddles two cells, so a point query inside one reports the cell rather
      // than the seam between them.
      outline: [],
      triangles: indices.length / 3,
    });
  }

  return out;
}
