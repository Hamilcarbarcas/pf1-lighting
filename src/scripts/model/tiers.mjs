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

/**
 * English, and deliberately not translated: this is the developer surface. Every
 * `game.pf1Lighting` readout prints it, and `api.tierName()` hands it to other modules as a tier's
 * name, so a consumer keying off `"Supernatural Dark"` must not break on a language change.
 * {@link tierLabel} is the one to show a user.
 */
export const TIER_NAME = Object.freeze({
  [TIER.SUPERNATURAL_DARK]: "Supernatural Dark",
  [TIER.DARK]: "Dark",
  [TIER.DIM]: "Dim",
  [TIER.NORMAL]: "Normal",
  [TIER.BRIGHT]: "Bright",
});

/** `lang/en.json` keys under `PF1LIGHTING.Tier`. Not the display strings — see {@link tierLabel}. */
const TIER_KEY = Object.freeze({
  [TIER.SUPERNATURAL_DARK]: "SupernaturalDark",
  [TIER.DARK]: "Dark",
  [TIER.DIM]: "Dim",
  [TIER.NORMAL]: "Normal",
  [TIER.BRIGHT]: "Bright",
});

/**
 * A tier's name as a user should read it.
 *
 * @remarks
 * Render time only: `game.i18n` has no translations loaded during `init` (see `i18n.mjs`), so a
 * module-level `const` built from this would freeze the keys instead of the names. Every caller is
 * inside `_renderHTML`, a hook, or a notification, all late enough.
 *
 * Falls back to {@link TIER_NAME} for an unrecognised tier rather than returning a raw key — the
 * one caller that can be handed one is the readout, mid-drag.
 */
export const tierLabel = (tier) =>
  TIER_KEY[tier] ? game.i18n.localize(`PF1LIGHTING.Tier.${TIER_KEY[tier]}`) : (TIER_NAME[tier] ?? "");

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
 * The primitive §3.2.1's band stacking is defined on. Bounded at Dark rather than Supernatural Dark
 * for the reason {@link tierOf} never returns it: Supernatural Dark is not somewhere adding or
 * removing light can arrive at, only somewhere a suppressor with the right `floor` puts a creature.
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
 * The only correct way to get a tier out of a suppressed brightness, and why it is a shared function
 * rather than three lines per call site: `tierOf` cannot express Supernatural Dark, thresholding
 * being unable to tell it from Dark — both are `B = 0`. The distinction comes from why it is zero
 * and how far the suppressor is licensed to reach, so it applies only where the suppressor is known.
 *
 * Written after `field()` and `evaluate()` disagreed about it (2026-08-22): `evaluate` had the floor
 * logic, `field` called plain `tierOf`, so every `dark` cell reported Dark however supernatural its
 * source. That silently disabled both the renderer's black fill (`darkeningStrength` fires only at
 * Supernatural Dark) and the umbra's top rank.
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
 * "reduce one step" lands at the brightest end of the tier below.
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
 * Reduction is defined on tiers rather than on B, so this quantises: a point at B=0.87 (Normal)
 * reduced one step lands at exactly B=0.5, the top of Dim, rather than keeping its position within
 * the band. DESIGN.md Appendix B holds the open question about whether that is the right behaviour.
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
 * Tier → darkness level, the `[0,1]` scalar the darkness-level texture carries.
 *
 * @remarks
 * In `model/` rather than `render/` since 2026-08-23, and the move is the point rather than tidying.
 * §3.2.1's band stacking is additive on rungs, so the ambient rung is the base of every sum in the
 * model — and it used to come from `tierOf(1 - darknessLevel)`, a separate quantisation from the one
 * the renderer paints with. Two ladders under one sum is a bug waiting for the first scene whose
 * darkness sits near a boundary. There is one ladder now, and `render/levels.mjs` re-exports it so
 * nothing else moved.
 *
 * A different axis from a lighting level (`render/levels.levelForTier`), not a rearrangement of it.
 * A lighting level says how a light source paints relative to the ambient; a darkness level is the
 * ambient, per fragment:
 *
 * ```glsl
 * computedDarknessLevel = texture2D(darknessLevelTexture, vSamplerUvs).r;
 * computedBackgroundColor = mix(ambientDaylight, ambientDarkness, computedDarknessLevel);
 * ```
 *
 * Every lighting and vision shader samples it, the property that made §7.0's stand-in light fills
 * obsolete: a region written here keeps its brightness through a vision source's paint, so god's
 * eye, true seeing and darkvision all still read the map's light levels.
 *
 * The numbers are two fixed points with even spacing between. Dark is 1.0, Dark meaning no light
 * and `ambientDarkness` being what no light looks like; Supernatural Dark shares it, the darkness
 * source's own overlay already telling the two apart and being the better distinction. That leaves
 * Bright at 0 — full daylight is the Bright tier — with Normal and Dim dividing the middle evenly.
 *
 * @type {Record<number, number>}
 */
export const TIER_TO_DARKNESS = Object.freeze({
  [TIER.BRIGHT]: 0,
  [TIER.NORMAL]: 1 / 3,
  [TIER.DIM]: 2 / 3,
  // Dark and Supernatural Dark share a level, deliberately (2026-08-23). Dark means no light and
  // `ambientDarkness` is what no light looks like, so there is nothing below it to reserve.
  // Supernatural Dark is told apart by the darkness source's own overlay.
  [TIER.DARK]: 1,
  [TIER.SUPERNATURAL_DARK]: 1,
});

/**
 * Named alternatives, so the choice can be made by looking at a scene rather than by argument.
 *
 * - `matched` is {@link TIER_TO_DARKNESS}, the default.
 * - `even` gives Supernatural Dark a level of its own, at the cost of Dark no longer meaning no
 *   light. Literally what the §7.0 spike measured.
 * - `bands` is `1 - tierCeiling(tier)`, so ambient never lifts past its own `B` band and a dark
 *   scene stays dark. Its cost is Bright/Normal and Dark/Supernatural sitting 0.1 apart.
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
 * The inverse of {@link TIER_TO_DARKNESS} and the base of every additive sum in §3.2.1. It replaces
 * `tierOf(1 - darknessLevel)`, which quantised the identical quantity on the threshold ladder — a
 * second answer to the same question, and the one the picture did not use.
 *
 * Nearest rung, ties to the darker. With the default table a scene at `darkness = 0.5` sits exactly
 * between Normal (⅓) and Dim (⅔), and resolving downward keeps the threshold ladder's behaviour. It
 * also makes the darkness slider step visibly between tiers rather than sliding through them, the
 * honest presentation of a quantised model.
 *
 * The tie is decided with a tolerance rather than on exact equality (2026-08-28). A midpoint
 * computed as `(a + b) / 2` is not reliably equidistant in binary: `(2/3 + 1) / 2` sits one ulp
 * nearer ⅔ than 1, so the Dim/Dark boundary resolved to Dim while the Normal/Dim boundary at 0.5
 * resolved to Dim as intended — the rule held or broke depending on which rungs it fell between.
 * Found by {@link darknessBand} failing to round-trip its own lower edge. Anything the tolerance
 * changes was decided by float noise before it.
 *
 * @param {number} darkness - 0..1
 * @returns {number} A {@link TIER} value in `[TIER.DARK, TIER.BRIGHT]`
 */
export function tierFromDarkness(darkness) {
  const d = Math.min(1, Math.max(0, darkness ?? 0));
  let best = TIER.DARK;
  let bestGap = Infinity;
  // Darkest first, and a rung must be *meaningfully* nearer to displace the darker one.
  for (let i = AMBIENT_TIERS.length - 1; i >= 0; i--) {
    const tier = AMBIENT_TIERS[i];
    const gap = Math.abs((table[tier] ?? 1) - d);
    if (gap < bestGap - TIE) {
      bestGap = gap;
      best = tier;
    }
  }
  return best;
}

/** How near two rungs' distances must be to count as a tie. Far below any real rung spacing. */
const TIE = 1e-9;

/**
 * How far below a band's open upper edge to land.
 *
 * @remarks
 * {@link darknessBand} returns `[from, to)` but `Number#between` is inclusive at both ends
 * (`primitives/number.mjs:83`, and `light.mjs:159` calls it with no third argument), so the dark end
 * is closed by hand. It matters at exactly one value per boundary, and that value is reachable: the
 * Normal/Dim edge under the default table is 0.5, where a hand-dragged darkness slider likes to sit.
 */
const EDGE = 1e-6;

/**
 * A tier range → the `darkness.min`/`max` pair Foundry gates a light source on.
 *
 * @remarks
 * Here rather than in `ui/light-config.mjs`, where it began: the preset editor needs the same
 * arithmetic to store an activation range (§10.2.1), and two copies of a rounding rule is how the
 * sheet and the preset table come to disagree about which tier a light switches on at.
 *
 * The full ladder is `{min: 0, max: 1}` — Foundry's own defaults, always on — because
 * `darknessBand` opens the brightest tier at 0 and closes the darkest at 1. That is what lets a
 * preset express always by simply not carrying a range.
 *
 * @param {number} brightest - The brightest ambient this light is on at
 * @param {number} darkest - The darkest ambient this light is on at
 * @returns {{min: number, max: number}}
 */
export function activationRange(brightest, darkest) {
  const bright = darknessBand(brightest);
  const dark = darknessBand(darkest);
  return {
    // Closed at the bright end already — a midpoint belongs to the darker tier, which is where
    // this starts from.
    min: bright.from,
    max: dark.to >= 1 ? 1 : dark.to - EDGE,
  };
}

/**
 * The span of darkness levels that {@link tierFromDarkness} answers `tier` for.
 *
 * @remarks
 * The inverse of `tierFromDarkness` as a range rather than a point, which is what anything comparing
 * a raw darkness number against a tier needs. `darknessTable()[tier]` is the level a tier paints at,
 * not the set of levels that read as that tier, and a control built on the point rather than the
 * band is wrong for every scene whose darkness was not set through §10.5's dropdown. See §10.4.1 —
 * Foundry's own activation test is `canvas.darknessLevel.between(min, max)` on the raw number.
 *
 * Nearest rung means the edges are the midpoints to the neighbouring rungs, and ties-to-the-darker
 * means the band is `[from, to)`: closed at the bright end, open at the dark end. A caller feeding
 * an inclusive comparison has to close `to` itself.
 *
 * Neighbours are found by sorting on level rather than by position in {@link AMBIENT_TIERS}, the
 * table being four editable settings with nothing stopping a GM making Dim brighter than Normal. A
 * non-monotone table gives degenerate bands here rather than crossed ones; the tie rule in
 * `tierFromDarkness` is the one place the two can still disagree, and only for a table that has
 * already made a tier unreachable.
 *
 * @param {number} tier - A {@link TIER} value the ambient can hold
 * @returns {{from: number, to: number}} Darkness levels, `from` inclusive and `to` exclusive
 */
export function darknessBand(tier) {
  const level = (t) => table[t] ?? 1;
  const ordered = [...AMBIENT_TIERS].sort((a, b) => level(a) - level(b));
  const i = ordered.indexOf(tier);
  if (i < 0) return { from: 0, to: 1 };
  const here = level(tier);
  return {
    from: i === 0 ? 0 : (level(ordered[i - 1]) + here) / 2,
    to: i === ordered.length - 1 ? 1 : (here + level(ordered[i + 1])) / 2,
  };
}
