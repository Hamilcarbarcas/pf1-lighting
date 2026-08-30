/**
 * Shared polygon primitives.
 *
 * Extracted when umbra (§4.3) became the second consumer of Clipper. `field.mjs` keeps its
 * own copies of the boolean operations deliberately — its `boolOp` increments a per-compute
 * `opCount` that the subdivision benchmarks read (§9.6), and threading a counter through a
 * shared helper would put instrumentation into everyone's call path to serve one caller.
 * What is shared here is the part that must **not** diverge: the scaling factor and the
 * conversions either side of it.
 */

/**
 * Clipper works in integers, so coordinates are scaled before and after.
 *
 * Core uses 100 wherever it touches Clipper (`common/constants.mjs:2146`). Matching it is
 * not cosmetic: a path produced at one scale and consumed at another silently yields
 * geometry off by a factor of 100, which reads as "the polygon vanished" rather than as a
 * unit error.
 */
export const CLIPPER_SCALE = 100;

/**
 * A polygon's points as a Clipper path.
 *
 * @param {PIXI.Polygon|{points: number[]}} polygon
 * @param {number} [scale=CLIPPER_SCALE]
 * @returns {{X: number, Y: number}[]}
 */
export function toClipperPath(polygon, scale = CLIPPER_SCALE) {
  const pts = polygon?.points;
  if (!pts?.length) return [];
  const path = new Array(pts.length / 2);
  for (let i = 0, j = 0; i < pts.length; i += 2, j++) {
    path[j] = { X: Math.round(pts[i] * scale), Y: Math.round(pts[i + 1] * scale) };
  }
  return path;
}

/**
 * Clipper paths back to polygons.
 *
 * Degenerate rings are dropped: Clipper can emit two-point slivers from a difference, and
 * they are not drawable, not testable, and not meaningful.
 *
 * @param {{X: number, Y: number}[][]} paths
 * @param {number} [scale=CLIPPER_SCALE]
 * @returns {PIXI.Polygon[]}
 */
export function fromClipperPaths(paths, scale = CLIPPER_SCALE) {
  const out = [];
  for (const path of paths ?? []) {
    if (!path || path.length < 3) continue;
    const points = new Array(path.length * 2);
    for (let i = 0, j = 0; i < path.length; i++, j += 2) {
      points[j] = path[i].X / scale;
      points[j + 1] = path[i].Y / scale;
    }
    out.push(new PIXI.Polygon(points));
  }
  return out;
}

/**
 * `subject` minus `clip`.
 *
 * @remarks
 * `pftNonZero` rather than even-odd, matching `field.mjs` and core. With even-odd, two
 * overlapping subject paths cancel where they overlap, which turns an overlap into a hole.
 *
 * @param {{X: number, Y: number}[][]} subject
 * @param {{X: number, Y: number}[][]} clip
 * @returns {{X: number, Y: number}[][]}
 */
export function difference(subject, clip) {
  const c = new ClipperLib.Clipper();
  c.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
  if (clip?.length) c.AddPaths(clip, ClipperLib.PolyType.ptClip, true);
  const solution = new ClipperLib.Paths();
  c.Execute(
    ClipperLib.ClipType.ctDifference,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero
  );
  return solution;
}

/** `subject` ∩ `clip`. Same fill rule and reasoning as {@link difference}. */
export function intersection(subject, clip) {
  const c = new ClipperLib.Clipper();
  c.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
  if (clip?.length) c.AddPaths(clip, ClipperLib.PolyType.ptClip, true);
  const solution = new ClipperLib.Paths();
  c.Execute(
    ClipperLib.ClipType.ctIntersection,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero
  );
  return solution;
}

/** Union of every path. One path in, one path out — no Clipper call. */
export function union(paths) {
  if (!paths?.length) return [];
  if (paths.length === 1) return [paths[0]];
  const c = new ClipperLib.Clipper();
  c.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
  const solution = new ClipperLib.Paths();
  c.Execute(
    ClipperLib.ClipType.ctUnion,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero
  );
  return solution;
}

/**
 * Group a flat ring list into `{outer, holes}` pairs.
 *
 * @remarks
 * A Clipper solution is a flat list in which holes are marked only by reversed winding, and
 * anything that renders a region as a *mesh* needs them attached to the right outer ring —
 * `earcut` takes one outer plus its holes, not a soup. {@link splitRings} answers which is
 * which; this answers which belongs to which.
 *
 * Holes are assigned by testing a vertex against each outer, and only when there is more than
 * one outer. The single-outer case is both overwhelmingly the common one (a scene rect with a
 * hole per darkness) and free.
 *
 * @param {PIXI.Polygon[]} polygons
 * @returns {{outer: PIXI.Polygon, holes: PIXI.Polygon[]}[]}
 */
export function groupRings(polygons) {
  const { outers, holes } = splitRings(polygons);
  if (outers.length === 1) return [{ outer: outers[0], holes }];
  return outers.map((outer) => ({
    outer,
    holes: holes.filter((hole) => outer.contains(hole.points[0], hole.points[1])),
  }));
}

/**
 * Signed area, for telling an outer ring from a hole.
 *
 * @param {PIXI.Polygon} polygon
 * @returns {number} Positive or negative by winding direction
 */
export function signedArea(polygon) {
  const p = polygon?.points;
  if (!p || p.length < 6) return 0;
  let sum = 0;
  for (let i = 0, n = p.length; i < n; i += 2) {
    const j = (i + 2) % n;
    sum += p[i] * p[j + 1] - p[j] * p[i + 1];
  }
  return sum / 2;
}

/**
 * Split a path list into outer rings and holes by winding direction.
 *
 * @remarks
 * Clipper marks holes by reversing their winding, and the sign that means "outer" depends on
 * the coordinate convention — so it is read off the **largest** ring rather than assumed.
 * Disjoint outer rings all share a winding, so this is correct for several at once.
 *
 * @param {PIXI.Polygon[]} polygons
 * @returns {{outers: PIXI.Polygon[], holes: PIXI.Polygon[]}}
 */
export function splitRings(polygons) {
  if (polygons.length < 2) return { outers: [...polygons], holes: [] };

  let outerSign = 0;
  let largest = 0;
  for (const polygon of polygons) {
    const area = signedArea(polygon);
    if (Math.abs(area) > largest) {
      largest = Math.abs(area);
      outerSign = Math.sign(area);
    }
  }

  const outers = [];
  const holes = [];
  for (const polygon of polygons) {
    (Math.sign(signedArea(polygon)) === outerSign ? outers : holes).push(polygon);
  }
  return { outers, holes };
}

/**
 * Is a point inside this region?
 *
 * @remarks
 * **Even-odd across every ring, not "inside any".** A Clipper result routinely contains
 * holes — subtracting a darkness bubble from an observer's line of sight leaves the bubble as
 * a reversed ring inside the result — and treating each ring as a separate solid says a point
 * in the hole is inside the region. That is exactly backwards: the hole is the part that was
 * removed.
 *
 * Counting crossings handles nesting to any depth without needing to know which ring is
 * which, so it stays correct for a hole inside a hole.
 *
 * @param {PIXI.Polygon[]} polygons
 * @param {{x: number, y: number}} point
 * @returns {boolean}
 */
export function containsPoint(polygons, point) {
  let crossings = 0;
  for (const polygon of polygons) {
    if (polygon.contains(point.x, point.y)) crossings++;
  }
  return crossings % 2 === 1;
}
