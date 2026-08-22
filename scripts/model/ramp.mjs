/**
 * The per-source brightness ramp. See DESIGN.md §3.2.1.
 *
 * Three zones, each a gradient band:
 *
 *   bright  1.0 → 0.9
 *   normal  0.9 → 0.5
 *   dim     0.5 → 0.1
 *   beyond  0
 *
 * Foundry's two native radii already are our Normal and Dim — `data.bright` is the
 * Normal radius and `data.dim` is the Dim radius. The Bright radius is ours, stored
 * in flags, and defaults to 0.
 */

import { MODULE_ID } from "../constants.mjs";
import { TIER } from "./tiers.mjs";

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Radii for one emitter, all in **pixels**.
 *
 * @typedef {object} Radii
 * @property {number} bright - Innermost. 0 when the light has no Bright zone (the norm).
 * @property {number} normal - Foundry's native `bright`.
 * @property {number} dim    - Foundry's native `dim`.
 */

/**
 * Brightness contributed by a single emitter at a given distance.
 *
 * @param {number} distance - Distance from the emitter origin, in pixels
 * @param {Radii} radii - Zone radii, in pixels
 * @returns {number} Brightness, 0..1
 */
export function brightnessAt(distance, radii) {
  const rB = radii.bright ?? 0;
  const rN = radii.normal ?? 0;
  const rD = radii.dim ?? 0;

  // Past the dim radius contributes nothing. Anywhere outside every light is Dark,
  // which is the correct mechanical answer; the visual taper past rD is the
  // renderer's business, not the model's.
  if (distance > rD || rD <= 0) return 0;

  // Bright zone, when the light has one.
  if (rB > 0 && distance <= rB) return lerp(1.0, 0.9, distance / rB);

  // Normal zone. With no Bright zone the centre reads 0.9, not 1.0 — DESIGN.md §3.2.1.
  const normalStart = rB > 0 ? rB : 0;
  if (distance <= rN && rN > normalStart) {
    return lerp(0.9, 0.5, (distance - normalStart) / (rN - normalStart));
  }

  // Dim zone.
  const dimStart = Math.max(rN, normalStart);
  if (rD > dimStart) {
    return lerp(0.5, 0.1, (distance - dimStart) / (rD - dimStart));
  }

  // Degenerate: dim radius collapsed onto the zone below it.
  return 0.1;
}

/**
 * Read an emitter's three radii off a live light source.
 *
 * `data.bright` / `data.dim` are already in pixels by the time they reach the source
 * (PF1's low-light mixin has also already scaled them, if active). Our Bright radius
 * is authored in scene distance units and converted here.
 *
 * @param {object} source - A PointLightSource
 * @returns {Radii} Radii in pixels
 */
export function radiiOf(source) {
  const doc = source.object?.document;
  const brightUnits = doc?.getFlag?.(MODULE_ID, "brightRadius") ?? 0;
  const perUnit = canvas.dimensions?.distancePixels ?? 1;

  return {
    bright: brightUnits * perUnit,
    normal: source.data?.bright ?? 0,
    dim: source.data?.dim ?? 0,
  };
}

/* -------------------------------------------- */
/*  Transforms expressed as radii                */
/* -------------------------------------------- */

/**
 * Reduce an emitter's output by whole tiers, **as a change of radii**.
 *
 * @remarks
 * This is the identity that lets suppressed light keep a gradient. Reducing one tier
 * shifts the zone radii inward by one zone: `(rB, rN, rD)` becomes `(0, rB, rN)`.
 *
 * Why it is exact, not an approximation. The original ramp puts Bright on `[0, rB)`,
 * Normal on `[rB, rN)` and Dim on `[rN, rD)`. Reducing one tier should leave Normal on
 * `[0, rB)`, Dim on `[rB, rN)` and Dark beyond `rN`. Feeding `(0, rB, rN)` back through
 * {@link brightnessAt} produces exactly that: with no Bright zone the ramp opens at 0.9
 * and runs to 0.5 across `[0, rB)` — Normal — then 0.5 to 0.1 across `[rB, rN)` — Dim —
 * and nothing beyond. Every tier boundary lands where the quantised model says it should.
 *
 * So `tierOf(brightnessAt(d, reduceRadii(r, n))) === tierOf(brightnessAt(d, r)) - n`
 * everywhere, while the value in between stays continuous instead of stepping.
 *
 * **This resolves the §6.2 tension for suppressed cells.** A reduced region can be drawn
 * by a source with shifted radii rather than a flat fill, so light inside a *darkness*
 * still falls off from its origin instead of becoming a uniform disc.
 *
 * @param {Radii} radii
 * @param {number} steps - Whole tiers to descend
 * @returns {Radii}
 */
export function reduceRadii(radii, steps) {
  const zones = [radii.bright ?? 0, radii.normal ?? 0, radii.dim ?? 0];
  const n = Math.max(0, Math.trunc(steps));
  const shifted = [0, 0, 0];
  for (let i = 0; i < zones.length; i++) {
    const target = i + n;
    if (target < shifted.length) shifted[target] = zones[i];
  }
  return { bright: shifted[0], normal: shifted[1], dim: shifted[2] };
}

/** Which tier each zone radius is the outer edge of. */
const ZONE_TIER = [TIER.BRIGHT, TIER.NORMAL, TIER.DIM];

/**
 * Cap an emitter at a maximum tier, as a change of radii.
 *
 * Collapsing every zone above `maxTier` to zero is equivalent to `min(B, ceiling)`:
 * with the brighter zones gone the ramp simply opens at the capped tier's top and falls
 * off from there.
 *
 * @param {Radii} radii
 * @param {number} maxTier - A {@link TIER} value
 * @returns {Radii}
 */
export function clampRadii(radii, maxTier) {
  const zones = [radii.bright ?? 0, radii.normal ?? 0, radii.dim ?? 0];
  const capped = zones.map((r, i) => (ZONE_TIER[i] > maxTier ? 0 : r));
  return { bright: capped[0], normal: capped[1], dim: capped[2] };
}

/**
 * Apply a suppressor transform to an emitter's radii.
 *
 * @param {Radii} radii
 * @param {{op: string, steps?: number, max?: number}} transform
 * @returns {Radii}
 */
export function transformRadii(radii, transform) {
  switch (transform?.op) {
    case "reduce":
      return reduceRadii(radii, transform.steps ?? 1);
    case "clamp":
      return clampRadii(radii, transform.max ?? TIER.DIM);
    default:
      return { ...radii };
  }
}
