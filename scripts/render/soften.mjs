/**
 * Soft transitions. DESIGN.md §3.2.1, §6.4.
 *
 * **Light edges only, since 2026-08-24.** A ground feather lived here too — concentric bands
 * cut from each `ambient`/`dark` cell — and it is gone at Patrick's call: it cost the great
 * majority of a repaint (55 of 74 ms on a drag), and a magical darkness reading as a hard-edged
 * circle turns out to be fine. The reasoning that led to it is kept in DESIGN.md §6.4.2 rather
 * than here, including why a filter on the darkness-level container cannot work — that one is
 * worth not rediscovering.
 *
 * What remains is the polygon inset Foundry already has, widened and made live, plus the
 * padding band on a drawn darkness source's rim.
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
 * reads as a hard circle. That is exactly the report (Patrick, 2026-08-23: umbras smoothed out
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

/* -------------------------------------------- */

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTING_EDGE_SOFTNESS, {
    name: "Light edge softening",
    hint:
      `How far a light's cut or clipped edge fades, in grid squares. Foundry's own value is ` +
      `${FOUNDRY_EDGE_OFFSET / 100}. Applies only where a light is not a plain circle — walls, ` +
      `clips, band overlaps — because Foundry fades an unobstructed disc with attenuation ` +
      `instead. Costs a polygon-offsetting pass per 3 pixels, so about 10 at the default, and ` +
      `a feather wider than a narrow region can eat it entirely.`,
    scope: "world",
    config: true,
    type: Number,
    range: { min: 0.05, max: 1, step: 0.05 },
    default: 0.3,
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
    config: true,
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
    },

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
