/**
 * Low-light vision must not enlarge darkness. DESIGN.md §4.4.
 *
 * PF1 multiplies a light's `dim` and `bright` radii by the observers' low-light multiplier
 * in `LLVMixin.getRadius()` (`pf1/module/canvas/low-light-vision.mjs:66-114`), applied to
 * the **placeable** via `_getLightSourceData()` rather than to the source
 * (`pf1/pf1.mjs:182-183`). A darkness source is an AmbientLight with `negative: true`
 * (§3.5) and goes through exactly the same path, so it gets doubled too.
 *
 * **Confirmed live 2026-08-22**: darkness bubbles render at double their authored radius
 * whenever an observer has low-light vision. §4.4 predicted this from reading the source
 * before any of it was built.
 *
 * ## Why this ships ahead of the rest of §4.4
 *
 * Not for correctness — low-light vision is unimplemented, so nothing else depends on it
 * yet. For **instrumentation**. Every darkness on the scene is currently a different size
 * from the one its document describes, so every geometry observation is being made against
 * a scene that does not match its own data, and every conclusion drawn from one inherits
 * the discrepancy silently.
 *
 * That is the same failure mode as native suppression path 3 (§4.1.1), which cost several
 * rounds of diagnosing a rules bug that was really a geometry one. Distorting the test bed
 * is a different and worse class of problem from distorting the picture.
 *
 * Low-light vision *should* enlarge light and never darkness: the rules extend how far a
 * creature can make use of a light source, and say nothing about how far a *darkness* spell
 * reaches. That is a property of the spell, not of the eye.
 */

import { MODULE_ID } from "../constants.mjs";

export const SETTING_LLV_GUARD = "guardNegativeLowLight";

/** Tracks the last applied value so `onChange` can ignore no-op saves. */
let lastValue = null;

function isGuardEnabled() {
  try {
    return game.settings.get(MODULE_ID, SETTING_LLV_GUARD) === true;
  } catch {
    return true;
  }
}

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTING_LLV_GUARD, {
    name: "Low-light vision does not enlarge darkness",
    hint:
      "Stops PF1's low-light vision multiplier from doubling the radius of darkness sources. " +
      "Low-light vision extends how far a creature can use a light; it has no effect on how far a " +
      "darkness spell reaches. Fixes a PF1 bug, so it is on by default and independent of this " +
      "module's other features.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: (value) => {
      if (value === lastValue) return;
      lastValue = value;
      if (canvas?.ready) {
        for (const light of [...canvas.effects.lightSources, ...canvas.effects.darknessSources]) {
          light.object?.initializeLightSource?.();
        }
        canvas.perception.update({ initializeLighting: true, refreshLighting: true });
      }
    },
  });

  lastValue = isGuardEnabled();
}

/** Is this placeable's light configured as darkness? */
function isNegative(placeable) {
  const doc = placeable?.document;
  // AmbientLight keeps its light config on `config`; TokenDocument on `light`. The mixin is
  // applied to both object classes (`pf1/pf1.mjs:182-183`), and token light shares the
  // schema, so mobile darkness reaches here too.
  return (doc?.config?.negative ?? doc?.light?.negative) === true;
}

/**
 * Guard `getRadius` against negative lights.
 *
 * @remarks
 * Mixed **above** PF1's `LLVMixin` so our `getRadius` runs first and can decline to call
 * theirs at all. Overriding `_getLightSourceData` instead would mean either duplicating
 * their bookkeeping or undoing a multiplication after the fact; `getRadius` is the seam
 * that exists precisely for this, and it is public.
 *
 * Applied at `setup`: after PF1's `init` where the mixin is installed, and once, so the
 * class chain does not grow a link per canvas draw.
 */
export function applyMixin() {
  const Base = CONFIG.AmbientLight.objectClass;
  if (!Base || Base.pf1LightingNegativeGuard) return;

  const guard = (Class) =>
    class extends Class {
      static pf1LightingNegativeGuard = true;

      /** @override */
      getRadius(dim, bright) {
        if (isGuardEnabled() && isNegative(this)) return { dim, bright };
        return super.getRadius(dim, bright);
      }
    };

  CONFIG.AmbientLight.objectClass = guard(Base);

  // Token light shares the schema, so a token can carry a darkness source too.
  const TokenBase = CONFIG.Token.objectClass;
  if (TokenBase && !TokenBase.pf1LightingNegativeGuard) {
    CONFIG.Token.objectClass = guard(TokenBase);
  }
}
