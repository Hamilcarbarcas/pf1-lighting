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
import * as areas from "./model/areas.mjs";
import * as spill from "./model/spill.mjs";
import * as geodesic from "./model/geodesic.mjs";
import * as geodesicOverlay from "./ui/geodesic-overlay.mjs";
import * as spillConfig from "./ui/spill-config.mjs";
import * as tiers from "./model/tiers.mjs";
import { stack as stackEmitters } from "./model/contest.mjs";
import * as suppression from "./suppression.mjs";
import * as settingsCache from "./settings-cache.mjs";
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
import * as lightConfig from "./ui/light-config.mjs";
import * as sceneConfig from "./ui/scene-config.mjs";
import * as publicApi from "./api.mjs";
import * as presets from "./model/presets.mjs";
import * as presetEditor from "./ui/preset-editor.mjs";
import * as visuals from "./ui/visuals.mjs";
import * as clip from "./render/clip.mjs";
import * as pool from "./render/pool.mjs";
import * as renderer from "./render/renderer.mjs";
import * as desaturate from "./render/desaturate.mjs";
import * as greyscale from "./render/greyscale.mjs";
import * as darknessMask from "./render/darkness-mask.mjs";
import * as ambient from "./render/ambient.mjs";
import * as soften from "./render/soften.mjs";
import * as darknessTexture from "./render/darkness-texture.mjs";
import * as gradient from "./render/gradient.mjs";
import * as transition from "./render/transition.mjs";
import * as fieldBlur from "./render/texture-blur.mjs";
import * as wallMask from "./render/wall-mask.mjs";
import * as lightRamps from "./render/light-ramps.mjs";
import * as tierPaint from "./render/paint.mjs";
import * as levels from "./render/levels.mjs";
import * as synthetic from "./spike/synthetic.mjs";
import * as bench from "./spike/bench.mjs";
import * as churn from "./spike/churn.mjs";
import * as subdivide from "./spike/subdivide.mjs";
import * as probe from "./spike/probe.mjs";
import * as darknessLevel from "./spike/darkness-level.mjs";

Hooks.once("init", () => {
  // The API goes up first, at `init` rather than `ready` (§11.2).
  // `game.modules.get("pf1-lighting").api` is the address another module looks at — Foundry's
  // convention. The `game.pf1Lighting.api` alias assigned in `ready` is the same frozen object, for
  // console use.
  //
  // Timing is the substance rather than tidiness: an API published in `ready` races every consumer's
  // own `ready` on module load order, so its existence would depend on alphabetical luck.
  publicApi.publish();

  // First, and before any `registerSettings` call. Every module setting read on a hot path goes
  // through this cache, and its invalidation hooks must be listening before anything can write a
  // setting. Registering a setting does not itself write one, so nothing is missed by being here
  // rather than earlier. See `settings-cache.mjs` for the 14.7 µs measurement behind it.
  settingsCache.registerHooks();

  // Before anything reads a tier. Registers the region behaviour's data model and icon; its label is
  // deliberately not set here and comes from `lang/en.json` — see `areas.registerBehavior` for why a
  // literal cannot work.
  areas.registerBehavior();

  suppression.registerSettings();
  readout.registerSettings();
  readout.registerKeybindings();
  cellOverlay.registerSettings();
  renderer.registerSettings();
  desaturate.registerSettings();
  // Greyscale as a region rather than a screen (§6.2.11): Foundry's five desaturation routes zeroed,
  // one pass on `canvas.environment` in their place. Registered before `visuals`, which reads the fog
  // dial by name.
  greyscale.registerSettings();
  darknessMask.registerSettings();
  ambient.registerSettings();
  // The tier → darkness-level table, as four world settings (§10.5). Registered before
  // anything reads a tier so the stored table is in force from the first query.
  levels.registerSettings();
  // The preset table, and the sub-window that edits it (§10.2). The table is a stored object
  // rather than a row in the flat list, so its control surface is the menu.
  presets.registerSettings();
  presetEditor.registerSettings();
  // The appearance numbers, edited in their own window (§10.6). Registered after the
  // modules that own the keys, so the menu never opens on a key that does not exist yet.
  soften.registerSettings();
  // One width for every brightness boundary (§6.4.3). Registered before the producers that read it —
  // the ground halos, a spill band and a light's zones all fade over this distance.
  transition.registerSettings();
  // Whether that width is delivered by blurring the whole field or by a gradient per region
  // (§6.4.4). One switch, two implementations, so they can be compared on the same scene.
  fieldBlur.registerSettings();
  // Observer-relative *drawing*: ground the viewer cannot see is painted Dark, the same
  // treatment an umbra already gets (§4.3.1). Registered here, where `paint` reads it.
  tierPaint.registerSettings();
  // A light's zones painted at a fixed brightness per tier rather than relative to the ground
  // beneath them (§6.2.9). Registered here, where `_updateCommonUniforms` reads it.
  clip.registerSettings();
  // The step past that: a light's brightness drawn as a region in the same map the ground uses,
  // instead of as Foundry's radial falloff (§7.0 step 6).
  lightRamps.registerSettings();
  perception.registerSettings();
  blindness.registerSettings();
  llv.registerSettings();
  umbra.registerSettings();
  observer.registerSettings();
  // §3.4's six numbers, and the window that edits them (§10.10). Same rule as the menus below:
  // the keys are registered here, by the module that reads them, before the menu that edits them
  // by name.
  spill.registerSettings();
  // §3.4.1's one number, registered before the window that edits it by name.
  geodesic.registerSettings();
  spillConfig.registerSettings();
  // Last of the menus, and it must follow `levels`, `soften` and `blindness` — it reads their
  // keys by name and `game.settings.settings` has to already hold them for the defaults button.
  visuals.registerSettings();
  observer.registerKeybindings();
  observer.registerSceneControls();
  // Hides its settings row from players at `ready` — client-scoped, so Foundry's own world-scope
  // filter cannot do it.
  observer.registerHooks();

  // The vision layer's verdicts, handed down to the suppression layer. Injected rather than imported
  // so the dependency runs one way only — see `setVisionModel`.
  suppression.setVisionModel({
    blinds: blindness.modelBlinds,
    darkSightRadius: blindness.darkSightRadius,
    // Narrower deliberately: the blinded condition strips sight, and true seeing is sight. Only
    // blindsight survives it, so it needs its own reach. See `blindness.blindsightRadius`.
    blindsightRadius: blindness.blindsightRadius,
    darkSightBrightness: blindness.darkSightBrightness,
    perceptionActive: perception.isPerceptionEnabled,
  });

  // The other direction of the same seam. `umbra` already imports `perception` for
  // `darkSightRange`, so perception cannot import it back without a cycle between peers.
  perception.setUmbraModel({ clampAt: umbra.clampAt });

  // Same injection seam as the two above: `render/darkness-texture.mjs` reads from `soften`, so
  // the settings callback comes back the other way rather than as a second import.
  soften.setGroundRefresh(darknessTexture.refreshFilters);
  // The transition width is read when a ramp's levels are built, so a change repaints rather than
  // re-syncing a filter. Same injection seam, same reason.
  transition.setRefresh(() => tierPaint.repaint({ force: true }));

  synthetic.registerHooks();
  registry.registerHooks();
  // A region's *shape* changes on `updateRegion` and its *values* on `updateRegionBehavior`,
  // which does not touch the region document at all — so both, or editing the tier does nothing
  // until the region is nudged.
  areas.registerHooks();
  // After `areas`, and the ordering is real. `spill.registerHooks` ends by calling
  // `areas.registerProvider`, and a provider's bands fold after the drawn regions — the only order
  // in which an `AT_LEAST` spill survives an `AT_MOST` room clamp (§3.4).
  spill.registerHooks();
  readout.registerHooks();
  cellOverlay.registerHooks();
  lightConfig.registerHooks();
  sceneConfig.registerHooks();
  // Swaps core's two ten-second transition buttons for one per tier (§10.5.2).
  sceneConfig.registerSceneControls();
  renderer.registerHooks();
  // Solves the light weights against the scene's ambient colours, per canvas.
  ambient.registerHooks();
  // Soft transitions: the light-edge inset and the darkness-texture blur (§3.2.1, §6.4). Its own
  // hook set rather than the renderer's, deliberately: the tier field has to repaint when the
  // observer moves, which must not drag source re-initialisation behind it (§9.5).
  tierPaint.registerHooks();
  umbraEdges.registerHooks();
  desaturate.registerHooks();
  // §6.2.11's single desaturation pass, on `canvas.environment`. That group is rebuilt on every
  // canvas draw, so the filter is re-attached at `canvasReady` rather than installed once.
  greyscale.registerHooks();
  // §6.4.7 — the segments the field blur must not cross. Its own hooks rather than the renderer's: a
  // wall moving changes the mask without changing a single brightness, and a door opening changes it
  // without moving anything at all.
  wallMask.registerHooks();

  // A prototype patch, so it neither races the canvas group's construction nor cares who else has
  // touched the class.
  detection.patchEffectsGroup();

  // `init`, and it has to be. `EnvironmentCanvasGroup` builds the global light source in its
  // constructor as a non-writable value property (`environment.mjs:29-30`), and the canvas groups
  // are created in `Canvas#initialize()` (`board.mjs:582`), long before `canvasInit` fires
  // (`board.mjs:1024`). Patching the CONFIG slot later leaves the live singleton an instance of the
  // stock class, unreplaceable. Found 2026-08-23, from the mixin reporting `patched: true` while the
  // source went on behaving as though it were not.
  ambient.applyMixin();

  // Also a prototype patch, and also once: the clip has to reach Foundry's visibility mask as well
  // as the mesh (§6.2.4's third consumer). Self-gating on `RENDER_SHAPE`, so it does nothing at all
  // with the renderer off.
  clip.patchVisibility();

  // The observer-relative half of the same idea: an umbra removes a region from what one creature's
  // light perception reveals (§4.3). Separate from `clip.patchVisibility` because `render/` must not
  // import from `vision/`.
  umbraMask.applyPatch();

  // The darkness layer is the one effects layer core never vision-masks, so a darkness source
  // draws through walls. A prototype patch on the layer's `_draw`, at `init` because the canvas
  // groups are built inside `Canvas#initialize()` and the class has no CONFIG slot to swap.
  darknessMask.applyPatch();

  // The other half, and the one that mattered: core paints unseen ground from the darkness-level
  // texture, which since §7.0 is where this module writes its model, so fog reproduced every
  // darkness disc and umbra. A CONFIG class swap, and it must precede the first canvas draw, every
  // effects layer reading that slot in its own `_draw`.
  darknessMask.applyFilterPatch();
  // The third darkening of unseen ground — Foundry's fog overlay, hard-coded at half black.
  // Same CONFIG-slot rule as the filter above: swapped at `init`, before the canvas is drawn.
  darknessMask.applyFowPatch();
});

/**
 * Detection modes, exactly once and exactly here.
 *
 * `setup` is the only correct window: PF1 replaces its modes during `init`, and `limits` re-mixes
 * them at every `canvasInit` with a cache that stays valid only if nothing re-parents the instance
 * underneath it afterwards. See `vision/detection.mjs`.
 */
Hooks.once("setup", () => {
  detection.mixinDetectionModes();

  // Also `setup`, for the same class of reason: PF1 installs `LLVMixin` on the placeable classes
  // during `init`, so this must follow it, and run once, so the chain does not grow a link per canvas
  // draw.
  llv.applyMixin();

  // Must follow `llv.applyMixin()` — both wrap `CONFIG.Token.objectClass`, each guarding on its own
  // static mark, so order decides the chain but not whether both apply.
  observer.applyMixin();

  // `setup`, because PF1 assigns `CONFIG.Canvas.visionModes.darkvision` during `init`
  // (`pf1.mjs:261`) and anything earlier is overwritten. Zeroes Foundry's five desaturation routes
  // so §6.2.11's single pass is the only thing greying anything.
  greyscale.neutralise();
});

// Must run after `limits` applies its own source-class mixins, so these sit on top.
Hooks.on("canvasInit", () => {
  suppression.applyMixin();
  clip.applyMixin();
  // A core oversight rather than one of this module's, though this module is what makes it visible:
  // a darkness sweep indexes each edge with its own source type, and `darkness` is not one of the
  // four wall restrictions, so every wall blocks it — windows and open doors included. See
  // `clip.patchDarknessWalls`.
  clip.patchDarknessWalls();
});

Hooks.once("ready", () => {
  game.pf1Lighting = {
    // The supported surface — DESIGN.md §11. Everything else on this object is a debug readout: it
    // logs, gains and loses fields as diagnoses need them, and several entries hand back live
    // internals. `api` is the half that promises not to change under a consumer, and `api.version`
    // is how one feature-detects.
    //
    // A console alias rather than the address. Another module should use
    // `game.modules.get("pf1-lighting").api`, published at `init` and the same frozen object. This
    // exists because `pf1-lighting.api` cannot be typed — the hyphen is a minus sign.
    //
    //   game.pf1Lighting.api.perceivedBy(token, { sample: "min" })
    //   game.pf1Lighting.api.brightnessOf([a, b, c], { observer })
    //   game.pf1Lighting.api.setSceneTier(game.pf1Lighting.api.TIER.DIM)
    api: publicApi.build(),

    // Model
    evaluate,
    gatherEmitters,
    gatherSuppressors,
    contest,
    brightnessAt,
    contributionAt,
    emissionOf,
    // §3.2.1's resolution rule on its own: set levels contend, relative bands sum. Takes the same
    // shape `evaluate().emitters` returns, so a suspect reading can be re-run by hand.
    //
    // Not named `stack`: `probe.stack()` has meant the sources under the cursor since the vertical
    // slice, and two things called that would be one console typo apart.
    stackEmitters,
    tiers,

    // Every setting this module owns, including the ones with no control surface.
    //
    //   game.pf1Lighting.settings()                              // list them all
    //   game.pf1Lighting.settings("renderEnabled")               // read one
    //   game.pf1Lighting.settings("renderEnabled", true)         // write one
    //
    // §10.6 removed the menu rows for eight switches as development bisection aids rather than play
    // features (2026-08-26) — the rows, not the switches, and a switch reachable only by remembering
    // its exact key is gone in practice. `hidden: true` marks the ones this is the only route to.
    settings: (key, value) => {
      const all = [...game.settings.settings.values()].filter((s) => s.namespace === MODULE_ID);

      if (key === undefined) {
        const report = {};
        for (const setting of all) {
          report[setting.key] = {
            // Localised here, and it has to be. `setting.name` is a key since §10.11, resolved by
            // Foundry when it renders a settings row, and 32 of the 38 settings below are
            // `config: false` and never get one. This readout is their only interface, so without
            // this the console prints `PF1LIGHTING.Setting.renderEnabled.Name`.
            name: game.i18n.localize(setting.name),
            scope: setting.scope,
            hidden: setting.config !== true,
            value: game.settings.get(MODULE_ID, setting.key),
            default: setting.default,
          };
        }
        console.error(`${MODULE_ID} | settings`, report);
        return report;
      }

      if (!all.some((s) => s.key === key)) {
        const names = all.map((s) => s.key).sort().join(", ");
        console.error(`${MODULE_ID} | no such setting "${key}". Known keys: ${names}`);
        return undefined;
      }

      if (value === undefined) return game.settings.get(MODULE_ID, key);
      return game.settings.set(MODULE_ID, key, value);
    },

    // Named configurations (DESIGN.md §10.2). `applyPreset(name)` returns the flat update a
    // document needs, so a macro can do
    //
    //   light.document.update(game.pf1Lighting.presets.apply("deeperDarkness"))
    //
    // Deliberately no matcher: the stored `preset` records where the numbers came from, which is
    // history and not recoverable by looking at them.
    presets: {
      // A function rather than the object: the table is a world setting since the editor landed, and
      // a snapshot taken at `ready` would go stale the first time it is edited.
      table: presets.table,
      apply: presets.applyPreset,
      choices: presets.presetChoices,
      label: presets.presetLabel,
      builtIn: presets.BUILT_IN,
      // The editor, and what it is currently looking at. `customised: false` means this world
      // has never saved it and still tracks the module's own table.
      edit: presetEditor.open,
      status: presetEditor.status,
      reset: presets.resetTable,
    },

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

    // Regions that move the ambient light level (DESIGN.md §10.7). `status()` answers the two
    // questions this feature generates: whether the behaviour is on offer at all (`declared` is the
    // module.json half and needs a world relaunch, not an F5), and whether an area can change the
    // picture — which needs Model global illumination on, §7.0's texture being the only channel by
    // which anything darkens below global light.
    areas: {
      status: areas.status,
      list: areas.areas,
      tierAt: areas.ambientTierAt,
      invalidate: areas.invalidate,
    },

    // Light spill through windows and open doors (DESIGN.md §3.4)
    spill: {
      stats: spill.stats,
      at: spill.at,
      list: spill.spillAreas,
      rebuild: spill.rebuild,
      config: spillConfig.open,
    },

    // §3.4.1's geometry — geodesic distance, live since 2026-08-28: `spill` above now contours these
    // fields, so this is the same arithmetic the map is lit by rather than a probe beside it. What it
    // adds is the ability to see the field the contour was cut from.
    //
    //   game.pf1Lighting.geodesic.draw()                       // the ladder, flat per tier
    //   game.pf1Lighting.geodesic.draw({ mode: "distance" })   // the raw field the contour cuts
    //   game.pf1Lighting.geodesic.draw({ graze: 0.45 })        // with a cone — not what ships
    //   game.pf1Lighting.geodesic.draw({ widths: { bright: 40, normal: 20, dim: 10 } })
    //   game.pf1Lighting.geodesic.clear()
    //
    // It still marches one aperture at a time where `spill` marches one room, deliberately:
    // per-window is the right granularity for asking what one window is doing, and the two agree
    // wherever a room has one window.
    //
    // Red is the severed cell-to-cell links. Look there first — a continuous hatch along a wall is
    // that wall sealed, and a break in the hatch is somewhere light gets through.
    geodesic: {
      draw: geodesicOverlay.draw,
      compare: geodesicOverlay.compare,
      clear: geodesicOverlay.clear,
      fill: geodesic.fill,
      ladder: geodesic.ladder,
      cellSize: geodesic.cellSize,
    },

    // The read-through cache over `game.settings.get`. `hitRate` well below 1, or `invalidations`
    // climbing while nobody touches settings, is the failure worth seeing — either turns the cache
    // into pure overhead, and neither shows up in a timing.
    //
    //   game.pf1Lighting.settingsCache()            // hit rate, keys held, invalidations
    //   game.pf1Lighting.settingsCache.invalidate() // drop it; the next read re-fetches
    settingsCache: Object.assign(settingsCache.stats, { invalidate: settingsCache.invalidate }),

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
      // Which mesh claims a point, and what the rendered texture says there. The two can disagree —
      // the JS query is a ring test, the shaders sample the rasterised result.
      meshAt: darknessTexture.meshAt,
      // Is this edge hard in the brightness field, or is another layer drawing over it? Hover the
      // edge and call it: a ramp means the field is smooth and the culprit is elsewhere — a light's
      // coloration, a darkness source's own disc, the visibility mask — while a step means the blur
      // is not reaching that boundary.
      transect: darknessTexture.transect,
      // Which layer owns a visible edge, once `transect` has shown the field is smooth. Toggles one
      // layer's visibility: "coloration", "darkness", "lights", "visibility". No argument restores
      // everything. Nothing is recomputed, so it leaves no trace.
      isolate: darknessTexture.isolate,
      // The observer-relative half: cells clamped where this observer looks through a
      // darkness, then painted (DESIGN.md §4.3). `shadows > 0, split: 0` means the umbra is
      // real and every cell it lands on was already at or below the clamp.
      paint: tierPaint.stats,
      repaint: () => tierPaint.repaint({ force: true }),

      // §3.4's falloffs as one interpolated mesh each (DESIGN.md §7.0 step 5). `ramps` below
      // `spill.stats().windows` means a window failed to triangulate and is being painted flat;
      // `sortLevels` proves each mesh landed below the ordinary ground cells, which is what lets the
      // umbra clamp overpaint it instead of cutting it.
      gradient: gradient.stats,
      regradient: () => gradient.sync([], { force: true }),
      // §6.4.3 — the one transition width every brightness boundary fades over.
      transitionWidth: transition.width,
      // §6.4.4 — is that width delivered by one blur of the field, or by a gradient per region?
      // Since §6.4.7 it also reports the wall mask: `sharpWalls: true` with `wall.segments: 0` on
      // a walled scene means every edge reported `light === NONE` and there is nothing to protect.
      blur: fieldBlur.status,
      // §6.4.7 on its own — the segments the blur is held off, and how wide the band is.
      walls: wallMask.status,

      // §6.2.9 — what each light's zones resolved to, in luminance, against the ladder they should
      // land on. The one readout answering whether Normal is the same brightness in a dim room as in
      // a dark one, which the map itself cannot be asked.
      zones: clip.zones,

      // Whether darkness sources are being withheld outside the viewer's vision. `applied: true`
      // with `enableVisionMasking: false` is a scene with token vision off, and is the one way
      // this correctly does nothing.
      darknessMask: darknessMask.status,

      // §6.2.11 — greyscale taken over: Foundry's five desaturation routes zeroed, one pass on
      // `canvas.environment` in their place. Takes a point (defaults to the cursor) and reports
      // `pixel`, the rasterised level the filter itself samples there, which separates a wrong
      // greyscale from a wrong field. Every entry under `routes` should read zero or empty; anything
      // else is a second thing desaturating.
      greyscale: greyscale.status,


      // Soft edges on sources — the light-polygon inset and a darkness disc's rim — and whether
      // Foundry is honouring them. `softEdgesAvailable: false` means the performance mode is below
      // Medium and the light half does nothing whatever the setting says.
      //
      // The ground is a different mechanism entirely since §6.4.4 and is not reported here: one blur
      // of the whole brightness field, driven by `transitionWidth`. See `render.blur()`.
      soften: soften.status,

      // Every gate between a darkness source and its animation reaching the screen, plus the
      // observer's senses. Written for a report that two senses taking the same code path behaved
      // differently — run it with each token selected and compare; the field that differs is the
      // answer.
      darknessGates: probe.darknessGates,


      // A/B for a hard-rimmed darkness disc on an otherwise soft map. Every region darker than Dim
      // also gets an `ERASE` mesh in the visibility mask, whose boundary is binary and sits in a
      // different container from the brightness, so §6.4.1's blur cannot reach it. Turn it off and
      // repaint: if the rim softens, that boundary is the cause.
      //
      //   game.pf1Lighting.render.noErase(true)    // then look
      //   game.pf1Lighting.render.noErase(false)   // put it back
      //
      // Not a setting: with it off, a darkness on a globally-lit map stops being dark.
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
      //   game.pf1Lighting.render.levels(null)      // back to the four saved settings
      //
      // Rebuilds immediately and persists nothing — for trying a table against a real map. The four
      // `tierLevel*` world settings are the stored answer (§10.5), and `null` here reloads them, so
      // an experiment is always one call from being undone. Changing any of those settings also
      // overwrites whatever was tried here.
      levels: (next) => {
        const table = next == null ? levels.applyTierTable() : levels.setDarknessTable(next);
        // The light weights are solved from the table, so they move with it.
        ambient.syncLightWeights();
        renderer.rebuild({ force: true });
        canvas.perception.update({ initializeLighting: true, refreshLighting: true, refreshVision: true });
        console.error(`${MODULE_ID} | darkness table`, table);
        return table;
      },
      presets: () => levels.DARKNESS_PRESETS,

      // Which scenes carry a light-level tier, and whether their stored darkness still matches it.
      // `matches: false` on a scene that is not `locked` means the sync did not run, usually because
      // this client was not the active GM when the setting changed.
      scenes: sceneConfig.status,
      resyncScenes: sceneConfig.syncAllScenes,
      // What the four lighting-control buttons do, callable from a macro:
      // `game.pf1Lighting.render.setSceneTier(2)` for Dim. Tier values are in `TIER`.
      setSceneTier: sceneConfig.setSceneTier,

      // The same pair for lights' activation ranges (§10.4.1), which are derived from the tier
      // table in exactly the same way and go stale in exactly the same circumstances.
      lights: lightConfig.status,
      resyncLights: lightConfig.syncAllLights,

      // The appearance settings, in their own window (§10.6).
      visuals: visuals.open,
    },

    // Debug overlay drawing the field's cells on the canvas
    overlay: {
      // The brightness map — the ground regions and tiers the renderer draws from. Every boundary
      // here is a real one in the model; a transition on screen that is not on a line in this
      // overlay was invented by the renderer.
      levels: cellOverlay.levels,
      // The field's own cell decomposition, as against `levels()` above, which shows what the
      // renderer painted. Comparing the two separates a model fault from a drawing one — a tier
      // present here and absent there was lost between the field and the picture.
      //
      // Same signature as `levels` above: bare call toggles, `draw(true)` / `draw(false)` are
      // explicit. It is a persisted setting underneath, unlike `levels()`, which is why calling it
      // with the setting off used to draw nothing and return nothing.
      draw: cellOverlay.show,
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
      // The tier as the current view sees it — `max` over active observers per §5.3, or null in
      // god's eye. What the readout reports.
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
      // Which of Foundry's reveal paths is painting a point for each observer — the readout for
      // wrong-colour or wrong-brightness terrain, as against a wrong tier.
      reveals: probe.reveals,
      mark: probe.mark,
      clearMark: probe.clearMark,
    },
  };

  // No ready banner: console output here is a requested readout or a real failure, nothing else.
});
