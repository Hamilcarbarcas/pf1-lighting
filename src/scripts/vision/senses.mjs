/**
 * Blindsight is not darkvision — DESIGN.md §4.5.3.
 *
 * PF1 folds the two together at the token document, and says so:
 *
 * ```js
 * // Darkvision, also includes blindsight until we have a better representation
 * const blackAndWhite = Math.max(darkvision, blindsight);
 * if (blackAndWhite > 0) {
 *   this.sight.visionMode = "darkvision";
 *   basicMode.range = Math.max(baseRange, convertDistance(blackAndWhite));
 * }
 * ```
 *
 * (`pf1/module/documents/token.mjs:205-214`, then `sight.range` at `:234` and darkvision's
 * `vision.defaults` copied onto the sight fields at `:260-265`.)
 *
 * A creature with ordinary eyes and blindsight 30 is thereby told it *is* a darkvision creature
 * with a 30 ft eye. §4.8 examined this in 2026-08-22 and cleared it, correctly, as harmless to
 * *detection*: PF1 pushes a separate `blindSight` mode at `DETECTION_TYPES.OTHER` (`:252-254`) whose
 * `_canDetect` is unconditional, so nothing is lost there.
 *
 * That reasoning did not survive two later features, each of which reads the conflated value:
 *
 * - §6.2.11 keys the observer's greyness on `visionMode.id`, so the creature greys every region at
 *   or below Dark across the whole map.
 * - `sight.range` becomes the blindsight range, so the vision FOV is a hard 30 ft disc where the
 *   token previously had none and saw by light perception alone.
 *
 * Reported 2026-09-05 as blindsight overriding every other vision mode and leaving nothing but its
 * own radius in black and white, which is exactly those two together.
 *
 * **The rule.** Blindsight is additive. It grants normal sight everything it granted before and
 * fills in what light cannot reach; it does not replace the eye, narrow it, or recolour the map.
 * §4.5.1 already supplies the fill — `darkSightRange` folds blindsight in and the `_initialize`
 * override in `suppression.mjs` maximises `data.radius` to it — so nothing here needs to add reach.
 * This only stops PF1 taking reach away.
 *
 * **Why the parent runs twice rather than being re-derived.** The correction is "what PF1 would have
 * computed had this creature no blindsight", and the only faithful expression of that is to run
 * PF1's own function with the sense hidden. Re-deriving it here means copying five interacting
 * lines — the `blackAndWhite` maximum, the `basicSight` range, the `seeInvisibility` range that
 * reads `basicMode.range` mid-mutation, the true-seeing override, and the `vision.defaults`
 * copy — and every one is a place to drift from the system on the next PF1 release. Hiding one
 * field and calling `super` cannot drift.
 *
 * The `blindSight` detection mode is the one thing hiding the sense also removes, so it is pushed
 * back afterwards. That is deliberate asymmetry, not an oversight: the mode is the half PF1 already
 * has right.
 */

import { MODULE_ID } from "../constants.mjs";

export const SETTING_SEPARATE_BLINDSIGHT = "separateBlindsight";

/** Marks a prototype this module has already patched. */
const PATCHED = Symbol.for("pf1LightingSensesPatched");

function isEnabled() {
  try {
    return game.settings.get(MODULE_ID, SETTING_SEPARATE_BLINDSIGHT) === true;
  } catch {
    return true;
  }
}

/**
 * Re-prepare every token document on the scene.
 *
 * @remarks
 * `reset()` rather than `prepareData()`. The two are not interchangeable — PF1's `prepareBaseData`
 * is not idempotent, so calling it a second time over already-prepared data compounds rather than
 * recomputes. `reset()` re-initialises from `_source` first, which is the whole difference.
 */
function reprepareTokens() {
  if (!canvas?.ready) return;
  for (const token of canvas.tokens?.placeables ?? []) {
    try {
      token.document.reset();
      token.initializeVisionSource?.();
    } catch {
      // One malformed token must not stop the rest re-preparing.
    }
  }
  canvas.perception.update({ initializeVision: true, refreshVision: true, refreshLighting: true });
}

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTING_SEPARATE_BLINDSIGHT, {
    name: "Blindsight is separate from darkvision",
    hint:
      "Stops PF1 treating blindsight as darkvision, which forces the black-and-white vision mode " +
      "and shrinks the creature's sight range to its blindsight range. Blindsight then adds to " +
      "normal vision instead of replacing it. Fixes a PF1 bug, so it is on by default.",
    scope: "world",
    // No control surface, on the `guardNegativeLowLight` precedent (§10.6): this corrects the
    // system rather than expressing a preference, so there is nothing for a table to sit either
    // side of. Reachable from the console — see `game.pf1Lighting.settings`.
    config: false,
    type: Boolean,
    default: true,
    onChange: () => reprepareTokens(),
  });
}

/**
 * Patch `_syncSenses` so blindsight stops masquerading as darkvision.
 *
 * @remarks
 * **A prototype patch, and `init` rather than `setup`.** Both are forced, and both differ from the
 * subclassing this module uses everywhere else.
 *
 * Scene documents — and with them every embedded `TokenDocument` — are constructed in
 * `Game#initializeDocuments` (`game.mjs:739`), *before* the `setup` hook at `:746`. Replacing
 * `CONFIG.Token.documentClass` at `setup` would therefore reach only tokens created afterwards and
 * leave every token already on every scene running PF1's version. Patching the prototype reaches
 * instances that already exist, which is the property wanted here and the one subclassing cannot
 * have.
 *
 * `init` is late enough: the system's `init` callback is registered before any module's and runs
 * first, so `CONFIG.Token.documentClass` is already `TokenDocumentPF` by the time this runs. Nothing
 * else in the ecosystem wraps `_syncSenses` — it is a PF1-private method — so there is no wrapper
 * chain to sit correctly within.
 */
export function applyPatch() {
  const proto = CONFIG.Token?.documentClass?.prototype;
  if (!proto || proto[PATCHED]) return;

  const original = proto._syncSenses;
  if (typeof original !== "function") return;

  Object.defineProperty(proto, PATCHED, { value: true, enumerable: false });

  proto._syncSenses = function pf1LightingSyncSenses() {
    const senses = this.actor?.system?.traits?.senses;
    const blindsight = senses?.bs?.total ?? 0;
    if (!isEnabled() || blindsight <= 0) return original.call(this);

    // Darkvision at least as wide makes the correction a no-op — it is already the `blackAndWhite`
    // maximum and already the `basicSight` range, so hiding blindsight would change nothing. Worth
    // a branch rather than a second pass: `_syncSenses` runs on every `prepareBaseData`, and this
    // is also the structural reason a creature with both senses is unaffected by any of this.
    if ((senses.dv?.total ?? 0) >= blindsight) return original.call(this);

    // Identity, not content: PF1 assigns a fresh `this.detectionModes = []` as its first act after
    // the three early returns (`token.mjs:179-183`). A different array proves it got that far,
    // which is a behavioural test rather than three copies of its preconditions that could drift.
    const before = this.detectionModes;

    const restore = senses.bs.total;
    try {
      senses.bs.total = 0;
      original.call(this);
    } finally {
      senses.bs.total = restore;
    }

    if (this.detectionModes === before || !Array.isArray(this.detectionModes)) return;
    // Present already means the field could not be hidden — a derived model that refused the
    // assignment — and PF1 ran unmodified. Its own mode is there and the sight fields are the old
    // behaviour, which is the correct thing to degrade to.
    if (this.detectionModes.some((m) => m.id === "blindSight")) return;

    let range;
    try {
      range = pf1.utils.convertDistance(blindsight)[0];
    } catch {
      return;
    }

    this.detectionModes.push({ id: "blindSight", enabled: true, range });

    // Guarded because an absent comparator is worse than no sort: `Array#sort` with `undefined`
    // orders by string, which would put the modes in an order PF1 never produces.
    const sorter = this.constructor._sortDetectionModes;
    if (typeof sorter === "function") this.detectionModes.sort(sorter);
  };
}

/** Is the patch installed and switched on? Read by `probe.vision()`. */
export function status() {
  return {
    enabled: isEnabled(),
    patched: CONFIG.Token?.documentClass?.prototype?.[PATCHED] === true,
  };
}
