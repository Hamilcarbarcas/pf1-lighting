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
 *
 * §4.4c is the other half of the rule and the first thing here that is not a guard: ambient dim
 * light reads as normal light. See {@link isActive} for the client question it turns on, and
 * `model/registry.lowLightAmbient` for the rule itself.
 */

import { MODULE_ID } from "../constants.mjs";
import { flag } from "../settings-cache.mjs";
import { isSightless } from "./sightless.mjs";

export const SETTING_LLV_GUARD = "guardNegativeLowLight";
export const SETTING_LLV_AMBIENT = "lowLightAmbient";

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

  game.settings.register(MODULE_ID, SETTING_LLV_AMBIENT, {
    name: "Low-light vision sees ambient dim light as normal",
    hint:
      "A creature with low-light vision reads ambient dim light — a moonlit night, dusk — as " +
      "normal light. Ambient only: a torch's dim ring is left alone, PF1 having already doubled " +
      "its radius for the same creature.",
    scope: "world",
    // No control surface, on the `guardNegativeLowLight` precedent (§10.6): a bisection aid rather
    // than a GM decision. Reachable from the console — see `game.pf1Lighting.settings`.
    config: false,
    type: Boolean,
    default: true,
    onChange: () => {
      invalidate();
      // Kept in step with the repaint below, or the next `controlToken` compares against an answer
      // this switch has already invalidated and decides there is nothing to do.
      painted = isActive();
      refresh();
    },
  });

  lastValue = isGuardEnabled();
}

/* -------------------------------------------- */
/*  §4.4c — is low-light vision in play here?   */
/* -------------------------------------------- */

/**
 * The minimal shape PF1's `getRadius` reads off `this`.
 *
 * @remarks
 * `getRadius` (`low-light-vision.mjs:66-114`) touches exactly two things on the instance:
 * `this.document.getFlag("pf1", "disableLowLight")` and `this.object?.document`. Everything else it
 * consults is global — the two world settings, `canvas.tokens.placeables`, `game.user.isGM`. So a
 * stub with a `getFlag` and no `object` is enough to ask the question, and the answer is PF1's own.
 *
 * The guard this file mixes in front of it reads `document.config?.negative` /
 * `document.light?.negative`; both are absent here, so the stub is not mistaken for a darkness and
 * the call falls through to `super`.
 */
const PROBE_STUB = Object.freeze({ document: { getFlag: () => false } });

/** @type {boolean|null} One frame's answer; `null` means not yet asked. */
let activeMemo = null;
let memoScheduled = false;

/**
 * Ask PF1 whether its low-light multiplier is in play for this client.
 *
 * @remarks
 * A probe rather than a reimplementation, and that is the whole point. `getRadius`'s observer
 * selection is not one rule but four interlocking ones — GM or the `lowLightVisionMode` setting
 * requires *every* observed token to have low-light vision, a player on the default needs only one,
 * `systemVision` switches the feature off wholesale, and a token flagged `customVisionRules` opts
 * out (`low-light-vision.mjs:72-107`). Copying that here would put a second copy of it in the world,
 * and the two disagreeing is invisible: the map would double a torch's radius and not lift the
 * moonlight, or the reverse, with nothing on screen naming the cause.
 *
 * The field already depends on PF1's answer — `ramp.emissionOf` builds every emitter from
 * `source.data.bright`/`dim`, which the mixin has already scaled per client (§4.4a). So this is not
 * importing a per-client term into a god's-eye model; it is asking the same question the model's own
 * radii are already answers to.
 *
 * Throwing is treated as "no". If PF1 ever starts reading something else off the instance, the stub
 * fails loudly here rather than quietly returning a wrong `true`, and the fallback is the behaviour
 * that existed before this section.
 *
 * @returns {boolean}
 */
function probe() {
  const getRadius = CONFIG.AmbientLight?.objectClass?.prototype?.getRadius;
  if (typeof getRadius !== "function") return false;
  try {
    // Unit radii in, so the result *is* the multiplier. Both, because PF1 carries two independent
    // ones and this asks about the faculty rather than about a distance — an actor with a bright
    // multiplier and no dim one still has low-light vision.
    const { dim, bright } = getRadius.call(PROBE_STUB, 1, 1) ?? {};
    return Math.max(Number(dim) || 0, Number(bright) || 0) > 1;
  } catch {
    return false;
  }
}

/**
 * Is low-light vision in play for this client? DESIGN.md §4.4c.
 *
 * @remarks
 * Memoised for one animation frame, the rule `vision/perception.mjs` uses and correct for the same
 * reason: nothing the probe reads can change within a frame, so a stale entry cannot outlive the
 * frame that made it. `probe` walks `canvas.tokens.placeables`, so this is not free enough to call
 * per test point — `evaluate()` asks it only after the cheaper tests have passed.
 */
export function isActive() {
  if (!flag(SETTING_LLV_AMBIENT, true)) return false;
  if (activeMemo === null) {
    activeMemo = probe();
    if (!memoScheduled) {
      memoScheduled = true;
      requestAnimationFrame(() => {
        memoScheduled = false;
        activeMemo = null;
      });
    }
  }
  return activeMemo;
}

/** Drop the memo now. For hooks, settings changes and console pokes. */
export function invalidate() {
  activeMemo = null;
}

/** Repaint, so a change of answer shows up without waiting for something else to move. */
function refresh() {
  if (!canvas?.ready) return;
  canvas.perception.update({ initializeLighting: true, refreshLighting: true, refreshVision: true });
}

/** The answer as of the last repaint, so {@link registerHooks} can tell a change from a no-op. */
let painted = null;

export function registerHooks() {
  // Selection is half of PF1's rule, so controlling a token can change the answer with nothing else
  // on the scene moving. PF1 answers the same event with `debouncedLightSourceReInit`, which
  // reinitialises every light and so restales the field on its own — but only on a scene that *has*
  // lights, and a moonlit field with none is exactly where this section does its work.
  //
  // Repaint only when the answer actually moved. `controlToken` fires on deselect as well as select
  // and once per token in a marquee, and an unconditional perception update per token is the shape
  // of cost §9.5 exists to avoid.
  const settle = foundry.utils.debounce(() => {
    invalidate();
    const next = isActive();
    if (next === painted) return;
    painted = next;
    refresh();
  }, 50);

  Hooks.on("controlToken", settle);
  Hooks.on("canvasReady", () => {
    invalidate();
    painted = isActive();
  });
}

/**
 * Why the ambient is or is not being lifted. For the console.
 *
 * @remarks
 * The switch being on is not the same as it having anything to do, and on screen the two look
 * identical — the §10.6 lesson, reported once per feature that skipped it.
 */
export function status() {
  const report = {
    enabled: flag(SETTING_LLV_AMBIENT, true),
    // PF1's own answer, uncached, so a stale memo cannot be what is being reported.
    active: probe(),
    // The three globals `getRadius` decides on, spelled out: a `false` here is the reason.
    systemVision: (() => {
      try {
        return game.settings.get("pf1", "systemVision");
      } catch {
        return null;
      }
    })(),
    requiresSelection: (() => {
      try {
        return game.user.isGM || game.settings.get("pf1", "lowLightVisionMode") === true;
      } catch {
        return null;
      }
    })(),
    controlled: canvas?.tokens?.controlled?.map((t) => t.name) ?? [],
    lowLightControlled:
      canvas?.tokens?.controlled?.filter((t) => t.actorVision?.lowLight === true).map((t) => t.name) ??
      [],
  };
  console.error("PF1 Lighting | low-light ambient", report);
  return report;
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
