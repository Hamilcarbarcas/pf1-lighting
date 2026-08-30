/**
 * What one emitter contributes, and where. See DESIGN.md §3.2.1.
 *
 * Two zones, and they are different kinds of thing:
 *
 *   inner  `d <= inner`           the set `tier`, absolutely
 *   band   `inner < d <= outer`   `+steps` rungs on whatever else is there, ceiling `cap`
 *   beyond `d > outer`            nothing
 *
 * Foundry's two native radii carry both — `data.bright` is the inner radius, `data.dim` the outer.
 * Nothing is added to the schema because a PF1 light needs nothing added: a torch is Normal to
 * 20 ft, one step up to 40, which is exactly two radii and a set level.
 *
 * The set level and step count live in flags, `LightData`'s schema being fixed.
 */

import { MODULE_ID } from "../constants.mjs";
import { TIER, stepTier, tierCeiling } from "./tiers.mjs";

/**
 * One emitter's light output, independent of position.
 *
 * @typedef {object} Emission
 * @property {number} tier   - The {@link TIER} it provides inside `inner`
 * @property {number} inner  - Radius at that tier, in pixels
 * @property {number} outer  - Outer radius of the relative band, in pixels
 * @property {number} steps  - Rungs the band raises the prevailing level by
 * @property {number} cap    - Ceiling the band may not raise past, a {@link TIER}
 */

/** Which zone a distance falls in. */
export const ZONE = Object.freeze({ NONE: 0, INNER: 1, BAND: 2 });

/**
 * Force the two radii to increase outward.
 *
 * @remarks
 * Foundry does not order `dim` and `bright`: `LightData` has them as independent `NumberField`s
 * (`common/data/data.mjs:45-49`), meeting only in `PointEffectSourceMixin`, which sweeps `shape` at
 * `max(dim, bright)`. So `{bright: 60ft, dim: 0}` — the natural way to author bright-out-to-here,
 * and how a daylight gets written — is valid, and used to invert the old three-zone nesting.
 *
 * Under §3.2.1's two zones the consequence is milder but still wrong untreated: the band would run
 * backwards. `max` rather than a warning, since nothing is ambiguous — a light whose inner radius
 * reaches past its outer simply has no band, which is what Foundry renders too.
 *
 * The old three-way version cost a full debugging session on 2026-08-23; see DESIGN.md §3.2.1's
 * closing note on absence leaving no trace in a readout.
 *
 * @param {Emission} emission
 * @returns {Emission} With `outer >= inner >= 0`
 */
export function normaliseEmission(emission) {
  const tier = emission?.tier ?? TIER.NORMAL;
  const inner = Math.max(0, emission?.inner ?? 0);
  const outer = Math.max(0, emission?.outer ?? 0, inner);
  return {
    tier,
    inner,
    outer,
    steps: Math.max(0, Math.trunc(emission?.steps ?? 1)),
    // Not floored at `tier`, as of 2026-08-28: max defaults to the inner radius's tier but must be
    // able to override it.
    //
    // The old floor read `Math.max(tier, cap ?? tier)`, reasoning that a cap below the set tier is
    // meaningless because a band can only raise. The premise holds but the conclusion does not:
    // the cap bounds the band, and the band raises whatever is already there — the ambient, not
    // this emitter's inner tier. A bright lamp with a Normal-capped halo is an ordinary thing to
    // want, and the floor turned every such halo Bright, so the control looked ignored.
    //
    // Nothing downstream needs the floor: `contest.stack`, `field.overlapCells` and
    // `light-ramps.zonesFor` all resolve the band as `max(base, min(step(base, n), cap))`, §3.2.1's
    // rule, which already refuses to let a low cap lower anything.
    cap: emission?.cap ?? tier,
  };
}

/**
 * Which zone of an emitter a point falls in, and what it contributes there.
 *
 * @remarks
 * Returns ingredients rather than a level: the two zones are consumed at different stages of the
 * contest — inner zones contend by `max`, bands are summed. Collapsing them here would make that
 * distinction unrepresentable, which is the mistake the three-zone ramp made.
 *
 * @param {number} distance - Distance from the emitter origin, in pixels
 * @param {Emission} emission
 * @returns {{zone: number, tier?: number, steps?: number, cap?: number}}
 */
export function contributionAt(distance, emission) {
  const e = normaliseEmission(emission);
  if (e.outer <= 0 || distance > e.outer) return { zone: ZONE.NONE };
  if (distance <= e.inner) return { zone: ZONE.INNER, tier: e.tier };
  // A band with no steps reaches nothing, and saying so here keeps it out of the sum.
  if (e.steps <= 0) return { zone: ZONE.NONE };
  // `tier` rides along unread by `contest.stack`'s band branch — it is the inner zone's level, of
  // no use to a band. Present so the contest can fall back the way the renderer does when `cap` is
  // missing; see the note on that fallback in `contest.stack`.
  return { zone: ZONE.BAND, steps: e.steps, cap: e.cap, tier: e.tier };
}

/**
 * A single emitter's contribution as a brightness, against a known base.
 *
 * @remarks
 * The scalar view, for callers holding one emitter and wanting a number — the readout, the probe's
 * `silent` list, anything asking whether this light reaches here at all. The resolution path does
 * not use it: stacking cannot be expressed one emitter at a time, which is the content of §3.2.1.
 *
 * @param {number} distance - Distance from the emitter origin, in pixels
 * @param {Emission} emission
 * @param {number} [base=TIER.DARK] - The prevailing tier this emitter would be adding to
 * @returns {number} Brightness, 0..1
 */
export function brightnessAt(distance, emission, base = TIER.DARK) {
  const c = contributionAt(distance, emission);
  switch (c.zone) {
    case ZONE.INNER:
      return tierCeiling(c.tier);
    case ZONE.BAND:
      return tierCeiling(Math.min(stepTier(base, c.steps), c.cap));
    default:
      return 0;
  }
}

/**
 * Read an emitter's emission off a live light source.
 *
 * `data.bright` / `data.dim` are already in pixels by the time they reach the source (PF1's
 * low-light mixin has also already scaled them, if active), so only the flags need reading.
 *
 * @param {object} source - A PointLightSource
 * @returns {Emission}
 */
export function emissionOf(source) {
  const config = source.object?.document?.getFlag?.(MODULE_ID, "config") ?? {};
  const tier = config.emitTier ?? TIER.NORMAL;

  return normaliseEmission({
    tier,
    inner: source.data?.bright ?? 0,
    outer: source.data?.dim ?? 0,
    steps: config.steps ?? 1,
    cap: config.cap ?? tier,
  });
}

/* -------------------------------------------- */
/*  Transforms                                  */
/* -------------------------------------------- */

/**
 * Apply a suppressor's transform to an emitter's output.
 *
 * @remarks
 * Reduction used to be a shift of the zone radii — `(rB, rN, rD)` becoming `(0, rB, rN)` — an
 * exact but elaborate identity, whose only purpose was to say "one tier dimmer" in the one
 * language a light source understood before it could carry its own lighting level (§6.2.2).
 *
 * It can now: `clip.mjs` drives `dimLevelCorrection` and `brightLevelCorrection` per source, so
 * reducing a light is lowering its set tier and cap, geometry untouched. The gradient survives
 * because the light keeps both zones.
 *
 * @param {Emission} emission
 * @param {{op: string, steps?: number, max?: number}} transform
 * @returns {Emission}
 */
export function transformEmission(emission, transform) {
  const e = normaliseEmission(emission);
  switch (transform?.op) {
    case "reduce": {
      const n = Math.max(0, transform.steps ?? 1);
      // The band descends with the core. A reduced torch is a dimmer torch, not a Normal torch
      // whose rim happens to still reach Normal.
      return normaliseEmission({ ...e, tier: stepTier(e.tier, -n), cap: stepTier(e.cap, -n) });
    }
    case "clamp": {
      const max = transform.max ?? TIER.DIM;
      return normaliseEmission({
        ...e,
        tier: Math.min(e.tier, max),
        cap: Math.min(e.cap, max),
      });
    }
    default:
      return e;
  }
}
