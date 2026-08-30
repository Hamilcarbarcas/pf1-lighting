/**
 * Wiring the perception model into Foundry's visibility pipeline. DESIGN.md §4.8.
 *
 * Foundry decides "can observer O see target T" in `DetectionMode#testVisibility`, which
 * runs each of the token's detection modes over a handful of test points. Three of PF1's
 * sight modes consult light, and each consults it differently:
 *
 *   `lightPerception`   `canvas.effects.testInsideLight(point)` — core
 *   `basicSight`        nothing; range only. PF1 puts darkvision here.
 *   `seeInvisibility`   `lightSource.shape.contains()` in a loop — PF1's replacement,
 *                       `pf1/module/canvas/detection-modes.mjs:28-33`
 *
 * Two levers rather than one. `testInsideLight` is overridden directly, correcting core's light
 * perception at the source so anything asking the same question gets the same answer — enough to
 * fix the visible symptom on its own.
 *
 * The detection modes are also mixed into, for two reasons that show up later: the mixin supplies
 * an observer to the override (`testInsideLight` has no parameter for one, and §4.3's umbra makes
 * the answer observer-dependent), and darkvision needs a rule of its own with nothing to do with
 * `testInsideLight`.
 *
 * The mixin composes rather than replaces, following `limits`' pattern exactly: build a subclass of
 * the instance's constructor and `Object.setPrototypeOf` the live instance onto it
 * (`limits/scripts/_index.mjs:29-34`). That composes with whoever else has already mixed in, either
 * order, needing no opinion about hook registration order. PF1 replaces `seeInvisibility` outright
 * and `limits` wraps `_testPoint` on everything, so subclassing the class core ships would silently
 * drop both.
 */

import { VISION_RANK } from "../constants.mjs";
import { isNativeSuppressionDisabled } from "../suppression.mjs";
import {
  darkvisionSees,
  isPerceptionEnabled,
  observer,
  perceives,
  withObserver,
} from "./perception.mjs";

const PATCH_MARK = "pf1LightingPerceptionPatched";

/* -------------------------------------------- */
/*  testInsideLight                             */
/* -------------------------------------------- */

/**
 * Answer "is this point inside light?" from the model rather than from raw polygons.
 *
 * @remarks
 * A prototype patch rather than a `CONFIG.Canvas.groups.effects.groupClass` swap: the group is
 * constructed during `Canvas#draw`, so a class swap has to win a race with it. Patching the
 * prototype is order-independent and applies to the group that already exists.
 *
 * Only the no-`condition` call is intercepted — a precise discriminator rather than caution, since
 * Foundry has exactly two callers:
 *
 *   - `DetectionModeLightPerception#_testPoint` passes no options. That is the perception case.
 *   - `PointDarknessSource#updateSuppression` (`point-darkness-source.mjs:90`) passes a
 *     `condition`, and is native suppression path 2 in mirror image. Its answer is already
 *     discarded by the `suppressed` override, and re-deciding it from the model would feed the
 *     contest's own output back into its input.
 */
export function patchEffectsGroup() {
  const cls = CONFIG.Canvas.groups?.effects?.groupClass;
  if (!cls || Object.hasOwn(cls.prototype, PATCH_MARK)) return;

  const original = cls.prototype.testInsideLight;

  Object.defineProperty(cls.prototype, PATCH_MARK, { value: true });
  cls.prototype.testInsideLight = function (point, options = {}) {
    // `typeof options === "number"` is the deprecated v13 elevation signature — left to core,
    // which logs the compatibility warning.
    if (!isPerceptionEnabled() || typeof options === "number" || options.condition) {
      return original.call(this, point, options);
    }
    return perceives(point, observer());
  };
}

/* -------------------------------------------- */
/*  Detection modes                             */
/* -------------------------------------------- */

/**
 * Name the observer, so `testInsideLight` and everything downstream knows who is looking.
 *
 * The default for every sight mode. Adds no rule of its own — the light test it scopes lives in
 * core, corrected in place.
 */
const ObserverScopeMixin = (Base) =>
  class extends Base {
    static [PATCH_MARK] = true;

    /** @override */
    _testPoint(visionSource, mode, target, test) {
      if (!isPerceptionEnabled()) return super._testPoint(visionSource, mode, target, test);
      return withObserver(visionSource, () =>
        super._testPoint(visionSource, mode, target, test)
      );
    }
  };

/**
 * Darkvision — `basicSight`.
 *
 * @remarks
 * The one sight mode with no light test to correct: core gates it on range and line of sight alone,
 * which is right, seeing in the dark being the entire faculty. What it lacks is the exception —
 * supernatural darkness defeats darkvision, and Foundry has no tier to express that in. The model
 * does (§3.1), so the rule is one comparison.
 *
 * Blindsight survives this, which is why the mixin is sight-only rather than luck. PF1 registers
 * blindsight twice: it inflates `basicSight.range` to `max(baseRange, darkvision, blindsight)` for
 * the black-and-white rendering (`pf1/module/documents/token.mjs:205-213`), and pushes a separate
 * `blindSight` mode at `DETECTION_TYPES.OTHER` whose `_canDetect` returns `true` unconditionally
 * (`pf1/module/canvas/detection-modes.mjs:73-87`). Detection is a disjunction over modes, so a
 * blindsighted creature in supernatural darkness fails here — correctly, if it has no darkvision —
 * and still detects through the untouched OTHER-type mode.
 *
 * Gating every mode rather than only sight modes would have blinded it for real.
 */
const DarkvisionMixin = (Base) =>
  class extends Base {
    static [PATCH_MARK] = true;

    /** @override */
    _testPoint(visionSource, mode, target, test) {
      if (!isPerceptionEnabled()) return super._testPoint(visionSource, mode, target, test);
      return withObserver(visionSource, () => {
        if (!super._testPoint(visionSource, mode, target, test)) return false;
        return darkvisionSees(test.point, visionSource);
      });
    }
  };

/**
 * *See invisibility* — `seeInvisibility`.
 *
 * @remarks
 * PF1 replaces this mode with one detecting in range or anywhere lit
 * (`pf1/module/canvas/detection-modes.mjs:18-34`), so seeing the invisible is not artificially
 * shorter-ranged than seeing the visible. The light half reads `lightSource.shape.contains()`
 * directly, so unlike core's it cannot be corrected by overriding `testInsideLight`.
 *
 * It needs narrowing, not reimplementing. Beyond `mode.range` the only way the chain can have
 * returned true is the lit branch, so re-deciding that case from the model gets the right answer
 * without knowing how the branch is written, and keeps `limits`' range clipping — layered above
 * PF1's mode — intact.
 */
const SeeInvisibilityMixin = (Base) =>
  class extends Base {
    static [PATCH_MARK] = true;

    /** @override */
    _testPoint(visionSource, mode, target, test) {
      if (!isPerceptionEnabled()) return super._testPoint(visionSource, mode, target, test);
      return withObserver(visionSource, () => {
        if (!super._testPoint(visionSource, mode, target, test)) return false;
        if (this._testRange(visionSource, mode, target, test)) return true;
        return perceives(test.point, visionSource);
      });
    }
  };

/**
 * Non-sight senses — blindsight, blindsense, lifesense.
 *
 * @remarks
 * Darkness must not block these, and the edge approach blocks them by default. Found by testing
 * 2026-08-22: a blindsighted creature could not perceive into a Supernatural Dark bubble from
 * outside it.
 *
 * The cause is that `los` is one polygon shared by every detection mode. `DetectionMode#_testLOS`
 * tests `visionSource.los.contains(...)` for any mode with `walls: true`
 * (`detection-mode.mjs:150-166`) and never asks what kind of sense it is, so §4.5.2's sight-blocking
 * edges, which truncate `los` at the darkness boundary, truncate tremorsense and blindsight with
 * it. Blindsight is not sight; a deeper darkness is nothing at all to it.
 *
 * It survived until now by accident — core builds those edges one-directional, so an observer
 * inside the bubble swept through them. Making them bidirectional, required for §4.3's 360° umbra,
 * removes the accident and breaks the inside case too.
 *
 * The same line is why blinding leaks: `_testLOS` checks `visionSource.blinded.darkness` against the
 * source type, always `"sight"`, so a creature blinded by supernatural darkness loses its blindsight
 * along with its eyes.
 *
 * The fix is a per-point collision test at piercing rank, replacing the shared polygon. No extra
 * sweep — `testCollision` is per test point and detection already works per point. Walls still
 * block, sitting at `-Infinity` where no rank clears them; darkness edges do not, every one ranking
 * below `PIERCING`.
 *
 * Only modes with `walls: true` need this. `feelTremor`, `senseInvisibility` and `senseAll` set
 * `walls: false` and never reach the shared polygon.
 */
const NonSightMixin = (Base) =>
  class extends Base {
    static [PATCH_MARK] = true;

    /** @override */
    _testLOS(visionSource, mode, target, test) {
      if (!isPerceptionEnabled() || !this.walls) {
        return super._testLOS(visionSource, mode, target, test);
      }
      return !CONFIG.Canvas.polygonBackends.sight.testCollision(
        visionSource.origin,
        test.point,
        {
          type: "sight",
          mode: "any",
          source: visionSource,
          useThreshold: true,
          priority: VISION_RANK.PIERCING,
        }
      );
    }
  };

function mixinFor(mode) {
  const SIGHT = foundry.canvas.perception.DetectionMode.DETECTION_TYPES.SIGHT;
  if (mode.type !== SIGHT) return NonSightMixin;

  switch (mode.id) {
    case "basicSight":
      return DarkvisionMixin;
    case "seeInvisibility":
      return SeeInvisibilityMixin;
    default:
      return ObserverScopeMixin;
  }
}

/**
 * Re-parent every sight detection mode onto a subclass carrying the mixin.
 *
 * @remarks
 * All modes, with opposite intent by type. Sight modes get the light rules; non-sight modes get
 * {@link NonSightMixin}, whose whole job is to undo an effect they should never have been subject
 * to — §4.5.2's edges truncating the `los` polygon every mode shares. A creature with tremorsense in
 * a deeper darkness still feels the floor.
 *
 * Runs exactly once, at `setup`: not at `canvasInit` where the source-class mixins live, and not at
 * `init`. The window is narrow and both edges are real.
 *
 *   - After PF1, which constructs its replacement modes during `init` (`pf1/pf1.mjs:251-258`) and
 *     assigns fresh instances over `CONFIG.Canvas.detectionModes`. Mixing before that is mixing
 *     into objects that get thrown away.
 *   - Before `limits`, and only once. `limits` mixes at every `canvasInit`, and its `applyMixin` is
 *     idempotent only by class identity — it caches the class it produced and returns it unchanged
 *     when asked again (`limits/scripts/utils.mjs`). Re-parenting the instance underneath after it
 *     has cached defeats that: the next `canvasInit` sees a constructor it has never mixed and adds
 *     a second copy of its own `_testPoint` to the chain, one more per scene change, indefinitely.
 *     Going in first leaves `limits` holding a stable class and its cache working.
 *
 * So the chain settles at `Limits < this < PF1-or-core`, which is also the wanted order: `limits`
 * clips range above, this scopes the observer, core does the light test corrected in
 * {@link patchEffectsGroup}.
 */
export function mixinDetectionModes() {
  for (const mode of Object.values(CONFIG.Canvas.detectionModes ?? {})) {
    if (mode.constructor[PATCH_MARK]) continue;
    Object.setPrototypeOf(mode, mixinFor(mode)(mode.constructor).prototype);
  }
}

/* -------------------------------------------- */
/*  Diagnostics                                 */
/* -------------------------------------------- */

/**
 * Which modes are patched, and is the layer live?
 *
 * @remarks
 * Three things must line up before perception changes anything, and a failure in any of them looks
 * identical on screen — everyone sees everything, exactly as if the module were off. This reports
 * all three, §9's debugging note applied before the fact rather than after the fourth wrong guess.
 */
export function status() {
  const chainOf = (cls) => {
    const names = [];
    let c = cls;
    while (c && c !== Function.prototype) {
      names.push(c.name || "(anonymous)");
      c = Object.getPrototypeOf(c);
    }
    return names.join(" < ");
  };

  const report = {
    enabled: isPerceptionEnabled(),
    nativeSuppressionDisabled: isNativeSuppressionDisabled(),
    testInsideLightPatched: Object.hasOwn(
      CONFIG.Canvas.groups?.effects?.groupClass?.prototype ?? {},
      PATCH_MARK
    ),
    modes: Object.values(CONFIG.Canvas.detectionModes ?? {}).map((m) => ({
      id: m.id,
      type: m.type,
      patched: m.constructor[PATCH_MARK] === true,
      chain: chainOf(m.constructor),
    })),
  };

  console.error("PF1 Lighting | perception status", report);
  return report;
}
