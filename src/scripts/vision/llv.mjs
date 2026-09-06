/**
 * Low-light vision must not enlarge darkness. DESIGN.md §4.4.
 *
 * PF1 multiplies a light's `dim` and `bright` radii by the observer's low-light multiplier in
 * `LLVMixin.getRadius()` (`pf1/module/canvas/low-light-vision.mjs:66-114`), applied to the
 * placeable via `_getLightSourceData()` rather than to the source (`pf1/pf1.mjs:182-183`). A
 * darkness source is an AmbientLight with `negative: true` (§3.5) taking the same path, so it gets
 * doubled too. Confirmed live 2026-08-22.
 *
 * Ships ahead of the rest of §4.4 for instrumentation, not correctness — low-light vision is
 * unimplemented, so nothing depends on it yet. Every darkness on the scene is otherwise a
 * different size from its own document, making every geometry observation a measurement against a
 * scene that does not match its data. Same failure mode as native suppression path 3 (§4.1.1),
 * which cost several rounds of diagnosing a rules bug that was really a geometry one.
 *
 * Low-light vision should enlarge light and never darkness: the rules extend how far a creature
 * can use a light source and say nothing about how far a darkness spell reaches — a property of
 * the spell, not the eye.
 *
 * The same sentence has a second half, added 2026-09-05 (§4.4b): it can only *enlarge*. PF1 takes
 * the multiplier from the sheet unvalidated, so an actor with low-light enabled and a multiplier of
 * 0 zeroes every light on the scene — and, via the `Math.min` across controlled tokens, for everyone
 * standing with them. See {@link applyMixin}'s `getRadius`.
 */

import { MODULE_ID } from "../constants.mjs";
import { isSightless } from "./sightless.mjs";

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
    // No control surface (2026-08-26): the switch was a development bisection aid.
    // Functionality stays, reachable from the console — see `game.pf1Lighting.settings`.
    config: false,
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
  // AmbientLight keeps its light config on `config`, TokenDocument on `light`. The mixin applies
  // to both object classes (`pf1/pf1.mjs:182-183`) and token light shares the schema, so mobile
  // darkness reaches here too.
  return (doc?.config?.negative ?? doc?.light?.negative) === true;
}

/**
 * Guard `getRadius` against negative lights.
 *
 * @remarks
 * Mixed above PF1's `LLVMixin` so this `getRadius` runs first and can decline to call theirs at
 * all. Overriding `_getLightSourceData` instead would mean duplicating their bookkeeping or
 * undoing a multiplication after the fact; `getRadius` is the public seam for exactly this.
 *
 * Applied at `setup` — after PF1's `init` installs the mixin, and once, so the class chain does
 * not grow a link per canvas draw.
 */
export function applyMixin() {
  const Base = CONFIG.AmbientLight.objectClass;
  if (!Base || Base.pf1LightingNegativeGuard) return;

  const guard = (Class) =>
    class extends Class {
      static pf1LightingNegativeGuard = true;

      /**
       * @override
       * Low-light vision is sight, so a Sightless creature does not have it (§4.5.4).
       *
       * @remarks
       * `TokenPF#actorVision` (`pf1/module/canvas/token.mjs:2-9`) is the only thing PF1's observer
       * selection reads — `getRadius` filters on `actorVision.lowLight`
       * (`low-light-vision.mjs:93`) — so denying it here removes the creature from the multiplier
       * without touching the selection logic.
       *
       * Only meaningful on the token class; the `AmbientLight` half of this mixin has no `actor`
       * and inherits nothing to override, so `super.actorVision` is undefined there and the guard
       * never fires.
       */
      get actorVision() {
        const vision = super.actorVision;
        if (!vision || !isSightless(this.actor)) return vision;
        return { ...vision, lowLight: false };
      }

      /** @override */
      getRadius(dim, bright) {
        if (isGuardEnabled() && isNegative(this)) return { dim, bright };

        const result = super.getRadius(dim, bright);

        // Low-light vision extends a light and can only extend it. A multiplier below 1 shrinks
        // every light on the scene, and 0 extinguishes them all — which does not read as a bad
        // number on one sheet, it reads as the selected creature having gone blind. Found
        // 2026-09-05 on an actor whose `ll.multiplier` was 0/0 with low-light enabled: the map went
        // black for that observer and the vision layer, which was working perfectly, took the
        // blame.
        //
        // PF1 takes a `Math.min` across the controlled tokens (`low-light-vision.mjs:96-101`), so
        // one actor carrying a 0 is enough to zero the scene for a whole party. Its own template
        // default is 2 (`template.json:689`); anything under 1 is data, not intent.
        //
        // Not gated on `guardNegativeLowLight`, which names the darkness rule and not this one.
        // A switch whose label describes one behaviour must not silently carry a second.
        return {
          dim: Math.max(result?.dim ?? 0, dim),
          bright: Math.max(result?.bright ?? 0, bright),
        };
      }
    };

  CONFIG.AmbientLight.objectClass = guard(Base);

  // Token light shares the schema, so a token can carry a darkness source too.
  const TokenBase = CONFIG.Token.objectClass;
  if (TokenBase && !TokenBase.pf1LightingNegativeGuard) {
    CONFIG.Token.objectClass = guard(TokenBase);
  }
}
