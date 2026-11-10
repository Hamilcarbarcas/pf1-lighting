/**
 * Where a token's light is read, and how several readings become one. DESIGN.md §11.3.1.
 */

/**
 * Every grid space a token occupies, as centre points.
 *
 * @remarks
 * The bounds walk is the live path; v13 has no `getOccupiedGridSpaceOffsets`. The optional call
 * is there because a version that adds it would handle hex grids and odd token shapes, which the
 * walk does not; on hex or gridless scenes it approximates.
 */
export function footprint(token) {
  const grid = canvas?.grid;
  const doc = token?.document;
  if (!grid || !doc) return [];

  const offsets = doc.getOccupiedGridSpaceOffsets?.();
  if (offsets?.length) {
    return offsets.map((offset) => {
      const { x, y } = grid.getCenterPoint(offset);
      return { x, y, elevation: doc.elevation ?? 0 };
    });
  }

  const b = token.bounds;
  const size = grid.size || 100;
  const points = [];
  for (let y = b.y + size / 2; y < b.y + b.height; y += size) {
    for (let x = b.x + size / 2; x < b.x + b.width; x += size) {
      points.push({ x, y, elevation: doc.elevation ?? 0 });
    }
  }
  return points;
}

/**
 * The points the `"majority"` sample reads. One square or smaller: the centre and the four points
 * halfway to the corners (core's visibility test points, minus the edge ones). Larger: every
 * occupied square's centre, plus the token centre when it isn't one of them.
 */
export function majorityPoints(token) {
  const doc = token?.document;
  const centre = token?.center;
  if (!doc || !centre) return [];
  const elevation = doc.elevation ?? 0;
  const size = canvas?.grid?.size || 100;
  const width = doc.width ?? 1;
  const height = doc.height ?? 1;

  if (width <= 1 && height <= 1) {
    const dx = (width * size) / 4;
    const dy = (height * size) / 4;
    return [
      { x: centre.x, y: centre.y, elevation },
      { x: centre.x - dx, y: centre.y - dy, elevation },
      { x: centre.x + dx, y: centre.y - dy, elevation },
      { x: centre.x - dx, y: centre.y + dy, elevation },
      { x: centre.x + dx, y: centre.y + dy, elevation },
    ];
  }

  const points = footprint(token);
  const hasCentre = points.some((p) => Math.abs(p.x - centre.x) < 1 && Math.abs(p.y - centre.y) < 1);
  if (!hasCentre) points.push({ x: centre.x, y: centre.y, elevation });
  return points;
}

/**
 * Index of the majority reading once readings are sorted brightest first: the highest tier that
 * more than half the points reach (3 of 5).
 */
export const majorityIndex = (count) => Math.floor(count / 2);

/** The majority tier of several tiers. */
export function majorityTier(tiers) {
  const sorted = [...tiers].sort((a, b) => b - a);
  return sorted[majorityIndex(sorted.length)];
}
