/**
 * `evaluate(point)` — the model's single point query. DESIGN.md §1 and §4.
 *
 * Thin by design: the registry resolves *what is there* and the contest resolves *what
 * wins*. This file only stitches them together and names the answer.
 *
 * Not implemented yet (§8.2 steps 4-5): low-light vision (§4.4), umbra (§4.3),
 * darkvision (§4.5), and observer filtering (§5). `evaluate` currently answers the
 * god's-eye question only — which per §5.4 is the mode with no observer terms in it, so
 * it is the right half to have working first.
 */

import { emittersAt, suppressorsAt } from "./registry.mjs";
import { contest } from "./contest.mjs";
import { TIER, TIER_NAME, tierOf } from "./tiers.mjs";

export { ELIGIBILITY_PRESETS, contest } from "./contest.mjs";

/**
 * @typedef {object} Evaluation
 * @property {number} B - Brightness, 0..1
 * @property {number} tier - A {@link TIER} value
 * @property {string} tierName
 * @property {number} baseline - `B` as it would have been with no suppressor
 * @property {number} baselineTier - The tier that `baseline` falls in
 * @property {object[]} emitters - Those reaching the point, with their contributions
 * @property {object[]} suppressors - Those covering the point
 * @property {object|null} winner - The strongest suppressor **present**, if any
 * @property {boolean} applied - Whether that suppressor changed the outcome. A darkness
 *   over a daylight is present but ineligible, so `winner` is set and `applied` false.
 * @property {object[]} negated - Suppressors struck out by a *daylight*-style canceller
 */

/**
 * Light level at a point.
 *
 * @param {{x: number, y: number, elevation?: number}} point - Scene pixel coordinates
 * @returns {Evaluation}
 */
export function evaluate(point) {
  const reaching = emittersAt(point);
  const suppressors = suppressorsAt(point);

  // The contest wants brightness alongside the rules fields, and the registry keeps them
  // apart — an entry is a source, `B` is what it happens to contribute here.
  //
  // Spread rather than naming fields. An earlier version copied `kind`, `level` and
  // `source` by hand, so when `cancelsDarkness` was added the contest silently never saw
  // it and *daylight* did nothing. Every config field a suppressor might test has to
  // survive this boundary, and listing them is a standing invitation to forget one.
  const emitters = reaching.map(({ entry, B }) => ({ ...entry, entry, B }));

  const { B, baseline, winner, applied, negated } = contest(emitters, suppressors);

  // Thresholding cannot distinguish Dark from Supernatural Dark — both are B = 0 — so
  // the distinction comes from *why* it is 0, and how low this suppressor is allowed to
  // reach. Most cannot reach Supernatural Dark at all; `floor` defaults to Dark and only
  // a source explicitly configured for it goes lower. DESIGN.md §3.1.
  //
  // Gated on `applied`, not on `winner`: ground already unlit before any darkness
  // arrived is ordinary Dark, not supernatural.
  const snuffed = applied && B <= 0;
  const tier = snuffed ? (winner?.floor ?? TIER.DARK) : tierOf(B);

  return {
    B,
    tier,
    tierName: TIER_NAME[tier],
    baseline,
    baselineTier: tierOf(baseline),
    emitters,
    suppressors,
    winner,
    applied,
    negated,
  };
}

/**
 * Emitters reaching a point. Retained as a console/debug entry point.
 *
 * @param {{x: number, y: number, elevation?: number}} point
 */
export function gatherEmitters(point) {
  return emittersAt(point).map(({ entry, B }) => ({ ...entry, entry, B }));
}

/**
 * Suppressors covering a point. Retained as a console/debug entry point.
 *
 * @param {{x: number, y: number, elevation?: number}} point
 */
export function gatherSuppressors(point) {
  return suppressorsAt(point);
}
