/**
 * The emitter / suppressor registry — DESIGN.md §8.2 step 1.
 *
 * A resolved snapshot of everything on the scene that affects light level, sitting
 * between Foundry's source collections and the model. Two reasons it exists rather than
 * gathering straight off `canvas.effects.*` at query time:
 *
 * 1. **Cost.** `evaluate()` has a sub-millisecond budget (§9.1) because it runs on
 *    mousemove. Re-reading document flags for every source on every call is the wrong
 *    shape for that, and `field()` needs the same resolved data for every cell.
 * 2. **Invalidation.** §8.3 is the weakest part of the design and the thing most likely
 *    to bite. Whatever it turns into, it acts on *this* — so the registry is built to be
 *    invalidated even though today it only invalidates wholesale.
 *
 * ## Rebuild policy
 *
 * Lazy, on a dirty flag. Hooks mark the registry stale; the next read rebuilds it.
 *
 * Deliberately **not** a debounce. Reads are already throttled by what drives them
 * (mousemove, render), so laziness coalesces hook bursts for free — dropping a hundred
 * lights on a scene marks dirty a hundred times and rebuilds once — with no timing
 * constant to tune and no window in which a read returns stale data.
 *
 * It is also deliberately not *partial*. Every entry carries an id and can be rebuilt on
 * its own, so per-entry invalidation drops in later without restructuring; but choosing
 * a granularity now, before a renderer exists to validate it, would be guessing. See
 * §8.3.
 */

import { MODULE_ID, isSynthetic } from "../constants.mjs";
import { brightnessAt, contributionAt, emissionOf, ZONE } from "./ramp.mjs";
import { DEFAULT_EMITTER, DEFAULT_SUPPRESSOR, extinguishes } from "./contest.mjs";
import { TIER, tierCeiling, tierFromDarkness } from "./tiers.mjs";
import { ambientTierAt } from "./areas.mjs";

/* -------------------------------------------- */
/*  Entries                                     */
/* -------------------------------------------- */

/**
 * One resolved source. Config and emission are read once per rebuild; geometry is derived
 * lazily, because most entries are never asked for their polygon.
 */
class Entry {
  constructor(source, config) {
    this.source = source;
    this.id = source.sourceId;
    Object.assign(this, config);
  }

  /** @type {PIXI.Polygon|undefined} The shape the cached path was derived from. */
  #shapeRef;

  /** @type {{X: number, Y: number}[]|null} */
  #path = null;

  /**
   * The source's outline.
   *
   * @remarks
   * DESIGN.md §6.2.4. This is `source.shape` directly, and it is safe to read *because*
   * the renderer no longer clips it — the clip lives in `RENDER_SHAPE` and reaches only
   * the mesh. An earlier version narrowed `shape` and had to read around it, which
   * turned out to be papering over a much worse problem: `shape` also drives `testPoint`
   * and Foundry's visibility mask.
   */
  get shape() {
    return this.source.shape ?? null;
  }

  /**
   * This entry's outline as a Clipper path, cached.
   *
   * @remarks
   * The cache is validated by **object identity** against `source.shape`, not by a
   * version number. Foundry builds a fresh polygon every time it re-runs `_createShapes`
   * — which is what a wall change, a door opening or a light moving all end in — so
   * identity catches every geometry change for free and cannot go stale. Nothing needs
   * to remember to invalidate it.
   *
   * @param {number} scale - Clipper scaling factor; must match whatever consumes it
   * @returns {{X: number, Y: number}[]|null}
   */
  path(scale) {
    const shape = this.shape;
    if (!shape?.points?.length) return null;
    if (this.#path && this.#shapeRef === shape && this.#pathScale === scale) return this.#path;

    const pts = shape.points;
    const path = new Array(pts.length / 2);
    for (let i = 0, j = 0; i < pts.length; i += 2, j++) {
      path[j] = { X: Math.round(pts[i] * scale), Y: Math.round(pts[i + 1] * scale) };
    }

    this.#shapeRef = shape;
    this.#pathScale = scale;
    return (this.#path = path);
  }

  /** @type {number|undefined} */
  #pathScale;

  /** @type {PIXI.Polygon|undefined} The shape the cached bounds were derived from. */
  #boundsRef;

  /** @type {{minX: number, minY: number, maxX: number, maxY: number}|null} */
  #bounds = null;

  /**
   * This entry's axis-aligned extent, cached on `shape` identity.
   *
   * @remarks
   * The same trick as {@link path}, for the same reason and against a different cost. Computed
   * from `points` rather than asked of the polygon because the two shapes that reach here disagree
   * about the API — a `PointSourcePolygon` carries `bounds`, a bare `PIXI.Polygon` from Clipper
   * carries neither that nor `getBounds` — and the whole point is a test that cannot fall back to
   * something slower without saying so.
   *
   * @returns {{minX: number, minY: number, maxX: number, maxY: number}|null}
   */
  bounds() {
    const shape = this.shape;
    const pts = shape?.points;
    if (!pts?.length) return null;
    if (this.#bounds && this.#boundsRef === shape) return this.#bounds;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      if (pts[i] < minX) minX = pts[i];
      if (pts[i] > maxX) maxX = pts[i];
      if (pts[i + 1] < minY) minY = pts[i + 1];
      if (pts[i + 1] > maxY) maxY = pts[i + 1];
    }

    this.#boundsRef = shape;
    return (this.#bounds = { minX, minY, maxX, maxY });
  }

  /**
   * Does this source cover a point?
   *
   * @remarks
   * Equivalent to `source.testPoint()` (`base-effect-source.mjs:343-345`), written out
   * so the model's containment test does not silently change meaning if the renderer
   * ever starts narrowing `shape` again.
   *
   * **The bounds test in front is not a micro-optimisation, it is the shape of the caller.**
   * `emittersAt` asks *every* emitter on the scene about *every* point, and a point query runs per
   * test point per detection mode per token per visibility refresh. `PIXI.Polygon#contains` is a
   * ray cast over the ring, and these rings are wall sweeps — hundreds of vertices each. A profile
   * of a six-token drag (2026-08-28) put `emittersAt` at 3.2% self with `Polygon.contains` a
   * further 1.4% beneath it, the largest owned cost left in the module.
   *
   * Four comparisons reject every emitter the point is nowhere near, which on any scene larger
   * than one room is nearly all of them. The bounds are exact and cached on shape identity, so
   * this cannot disagree with the ring test: a point outside the extent is outside the polygon.
   */
  contains(point) {
    const box = this.bounds();
    if (!box) return false;
    if (point.x < box.minX || point.x > box.maxX) return false;
    if (point.y < box.minY || point.y > box.maxY) return false;
    return this.shape.contains(point.x, point.y) === true;
  }
}

/**
 * Ambient brightness right now, from the scene's darkness level.
 *
 * Read live rather than cached on the entry: Foundry *animates* darkness transitions, so
 * `darknessLevel` slides between values without firing a document update. A snapshot
 * taken at registry-build time is correct only until someone drags the slider.
 *
 * PLACEHOLDER shape until §7.1 makes global illumination a real clippable emitter.
 *
 * @returns {number} 0..1
 */
export function ambientBrightness(point) {
  return tierCeiling(ambientTier(point));
}

/**
 * The ambient **tier**, and the base of every additive sum in §3.2.1.
 *
 * @remarks
 * Read through the §7.0 darkness table rather than by thresholding `1 - darknessLevel`. Two
 * quantisations of the same quantity cannot both be the base of a rung ladder, and this is the
 * one the renderer already paints from — so the model and the picture agree by construction.
 *
 * Read live rather than cached on an entry: Foundry *animates* darkness transitions, so
 * `darknessLevel` slides between values without firing a document update.
 *
 * **Position-dependent since §10.7.** A region carrying an *Ambient Light Level* behaviour moves
 * the base inside it, so this takes an optional point. Omitting it gives the scene's own tier,
 * which is what the field's whole-scene reads want; the point query passes one. On a scene with
 * no such region the two answers are identical and `areas.ambientTierAt` returns immediately.
 *
 * @param {{x: number, y: number}} [point]
 */
export function ambientTier(point) {
  const darkness =
    canvas?.environment?.darknessLevel ?? canvas?.scene?.environment?.darknessLevel ?? 0;
  return ambientTierAt(point, tierFromDarkness(darkness));
}

/** An emitter: contributes brightness. */
class EmitterEntry extends Entry {
  /**
   * Which zone of this emitter a point falls in — DESIGN.md §3.2.1.
   *
   * @remarks
   * The resolution path's entry point, and it deliberately does **not** return a number.
   * A band contributes `+n rungs on whatever else is here`, which is not a quantity this
   * emitter can know on its own; `contest.stack` is the only place that can. Returning a
   * brightness here is exactly the collapse the three-zone ramp made.
   *
   * @param {{x: number, y: number, elevation?: number}} [point]
   * @returns {{zone: number, tier?: number, steps?: number, cap?: number}}
   */
  contributionAt(point) {
    // Global illumination is a set level with no origin and no band. `ambientTier` is read
    // live, so a darkness *animation* cannot leave it stale.
    if (this.isGlobal) return { zone: ZONE.INNER, tier: ambientTier(point) };
    const distance = Math.hypot(point.x - this.source.x, point.y - this.source.y);
    return contributionAt(distance, this.emission);
  }

  /**
   * Brightness contributed at a point, ignoring everything else on the map.
   *
   * @remarks
   * Retained for readouts and for the reaching test, **not** for resolution. A band's
   * brightness here is what it would produce over unlit ground, which is a lower bound on
   * its real contribution and the right answer for "does this light reach".
   *
   * @param {{x: number, y: number, elevation?: number}} [point]
   * @param {number} [base] - The prevailing tier to raise from
   * @returns {number} 0..1
   */
  brightnessAt(point, base = TIER.DARK) {
    if (this.isGlobal) return ambientBrightness(point);
    const distance = Math.hypot(point.x - this.source.x, point.y - this.source.y);
    return brightnessAt(distance, this.emission, base);
  }
}

/** A suppressor: reduces or clamps whatever reaches it. */
class SuppressorEntry extends Entry {}

/* -------------------------------------------- */
/*  State                                       */
/* -------------------------------------------- */

let emitterList = null;
let activeEmitterList = null;
let suppressorList = null;
let generation = 0;

/** Read module config off whatever document backs a source, over defaults. */
function configOf(source, defaults) {
  const flags = source.object?.document?.getFlag?.(MODULE_ID, "config") ?? {};
  return { ...defaults, ...flags };
}

/**
 * A suppressor's resolved config, without going through the registry.
 *
 * @remarks
 * For callers that run *during source initialisation*, before the registry is a meaningful
 * thing to consult — notably `requiresEdges` (§4.5.2), which Foundry reads while building
 * the very source the registry would be describing. Reading the flag directly avoids both a
 * chicken-and-egg problem and any question of whether a rebuild is safe at that moment.
 *
 * @param {object} source
 * @returns {object}
 */
export function suppressorConfigOf(source) {
  return configOf(source, DEFAULT_SUPPRESSOR);
}

/**
 * Should this source take part in the model?
 *
 * @remarks
 * **Previews are excluded, and this matters more than it looks.** Dragging a placeable
 * creates a *second* live source — `AmbientLight#sourceId` appends `.preview`
 * (`placeables/light.mjs:55`) — so for the length of the drag the original and its ghost
 * are both active and both overlapping. Counting both meant the model resolved a scene
 * that did not exist.
 *
 * It showed up asymmetrically, which is what made it confusing: `initializeLighting` is
 * only requested when a light creates edges (`placeables/light.mjs:328`), which darkness
 * sources do and plain lights do not. So dragging a *darkness* re-ran the model every
 * frame against the doubled state, while dragging a *light* silently deferred it all to
 * drop.
 *
 * Excluding previews makes both behave the same way: the field reflects committed state,
 * and settles when the drag ends.
 */
function usable(source) {
  if (isSynthetic(source)) return false; // §6.6 — never read back our own output
  if (source.object?.isPreview) return false;
  return true;
}

function buildEmitters() {
  const out = [];
  const globalSource = canvas.environment?.globalLightSource;

  for (const source of canvas.effects.lightSources) {
    if (!source.active) continue;
    if (!usable(source)) continue;

    if (source === globalSource) {
      // Global illumination has no origin or radius, so the ramp cannot apply. Its
      // brightness comes from {@link ambientBrightness}, read live at query time so a
      // darkness animation cannot leave it stale.
      out.push(
        new EmitterEntry(source, {
          kind: "ambient",
          level: 0,
          isGlobal: true,
          placeholder: true,
          emission: null,
        })
      );
      continue;
    }

    out.push(
      new EmitterEntry(source, {
        ...configOf(source, DEFAULT_EMITTER),
        isGlobal: false,
        emission: emissionOf(source),
      })
    );
  }

  return out;
}

function buildSuppressors() {
  const out = [];
  for (const source of canvas.effects.darknessSources) {
    if (!source.active || source.data?.disabled) continue;
    if (!usable(source)) continue;
    out.push(new SuppressorEntry(source, configOf(source, DEFAULT_SUPPRESSOR)));
  }
  return out;
}

/**
 * Put out every emitter **standing inside** a suppressor entitled to block it. DESIGN.md §3.3.1.
 *
 * @remarks
 * **The rule is about the source, not about the ground.** A torch carried into a *darkness*
 * does not light the corridor thirty feet away just because the corridor is outside the
 * bubble — it has gone out. Everything else in this model is pointwise, so without this a
 * suppressed light was merely *clipped*: dark where the darkness covered it, and shining
 * normally everywhere its radius reached beyond. Reported 2026-08-25.
 *
 * Marked rather than removed, and the full list still comes back from {@link emitters}. Two
 * consumers need to see a suppressed emitter: the renderer, which has to notice a source it is
 * no longer drawing and withhold its mesh, and every readout, which should be able to say *why*
 * a light contributes nothing. {@link activeEmitters} is what resolution reads.
 *
 * **Geometry and eligibility only — the contest is not re-run here.** The consequence is one
 * second-order case this gets wrong: a *daylight* that annihilates the darkness at the torch's
 * own position would leave the torch lit, and this still puts it out. Resolving it properly
 * would mean running the regional contest to decide which emitters exist, which is the input to
 * that contest. Deliberate, and cheap to revisit if a scene ever produces it.
 */
function markOriginSuppression(emitterEntries, suppressorEntries) {
  for (const emitter of emitterEntries) emitter.suppressedAtOrigin = false;
  if (!suppressorEntries.length) return;

  for (const emitter of emitterEntries) {
    // Global illumination has no origin to stand anywhere.
    if (emitter.isGlobal) continue;
    const origin = { x: emitter.source.x, y: emitter.source.y };
    for (const suppressor of suppressorEntries) {
      if (!extinguishes(suppressor, emitter)) continue;
      if (!suppressor.contains(origin)) continue;
      emitter.suppressedAtOrigin = true;
      break;
    }
  }
}

function rebuild() {
  emitterList = buildEmitters();
  suppressorList = buildSuppressors();
  markOriginSuppression(emitterList, suppressorList);
  activeEmitterList = emitterList.filter((entry) => !entry.suppressedAtOrigin);
  generation++;
}

/* -------------------------------------------- */
/*  Public                                      */
/* -------------------------------------------- */

/** Mark the registry stale. Cheap; the rebuild happens on next read. */
export function invalidate() {
  emitterList = null;
  activeEmitterList = null;
  suppressorList = null;
}

/**
 * Bumped on every rebuild. A cache key for anything derived from the registry —
 * notably `field()`, which is far too expensive to recompute speculatively.
 */
export function version() {
  if (emitterList === null) rebuild();
  return generation;
}

/**
 * Every emitter the registry knows about, **including ones that are out**.
 *
 * @returns {EmitterEntry[]}
 * @see activeEmitters — what resolution should read. This list is for the renderer, which has
 *   to notice a source it has stopped drawing, and for readouts, which should be able to
 *   explain a light that contributes nothing.
 */
export function emitters() {
  if (emitterList === null) rebuild();
  return emitterList;
}

/**
 * The emitters that actually contribute — {@link emitters} less those put out at their origin.
 *
 * @remarks
 * **Resolution reads this, and every part of it must read the same thing.** `field()` and
 * `emittersAt()` answer the same question at different granularities, and this project has
 * already shipped one bug from letting the two derive an answer separately (`tierOf` versus
 * `resolveTier`, 2026-08-22), where the model and the picture disagreed for a week about how
 * dark a *darkness* was. One list, computed once per rebuild.
 *
 * @returns {EmitterEntry[]}
 */
export function activeEmitters() {
  if (emitterList === null) rebuild();
  return activeEmitterList;
}

/** @returns {SuppressorEntry[]} */
export function suppressors() {
  if (suppressorList === null) rebuild();
  return suppressorList;
}

/**
 * Emitters reaching a point, each with the **zone** it reaches through.
 *
 * @remarks
 * `B` is still reported, because most readers want a number and every readout prints one, but
 * it is the emitter's output *over unlit ground* — a lower bound. The authoritative answer
 * needs the whole set at once and comes from `contest.stack` (§3.2.1).
 *
 * The reaching test is on the zone, not on `B`: a band whose contribution happens to be zero
 * against Dark is still present, and dropping it here would silently unstack it. That is the
 * same class of mistake as the `bright`-past-`dim` disappearance — absence leaving no trace.
 *
 * @param {{x: number, y: number, elevation?: number}} point
 * @returns {{entry: EmitterEntry, B: number, zone: number, tier?: number, steps?: number,
 *   cap?: number}[]}
 */
export function emittersAt(point) {
  const out = [];
  for (const entry of activeEmitters()) {
    // Global illumination covers everything and has no polygon to test.
    if (!entry.isGlobal && !entry.contains(point)) continue;
    const contribution = entry.contributionAt(point);
    if (contribution.zone === ZONE.NONE) continue;
    out.push({ entry, B: entry.brightnessAt(point), ...contribution });
  }
  return out;
}

/**
 * Suppressors covering a point.
 *
 * @param {{x: number, y: number, elevation?: number}} point
 * @returns {SuppressorEntry[]}
 */
export function suppressorsAt(point) {
  return suppressors().filter((entry) => entry.contains(point));
}

/** Debug readout. */
export function stats() {
  return {
    dirty: isDirty(),
    generation,
    emitters: emitters().length,
    // Lights standing inside a darkness that can block them (§3.3.1). Above zero with a
    // darkness on the scene is ordinary; above zero *without* one would be the bug.
    extinguished: emitters().filter((e) => e.suppressedAtOrigin).length,
    suppressors: suppressors().length,
    global: emitters().filter((e) => e.isGlobal).length,
  };
}

/**
 * Does this document change alter anything the registry has *resolved*?
 *
 * @remarks
 * The registry caches only what cannot be read live: resolved config (`kind`, `level`,
 * `floor`, `transform`) and emission. Position is **not** cached — `contributionAt` reads
 * `source.x` and `contains` calls `testPoint`, both live — so a token walking around
 * with a torch does not stale the registry at all.
 *
 * Its *geometry* does change, but that is the field's problem and the field detects it
 * by shape identity rather than by trusting this.
 *
 * @param {object} changed - The diff Foundry passes to `updateX`
 * @param {string[]} keys - Top-level keys that matter for this document type
 */
function affectsRegistry(changed, keys) {
  if (foundry.utils.hasProperty(changed, `flags.${MODULE_ID}`)) return true;
  return keys.some((key) => key in changed);
}

/**
 * Hooks that make the registry stale.
 *
 * @remarks
 * `initializeLightSources` is the broad, always-correct signal — Foundry fires it after
 * rebuilding the light source collection. Note it does **not** fire for an ordinary
 * light-bearing token moving: `Token#initializeLightSource` only requests
 * `initializeLighting` when darkness or edges are involved
 * (`placeables/token.mjs:792-798`), and otherwise re-initialises the source in place.
 * That is fine here, for the reason given on {@link affectsRegistry}.
 *
 * Creation and deletion always invalidate — they change *membership*, which nothing else
 * detects. Updates are filtered, because `updateToken` fires on every hit point, name
 * and step, and none of that is lighting.
 */
export function registerHooks() {
  const dirty = () => invalidate();

  Hooks.on("initializeLightSources", dirty);
  Hooks.on("canvasReady", dirty);
  Hooks.on("canvasTearDown", dirty);

  for (const doc of ["AmbientLight", "Token"]) {
    Hooks.on(`create${doc}`, dirty);
    Hooks.on(`delete${doc}`, dirty);
  }

  // An ambient light is *only* lighting, so almost any edit is relevant and the filter
  // would cost more than it saves.
  Hooks.on("updateAmbientLight", dirty);

  // `hidden` because a hidden token's light stops being active, which changes membership.
  Hooks.on("updateToken", (_doc, changed) => {
    if (affectsRegistry(changed, ["light", "hidden"])) dirty();
  });

  // `environment` carries the darkness level and global illumination; `grid` because
  // `grid` because a scene's distance scale feeds every radius the model reads.
  Hooks.on("updateScene", (_doc, changed) => {
    if (affectsRegistry(changed, ["environment", "darkness", "grid"])) dirty();
  });
}
