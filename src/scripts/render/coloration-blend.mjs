/**
 * Overlapping lights do not stack their colour. DESIGN.md §6.4.9.
 *
 * A light source draws three layers. Two of them, background and illumination, blend `MAX_COLOR`
 * (`base-light-source.mjs:68-82`), so where two lights overlap the brighter one wins. The third,
 * coloration, carries the light's tint and its *Color Intensity*, and blends `SCREEN`:
 * `1 − (1 − a)(1 − b)`. Two torches over the same ground tint it more strongly than either alone,
 * and the overlap reads brighter than the tier the model gives it.
 *
 * Every light's coloration mesh is drawn into `canvas.effects.coloration`, which is filtered over a
 * black fill of the scene rect (`layers/effects/coloration-effects.mjs:42-51`) and then added onto
 * the scene. So inside that layer each mesh blends against black and the other lights' coloration,
 * never against the map, and `MAX_COLOR` there means exactly "the strongest tint per channel wins".
 * A single light is unchanged, since `max(black, tint)` is the tint.
 *
 * The cost is in mixed colours: a red light over a blue one gives each channel's maximum, a magenta
 * brighter than either but dimmer than `SCREEN` gives. Same-coloured lights, the common case, simply
 * stop adding.
 *
 * The lever is the layer's `blendMode`, which `#createMeshes` copies onto the mesh when it builds it
 * (`rendered-effect-source.mjs:349`) right after calling `_configureShaders`. That is the last
 * overridable call before the copy, so the patch sets the layer there. A prototype patch on
 * `PointLightSource` rather than a CONFIG subclass: it reaches PF1's light class, this module's pool
 * clones and companion sources alike, whatever order their CONFIG patches landed in. The global
 * light source is not a `PointLightSource` and is left alone.
 */

import { MODULE_ID } from "../constants.mjs";
import { flag } from "../settings-cache.mjs";

export const SETTING_COLORATION_MAX = "colorationMax";

const MAX = "MAX_COLOR";
const PATCHED = Symbol(`${MODULE_ID}.colorationBlend`);

/** Should overlapping coloration take the maximum rather than screen-blend? */
export function isEnabled() {
  return flag(SETTING_COLORATION_MAX, true);
}

/** The blend mode a light's coloration layer should use now. Core's own when the switch is off. */
function blendFor(source) {
  if (isEnabled()) return MAX;
  return source.constructor._layers?.coloration?.blendMode ?? "SCREEN";
}

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTING_COLORATION_MAX, {
    name: "Overlapping light colors do not stack",
    hint:
      "Where two lights overlap, the stronger tint wins instead of the two adding together, so an " +
      "overlap is no more colorful than its brightest light. Off restores Foundry's blending.",
    scope: "world",
    // No control surface, matching the module's other corrections of core behavior.
    config: false,
    type: Boolean,
    default: true,
    onChange: () => applyLive(),
  });
}

/**
 * Patch `PointLightSource#_configureShaders` to set the coloration layer's blend before the meshes
 * are built. Once, at `init`, before any source exists.
 */
export function install() {
  const Light = foundry.canvas.sources.PointLightSource;
  const proto = Light?.prototype;
  if (!proto || proto[PATCHED]) return;
  const original = proto._configureShaders;
  proto._configureShaders = function (...args) {
    const layer = this.layers?.coloration;
    if (layer) layer.blendMode = blendFor(this);
    return original.apply(this, args);
  };
  proto[PATCHED] = true;
}

/**
 * Re-blend every existing light without rebuilding it.
 *
 * @remarks
 * Meshes are built once per source and reused, so a live switch sets both the layer (for any mesh
 * built later) and the mesh already on screen, then asks for a lighting refresh.
 */
function applyLive() {
  if (!canvas?.ready) return;
  const Light = foundry.canvas.sources.PointLightSource;
  for (const source of canvas.effects.lightSources) {
    if (!(source instanceof Light)) continue;
    const layer = source.layers?.coloration;
    if (!layer) continue;
    layer.blendMode = blendFor(source);
    if (layer.mesh) layer.mesh.blendMode = PIXI.BLEND_MODES[layer.blendMode];
  }
  canvas.perception.update({ refreshLighting: true });
}

/** Debug readout: how many lights carry which coloration blend right now. */
export function status() {
  const counts = {};
  for (const source of canvas?.effects?.lightSources ?? []) {
    const mesh = source.layers?.coloration?.mesh;
    if (!mesh) continue;
    const name = Object.keys(PIXI.BLEND_MODES).find((k) => PIXI.BLEND_MODES[k] === mesh.blendMode) ?? mesh.blendMode;
    counts[name] = (counts[name] ?? 0) + 1;
  }
  const report = { enabled: isEnabled(), patched: !!foundry.canvas.sources.PointLightSource?.prototype?.[PATCHED], meshes: counts };
  console.error(`${MODULE_ID} | coloration blend`, report);
  return report;
}
