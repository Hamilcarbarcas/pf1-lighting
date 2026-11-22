/**
 * Attenuated ground's renderer. DESIGN.md §4.3.6.
 *
 * Per observer, a RED layer: its view at 1 (light perception, sight, its reveals), lowered by its
 * depth meshes to `1 − depth` (`MIN_COLOR`), raised again by its caps (`MAX_COLOR`). Layers composite
 * with `MAX_COLOR`, the best view winning. The composite is a child of `canvas.masks.vision`, after
 * core's `vision` container, drawn with `MIN_ALL`: it can only dim what core drew, and leaves the
 * alpha core's blur shapes its edges by. Fog's commit
 * renders `vision` alone, so exploration is unaffected.
 *
 * Every observer gets a layer once any has a mesh; one left out would read 0 and erase its view.
 */

import { MODULE_ID } from "../constants.mjs";
import { CLIPPER_SCALE, fromClipperPaths } from "../geometry.mjs";
import * as attenuated from "../attenuated.mjs";
import * as revealed from "../revealed.mjs";

const TEXTURE_CONFIGURATION = Object.freeze({
  scaleMode: PIXI.SCALE_MODES.LINEAR,
  format: PIXI.FORMATS.RED,
  multisample: PIXI.MSAA_QUALITY.NONE,
});

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

// Clamped per fragment, after interpolation.
const DEPTH_FRAGMENT = `
precision mediump float;
varying float vDepth;
void main() {
  float v = 1.0 - clamp(vDepth, 0.0, 1.0);
  gl_FragColor = vec4(v, v, v, 1.0);
}`;

let CompositeClass = null;
let LayerClass = null;
let depthShader = null;

/** @type {PIXI.Container|null} */
let composite = null;
/** @type {{container: PIXI.Container, base: PIXI.Graphics, caps: PIXI.Graphics, meshes: PIXI.Mesh[], entry: object|null}[]} */
let layers = [];
/** The entries last published. */
let drawn = [];

const stats = { observers: 0, meshes: 0, triangles: 0, caps: 0, rebuilds: 0, capRedraws: 0 };

/** Reveal polygons per `revealed.collect` result: that object is replaced whenever they change. */
const revealCache = new WeakMap();

function revealsOf(source) {
  if (!revealed.hasProviders()) return null;
  const collected = revealed.collect(source);
  if (!collected.light.length && !collected.sight.length) return null;
  let polygons = revealCache.get(collected);
  if (!polygons) {
    polygons = fromClipperPaths([...collected.light, ...collected.sight], CLIPPER_SCALE);
    revealCache.set(collected, polygons);
  }
  return polygons;
}

/**
 * One observer's entry, read before the carve swaps `light` and `shape` for the refresh.
 * @returns {{source: object, light: object, shape: object, reveals: PIXI.Polygon[]|null, meshes: object[], caps: object[]}}
 */
export function entryFor(source) {
  return {
    source,
    light: source.light,
    shape: source.shape,
    reveals: revealsOf(source),
    meshes: attenuated.collect(source),
    caps: attenuated.collectCaps(source),
  };
}

/* -------------------------------------------- */
/*  Classes and mounting                        */
/* -------------------------------------------- */

function defineClasses() {
  const Cached = globalThis.foundry?.canvas?.containers?.CachedContainer;
  if (!Cached) return false;
  CompositeClass ??= class AttenuatedComposite extends Cached {
    static textureConfiguration = TEXTURE_CONFIGURATION;

    clearColor = [0, 0, 0, 0];

    autoRender = true;
  };
  LayerClass ??= class AttenuatedLayer extends Cached {
    static textureConfiguration = TEXTURE_CONFIGURATION;

    clearColor = [0, 0, 0, 0];

    autoRender = true;
  };
  depthShader ??= PIXI.Shader.from(DEPTH_VERTEX, DEPTH_FRAGMENT, {});
  return true;
}

/** The composite, as the last child of the vision mask. `attachVision` appends, so order is rechecked. */
function mount() {
  const visionMask = canvas?.masks?.vision;
  if (!visionMask || !canvas.app?.renderer || !defineClasses()) return null;
  try {
    if (!composite || composite.destroyed) {
      const sprite = new PIXI.Sprite();
      composite = new CompositeClass(sprite);
      sprite.blendMode = PIXI.BLEND_MODES.MIN_ALL;
      layers = [];
    }
    const children = visionMask.children;
    if ((composite.parent !== visionMask) || (children.indexOf(composite) !== children.length - 1)) {
      visionMask.addChild(composite);
    }
  } catch (error) {
    console.error(`${MODULE_ID} | attenuated ground could not be mounted; nothing is dimmed`, error);
    composite = null;
    return null;
  }
  return composite;
}

function makeLayer(target) {
  const sprite = new PIXI.Sprite();
  const container = new LayerClass(sprite);
  sprite.blendMode = PIXI.BLEND_MODES.MAX_COLOR;
  const base = container.addChild(new PIXI.Graphics());
  const caps = new PIXI.Graphics();
  caps.blendMode = PIXI.BLEND_MODES.MAX_COLOR;
  target.addChild(container);
  return { container, base, caps, meshes: [], entry: null };
}

function clearLayers(keep) {
  while (layers.length > keep) {
    const { container } = layers.pop();
    const sprite = container.sprite;
    container.parent?.removeChild(container);
    container.destroy({ children: true });
    sprite?.destroy();
  }
}

/* -------------------------------------------- */
/*  Drawing                                     */
/* -------------------------------------------- */

function drawBase(graphics, { light, shape, reveals }) {
  graphics.clear();
  graphics.beginFill(0xffffff, 1);
  for (const polygon of new Set([light, shape])) {
    if (polygon?.points?.length >= 6) graphics.drawPolygon(polygon.points);
  }
  for (const polygon of reveals ?? []) {
    if (polygon.points?.length >= 6) graphics.drawPolygon(polygon.points);
  }
  graphics.endFill();
}

function drawCaps(graphics, caps) {
  graphics.clear();
  for (const { polygon, depth } of caps) {
    const v = Math.round((1 - Math.min(1, Math.max(0, depth))) * 255);
    graphics.beginFill((v << 16) | (v << 8) | v, 1);
    graphics.drawPolygon(polygon.points);
    graphics.endFill();
  }
}

function drawMeshes(layer, meshes) {
  for (const mesh of layer.meshes) mesh.destroy();
  layer.meshes = [];
  for (const { points, depths, indices } of meshes) {
    const geometry = new PIXI.Geometry()
      .addAttribute("aVertexPosition", points instanceof Float32Array ? points : Float32Array.from(points), 2)
      .addAttribute("aDepth", depths instanceof Float32Array ? depths : Float32Array.from(depths), 1)
      .addIndex((indices instanceof Uint32Array) || (indices instanceof Uint16Array) ? indices : Uint32Array.from(indices));
    const mesh = new PIXI.Mesh(geometry, depthShader);
    mesh.blendMode = PIXI.BLEND_MODES.MIN_COLOR;
    layer.meshes.push(layer.container.addChild(mesh));
  }
  // Caps draw last.
  layer.container.addChild(layer.caps);
}

function updateLayer(layer, entry) {
  const was = layer.entry;
  if (!was || (was.light !== entry.light) || (was.shape !== entry.shape) || (was.reveals !== entry.reveals)) drawBase(layer.base, entry);
  if (!was || (was.meshes !== entry.meshes)) drawMeshes(layer, entry.meshes);
  if (!was || (was.caps !== entry.caps)) drawCaps(layer.caps, entry.caps);
  layer.entry = entry;
}

/**
 * This refresh's entries, one per active observer. Nothing is drawn unless one has a mesh.
 * @param {object[]} entries  {@link entryFor} results
 */
export function publish(entries) {
  const any = entries.some((e) => e.meshes.length);
  if (!any) {
    if (drawn.length) hide();
    return;
  }
  const same = (entries.length === drawn.length) && entries.every((e, i) => {
    const d = drawn[i];
    return (e.light === d.light) && (e.shape === d.shape) && (e.reveals === d.reveals)
      && (e.meshes === d.meshes) && (e.caps === d.caps);
  });
  const target = mount();
  if (!target) return;
  if (same) return;

  drawn = entries;
  clearLayers(entries.length);
  while (layers.length < entries.length) layers.push(makeLayer(target));
  entries.forEach((entry, i) => updateLayer(layers[i], entry));
  stats.observers = entries.length;
  stats.meshes = entries.reduce((n, e) => n + e.meshes.length, 0);
  stats.triangles = entries.reduce((n, e) => n + e.meshes.reduce((m, mesh) => m + mesh.indices.length / 3, 0), 0);
  stats.caps = entries.reduce((n, e) => n + e.caps.length, 0);
  stats.rebuilds++;
  target.renderable = true;
}

function hide() {
  drawn = [];
  clearLayers(0);
  if (composite && !composite.destroyed) composite.renderable = false;
  stats.observers = stats.meshes = stats.triangles = stats.caps = 0;
}

/** Caps changed without a vision refresh: redraw them and the mask, at most once a frame. */
let capsFrame = null;
function redrawCaps() {
  if (capsFrame !== null) return;
  capsFrame = requestAnimationFrame(() => {
    capsFrame = null;
    if (!drawn.length || !canvas?.ready) return;
    let changed = false;
    drawn.forEach((entry, i) => {
      const caps = attenuated.collectCaps(entry.source);
      if (caps === entry.caps) return;
      entry.caps = caps;
      if (layers[i]) drawCaps(layers[i].caps, caps);
      changed = true;
    });
    if (!changed) return;
    stats.caps = drawn.reduce((n, e) => n + e.caps.length, 0);
    stats.capRedraws++;
    if (canvas.masks?.vision) canvas.masks.vision.renderDirty = true;
  });
}

export function registerHooks() {
  attenuated.hooks.capsChanged = redrawCaps;
  Hooks.on("canvasTearDown", () => {
    hide();
    composite?.parent?.removeChild(composite);
  });
}

export function status() {
  const report = {
    providers: attenuated.list(),
    mounted: !!(composite && !composite.destroyed && composite.parent),
    renderable: !!composite?.renderable,
    layers: layers.length,
    ...stats,
  };
  console.error(`${MODULE_ID} | attenuated ground`, report);
  return report;
}
