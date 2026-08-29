/**
 * The public API. DESIGN.md §11.
 *
 * ## Separate from the console surface, on purpose
 *
 * `game.pf1Lighting.*` is a debug surface — it logs to `console.error`, gains and loses fields
 * whenever a diagnosis needs them, and several entries hand back live internal objects. A
 * consumer that binds to it will break, and should. `game.pf1Lighting.api` is the half that
 * promises not to, and {@link VERSION} is how a consumer feature-detects.
 *
 * ## What is here, and what is deliberately not
 *
 * > Expose a question only this module can answer, or an answer only this module can assemble
 * > cheaply. Everything else stays core's.
 *
 * Hamilcarbarcas's rule, and it decides most of the surface. Distance, wall collisions, ownership and
 * the raw `scene.environment.darknessLevel` are all core's and are absent. What is here is the
 * tier ladder (§3.1), the observer-relative answer (§4.3, §4.8), and the *assembly* — one call
 * that returns what a stealth check needs instead of nine.
 *
 * ## Arrays in, arrays out
 *
 * Every query takes a single subject or an array of them, and the return shape follows the
 * argument: an array in gives an array out, a scalar gives a scalar. That is one rule to
 * remember and it exists for a real reason rather than for ergonomics — `evaluate` reads the
 * field, and the field rebuilds when the registry version moves, so ten separate calls in a
 * stealth pass can pay for ten rebuilds where one call with ten subjects pays once.
 *
 * {@link perceive} is the exception and says so: it returns one record per (observer, observed)
 * pair, so an array on either side gives a flat array of records that each name both ends.
 */

import { MODULE_ID } from "./constants.mjs";
import { TIER, TIER_NAME } from "./model/tiers.mjs";
import { evaluate } from "./model/evaluate.mjs";
import * as perception from "./vision/perception.mjs";
import * as sceneConfig from "./ui/scene-config.mjs";

/**
 * Incremented on a **breaking** change only — a removed function, a changed return shape, or a
 * changed meaning. Added fields and new functions do not move it.
 */
export const VERSION = 1;

/** Fired after {@link setSceneTier} commits, and after any other write of the scene's tier. */
export const TIER_CHANGED_HOOK = `${MODULE_ID}.sceneTierChanged`;

/* -------------------------------------------- */
/*  Subjects                                    */
/* -------------------------------------------- */

const isArray = Array.isArray;
const many = (v) => (isArray(v) ? v : [v]);
const like = (input, results) => (isArray(input) ? results : results[0]);

/**
 * A placed `Token` from whatever a caller had to hand.
 *
 * @remarks
 * Three shapes reach this in practice and only one of them is the object the vision pipeline
 * needs: a `TokenDocument` (what a hook hands you), a `Token` (what the canvas holds), and an id.
 * Everything downstream wants the placeable, because that is what carries `vision` and
 * `_getVisionSourceData`.
 */
function tokenOf(subject) {
  if (!subject) return null;
  if (subject instanceof CONFIG.Token.objectClass) return subject;
  if (subject.object && subject.documentName === "Token") return subject.object;
  if (typeof subject === "string") return canvas?.tokens?.get(subject) ?? null;
  return subject.center ? subject : null;
}

/**
 * A `{x, y, elevation}` from a token, a token document, or a point.
 *
 * @remarks
 * Elevation is carried and then ignored by the model (§3.6). It is taken anyway so the signature
 * does not have to change on the day §3.6 does.
 */
function pointOf(subject) {
  const token = tokenOf(subject);
  if (token?.center) {
    return {
      x: token.center.x,
      y: token.center.y,
      elevation: token.document?.elevation ?? 0,
    };
  }
  if (Number.isFinite(subject?.x) && Number.isFinite(subject?.y)) {
    return { x: subject.x, y: subject.y, elevation: subject.elevation ?? 0 };
  }
  return null;
}

/* -------------------------------------------- */
/*  Sampling                                    */
/* -------------------------------------------- */

/**
 * How a subject that occupies more than a point resolves to one tier. DESIGN.md §11.3.
 *
 * @remarks
 * **`center` is the shared rule, and sharing it is the point** (Hamilcarbarcas, 2026-08-28: *"we should
 * determine a grid cell's light the same way we determine a token's light"*). A token and the
 * cell it stands in therefore agree by construction rather than by coincidence, and the answer
 * matches what the readout has always reported.
 *
 * `min` and `max` exist because the stealth case is genuinely asymmetric — a creature hides in
 * the darkest square it occupies and is spotted by the brightest — and a Large creature
 * straddling a boundary has no single tier to give. They are opt-in; nothing defaults to them.
 *
 * There is deliberately no `average`. Averaging tiers and re-thresholding produces a number that
 * matches no rule in the game, which is the objection that retired the word.
 */
const SAMPLE = Object.freeze({ CENTER: "center", MIN: "min", MAX: "max" });

/**
 * Every grid space a token occupies, as centre points.
 *
 * @remarks
 * **The bounds walk is the live path.** v13 has no `getOccupiedGridSpaceOffsets` — the optional
 * call is there because the concept keeps reappearing under that name and a version that adds it
 * knows about hex grids and odd token shapes, which this does not. Square grids are what PF1
 * plays on and what the walk is correct for; on a hex or gridless scene it approximates, and only
 * `min`/`max` sampling ever reaches it.
 */
function footprint(token) {
  const grid = canvas?.grid;
  const doc = token?.document;
  if (!grid || !doc) return [];

  const offsets = doc.getOccupiedGridSpaceOffsets?.();
  if (offsets?.length) {
    return offsets.map((offset) => {
      const { x, y } = grid.getCenterPoint(offset);
      return { x, y, elevation: doc.elevation ?? 0 };
    });
  }

  const b = token.bounds;
  const size = grid.size || 100;
  const points = [];
  for (let y = b.y + size / 2; y < b.y + b.height; y += size) {
    for (let x = b.x + size / 2; x < b.x + b.width; x += size) {
      points.push({ x, y, elevation: doc.elevation ?? 0 });
    }
  }
  return points.length ? points : [pointOf(token)].filter(Boolean);
}

/** The points one subject resolves to, under `sample`. */
function pointsFor(subject, sample) {
  if (sample === SAMPLE.CENTER) {
    const point = pointOf(subject);
    return point ? [point] : [];
  }
  const token = tokenOf(subject);
  if (!token?.document) {
    const point = pointOf(subject);
    return point ? [point] : [];
  }
  const points = footprint(token);
  return points.length ? points : [pointOf(token)].filter(Boolean);
}

/** Fold several sampled tiers into the one the caller asked for. */
function fold(tiers, sample) {
  if (!tiers.length) return TIER.DARK;
  if (sample === SAMPLE.MIN) return Math.min(...tiers);
  if (sample === SAMPLE.MAX) return Math.max(...tiers);
  return tiers[0];
}

/* -------------------------------------------- */
/*  Vision sources                              */
/* -------------------------------------------- */

/**
 * A usable `PointVisionSource` for a token, building a throwaway one if the canvas has none.
 *
 * @remarks
 * **The problem this exists for.** `Token#initializeVisionSource` calls `#destroyVisionSource()`
 * whenever `_isVisionSource()` is false (`placeables/token.mjs:868-880`), which is every token
 * the current user does not own or control. For a stealth check the interesting observers are
 * exactly those, so `token.vision` is `undefined` precisely when the question is worth asking.
 *
 * **Building one is safe because registration is a separate call.** Core does
 * `new CONFIG.Canvas.visionSourceClass(...)`, `initialize(...)`, then **`add()`**
 * (`token.mjs:884-892`), and only that last step puts it in `canvas.effects.visionSources`. We
 * never call it, so nothing on the canvas sees this source and nothing has to be cleaned up
 * beyond the object itself.
 *
 * **The blinded states are copied first**, as core does, because `isBlinded` gates `basicSight`
 * and `lightPerception` in the visibility loop and a source initialised without them would
 * report a blinded creature as sighted.
 *
 * **It costs a polygon sweep** — the expensive operation in this module (§9.6). Affordable once
 * per die roll for a scene's worth of NPCs; not affordable on a hook that fires during movement.
 * The API says so rather than hiding it behind a cache that would go stale on the first wall.
 *
 * @param {Token} token
 * @returns {{source: object|null, dispose: () => void}}
 */
function visionSourceFor(token) {
  const live = token?.vision;
  if (live) return { source: live, dispose: () => {} };

  const cls = CONFIG.Canvas.visionSourceClass;
  if (!cls || !token?._getVisionSourceData) return { source: null, dispose: () => {} };

  let source = null;
  try {
    source = new cls({ sourceId: `${MODULE_ID}.probe.${token.id}`, object: token });
    const blinded = token._getVisionBlindedStates?.() ?? {};
    for (const state in blinded) source.blinded[state] = blinded[state];
    source.initialize(token._getVisionSourceData());
  } catch (error) {
    console.error(`${MODULE_ID} | could not build a vision source for ${token?.name}`, error);
    try {
      source?.destroy?.();
    } catch {
      /* already gone */
    }
    return { source: null, dispose: () => {} };
  }

  return {
    source,
    dispose: () => {
      try {
        source.destroy?.();
      } catch {
        /* PIXI teardown, nothing to salvage */
      }
    },
  };
}

/* -------------------------------------------- */
/*  Brightness                                  */
/* -------------------------------------------- */

/**
 * The light tier at one or more points.
 *
 * @remarks
 * **`observer` decides which of two questions this is**, and they are genuinely different
 * answers rather than a default and a refinement. Omitted, the answer is god's eye: the model's
 * own tier, what a GM sees, what the readout reports. Given a token, the answer is clamped by
 * any umbra between that token and the point (§4.3) — so a lit room seen through a *darkness*
 * reports the darkness's tier, which is what that creature can actually see by.
 *
 * @param {object|object[]} points - `{x, y, elevation?}`, a Token, or a TokenDocument
 * @param {object} [options]
 * @param {Token|TokenDocument|null} [options.observer]
 * @returns {number|number[]} A {@link TIER} value per input
 */
export function brightnessAt(points, { observer = null } = {}) {
  const list = many(points);
  const obs = observer ? visionSourceFor(tokenOf(observer)) : null;
  try {
    const out = list.map((subject) => {
      const point = pointOf(subject);
      if (!point) return TIER.DARK;
      if (!obs?.source) return evaluate(point).tier;
      return perception.withObserver(obs.source, () =>
        perception.perceivedTier(point, obs.source)
      );
    });
    return like(points, out);
  } finally {
    obs?.dispose();
  }
}

/**
 * The light tier a token is standing in.
 *
 * @param {Token|TokenDocument|(Token|TokenDocument)[]} tokens
 * @param {object} [options]
 * @param {Token|TokenDocument|null} [options.observer]
 * @param {"center"|"min"|"max"} [options.sample="center"] - See {@link SAMPLE}
 * @returns {number|number[]}
 */
export function brightnessOf(tokens, { observer = null, sample = SAMPLE.CENTER } = {}) {
  const list = many(tokens);
  const obs = observer ? visionSourceFor(tokenOf(observer)) : null;
  try {
    const out = list.map((subject) => {
      const points = pointsFor(subject, sample);
      if (!points.length) return TIER.DARK;
      const tiers = points.map((point) =>
        obs?.source
          ? perception.withObserver(obs.source, () =>
              perception.perceivedTier(point, obs.source)
            )
          : evaluate(point).tier
      );
      return fold(tiers, sample);
    });
    return like(tokens, out);
  } finally {
    obs?.dispose();
  }
}

/**
 * The light tier of the grid space containing a point.
 *
 * @remarks
 * The **same rule a token gets** — the space's centre — so a token and the square it stands in
 * cannot disagree. That is the whole reason this is a separate function rather than the caller
 * snapping a point themselves and calling {@link brightnessAt}: the snapping rule is ours to
 * keep consistent.
 *
 * @param {object|object[]} points
 * @param {object} [options]
 * @param {Token|TokenDocument|null} [options.observer]
 * @returns {number|number[]}
 */
export function brightnessInSquare(points, { observer = null } = {}) {
  const list = many(points);
  const centres = list.map((subject) => {
    const point = pointOf(subject);
    if (!point || !canvas?.grid) return point;
    const centre = canvas.grid.getCenterPoint(point);
    return { x: centre.x, y: centre.y, elevation: point.elevation };
  });
  const out = brightnessAt(centres, { observer });
  return like(points, many(out));
}

/* -------------------------------------------- */
/*  Perception                                  */
/* -------------------------------------------- */

/**
 * Detection modes that do not consult light at all.
 *
 * @remarks
 * The field a stealth pass actually branches on: for these observers the light tier is
 * irrelevant, so a hider in pitch darkness is no better off than one in daylight. Derived from
 * the mode id rather than detected, because there is nothing on a `DetectionMode` that declares
 * it — `basicSight` is where PF1 puts darkvision, and blindsight rides in on the same mode
 * (`pf1/module/documents/token.mjs:205-213`).
 *
 * An unregistered id answers `null` rather than `false`, so a consumer can tell *"this sense
 * ignores light"* from *"we have never heard of this sense"*. Use
 * {@link registerLightIndependentMode} to add one.
 */
const LIGHT_INDEPENDENT = new Set(["basicSight", "blindSight", "feelTremor"]);
const LIGHT_DEPENDENT = new Set(["lightPerception", "seeInvisibility", "visionLight"]);

/** Teach {@link perceive} that a mode ignores light. */
export function registerLightIndependentMode(id) {
  if (id) LIGHT_INDEPENDENT.add(id);
  return [...LIGHT_INDEPENDENT];
}

function lightIndependenceOf(id) {
  if (!id) return null;
  if (LIGHT_INDEPENDENT.has(id)) return true;
  if (LIGHT_DEPENDENT.has(id)) return false;
  return null;
}

/**
 * Every detection mode that can see `observed` from `source`, in core's own order.
 *
 * @remarks
 * **Core will not answer this and the workaround is not a reimplementation.**
 * `CanvasVisibility#testVisibility` short-circuits on the first mode that returns true
 * (`groups/visibility.mjs:735-792`) and gives back a boolean. But every mode is reached through a
 * *public* per-mode entry point, and the argument is built by a method we can call —
 * so running the same loop without the short circuit keeps every rule inside core's mode
 * instances. That is what makes this compose with PF1's replaced `seeInvisibility` and with
 * `limits`' wrap of `_testPoint`; a hand-written range-and-light test would silently drop both.
 *
 * Three details that are easy to miss, each of which changes an answer:
 *
 * - **A vision-granting light is a fourth route**, tested before any mode
 *   (`visibility.mjs:745-749`). It has no mode id and no observer — `lightSource.testVisibility`
 *   takes only the config — so it reveals to everyone equally. Reported as `"visionLight"`.
 * - **`isBlinded` gates `basicSight` and `lightPerception` but not the special modes.** A blinded
 *   creature still feels tremors.
 * - **`testVisibility` mutates the target**, assigning `object.detectionFilter` when a special
 *   mode wins (`visibility.mjs:788`). Saved and restored here, or a probe leaves a rendering
 *   artefact on a token nobody looked at.
 */
function modesSeeing(source, observed, point) {
  const found = [];
  const visibility = canvas?.visibility;
  if (!visibility?._createVisibilityTestConfig) return found;

  const config = visibility._createVisibilityTestConfig(point, { object: observed });
  const modes = CONFIG.Canvas.detectionModes ?? {};
  const doc = source?.object?.document;

  const savedFilter = observed?.detectionFilter;
  try {
    for (const lightSource of canvas?.effects?.lightSources?.values() ?? []) {
      if (!lightSource.data?.vision || !lightSource.active) continue;
      if (lightSource.testVisibility?.(config) === true) {
        found.push("visionLight");
        break;
      }
    }

    if (source && doc) {
      const run = (id) => {
        const mode = doc.detectionModes?.find((m) => m.id === id);
        if (!mode || !mode.enabled) return;
        const impl = modes[id];
        if (!impl) return;
        const seen = perception.withObserver(source, () =>
          impl.testVisibility(source, mode, config)
        );
        if (seen === true) found.push(id);
      };

      if (!source.isBlinded) {
        run("basicSight");
        run("lightPerception");
      }
      if (observed instanceof CONFIG.Token.objectClass) {
        for (const mode of doc.detectionModes ?? []) {
          if (mode.id === "basicSight" || mode.id === "lightPerception") continue;
          run(mode.id);
        }
      }
    }
  } finally {
    if (observed) observed.detectionFilter = savedFilter;
  }

  return found;
}

/**
 * What one observer can tell about one target.
 *
 * @remarks
 * Takes arrays on either side and returns **one record per pair**, which is the one place this
 * API does not follow "scalar in, scalar out": a matrix has no scalar shape. Each record names
 * both ends, so a flat list is unambiguous and a caller can group it however it likes. Both
 * arguments scalar gives a single record rather than an array of one.
 *
 * `distance` is bundled because every consumer of this recomputes it — a Perception DC rises
 * with it, and it is the term a caller needs to sort by. `losBlocked` likewise: a target hidden
 * behind a wall and a target hidden by darkness need different rulings, and `visible: false`
 * alone cannot tell them apart.
 *
 * **This costs a polygon sweep per observer that has no live vision source.** See
 * {@link visionSourceFor}. Ask it on a die roll, not on a movement hook.
 *
 * @param {Token|TokenDocument|(Token|TokenDocument)[]} observers
 * @param {Token|TokenDocument|(Token|TokenDocument)[]} observed
 * @param {object} [options]
 * @param {"center"|"min"|"max"} [options.sample="center"]
 * @returns {object|object[]}
 */
export function perceive(observers, observed, { sample = SAMPLE.CENTER } = {}) {
  const obsList = many(observers).map(tokenOf).filter(Boolean);
  const targetList = many(observed).map(tokenOf).filter(Boolean);
  const out = [];

  for (const observer of obsList) {
    const { source, dispose } = visionSourceFor(observer);
    try {
      for (const target of targetList) {
        out.push(record(observer, source, target, sample));
      }
    } finally {
      dispose();
    }
  }

  const single = !isArray(observers) && !isArray(observed);
  return single ? (out[0] ?? null) : out;
}

function record(observer, source, target, sample) {
  const point = pointOf(target);
  const reasons = point ? modesSeeing(source, target, point) : [];
  const reason = reasons[0] ?? null;

  const tier = point
    ? fold(
        pointsFor(target, sample).map((p) =>
          source
            ? perception.withObserver(source, () => perception.perceivedTier(p, source))
            : evaluate(p).tier
        ),
        sample
      )
    : TIER.DARK;

  const from = pointOf(observer);
  const distance =
    from && point
      ? canvas?.grid?.measurePath?.([from, point])?.distance ??
        Math.hypot(point.x - from.x, point.y - from.y) /
          (canvas?.dimensions?.distancePixels ?? 1)
      : null;

  return {
    observer,
    observed: target,
    visible: reasons.length > 0,
    reason,
    reasons,
    tier,
    tierName: TIER_NAME[tier],
    lightIndependent: lightIndependenceOf(reason),
    blinded: source?.isBlinded === true,
    distance: distance === null ? null : +distance.toFixed(2),
    losBlocked:
      from && point
        ? CONFIG.Canvas.polygonBackends.sight.testCollision(from, point, {
            type: "sight",
            mode: "any",
          }) === true
        : null,
    // No live vision source means this observer is not one the canvas is currently drawing for,
    // so the answer came from a source built for the question. Worth reporting: it is also the
    // expensive path.
    ephemeral: !observer?.vision,
  };
}

/**
 * Who can see this token, and how. The stealth call.
 *
 * @remarks
 * One field build and one sweep per candidate, rather than N calls each paying for both.
 * `observers` defaults to every other token on the scene that has sight at all — the caller
 * narrows it, because which NPCs are *entitled* to notice is a table question and not ours.
 *
 * Sorted so the ones that can see come first, brightest perception first within that, because
 * the caller's next step is almost always to partition this list.
 *
 * @param {Token|TokenDocument} observed
 * @param {object} [options]
 * @param {(Token|TokenDocument)[]} [options.observers]
 * @param {"center"|"min"|"max"} [options.sample="center"] - `"min"` is the hider's rule
 * @returns {object[]}
 */
export function perceivedBy(observed, { observers, sample = SAMPLE.CENTER } = {}) {
  const target = tokenOf(observed);
  if (!target) return [];

  const candidates = (observers ? many(observers).map(tokenOf) : canvas?.tokens?.placeables ?? [])
    .filter(Boolean)
    .filter((token) => token !== target && token.document?.sight?.enabled !== false);

  const results = perceive(candidates, target, { sample });
  return many(results).sort(
    (a, b) => Number(b.visible) - Number(a.visible) || b.tier - a.tier
  );
}

/* -------------------------------------------- */
/*  The scene                                   */
/* -------------------------------------------- */

/**
 * The scene's own light level, as a tier.
 *
 * @remarks
 * From `flags.pf1-lighting.tier` where the scene has been set through this module, and from the
 * nearest rung to its stored darkness where it has not (§10.5.1). A caller cannot tell the two
 * apart from here, and does not need to — both are the answer to *what light level is this
 * scene*.
 */
export function sceneTier(scene = canvas?.scene) {
  const stored = sceneConfig.tierOf(scene);
  if (stored !== null) return stored;
  return sceneConfig.nearestTier(scene);
}

/**
 * Set the scene's light level. GM only, and **refused on a darkness-locked scene**.
 *
 * @remarks
 * The lock is core's own control and it already means exactly this — Hamilcarbarcas, 2026-08-28:
 * *"There's already a darkness level lock in scene config. Can we use this for preventing the
 * api from changing scene brightness?"* It does, and has since §10.5.2:
 * `Scene#_preUpdate` silently *deletes* `environment.darknessLevel` from an update when the lock
 * is set (`documents/scene.mjs:416-419`), so writing anyway would report success and change
 * nothing. `setSceneTier` checks first and returns `null`.
 *
 * That makes the lock the natural filter for a time-of-day driver, with one consequence worth
 * knowing: it means *frozen*, not *not clock-driven*. A locked dungeon cannot be changed by a GM
 * from the dropdown either. If a scene ever needs to be hand-settable but ignored by the clock,
 * that is a second flag and it does not exist yet.
 *
 * @param {number} tier - A {@link TIER} value the ambient can hold
 * @param {Scene} [scene=canvas.scene]
 * @returns {Promise<number|null>} The tier set, or null if nothing was written
 */
export function setSceneTier(tier, scene = canvas?.scene) {
  return sceneConfig.setSceneTier(tier, scene);
}

/* -------------------------------------------- */

/** @type {object|null} Built once; both addresses hand back the same object. */
let surface = null;

/**
 * The frozen object handed to consumers.
 *
 * @remarks
 * **Memoised, because it is published at two addresses and they must not drift.**
 * `game.modules.get("pf1-lighting").api` is the one another module should use — it is Foundry's
 * convention, it is what this project's own modules already publish and consume, and a module id
 * containing a hyphen can only be reached through a string key anyway. `game.pf1Lighting.api` is
 * a console alias for the same object, and exists because `pf1-lighting.api` is not typeable:
 * the hyphen is a minus sign, so it parses as `pf1 - lighting.api`.
 */
export function build() {
  return (surface ??= Object.freeze({
    version: VERSION,
    TIER: Object.freeze({ ...TIER }),
    tierName: (tier) => TIER_NAME[tier] ?? null,
    SAMPLE,
    TIER_CHANGED_HOOK,

    brightnessAt,
    brightnessOf,
    brightnessInSquare,

    perceive,
    perceivedBy,
    registerLightIndependentMode,

    sceneTier,
    setSceneTier,
  }));
}

/**
 * Publish at the address other modules will actually look at.
 *
 * @remarks
 * **At `init`, and the timing is the point.** `game.pf1Lighting` is assigned in `ready`, which is
 * too late to be an API: a consumer's own `ready` hook races ours on registration order, so
 * whether the API exists depends on module load order rather than on anything either module did.
 * `.api` set here is visible to every consumer's `setup` and `ready` alike.
 *
 * Nothing in {@link build} touches the canvas or reads a setting — the entries are function
 * references and frozen constants — so there is nothing for `init` to be too early for.
 */
export function publish() {
  const mod = game.modules?.get(MODULE_ID);
  if (mod) mod.api = build();
  return mod?.api ?? null;
}
