/**
 * Obstructed ground: withheld, but not unseen. DESIGN.md §4.3.5.
 *
 * A withheld region registered with `treatment: "obstructed"` is ground in an observer's line of
 * sight that something low hides (astora-mod's wall umbras). The carve is untouched: it is still cut
 * from the vision mask, never explored, and detection never reads any of this. What changes is how
 * the fogged pixels are drawn, in two places this file feeds:
 *
 * | Where | Change inside obstructed ground |
 * | --- | --- |
 * | the illumination masking filter (`darkness-mask.mjs`) | the darkness level comes from the model texture, not the constant Dark, so the ground's tier shows |
 * | the fog overlay (`darkness-mask.mjs`) | explored fog is thinned, toward the ground as seen, never brighter |
 *
 * plus `paint.mjs`, which stops clamping obstructed ground to Dark so the texture has a tier to show.
 *
 * Both shaders need "how obstructed is this fragment", and core's vision mask is a single RED channel
 * with nothing spare, so this file keeps one more screen-space RED texture: a `CachedContainer` in
 * `canvas.masks` beside the vision mask. Being in `canvas.masks` is the point of putting it there:
 * core marks every mask there dirty on pan, zoom, and context loss (`board.mjs:1491`, `:708`), and
 * `CachedContainer` resizes itself, so this follows the vision mask without re-deriving when core
 * renders it.
 *
 * The value is a lightness, 0..1, which both shaders use as the weight of their obstructed treatment.
 * Each observer gets a layer of its own, a nested `CachedContainer`:
 *
 * 1. its obstructed ground, `los ∩ obstructed`, drawn at 1;
 * 2. its depth meshes, if a provider gave any, drawn as `1 − clamp(depth)` with `MIN_COLOR`, so the
 *    deepest band at a point wins and ground outside step 1 stays 0.
 *
 * The layers are composited into the mask with `MAX_COLOR` through each layer's bound sprite: the
 * observer with the best view of a point decides it. The layers render whenever the mask does
 * (`autoRender`), and the mask only when something changed or core invalidated it.
 *
 * Clipping to `los` matters: a provider's regions are bounded by area, not by `los`, so an unclipped
 * one behind a full-height wall would publish the light level of a room nobody can see. Another
 * observer seeing a fragment outright wins in the shaders, through `1 − v`.
 *
 * **Grown by core's vision blur.** Core blurs the vision mask, and its `AlphaBlurFilter` puts the whole
 * ramp on the seen side of an edge (`rgb *= clamp(2a − 1)`). Just past an umbra, then, core treats the
 * ground as partly unseen while a mask stopping at the same edge says "not obstructed", so those pixels
 * blended toward the constant Dark and full fog: a black band (found in play 2026-11-03). The mask is
 * dilated by the blur's reach (its `padding`, which core scales with zoom), so the ramp crossfades from
 * the umbra's own look instead. Spilling the same few pixels into ordinary fog on the other side is
 * harmless. One filter on the mask, run only when it renders.
 *
 * The mask is RG: red is that lightness, green marks the region itself (1 inside), which red cannot,
 * being 0 at full depth. The dilation grows both.
 *
 * **The edge fade.** Past core's few pixels of blur, obstructed ground still steps to seen ground: the
 * umbra shows a flat tier, seen ground its real light and light color. A second texture, the feather,
 * holds obstructed ground as actually drawn (in a region, seen by nobody) in red and that times its
 * lightness in green, blurred by the edge-fade width. On seen ground, twice its red is a rim weight: the
 * masking filter and the fog shader treat the rim as umbra by that much (1 at the boundary, fading out),
 * at the lightness the umbra had there (green over red). Built after the vision mask, so ground another
 * observer sees casts no fade. One blur for every observer together, redrawn on each vision refresh and
 * on core's mask invalidation.
 *
 * Empty means free: with no obstructed rings neither texture is rendered and both shaders are told not
 * to sample them.
 */

import { MODULE_ID } from "../constants.mjs";
import { flag, number } from "../settings-cache.mjs";
import { CLIPPER_SCALE, fromClipperPaths, groupRings, intersection, toClipperPath } from "../geometry.mjs";
import * as withheld from "../withheld.mjs";

export const SETTING_LIGHT = "obstructedLightShows";
export const SETTING_MEMORY = "obstructedMemory";
export const SETTING_FADE = "obstructedEdgeFade";

/** The keys in `canvas.masks`. */
const MASK_NAME = "pf1Obstructed";
const FEATHER_NAME = "pf1ObstructedFeather";

/** Red lightness and green region, linear so a band's gradient and the mask's edge sample smoothly. */
const TEXTURE_CONFIGURATION = Object.freeze({
  scaleMode: PIXI.SCALE_MODES.LINEAR,
  format: PIXI.FORMATS.RG,
  multisample: PIXI.MSAA_QUALITY.NONE,
});

/** The feather: red the drawn region, green that times its lightness, both blurred. */
const FEATHER_CONFIGURATION = Object.freeze({
  scaleMode: PIXI.SCALE_MODES.LINEAR,
  format: PIXI.FORMATS.RG,
  multisample: PIXI.MSAA_QUALITY.NONE,
});

// Obstructed ground as drawn (in a region, seen by nobody) in red, and that times its lightness in green.
// Blurred, red is the rim's weight and green over red the lightness the umbra had at the boundary.
const FEATHER_SOURCE = `
varying vec2 vTextureCoord;
varying vec2 vMaskTextureCoord;
uniform sampler2D obstructedTexture;
uniform sampler2D visionTexture;
void main() {
  vec4 obstructed = texture2D(obstructedTexture, vMaskTextureCoord);
  float drawn = obstructed.g * (1.0 - texture2D(visionTexture, vMaskTextureCoord).r);
  gl_FragColor = vec4(drawn, drawn * obstructed.r, 0.0, 1.0);
}`;

const DEPTH_VERTEX = `
precision highp float;
attribute vec2 aVertexPosition;
attribute float aDepth;
uniform mat3 projectionMatrix;
uniform mat3 translationMatrix;
varying float vDepth;
void main() {
  vDepth = aDepth;
  gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);
}`;

// Clamped per fragment, after interpolation: a corner's depth may exceed 1, and clamping corners first
// would bend the gradient. Green 1 leaves the region channel alone under `MIN_COLOR`.
const DEPTH_FRAGMENT = `
precision mediump float;
varying float vDepth;
void main() {
  gl_FragColor = vec4(1.0 - clamp(vDepth, 0.0, 1.0), 1.0, 0.0, 1.0);
}`;

// A max filter: three rings of twelve taps out to `radius` screen pixels. `inputSize` is shared with
// PIXI's default filter vertex shader, which declares it highp; a uniform's precision must match across
// the two stages or the program fails to link.
const DILATE_FRAGMENT = `
varying vec2 vTextureCoord;
uniform sampler2D uSampler;
uniform highp vec4 inputSize;
uniform float radius;
void main() {
  vec2 value = texture2D(uSampler, vTextureCoord).rg;
  for ( int ring = 1; ring <= 3; ring++ ) {
    float reach = radius * float(ring) / 3.0;
    for ( int i = 0; i < 12; i++ ) {
      float angle = float(i) * 0.5235988;
      vec2 offset = vec2(cos(angle), sin(angle)) * reach * inputSize.zw;
      value = max(value, texture2D(uSampler, vTextureCoord + offset).rg);
    }
  }
  gl_FragColor = vec4(value, 0.0, 1.0);
}`;

/** @type {PIXI.Container|null} The mask, once mounted. */
let mask = null;
/** @type {PIXI.Container|null} The feather, mounted with the mask. */
let feather = null;
/** Classes and the shared shader, made on first mount: they need Foundry's canvas classes. */
let MaskClass = null;
let LayerClass = null;
let FeatherClass = null;
let FeatherSourceFilter = null;
let depthShader = null;

/**
 * One per observer with obstructed ground, in publish order.
 * @type {{container: PIXI.Container, region: PIXI.Graphics, meshes: PIXI.Mesh[], rings: object, depth: object}[]}
 */
let layers = [];
/** Is anything drawn? Both shaders read this through {@link activeTexture}. */
let filled = false;
/** The entries last published, compared by identity to skip rebuilds. */
let drawn = [];

/** @type {PIXI.Graphics|null} The console overlay; see {@link show}. */
let overlay = null;

/** Rings per source, cached on `los` identity plus the withheld generation, like the carve. */
/** @type {WeakMap<object, {los: object, generation: number, rings: PIXI.Polygon[]}>} */
const ringCache = new WeakMap();

const stats = { observers: 0, rings: 0, depthMeshes: 0, depthTriangles: 0, rebuilds: 0, intersections: 0 };

/** Does obstructed ground show its light level? A correction of core, so console-only. */
export const lightShows = () => flag(SETTING_LIGHT, true);

/** How far explored fog over obstructed ground is thinned: 0 ordinary fog, 1 none. */
export function memory() {
  return Math.min(1, Math.max(0, number(SETTING_MEMORY, 0.5)));
}

/** The edge fade onto seen ground, in grid squares; 0 leaves core's blur alone. */
export function edgeFade() {
  return Math.min(2, Math.max(0, number(SETTING_FADE, 0.5)));
}

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTING_LIGHT, {
    name: "Light shows on obstructed ground",
    hint:
      "Ground in line of sight that something low hides (another module's wall umbras) shows its " +
      "current light level under the fog instead of being drawn at Dark. Drawing only: what a " +
      "creature can see is unchanged.",
    scope: "world",
    // No control surface, matching the module's other corrections of core behaviour.
    config: false,
    type: Boolean,
    default: true,
    // Paint's clamp changes, and paint's signature carries the withheld generation.
    onChange: () => withheld.invalidate(),
  });

  game.settings.register(MODULE_ID, SETTING_MEMORY, {
    name: "Obstructed ground memory",
    hint:
      "How close explored ground hidden by something low comes to looking seen: 0 is ordinary " +
      "fog, 1 is as bright as seen ground, never brighter. Unexplored ground stays black.",
    scope: "world",
    config: false,
    type: Number,
    range: { min: 0, max: 1, step: 0.05 },
    default: 0.5,
    // Read live by the fog filter's `apply`.
    onChange: () => {},
  });

  game.settings.register(MODULE_ID, SETTING_FADE, {
    name: "Obstructed ground edge fade",
    hint:
      "How far, in grid squares, ground hidden by something low fades into the ground beside it that " +
      "is in view. 0 leaves only Foundry's own soft edge.",
    scope: "world",
    config: false,
    type: Number,
    range: { min: 0, max: 2, step: 0.05 },
    default: 0.5,
    onChange: () => markFeather(),
  });
}

/* -------------------------------------------- */
/*  Per observer                                */
/* -------------------------------------------- */

/**
 * One observer's obstructed ground, clipped to what it would see there without the carve: its light
 * perception and sight polygons, not its `los`. Another module may narrow those inside a region and
 * leave `los` alone (Limits' fog does, found in play 2026-11-03), and ground it hides must stay unseen.
 * Read before the carve swaps them for the refresh. One Clipper op per change, nothing when the
 * observer has no obstructed regions.
 *
 * @param {PointVisionSource} source
 * @param {{obstructed: object[][]}} collected  `withheld.collect(source)`
 * @returns {PIXI.Polygon[]|null}
 */
export function ringsFor(source, collected) {
  if (!collected?.obstructed?.length || !source?.los) return null;
  const generation = withheld.currentGeneration();
  const { los, light, shape } = source;
  const hit = ringCache.get(source);
  if (hit && (hit.los === los) && (hit.light === light) && (hit.shape === shape)
    && (hit.generation === generation)) return hit.rings;

  // Wound alike, so the subject's non-zero fill unions the two rather than cancelling their overlap.
  const view = [];
  for (const polygon of new Set([light, shape])) {
    if (!polygon?.points?.length) continue;
    let path = toClipperPath(polygon, CLIPPER_SCALE);
    if (path.length < 3) continue;
    if (!ClipperLib.Clipper.Orientation(path)) path = [...path].reverse();
    view.push(path);
  }
  const rings = view.length
    ? fromClipperPaths(intersection(view, collected.obstructed), CLIPPER_SCALE)
    : [];
  stats.intersections++;
  ringCache.set(source, { los, light, shape, generation, rings });
  return rings;
}

/**
 * One observer's entry for {@link publish}: its rings, and its depth meshes (cached by the registry on
 * the same key, so an unchanged observer hands back the same arrays).
 *
 * @returns {{rings: PIXI.Polygon[], depth: object[]}|null}
 */
export function entryFor(source, collected) {
  const rings = ringsFor(source, collected);
  if (!rings?.length) return null;
  return { rings, depth: withheld.collectDepth(source) };
}

/**
 * This refresh's entries, one per observer. Layers are rebuilt only where an observer's cached arrays
 * changed, so a static scene costs a length check.
 *
 * @param {{rings: PIXI.Polygon[], depth: object[]}[]} entries
 */
export function publish(entries) {
  const same = (entries.length === drawn.length)
    && entries.every((e, i) => (e.rings === drawn[i].rings) && (e.depth === drawn[i].depth));
  // The feather reads the vision mask, which this refresh redraws whether or not the rings changed.
  if (same) {
    markFeather();
    return;
  }
  drawn = entries;
  stats.observers = entries.length;
  stats.rings = entries.reduce((n, e) => n + e.rings.length, 0);

  if (!entries.length) {
    clearLayers(0);
    filled = false;
    if (mask) mask.renderable = false;
    markFeather();
    drawOverlay();
    return;
  }

  const target = mount();
  if (!target) return;
  clearLayers(entries.length);
  while (layers.length < entries.length) layers.push(makeLayer(target));
  stats.depthMeshes = stats.depthTriangles = 0;
  entries.forEach((entry, i) => updateLayer(layers[i], entry));
  filled = true;
  target.renderable = true;
  target.renderDirty = true;
  markFeather();
  stats.rebuilds++;
  drawOverlay();
}

/** Each outer followed by its own holes: PIXI attaches a hole to the last shape drawn (§4.3.2 defect 1). */
function drawRings(target, rings) {
  for (const { outer, holes } of groupRings(rings)) {
    if (!outer.points?.length) continue;
    target.drawPolygon(outer.points);
    for (const hole of holes) {
      if (!hole.points?.length) continue;
      target.beginHole();
      target.drawPolygon(hole.points);
      target.endHole();
    }
  }
}

function updateLayer(layer, { rings, depth }) {
  if (layer.rings !== rings) {
    layer.region.clear();
    // Red lightness 1, green region 1.
    layer.region.beginFill(0xffff00, 1);
    drawRings(layer.region, rings);
    layer.region.endFill();
    layer.rings = rings;
  }
  if (layer.depth !== depth) {
    for (const mesh of layer.meshes) mesh.destroy();
    layer.meshes = [];
    for (const { points, depths, indices } of depth ?? []) {
      const geometry = new PIXI.Geometry()
        .addAttribute("aVertexPosition", Float32Array.from(points), 2)
        .addAttribute("aDepth", Float32Array.from(depths), 1)
        .addIndex((indices instanceof Uint32Array) || (indices instanceof Uint16Array) ? indices : Uint32Array.from(indices));
      const mesh = new PIXI.Mesh(geometry, depthShader);
      mesh.blendMode = PIXI.BLEND_MODES.MIN_COLOR;
      layer.meshes.push(layer.container.addChild(mesh));
    }
    layer.depth = depth;
  }
  stats.depthMeshes += layer.meshes.length;
  for (const { indices } of depth ?? []) stats.depthTriangles += indices.length / 3;
}

/* -------------------------------------------- */
/*  The mask                                    */
/* -------------------------------------------- */

function defineClasses() {
  const Cached = globalThis.foundry?.canvas?.containers?.CachedContainer;
  if (!Cached) return false;
  MaskClass ??= class ObstructedMask extends Cached {
    static textureConfiguration = TEXTURE_CONFIGURATION;

    clearColor = [0, 0, 0, 0];

    autoRender = false;

    /** @override */
    render(renderer) {
      // Read at render: core rescales its blur on zoom and replaces the filter on each canvas draw.
      const dilate = this.pf1Dilate;
      if (dilate && (this.renderDirty || this.autoRender)) {
        const reach = canvas.masks?.vision?.blurFilter?.padding ?? 0;
        dilate.enabled = reach > 0;
        dilate.uniforms.radius = reach;
      }
      super.render(renderer);
    }
  };
  // Rendered only when the mask is, which is when it is dirty; the bound sprite composites it.
  LayerClass ??= class ObstructedLayer extends Cached {
    static textureConfiguration = TEXTURE_CONFIGURATION;

    clearColor = [0, 0, 0, 0];

    autoRender = true;
  };
  depthShader ??= PIXI.Shader.from(DEPTH_VERTEX, DEPTH_FRAGMENT, {});

  const MaskFilter = globalThis.foundry?.canvas?.rendering?.filters?.AbstractBaseMaskFilter;
  if (!MaskFilter) return false;
  FeatherSourceFilter ??= class ObstructedFeatherSource extends MaskFilter {
    static fragmentShader = FEATHER_SOURCE;

    static defaultUniforms = { obstructedTexture: PIXI.Texture.EMPTY, visionTexture: PIXI.Texture.EMPTY };

    /** @override */
    apply(filterManager, input, output, clear, currentState) {
      this.uniforms.obstructedTexture = mask?.renderTexture ?? PIXI.Texture.EMPTY;
      this.uniforms.visionTexture = canvas.masks?.vision?.renderTexture ?? PIXI.Texture.EMPTY;
      super.apply(filterManager, input, output, clear, currentState);
    }
  };
  // The source filter then a blur, over the whole screen, as core blurs the vision mask.
  FeatherClass ??= class ObstructedFeather extends Cached {
    static textureConfiguration = FEATHER_CONFIGURATION;

    clearColor = [0, 0, 0, 0];

    autoRender = false;

    /** @override */
    render(renderer) {
      if (this.renderDirty && this.pf1Blur) {
        // Grid squares to screen pixels, read at render so zoom is current.
        this.pf1Blur.blur = edgeFade() * (canvas.dimensions?.size ?? 100) * (canvas.stage?.scale?.x ?? 1);
      }
      super.render(renderer);
    }
  };
  return true;
}

/**
 * The mask, created on first use. Needs the renderer, so never before `canvasReady`; `canvas.hidden`
 * and its masks live for the page, so one instance serves every scene.
 */
function mount() {
  if (mask && !mask.destroyed && mask.parent) return mask;
  const hidden = canvas?.hidden;
  if (!hidden?.addMask || !canvas.app?.renderer || !defineClasses()) return null;
  try {
    mask = new MaskClass();
    layers = [];
    // Over the whole screen, as core filters the vision mask.
    mask.pf1Dilate = new PIXI.Filter(undefined, DILATE_FRAGMENT, { radius: 0 });
    mask.filters = [mask.pf1Dilate];
    mask.filterArea = canvas.app.renderer.screen;
    hidden.addMask(MASK_NAME, mask);
  } catch (error) {
    console.error(`${MODULE_ID} | obstructed mask could not be created; obstructed ground draws as unseen`, error);
    mask = null;
    return null;
  }
  try {
    // After the mask, so it renders after it (and after the vision mask) in the same frame.
    feather = new FeatherClass();
    feather.pf1Blur = new PIXI.BlurFilter(8, 3);
    feather.filters = [FeatherSourceFilter.create(), feather.pf1Blur];
    feather.filterArea = canvas.app.renderer.screen;
    feather.renderable = false;
    hidden.addMask(FEATHER_NAME, feather);
  } catch (error) {
    // The fade only: obstructed ground still draws, with core's edge.
    console.error(`${MODULE_ID} | obstructed edge fade could not be created; edges stay sharp`, error);
    feather = null;
  }
  return mask;
}

/** The feather follows the mask and the vision mask: rendered only while both have something to say. */
function markFeather() {
  if (!feather || feather.destroyed) return;
  feather.renderable = filled && (edgeFade() > 0);
  if (feather.renderable) feather.renderDirty = true;
}

function makeLayer(target) {
  const sprite = new PIXI.Sprite();
  const container = new LayerClass(sprite);
  sprite.blendMode = PIXI.BLEND_MODES.MAX_COLOR;
  const region = container.addChild(new PIXI.Graphics());
  target.addChild(container);
  return { container, region, meshes: [], rings: null, depth: null };
}

/** Destroy layers past `keep`, with their render textures and meshes. */
function clearLayers(keep) {
  while (layers.length > keep) {
    const { container } = layers.pop();
    const sprite = container.sprite;
    container.parent?.removeChild(container);
    container.destroy({ children: true });
    sprite?.destroy();
  }
}

/**
 * The mask's texture when it holds something, else null. Both shaders sample it only when this is
 * non-null.
 */
export function activeTexture() {
  return (filled && mask && !mask.destroyed) ? mask.renderTexture : null;
}

/** The feather's texture while the edge fade is on, else null. */
export function featherTexture() {
  return (filled && feather && !feather.destroyed && (edgeFade() > 0)) ? feather.renderTexture : null;
}

/** A scene going away leaves nothing behind for the next one. */
function reset() {
  drawn = [];
  filled = false;
  stats.observers = stats.rings = stats.depthMeshes = stats.depthTriangles = 0;
  clearLayers(0);
  if (mask) mask.renderable = false;
  if (feather) feather.renderable = false;
  overlay?.destroy();
  overlay = null;
}

export function registerHooks() {
  Hooks.on("canvasTearDown", reset);
}

/* -------------------------------------------- */
/*  Diagnostics                                 */
/* -------------------------------------------- */

/** Redraw the console overlay from the current rings, if it is on. */
function drawOverlay() {
  if (!overlay || overlay.destroyed) return;
  overlay.clear();
  if (!stats.rings) return;
  overlay.beginFill(0xff4040, 0.35);
  for (const { rings } of drawn) drawRings(overlay, rings);
  overlay.endFill();
}

/**
 * Tint obstructed ground red over the canvas: `game.pf1Lighting.umbra.showObstructed(true)`. Drawn
 * from the same rings as the mask, in world coordinates; flat, so depth is not shown.
 */
export function show(on = true) {
  if (!on) {
    overlay?.destroy();
    overlay = null;
    return false;
  }
  if (!canvas?.interface) return false;
  if (!overlay || overlay.destroyed) overlay = canvas.interface.addChild(new PIXI.Graphics());
  drawOverlay();
  return true;
}

export function status() {
  const report = {
    lightShows: lightShows(),
    memory: memory(),
    edgeFade: edgeFade(),
    mounted: !!(mask && !mask.destroyed && mask.parent),
    featherMounted: !!(feather && !feather.destroyed && feather.parent),
    filled,
    layers: layers.length,
    ...stats,
  };
  console.error(`${MODULE_ID} | obstructed ground`, report);
  return report;
}
