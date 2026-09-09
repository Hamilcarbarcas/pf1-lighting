/**
 * `evaluate(point)` — the model's single point query. DESIGN.md §1 and §4.
 *
 * Thin by design: the registry resolves what is there, the contest resolves what wins. This file
 * stitches them together and names the answer.
 *
 * Not implemented yet (§8.2 steps 4-5): low-light vision's radius half (§4.4, still PF1's), umbra
 * (§4.3), darkvision (§4.5), observer filtering (§5). `evaluate` answers the god's-eye question
 * only — per §5.4 the mode with no observer terms, so the right half to have working first.
 *
 * §4.4c is the one exception and is not an observer term: it is scoped to the *client*, decided
 * once by PF1's own selection rather than per creature, and applies to the ambient uniformly with
 * no per-point or per-path component. It belongs here rather than in `vision/perception.mjs`
 * because the picture carries it — and §4.3's readout lesson is that a tier the screen shows and
 * the model denies is reported as a rules bug.
 */

import { ambientTier, emittersAt, lowLightActive, suppressorsAt } from "./registry.mjs";
import { contest } from "./contest.mjs";
import { TIER, TIER_NAME, resolveTier, tierCeiling, tierOf } from "./tiers.mjs";

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
 * @property {object|null} winner - The strongest suppressor present, if any
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

  // The contest wants brightness alongside the rules fields; the registry keeps them apart, an
  // entry being a source and `B` what it contributes here.
  //
  // Spread rather than naming fields. An earlier version copied `kind`, `level` and `source` by
  // hand, so when `cancelsDarkness` arrived the contest never saw it and daylight did nothing.
  // Every config field a suppressor might test has to survive this boundary, and an explicit list
  // is an invitation to forget one.
  //
  // `...rest` must carry the resolved zone (`zone`, `tier`, `steps`, `cap`) as well as `B`:
  // `contest.stack` sums bands and maxes set levels, so a bare brightness arriving here would be
  // treated as absolute (§3.2.1).
  const emitters = reaching.map(({ entry, ...rest }) => ({ ...entry, entry, ...rest }));

  const { B, baseline, winner, applied, negated } = contest(emitters, suppressors);

  // Thresholding cannot separate Dark from Supernatural Dark — both are B = 0 — so the
  // distinction comes from why it is 0 and how low the suppressor may reach. `floor` defaults to
  // Dark; only a source explicitly configured for it goes lower. DESIGN.md §3.1.
  //
  // Gated on `applied`, not `winner`: ground already unlit before any darkness arrived is
  // ordinary Dark, not supernatural.
  const resolved = resolveTier(B, { suppressed: applied, floor: winner?.floor });

  // §4.4c — ambient dim light reads as normal light for a low-light observer. Four conditions, and
  // each rules out a different way of getting to Dim that this must not touch:
  //
  //   `!applied`     a *darkness* produced this. The spell acts on the environment and the eye
  //                  reads what it leaves, so a darkness over a moonlit night is Dark and stays it.
  //   `=== DIM`      nothing else to lift.
  //   `lowLightActive()`  ahead of `ambientTier`, which is a live read plus an area fold. False on
  //                  nearly every client, so this is the test that keeps the rest off the hot path.
  //   ambient is Dim the Dim is the ground showing through rather than a light's outer band. A band
  //                  raises by rungs (§3.2.1), so a torch over Dim ambient already resolves to
  //                  Normal and never reaches here — the double count `lowLightAmbient` names.
  //
  // Falling out of that: a torch on a moonlit night lights nothing extra for an elf, its ring and
  // the night around it both reading Normal. Which is the rule.
  const lifted =
    !applied && resolved === TIER.DIM && lowLightActive() && ambientTier(point) === TIER.DIM;
  const tier = lifted ? TIER.NORMAL : resolved;

  return {
    // `baseline` follows because `lifted` implies `!applied`, which is exactly when the two are the
    // same number. Letting it lag would report a point as brighter than its own unsuppressed self.
    B: lifted ? tierCeiling(TIER.NORMAL) : B,
    tier,
    tierName: TIER_NAME[tier],
    baseline: lifted ? tierCeiling(TIER.NORMAL) : baseline,
    baselineTier: lifted ? TIER.NORMAL : tierOf(baseline),
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
  return emittersAt(point).map(({ entry, ...rest }) => ({ ...entry, entry, ...rest }));
}

/**
 * Suppressors covering a point. Retained as a console/debug entry point.
 *
 * @param {{x: number, y: number, elevation?: number}} point
 */
export function gatherSuppressors(point) {
  return suppressorsAt(point);
}
