/**
 * The precedence contest — DESIGN.md §4.1, §3.3.
 *
 * Pure rules. Nothing here touches the canvas, reads a document or knows what a point
 * is: it takes resolved emitters and suppressors and says what wins. Both consumers
 * need it — `evaluate()` for one point, `field()` for one cell — and neither should
 * have to drag the other's machinery along.
 *
 * Model B (§4.1): **highest level wins, equal levels go to the suppressor, nothing
 * composes.** A transform pipeline was rejected in Appendix A.4 because the operations
 * don't commute, so there is exactly one winning suppressor and it is applied once.
 *
 * ## A suppressor does two separate things
 *
 * Getting this wrong produced the one real model bug found in testing, so it is worth
 * stating flatly. *Darkness* both:
 *
 * 1. **removes** eligible light sources — "nonmagical sources of light, such as torches
 *    and lanterns, do not increase the light level in an area of darkness"; and
 * 2. **drops** the resulting illumination one step.
 *
 * These are not the same operation and eligible sources are not merely dimmed. An
 * earlier version folded them together — every emitter contributed to a baseline that
 * was then reduced once — so three torches inside a *darkness* came out Dim instead of
 * Dark, because the torches were never actually removed.
 *
 * Hence three categories rather than two:
 *
 * | Category | Test | Effect |
 * | --- | --- | --- |
 * | counters | not eligible, magical, level above the suppressor's | defeats it; light untouched |
 * | blocked | eligible per the preset | contributes nothing at all |
 * | passthrough | everything else, i.e. ambient | contributes, and *is* transformed |
 */

import { TIER, reduceTiers, clampToTier } from "./tiers.mjs";

/* -------------------------------------------- */
/*  Defaults                                    */
/* -------------------------------------------- */

/** An ordinary torch: mundane, no spell level. */
export const DEFAULT_EMITTER = Object.freeze({
  kind: "mundane",
  level: 0,

  /**
   * *Daylight*'s special case. A normal higher-level light **overrides** a darkness and
   * goes on shining (see `counters` below); one flagged here **annihilates** with it
   * instead — both effects vanish where they overlap, and this emitter stops
   * contributing light of its own there. Other sources in that region are unaffected
   * and unsuppressed.
   *
   * Cancels suppressors of its own level or lower.
   */
  cancelsDarkness: false,
});

/**
 * Applied to a darkness source carrying no module flags, so an unconfigured
 * `negative: true` light behaves as the *darkness* spell rather than doing nothing.
 */
export const DEFAULT_SUPPRESSOR = Object.freeze({
  kind: "magical",
  level: 2,
  transform: { op: "reduce", steps: 1 },
  eligibility: "preset:darkness",
  blocksPath: true,

  /**
   * Lowest tier this suppressor can drive an area to.
   *
   * Dark by default: not everything capable of darkening an area is capable of
   * *supernatural* darkness. Reaching Supernatural Dark is an explicit opt-in per
   * source — *deeper darkness* sets `floor: TIER.SUPERNATURAL_DARK`.
   */
  floor: TIER.DARK,
});

/* -------------------------------------------- */
/*  Eligibility                                 */
/* -------------------------------------------- */

/**
 * Which emitters a suppressor is allowed to touch. DESIGN.md §3.3 — GMs pick a preset;
 * they do not author predicates.
 */
export const ELIGIBILITY_PRESETS = {
  /**
   * *Darkness*: blocks mundane light, and magical light of its own level or lower.
   * A torch and a level-0 *light* go out; *daylight* does not.
   */
  darkness: (emitter, suppressor) =>
    emitter.kind === "mundane" ||
    (emitter.kind === "magical" && emitter.level <= suppressor.level),

  /** Blocks everything, ambient included. Not a PF1 effect; useful for testing. */
  total: () => true,

  /** Blocks nothing. Isolates the contest from eligibility when debugging. */
  none: () => false,
};

export function eligibilityFn(spec) {
  if (typeof spec === "function") return spec;
  const key = String(spec ?? "").replace(/^preset:/, "");
  return ELIGIBILITY_PRESETS[key] ?? ELIGIBILITY_PRESETS.darkness;
}

/**
 * Does this emitter strip a suppressor of its force where the two overlap?
 *
 * Covers both ways that happens — an ordinary higher-level magical light *countering*
 * it, and a *daylight* *annihilating* with it. They differ in what happens to the
 * emitter itself, not in what happens to the suppressor, so geometry that only cares
 * about the suppressor can treat them alike.
 *
 * @param {object} emitter
 * @param {object} suppressor
 * @returns {boolean}
 */
export function breaks(emitter, suppressor) {
  if (emitter.cancelsDarkness && emitter.level >= suppressor.level) return true;
  return (
    emitter.kind === "magical" &&
    emitter.level > suppressor.level &&
    !eligibilityFn(suppressor.eligibility)(emitter, suppressor)
  );
}

/* -------------------------------------------- */
/*  Transforms                                  */
/* -------------------------------------------- */

/**
 * Apply a suppressor's effect to a brightness value.
 *
 * Both operations are defined on **tiers**, not on `B`, so they quantise — see
 * `reduceTiers` and DESIGN.md Appendix B for the open question about whether a point
 * mid-band should keep its position within it.
 *
 * The floor only constrains `reduce`, since `clamp` lowers toward a named tier and
 * `tierOf` never returns Supernatural Dark on its own — only repeated reduction can
 * drive an area below Dark.
 */
export function applyTransform(B, transform, floor = TIER.DARK) {
  switch (transform?.op) {
    case "reduce":
      return reduceTiers(B, transform.steps ?? 1, floor);
    case "clamp":
      return clampToTier(B, transform.max ?? TIER.DIM);
    default:
      return B;
  }
}

/* -------------------------------------------- */
/*  Mutual annihilation (daylight)              */
/* -------------------------------------------- */

/**
 * Resolve *daylight*-style annihilation before the contest runs.
 *
 * @remarks
 * This is a pre-pass rather than a branch because it decides which effects reach the
 * contest at all. Where a `cancelsDarkness` emitter meets a suppressor of its own level
 * or lower, **both** are struck out: the suppressor stops darkening, and the emitter
 * stops lighting. Everything else in that region then resolves as if neither had ever
 * been cast.
 *
 * That is what separates it from the `counters` branch, which is the *ordinary*
 * higher-level case — there the light keeps shining and simply overrides the darkness.
 *
 * A canceller is only spent if it actually cancelled something. *Daylight* with no
 * darkness around it is just a bright light.
 *
 * @param {object[]} emitters
 * @param {object[]} suppressors
 * @returns {{emitters: object[], suppressors: object[], negated: object[]}}
 */
function annihilate(emitters, suppressors) {
  const cancellers = emitters.filter((e) => e.cancelsDarkness);
  if (!cancellers.length || !suppressors.length) {
    return { emitters, suppressors, negated: [] };
  }

  const negated = new Set();
  const spent = new Set();

  for (const canceller of cancellers) {
    const victims = suppressors.filter((s) => s.level <= canceller.level);
    if (!victims.length) continue;
    for (const victim of victims) negated.add(victim);
    spent.add(canceller);
  }

  if (!negated.size) return { emitters, suppressors, negated: [] };

  return {
    emitters: emitters.filter((e) => !spent.has(e)),
    suppressors: suppressors.filter((s) => !negated.has(s)),
    negated: [...negated],
  };
}

/* -------------------------------------------- */
/*  The contest                                 */
/* -------------------------------------------- */

/**
 * @typedef {object} ContestResult
 * @property {number} B - Resolved brightness, 0..1
 * @property {number} baseline - What `B` would have been with no suppressor present
 * @property {object|null} winner - The strongest suppressor **present**, if any
 * @property {boolean} applied - Whether that suppressor actually changed the outcome
 * @property {object[]} negated - Suppressors struck out by a *daylight*-style canceller
 *   before the contest ran. Those emitters are removed too, so a region where the two
 *   overlap resolves as if neither spell had been cast.
 */

/**
 * Resolve emitters against suppressors at one place.
 *
 * @remarks
 * `winner` and `applied` are separate on purpose. A *darkness* covering a *daylight*
 * is present and is the strongest suppressor there, but it is not eligible to touch a
 * level-3 emitter, so the daylight survives and floors the result at its own full
 * brightness — the suppressor changed nothing. Reporting only `winner` made that read
 * as "the darkness won" while `B` showed untouched light, which is exactly backwards.
 *
 * `applied` is `B < baseline`, not "the transform ran". The transform always runs; what
 * matters is whether a survivor's floor then overrode it.
 *
 * @param {{B: number, kind: string, level: number}[]} emitters - Each with the
 *   brightness it contributes *here*, already resolved by the caller
 * @param {{level: number, eligibility: any, transform: object}[]} suppressors
 * @returns {ContestResult}
 */
export function contest(allEmitters, allSuppressors) {
  const ambient = 0; // nothing reaching this place
  const brightest = (list) => list.reduce((max, e) => Math.max(max, e.B), ambient);

  if (!allEmitters.length && !allSuppressors.length) {
    return { B: ambient, baseline: ambient, winner: null, applied: false, negated: [] };
  }

  // Unordered max over emitters: light does not stack (§4.2). Measured over the
  // *original* set, including light annihilation is about to strike out, because
  // `baseline` answers "what would this place read with no darkness anywhere".
  const baseline = brightest(allEmitters);

  // *Daylight* resolves before the contest: it removes effects from play rather than
  // competing within it.
  const { emitters, suppressors, negated } = annihilate(allEmitters, allSuppressors);

  if (!suppressors.length) {
    return { B: brightest(emitters), baseline, winner: null, applied: false, negated };
  }

  // One winner, never a composition. Ties resolve to the first, which is arbitrary but
  // harmless — equal-level suppressors have equal claim by definition.
  const strongest = suppressors.reduce((best, s) => (s.level > best.level ? s : best));
  const isEligible = eligibilityFn(strongest.eligibility);

  // Three categories, not two — see the note above `contest`.
  const blocked = [];
  const passthrough = [];
  for (const e of emitters) (isEligible(e, strongest) ? blocked : passthrough).push(e);

  // Magical light the suppressor cannot block, which also out-levels it, counters it
  // outright — *daylight* over *darkness*. Nothing is suppressed where that light falls.
  if (passthrough.some((e) => e.kind === "magical" && e.level > strongest.level)) {
    return { B: brightest(emitters), baseline, winner: null, applied: false, negated };
  }

  // Whatever the suppressor was never entitled to block. This — not the full baseline —
  // is what the transform acts on.
  //
  // Equal-level magical light needs no special case: the `darkness` preset blocks
  // magical light of its own level *or lower*, so a level-2 light inside a level-2
  // darkness is already in `blocked` and the suppressor simply prevails (§4.1).
  const remaining = brightest(passthrough);

  // The suppressor prevails. Blocked emitters contribute **nothing** — a torch inside a
  // *darkness* does not dim, it stops counting — and the transform then applies to what
  // remains, bounded below by the suppressor's floor.
  const B = applyTransform(remaining, strongest.transform, strongest.floor ?? TIER.DARK);
  return { B, baseline, winner: strongest, applied: B < baseline, negated };
}
