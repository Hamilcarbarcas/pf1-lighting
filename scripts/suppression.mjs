/**
 * Disabling Foundry's native darkness suppression. DESIGN.md §4.1.1.
 *
 * Foundry's darkness sources set `requiresEdges = true`, so `_createEdges()`
 * (point-effect-source.mjs:199-200) inserts edges into `canvas.edges` and every light
 * sweep gets clipped at the darkness boundary. By the time our model reads
 * `canvas.effects.lightSources`, the geometry is already suppressed — measured
 * 2026-08-21 as `emitters: []` inside a darkness bubble overlapping a torch.
 *
 * The contest needs the *unsuppressed* baseline: "this area would have been Normal, so
 * darkness drops it one step to Dim". Foundry's suppression is binary (light gone) and
 * ours is graduated (tier reduced), so the two cannot be reconciled — native
 * suppression has to go, and we apply our own in the renderer.
 *
 * **While this is on and the renderer does not yet exist, darkness will visibly stop
 * working** — light shines straight through, because nothing is suppressing it. That is
 * expected.
 */

import { MODULE_ID, VISION_RANK } from "./constants.mjs";
import { t } from "./i18n.mjs";
import { flag } from "./settings-cache.mjs";

export const SETTING_DISABLE_NATIVE = "disableNativeSuppression";

/** Tracks the last applied value so `onChange` can ignore no-op saves. */
let lastValue = null;

/**
 * Is native darkness suppression currently disabled?
 *
 * @remarks
 * **Through the settings cache, and this is one of the three reads that made it necessary.**
 * `isPerceptionEnabled` calls this on every detection-mode `_testPoint`, so it ran ~1,400 times
 * per visibility refresh at 14.7 µs a call. See `settings-cache.mjs`.
 */
export function isNativeSuppressionDisabled() {
  return flag(SETTING_DISABLE_NATIVE);
}

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTING_DISABLE_NATIVE, {
    // English, not a key: `config: false` below means Foundry never renders a row for it, and
    // `game.pf1Lighting.settings()` is the only thing that prints this. See §10.11.
    name: "Disable native darkness suppression",
    hint:
      "Stops Foundry's darkness sources from clipping light sweeps, so the lighting model can see " +
      "what the light level would have been before darkness applied. Until this module's renderer " +
      "exists, darkness will appear not to work — light will shine through it. Development use.",
    scope: "world",
    // **No control surface, by decision (Hamilcarbarcas, 2026-08-26).** The functionality stays; the
    // switch was a development bisection aid and the module is past needing one in the menu.
    // Reachable from the console — see `game.pf1Lighting.settings`.
    config: false,
    type: Boolean,
    // **Flipped from `false` when the control was removed.** A hidden switch that defaults off
    // is a module that does nothing on a fresh world, and everything downstream requires this:
    // the renderer refuses to run without it (§4.1.1).
    default: true,
    onChange: (value) => {
      // A settings-form save persists every setting and fires onChange unconditionally,
      // so only act on a genuine change.
      if (value === lastValue) return;
      lastValue = value;
      reinitialiseSources();
      ui.notifications.info(t(value ? "Notify.SuppressionOn" : "Notify.SuppressionOff"));
    },
  });

  lastValue = isNativeSuppressionDisabled();
}

/**
 * Ignore one key of a source's `suppression` record.
 *
 * `BaseEffectSource#suppressed` is `Object.values(this.suppression).includes(true)`
 * (base-effect-source.mjs:184-185), and a suppressed source gets `radius: 0` in
 * `_getPolygonConfiguration` — annihilated, not clipped. The private methods that
 * *write* those keys cannot be overridden, but we can stop a key from counting.
 *
 * @param {object} source
 * @param {string} ignoredKey
 * @returns {boolean}
 */
function suppressedIgnoring(source, ignoredKey) {
  for (const [key, value] of Object.entries(source.suppression)) {
    if (key === ignoredKey) continue;
    if (value === true) return true;
  }
  return false;
}

/**
 * Mix over whatever source classes are installed.
 *
 * Called at `canvasInit`, after `limits` has applied its own mixins, so we sit on top
 * of them rather than beside them.
 *
 * @remarks
 * There are **five independent** native suppression paths, and disabling any subset
 * leaves the rest in place (measured 2026-08-21 and 2026-08-22):
 *
 * 1. **Edges** — geometric, partial. Darkness sources set `requiresEdges`, inserting
 *    edges that clip light *sweeps* at the darkness boundary.
 * 2. **Origin containment** — all-or-nothing. `PointLightSource#updateDarknessSuppression`
 *    (point-light-source.mjs:31-34) sets `suppression.darkness` when a light's *origin*
 *    is inside a darkness source, zeroing its radius outright. `PointDarknessSource`
 *    does the mirror image with `suppression.light`.
 *
 * 3. **Light priority edges** — geometric, and the nastiest, because it corrupts the
 *    *model* rather than only the picture. `PointLightSource#requiresEdges` is
 *    `priority > 0` (`point-light-source.mjs:20-22`), and Foundry ranks darkness sources
 *    against priority-bearing lights to decide whose edges cut whose sweep
 *    (`groups/effects.mjs:186+`).
 *
 * Path 1 alone explains a light reaching *into* darkness. Path 2 is why a light placed
 * *inside* darkness vanishes entirely — wrong for PF1, where a torch inside a darkness
 * spell still burns, one tier down.
 *
 * 4. **Vision blinding — the canvas.** `PointVisionSource` sets `blinded.darkness` when
 *    its origin is inside an active darkness source (`point-vision-source.mjs:198`), and
 *    its own sweep collapses to the token's footprint. See {@link patchVisionSource}.
 *
 * 5. **Vision blinding — detection.** The *same* flag, read from outside the class by
 *    `DetectionMode#_testLOS` (`detection-mode.mjs:157`), fails every sight-based
 *    detection independently of path 4. Found 2026-08-22 while building the perception
 *    layer, and it is the reason paths 4 and 5 are now neutralised at the record rather
 *    than at each consumer — see {@link patchVisionSource}.
 *
 * Path 3 is why a *daylight* overlapping a *darkness* refused to cancel: the daylight
 * outranked it, so Foundry had already cut a bite out of the darkness's polygon, and the
 * two shapes the model compared genuinely no longer intersected. It presents as a rules
 * bug and is a geometry one.
 *
 * Path 4 is why darkness regions rendered as pure black holes that blocked darkvision and
 * looked like unexplored space. It is not a rendering path at all, which is why four
 * successive rendering fixes did nothing to it. Path 5 is its counterpart for *objects*
 * rather than terrain, and stays hidden behind path 4: a token that cannot see the room
 * is not obviously also failing to see the people in it.
 */
export function applyMixin() {
  patchDarknessSource();
  patchLightSource();
  patchVisionSource();
}

/**
 * Stop magical darkness from blinding a token outright.
 *
 * @remarks
 * **Path 4**, found 2026-08-22 — the one that produced the black discs.
 *
 * `PointVisionSource` blinds itself when its origin is inside an active darkness source:
 * `this.blinded.darkness = canvas.effects.testInsideDarkness(this.origin, {condition})`
 * (`point-vision-source.mjs:198`). A blinded token sees nothing at all, which is why the
 * regions read as unexplored space rather than as unlit ground, blocked darkvision, and
 * survived every rendering change we made — none of this is rendering.
 *
 * Our own mixin made it *worse* than native. `testInsideDarkness` skips inactive darkness
 * sources, and the `suppressed` override above deliberately keeps them active where
 * Foundry would have switched them off — so disabling native suppression *increased* how
 * often tokens were blinded. That inversion is what made it so hard to place.
 *
 * Under our model, darkness sets a light *level*; §4.5's darkvision and the §4.1 contest
 * decide what a creature can see. Being struck blind is not one of the outcomes.
 *
 * The private `#updateBlindedState` cannot be overridden, but the *consumers* are public
 * — so neutralise the key around a `super` call and let Foundry's own logic run.
 *
 * **There are three consumers, spread across two files, and the obvious one is the least
 * important.** Wrapping them individually was tried first and kept coming up one short:
 *
 *   1. `isBlinded` — swaps the vision mode to `blindness`
 *      (`point-vision-source.mjs:173-175`). The visible one, and the one that matters
 *      least.
 *   2. `_getPolygonConfiguration` — reads `blinded.darkness` **directly** and collapses
 *      the sweep radius to `data.externalRadius` (`point-vision-source.mjs:289-290`).
 *      Patching only (1) produced a source that reported healthy in every respect — not
 *      blinded, right vision mode, radius 1250, active — while seeing a single square,
 *      because the polygon had already been built at footprint size.
 *   3. `DetectionMode#_testLOS` — reads `visionSource.blinded.darkness` directly, from
 *      *outside the class entirely*, and fails every sight-based detection
 *      (`detection-mode.mjs:157`). A subclass override cannot reach this one at all. Its
 *      symptom is different again from (1) and (2): the canvas looks right and the token
 *      sees the room, but every other token in it is invisible.
 *
 * So the lever moved from the consumers to the **record**. `blinded` is a plain instance
 * field, and a subclass field initialiser replaces the parent's — so we hand Foundry a
 * record whose `darkness` key is an accessor that reads `false` while the model is in
 * charge. `#updateBlindedState` still writes to it, `Object.values(this.blinded)` still
 * enumerates it, and every reader present or future is covered without knowing they exist.
 *
 * The written value is kept, not discarded: `probe.vision()` reports it, so the diagnostic
 * can still distinguish "Foundry wanted to blind this token and we overrode it" from
 * "Foundry never blinded it".
 */
function patchVisionSource() {
  const Base = CONFIG.Canvas.visionSourceClass;
  if (!Base || Base.pf1LightingSuppressionPatched) return;

  const Patched = class extends Base {
    static pf1LightingSuppressionPatched = true;

    /**
     * @override
     * Replaces `PointVisionSource#blinded` (`point-vision-source.mjs:183`). A subclass
     * field initialiser runs after the parent's and wins, so this is the record Foundry
     * uses from construction onwards.
     */
    blinded = createBlindedRecord(this);

    /**
     * @override
     * Light-independent sight needs a radius or it reveals nothing (DESIGN.md §4.5.1).
     *
     * Detection short-circuits let such a creature *detect* anything in line of sight, but
     * terrain is painted from `data.radius` (`groups/visibility.mjs:575-590`), which is zero
     * for a creature with no darkvision. Without this it would make out every token while
     * standing in a black void.
     *
     * A **maximum**, never an assignment: *true seeing* already has its range folded into
     * `sight.range` by PF1, and darkvision may reach further than either sense. This can
     * only ever extend.
     *
     * `_initialize` is the seam because core normalises radii here too
     * (`point-vision-source.mjs:217-222`), so the value is set before anything derives a
     * polygon from it.
     */
    _initialize(data) {
      super._initialize(data);
      if (visionModel?.perceptionActive?.() !== true) return;

      // **Blinded: blindsight and nothing else.** The record above already reports this
      // creature as unblinded so that terrain gets painted at all; this is the other half, and
      // without it the radius left over from `_syncSenses` is `max(base, darkvision,
      // blindsight)` — so a blinded creature would see as far as its *darkvision*, which is
      // sight, and is precisely what the condition removes. Assigned, not maximised: when
      // blinded, blindsight is the only reach there is, and zero correctly restores core's
      // behaviour for a creature that has none.
      if (this.blinded?.[RAW_BLIND]) {
        const blindsight = visionModel?.blindsightRadius?.(this) ?? 0;
        this.data.radius = blindsight;
        // Same ladder as the ordinary path below, for the same reason: blindsight perceives
        // through a magical darkness, so it sweeps at piercing rank. A creature blinded with no
        // blindsight gets `NORMAL` and a radius of zero, which is core's behaviour exactly.
        this.data.priority = Math.max(
          this.data.priority ?? 0,
          blindsight > 0 ? VISION_RANK.PIERCING : VISION_RANK.NORMAL
        );
        // `darkSightBrightness` is deliberately not applied: it is a look adjustment for
        // light-independent *sight*, and this branch is reached only when sight is gone.
        return;
      }

      const darkSight = visionModel?.darkSightRadius?.(this) ?? 0;

      // Where this observer sits on the ladder (EDGE_RANK). Ordinary sight ignores umbra
      // edges and stops at blocking ones; light-independent sight ignores both. Set for
      // *every* observer, not only the exceptional ones, because the whole point of the
      // ladder is that rank-0 umbra edges must not block anybody's ordinary sight.
      //
      // **Walls are unaffected at any rank** — `_determineEdgeTypes` registers them at
      // `-Infinity` (`clockwise-sweep.mjs:101`) while darkness edges take the sweep's own
      // priority (`:127`), and an edge is skipped only when
      // `edge.priority < edgeType.priority` (`:236`).
      this.data.priority = Math.max(
        this.data.priority ?? 0,
        darkSight > 0 ? VISION_RANK.PIERCING : VISION_RANK.NORMAL
      );

      if (darkSight <= 0) return;
      this.data.radius = Math.max(this.data.radius ?? 0, darkSight);

      // Optional look adjustment. Revealing and brightening are the same act in Foundry
      // (see `darkSightBrightness`), so this is the only way to have one without the other.
      // Additive against any authored value, then clamped to the shader's range.
      const offset = visionModel?.darkSightBrightness?.(this) ?? 0;
      if (offset !== 0) {
        this.data.brightness = Math.clamp((this.data.brightness ?? 0) + offset, -1, 1);
      }
    }
  };

  Object.defineProperty(Patched, "name", { value: "PF1LightingVisionSource" });
  CONFIG.Canvas.visionSourceClass = Patched;
}

/**
 * The vision layer's verdicts, injected rather than imported.
 *
 * @remarks
 * Dependency direction, made explicit. This file is the **low** layer — it knows how to
 * stop Foundry suppressing things and nothing about light levels. The vision layer sits on
 * top and imports from here. Importing back the other way to ask "should this observer be
 * blinded" would make the two mutually dependent, and an ES module cycle between a settings
 * reader and a model query is the kind of thing that works until the day an import order
 * changes and a `const` is read in its temporal dead zone.
 *
 * So `module.mjs` wires them together and this file holds an interface it never constructs.
 *
 * @type {{
 *   blinds?: (s: object) => boolean,
 *   darkSightRadius?: (s: object) => number,
 *   blindsightRadius?: (s: object) => number,
 *   darkSightBrightness?: (s: object) => number,
 *   perceptionActive?: () => boolean,
 * }|null}
 */
let visionModel = null;

/** Wire the vision layer's verdicts in. Called once at `init`. */
export function setVisionModel(model) {
  visionModel = model;
}

/**
 * The raw, un-overridden `blinded.darkness` value, for diagnostics.
 *
 * Non-enumerable, so it stays out of `Object.values(this.blinded)` — which is exactly how
 * `isBlinded` is computed, and would otherwise blind every token permanently.
 */
export const RAW_BLINDED = Symbol("pf1LightingRawBlinded");

/** The raw, un-overridden `blinded.blind` value — the status effect as Foundry set it. */
export const RAW_BLIND = Symbol("pf1LightingRawBlind");

/**
 * A `blinded` record whose `darkness` key is decided by the model rather than by Foundry.
 *
 * @remarks
 * Not simply `false`. Native path 4's *behaviour* is correct — a creature that cannot see
 * where it stands should be blind — and only its **trigger** was wrong, firing on the mere
 * presence of darkness rather than on whether that darkness actually defeats the observer.
 * So the trigger is replaced and Foundry's own blinding machinery is left to do the rest.
 *
 * With no vision model wired in, this reports `false` and behaves exactly as it did before
 * §4.5.1 — the model is additive, not load-bearing for correctness here.
 *
 * @param {object} source - The vision source this record belongs to
 * @returns {Record<string, boolean>}
 */
function createBlindedRecord(source) {
  let raw = false;
  let rawBlind = false;
  const record = {};

  Object.defineProperty(record, "darkness", {
    enumerable: true,
    configurable: true,
    get: () => {
      if (!isNativeSuppressionDisabled()) return raw;
      return visionModel?.blinds?.(source) === true;
    },
    set: (value) => {
      raw = value === true;
    },
  });

  /**
   * **The blinded *condition*, which blindsight should survive** (Hamilcarbarcas, 2026-08-26).
   *
   * Written by `Token#updateVisionSource` from the status effect
   * (`placeables/token.mjs:889-890`, `:911`), and `isBlinded` is any-true over this record — so
   * a blinded creature gets the `blindness` vision mode, no sight FOV, and an unpainted void,
   * however well its other senses work.
   *
   * Blindsight is not sight. PF1 already has the *detection* half right: its `blindSight` mode
   * is type `OTHER` with `_canDetect() { return true }`, so core's status gate on sight modes
   * (`perception/detection-mode.mjs:107`) never reaches it, and a blinded creature still detects
   * what it can hear or feel. Only terrain was lost, and only because terrain is painted from
   * `data.radius`.
   *
   * So this reports `false` for a creature with blindsight, and the `_initialize` override then
   * **clamps the radius to the blindsight range** rather than leaving it at the token's full
   * sight range. Both halves are needed: without the first there is no terrain at all, and
   * without the second a blinded creature would see as far as its *darkvision*, which is sight
   * and is exactly what the condition takes away.
   *
   * The sight-based modes stay blocked either way, because core gates those on the status effect
   * itself and not on this record. That is the division that makes this safe.
   */
  Object.defineProperty(record, "blind", {
    enumerable: true,
    configurable: true,
    get: () => {
      if (!rawBlind) return false;
      return !((visionModel?.blindsightRadius?.(source) ?? 0) > 0);
    },
    set: (value) => {
      rawBlind = value === true;
    },
  });

  Object.defineProperty(record, RAW_BLINDED, {
    enumerable: false,
    get: () => raw,
  });

  Object.defineProperty(record, RAW_BLIND, {
    enumerable: false,
    get: () => rawBlind,
  });

  return record;
}

function patchDarknessSource() {
  const Base = CONFIG.Canvas.darknessSourceClass;
  if (Base?.pf1LightingSuppressionPatched) return;

  const Patched = class extends Base {
    static pf1LightingSuppressionPatched = true;

    /**
     * @override
     * Path 1, in full. A darkness source contributes **no** edges of its own.
     *
     * @remarks
     * It briefly contributed sight-only edges here (§4.5.2, 2026-08-22), which was right
     * about the mechanism and wrong about the geometry. Edges built in this method can only
     * trace `this.shape`, the suppressor's *raw* polygon, so they ignore daylight
     * cancellation, two-band rims and per-region tiers alike — "where a darkness is" rather
     * than "where a darkness is in effect".
     *
     * Sight edges now come from `field()` cells in `vision/umbra-edges.mjs`, which is the
     * only place the model's own answer is available. Read that file before reinstating
     * anything here.
     *
     * The source still renders its own mesh either way — that is driven by its shape,
     * independently of whether it contributes edges.
     */
    get requiresEdges() {
      if (isNativeSuppressionDisabled()) return false;
      return super.requiresEdges;
    }

    /**
     * @override
     * Path 2, mirrored: stop overlapping light from annihilating this darkness. Under
     * our model the §4.1 contest decides that, not origin containment.
     */
    get suppressed() {
      if (isNativeSuppressionDisabled()) return suppressedIgnoring(this, "light");
      return super.suppressed;
    }
  };

  Object.defineProperty(Patched, "name", { value: "PF1LightingDarknessSource" });
  CONFIG.Canvas.darknessSourceClass = Patched;
}

function patchLightSource() {
  const Base = CONFIG.Canvas.lightSourceClass;
  if (Base?.pf1LightingSuppressionPatched) return;

  const Patched = class extends Base {
    static pf1LightingSuppressionPatched = true;

    /**
     * @override
     * Path 2. A light whose origin sits inside a darkness source keeps its radius; the
     * contest reduces its tier rather than deleting it.
     */
    get suppressed() {
      if (isNativeSuppressionDisabled()) return suppressedIgnoring(this, "darkness");
      return super.suppressed;
    }

    /**
     * @override
     * **Path 3**, found 2026-08-22 — the one that was missed.
     *
     * `PointLightSource#requiresEdges` is `this.priority > 0`
     * (`point-light-source.mjs:20-22`), and `initializePriorityLightSources` ranks
     * darkness sources and priority-bearing lights by descending priority, darkness
     * winning ties (`groups/effects.mjs:186+`). Those sources emit edges that clip each
     * other's **sweeps**.
     *
     * That is Foundry running its own precedence contest, geometrically, underneath
     * ours — and it does not merely affect rendering. It truncates the polygons the
     * model measures, so a *daylight* outranking a *darkness* left the darkness with a
     * bitten-off shape that no longer reached the light. The symptom was a
     * daylight/darkness overlap that refused to cancel: the two polygons genuinely did
     * not intersect any more, because Foundry had already cut one of them away.
     *
     * §4.1's level contest replaces this entirely, so the edges have to go with it.
     */
    get requiresEdges() {
      if (isNativeSuppressionDisabled()) return false;
      return super.requiresEdges;
    }
  };

  Object.defineProperty(Patched, "name", { value: "PF1LightingLightSource" });
  CONFIG.Canvas.lightSourceClass = Patched;
}

/**
 * Rebuild every light and darkness source so an `requiresEdges` change takes effect.
 *
 * @remarks
 * Snapshotting to an array first is deliberate — PF1 documents that iterating
 * `canvas.effects.lightSources` directly while re-initialising can loop forever
 * (`pf1/module/canvas/low-light-vision.mjs:130-133`).
 */
export function reinitialiseSources() {
  if (!canvas?.ready) return;

  const sources = [...canvas.effects.darknessSources, ...canvas.effects.lightSources];
  for (const source of sources) source.object?.initializeLightSource?.();

  canvas.perception.update({
    initializeLighting: true,
    initializeVision: true,
    refreshLighting: true,
    refreshVision: true,
  });
}
