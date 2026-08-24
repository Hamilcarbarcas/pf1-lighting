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

/** Brightest and darkest tiers reachable by ordinary arithmetic. Bounds for {@link stepTier}. */
const TIER_MIN = TIER.DARK;
const TIER_MAX = TIER.BRIGHT;

/**
 * Move a tier up or down whole rungs, bounded.
 *
 * @remarks
 * The primitive §3.2.1's band stacking is defined on. Bounded at Dark rather than at
 * Supernatural Dark for the same reason {@link tierOf} never returns it: Supernatural Dark is
 * not a point anyone can *arrive* at by adding or removing light, only somewhere a suppressor
 * with the right `floor` can put you.
 *
 * @param {number} tier - A {@link TIER} value
 * @param {number} steps - Rungs to move; may be negative
 * @returns {number} A {@link TIER} value in `[TIER.DARK, TIER.BRIGHT]`
 */
export function stepTier(tier, steps) {
  return Math.min(TIER_MAX, Math.max(TIER_MIN, tier + Math.trunc(steps || 0)));
}

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
 * Threshold a brightness into a tier, honouring a suppressor's floor.
 *
 * @remarks
 * **The only correct way to get a tier out of a suppressed brightness**, and the reason it
 * is a shared function rather than three lines at each call site: `tierOf` cannot express
 * Supernatural Dark, because thresholding cannot distinguish it from Dark — both are `B = 0`.
 * The distinction comes from *why* it is zero and how far the suppressor is licensed to
 * reach, so it can only be applied where the suppressor is known.
 *
 * Written after `field()` and `evaluate()` disagreed about it (found 2026-08-22): `evaluate`
 * had the floor logic, `field` called plain `tierOf`, and so every `dark` cell reported Dark
 * however supernatural its source. That silently disabled both the renderer's black fill
 * (`darkeningStrength` fires only at Supernatural Dark) and the umbra's top rank.
 *
 * @param {number} B - Brightness after the suppressor's transform
 * @param {object} [options]
 * @param {boolean} [options.suppressed=true] - Did a suppressor actually change the outcome?
 *   Ground that was already unlit is ordinary Dark, not supernatural.
 * @param {number} [options.floor=TIER.DARK] - The winning suppressor's floor
 * @returns {number} A {@link TIER} value
 */
export function resolveTier(B, { suppressed = true, floor = TIER.DARK } = {}) {
  if (suppressed && B <= 0) return floor;
  return tierOf(B);
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

/* -------------------------------------------- */
/*  Tier ↔ darkness level (§7.0, the texture)   */
/* -------------------------------------------- */

/**
 * Tier → **darkness level**, the `[0,1]` scalar the darkness-level texture carries.
 *
 * @remarks
 * **In `model/`, not `render/`, since 2026-08-23**, and the move is the point rather than
 * tidying. §3.2.1's band stacking is additive on rungs, so the *ambient* rung is the base of
 * every sum in the model — and it used to come from `tierOf(1 - darknessLevel)`, a completely
 * separate quantisation from the one the renderer paints with. Two ladders under one sum is a
 * bug waiting for the first scene whose darkness sits near a boundary. There is one ladder
 * now, and `render/levels.mjs` re-exports it so nothing else moved.
 *
 * A different axis from a *lighting level* (`render/levels.levelForTier`) and not a
 * rearrangement of it. A lighting level says how a light source paints relative to the ambient;
 * a darkness level **is** the ambient, per fragment:
 *
 * ```glsl
 * computedDarknessLevel = texture2D(darknessLevelTexture, vSamplerUvs).r;
 * computedBackgroundColor = mix(ambientDaylight, ambientDarkness, computedDarknessLevel);
 * ```
 *
 * Every lighting *and* vision shader samples it, which is the property that made §7.0's
 * stand-in light fills obsolete: a region written here keeps its brightness **through** a
 * vision source's paint, so god's eye, *true seeing* and darkvision all still read the map's
 * light levels.
 *
 * ## Why these numbers
 *
 * Two fixed points, then even spacing between them. **Dark is 1.0** — Dark means no light, and
 * `ambientDarkness` is what no light looks like. **Supernatural Dark shares it**, because the
 * darkness source's own overlay already tells the two apart and is the better distinction.
 * That leaves Bright at 0 — full daylight is our Bright tier — with Normal and Dim dividing
 * the middle evenly.
 *
 * @type {Record<number, number>}
 */
export const TIER_TO_DARKNESS = Object.freeze({
  [TIER.BRIGHT]: 0,
  [TIER.NORMAL]: 1 / 3,
  [TIER.DIM]: 2 / 3,
  // **Dark and Supernatural Dark share a level, deliberately** (Patrick, 2026-08-23). Dark
  // means no light, and `ambientDarkness` is what no light looks like — there is nothing below
  // it to reserve. Supernatural Dark is told apart by the darkness source's own overlay.
  [TIER.DARK]: 1,
  [TIER.SUPERNATURAL_DARK]: 1,
});

/**
 * Named alternatives, so the choice can be made by looking at a scene rather than by argument.
 *
 * - **`matched`** is {@link TIER_TO_DARKNESS}, the default.
 * - **`even`** gives Supernatural Dark a level of its own, at the cost of Dark no longer
 *   meaning "no light". What the §7.0 spike measured, literally.
 * - **`bands`** is `1 - tierCeiling(tier)`, so ambient never lifts past its own `B` band and a
 *   dark scene stays dark. Its cost is that Bright/Normal and Dark/Supernatural sit 0.1 apart.
 */
export const DARKNESS_PRESETS = Object.freeze({
  matched: TIER_TO_DARKNESS,
  even: Object.freeze({
    [TIER.BRIGHT]: 0,
    [TIER.NORMAL]: 0.25,
    [TIER.DIM]: 0.5,
    [TIER.DARK]: 0.75,
    [TIER.SUPERNATURAL_DARK]: 1,
  }),
  bands: Object.freeze({
    [TIER.BRIGHT]: 0,
    [TIER.NORMAL]: 1 - THRESHOLD.bright,
    [TIER.DIM]: 1 - THRESHOLD.normal,
    [TIER.DARK]: 1 - THRESHOLD.dim,
    [TIER.SUPERNATURAL_DARK]: 1,
  }),
});

/** @type {Record<number, number>} */
let table = TIER_TO_DARKNESS;

/** The table in force. */
export const darknessTable = () => table;

/**
 * Swap the tier → darkness-level table at runtime, for tuning against a live scene.
 *
 * @param {Record<number, number>|string|null} next - A preset name, an explicit table keyed by
 *   {@link TIER}, or `null` to restore the default
 * @returns {Record<number, number>} The table now in force
 */
export function setDarknessTable(next) {
  table = (typeof next === "string" ? DARKNESS_PRESETS[next] : next) ?? TIER_TO_DARKNESS;
  return table;
}

/** Tiers the ambient can actually be, brightest first. Supernatural Dark is not among them. */
const AMBIENT_TIERS = [TIER.BRIGHT, TIER.NORMAL, TIER.DIM, TIER.DARK];

/**
 * A scene darkness level → the ambient tier, **through the same table the renderer paints**.
 *
 * @remarks
 * The inverse of {@link TIER_TO_DARKNESS}, and the base of every additive sum in §3.2.1. It
 * replaces `tierOf(1 - darknessLevel)`, which quantised the identical quantity on the
 * *threshold* ladder instead — a second answer to the same question, and the one the picture
 * did not use.
 *
 * **Nearest rung, ties to the darker.** With the default table a scene at `darkness = 0.5`
 * sits exactly between Normal (⅓) and Dim (⅔), and resolving the tie downward keeps the
 * behaviour the threshold ladder had. It also makes the darkness slider step visibly between
 * tiers rather than sliding through them, which is the honest presentation of a quantised
 * model.
 *
 * @param {number} darkness - 0..1
 * @returns {number} A {@link TIER} value in `[TIER.DARK, TIER.BRIGHT]`
 */
export function tierFromDarkness(darkness) {
  const d = Math.min(1, Math.max(0, darkness ?? 0));
  let best = TIER.DARK;
  let bestGap = Infinity;
  // Darkest first, and `<` rather than `<=`, so an exact tie keeps the darker rung.
  for (let i = AMBIENT_TIERS.length - 1; i >= 0; i--) {
    const tier = AMBIENT_TIERS[i];
    const gap = Math.abs((table[tier] ?? 1) - d);
    if (gap < bestGap) {
      bestGap = gap;
      best = tier;
    }
  }
  return best;
}
