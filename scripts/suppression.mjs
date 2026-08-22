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

import { MODULE_ID } from "./constants.mjs";

export const SETTING_DISABLE_NATIVE = "disableNativeSuppression";

/** Tracks the last applied value so `onChange` can ignore no-op saves. */
let lastValue = null;

/** Is native darkness suppression currently disabled? */
export function isNativeSuppressionDisabled() {
  try {
    return game.settings.get(MODULE_ID, SETTING_DISABLE_NATIVE) === true;
  } catch {
    return false;
  }
}

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTING_DISABLE_NATIVE, {
    name: "Disable native darkness suppression",
    hint:
      "Stops Foundry's darkness sources from clipping light sweeps, so the lighting model can see " +
      "what the light level would have been before darkness applied. Until this module's renderer " +
      "exists, darkness will appear not to work — light will shine through it. Development use.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: (value) => {
      // A settings-form save persists every setting and fires onChange unconditionally,
      // so only act on a genuine change.
      if (value === lastValue) return;
      lastValue = value;
      reinitialiseSources();
      ui.notifications.info(
        `PF1 Lighting | Native darkness suppression ${value ? "disabled" : "restored"}.`
      );
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
 * There are **four independent** native suppression paths, and disabling any subset
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
 * 4. **Vision blinding** — `PointVisionSource` sets `blinded.darkness` when its origin is
 *    inside an active darkness source (`point-vision-source.mjs:198`). A blinded token
 *    sees *nothing*. See {@link patchVisionSource}.
 *
 * Path 3 is why a *daylight* overlapping a *darkness* refused to cancel: the daylight
 * outranked it, so Foundry had already cut a bite out of the darkness's polygon, and the
 * two shapes the model compared genuinely no longer intersected. It presents as a rules
 * bug and is a geometry one.
 *
 * Path 4 is why darkness regions rendered as pure black holes that blocked darkvision and
 * looked like unexplored space. It is not a rendering path at all, which is why four
 * successive rendering fixes did nothing to it.
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
 * **There are two consumers, and the obvious one is the less important.** `isBlinded`
 * switches the vision mode to `blindness`; `_getPolygonConfiguration` reads
 * `blinded.darkness` *directly* and collapses the sweep radius to `data.externalRadius`
 * (`point-vision-source.mjs:289-290`). Patching only `isBlinded` produced a source that
 * reported healthy in every respect — not blinded, right vision mode, radius 1250,
 * active — while seeing a single square, because the polygon had already been built at
 * footprint size.
 */
function patchVisionSource() {
  const Base = CONFIG.Canvas.visionSourceClass;
  if (!Base || Base.pf1LightingSuppressionPatched) return;

  const Patched = class extends Base {
    static pf1LightingSuppressionPatched = true;

    /**
     * Run `fn` with `blinded.darkness` neutralised.
     *
     * `#updateBlindedState` is private and cannot be overridden, so the flag gets set
     * regardless; what we can do is stop it counting. Reusing Foundry's own logic around
     * a temporarily cleared flag beats reimplementing each consumer.
     */
    #unblinded(fn) {
      if (!isNativeSuppressionDisabled() || this.blinded?.darkness !== true) return fn();
      const saved = this.blinded.darkness;
      try {
        this.blinded.darkness = false;
        return fn();
      } finally {
        this.blinded.darkness = saved;
      }
    }

    /** @override */
    get isBlinded() {
      return this.#unblinded(() => super.isBlinded);
    }

    /**
     * @override
     * **The one that actually mattered.**
     *
     * `_getPolygonConfiguration` reads `this.blinded.darkness` *directly* rather than
     * through `isBlinded` (`point-vision-source.mjs:289-290`), collapsing the sweep
     * radius to `data.externalRadius` — the token's own footprint. Patching `isBlinded`
     * alone left the vision mode correct and the source active while the polygon was
     * still a one-square bubble.
     */
    _getPolygonConfiguration() {
      return this.#unblinded(() => super._getPolygonConfiguration());
    }
  };

  Object.defineProperty(Patched, "name", { value: "PF1LightingVisionSource" });
  CONFIG.Canvas.visionSourceClass = Patched;
}

function patchDarknessSource() {
  const Base = CONFIG.Canvas.darknessSourceClass;
  if (Base?.pf1LightingSuppressionPatched) return;

  const Patched = class extends Base {
    static pf1LightingSuppressionPatched = true;

    /**
     * @override
     * Path 1. The darkness source still renders its own mesh — that is driven by its
     * own shape, independently of whether it contributes edges for other sources.
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
