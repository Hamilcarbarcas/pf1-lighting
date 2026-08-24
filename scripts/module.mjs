/**
 * pf1-lighting — entry point.
 *
 * Current state: the DESIGN.md §8.1 vertical slice. Nothing here changes how a scene
 * looks on its own; everything is driven from the console via `game.pf1Lighting`.
 */

import { MODULE_ID } from "./constants.mjs";
import { evaluate, gatherEmitters, gatherSuppressors, contest } from "./model/evaluate.mjs";
import { brightnessAt, contributionAt, emissionOf } from "./model/ramp.mjs";
import * as registry from "./model/registry.mjs";
import * as field from "./model/field.mjs";
import * as tiers from "./model/tiers.mjs";
import { stack as stackEmitters } from "./model/contest.mjs";
import * as suppression from "./suppression.mjs";
import * as perception from "./vision/perception.mjs";
import * as detection from "./vision/detection.mjs";
import * as blindness from "./vision/blindness.mjs";
import * as llv from "./vision/llv.mjs";
import * as observer from "./vision/observer.mjs";
import * as umbra from "./vision/umbra.mjs";
import * as umbraEdges from "./vision/umbra-edges.mjs";
import * as umbraMask from "./vision/umbra-mask.mjs";
import * as readout from "./ui/readout.mjs";
import * as cellOverlay from "./ui/cell-overlay.mjs";
import * as clip from "./render/clip.mjs";
import * as pool from "./render/pool.mjs";
import * as renderer from "./render/renderer.mjs";
import * as desaturate from "./render/desaturate.mjs";
import * as ambient from "./render/ambient.mjs";
import * as soften from "./render/soften.mjs";
import * as darknessTexture from "./render/darkness-texture.mjs";
import * as tierPaint from "./render/paint.mjs";
import * as levels from "./render/levels.mjs";
import * as synthetic from "./spike/synthetic.mjs";
import * as bench from "./spike/bench.mjs";
import * as churn from "./spike/churn.mjs";
import * as subdivide from "./spike/subdivide.mjs";
import * as probe from "./spike/probe.mjs";
import * as darknessLevel from "./spike/darkness-level.mjs";

Hooks.once("init", () => {
  suppression.registerSettings();
  readout.registerSettings();
  readout.registerKeybindings();
  cellOverlay.registerSettings();
  renderer.registerSettings();
  desaturate.registerSettings();
  ambient.registerSettings();
  soften.registerSettings();
  perception.registerSettings();
  blindness.registerSettings();
  llv.registerSettings();
  umbra.registerSettings();
  observer.registerSettings();
  observer.registerKeybindings();
  observer.registerSceneControls();

  // The vision layer's verdicts, handed down to the suppression layer. Injected rather
  // than imported so the dependency runs one way only — see `setVisionModel`.
  suppression.setVisionModel({
    blinds: blindness.modelBlinds,
    darkSightRadius: blindness.darkSightRadius,
    darkSightBrightness: blindness.darkSightBrightness,
    perceptionActive: perception.isPerceptionEnabled,
  });

  // The other direction of the same seam. `umbra` already imports `perception` for
  // `darkSightRange`, so perception cannot import it back without a cycle between peers.
  perception.setUmbraModel({ clampAt: umbra.clampAt });

  synthetic.registerHooks();
  registry.registerHooks();
  readout.registerHooks();
  cellOverlay.registerHooks();
  renderer.registerHooks();
  // Solves the light weights against the scene's ambient colours, per canvas.
  ambient.registerHooks();
  // Soft transitions: the light-edge inset and the darkness-texture blur (§3.2.1, §6.4).
  // Its own hook set, and deliberately not the renderer's: the tier field has to repaint when
  // the *observer* moves, which must not drag source re-initialisation along behind it (§9.5).
  tierPaint.registerHooks();
  umbraEdges.registerHooks();
  desaturate.registerHooks();

  // A prototype patch, so it neither races the canvas group's construction nor cares
  // who else has touched the class.
  detection.patchEffectsGroup();

  // **`init`, and it has to be.** `EnvironmentCanvasGroup` builds the global light source in
  // its constructor as a non-writable value property (`environment.mjs:29-30`), and the canvas
  // groups are created in `Canvas#initialize()` (`board.mjs:582`) — long before `canvasInit`
  // fires (`board.mjs:1024`). Patching the CONFIG slot any later leaves the live singleton an
  // instance of the stock class, which cannot be replaced. Found 2026-08-23, from the mixin
  // reporting `patched: true` while the source went on behaving as though it were not.
  ambient.applyMixin();

  // Also a prototype patch, and also once: the clip has to reach Foundry's visibility mask
  // as well as the mesh (§6.2.4's third consumer). Self-gating on `RENDER_SHAPE`, so it does
  // nothing at all with the renderer off.
  clip.patchVisibility();

  // The observer-relative half of the same idea: an umbra removes a region from what *this*
  // creature's light perception reveals (§4.3). Separate from `clip.patchVisibility` because
  // `render/` must not import from `vision/`.
  umbraMask.applyPatch();
});

/**
 * Detection modes, exactly once and exactly here.
 *
 * `setup` is the only correct window: PF1 replaces its modes during `init`, and `limits`
 * re-mixes them at every `canvasInit` with a cache that only stays valid if nothing
 * re-parents the instance underneath it afterwards. See `vision/detection.mjs`.
 */
Hooks.once("setup", () => {
  detection.mixinDetectionModes();

  // Also `setup`, and for the same class of reason: PF1 installs `LLVMixin` on the
  // placeable classes during `init`, so we have to be after it, and once, so the chain
  // does not grow a link per canvas draw.
  llv.applyMixin();

  // Must follow `llv.applyMixin()` — both wrap `CONFIG.Token.objectClass`, and each guards
  // on its own static mark, so order decides the chain but not whether both apply.
  observer.applyMixin();
});

// Must run after `limits` applies its own source-class mixins, so we sit on top.
Hooks.on("canvasInit", () => {
  suppression.applyMixin();
  clip.applyMixin();
});

Hooks.once("ready", () => {
  game.pf1Lighting = {
    // Model
    evaluate,
    gatherEmitters,
    gatherSuppressors,
    contest,
    brightnessAt,
    contributionAt,
    emissionOf,
    // §3.2.1's resolution rule on its own: set levels contend, relative bands sum. Takes the
    // same shape `evaluate().emitters` returns, so a suspect reading can be re-run by hand.
    //
    // **Not** `stack` — `probe.stack()` has meant "the sources under the cursor" since the
    // vertical slice, and two things called that would be one console typo apart.
    stackEmitters,
    tiers,

    // Resolved snapshot of everything affecting light level (DESIGN.md §8.2 step 1)
    registry: {
      emitters: registry.emitters,
      suppressors: registry.suppressors,
      emittersAt: registry.emittersAt,
      suppressorsAt: registry.suppressorsAt,
      invalidate: registry.invalidate,
      version: registry.version,
      stats: registry.stats,
    },

    // Whole-scene cell decomposition — the renderer's input (DESIGN.md §6.1)
    field: {
      get: field.get,
      compute: field.compute,
      stats: field.stats,
      explain: field.explain,
      invalidate: field.invalidate,
    },

    // The renderer (DESIGN.md §6)
    render: {
      rebuild: () => renderer.rebuild({ force: true }),
      reset: renderer.reset,
      stats: renderer.stats,
      pool: pool.stats,
      // Global illumination: the shader threshold that gets it out of the way (DESIGN.md §7.0)
      ambient: ambient.status,
      // The model's tiers, painted into Foundry's darkness-level texture (DESIGN.md §7.0).
      // Takes an optional point; defaults to the cursor and reads the level back.
      texture: darknessTexture.status,
      // Which mesh claims a point, and what the **rendered texture** says there. The two can
      // disagree — the JS query is a ring test, the shaders sample the rasterised result.
      meshAt: darknessTexture.meshAt,
      // The observer-relative half: cells clamped where this observer looks through a
      // darkness, then painted (DESIGN.md §4.3). `shadows > 0, split: 0` means the umbra is
      // real and every cell it lands on was already at or below the clamp.
      paint: tierPaint.stats,
      repaint: () => tierPaint.repaint({ force: true }),


      // Soft transitions — the two edge mechanisms, and whether Foundry is honouring them.
      // `softEdgesAvailable: false` means the performance mode is below Medium and the light
      // half of this does nothing whatever the setting says.
      soften: soften.status,


      // A/B for a hard-rimmed *darkness* disc on an otherwise soft map. Every region darker
      // than Dim also gets an `ERASE` mesh in the **visibility** mask, whose boundary is binary
      // and is in a different container from the brightness — so §6.4.1's blur cannot reach it.
      // Turn it off and repaint: if the rim softens, that boundary is the cause.
      //
      //   game.pf1Lighting.render.noErase(true)    // then look
      //   game.pf1Lighting.render.noErase(false)   // put it back
      //
      // Not a setting: with it off, a *darkness* on a globally-lit map stops being dark.
      noErase: (off = true) => {
        darknessTexture.setEraseDisabled(off);
        tierPaint.repaint({ force: true });
        canvas.perception.update({ refreshLighting: true, refreshVision: true });
        console.error(`${MODULE_ID} | global-light erase ${off ? "DISABLED" : "restored"}`);
        return darknessTexture.isEraseDisabled();
      },

      // Tier → darkness level, retunable against a live scene. The one number set in §7.0
      // that can only be settled by looking at a map:
      //
      //   game.pf1Lighting.render.levels("bands")   // tier ceilings — dark scenes stay dark
      //   game.pf1Lighting.render.levels("even")    // Supernatural Dark gets its own level
      //   game.pf1Lighting.render.levels(null)      // back to "matched", the default
      //
      // Rebuilds immediately; nothing is persisted.
      levels: (next) => {
        const table = levels.setDarknessTable(next);
        // The light weights are solved from the table, so they move with it.
        ambient.syncLightWeights();
        renderer.rebuild({ force: true });
        canvas.perception.update({ initializeLighting: true, refreshLighting: true, refreshVision: true });
        console.error(`${MODULE_ID} | darkness table`, table);
        return table;
      },
      presets: () => levels.DARKNESS_PRESETS,
    },

    // Debug overlay drawing the field's cells on the canvas
    overlay: {
      draw: () => cellOverlay.draw({ force: true, log: true }),
      clear: cellOverlay.clear,
      toggle: cellOverlay.toggle,
    },

    // Vertical slice harnesses
    spike: {
      spawn: synthetic.spawn,
      destroy: synthetic.destroy,
      clear: synthetic.clear,
      list: synthetic.list,
      refresh: synthetic.refresh,
      ngon: synthetic.ngon,
      bench: bench.bench,
      compare: bench.compare,
      churn: churn.run,
      subdivide: subdivide.run,
      emitterPaths: subdivide.emitterPaths,
      suppressorPaths: subdivide.suppressorPaths,
      // §7.0 spike — can the darkness-level texture carry the five tiers?
      darknessBands: darknessLevel.bands,
      darknessPaint: darknessLevel.paint,
      darknessClear: darknessLevel.clear,
      darknessAt: darknessLevel.sample,
    },

    // Native darkness suppression (DESIGN.md §4.1.1)
    suppression: {
      isDisabled: suppression.isNativeSuppressionDisabled,
      reinitialise: suppression.reinitialiseSources,
    },

    // Vision as perception — what a creature can see, given the light level (§4.8)
    perception: {
      isEnabled: perception.isPerceptionEnabled,
      tierAt: perception.perceivedTier,
      sees: perception.perceives,
      darkvisionSees: perception.darkvisionSees,
      status: detection.status,
      refresh: perception.refresh,
      blinds: blindness.modelBlinds,
      darkSightRange: perception.darkSightRange,
      // The tier as the current *view* sees it — `max` over active observers per §5.3, or
      // null in god's eye. What the readout reports.
      viewerTier: perception.viewerTier,
    },

    // Sight *through* magical darkness (DESIGN.md §4.3)
    umbra: {
      for: umbra.umbraFor,
      all: umbra.all,
      stats: umbra.stats,
      draw: umbra.draw,
      clear: umbra.clear,
      edges: umbraEdges.stats,
      resync: () => umbraEdges.sync({ force: true }),
      // The consumption half: what a point is clamped to for a given observer.
      clampAt: umbra.clampAt,
      regionsFor: umbra.regionsFor,
      isEnabled: umbra.isUmbraPerceptionEnabled,
      mask: umbraMask.status,
      invalidate: umbra.invalidate,
      // `stats().rebuildMs` is the cold path by construction; this is the only readout that
      // exercises the one `perceivedTier` actually calls.
      cache: umbra.cacheProbe,
    },

    // Whose field is being computed (DESIGN.md §5)
    observer: {
      status: observer.status,
      isGmObserverMode: observer.isGmObserverMode,
      toggle: observer.toggleGmObserverMode,
      refresh: observer.refreshVision,
    },

    // Readouts
    probe: {
      at: probe.at,
      tokens: probe.tokens,
      stack: probe.stack,
      sources: probe.sources,
      geometry: probe.geometry,
      vision: probe.vision,
      darkness: probe.darkness,
      perception: probe.perception,
      // What is *painting* at a point, as against what the model says is there (§7.0)
      paintersAt: probe.paintersAt,
      // Which of `field()`'s cells cover a point — the picture's answer, next to
      // `evaluate()`'s. `at()` reports both and marks the point it sampled.
      cellsAt: probe.cellsAt,
      // Which of Foundry's reveal paths is painting a point for each observer — the readout
      // for "this terrain is the wrong colour / brightness" as against "the wrong tier".
      reveals: probe.reveals,
      mark: probe.mark,
      clearMark: probe.clearMark,
    },
  };

  console.error(`${MODULE_ID} | ready — vertical slice. Try game.pf1Lighting.probe.stack()`);
});
