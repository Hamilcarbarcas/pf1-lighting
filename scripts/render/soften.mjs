/**
 * Soft edges on **sources**. DESIGN.md §3.2.1, §6.4.
 *
 * Two mechanisms, both belonging to a light or a darkness *source* rather than to the ground: the
 * polygon inset Foundry already has, widened and made live ({@link edgeOffset}), and the padding
 * band on a drawn darkness source's rim ({@link darknessPadding}).
 *
 * **The ground is no longer softened from here, and its two settings are gone.** §6.4.3 replaced
 * `groundSoftness` and `spillSoftness`, and §6.4.4 replaced *that* with a single blur of the
 * composited field (`render/texture-blur.mjs`). One brightness boundary, one width, one place:
 * `transitionWidth` in `render/transition.mjs`.
 *
 * Two claims this file used to make and which are now known to be wrong, kept because both are the
 * kind that get rediscovered:
 *
 * - *"A filter on the darkness-level container cannot work."* It was read off `cached-container.mjs`'s
 *   redirect, which fires only when the container is already nested inside a filtered parent. In the
 *   plain case the cached texture is bound before `super.render` pushes the filter, so the filter's
 *   output lands on it. §6.4.4.
 * - *"A blur cannot make a gradient."* True of a **mesh**, where the blur fades alpha and reveals
 *   whatever is beneath. Not true of the composited **field**, where a blurred step is a genuine
 *   ramp in the value. §7.0 step 5 established the first and it was over-generalised into the
 *   second.
 */

import { HARD_EDGES, HIDDEN, MODULE_ID, isSynthetic } from "../constants.mjs";

export const SETTING_EDGE_SOFTNESS = "edgeSoftness";
export const SETTING_DARKNESS_SOFTNESS = "darknessSoftness";

/** Foundry's own value, `RenderedEffectSource.EDGE_OFFSET`. The setting's "unchanged" point. */
const FOUNDRY_EDGE_OFFSET = 8;

const read = (key, fallback) => {
  try {
    return game.settings.get(MODULE_ID, key) ?? fallback;
  } catch {
    return fallback;
  }
};

/**
 * The polygon inset a soft-edged source should feather across, as a **negative** offset.
 *
 * @remarks
 * Consumed by `render/clip.mjs`, which installs it as a static getter on the patched source
 * classes — `_updateGeometry` reads `this.constructor.EDGE_OFFSET` and scales it by
 * `canvas.grid.size / 100` (`point-effect-source.mjs:176`), so the value is grid-relative and
 * a 200px grid feathers twice as far in pixels. That is the right behaviour: the feather is a
 * distance on the map, not on the screen.
 *
 * **It is not free, and the cost is linear in the offset.** `PolygonMesher` runs
 * `ceil(|offset| / 3)` ClipperOffset passes (`polygon-mesher.mjs:20`), so tripling the offset
 * triples the passes on *every* soft-edged source. §9.5 already measured soft edges at ~3.9×
 * the cost of hard ones at Foundry's own `-8`. Raise it for looks, and re-measure if a scene
 * with many wall-truncated lights starts to drag.
 *
 * Soft edges also require `canvas.performance.lightSoftEdges`, which Foundry only enables at
 * **Medium** performance mode and above (`board.mjs:876-884`), and it disables them entirely
 * for unobstructed circular sources, which get their falloff from `attenuation` instead
 * (`point-effect-source.mjs:118`). Neither is ours to change and both are why this can appear
 * to do nothing.
 *
 * @returns {number} Negative, in pixels per 100px of grid
 */
export const edgeOffset = () => -Math.abs(read(SETTING_EDGE_SOFTNESS, 0.3)) * 100;

/**
 * How far a darkness source's disc fades at its rim, in **pixels**.
 *
 * @remarks
 * A third mechanism, because a darkness source softens its edge in a third way again — not the
 * polygon inset and not the illumination blur, but a padding band:
 *
 * ```glsl
 * // darkness-lighting.mjs:94
 * depth *= (1.0 - smoothstep(borderDistance, 1.0, dist));
 * // point-darkness-source.mjs:118
 * borderDistance = radius / (radius + _padding)
 * ```
 *
 * **`_padding` is a fixed number of pixels, so the fade gets proportionally tighter the bigger
 * the darkness is.** Core's default is `0.5 × grid` — 50px on a 100px grid — which on a 20 ft
 * disc is a fifth of the radius and reads soft, and on a 60 ft disc is a twenty-fourth and
 * reads as a hard circle. That is exactly the report (Hamilcarbarcas, 2026-08-23: umbras smoothed out
 * but the darkness discs themselves stayed sharp).
 *
 * Safe to raise, and worth saying why, because it looks like it should widen the spell. It does
 * not: `_createShapes` sweeps the *padded* radius into `_visualShape` for rendering and then
 * builds `this.shape` from the true radius (`point-darkness-source.mjs:131-140`). Only the
 * picture grows. `shape` is what `testPoint` and the whole model read, so the suppressor still
 * covers exactly what it should.
 *
 * The cost is a wider wall sweep per darkness source.
 *
 * @returns {number} Padding in pixels
 */
export const darknessPadding = () =>
  Math.max(0, read(SETTING_DARKNESS_SOFTNESS, 1.5)) * (canvas?.grid?.size ?? 100);

/**
 * **Retired, 2026-08-27.** Both ground-softening mechanisms are gone from this file.
 *
 * @remarks
 * `groundSoftness` blurred each ground *mesh*, and `spillSoftness` multiplied it for §3.4's bands.
 * Neither could do the job, and the reason is one finding: a `PIXI.BlurFilter` fades a mesh's
 * **alpha** to reveal whatever lies beneath, so it can soften a boundary between two levels but
 * never invent one between them (§7.0 step 5). Every value of `spillSoftness` only spread the same
 * handful of steps over more or less distance.
 *
 * `transitionWidth` in `render/transition.mjs` replaces both, and one blur of the composited
 * **field** delivers it (§6.4.4) — which is a different operation from blurring a mesh and is why
 * it works where these did not.
 *
 * The keys are not re-registered. An orphan `Setting` document in an existing world is inert:
 * Foundry ignores a stored value with no registration behind it.
 */

/* -------------------------------------------- */

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTING_EDGE_SOFTNESS, {
    name: "Light edge softening",
    hint:
      `How far a light's cut or clipped edge fades, in grid squares. Foundry's own value is ` +
      `${FOUNDRY_EDGE_OFFSET / 100}. Applies only where a light is not a plain circle — walls, ` +
      `clips, band overlaps — because Foundry fades an unobstructed disc with attenuation ` +
      `instead. Since lights became brightness regions this governs the light's **colour** edge ` +
      `rather than its brightness edge: how far the coloured wash feathers. Brightness fades ` +
      `over Brightness transition width instead. Costs a polygon-offsetting pass per 3 pixels.`,
    scope: "world",
    // **No control surface at all since 2026-08-27** (§10.6.2). It had a row in *Configure
    // visuals* and came out with the audit: both of these tune a *source's* mesh edge, which is a
    // much smaller and rarer thing than the brightness boundaries that window is otherwise about,
    // and neither has been touched since the defaults were set. Reachable from the console —
    // `game.pf1Lighting.settings("edgeSoftness", 0.2)`.
    config: false,
    type: Number,
    range: { min: 0.05, max: 1, step: 0.05 },
    // **0.05 since 2026-08-27**, down from 0.3 (Hamilcarbarcas: *"too niche to take up settings space"*).
    // The larger value existed because §6.4 found a clipped light abutting one of our regions read
    // as a hard step — a *brightness* complaint, and brightness has not come from this mesh since
    // §7.0 step 6. What is left is the colour wash's edge, which wants the tightest feather the
    // range allows rather than a third of a square.
    default: 0.05,
    onChange: () => {
      // The offset is baked into each source's geometry, so nothing short of rebuilding them
      // shows the change.
      if (canvas?.ready) {
        canvas.perception.update({ initializeLighting: true, refreshLighting: true });
      }
    },
  });

  game.settings.register(MODULE_ID, SETTING_DARKNESS_SOFTNESS, {
    name: "Darkness edge softening",
    hint:
      "How far a darkness source's own disc fades at its rim, in grid squares. Foundry's " +
      "value is 0.5, which is a fixed distance and so looks progressively harder the larger " +
      "the darkness is. Widens only the picture, never the area the spell covers.",
    scope: "world",
    // **No control surface at all since 2026-08-27** (§10.6.2). It had a row in *Configure
    // visuals* and came out with the audit: both of these tune a *source's* mesh edge, which is a
    // much smaller and rarer thing than the brightness boundaries that window is otherwise about,
    // and neither has been touched since the defaults were set. Reachable from the console —
    // `game.pf1Lighting.settings("edgeSoftness", 0.2)`.
    config: false,
    type: Number,
    range: { min: 0.5, max: 6, step: 0.5 },
    default: 0.5,
    onChange: () => {
      if (canvas?.ready) {
        canvas.perception.update({ initializeLighting: true, refreshLighting: true });
      }
    },
  });


}

/**
 * How to push a changed source-edge setting onto what is already drawn.
 *
 * @remarks
 * Injected rather than imported, for the reason the other two seams in this module's
 * neighbourhood give: `render/darkness-texture.mjs` reads from here, so
 * importing its `refreshFilters` back would make two peers depend on each other for the sake
 * of one settings callback. `module.mjs` wires it.
 *
 * @param {() => void} fn
 */
export function setGroundRefresh(fn) {
  groundRefresh = typeof fn === "function" ? fn : () => {};
}

let groundRefresh = () => {};

/**
 * Debug readout — **live source state, not the settings**.
 *
 * @remarks
 * Written after a round trip where three levers were changed and nothing on screen moved
 * (2026-08-23). Reporting what the settings say is useless in that situation: the settings were
 * right every time. What matters is whether each mechanism *reached* a source, and every one of
 * them has a gate between the setting and the pixel — Foundry's performance mode, the
 * complete-circle exemption, whether the source is even being drawn.
 *
 * So this samples a real light and a real darkness source and reports what they actually
 * meshed with.
 */
export function status() {
  /** What a source's edge treatment actually resolved to, as against what was asked for. */
  const sample = (source) => {
    if (!source) return null;
    const shape = source.shape;
    return {
      cls: source.constructor?.name,
      patched: source.constructor?.pf1LightingClipPatched === true,
      edgeOffset: source.constructor?.EDGE_OFFSET,
      // `_updateGeometry`'s own arithmetic (`point-effect-source.mjs:176`) — the number that
      // actually reached `PolygonMesher`, or 0 if Foundry declined.
      meshedOffset:
        (source._flags?.renderSoftEdges ? source.constructor?.EDGE_OFFSET ?? 0 : 0) *
        ((canvas?.grid?.size ?? 100) / 100),
      renderSoftEdges: source._flags?.renderSoftEdges === true,
      // **The usual reason a light has no polygon feather at all.** An unobstructed disc is a
      // complete circle, and Foundry disables soft edges for one on purpose — its outer fade
      // comes from `attenuation` in the shader instead. Nothing here can change that.
      completeCircle: shape?.isCompleteCircle?.() === true,
      hardEdges: source[HARD_EDGES] === true,
      padding: source._padding,
      // The darkness fade band, as the shader will compute it. 1.0 means no fade at all.
      borderDistance:
        Number.isFinite(source.radius) && source.radius > 0
          ? +(source.radius / (source.radius + (source._padding ?? 0))).toFixed(4)
          : 1,
      visualShape: !!source._visualShape,
      drawn: source.active === true,
    };
  };

  // **Skip the global light source.** It came first in the collection and the first version of
  // this readout sampled it, reporting `patched: false, edgeOffset: -8` — true, and about a
  // source that is built from `CONFIG.Canvas.globalLightSourceClass`, a slot `clip.applyMixin`
  // deliberately does not touch and which disables soft edges on itself anyway
  // (`global-light-source.mjs:54`). A correct answer to the wrong question, which cost a round
  // trip (2026-08-23).
  const globalSource = canvas?.environment?.globalLightSource;
  const lights = [...(canvas?.effects?.lightSources?.values() ?? [])].filter(
    (s) => !isSynthetic(s) && s !== globalSource
  );
  const darks = [...(canvas?.effects?.darknessSources?.values() ?? [])].filter((s) => !isSynthetic(s));
  const synthetics = [...(canvas?.effects?.lightSources?.values() ?? [])].filter((s) => isSynthetic(s));

  return {
    settings: {
      edgeOffset: edgeOffset(),
      darknessPadding: darknessPadding(),
      // The ground's own softening lives in `render/texture-blur.mjs` now — see
      // `game.pf1Lighting.render.blur()`. Nothing in this file touches it.
    },

    // **Whether a darkness sweep reads wall restrictions at all.** False means core's own
    // behaviour is in force and every wall blocks darkness — windows and open doors included —
    // whatever those walls are configured to allow. See `clip.patchDarknessWalls`.
    darknessWallsPatched:
      canvas?.app && CONFIG.Canvas.polygonBackends?.darkness?.pf1LightingDarknessWalls === true,

    // Foundry's global gate. False means the whole light-edge half is inert whatever is set.
    softEdgesAvailable: canvas?.performance?.lightSoftEdges === true,
    performanceMode: canvas?.performance?.mode,
    gridSize: canvas?.grid?.size,

    // Several, not one: whether a feather applies is per-source (walls, clipping, circularity),
    // so a single sample can be unrepresentative in either direction.
    lights: lights.slice(0, 3).map(sample),
    // A pooled fill — a `stack` clone or a `reduced` cell. These are the ones that *must*
    // feather, since they exist to blend into a light rather than to abut a region.
    synthetics: synthetics.slice(0, 3).map(sample),
    darkness: sample(darks[0]),


    // **Ordinary darkness does not draw a darkness source at all** with the takeover on — its
    // disc is a `dark` region in the texture, so `darknessPadding` cannot soften it and only
    // the blur can. Only Supernatural Dark still renders a source. This counts what is really
    // being drawn, which is the difference between the two explanations.
    darknessSourcesDrawn: darks.filter((s) => s.active && !s[HIDDEN]).length,
    darknessSourcesTotal: darks.length,
  };
}
