/**
 * The public API. DESIGN.md §11.
 *
 * Distinct from `game.pf1Lighting.*`, a debug surface that changes shape without notice. This half
 * is stable; {@link VERSION} moves on a breaking change.
 *
 * Scalar in, scalar out; array in, array out. Batch where possible — the field rebuilds when the
 * registry version moves, so ten calls can pay for ten rebuilds where one call with ten subjects
 * pays once. {@link perceive} is the exception: one record per (observer, observed) pair.
 */

import { MODULE_ID } from "./constants.mjs";
import { TIER, TIER_NAME } from "./model/tiers.mjs";
import { evaluate } from "./model/evaluate.mjs";
import * as perception from "./vision/perception.mjs";
import * as sceneConfig from "./ui/scene-config.mjs";

/**
 * Breaking changes only: a removed function, a changed return shape, a changed meaning. Added
 * fields and new functions do not move it.
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
 * A placed `Token` from whatever a caller had to hand: `TokenDocument`, `Token`, or id.
 *
 * @remarks
 * Only the placeable carries `vision` and `_getVisionSourceData`, which the vision pipeline needs.
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
 * Elevation is carried but ignored by the model (§3.6); taken anyway so the signature survives
 * §3.6 changing.
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
 * `center` is shared with grid cells (2026-08-28), so a token and its square always agree, and
 * both match the readout.
 *
 * `min`/`max` are opt-in, for the asymmetric stealth case: a creature hides in the darkest square
 * it occupies and is spotted by the brightest. No `average` — averaging tiers and re-thresholding
 * matches no rule in the game.
 */
const SAMPLE = Object.freeze({ CENTER: "center", MIN: "min", MAX: "max" });

/**
 * Every grid space a token occupies, as centre points.
 *
 * @remarks
 * The bounds walk is the live path; v13 has no `getOccupiedGridSpaceOffsets`. The optional call
 * is there because a version that adds it would handle hex grids and odd token shapes, which the
 * walk does not — on hex or gridless scenes it approximates. Only `min`/`max` sampling reaches it.
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
 * `token.vision` is `undefined` for every token the user neither owns nor controls
 * (`placeables/token.mjs:868-880`) — exactly the interesting observers for a stealth check.
 *
 * Building one is safe because registration is separate: core does `new
 * CONFIG.Canvas.visionSourceClass(...)`, `initialize(...)`, then `add()` (`token.mjs:884-892`), and
 * only `add()` reaches `canvas.effects.visionSources`. Skipping it leaves nothing to clean up
 * beyond the object.
 *
 * Blinded states are copied first, as core does: `isBlinded` gates `basicSight` and
 * `lightPerception`, and a source without them reports a blinded creature as sighted.
 *
 * Costs a polygon sweep, the expensive operation in this module (§9.6) — once per die roll, not on
 * a movement hook. A cache would go stale on the first wall.
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
 * `observer` selects between two different questions, not a default and a refinement. Omitted:
 * god's eye — the model's own tier, what a GM sees, what the readout reports. Given a token:
 * clamped by any umbra between token and point (§4.3), so a lit room seen through a darkness
 * reports the darkness's tier.
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
 * The space's centre, the same rule a token gets, so the two cannot disagree. A separate function
 * rather than caller-side snapping keeps that rule in one place.
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
 * The field a stealth pass branches on: for these observers the tier is irrelevant, so a hider in
 * pitch darkness is no better off than one in daylight. Keyed by mode id because nothing on a
 * `DetectionMode` declares it — PF1 puts darkvision on `basicSight`, and blindsight rides the same
 * mode (`pf1/module/documents/token.mjs:205-213`).
 *
 * Unregistered ids answer `null`, not `false`, separating "ignores light" from "unknown here".
 * {@link registerLightIndependentMode} adds one.
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
 * Not a reimplementation. `CanvasVisibility#testVisibility` short-circuits on the first mode
 * returning true (`groups/visibility.mjs:735-792`) and yields a boolean, but every mode has a
 * public per-mode entry point and its argument comes from a callable method — so the same loop
 * without the short circuit keeps every rule inside core's mode instances. That is what composes
 * with PF1's replaced `seeInvisibility` and `limits`' wrap of `_testPoint`; a hand-written
 * range-and-light test would drop both silently.
 *
 * Three details, each of which changes an answer:
 *
 * - A vision-granting light is a fourth route, tested before any mode
 *   (`visibility.mjs:745-749`). No mode id, no observer — `lightSource.testVisibility` takes only
 *   the config — so it reveals to everyone equally. Reported as `"visionLight"`.
 * - `isBlinded` gates `basicSight` and `lightPerception` but not the special modes; a blinded
 *   creature still feels tremors.
 * - `testVisibility` mutates the target, assigning `object.detectionFilter` when a special mode
 *   wins (`visibility.mjs:788`). Saved and restored here, or a probe leaves a rendering artefact
 *   on an unexamined token.
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
 * One record per pair — the one departure from scalar-in, scalar-out, since a matrix has no scalar
 * shape. Each record names both ends, so a flat list stays unambiguous. Two scalar arguments give
 * a single record, not an array of one.
 *
 * `distance` is bundled because every consumer recomputes it; a Perception DC rises with it.
 * `losBlocked` likewise — hidden behind a wall and hidden by darkness need different rulings, and
 * `visible: false` cannot separate them.
 *
 * Costs a polygon sweep per observer with no live vision source ({@link visionSourceFor}).
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
    // No live vision source: the canvas is not drawing for this observer, so the answer came from
    // a source built for the question. The expensive path.
    ephemeral: !observer?.vision,
  };
}

/**
 * Who can see this token, and how. The stealth call.
 *
 * @remarks
 * One field build and one sweep per candidate, rather than N calls paying for both each time.
 * `observers` defaults to every other token on the scene with sight enabled; narrowing it is the
 * caller's, since which NPCs are entitled to notice is a table question.
 *
 * Sorted seers first, brightest perception first within that — the next step is almost always to
 * partition the list.
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
 * From `flags.pf1-lighting.tier` where the scene was set through this module, otherwise the
 * nearest rung to its stored darkness (§10.5.1). Both answer the same question; callers need not
 * tell them apart.
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
 * Reuses core's darkness-level lock, which already carries this meaning (2026-08-28, §10.5.2):
 * `Scene#_preUpdate` silently deletes `environment.darknessLevel` from a locked scene's update
 * (`documents/scene.mjs:416-419`), so writing anyway reports success and changes nothing. Checked
 * up front instead; returns `null`.
 *
 * Also the natural filter for a time-of-day driver, with one consequence: the lock means frozen,
 * not merely not-clock-driven. A locked dungeon resists the GM's dropdown too. Hand-settable but
 * clock-ignored would need a second flag; none exists.
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
 * Memoised: published at two addresses, which must not drift.
 * `game.modules.get("pf1-lighting").api` is Foundry's convention and what other modules should
 * use. `game.pf1Lighting.api` is a console alias for the same object, since `pf1-lighting.api` is
 * not typeable — the hyphen parses as a minus sign.
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
 * At `init`, and the timing is the point. `game.pf1Lighting` is assigned in `ready`, too late: a
 * consumer's own `ready` hook races it on registration order, making the API's existence depend on
 * module load order. Set here, `.api` is visible to every consumer's `setup` and `ready` alike.
 *
 * {@link build} touches neither canvas nor settings — function references and frozen constants
 * only — so `init` is not too early.
 */
export function publish() {
  const mod = game.modules?.get(MODULE_ID);
  if (mod) mod.api = build();
  return mod?.api ?? null;
}
