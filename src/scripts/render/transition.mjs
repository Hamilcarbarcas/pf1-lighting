/**
 * One gradient, everywhere. DESIGN.md §6.4.3.
 *
 * Consolidated 2026-08-27. Before that each boundary had a mechanism invented for it, with its own
 * units:
 *
 * | Boundary | Was | Width was expressed as |
 * | --- | --- | --- |
 * | region edge, darkness rim, umbra | a `PIXI.BlurFilter` on the mesh | blur strength in world px |
 * | §3.4 spill band | per-vertex ramp | a fraction of a band |
 * | §7.0 step 6 light zone | per-vertex ramp | a fraction of the narrower zone |
 *
 * So three different things could be "half a transition" depending on what they sat next to, and a
 * blur is not a gradient at all — it fades a mesh's alpha to reveal what is beneath, which is why
 * §7.0 step 5 could never make one read as a ramp.
 *
 * The rule: every brightness boundary ramps over the same distance, centred on the boundary. One
 * number, in grid squares, meaning the same at a region edge, a darkness rim, a light's zone
 * boundary and a window's spill. A two-rung boundary is not widened for it — a wider fade would
 * read as less of a step, and a two-rung boundary is more of one.
 *
 * All three producers call {@link levelAtDistance} with zones in scene pixels, differing only in
 * where the distance comes from:
 *
 * | Producer | Distance is |
 * | --- | --- |
 * | `render/halo.mjs` | signed distance across a ground cell's boundary |
 * | `model/spill.mjs` + `render/gradient.mjs` | distance out from the lit wedge |
 * | `render/light-ramps.mjs` | distance from the light's origin |
 *
 * The old `spillPlateau` control went with the fractional widths it expressed. A plateau is not a
 * thing to set: it is whatever remains of a zone once its two transitions are taken out, so a zone
 * narrower than a transition never reaches its nominal level rather than squeezing one in.
 */

import { MODULE_ID } from "../constants.mjs";
import { number } from "../settings-cache.mjs";

export const SETTING_WIDTH = "transitionWidth";

/**
 * The distance one tier step of brightness fades over, in scene pixels.
 *
 * @remarks
 * Stored in grid squares rather than pixels, for the reason `soften.groundSoftness` gives: it is a
 * distance on the map, so it must not change with zoom or grid size.
 */
export function width() {
  // The setting is cached, the product is not. `canvas.grid.size` is per scene and stays a live
  // read; only the stored number goes through `settings-cache.mjs`. Worth caching because
  // `light-ramps.cacheKey` reaches this once per light cell per pass.
  return Math.max(0, number(SETTING_WIDTH, 0.75)) * (canvas?.grid?.size ?? 100);
}

/** Hermite. A linear ramp between two plateaus shows its own two corners. */
export const smooth = (t) => t * t * (3 - 2 * t);
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const mix = (a, b, t) => a + (b - a) * t;

/**
 * How wide the transition between two levels is, in scene pixels.
 *
 * @remarks
 * {@link width}, independent of how far apart the two levels are. That is the content of a single
 * gradient system: one distance, so a Normal/Dim edge and a Bright/Dark edge are the same
 * thickness of fade and differ only in how much brightness crosses it.
 *
 * Both arguments stay in the signature because every call site has them, and a future rule that
 * does vary with the gap belongs here rather than at four producers.
 */
export function spanFor(from, to) {
  void from;
  void to;
  return width();
}

/**
 * The level at a distance, across a run of contiguous zones.
 *
 * @remarks
 * `zones` are `{r0, r1, level}` ascending, in scene pixels; the first may start at `-Infinity` and
 * the last may end at it. Each internal boundary carries a centred {@link spanFor}-wide transition,
 * clamped so it never eats more than half of either neighbour — a zone narrower than its own
 * transitions then never reaches its nominal level, rather than squeezing in a plateau.
 *
 * `trailing` covers one case: a light's outermost boundary has no geometry past it to carry the
 * other half of a centred ramp, so it finishes at the rim instead of straddling it. That is also
 * what hides the mesh's own silhouette — it hands back exactly the ground level at its edge.
 *
 * @param {number} d - Distance, scene pixels
 * @param {{r0: number, r1: number, level: number}[]} zones
 * @param {object} [options]
 * @param {boolean} [options.trailing] - Finish the last transition at the boundary, not across it
 * @returns {number}
 */
export function levelAtDistance(d, zones, { trailing = false } = {}) {
  const last = zones.length - 1;
  if (last < 0) return 0;
  if (last === 0) return zones[0].level;

  let i = 0;
  while (i < last && d > zones[i].r1) i++;
  const z = zones[i];

  const halfOf = (a, b) => {
    const span = spanFor(a.level, b.level) / 2;
    const roomA = Number.isFinite(a.r1 - a.r0) ? (a.r1 - a.r0) / 2 : Infinity;
    const roomB = Number.isFinite(b.r1 - b.r0) ? (b.r1 - b.r0) / 2 : Infinity;
    return Math.max(1e-6, Math.min(span, roomA, roomB));
  };

  if (i > 0) {
    const prev = zones[i - 1];
    const h = halfOf(prev, z);
    if (d < z.r0 + h) return mix(prev.level, z.level, smooth(clamp01((d - z.r0 + h) / (2 * h))));
  }

  if (i < last) {
    const next = zones[i + 1];
    const h = halfOf(z, next);
    const from = trailing && i === last - 1 ? z.r1 - 2 * h : z.r1 - h;
    if (d > from) return mix(z.level, next.level, smooth(clamp01((d - from) / (2 * h))));
  }

  return z.level;
}

/* -------------------------------------------- */

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTING_WIDTH, {
    name: "Brightness transition width",
    hint:
      "How far one step of brightness fades into the next, in grid squares — the same distance " +
      "everywhere it happens: the edge of a lit room, the rim of a darkness, a light's zones, and " +
      "a window's spill. 0 makes every brightness boundary a hard edge.",
    scope: "world",
    // Edited in the Configure visuals window (§10.6) with the rest of the appearance numbers.
    // Registered here, where every producer reads it.
    config: false,
    type: Number,
    range: { min: 0, max: 4, step: 0.05 },
    default: 0.75,
    onChange: () => refresh(),
  });
}

/**
 * Everything behind {@link width}, separated.
 *
 * @remarks
 * The product alone is not diagnosable, which cost a round on 2026-08-27. `transitionPixels: 20` is
 * equally consistent with a stored 0.1 on a 200px grid and a stored 0.75 on a 27px one, needing
 * opposite responses. It also happened to equal the retired `groundSoftness`, making an unchanged
 * setting look like a working one.
 */
export function status() {
  let stored = null;
  let registered = false;
  try {
    stored = game.settings.get(MODULE_ID, SETTING_WIDTH);
    registered = true;
  } catch {
    /* not registered yet */
  }
  const grid = canvas?.grid?.size ?? null;
  return {
    registered,
    // What is stored, in grid squares. `null` with `registered: false` means the setting never
    // reached `game.settings` and `width()` is running on its fallback.
    squares: stored,
    default: 0.75,
    grid,
    scenePixels: Math.round(width()),
    // On screen right now — the number that decides whether it is visible. At a zoomed-out stage
    // scale it can be a fraction of the scene value.
    screenPixels: Math.round(width() * (canvas?.stage?.scale?.x ?? 1)),
  };
}

/**
 * How to push a changed width onto what is already drawn.
 *
 * Injected rather than imported, the same seam `soften.setGroundRefresh` uses: every producer reads
 * this module, so importing one back would make peers depend on each other for a settings callback.
 */
export function setRefresh(fn) {
  refresh = typeof fn === "function" ? fn : () => {};
}

let refresh = () => {};
