/**
 * Making a darkness source answer to the observer. DESIGN.md §6.2.5.
 *
 * Two adjustments, both for the same underlying reason:
 *
 *   - Desaturation — grey vision gets full-colour terrain inside a darkness bubble.
 *   - Withholding — for blindsight the bubble is not drawn at all: a creature that maps a room by
 *     echo does not experience the darkness as anything.
 *
 * The first is dormant while §6.2.11 is on, which is the default. It was route 5 of the five ways
 * greyscale reached the screen, and the takeover zeroes the vision mode's `saturation`, so
 * {@link currentSaturation} reads 0 and the wrap below mixes by nothing. The single pass on
 * `canvas.environment` greys the darkness disc along with everything else and cannot disagree with
 * the terrain around it the way two mechanisms could.
 *
 * Kept as the fallback: with `regionalGreyscale` off, `neutralise` never runs, the vision mode
 * keeps its saturation, and everything below works as written. The analysis is load-bearing too —
 * it records that a darkness source repaints from the raw primary texture, and §6.2.11 exists
 * because a vision source does the same.
 *
 * The problem: a creature with darkvision or blindsight sees the world in grey, except inside a
 * darkness bubble where terrain comes back in full colour (2026-08-22). Not the vision mode, and
 * swapping modes cannot fix it — a vision mode's colour adjustment applies to the primary sprite,
 * `refreshPrimarySpriteMesh` setting `visionMode.canvas.shader` on `canvas.primary.sprite` and
 * pointing its sampler at `this.renderTexture` (`groups/primary.mjs:192-205`), so desaturation
 * happens as the sprite is drawn.
 *
 * A darkness source never uses that sprite. `_updateDarknessUniforms` hands the shader
 * `u.primaryTexture = canvas.primary.renderTexture` (`point-darkness-source.mjs:217`) — the raw
 * texture — and composites its own darkened copy, bypassing the vision mode entirely. A fifth face
 * of §6.2.3's finding: a `PointDarknessSource` redraws the map on its own terms.
 *
 * The fix wraps rather than replaces. Every darkness shader — default and all four animated —
 * ends on the same `FRAGMENT_END`:
 *
 * ```glsl
 * gl_FragColor = vec4(finalColor, 1.0) * depth;
 * ```
 *
 * One textual substitution therefore covers all of them, including a GM's Roiling Darkness.
 * Subclassing `AdaptiveDarknessShader` alone would miss them, an animation's `darknessShader`
 * replacing the default outright (`rendered-effect-source.mjs:278`).
 *
 * No new uniform is needed: `saturation` is already declared in `FRAGMENT_UNIFORMS` for every
 * lighting shader (`base-lighting.mjs:92`) and no darkness shader reads it. Reusing it avoids
 * editing the uniform block, the fragile part of shader surgery.
 *
 * Luminance is computed inline rather than through `perceivedBrightness`, only the default shader
 * being guaranteed to have included that helper.
 */

import { MODULE_ID } from "../constants.mjs";

export const SETTING_DESATURATE = "desaturateDarkness";

/** The line every darkness shader ends on. */
const FRAGMENT_END = "gl_FragColor = vec4(finalColor, 1.0) * depth;";

/**
 * Rec. 709 luma, matching Foundry's own colour-adjustment shader, so the grey inside a darkness
 * matches the grey outside rather than merely being grey.
 */
const DESATURATE = `
  float pf1Luma = dot(finalColor, vec3(0.2126, 0.7152, 0.0722));
  finalColor = mix(finalColor, vec3(pf1Luma), clamp(saturation, 0.0, 1.0));
`;

/** Cache, so one wrapped class exists per base class rather than one per source. */
const wrapped = new WeakMap();

export function isEnabled() {
  try {
    return game.settings.get(MODULE_ID, SETTING_DESATURATE) === true;
  } catch {
    return true;
  }
}

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTING_DESATURATE, {
    name: "Darkness respects grey vision (fallback)",
    hint:
      "Desaturates what a darkness source draws, so a creature seeing in black and white does not " +
      "get full-colour terrain inside a darkness bubble. **Does nothing while 'Greyscale follows " +
      "the brightness map' is on**, which is the default: that takes over greyscale entirely and " +
      "greys the darkness disc along with everything else. This is the fallback for worlds that " +
      "turn the takeover off.",
    scope: "world",
    // No control surface (2026-08-26): the switch was a development bisection aid.
    // Functionality stays, reachable from the console — see `game.pf1Lighting.settings`.
    config: false,
    type: Boolean,
    default: true,
    onChange: () => {
      if (!canvas?.ready) return;
      // The shader class is chosen during source initialisation, so a live change needs the sources
      // rebuilt rather than merely refreshed.
      for (const source of canvas.effects.darknessSources) source.object?.initializeLightSource?.();
      canvas.perception.update({ initializeLighting: true, refreshLighting: true });
    },
  });
}

/**
 * Wrap a darkness shader class so it honours `saturation`.
 *
 * @param {typeof AdaptiveDarknessShader} Base
 * @returns {typeof AdaptiveDarknessShader}
 */
export function withDesaturation(Base) {
  if (!Base) return Base;
  if (wrapped.has(Base)) return wrapped.get(Base);

  const source = Base.fragmentShader;

  // If the substitution has nothing to bite on, leave the class alone rather than shipping a shader
  // that fails to compile. A future Foundry rewriting `FRAGMENT_END` should degrade to colour
  // inside darkness, not to a black canvas.
  if (typeof source !== "string" || !source.includes(FRAGMENT_END)) {
    console.warn(
      `${MODULE_ID} | ${Base.name} does not end on the expected fragment; leaving it unwrapped.`
    );
    wrapped.set(Base, Base);
    return Base;
  }

  const Wrapped = class extends Base {
    static fragmentShader = source.replace(FRAGMENT_END, `${DESATURATE}${FRAGMENT_END}`);

    static defaultUniforms = { ...Base.defaultUniforms, saturation: 0 };
  };

  Object.defineProperty(Wrapped, "name", { value: `PF1Lighting${Base.name}` });
  wrapped.set(Base, Wrapped);
  wrapped.set(Wrapped, Wrapped);
  return Wrapped;
}

/**
 * How grey the observer's eyes are, as 0..1.
 *
 * @remarks
 * Read from the single vision source Foundry picks for canvas-wide tinting (`visibility.mjs:196`).
 * A real limitation, but with two vision sources active the canvas tint already comes from one of
 * them, so matching that choice keeps the inside of a darkness consistent with the outside rather
 * than inventing a third answer.
 *
 * Vision modes express saturation as -1..0 where -1 is fully grey; this wants 0..1.
 *
 * Returns 0 for darkvision as of §6.2.11, which is not a bug: the greyscale takeover zeroes
 * `vision.defaults.saturation` on the vision mode, so the wrap below mixes by nothing. Route 5 of
 * the five, switched off from the far end rather than by editing this file. The other half of this
 * file, {@link observerIgnoresDarkness}, reads actor senses and is untouched.
 */
export function currentSaturation() {
  if (!isEnabled()) return 0;
  const source = canvas?.visibility?.visionModeData?.source;
  const saturation = source?.visionModeOverrides?.saturation ?? 0;
  return Math.clamp(-saturation, 0, 1);
}

/**
 * Should the darkness mesh be withheld entirely for the current observer?
 *
 * @remarks
 * Blindsight only, and only after two failed attempts in the shader.
 *
 * A creature mapping a room by echo does not experience a deeper darkness over it as anything, so
 * the bubble must be indistinguishable from the ground around it. See in darkness and true seeing
 * differ: they see the darkness as darkness and see through it, needing no adjustment — piercing
 * rank already gives the sight, and the bubble should still look like a bubble.
 *
 * Both shader attempts failed on one misconception. Mixing back toward `baseColor` gave the raw map
 * at full brightness, too bright; mixing toward `baseColor * computedBackgroundColor` gave the
 * ambient background, nearly black on a night scene. Neither matches the surroundings, because the
 * grey around the bubble is painted by the vision source and the darkness shader has no access to
 * that term. No expression in that shader reproduces it.
 *
 * So withhold the mesh instead and let the ordinary pipeline draw the ground, vision paint
 * included. `_drawMesh` already has that path (see {@link HIDDEN}), and it is the one lever
 * measured to work — §6.2.3 found alpha does not stop a darkness source drawing.
 *
 * Global, not per-observer-range: the same single-vision-source approximation as
 * {@link currentSaturation}. A distant bubble outside blindsight range also goes unpainted, being
 * beyond `data.radius` and so not drawn as perceived anyway.
 */
export function observerIgnoresDarkness() {
  // No longer gated on `desaturateDarkness`, as of 2026-08-27. The two halves were switched
  // together because they arrived together; §6.2.11 made the desaturation half inert by default,
  // leaving the switch's only effect a silent disabling of blindsight withholding — a behaviour it
  // does not name.
  //
  // Withholding is a correctness rule, not a preference: a creature mapping a room by echo does not
  // experience a darkness over it as anything, so there is nothing for a setting to sit either side
  // of.
  const source = canvas?.visibility?.visionModeData?.source;
  return (source?.object?.actor?.system?.traits?.senses?.bs?.total ?? 0) > 0;
}

/** Last value seen, so a refresh is only requested when the answer actually changes. */
let lastIgnores = null;

/**
 * Refresh lighting when the observer changes.
 *
 * @remarks
 * `_drawMesh` runs on a lighting refresh, but changing which token is selected triggers only a
 * vision refresh. Without this the bubble keeps the previous observer's appearance until something
 * else dirties the lighting, which reads as the feature working intermittently.
 *
 * Guarded on a real change of answer, so the common case — selecting any token without blindsight
 * when the last one also had none — costs one boolean and requests nothing. Lighting is requested,
 * never vision, so this cannot feed back into the hook that drives it.
 */
export function registerHooks() {
  const check = () => {
    const ignores = observerIgnoresDarkness();
    if (ignores === lastIgnores) return;
    lastIgnores = ignores;
    if (canvas?.ready) canvas.perception.update({ refreshLighting: true });
  };

  Hooks.on("initializeVisionSources", check);
  Hooks.on("initializeVisionMode", check);
  Hooks.on("canvasReady", () => {
    lastIgnores = null;
    check();
  });
}
