/**
 * Softening the brightness field by blurring the field. DESIGN.md §6.4.4.
 *
 * A blur cannot make a gradient was true of a mesh, not of the field. §7.0 step 5 established that
 * blurring an individual mesh cannot produce a gradient, correctly: a `PIXI.BlurFilter` fades a
 * mesh's alpha at its rim, so what appears there is whatever lies beneath — and beneath a stripe is
 * only the next stripe. Three attempts died on it and the conclusion hardened into a blur not being
 * a gradient.
 *
 * It does not carry over. Blurring the composited scalar field is a different operation: a hard step
 * from `0.35` to `1.0` convolved with a kernel is a smooth ramp in the value, and the consumer turns
 * that into a smooth colour by `mix(ambientDaylight, ambientDarkness, level)` as it would any other
 * value. No alpha is involved and there is nothing beneath to reveal.
 *
 * §6.4.2's other conclusion — that the container takes no filter — was read off
 * `cached-container.mjs`'s redirect, which fires only when the container is already nested inside a
 * filtered parent, so it is a statement about the nested case. In the plain case
 * `CachedContainer#render` binds the cached texture then calls `super.render`, which is where PIXI
 * pushes the filter; the filter's output goes to whatever render texture was bound at push time,
 * which is the cached one.
 *
 * Better rather than merely shorter. `render/halo.mjs` softens a boundary by enumerating it: four
 * polygon offsets, a boolean per ring, a triangulation and a containment test per vertex, for every
 * ground region, on every repaint. It has cost 41 ms of a repaint, and every artefact of the last
 * two rounds was a property of that machinery rather than of the picture — round joins curving a
 * corner, a fixed arc tolerance faceting a circle, two rings interpolating along a chord.
 *
 * A blur has none of those, never looking at the geometry. It softens every boundary at one width,
 * including the ones nobody enumerated, at the cost of one screen-space pass.
 *
 * What it gives up:
 *
 * - Shape. The ramp is the kernel's; there is no plateau control, and a flat region's corners round
 *   slightly.
 * - Selectivity. It softens boundaries the model might want hard. A live concern while a region
 *   boundary following a wall was supposed to stay crisp (§6.4.2a), and no longer one since §6.4.3
 *   made every brightness boundary a gradient.
 * - Tap count. The `PIXI.BlurFilter` limitation from §7.0 step 5 applies — a fixed number of taps
 *   spread across the radius — but bites far less: the input is a step rather than a stripe, so the
 *   taps land on a ramp, and the 8-bit texture has ~85 codes between adjacent tiers to absorb it.
 *
 * Kept alongside `render/halo.mjs` rather than replacing it, switched by one setting, so the two can
 * be compared on the same scene. If the blur wins, the halos and most of the per-vertex machinery
 * come out with it.
 */

import { MODULE_ID } from "../constants.mjs";
import { flag } from "../settings-cache.mjs";
import { width } from "./transition.mjs";
import * as wallMask from "./wall-mask.mjs";

export const SETTING_BLUR = "blurTransitions";
export const SETTING_SHARP_WALLS = "sharpWalls";

const MARK = "pf1LightingFieldBlur";

/**
 * How far apart the blur's samples may land, in **screen** pixels. DESIGN.md §6.4.8.
 *
 * @remarks
 * `PIXI.BlurFilter`'s taps are spaced `blur / quality` apart and nothing else moves them.
 * `generateBlurVertSource` offsets tap `i` by `(i - 7) * strength` and `BlurFilterPass#apply` sets
 * that strength to `blur / passes`, so at the default quality of 4 with a wide blur the Gaussian is
 * a comb, and a step edge convolved with a comb is a staircase.
 *
 * Measured on the field directly, 2026-08-28: the transect across a boundary changed value every 8
 * screen pixels, its first differences tracing a clean bell —
 * `0.015 0.028 0.051 0.078 0.106 0.126 0.126 0.109 0.078 0.051 0.028 0.012`. The derivative of a
 * blurred step is the kernel, so that bell is the fifteen taps themselves, one per terrace. At the
 * measured zoom `blur ≈ 32`, and `32 / 4 = 8`: arithmetic and measurement agree to the pixel.
 *
 * It reads as banding on straight boundaries and not on curved ones for the reason any regular
 * sampling artefact does — along a straight edge every terrace lines up into a stripe the eye can
 * follow, while around a curve the same terraces stagger and read as texture.
 *
 * Raising `kernelSize` was the wrong knob, and this file had already turned it. More taps at the
 * same spacing makes the kernel wider, not denser: 15 taps spanning `±7 × spacing` is three times
 * the reach of PIXI's default 5 at the same coarseness. Kept at 15 because a wider kernel per pass
 * is a smoother profile once the spacing is fixed, but it was never going to fix the spacing.
 *
 * Two screen pixels sits just under what an eye can pick out of a low-contrast ramp while keeping
 * the pass count bounded. `quality` is the number of passes in each direction, so it is the term
 * that decides the cost.
 */
const TAP_SPACING = 2;

/** Never fewer passes than PIXI's own default, and never more than this. */
const MIN_QUALITY = 4;
const MAX_QUALITY = 24;

/**
 * Passes needed to keep the taps within {@link TAP_SPACING} of each other.
 *
 * @remarks
 * From the running blur, not the configured strength: `canvas.addBlurFilter` re-derives `filter.blur`
 * from the stage scale on every zoom (`board.mjs:1657-1670`), so a map zoomed out far enough would
 * otherwise spread the same taps over more screen than they were solved for.
 *
 * PIXI distributes one blur across its passes rather than compounding it, so raising `quality` holds
 * the visible width and only smooths the profile. Nothing has to compensate.
 */
function qualityFor(strength) {
  const blur = strength * (canvas?.stage?.scale?.x ?? 1);
  const needed = Math.ceil(blur / TAP_SPACING);
  return Math.min(MAX_QUALITY, Math.max(MIN_QUALITY, needed));
}

let filter = null;
let lastStrength = null;

/**
 * Blur the composited field instead of enumerating its boundaries?
 *
 * @remarks
 * When on, `render/halo.mjs` emits nothing — the two are alternatives, and applying both softens
 * every boundary twice at two different widths, the state §6.4.3 was written to end.
 */
export function isEnabled() {
  // Cached — `light-ramps.cacheKey` and `rampFor` both ask once per light cell per pass, and
  // `halo.halosFrom` asks on every repaint. See `settings-cache.mjs`.
  return flag(SETTING_BLUR);
}

/**
 * Keep the field hard where a light-blocking wall runs? DESIGN.md §6.4.7.
 */
export function sharpWalls() {
  return isEnabled() && flag(SETTING_SHARP_WALLS);
}

/* -------------------------------------------- */
/*  The composite — §6.4.7                      */
/* -------------------------------------------- */

let composite = null;

/**
 * Blur the field, then put the wall lines back sharp.
 *
 * @param {object} params
 * @returns {PIXI.Filter}
 */
function buildComposite() {
  const Base = foundry.canvas.rendering.filters.AbstractBaseMaskFilter;

  return class SharpWallFilter extends Base {
    static defaultUniforms = {
      sharpTexture: null,
      wallTexture: null,
      screenDimensions: [1, 1],
    };

    static fragmentShader = `
    precision ${PIXI.settings.PRECISION_FRAGMENT} float;
    varying vec2 vTextureCoord;
    varying vec2 vMaskTextureCoord;
    uniform sampler2D uSampler;       // the blurred field
    uniform sampler2D sharpTexture;   // the same field, untouched
    uniform sampler2D wallTexture;

    void main() {
      float wall = texture2D(wallTexture, vMaskTextureCoord).r;
      // Nothing to choose between where no wall runs, which is nearly every fragment: one texture
      // read and a branch the whole warp takes together.
      if ( wall <= 0.0 ) {
        gl_FragColor = texture2D(uSampler, vTextureCoord);
        return;
      }
      gl_FragColor = mix(
        texture2D(uSampler, vTextureCoord),
        texture2D(sharpTexture, vTextureCoord),
        clamp(wall, 0.0, 1.0)
      );
    }`;

    /**
     * @override
     * @remarks
     * Two passes inside one filter, and it has to be one filter: PIXI chains filters sequentially,
     * so a second filter in `container.filters` would only see the first's output, with no way to
     * reach back for the unblurred field. Running the blur into a scratch target here makes both
     * available to the same fragment.
     *
     * `getFilterTexture()` hands back a target matching the current filter frame, so `input` and
     * `temp` share dimensions and both sample correctly at `vTextureCoord`.
     */
    apply(filterManager, input, output, clear, currentState) {
      const u = this.uniforms;
      u.screenDimensions = canvas.screenDimensions;
      u.wallTexture = wallMask.texture();

      // No mask yet — nothing to protect, so this is an ordinary blur.
      if (!u.wallTexture) {
        filter.apply(filterManager, input, output, clear, currentState);
        return;
      }

      const temp = filterManager.getFilterTexture();
      filter.apply(filterManager, input, temp, PIXI.CLEAR_MODES.CLEAR, currentState);
      u.sharpTexture = input;
      filterManager.applyFilter(this, temp, output, clear);
      filterManager.returnFilterTexture(temp);
    }
  };
}

let CompositeClass = null;

function sharpWallFilter() {
  CompositeClass ??= buildComposite();
  composite ??= CompositeClass.create();
  composite[MARK] = true;
  composite.padding = 0;
  return composite;
}

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTING_SHARP_WALLS, {
    name: "Keep brightness hard at walls",
    hint:
      "Light stops at a wall, but the softening does not: it spreads brightness about one " +
      "transition width past every hard edge, so a lit room glows through its own walls and a " +
      "dark one picks up the corridor outside. This holds the field sharp along any wall that " +
      "blocks light, and softens everything else as before.",
    scope: "world",
    // No control surface, matching the module's other corrections of core behaviour.
    config: false,
    type: Boolean,
    default: true,
    onChange: () => {
      wallMask.invalidate();
      sync({ force: true });
    },
  });

  game.settings.register(MODULE_ID, SETTING_BLUR, {
    name: "Soften brightness boundaries with a blur",
    hint:
      "Blurs the whole brightness map in one pass instead of building a gradient around each " +
      "region. Same width setting, far cheaper, and it softens every boundary rather than only " +
      "the ones the model enumerates. Off uses the per-region gradients instead, which give a " +
      "more controlled ramp shape at a much higher cost.",
    scope: "world",
    // No control surface, matching the module's other corrections of core behaviour.
    config: false,
    type: Boolean,
    default: true,
    onChange: () => sync({ force: true }),
  });
}

/**
 * Attach, retune or remove the field blur.
 *
 * @remarks
 * Registered through `canvas.addBlurFilter`, which keeps the strength in world units: it stores
 * `_configuredStrength` and re-derives `filter.blur` from the stage scale on every zoom
 * (`board.mjs:1657-1670`). Without it the transition would be a fixed number of screen pixels and
 * appear to widen as the GM zoomed out — the trap `soften.groundSoftness` documents.
 *
 * `padding` matters more than it looks. A filter samples outside its own bounds and the container is
 * exactly screen-sized, so without padding the blur has nothing to reach for at the edges and
 * darkens the border of the map.
 *
 * @returns {object|null} What was applied
 */
export function sync({ force = false } = {}) {
  const container = canvas?.effects?.illumination?.darknessLevelMeshes;
  if (!container) return null;

  if (!isEnabled()) {
    if (filter) {
      canvas.blurFilters?.delete(filter);
      container.filters = null;
      filter = null;
      composite = null;
      lastStrength = null;
      container.renderDirty = true;
    }
    return null;
  }

  // Half the transition width: a Gaussian's visible extent is roughly twice its strength, which is
  // what makes one `transitionWidth` on screen mean the same distance it means to a spill band or a
  // light's zone.
  const strength = width() / 2;

  if (!(strength > 0)) {
    if (filter) {
      canvas.blurFilters?.delete(filter);
      container.filters = null;
      filter = null;
      composite = null;
    }
    return null;
  }

  if (!filter) {
    filter = new PIXI.BlurFilter(strength, qualityFor(strength), undefined, 15);
    filter[MARK] = true;
    filter.padding = 0;
  }

  // The blur is not what the container carries. `composite` runs it into a scratch target and then
  // chooses per fragment between the blurred field and the untouched one — see
  // {@link sharpWallFilter}. With the wall mask off it is bypassed entirely and the blur attached
  // directly, so that path stays exactly what it was.
  const outer = sharpWalls() ? sharpWallFilter() : filter;
  if (container.filters?.[0] !== outer) container.filters = [outer];

  // Zoom moves `filter.blur` without moving `strength`, and the tap spacing derives from the
  // running blur, so this retunes every sync rather than only when the setting changes.
  filter.quality = qualityFor(strength);

  if (force || lastStrength !== strength) {
    filter._configuredStrength = strength;
    // The inner blur is what gets registered, not the composite. `canvas.addBlurFilter` stores
    // `_configuredStrength` and re-derives `.blur` from the stage scale on every zoom
    // (`board.mjs:1657-1670`), so it needs the object that has a `blur` property — the
    // `PIXI.BlurFilter`, regardless of who invokes it.
    canvas.addBlurFilter(filter);
    lastStrength = strength;
    container.renderDirty = true;
  }

  if (sharpWalls()) wallMask.sync();

  return {
    strength,
    quality: filter.quality,
    applied: container.filters?.[0] === outer,
    sharpWalls: sharpWalls(),
  };
}

/** Scene teardown. The container goes with the canvas; this only drops the local references. */
export function dispose() {
  if (filter) canvas?.blurFilters?.delete(filter);
  filter = null;
  composite = null;
  lastStrength = null;
  wallMask.dispose();
}

/**
 * Debug readout.
 *
 * @remarks
 * `applied: true` with nothing visibly softer is the interesting failure: the filter is attached but
 * its output is not reaching the cached texture, the open question this file exists to settle.
 * Compare `sampled` either side of a boundary with `render.meshAt()` — a blurred field reads
 * intermediate values there and an unblurred one does not.
 */
export function status() {
  const container = canvas?.effects?.illumination?.darknessLevelMeshes;
  const report = {
    enabled: isEnabled(),
    strength: lastStrength,
    // In world units; `blur` is what PIXI is running, which is this times the stage scale.
    running: filter?.blur ?? null,
    // The banding number. `tapSpacing` is how far apart the blur's samples land on screen in pixels
    // — `blur / quality`, and nothing else moves it (§6.4.8). Much above `TAP_SPACING` and a
    // straight boundary shows the kernel's taps as terraces. `quality` at `MAX_QUALITY` with the
    // spacing still high means the transition width is wider than the pass budget can sample; lower
    // `transitionWidth` or raise the cap.
    quality: filter?.quality ?? null,
    tapSpacing: filter ? +(filter.blur / filter.quality).toFixed(2) : null,
    applied: container?.filters?.[0] === filter && !!filter,
    // Above zero means the halos are also running, which would soften everything twice.
    haloesExpected: !isEnabled(),
    // §6.4.7. `sharpWalls: true` with `wall.segments: 0` is the interesting failure: the composite
    // is running with nothing to protect, so the picture is an ordinary blur.
    sharpWalls: sharpWalls(),
    composited: container?.filters?.[0] === composite && !!composite,
    wall: wallMask.status(),
    children: container?.children?.length ?? null,
  };
  console.error(`${MODULE_ID} | field blur`, report);
  return report;
}
