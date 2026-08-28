/**
 * What the viewer is shown where they cannot see. Two corrections, one concern.
 *
 * Both are about the same leak — the model becoming visible through fog — and they turned out to
 * live in different places, which is why there are two of them and why the first one alone did
 * not fix the report.
 *
 * 1. {@link applyPatch} — the **darkness layer** is the one effects layer core never
 *    vision-masks, so a darkness *source mesh* draws through walls.
 * 2. {@link applyFilterPatch} — the illumination filter's **replacement colour for unseen
 *    areas** is sampled from the darkness-level texture, which since §7.0 is where this module
 *    writes its model. Fog therefore reproduces every darkness disc and umbra we paint.
 *
 * The second is the one that mattered. Kept together because a future reader chasing "the model
 * is visible in fog" will land on one of them and needs to know about the other.
 *
 * ---
 *
 * # 1. Vision-masking the darkness layer
 *
 * ## The asymmetry
 *
 * Three of the four effect layers install a `VisualEffectsMaskingFilter` in their `_draw`:
 *
 * | Layer | Filter |
 * | --- | --- |
 * | `background-effects.mjs:58` | masking filter, `FILTER_MODES.BACKGROUND` |
 * | `illumination-effects.mjs:119` | masking filter, `FILTER_MODES.ILLUMINATION` |
 * | `coloration-effects.mjs:45` | masking filter, `FILTER_MODES.COLORATION` |
 * | `darkness-effects.mjs:27` | **a plain `VoidFilter`** |
 *
 * That filter's core is one `mix` (`effects-masking.mjs:173`):
 *
 * ```glsl
 * finalColor = mix(getReplacementColor(), finalColor, texture2D(visionTexture, vMaskTextureCoord).r);
 * ```
 *
 * Where the vision mask reads zero, the layer contributes its replacement colour instead of what
 * it drew. Light and colour get that treatment. Darkness does not — so a `PointDarknessSource`
 * composites its darkened copy of the map everywhere it reaches, seen or not.
 *
 * In stock Foundry that barely surfaces, because a darkness source is rare set dressing. In a
 * module built on them it is a live information leak: reported 2026-08-27 as players watching
 * darkness bubbles move through rooms they had no vision into.
 *
 * ## Why it looked like two different bugs
 *
 * Umbras appeared to behave correctly and darkness circles did not, which sent the first round of
 * diagnosis at `vision/umbra-mask.mjs` — wrongly. The split is a rendering one: with the §7.0
 * takeover on, `darkeningStrength` withholds the source mesh for every tier **but** Supernatural
 * Dark, so an ordinary *darkness* is a `dark` region in the illumination texture — already masked
 * — while a supernatural one is drawn as a source mesh on this layer, and is not.
 *
 * It also explains why it only showed at normal or bright scene darkness. The leak is a
 * *darkened* copy of the map, and that is only distinguishable from its surroundings when the
 * surroundings are bright.
 *
 * ## The fix, and why `BACKGROUND`
 *
 * `getReplacementColor` returns `vec4(0.0)` for mode 0 (`effects-masking.mjs:154`) — contribute
 * nothing where unseen — which is exactly right for a layer drawn at `BLEND_MODES.NORMAL`.
 * `ILLUMINATION` would substitute the ambient colour and `COLORATION` its own replacement, both
 * of which would paint something into the dark rather than withholding it.
 *
 * Registering in `canvas.effects.visualEffectsMaskingFilters` is not bookkeeping: core owns the
 * `enableVisionMasking` uniform through `toggleMaskingFilters` (`groups/effects.mjs:425`), so a
 * scene with token vision disabled switches this off exactly as it switches off the other three.
 * Without the registration the darkness layer would stay masked on a scene where nothing else
 * was, which is a worse asymmetry than the one being fixed.
 *
 * ## Scope
 *
 * This changes core behaviour for **every** darkness source, including other modules'. The
 * argument for doing it anyway is consistency: darkness starts behaving the way light already
 * does. Patrick's call, 2026-08-27, with that stated.
 *
 * It follows observer mode for free, because `canvas.masks.vision` is whatever the current
 * viewer's mask is — so with *GM sees through the selected token* on, darkness outside that
 * token's vision stops being drawn for the GM too.
 */

import { MODULE_ID } from "../constants.mjs";
import { TIER, darknessTable } from "../model/tiers.mjs";

export const SETTING_DARKNESS_MASK = "maskDarknessByVision";

const PATCH_MARK = "pf1LightingDarknessMasked";

let patched = false;
let lastPass = null;

export function isEnabled() {
  try {
    return game.settings.get(MODULE_ID, SETTING_DARKNESS_MASK) === true;
  } catch {
    return true;
  }
}

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTING_DARKNESS_MASK, {
    name: "Darkness is hidden where a creature cannot see",
    hint:
      "Stops a darkness source from being drawn in areas outside the viewer's vision. Foundry " +
      "masks its light and colour layers this way and does not mask darkness, so a darkness " +
      "bubble is otherwise visible — and visibly moving — through walls.",
    scope: "world",
    // No control surface, matching the module's other corrections of core behaviour. Reachable
    // from the console — see `game.pf1Lighting.settings`.
    config: false,
    type: Boolean,
    default: true,
    onChange: () => {
      // The filter is built in `_draw`, so the switch takes effect on the next canvas draw.
      if (canvas?.ready) canvas.draw();
    },
  });

  game.settings.register(MODULE_ID, SETTING_FOG_IGNORES_MODEL, {
    name: "Unseen areas read as Dark",
    hint:
      "Foundry paints areas a creature cannot see from the darkness-level texture, which this " +
      "module writes its light levels into — so every darkness bubble and umbra shows through " +
      "fog. With this on, unseen ground reads at the model's Dark level instead: one fixed " +
      "brightness, the same on every scene. It also stops the coloration layer adding a wash " +
      "there, which Foundry scales by the scene's global illumination.",
    scope: "world",
    // No control surface, matching the module's other corrections of core behaviour.
    config: false,
    type: Boolean,
    default: true,
    // No redraw: the shader keeps both branches and `apply` picks between them every frame.
    onChange: () => {},
  });

  game.settings.register(MODULE_ID, SETTING_UNSEEN_DIMMING, {
    name: "Dimming of explored ground you cannot see",
    hint:
      "How far explored ground outside the viewer's current vision is taken toward black, on top " +
      "of already being drawn at Dark. Foundry hard-codes this at 0.5, which stacks badly on dark " +
      "terrain. Unexplored ground stays solid black either way — that distinction is the one " +
      "thing the fog overlay carries that nothing else does.",
    scope: "world",
    // No control surface, matching the module's other corrections of core behaviour.
    config: false,
    type: Number,
    range: { min: 0, max: 1, step: 0.05 },
    default: 0.2,
    // Read live in `apply`, so nothing has to be rebuilt.
    onChange: () => {},
  });
}

/* -------------------------------------------- */
/*  3. How dark explored-but-unseen ground goes */
/* -------------------------------------------- */

export const SETTING_UNSEEN_DIMMING = "unseenDimming";

const FOW_MARK = "pf1LightingFowFilter";
let fowPatched = false;

/** How far explored-but-currently-unseen ground is taken toward black, 0..1. */
export function unseenDimming() {
  try {
    const value = game.settings.get(MODULE_ID, SETTING_UNSEEN_DIMMING);
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.2;
  } catch {
    return 0.2;
  }
}

/**
 * Make the fog-of-war overlay's *explored* dimming adjustable. Core hard-codes it at 0.5.
 *
 * @remarks
 * **This is a third, separate darkening of unseen ground, and it stacks on the other two.** The
 * texture is already clamped to Dark there (§4.3.1) and the masking filter already replaces the
 * colour (§6.2.10); then `VisibilityFilter` composites a fog overlay on top of the finished scene,
 * and its explored branch is `vec4(…, 0.5)` — half black, on ground that is already at the
 * model's darkest tier. Reported 2026-08-27 as too dark next to dark terrain, which is exactly
 * what three darkenings in a row would look like.
 *
 * **Unexplored is deliberately untouched.** It is `vec4(unexploredColor, 1.0)` — solid black — and
 * that is the one distinction the fog overlay carries that nothing else does: *never been there*
 * against *cannot see right now*. Flattening the two would lose real information.
 *
 * A targeted substitution rather than a copy of the whole program, which is the opposite of the
 * choice {@link applyFilterPatch} makes, and the difference is that `fragmentShader` is a
 * **method** here rather than a static template. Copying it would mean reproducing both of its
 * option branches and re-deriving them on every Foundry release; substituting into its output
 * inherits whatever core does. The match is checked and reported, so a version bump that moves the
 * literal shows up in {@link status} rather than silently doing nothing.
 */
export function applyFowPatch() {
  if (fowPatched) return;
  const Base = CONFIG.Canvas?.visibilityFilter;
  if (!Base || Base[FOW_MARK]) return;
  fowPatched = true;

  CONFIG.Canvas.visibilityFilter = class extends Base {
    static [FOW_MARK] = true;

    static defaultUniforms = { ...Base.defaultUniforms, pf1ExploredAlpha: 0.2 };

    /** Whether the substitution took, for {@link status}. */
    static pf1Matched = null;

    /** @override */
    static fragmentShader(options = {}) {
      const source = super.fragmentShader(options);
      // The persistent-vision variant has no explored branch at all, so a miss there is correct
      // rather than a breakage — only report one when the branch is present.
      const expected = source.includes("exploredColor");
      const patched = source
        .replace("vec3(1.0)), 0.5)", "vec3(1.0)), pf1ExploredAlpha)")
        .replace("uniform vec3 unexploredColor;", "uniform vec3 unexploredColor;\n    uniform float pf1ExploredAlpha;");

      const took = patched !== source;
      if (expected && !took) {
        console.error(
          `${MODULE_ID} | fog dimming: core's VisibilityFilter no longer matches — leaving it alone.`
        );
      }
      if (expected) CONFIG.Canvas.visibilityFilter.pf1Matched = took;
      return took ? patched : source;
    }

    /** @override */
    apply(filterManager, input, output, clear, currentState) {
      // Live, so the setting is a slider rather than a redraw.
      if ("pf1ExploredAlpha" in this.uniforms) this.uniforms.pf1ExploredAlpha = unseenDimming();
      super.apply(filterManager, input, output, clear, currentState);
    }
  };
}

/**
 * Swap the darkness layer's `VoidFilter` for a vision-masking one.
 *
 * @remarks
 * A prototype patch on `_draw` rather than a `CONFIG` class swap, because there is no CONFIG slot
 * for this layer — `groups/effects.mjs:125` constructs `CanvasDarknessEffects` directly.
 *
 * The original is called first and its filter discarded, rather than reimplemented. `_draw` is
 * three lines today and reimplementing it would silently drop anything a future version adds; one
 * wasted `VoidFilter.create()` per canvas draw is not a cost worth avoiding.
 */
export function applyPatch() {
  if (patched) return;
  const proto = foundry.canvas.layers?.CanvasDarknessEffects?.prototype;
  if (!proto?._draw || proto[PATCH_MARK]) return;
  patched = true;
  proto[PATCH_MARK] = true;

  const original = proto._draw;
  proto._draw = async function pf1LightingDarknessDraw(...args) {
    const result = await original.apply(this, args);
    if (!isEnabled()) {
      lastPass = { applied: false, reason: "disabled" };
      return result;
    }

    try {
      const Masking = CONFIG.Canvas.visualEffectsMaskingFilter;
      const filter = Masking.create({
        visionTexture: canvas.masks.vision.renderTexture,
        darknessLevelTexture: canvas.effects.illumination.renderTexture,
        // Mode 0. Its replacement colour is transparent, so an unseen area gets *nothing* from
        // this layer rather than a substituted colour — see the file header.
        mode: Masking.FILTER_MODES.BACKGROUND,
      });
      // The `VoidFilter` this replaces was `NORMAL`; the darkness layer alters the primary
      // texture by drawing over it, not by multiplying into it as illumination does.
      filter.blendMode = PIXI.BLEND_MODES.NORMAL;

      this.filter = filter;
      this.filterArea = canvas.app.renderer.screen;
      this.filters = [filter];
      canvas.effects.visualEffectsMaskingFilters.add(filter);

      lastPass = { applied: true, mode: Masking.FILTER_MODES.BACKGROUND };
    } catch (error) {
      // A filter fault must never stop the canvas drawing. Failing open leaves core's own
      // `VoidFilter` in place, which is the pre-patch picture rather than a broken one.
      console.error("PF1 Lighting | darkness vision mask failed", error);
      lastPass = { applied: false, reason: error?.message ?? "error" };
    }

    return result;
  };
}

/* -------------------------------------------- */
/*  2. Fog must not read the model                */
/* -------------------------------------------- */

/**
 * # 2. The replacement colour for unseen areas
 *
 * **This is the one that mattered**, and the first patch above changed almost nothing because it
 * was one layer too high. Confirmed 2026-08-27 by switching `ambientTakeover` off and watching
 * the discs leave the fog.
 *
 * Core paints unseen areas from `getReplacementColor()` (`effects-masking.mjs:153-158`):
 *
 * ```glsl
 * vec4 getReplacementColor() {
 *   if ( mode == 0 ) return vec4(0.0);
 *   if ( mode == 2 ) return vec4(replacementColor, 1.0);
 *   float darknessLevel = texture2D(darknessLevelTexture, vMaskTextureCoord).r;
 *   return vec4(mix(ambientDaylight, ambientDarkness, darknessLevel), 1.0);
 * }
 * ```
 *
 * and `illumination-effects.mjs:120` supplies `darknessLevelTexture:
 * canvas.effects.illumination.renderTexture`, which is `darknessLevelMeshes.renderTexture` — the
 * container `render/darkness-texture.mjs` writes the model into.
 *
 * So fog is not failing to hide the model. It is **rendering it on purpose**, per fragment, from
 * a texture that in stock Foundry only ever holds static region data. Every `dark` cell — every
 * darkness bubble, every umbra clamp — is reproduced faithfully in the dark.
 *
 * That also explains the two things that never fitted a simpler story. The circles were *texture
 * regions*, not meshes — §6.4.1 measured one darkness source drawn out of seven with the takeover
 * on, because `darkeningStrength` withholds the mesh for every tier but Supernatural Dark — so
 * patch 1 had almost nothing to act on. And it only showed at normal or bright scene darkness
 * because the replacement is `mix(ambientDaylight, ambientDarkness, darknessLevel)`: at high
 * darkness both ends of that mix are nearly the same colour and the discs vanish into it.
 *
 * ## The fix
 *
 * Read the **scene's own** darkness level instead of the texture. Unseen ground then renders at
 * the scene's ambient, which is both the stock behaviour and what Patrick named as correct
 * (2026-08-27): *"areas with no vision have their brightness still determined by ambient level,
 * so those areas behind walls and whatnot being brighter is normal."*
 *
 * A `CONFIG.Canvas.visualEffectsMaskingFilter` swap rather than a prototype patch, because that
 * is a real config slot (`config.mjs:701`) and every layer reads it fresh in `_draw`. Built from
 * whatever is currently installed rather than from the core class, so a module that got there
 * first keeps its behaviour — the same discipline as `render/pool.mjs`.
 *
 * ## The consequence, accepted
 *
 * §10.7's ambient regions stop showing through fog too — an unlit cellar reads at scene
 * brightness in unexplored area. Patrick's call, 2026-08-27. Separating them would mean a second
 * darkness-level texture holding only the static half, which is a great deal of machinery to
 * reveal architecture the map already shows.
 */
export const SETTING_FOG_IGNORES_MODEL = "fogIgnoresModel";

const FILTER_MARK = "pf1LightingFogFilter";

let filterPatched = false;

export function fogIgnoresModel() {
  try {
    return game.settings.get(MODULE_ID, SETTING_FOG_IGNORES_MODEL) === true;
  } catch {
    return true;
  }
}

/**
 * Swap `CONFIG.Canvas.visualEffectsMaskingFilter` for one whose unseen replacement ignores the
 * darkness-level texture.
 *
 * @remarks
 * The header is copied from core with **one line changed**, rather than assembled by string
 * surgery on the original. `fragmentHeader` is a static template literal that interpolates
 * `${this.CONSTANTS}` and `${this.PERCEIVED_BRIGHTNESS}` at class-definition time, so a subclass
 * gets those for free; but a textual `replace()` against it would fail silently the first time
 * core reformatted a line, and a shader that silently stops masking looks exactly like one that
 * is working. A copy breaks loudly on a version bump instead — see the `SATURATION` note in
 * `render/desaturate.mjs` for the other half of this trade.
 */
export function applyFilterPatch() {
  if (filterPatched) return;
  const Base = CONFIG.Canvas?.visualEffectsMaskingFilter;
  if (!Base || Base[FILTER_MARK]) return;
  filterPatched = true;

  CONFIG.Canvas.visualEffectsMaskingFilter = class extends Base {
    static [FILTER_MARK] = true;

    static defaultUniforms = { ...Base.defaultUniforms, pf1SceneDarkness: 0 };

    static fragmentHeader = `
    varying vec2 vTextureCoord;
    varying vec2 vMaskTextureCoord;
    uniform float contrast;
    uniform float saturation;
    uniform float exposure;
    uniform vec3 ambientDarkness;
    uniform vec3 ambientDaylight;
    uniform vec3 replacementColor;
    uniform vec3 tint;
    uniform sampler2D uSampler;
    uniform sampler2D visionTexture;
    uniform sampler2D darknessLevelTexture;
    uniform bool enableVisionMasking;
    uniform int mode;
    uniform float pf1SceneDarkness;
    vec4 baseColor;
    vec4 finalColor;
    ${this.CONSTANTS}
    ${this.PERCEIVED_BRIGHTNESS}

    vec4 getReplacementColor() {
      if ( mode == 0 ) return vec4(0.0);
      if ( mode == 2 ) return vec4(replacementColor, 1.0);
      // **The only line that differs from core.** It samples \`darknessLevelTexture\` here, which
      // since §7.0 is this module's model — so fog reproduced every darkness disc and umbra in
      // it. A negative \`pf1SceneDarkness\` is the off switch and restores core's behaviour
      // exactly, so the setting needs no second shader.
      float darknessLevel = pf1SceneDarkness >= 0.0
        ? pf1SceneDarkness
        : texture2D(darknessLevelTexture, vMaskTextureCoord).r;
      return vec4(mix(ambientDaylight, ambientDarkness, darknessLevel), 1.0);
    }
    `;

    /** @override */
    apply(filterManager, input, output, clear, currentState) {
      if (this.uniforms.mode === this.constructor.FILTER_MODES.ILLUMINATION) {
        // Read live, per frame. Foundry *animates* darkness transitions without firing a document
        // update, so a value cached at filter creation is correct only until someone drags the
        // slider — the same trap `registry.ambientTier` is read live to avoid.
        //
        // `-1` is not a darkness level; it is the sentinel the shader reads as "use the texture",
        // which is what makes the setting a live toggle rather than a redraw.
        //
        // **The model's Dark, not the scene's darkness** (Patrick, 2026-08-27: *"a dark cell as
        // identified by our model should be the exact same pixel coloration regardless of
        // illumination settings"*). This line used to read `canvas.environment.darknessLevel`,
        // which made every unseen fragment on the map — most of a player's view — render at
        // whatever the scene's global-illumination slider said. That was the largest of the
        // remaining leaks and it was ours, introduced by §6.2.8 for a reason that has since been
        // solved better: §4.3.1 already clamps unseen ground to Dark *in the texture*, so there
        // are no darkness discs left in it to bleed through, and the constant here is now simply
        // the same answer arrived at from the other side.
        this.uniforms.pf1SceneDarkness = fogIgnoresModel() ? darknessTable()[TIER.DARK] : -1;
      } else if (
        this.uniforms.mode === this.constructor.FILTER_MODES.COLORATION &&
        fogIgnoresModel()
      ) {
        // **The coloration layer blends `ADD`** (`coloration-effects.mjs:47`), and core replaces
        // its unseen fragments with `canvas.colors.background` (`effects.mjs:239`) — which is
        // `mix(darkness, daylight, 1 − sceneDarkness)`. So every pixel a viewer cannot see had a
        // grey *added* to it in proportion to the scene's global-illumination slider. Third of the
        // three leaks behind Patrick's report, and the only one that is core's rather than ours.
        //
        // Black is not a tuning choice, it is the identity for an additive layer: no coloured
        // light reaches ground you cannot see. Assigned per frame because `refreshLighting`
        // rewrites the uniform from `colors.background` whenever the environment changes.
        const c = this.uniforms.replacementColor;
        if (c) c[0] = c[1] = c[2] = 0;
      }
      super.apply(filterManager, input, output, clear, currentState);
    }
  };
}

/**
 * Whether either correction is actually in force.
 *
 * @remarks
 * `applied: true` with `enableVisionMasking: false` is the expected state on a scene with token
 * vision off — core toggles the uniform across every registered filter — and is the one way the
 * layer mask correctly does nothing.
 *
 * `fogFilter: false` with `fogIgnoresModel: true` means the CONFIG swap did not happen, which on
 * a live world means another module replaced the class after `init`.
 */
export function status() {
  const filter = canvas?.effects?.darkness?.filter;
  const illumination = canvas?.effects?.illumination?.filter;
  const report = {
    patched,
    enabled: isEnabled(),
    ...(lastPass ?? { applied: false, reason: "not drawn yet" }),
    registered: canvas?.effects?.visualEffectsMaskingFilters?.has(filter) ?? false,
    enableVisionMasking: filter?.uniforms?.enableVisionMasking ?? null,
    tokenVision: canvas?.scene?.tokenVision ?? null,

    // The half that fixes the model showing through fog.
    fogIgnoresModel: fogIgnoresModel(),
    fogFilter: CONFIG.Canvas?.visualEffectsMaskingFilter?.[FILTER_MARK] === true,
    // Above zero once a scene has drawn. `null` means the illumination layer has no filter, which
    // would be a much larger problem than this one.
    // **What the unseen replacement actually resolves to.** Must equal the model's Dark level,
    // not the scene's darkness — a value that tracks `canvas.environment.darknessLevel` is the
    // leak of 2026-08-27 returning.
    unseenLevel: illumination?.uniforms?.pf1SceneDarkness ?? null,
    modelDark: darknessTable()[TIER.DARK],
    sceneDarkness: canvas?.environment?.darknessLevel ?? null,
    // Zero on all three channels is the additive coloration layer contributing nothing where the
    // viewer cannot see. Anything above zero is a grey wash scaling with the scene's slider.
    colorationReplacement: [...(canvas?.effects?.coloration?.filter?.uniforms?.replacementColor ?? [])],
    // The fog overlay's explored dimming. `fowMatched: false` means core's shader moved and the
    // substitution found nothing — the setting then reads correctly and does nothing.
    unseenDimming: unseenDimming(),
    fowPatched: CONFIG.Canvas?.visibilityFilter?.[FOW_MARK] === true,
    fowMatched: CONFIG.Canvas?.visibilityFilter?.pf1Matched ?? null,
    fowAlpha: canvas?.visibility?.filter?.uniforms?.pf1ExploredAlpha ?? null,
  };
  console.error(`${MODULE_ID} | vision masking`, report);
  return report;
}
