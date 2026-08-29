/**
 * **Greyscale, taken over.** DESIGN.md §6.2.11.
 *
 * Hamilcarbarcas, 2026-08-27: *"Rather than hacking together a bunch of rules, I want to do more like what
 * we did with lighting and create one centralized implementation that disables existing routes and
 * implements its own singular application according to our rules."*
 *
 * A creature that sees in black and white falls back on that sense **where there is no light**.
 * Where there is light it uses its eyes, and its eyes see colour. So the boundary between grey and
 * colour is a brightness boundary, and this module already computes, rasterises and blurs exactly
 * one of those.
 *
 * ## Why the first attempt missed, and it is worth keeping
 *
 * The first build patched the primary sprite's shader and the coloration filter, and produced no
 * visible change inside a darkvision radius. The cause is one line
 * (`base-lighting.mjs:395`), which every vision-source layer begins on:
 *
 * ```glsl
 * vec4 baseColor = useSampler ? texture2D(primaryTexture, vSamplerUvs) : vec4(1.0);
 * ```
 *
 * with `u.primaryTexture = canvas.primary.renderTexture` (`point-vision-source.mjs:428`) — the
 * **raw** cached terrain, sampled before the primary sprite's shader ever runs. A vision source
 * does precisely what §6.2.5 found a *darkness* source doing: it takes its own copy of the map and
 * repaints it on its own terms. With `background.visibility: REQUIRED`, darkvision does that across
 * its whole field of view, so the sprite's output is overpainted everywhere it would have mattered.
 *
 * That is the fifth face of §6.2.3's finding, one source class over, and it is the general lesson:
 * **no shader that samples `canvas.primary.renderTexture` can be corrected by changing what the
 * primary sprite does.** Three of the five routes below do exactly that.
 *
 * ## The five routes greyscale reached the screen by
 *
 * | # | Route | Applies to | Samples |
 * | --- | --- | --- | --- |
 * | 1 | `visionMode.canvas.shader` + `canvas.uniforms.saturation` | the whole canvas | raw primary texture |
 * | 2 | vision source **background** layer, `vision.defaults.saturation` | inside the FOV | raw primary texture — **overpaints 1** |
 * | 3 | vision source illumination + coloration layers, same uniform | inside the FOV | — |
 * | 4 | `lighting.*.postProcessingModes: ["SATURATION"]` via `VisualEffectsMaskingFilter` | whole effects layers | — |
 * | 5 | §6.2.5's darkness-shader wrap (ours) | inside a darkness disc | raw primary texture |
 *
 * Five places, four of them core's, three sampling the map independently. Correcting them one at a
 * time is unwinnable, because route 2 wins wherever a vision source paints.
 *
 * ## The takeover
 *
 * Same shape as §7.0's. **Zero every route, then add one pass nothing can repaint over.**
 *
 * {@link neutralise} rebuilds PF1's darkvision `VisionMode` with routes 1–4 set to zero, and route
 * 5 falls silent on its own: `desaturate.currentSaturation()` reads
 * `visionModeOverrides.saturation`, which is now 0, so the darkness wrap becomes an identity
 * without that file being touched. After it runs, nothing in Foundry's pipeline desaturates
 * anything, on any layer, for any observer.
 *
 * {@link buildFilterClass}'s filter is the one pass, on **`canvas.environment`**. That group is
 * `CanvasGroupMixin(PIXI.Container)` — an ordinary container, none of `CachedContainer`'s
 * complications — and it holds `primary` (terrain, tokens, tiles, weather) and `effects` (every
 * lighting layer). `visibility` and `interface` are its *siblings* under `rendered`, so the fog
 * overlay, the grid, nameplates and the UI are outside it and stay in colour.
 *
 * The filter runs after all of that has composited. It cannot be overpainted, it does not care
 * which source sampled which texture, and it is the last thing to touch those pixels.
 *
 * ## The rule it applies
 *
 * ```
 * grey = clamp((level − colourLevel) / (darkLevel − colourLevel), 0, 1) × greyness × fogGate
 * ```
 *
 * `level` is our field, sampled at `vMaskTextureCoord` — the screen UV
 * `AbstractBaseMaskFilter`'s vertex shader exists to provide, and the same basis core samples every
 * screen-sized cached texture on. At or above Dark, fully grey; at or below `colourLevel`, full
 * colour; and **the blurred band between the two rungs is the gradient**, so the greyscale edge is
 * exactly as soft as the brightness edge beside it and moves with `transitionWidth` without reading
 * it. Both rungs come from `darknessTable()`, so retuning the ladder in *Configure Visuals* moves
 * this too.

 *
 * ## What changes visibly, beyond the intent
 *
 * **Tokens grey too.** They are in `primary`. A creature standing in a dark room should not be in
 * colour to an observer who can only see it by darkvision, and today it always is — so this is a
 * correction, but it is a conspicuous one and it is the first thing that will look different.
 *
 * ## This corrects a claim in DESIGN.md
 *
 * §"Colour in an umbra is the coloration layer, never the map" (2026-08-23) said a vision mode's
 * desaturation *"physically cannot be grey in one place and coloured in another"*. True of the code
 * as it stood, false as a general claim, and retracted there.
 */

import { MODULE_ID } from "../constants.mjs";
import { TIER, darknessTable } from "../model/tiers.mjs";

export const SETTING_REGIONAL_GREY = "regionalGreyscale";
export const SETTING_FOG_GREY = "greyscaleInFog";

/**
 * **0 since 2026-08-29** — remembered terrain keeps its colour.
 *
 * @remarks
 * It shipped at 0.5 as a compromise: the boundary this fades across is the viewer's own vision
 * polygon, so at 1 the greyscale edge sweeps the map as they walk. But 0.5 is *also* a moving
 * edge, only a fainter one, and it greys terrain the viewer is remembering rather than seeing —
 * which is the wrong claim. Memory is not a sense with a light level. 0 declines the question.
 *
 * The dial stays because the shader branch is already written and free (`fogGrey < 1.0`), and
 * because a table that wants fog to read as unlit can still ask for it.
 */
const FOG_GREY_DEFAULT = 0;

/**
 * How grey each vision mode's eyes are, captured **before** {@link neutralise} zeroes it.
 *
 * @remarks
 * The takeover destroys its own input. `visionModeOverrides.saturation` was how the observer's
 * greyness was read, and after routes 1–4 are zeroed it reports 0 for everyone — so the filter
 * would correctly compute that nobody sees in black and white. Captured by mode id at neutralise
 * time, which is also the honest record of what was taken away.
 */
const greynessByMode = new Map();

let filter = null;
let neutralised = false;

/* -------------------------------------------- */
/*  Settings                                    */
/* -------------------------------------------- */

export function isEnabled() {
  try {
    return game.settings.get(MODULE_ID, SETTING_REGIONAL_GREY) === true;
  } catch {
    return true;
  }
}

/** How much of the greyscale reaches explored ground outside current vision, 0..1. */
export function fogGrey() {
  try {
    const value = game.settings.get(MODULE_ID, SETTING_FOG_GREY);
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : FOG_GREY_DEFAULT;
  } catch {
    return FOG_GREY_DEFAULT;
  }
}

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTING_REGIONAL_GREY, {
    name: "Greyscale follows the brightness map",
    hint:
      "A creature seeing in black and white sees grey only where the model says there is no " +
      "light, and colour everywhere else. Off restores Foundry's five routes, which between them " +
      "grey the whole canvas whenever a darkvision token is selected.",
    scope: "world",
    // No control surface, matching the module's other corrections of core behaviour. The one
    // number worth tuning is the fog dial below, which does have one.
    config: false,
    type: Boolean,
    default: true,
    onChange: () => {
      sync();
      // **F5 for the off→on direction, and this cannot do it.** `neutralise` runs once at `setup`
      // and rebuilding the vision mode mid-session would leave every already-initialised vision
      // source holding the old one. Off→off-looking is handled: the filter detaches and the routes
      // stay zeroed, which is *no* greyscale rather than Foundry's. Stated in Appendix B.5.
      if (canvas?.ready) canvas.perception.update({ refreshLighting: true, refreshVision: true });
    },
  });

  game.settings.register(MODULE_ID, SETTING_FOG_GREY, {
    name: "Greyscale in explored fog",
    hint:
      "How much of the greyscale treatment reaches explored ground you cannot currently see. 0 " +
      "leaves remembered terrain in full colour; 1 treats it exactly like ground in view. The " +
      "middle exists because the boundary is your vision polygon, which moves with you.",
    scope: "world",
    // **No control surface since 2026-08-29.** It had a row in *Configure Visuals* and came out
    // with `darknessAnimationStrength`: the default is now 0, which is *off*, so the row was a
    // slider whose whole range is a deliberate departure from the shipped answer. Console only —
    // `game.pf1Lighting.settings("greyscaleInFog", 0.5)`.
    config: false,
    type: Number,
    range: { min: 0, max: 1, step: 0.05 },
    default: FOG_GREY_DEFAULT,
    // Read live in the filter's `apply`, so nothing has to be rebuilt.
    onChange: () => {},
  });
}

/* -------------------------------------------- */
/*  The ramp                                    */
/* -------------------------------------------- */

/**
 * The two rungs the greyscale ramp spans, in darkness-level units.
 *
 * @remarks
 * Read live: the ladder is four world settings (§10.5) and `render.levels()` can replace the whole
 * table against a live scene without persisting anything.
 *
 * **The bright end is Dim, and it stays there.** Anchoring it at Normal was tried on 2026-08-27 to
 * suppress a gold halo at a darkness rim and was reverted the same day: Dim in full colour is what
 * darkvision should look like, and the halo was a clamp-geometry fault wearing a colour costume —
 * `render/paint.mjs`'s collar was ramping the umbra open around its own holes. Fixed there. **The
 * lesson is the one worth keeping: a wrong picture in this file is usually a right reading of a
 * wrong field.**
 *
 * Guarded against a degenerate ladder. A world setting the two rungs equal would otherwise divide
 * by zero and get a NaN, which reads as *no greyscale anywhere* — a failure that would be blamed on
 * this rather than on the ladder.
 */
function rungs() {
  const table = darknessTable();
  const dark = table[TIER.DARK] ?? 1;
  const colour = table[TIER.DIM] ?? 2 / 3;
  return { colour, dark: Math.max(dark, colour + 0.001) };
}

/**
 * How grey the current observer's eyes are, 0..1.
 *
 * @remarks
 * Read from the **single vision source** Foundry itself picks for canvas-wide tinting
 * (`visibility.mjs:196`). With two vision sources active core already picks one of them for every
 * canvas-wide effect, and inventing a second answer here would put the greyscale out of step with
 * everything else that follows that choice.
 *
 * Keyed on `visionMode.id` rather than on the source's overrides, because {@link neutralise} has
 * set those to zero — see {@link greynessByMode}.
 */
export function observerGreyness() {
  if (!isEnabled()) return 0;
  const source = canvas?.visibility?.visionModeData?.source;
  const id = source?.visionMode?.id;
  return greynessByMode.get(id) ?? 0;
}

/* -------------------------------------------- */
/*  1. Disable every existing route             */
/* -------------------------------------------- */

/**
 * Zero Foundry's five desaturation routes for darkvision.
 *
 * @remarks
 * **`setup`, and it has to be.** PF1 assigns `CONFIG.Canvas.visionModes.darkvision` during `init`
 * (`pf1.mjs:261`); anything earlier is overwritten. `VisionMode` is a `DataModel` whose fields
 * validate on assignment, so the mode is rebuilt from `toObject()` rather than mutated — the same
 * round trip PF1 itself uses (`pf1/canvas/vision-modes.mjs:11-15`) — and reconstructed through
 * `mode.constructor`, so a PF1 subclass survives it.
 *
 * What each line switches off, in the numbering of the table at the top of this file:
 *
 * - **1** `canvas.uniforms.saturation` — the primary sprite's whole-canvas adjustment. The shader
 *   is left installed rather than reset to `BaseSamplerShader`: with every adjustment at zero it
 *   is a passthrough, and keeping it preserves the `tint` path, which a source can still set
 *   through `visionModeOverrides.colorRGB` and which is not ours to remove.
 * - **2, 3** `vision.defaults.saturation` — every layer the vision source paints.
 * - **4** `postProcessingModes` on all four lighting channels. Darkvision carries none; cleared
 *   anyway, because "this mode happens not to use route 4" is a fact about today's `config.mjs`.
 * - **5** falls silent by itself. `desaturate.currentSaturation()` reads
 *   `visionModeOverrides.saturation`, which line 2 has just set to 0, so the darkness-shader wrap
 *   mixes by zero. Its *other* half — `observerIgnoresDarkness`, blindsight withholding the mesh —
 *   reads actor senses and is untouched.
 *
 * `vision.darkness.adaptive` is put back to core's `false`. The first build set it true to reach
 * `background-vision.mjs:11`; with the saturation it was gating now zero, that mix is an identity
 * either way, and false is the smaller deviation.
 *
 * **Darkvision only.** `monochromatic` and `lightAmplification` keep every route they have:
 * monochromatic models an eye that cannot see colour *at all*, which is not a statement about
 * where the light is, and amplification is a different effect wearing the same shader.
 */
export function neutralise() {
  if (neutralised) return;
  if (!isEnabled()) return;

  const mode = CONFIG.Canvas?.visionModes?.darkvision;
  if (!mode) return;
  neutralised = true;

  const data = mode.toObject();

  // Captured before it is destroyed. Both routes state the same fact about the eye; the vision
  // source's own default is the one core treats as authoritative, with the canvas uniform as the
  // fallback for a mode that only carries the sprite half.
  const greyness = Math.clamp(
    -(data.vision?.defaults?.saturation ?? data.canvas?.uniforms?.saturation ?? 0),
    0,
    1
  );
  greynessByMode.set(data.id ?? "darkvision", greyness);

  if (data.canvas?.uniforms) data.canvas.uniforms.saturation = 0;
  if (data.vision?.defaults) data.vision.defaults.saturation = 0;
  if (data.vision?.darkness) data.vision.darkness.adaptive = false;
  for (const channel of ["background", "coloration", "illumination", "darkness"]) {
    const lighting = data.lighting?.[channel];
    if (lighting) lighting.postProcessingModes = [];
  }

  CONFIG.Canvas.visionModes.darkvision = new mode.constructor(data);
}

/* -------------------------------------------- */
/*  2. One pass, at the end                     */
/* -------------------------------------------- */

/**
 * Desaturate the composited scene by the brightness field.
 *
 * @remarks
 * Built on `AbstractBaseMaskFilter` for its vertex shader alone. `vMaskTextureCoord` is
 * `(vTextureCoord × inputSize.xy + outputFrame.xy) / screenDimensions` — the screen UV of the
 * fragment, correct even when the filter is handed a sub-rect of the screen, which `vTextureCoord`
 * on its own is not. Both textures sampled through it are screen-sized cached ones, which is the
 * case that varying exists for, and `apply` there keeps `screenDimensions` current across a resize.
 *
 * **Unpremultiplied for the luma, repremultiplied after.** A filter's input is premultiplied
 * alpha; taking `perceivedBrightness` of `rgb` without dividing by `a` reads a half-transparent
 * fragment as darker than it is, which shows as a grey halo around anything soft-edged.
 */
function buildFilterClass() {
  const Base = foundry.canvas.rendering.filters.AbstractBaseMaskFilter;

  return class MonochromeFilter extends Base {
    static defaultUniforms = {
      darknessTexture: null,
      visionTexture: null,
      screenDimensions: [1, 1],
      strength: 0,
      colourLevel: 2 / 3,
      darkLevel: 1,
      // Overwritten from {@link fogGrey} on the first `apply`; this is only what the filter
      // holds between construction and that call. Tracks {@link FOG_GREY_DEFAULT} so the two
      // cannot disagree during that window.
      fogGrey: FOG_GREY_DEFAULT,
    };

    static fragmentShader = `
  precision ${PIXI.settings.PRECISION_FRAGMENT} float;
  varying vec2 vTextureCoord;
  varying vec2 vMaskTextureCoord;
  uniform sampler2D uSampler;
  uniform sampler2D darknessTexture;
  uniform sampler2D visionTexture;
  uniform float strength;
  uniform float colourLevel;
  uniform float darkLevel;
  uniform float fogGrey;

  void main() {
    vec4 color = texture2D(uSampler, vTextureCoord);

    if ( (strength > 0.0) && (color.a > 0.0) ) {
      float level = texture2D(darknessTexture, vMaskTextureCoord).r;
      float grey = clamp((level - colourLevel) / (darkLevel - colourLevel), 0.0, 1.0) * strength;

      // \`step(0.001, …)\` rather than \`> 0.0\` is core's own idiom for this texture
      // (\`darkness-lighting.mjs:93\`), and the epsilon matters: the vision mask is antialiased at
      // its rim, so a strict test flickers along the polygon edge as the observer moves.
      if ( fogGrey < 1.0 ) {
        grey *= mix(fogGrey, 1.0, step(0.001, texture2D(visionTexture, vMaskTextureCoord).r));
      }

      vec3 straight = color.rgb / color.a;
      float lum = dot(straight, vec3(0.2126, 0.7152, 0.0722));
      color.rgb = mix(color.rgb, vec3(lum) * color.a, grey);
    }

    gl_FragColor = color;
  }`;

    /**
     * @override
     * @remarks
     * Every uniform is written per frame, and each for its own reason: the ladder is retunable live,
     * the fog dial is a slider, which token is selected decides `strength`, and both render textures
     * are recreated on resize. Nothing here is safe to capture at construction.
     */
    apply(filterManager, input, output, clear, currentState) {
      const u = this.uniforms;
      const { colour, dark } = rungs();
      u.strength = observerGreyness();
      u.colourLevel = colour;
      u.darkLevel = dark;
      u.fogGrey = fogGrey();
      u.darknessTexture = canvas?.effects?.illumination?.renderTexture ?? PIXI.Texture.WHITE;
      u.visionTexture = canvas?.masks?.vision?.renderTexture ?? PIXI.Texture.WHITE;
      super.apply(filterManager, input, output, clear, currentState);
    }
  };
}

/**
 * The class, built once on first use.
 *
 * @remarks
 * **Lazily, and not as a module-scope `class … extends`.** Both the base class and
 * `PIXI.settings.PRECISION_FRAGMENT` would then be dereferenced at *import* time, which is before
 * `init` — and a module that throws while being imported does not merely fail, it takes its own
 * error handling with it. Every other patch in this module is built inside a function for the same
 * reason.
 */
function filterClass() {
  FilterClass ??= buildFilterClass();
  return FilterClass;
}

let FilterClass = null;

/**
 * Attach or remove the pass.
 *
 * @remarks
 * `canvas.environment` is rebuilt on every canvas draw, so this runs at `canvasReady` rather than
 * once. Appends rather than assigns: the group carries no filters of its own today — the ambience
 * filter lives on `canvas.primary` (`primary.mjs:180-186`) — but replacing an array we did not
 * create is how a module breaks the next one.
 *
 * **No teardown counterpart, deliberately.** A `PIXI.Filter` is not bound to the container that
 * lists it, so the one instance is reused across canvas draws — one allocation, and `canvasReady`
 * re-attaches it to the new group. The other `dispose` exports in `render/` exist because their
 * subjects are meshes and textures owned by a scene; this one would have nothing to release.
 *
 * `filterArea` is the renderer screen, matching every other full-screen filter Foundry attaches.
 * Without it PIXI derives the area from the group's bounds, which on a scene larger than the
 * viewport is the whole map: the filter would allocate a render target the size of the scene.
 */
export function sync() {
  const group = canvas?.environment;
  if (!group) return null;

  if (!isEnabled()) {
    if (filter && group.filters?.includes(filter)) {
      group.filters = group.filters.filter((f) => f !== filter);
    }
    return null;
  }

  filter ??= filterClass().create();
  group.filterArea = canvas.app.renderer.screen;
  if (!group.filters?.includes(filter)) group.filters = [...(group.filters ?? []), filter];

  return { attached: true };
}

export function registerHooks() {
  Hooks.on("canvasReady", () => sync());
}

/* -------------------------------------------- */
/*  Readout                                     */
/* -------------------------------------------- */

/**
 * Debug readout.
 *
 * @remarks
 * Reports **both** halves, because the two failures look nothing alike and each is diagnostic on
 * its own:
 *
 * - A non-zero value in `routes` means something is still desaturating besides us, and the picture
 *   will be grey where the field says it should not be. That is the takeover leaking.
 * - `attached: false`, or `strength: 0` with a darkvision token selected, means the pass is not
 *   running and the picture will be **fully coloured** — which after neutralisation is a different
 *   wrong from what Foundry does, so it cannot be mistaken for "the feature is off".
 *
 * `pixel` is the decisive number and is why this readout takes a point. It is the **rasterised**
 * level the filter itself samples, read back from the same texture — not `getDarknessLevel`, which
 * is a JS ring test and can disagree. If `pixel` is low where the ground looks dark, the fault is
 * in the field and no amount of work here will fix it; `render.meshAt()` then says which mesh
 * failed to paint.
 *
 * @param {number} [x] - Defaults to the cursor
 * @param {number} [y]
 */
export function status(x, y) {
  const mode = CONFIG.Canvas?.visionModes?.darkvision;
  const group = canvas?.environment;
  const point = x === undefined ? (canvas?.mousePosition ?? { x: 0, y: 0 }) : { x, y };
  const { colour, dark } = rungs();

  let pixel = null;
  try {
    const texture = canvas.effects.illumination.renderTexture;
    const screen = canvas.stage.worldTransform.apply(point);
    const frame = new PIXI.Rectangle(Math.round(screen.x), Math.round(screen.y), 1, 1);
    pixel = canvas.app.renderer.extract.pixels(texture, frame)?.[0] / 255;
  } catch (error) {
    console.error(`${MODULE_ID} | texture readback failed`, error);
  }

  const report = {
    enabled: isEnabled(),

    // **All five routes should read zero or empty.** Anything else is a second thing desaturating.
    neutralised,
    routes: {
      spriteSaturation: mode?.canvas?.uniforms?.saturation ?? null,
      visionSaturation: mode?.vision?.defaults?.saturation ?? null,
      adaptive: mode?.vision?.darkness?.adaptive ?? null,
      postProcess: ["background", "coloration", "illumination", "darkness"]
        .flatMap((c) => mode?.lighting?.[c]?.postProcessingModes ?? []),
      // Route 5, read where it is consumed rather than where it is declared.
      darknessWrap: canvas?.visibility?.visionModeData?.source?.visionModeOverrides?.saturation ?? null,
    },

    // The pass.
    attached: !!filter && (group?.filters?.includes(filter) ?? false),
    // Above zero only while a grey-vision token is the single vision source.
    strength: observerGreyness(),
    capturedModes: Object.fromEntries(greynessByMode),

    // The ramp, in darkness-level units: the Dim and Dark rungs. A level at or below `colour` is
    // fully coloured, one at or above `dark` fully grey.
    colour,
    dark,
    fogGrey: fogGrey(),

    // **What the filter actually samples at the point.** See the remarks — this is the one number
    // that separates "the greyscale is wrong" from "the field is wrong".
    point: { x: Math.round(point.x), y: Math.round(point.y) },
    pixel,
    grey: pixel == null ? null : Math.min(1, Math.max(0, (pixel - colour) / (dark - colour))),
  };
  console.error(`${MODULE_ID} | greyscale`, report);
  return report;
}
