/**
 * The precedence contest — DESIGN.md §4.1, §3.3.
 *
 * Pure rules. Nothing here touches the canvas, reads a document or knows what a point
 * is: it takes resolved emitters and suppressors and says what wins. Both consumers
 * need it — `evaluate()` for one point, `field()` for one cell — and neither should
 * have to drag the other's machinery along.
 *
 * Model B (§4.1): **highest level wins, equal levels go to the suppressor.** There is exactly
 * one winning suppressor and it is applied once. Suppressors still do not compose with each
 * other — Appendix A.4's rejection of a suppressor *pipeline* stands, and this file has never
 * had one.
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
 * ## Light that survives applies *after* the darkness, not instead of it
 *
 * **Reversed 2026-08-29 (Hamilcarbarcas).** Until then a surviving higher-level light
 * *countered* the suppressor: the whole contest short-circuited and the point resolved to the
 * unsuppressed stack. That is one rule too many, and it had a consequence nobody would have
 * asked for — the short circuit returned the stack over **every** emitter including the ones the
 * darkness had just blocked, so a *daylight*-adjacent lamp anywhere in the area silently relit
 * every torch the darkness was putting out.
 *
 * The order is now the one the rules describe, and it is an order rather than a contest:
 *
 * 1. the darkness **removes** every light it is eligible to block;
 * 2. it **transforms** what is left standing on the ground — which is the ambient;
 * 3. the surviving lights then **apply over that result**, setting or raising it exactly as they
 *    would over any other ground.
 *
 * Worked example (Hamilcarbarcas's): a Dim scene, a mundane light setting Normal, a level-3
 * magical light raising one step, and a level-2 *darkness* reducing by one. The mundane light is
 * blocked; Dim reduces to Dark; the level-3 light raises Dark to Dim. Answer: **Dim**. Under the
 * old counter rule the same point read Normal or brighter.
 *
 * Step 3 is `stack()` with the transformed ground injected as an absolute entry, so set-level
 * zones contend and bands sum from it — no second implementation of §3.2.1.
 *
 * Hence three categories rather than two:
 *
 * | Category | Test | Effect |
 * | --- | --- | --- |
 * | blocked | eligible per the preset | contributes nothing at all |
 * | over | anything else that is a real light | applies *after* the transform |
 * | ground | the ambient | what the transform acts on |
 */

import { TIER, reduceTiers, clampToTier, stepTier, tierCeiling, tierOf } from "./tiers.mjs";
import { ZONE } from "./ramp.mjs";

/* -------------------------------------------- */
/*  Stacking — DESIGN.md §3.2.1                 */
/* -------------------------------------------- */

/**
 * Resolve a set of emitters at one place into a brightness.
 *
 * @remarks
 * **The one place the two zone kinds meet, and they meet by different operations.** Set levels
 * *contend* — light does not stack (§4.2) — while relative bands *sum*:
 *
 * ```
 * A      = max(every covering inner zone)
 * Σn     = sum of `steps` over every covering band
 * ceil   = max of `cap` over those same bands
 * result = max(A, min(A + Σn, ceil))
 * ```
 *
 * Two properties are worth naming because both are easy to lose in a refactor:
 *
 * - **`ceil` is the `max` of the caps, not the `min`.** A cap states what *that source* can
 *   do alone, so a *daylight* whose band crosses a torch's must not be pulled down to the
 *   torch's ceiling.
 * - **The outer `max(A, …)`** stops a low cap from *darkening* ground already brighter than
 *   it. Without it a torch would dim a sunlit field to Normal. Foundry's own shader carries the
 *   identical guard at `base-lighting.mjs:380`.
 *
 * Bands read only `A`, never each other, so this is two passes and not a fixed point: no
 * ordering, no convergence, and no way for two bands to amplify one another.
 *
 * @param {{zone?: number, B?: number, emission?: object}[]} emitters - Each carrying the zone
 *   it contributes through *here*, as resolved by the caller
 * @returns {number} Brightness, 0..1
 */
export function stack(emitters) {
  let absolute = -Infinity;
  let steps = 0;
  let ceiling = -Infinity;

  for (const e of emitters) {
    if (e.zone === ZONE.BAND) {
      steps += e.steps ?? 0;
      // **`?? e.tier` before `?? TIER.NORMAL`, and the order is the point.** This fallback used to
      // be `TIER.NORMAL` alone while `light-ramps.zonesFor` and `renderer` used `emission.tier`, so
      // a band whose `cap` went missing was ceilinged at Normal by the *model* and at the light's
      // own level by the *picture*. For a Bright lamp that is the overlay reading Normal while the
      // screen reads Bright — two answers to one question, and the hardest kind to chase because
      // each half is individually defensible.
      //
      // `normaliseEmission` sets `cap` for anything built from a real light, so this is a guard on
      // synthetic entries rather than a live path. Aligned 2026-08-28 anyway: a divergence that
      // only fires on an unusual input is one that surfaces on an unusual day.
      ceiling = Math.max(ceiling, e.cap ?? e.tier ?? TIER.NORMAL);
    } else if (e.zone === ZONE.INNER) {
      absolute = Math.max(absolute, e.tier ?? TIER.DARK);
    } else if (e.B > 0) {
      // An emitter resolved to a plain brightness with no zone — global illumination, and any
      // caller holding a value rather than a source. Absolute by definition.
      absolute = Math.max(absolute, tierOf(e.B));
    }
  }

  if (absolute === -Infinity) absolute = TIER.DARK;
  if (!steps) return tierCeiling(absolute);

  const raised = Math.min(stepTier(absolute, steps), ceiling);
  return tierCeiling(Math.max(absolute, raised));
}

/* -------------------------------------------- */
/*  Defaults                                    */
/* -------------------------------------------- */

/** An ordinary torch: mundane, no spell level. */
export const DEFAULT_EMITTER = Object.freeze({
  kind: "mundane",
  level: 0,

  /**
   * *Daylight*'s special case, and the one thing that still removes a suppressor from play. An
   * ordinary higher-level light **survives** a darkness and applies over the level it produced;
   * one flagged here **annihilates** with it instead — both effects vanish where they overlap,
   * the ground reverts to what it would have been with neither cast, and this emitter stops
   * contributing light of its own there. Other sources in that region are unaffected and
   * unsuppressed.
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

/**
 * Does this suppressor block *sight through it* — cast an umbra (§4.3)?
 *
 * @remarks
 * **Level 0 means mundane, for suppressors exactly as for emitters.** An unlit cellar and a
 * *darkness* spell both make an area dark, and only one of them stops you seeing the lit
 * courtyard on the far side. Standing in an ordinary dark room you can see out of the
 * doorway perfectly well; that is the difference this predicate names.
 *
 * Two conditions, and the level one is the rule rather than a default:
 *
 * - `level >= 1` — magical. A level-0 source is mundane darkness and never casts an umbra,
 *   whatever else it is configured with.
 * - `blocksPath !== false` — an opt-out for magical darkness that is deliberately
 *   see-through. Homebrew; the default is on.
 *
 * Consumed by §4.3's umbra and by §4.5.1's blindness, so the two cannot drift apart. It
 * matters most for the case that motivated it: a creature with no darkvision on ordinary
 * unlit ground can still see a lit room 30 ft away, and must not be blinded for standing in
 * the dark.
 *
 * @param {object|null} suppressor
 * @returns {boolean}
 */
export function castsUmbra(suppressor) {
  if (!suppressor) return false;
  return (suppressor.level ?? 0) >= 1 && suppressor.blocksPath !== false;
}

/**
 * Does this suppressor hide terrain *inside* it from an observer outside? DESIGN.md §4.5.2.
 *
 * @remarks
 * Strictly narrower than {@link castsUmbra}, and deliberately so. Umbra is per-observer
 * geometry; this becomes **global sight-blocking edges**, which cannot carry a per-observer
 * exception. So it may only fire where the answer is the same for everyone — and that is
 * exactly what Supernatural Dark means, as against ordinary Dark which darkvision handles.
 *
 * Ordinary *darkness* needs nothing here and would be actively wrong to include: a
 * normal-sighted creature has `basicSight.range` 0 and gets terrain from light perception
 * alone, so unlit ground is already unpainted for it, while a darkvision creature's radius
 * correctly does paint it. Adding edges would break the second case to fix a first case that
 * was never broken.
 *
 * @param {object|null} suppressor
 * @returns {boolean}
 */
export function blocksSight(suppressor) {
  if (!castsUmbra(suppressor)) return false;
  return (suppressor.floor ?? TIER.DARK) <= TIER.SUPERNATURAL_DARK;
}

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
   *
   * **Mundane darkness ranks below level 0, so it blocks nothing** (Hamilcarbarcas, 2026-08-29:
   * *"mundane darkness should be treated as -1, so non-magical or lvl 0 light works within its
   * area"*). Level 0 means mundane for a suppressor exactly as it does for an emitter — the same
   * rule `castsUmbra` has always carried — and an unlit cellar does not put out a torch carried
   * into it. Without this a level-0 darkness extinguished every mundane light *and* every
   * level-0 *light* spell, on `0 <= 0`.
   *
   * **Ranked here, not stored.** Writing −1 into `level` would mean migrating documents and
   * teaching `castsUmbra`, `breaks`, `annihilate`, the preset table and the sheet's *Mundane*
   * dropdown entry a second sentinel, all to reach an outcome identical to this line: below
   * level 1 the preset is simply not entitled to anything.
   *
   * It leaves mundane darkness doing only what it can actually do: reduce the ambient, and be
   * lit over by anything at all.
   */
  darkness: (emitter, suppressor) =>
    (suppressor.level ?? 0) >= 1 &&
    (emitter.kind === "mundane" ||
      (emitter.kind === "magical" && emitter.level <= suppressor.level)),

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
 * @remarks
 * **Only *daylight* does, since 2026-08-29.** This used to carry a second clause for ordinary
 * higher-level magical light, on the counter rule the file header records reversing: such a
 * light was held to defeat the darkness outright over its own radius. It no longer defeats
 * anything — it applies *after* the transform — so the darkness keeps its force there and this
 * predicate keeps only the case where a light genuinely removes a suppressor from play.
 *
 * The distinction the geometry cares about is exactly that: a *daylight* takes the region away
 * (`field.resolveRegions` cuts it), while a surviving higher-level light leaves the region
 * standing and merely lights the ground it produced. Reading `breaks` as "the suppressor is not
 * here" is what makes both correct with one predicate.
 *
 * @param {object} emitter
 * @param {object} suppressor
 * @returns {boolean}
 */
export function breaks(emitter, suppressor) {
  return emitter.cancelsDarkness === true && emitter.level >= suppressor.level;
}

/**
 * May this suppressor put this emitter out entirely?
 *
 * @remarks
 * `breaks` and `eligibilityFn` composed, and named, because the pair reads backwards otherwise:
 * an emitter is extinguished when the suppressor is *entitled* to block it **and** the emitter
 * does not annihilate the suppressor first.
 *
 * Unchanged by 2026-08-29's narrowing of `breaks`, and worth checking rather than assuming: a
 * higher-level magical light was never extinguished by way of `breaks`, since the eligibility
 * half already answers false for it. The clause that went was redundant here and load-bearing
 * only in the geometry.
 *
 * Its one caller today is §3.3.1's origin rule — a light standing **inside** a darkness that
 * could block it goes out altogether rather than merely being clipped to what falls outside.
 * Shared here rather than written at that call site so it cannot drift from the pointwise
 * contest, which is the mistake `resolveTier` was extracted to prevent.
 *
 * @param {object} suppressor
 * @param {object} emitter
 * @returns {boolean}
 */
export function extinguishes(suppressor, emitter) {
  if (breaks(emitter, suppressor)) return false;
  return eligibilityFn(suppressor.eligibility)(emitter, suppressor);
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
 * That is what separates it from the ordinary higher-level case, where the light keeps shining
 * but the darkness keeps acting — the ground it produced is what the light then applies over.
 * *Daylight* is the only thing that takes the darkness off the board.
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
 * `winner` and `applied` are separate on purpose. A *darkness* under a surviving level-3 light
 * is present and is the strongest suppressor there, and may still have changed nothing — the
 * light sets a level above anything the transform could have produced. Reporting only `winner`
 * made that read as "the darkness won" while `B` showed a brightly lit point, which is exactly
 * backwards.
 *
 * `applied` is `B < baseline`, not "the transform ran". The transform always runs; what matters
 * is whether the light standing over the result then overrode it.
 *
 * **`winner` is now set in cases that used to report `null`** — the old counter branch returned
 * no winner at all. `evaluate` feeds it to `resolveTier` as a floor, and `vision/blindness`
 * asks it whether the point casts an umbra; both are gated on the resolved tier first
 * (`B <= 0` and `tier > SUPERNATURAL_DARK` respectively), so a lit point cannot reach either.
 *
 * @param {{B: number, kind: string, level: number}[]} emitters - Each with the
 *   brightness it contributes *here*, already resolved by the caller
 * @param {{level: number, eligibility: any, transform: object}[]} suppressors
 * @returns {ContestResult}
 */
export function contest(allEmitters, allSuppressors) {
  const ambient = 0; // nothing reaching this place

  if (!allEmitters.length && !allSuppressors.length) {
    return { B: ambient, baseline: ambient, winner: null, applied: false, negated: [] };
  }

  // Set levels contend, bands sum — see {@link stack}. Not a plain `max` reduce since
  // 2026-08-23: a light's outer band raises the prevailing level rather than setting it, so
  // two overlapping torches are brighter than one (§3.2.1).
  //
  // Measured over the *original* set, including light annihilation is about to strike out,
  // because `baseline` answers "what would this place read with no darkness anywhere".
  const brightest = (list) => stack(list);
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

  // Three categories, not two — see the note above `contest`. Blocked emitters are simply
  // dropped: a torch inside a *darkness* does not dim, it stops counting.
  //
  // Equal-level magical light needs no special case: the `darkness` preset blocks magical light
  // of its own level *or lower*, so a level-2 light inside a level-2 darkness is already blocked
  // and the suppressor simply prevails (§4.1).
  const over = [];
  const ground = [];
  for (const e of emitters) {
    if (isEligible(e, strongest)) continue;
    (e.kind === "ambient" ? ground : over).push(e);
  }

  // Step 2 — the transform acts on the **ground**, which is the ambient and nothing else. This is
  // what a darkness reduces: not "the baseline", which would fold back in the very lights step 1
  // just removed, and not the surviving lights, which have not been applied yet.
  const B0 = applyTransform(brightest(ground), strongest.transform, strongest.floor ?? TIER.DARK);

  // Step 3 — surviving light applies over that result, by the ordinary stacking rules. A set
  // level contends with `B0`, a band raises from it. `stack` reads a zone-less entry as an
  // absolute brightness, which is exactly what the transformed ground is.
  //
  // `over.length` guards nothing but a wasted array: `stack([{B: B0}])` answers `B0` for every
  // value including 0, since `tierOf(0)` is Dark and `tierCeiling(Dark)` is 0 again.
  const B = over.length ? stack([{ B: B0 }, ...over]) : B0;

  return { B, baseline, winner: strongest, applied: B < baseline, negated };
}
