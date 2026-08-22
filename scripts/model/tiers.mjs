/**
 * Brightness tiers. See DESIGN.md §3.1.
 *
 * `B` ∈ [0,1] is the primary quantity; tiers are a thresholding of it.
 */

/** Ordered tiers, ascending brightness. */
export const TIER = Object.freeze({
  SUPERNATURAL_DARK: 0,
  DARK: 1,
  DIM: 2,
  NORMAL: 3,
  BRIGHT: 4,
});

export const TIER_NAME = Object.freeze({
  [TIER.SUPERNATURAL_DARK]: "Supernatural Dark",
  [TIER.DARK]: "Dark",
  [TIER.DIM]: "Dim",
  [TIER.NORMAL]: "Normal",
  [TIER.BRIGHT]: "Bright",
});

/**
 * Upper bound of each tier's `B` band. Supernatural Dark is pinned at 0 and is not
 * reachable by thresholding — it is only produced by a suppressor.
 *
 * DESIGN.md §3.1 — these become settings later.
 */
export const THRESHOLD = Object.freeze({
  bright: 0.9, // B >  0.9              → Bright
  normal: 0.5, // B >  0.5, <= 0.9      → Normal
  dim: 0.1, // B >  0.1, <= 0.5      → Dim
  //          B <= 0.1              → Dark
});

/**
 * Threshold a brightness value into a tier.
 *
 * @param {number} B - Brightness, 0..1
 * @returns {number} A {@link TIER} value. Never returns SUPERNATURAL_DARK.
 */
export function tierOf(B) {
  if (B > THRESHOLD.bright) return TIER.BRIGHT;
  if (B > THRESHOLD.normal) return TIER.NORMAL;
  if (B > THRESHOLD.dim) return TIER.DIM;
  return TIER.DARK;
}

/**
 * The `B` value at the top of a tier's band. Used when a suppressor demotes a tier —
 * "reduce one step" lands you at the brightest end of the tier below.
 *
 * @param {number} tier - A {@link TIER} value
 * @returns {number} Brightness, 0..1
 */
export function tierCeiling(tier) {
  switch (tier) {
    case TIER.BRIGHT:
      return 1.0;
    case TIER.NORMAL:
      return THRESHOLD.bright;
    case TIER.DIM:
      return THRESHOLD.normal;
    case TIER.DARK:
      return THRESHOLD.dim;
    default:
      return 0;
  }
}

/**
 * Step a brightness value down by whole tiers.
 *
 * @remarks
 * Reduction is defined on tiers, not on B, so this quantises. A point at B=0.87
 * (Normal) reduced one step lands at exactly B=0.5 (top of Dim) rather than
 * retaining its position within the band. See DESIGN.md Appendix B for the open
 * question about whether that is the behaviour we want.
 *
 * @param {number} B - Brightness, 0..1
 * @param {number} steps - Whole tiers to descend
 * @param {number} [floor=TIER.SUPERNATURAL_DARK] - Lowest tier this may reach. Suppressors
 *   default to `TIER.DARK`: not everything that darkens an area is capable of
 *   *supernatural* darkness, so plain *darkness* bottoms out at Dark and only a source
 *   explicitly configured for it can go lower.
 * @returns {number} Reduced brightness
 */
export function reduceTiers(B, steps, floor = TIER.SUPERNATURAL_DARK) {
  const target = Math.max(floor, tierOf(B) - Math.max(0, steps));
  return tierCeiling(target);
}

/**
 * Clamp a brightness value to at most the given tier.
 *
 * @param {number} B - Brightness, 0..1
 * @param {number} maxTier - A {@link TIER} value
 * @returns {number} Clamped brightness
 */
export function clampToTier(B, maxTier) {
  const ceiling = tierCeiling(maxTier);
  return Math.min(B, ceiling);
}
