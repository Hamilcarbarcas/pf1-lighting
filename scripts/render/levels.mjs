/**
 * Tier → Foundry lighting level. DESIGN.md §6.2.3.
 *
 * `CONST.LIGHTING_LEVELS` has six values and the model has five tiers, so the mapping is
 * exact with one to spare. Notably `BRIGHTEST` is a fully rendered level that **nothing
 * in core produces** — it draws from `canvas.colors.ambientBrightest`, itself set from
 * `CONFIG.Canvas.brightestColor` (`environment.mjs:156`, `rendered-effect-source.mjs:587`).
 *
 * That is what §3.2.1's added Bright tier renders as. No custom shader, no invented
 * path: Foundry already had a level for it and no use of its own.
 */

import { TIER } from "../model/tiers.mjs";

/** @type {Record<number, number>} */
export const TIER_TO_LEVEL = Object.freeze({
  [TIER.BRIGHT]: 3, // LIGHTING_LEVELS.BRIGHTEST — ours; core never emits it
  [TIER.NORMAL]: 2, // BRIGHT — Foundry's "bright" is our Normal (§3.2.1)
  [TIER.DIM]: 1, // DIM
  [TIER.DARK]: 0, // UNLIT
  [TIER.SUPERNATURAL_DARK]: -2, // DARKNESS — the violet
  // HALFDARK (-1) is unused, as it is by core (§3.3.1).
});

/**
 * Every `dark` cell is drawn by a **darkness** source, whatever its tier.
 *
 * @remarks
 * This was nearly got wrong twice. A `dark` cell's tier is ambient reduced one step, so
 * it is always ≤ ambient — and the first build rendered it with a *light* source, which
 * can only add, turning a *darkness* cast at noon into a glow. The second reading was
 * that it therefore could not be drawn at all until §7.1 gave us global illumination.
 *
 * Both were wrong for the same reason: a darkness source **subtracts**, and once its
 * lighting level can be set per source (see `clip.setLevel`) it subtracts *down to that
 * tier* rather than to black. Bright ambient with a *darkness* over it becomes Normal,
 * which is exactly the rule.
 *
 * `TIER.DARK` still draws — as `UNLIT`, which on an already-unlit scene is a no-op and
 * on a lit one is the full reduction the spell is entitled to.
 */

