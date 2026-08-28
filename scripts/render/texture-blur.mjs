/**
 * Softening the brightness field by **blurring the field**. DESIGN.md §6.4.4.
 *
 * Patrick, 2026-08-27: *"is this the best way to resolve these gradients? All we really need is a
 * decent blurring between the two edges of brightness — perhaps there's a simpler way?"*
 *
 * Probably yes, and the reason the module did not already do it is that an earlier finding was
 * applied to the wrong object.
 *
 * ## "A blur cannot make a gradient" was true of a *mesh*, not of the *field*
 *
 * §7.0 step 5 established that blurring an individual mesh cannot produce a gradient, and that is
 * correct: a `PIXI.BlurFilter` fades a mesh's **alpha** at its rim, so what appears there is
 * whatever lies beneath — and beneath a stripe is only the next stripe. Three separate attempts
 * died on it and the conclusion hardened into "a blur is not a gradient".
 *
 * It does not carry over. Blurring the **composited scalar field** is a different operation
 * entirely: a hard step from `0.35` to `1.0` convolved with a kernel *is* a smooth ramp in the
 * value, and the consumer turns that into a smooth colour by `mix(ambientDaylight, ambientDarkness,
 * level)` the same way it turns any other value into one. There is no alpha involved and nothing
 * beneath to reveal.
 *
 * §6.4.2's other conclusion — that the container itself takes no filter — was read off
 * `cached-container.mjs`'s redirect, which only fires when the container is *already* nested inside
 * a filtered parent. That is a statement about the nested case. In the plain case
 * `CachedContainer#render` binds the cached texture and then calls `super.render`, which is where
 * PIXI pushes the filter; the filter's output goes to whatever render texture was bound at push
 * time, which is the cached one. **So it should work, and it is fifteen lines to find out.**
 *
 * ## Why it would be better rather than merely shorter
 *
 * `render/halo.mjs` softens a boundary by *enumerating* it: four polygon offsets, a boolean per
 * ring, a triangulation and a containment test per vertex, for every ground region, on every
 * repaint. It has cost 41 ms of a repaint, and every artefact of the last two rounds has been a
 * property of that machinery rather than of the picture — round joins curving a corner, a fixed arc
 * tolerance faceting a circle, two rings interpolating along a chord.
 *
 * A blur has none of those because it never looks at the geometry. It softens **every** boundary at
 * one width, including the ones nobody enumerated, and it costs one screen-space pass.
 *
 * ## What it gives up, stated plainly
 *
 * - **Shape.** A ramp is the kernel's, not ours; there is no plateau control and a flat region's
 *   corners round slightly.
 * - **Selectivity.** It softens boundaries the model might want hard. That was a live concern while
 *   a region boundary following a wall was supposed to stay crisp (§6.4.2a) and stopped being one
 *   when §6.4.3 made every brightness boundary a gradient.
 * - **Tap count.** The `PIXI.BlurFilter` limitation from §7.0 step 5 is real here too — a fixed
 *   number of taps spread across the radius — but it bites far less: the input is a step rather
 *   than a stripe, so the taps land on a ramp, and the 8-bit texture has ~85 codes between adjacent
 *   tiers to absorb it.
 *
 * Kept **alongside** `render/halo.mjs` rather than replacing it, switched by one setting, so the
 * two can be compared on the same scene. If the blur wins, the halos and most of the per-vertex
 * machinery come out with it.
 */

import { MODULE_ID } from "../constants.mjs";
import { width } from "./transition.mjs";

export const SETTING_BLUR = "blurTransitions";

const MARK = "pf1LightingFieldBlur";

let filter = null;
let lastStrength = null;

/**
 * Blur the composited field instead of enumerating its boundaries?
 *
 * @remarks
 * When on, `render/halo.mjs` emits nothing — the two are alternatives and applying both would
 * soften every boundary twice, at two different widths, which is the state §6.4.3 was written to
 * end.
 */
export function isEnabled() {
  try {
    return game.settings.get(MODULE_ID, SETTING_BLUR) === true;
  } catch {
    return false;
  }
}

export function registerSettings() {
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
 * **Registered through `canvas.addBlurFilter`,** which is what keeps the strength in *world* units:
 * it stores `_configuredStrength` and re-derives `filter.blur` from the stage scale on every zoom
 * (`board.mjs:1657-1670`). Without it the transition would be a fixed number of screen pixels and
 * would appear to widen as the GM zoomed out — the same trap `soften.groundSoftness` documents.
 *
 * `padding` matters more than it looks. A filter samples outside its own bounds, and the container
 * is exactly the size of the screen; without padding the blur has nothing to reach for at the
 * edges and darkens the border of the map.
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
      lastStrength = null;
      container.renderDirty = true;
    }
    return null;
  }

  // Half the transition width: a Gaussian's visible extent is roughly twice its strength, so this
  // is what makes one `transitionWidth` on screen mean the same distance it means to a spill band
  // or a light's zone.
  const strength = width() / 2;

  if (!(strength > 0)) {
    if (filter) {
      canvas.blurFilters?.delete(filter);
      container.filters = null;
      filter = null;
    }
    return null;
  }

  if (!filter) {
    // Quality 4 and a 15-tap kernel: the tap count is the one place §7.0 step 5's finding still
    // applies, and this is the smooth end of what `PIXI.BlurFilter` offers.
    filter = new PIXI.BlurFilter(strength, 4, undefined, 15);
    filter[MARK] = true;
    filter.padding = 0;
    container.filters = [filter];
  }

  if (force || lastStrength !== strength) {
    filter._configuredStrength = strength;
    canvas.addBlurFilter(filter);
    lastStrength = strength;
    container.renderDirty = true;
  }

  return { strength, applied: container.filters?.[0] === filter };
}

/** Scene teardown — the container goes with the canvas, so this only drops our references. */
export function dispose() {
  if (filter) canvas?.blurFilters?.delete(filter);
  filter = null;
  lastStrength = null;
}

/**
 * Debug readout.
 *
 * @remarks
 * `applied: true` with nothing visibly softer is the one interesting failure, and it means the
 * filter is attached but its output is not reaching the cached texture — which is the open question
 * this file exists to settle. Compare `sampled` on either side of a boundary with
 * `render.meshAt()`: a blurred field reads intermediate values there and an unblurred one does not.
 */
export function status() {
  const container = canvas?.effects?.illumination?.darknessLevelMeshes;
  const report = {
    enabled: isEnabled(),
    strength: lastStrength,
    // In world units; `blur` is what PIXI is running, which is this times the stage scale.
    running: filter?.blur ?? null,
    applied: container?.filters?.[0] === filter && !!filter,
    // Above zero means the halos are also running, which would soften everything twice.
    haloesExpected: !isEnabled(),
    children: container?.children?.length ?? null,
  };
  console.error(`${MODULE_ID} | field blur`, report);
  return report;
}
