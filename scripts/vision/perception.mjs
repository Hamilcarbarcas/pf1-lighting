/**
 * Vision as perception — DESIGN.md §4.8, §8.2 step 4.
 *
 * The model says how bright a point is. This says what that means for *seeing*.
 *
 * Those are separate questions and Foundry answers them in separate places, which is why
 * getting the lighting right left a visible gap: a token standing in a *darkness* was
 * still plainly visible, because Foundry's light-perception test asks
 * `canvas.effects.testInsideLight(point)` — is this point inside some light source's
 * polygon — and we deliberately never clip `source.shape` (§6.2.4). The raw torch polygon
 * still covers the darkness, so the answer stayed yes no matter what the renderer drew.
 *
 * ## The mapping
 *
 * | Foundry                | PF1                                  | Here                     |
 * | ---------------------- | ------------------------------------ | ------------------------ |
 * | `lightPerception`      | ordinary sight                       | tier ≥ Dim               |
 * | `basicSight`           | darkvision (PF1 folds blindsight in) | any tier above Supernatural Dark, within range |
 * | `seeInvisibility`      | *see invisibility* / *true seeing*   | in range, or lit         |
 *
 * The tier thresholds are the whole ruleset. Ordinary sight works down to dim light and
 * stops at Dark; darkvision ignores light level entirely but is defeated by *supernatural*
 * darkness, which is exactly the distinction §3.1's fifth tier exists to carry.
 *
 * ## Where the observer enters
 *
 * `perceivedTier` takes an observer, and as of the umbra landing (§4.3) it uses it: the
 * god's-eye tier is clamped to whatever the darkness between the two of them allows. That
 * parameter was threaded through three detection modes before there was anything to put in
 * it, which is why this change is four lines rather than a refactor.
 *
 * It remains the seam for §4.4/§4.5 (low-light vision, darkvision as a tier remap), which
 * are the other two observer terms and enter the same way.
 */

import { MODULE_ID } from "../constants.mjs";
import { t } from "../i18n.mjs";
import { flag } from "../settings-cache.mjs";
import { evaluate } from "../model/evaluate.mjs";
import { TIER, TIER_NAME } from "../model/tiers.mjs";
import { isNativeSuppressionDisabled } from "../suppression.mjs";

export const SETTING_PERCEPTION = "perceptionEnabled";

/** The dimmest tier ordinary sight can work in. DESIGN.md §4.8. */
export const SIGHT_TIER = TIER.DIM;

/** Tracks the last applied value so `onChange` can ignore no-op saves. */
let lastValue = null;

/**
 * Is the perception layer active?
 *
 * @remarks
 * Gated on native suppression being disabled as well as on its own setting, and not as a
 * convenience. With native suppression on, Foundry has already clipped light polygons at
 * darkness boundaries (§4.1.1 path 1) and blinded any token standing in one (path 4), so
 * the model is reading a baseline that has had the answer applied to it already. Deciding
 * perception from that would double-count.
 */
export function isPerceptionEnabled() {
  // **Both reads are cached** (`settings-cache.mjs`). This is the hottest settings read in the
  // module by a wide margin — every `_testPoint` and `_testLOS` of every detection mode calls it,
  // and the patched `testInsideLight` calls it again, so a single visibility refresh over ~1,000
  // test points made thousands of `game.settings.get` calls at 14.7 µs each. Measured 2026-08-28
  // at ~61 ms per refresh, which was the largest single cost in the module.
  if (!flag(SETTING_PERCEPTION)) return false;
  return isNativeSuppressionDisabled();
}

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTING_PERCEPTION, {
    name: "Perceive by light level",
    hint:
      "Decide what a creature can see from the lighting model instead of from Foundry's raw light " +
      "polygons: ordinary sight needs dim light or better, darkvision works in darkness but not in " +
      "supernatural darkness. Requires 'Disable native darkness suppression'.",
    scope: "world",
    // **No control surface, by decision (Hamilcarbarcas, 2026-08-26).** The functionality stays; the
    // switch was a development bisection aid and the module is past needing one in the menu.
    // Reachable from the console — see `game.pf1Lighting.settings`.
    config: false,
    type: Boolean,
    // Flipped from `false` with the control. See `suppression.mjs` for the reasoning.
    default: true,
    onChange: (value) => {
      if (value === lastValue) return;
      lastValue = value;
      refresh();
      ui.notifications.info(t(value ? "Notify.PerceptionOn" : "Notify.PerceptionOff"));
    },
  });

  lastValue = (() => {
    try {
      return game.settings.get(MODULE_ID, SETTING_PERCEPTION) === true;
    } catch {
      return false;
    }
  })();
}

/** Re-run visibility so a settings change shows up without a token nudge. */
export function refresh() {
  if (!canvas?.ready) return;
  invalidate();
  canvas.perception.update({ initializeVision: true, refreshVision: true });
}

/* -------------------------------------------- */
/*  Observer scope                              */
/* -------------------------------------------- */

let currentObserver = null;

/**
 * Run `fn` with `observer` as the creature doing the perceiving.
 *
 * @remarks
 * An ambient rather than an argument because the call we most need to influence is
 * `canvas.effects.testInsideLight(point)`, made from inside core's
 * `DetectionModeLightPerception#_testPoint` with no way to pass anything down. Wrapping
 * the detection-mode call gives our `testInsideLight` override the observer that core
 * never had a slot for, without reimplementing the chain above it — which matters,
 * because `limits` also mixes into `_testPoint` and its range clipping has to survive.
 *
 * @template T
 * @param {PointVisionSource|null} observer
 * @param {() => T} fn
 * @returns {T}
 */
export function withObserver(observer, fn) {
  const saved = currentObserver;
  currentObserver = observer ?? null;
  try {
    return fn();
  } finally {
    currentObserver = saved;
  }
}

/** The observer currently being tested, if a detection mode is on the stack. */
export function observer() {
  return currentObserver;
}

/* -------------------------------------------- */
/*  Umbra, injected                             */
/* -------------------------------------------- */

/**
 * @type {{clampAt: (point: object, source: object) => number|null}|null}
 *
 * @remarks
 * Injected rather than imported because `vision/umbra.mjs` already imports *this* file — it
 * needs `darkSightRange` to decide whether an observer is subject to umbra at all. Importing
 * back would make a cycle between two peers, which ES modules tolerate but which puts the
 * correctness of both on the order the bundler happens to evaluate them in. Same seam, same
 * reason, as `suppression.setVisionModel`.
 */
let umbraModel = null;

export function setUmbraModel(model) {
  umbraModel = model ?? null;
}

/* -------------------------------------------- */
/*  Query                                       */
/* -------------------------------------------- */

/**
 * @type {Map<string, number>}
 *
 * One frame's worth of point queries.
 *
 * @remarks
 * `evaluate()` costs 0.0025 ms (§9.7), which is cheap right up until visibility testing
 * multiplies it: every token, times its ~9 test points, times each of its sight modes,
 * every time vision refreshes. The same point is asked about repeatedly within a single
 * pass — `lightPerception` and `seeInvisibility` test identical points — so a memo keyed
 * on the point is nearly free and removes most of the multiplier.
 *
 * Cleared on the next animation frame rather than on an invalidation signal. Within one
 * frame the scene cannot change, which makes the cache trivially correct without having
 * to enumerate what would dirty it; and a stale entry could never outlive the frame that
 * created it even if something did.
 */
const memo = new Map();
let memoScheduled = false;

function scheduleMemoClear() {
  if (memoScheduled) return;
  memoScheduled = true;
  requestAnimationFrame(() => {
    memoScheduled = false;
    memo.clear();
  });
}

/** Drop the memo now. For settings changes and console pokes. */
export function invalidate() {
  memo.clear();
}

/**
 * The light tier at a point, as this observer experiences it.
 *
 * @param {{x: number, y: number, elevation?: number}} point
 * @param {PointVisionSource|null} [obs] - Defaults to whatever {@link withObserver} set
 * @returns {number} A {@link TIER} value
 */
export function perceivedTier(point, obs = currentObserver) {
  // The observer is part of the key because the answer now genuinely differs between two
  // creatures standing in different places: umbra is a property of the *path*, not of the
  // point. It was in the key before there was anything to distinguish, on the reasoning that
  // a cache silently sharing entries between observers would present as a rules bug rather
  // than as a cache bug.
  const key = `${obs?.sourceId ?? ""}|${Math.round(point.x)}|${Math.round(point.y)}|${Math.round(point.elevation ?? 0)}`;

  const hit = memo.get(key);
  if (hit !== undefined) return hit;

  const tier = clampToUmbra(evaluate(point).tier, point, obs);
  memo.set(key, tier);
  scheduleMemoClear();
  return tier;
}

/**
 * The tier as the **current view** would perceive it, or `null` in god's eye.
 *
 * @remarks
 * `perceivedTier` needs an observer, and `currentObserver` is only set while a detection mode is
 * on the stack — so anything asking outside a visibility pass (the readout, a console probe) got
 * the unclamped god's-eye answer and no indication that it had. That is why the tooltip went on
 * reporting a lit room at its own tier while the screen, correctly, showed it shadowed.
 *
 * §5.3's rule decides the multi-observer case and it is `max`: a point shadowed for one creature
 * and lit for another is **lit**, so the least restrictive observer wins. That also matches what
 * is on screen, which is the union of what the party can see.
 *
 * `null` rather than the raw tier when there are no active vision sources, so a caller can tell
 * "nothing is clamping this" from "something looked and found no clamp" — in god's eye there is
 * no observer, no path, and so no umbra at all (§5.4).
 *
 * @param {{x: number, y: number, elevation?: number}} point
 * @returns {number|null}
 */
export function viewerTier(point) {
  const sources = [...(canvas?.effects?.visionSources?.values() ?? [])].filter((s) => s.active);
  if (!sources.length) return null;

  let best = -Infinity;
  for (const source of sources) best = Math.max(best, perceivedTier(point, source));
  return Number.isFinite(best) ? best : null;
}

/**
 * Lower a god's-eye tier to what this observer can actually make out at that point.
 *
 * @remarks
 * **The clamp only ever darkens.** Umbra answers "what is between us", and nothing between
 * two points can make the far one brighter. Guarding on `<` rather than assigning means a
 * region whose clamp is *above* the point's own tier — a Dim umbra falling across ground that
 * is already Dark — correctly leaves it alone, which is the case §4.3's "clamp, do not
 * transform" amendment exists to get right.
 */
function clampToUmbra(tier, point, obs) {
  if (!obs || !umbraModel) return tier;
  const clamp = umbraModel.clampAt(point, obs);
  return clamp !== null && clamp < tier ? clamp : tier;
}

/**
 * How far this creature sees with **no regard to light level at all**, in pixels.
 *
 * @remarks
 * Two PF1 senses grant the same faculty and differ only in reach, so they are one function
 * rather than two predicates:
 *
 * | Sense | Reach | Notes |
 * | --- | --- | --- |
 * | *See in darkness* (`sid`) | unbounded | "perfect vision in all darkness", no range given |
 * | *True seeing* (`tr`) | its own range, 120 ft | "sees through normal and magical darkness" |
 * | *Blindsight* (`bs`) | its own range | not sight at all, so light cannot constrain it |
 *
 * This is **not** a wider darkvision. Darkvision is defeated by supernatural darkness and
 * these are not, so they cannot be expressed by extending a radius — they are an exemption
 * from light level as a constraint, bounded by distance.
 *
 * **PF1 leaves `sid` stranded.** It is a real trait with a change flag
 * (`pf1/module/documents/actor/actor-pf.mjs:1639`, `config.mjs:2021`) and it appears on the
 * sheet, but `_syncSenses` never reads it — no detection mode, no vision behaviour, ever.
 * Nothing existed for it to counter. Supernatural Dark is the first thing that does.
 *
 * *True seeing* it does handle, partly: `_syncSenses` bumps `basicSight.range` and
 * `sight.range` to the spell's range and drops the vision mode back to `basic`
 * (`pf1/module/documents/token.mjs:225-232`), so terrain and detection already reach. What
 * PF1 has no way to express is that the reach survives *magical darkness* — which is
 * exactly what §4.8's darkvision gate would otherwise take away from it.
 *
 * @param {PointVisionSource|null} source
 * @returns {number} Pixels; `Infinity` for see-in-darkness, `0` for neither sense
 */
export function darkSightRange(source) {
  const senses = source?.object?.actor?.system?.traits?.senses;
  if (!senses) return 0;

  // No range in the rules, so no range here. `maxR` stands in wherever a finite number is
  // required — see the `_initialize` override in `suppression.mjs`.
  if (senses.sid === true) return Infinity;

  // The widest bounded sense wins; they compose rather than override.
  //
  // **Blindsight is here because it is not sight**, which is the same reason it needed
  // rescuing from the sight edges in `detection.mjs`. Detection already worked through the
  // `blindSight` mode; what did not was *terrain*, which Foundry paints from `data.radius`
  // intersected with `los` — and `los` is truncated at a supernatural darkness boundary. So
  // a blindsighted creature detected every token in range while standing in an unpainted
  // void. Treating it as light-independent perception with a range fixes the rendering half
  // and costs nothing on the detection half, which was already right.
  const bounded = Math.max(senses.tr?.total ?? 0, senses.bs?.total ?? 0);
  if (bounded > 0) {
    try {
      const feet = pf1.utils.convertDistance(bounded)[0];
      // `getLightRadius` rather than a raw pixel conversion: it accounts for token size, so
      // a Huge creature's range is measured from its edge as Foundry measures everything
      // else.
      return source.object?.getLightRadius?.(feet) ?? 0;
    } catch {
      return 0;
    }
  }

  return 0;
}

/**
 * Blindsight's range alone, in pixels.
 *
 * @remarks
 * The third slice of the same trait data, and it exists because the **blinded condition** needs
 * a different subset again from either of the other two.
 *
 * {@link darkSightRange} answers *"how far does perception that ignores light reach"* and folds
 * blindsight in with *see in darkness* and *true seeing*. That is right for a creature standing
 * in magical darkness — all three see through it. It is wrong for a creature that has been
 * **blinded**, because the other two are still *sight*: a blinded creature does not get to use
 * *true seeing*, and blindsight is the only one of the three that survives.
 *
 * So: one function per question, rather than one function with a flag. Three narrow readers of
 * the same field are easier to reason about than one reader with three modes, and the mistake
 * this guards against — using the wrong subset — is invisible at the call site otherwise.
 *
 * @param {PointVisionSource|null} source
 * @returns {number} Pixels; `0` for a creature with no blindsight
 */
export function blindsightRange(source) {
  const range = source?.object?.actor?.system?.traits?.senses?.bs?.total ?? 0;
  if (range <= 0) return 0;
  try {
    // `getLightRadius`, as the others do, so a Huge creature measures from its edge.
    return source.object?.getLightRadius?.(pf1.utils.convertDistance(range)[0]) ?? 0;
  } catch {
    return 0;
  }
}

/**
 * The same, **excluding blindsight** — the senses that are genuinely *sight*.
 *
 * @remarks
 * Blindsight belongs in {@link darkSightRange}, which drives terrain, blinding and sweep
 * rank. It must **not** drive the detection short-circuits below, for a reason that is pure
 * Foundry plumbing rather than rules:
 *
 * `CanvasVisibility#testVisibility` runs `basicSight` and `lightPerception` **before** the
 * special modes, and only a special mode sets `object.detectionFilter`
 * (`groups/visibility.mjs:759-790`). So if `lightPerception` starts succeeding for a
 * blindsighted creature, the target is still detected — but by the wrong mode, and PF1's
 * blue blindsight outline silently stops being drawn.
 *
 * The distinction is real in the rules too: blindsight perceives, it does not *see*. It
 * should not let you read a scroll in the dark.
 *
 * @param {PointVisionSource|null} source
 * @returns {number} Pixels
 */
export function visualDarkSightRange(source) {
  const senses = source?.object?.actor?.system?.traits?.senses;
  if (!senses) return 0;
  if (senses.sid === true) return Infinity;

  const trueSeeing = senses.tr?.total ?? 0;
  if (trueSeeing <= 0) return 0;
  try {
    return source.object?.getLightRadius?.(pf1.utils.convertDistance(trueSeeing)[0]) ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Is this point inside the observer's light-independent sight?
 *
 * @remarks
 * Walls are not tested here. Every caller runs inside a detection mode that has already
 * checked line of sight, and the one that has not — {@link modelBlinds} — asks about the
 * observer's own square, where the question does not arise.
 */
function withinDarkSight(point, obs) {
  const range = visualDarkSightRange(obs);
  if (range <= 0) return false;
  if (range === Infinity) return true;
  return Math.hypot(point.x - obs.x, point.y - obs.y) <= range;
}

/**
 * Can ordinary sight make something out here?
 *
 * @param {{x: number, y: number, elevation?: number}} point
 * @param {PointVisionSource|null} [obs]
 * @returns {boolean}
 */
export function perceives(point, obs = currentObserver) {
  if (withinDarkSight(point, obs)) return true;
  return perceivedTier(point, obs) >= SIGHT_TIER;
}

/**
 * Can darkvision make something out here?
 *
 * @remarks
 * Darkvision does not care how dark it is — that is the point of it — so this is not a
 * threshold like {@link perceives} but a single exclusion. *Supernatural* darkness is the
 * one thing it cannot see through, and the model already distinguishes that from ordinary
 * Dark by which suppressor produced it and how low that suppressor's `floor` reaches
 * (§3.3). Plain *darkness* bottoms out at Dark and darkvision works in it; a source
 * explicitly configured for Supernatural Dark defeats it.
 *
 * Range is not checked here. Foundry has already applied it — `basicSight` carries the
 * darkvision range as `mode.range` and `DetectionMode#_testPoint` tests it before this
 * runs.
 *
 * @param {{x: number, y: number, elevation?: number}} point
 * @param {PointVisionSource|null} [obs]
 * @returns {boolean}
 */
export function darkvisionSees(point, obs = currentObserver) {
  if (withinDarkSight(point, obs)) return true;
  return perceivedTier(point, obs) > TIER.SUPERNATURAL_DARK;
}

/**
 * Human-readable reason for a perception verdict. Used by `probe.perception()`.
 *
 * @param {{x: number, y: number, elevation?: number}} point
 * @param {PointVisionSource|null} [obs]
 */
export function explainPoint(point, obs = currentObserver) {
  const tier = perceivedTier(point, obs);

  // The god's-eye answer alongside the observer's, because "this token should be visible"
  // has two completely different causes — the point is dark, or the *path* is — and they
  // need different fixes. Reporting only the resolved tier makes them indistinguishable.
  const raw = evaluate(point).tier;
  const clamp = obs && umbraModel ? umbraModel.clampAt(point, obs) : null;

  return {
    tier,
    tierName: TIER_NAME[tier],
    ordinarySight: tier >= SIGHT_TIER,
    darkvision: tier > TIER.SUPERNATURAL_DARK,
    rawTier: raw,
    rawTierName: TIER_NAME[raw],
    // null: nothing between them. A tier: shadowed, and this is what by.
    umbraClamp: clamp === null ? null : TIER_NAME[clamp],
    // The distinction that matters — the clamp exists *and* it is what decided the answer.
    umbraApplied: clamp !== null && clamp < raw,
  };
}
