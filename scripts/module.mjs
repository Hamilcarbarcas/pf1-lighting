/**
 * pf1-lighting — entry point.
 *
 * Current state: the DESIGN.md §8.1 vertical slice. Nothing here changes how a scene
 * looks on its own; everything is driven from the console via `game.pf1Lighting`.
 */

import { MODULE_ID } from "./constants.mjs";
import { evaluate, gatherEmitters, gatherSuppressors, contest } from "./model/evaluate.mjs";
import { brightnessAt, radiiOf } from "./model/ramp.mjs";
import * as registry from "./model/registry.mjs";
import * as field from "./model/field.mjs";
import * as tiers from "./model/tiers.mjs";
import * as suppression from "./suppression.mjs";
import * as readout from "./ui/readout.mjs";
import * as cellOverlay from "./ui/cell-overlay.mjs";
import * as clip from "./render/clip.mjs";
import * as pool from "./render/pool.mjs";
import * as renderer from "./render/renderer.mjs";
import * as synthetic from "./spike/synthetic.mjs";
import * as bench from "./spike/bench.mjs";
import * as churn from "./spike/churn.mjs";
import * as subdivide from "./spike/subdivide.mjs";
import * as probe from "./spike/probe.mjs";

Hooks.once("init", () => {
  suppression.registerSettings();
  readout.registerSettings();
  readout.registerKeybindings();
  cellOverlay.registerSettings();
  renderer.registerSettings();

  synthetic.registerHooks();
  registry.registerHooks();
  readout.registerHooks();
  cellOverlay.registerHooks();
  renderer.registerHooks();
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
    radiiOf,
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
    },

    // Native darkness suppression (DESIGN.md §4.1.1)
    suppression: {
      isDisabled: suppression.isNativeSuppressionDisabled,
      reinitialise: suppression.reinitialiseSources,
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
    },
  };

  console.error(`${MODULE_ID} | ready — vertical slice. Try game.pf1Lighting.probe.stack()`);
});
