/**
 * Painting the umbra by withholding revelation, not by re-rendering. DESIGN.md §4.3, §7.0.
 *
 * A mask, not a light. The obvious construction treats an umbra as a suppressor region: inject it
 * into `field()`, let the renderer cut the lights and fill at the clamp tier. Accurate, and the
 * wrong layer — wall line-of-sight is smooth during motion, so the question is what Foundry does
 * that this would not (2026-08-23).
 *
 * Moving a token re-runs that token's own sweep and redraws a mask. It never touches a light
 * source. §9.5 measured that source construction dominates this module's cost, so hanging umbra off
 * the field would put the most expensive operation behind the most frequent event — roughly 10 ms
 * per frame of observer movement, untunable, because the work is real.
 *
 * The principle: per-scene facts belong in sources, per-observer facts belong in masks. An umbra is
 * per-observer by definition.
 *
 * `vision.light.mask` is assigned to the `mask` property of the `vision.light` container
 * (`visibility.mjs:404` — added as a child and set as the mask in one line, easy to read straight
 * past). So:
 *
 * ```
 * visible  =  (light.sources ∪ light.global ∪ light.cached)  ∩  light.mask   ∪   sight
 * ```
 *
 * `light.sources` is the union of every light on the scene and is not observer-relative, which
 * looked fatal — a lit room beyond a darkness is drawn there by its own torch. It is not, because
 * that union is intersected with `light.mask`: keep the umbra out of the mask and the room stops
 * being revealed, however brightly its torch burns.
 *
 * Darkvision falls out with no branch. `vision.sight` is a separate union drawn from
 * `visionSource.shape`, ungated by `light.mask` (`visibility.mjs:408`, `:579`), so withholding only
 * light perception blinds ordinary sight to a Dark umbra and leaves darkvision seeing through it —
 * §4.3's rule, obtained from Foundry's structure rather than by testing senses.
 *
 * Two mechanisms tried and rejected, both instructive.
 *
 * An `ERASE`-blended child of the mask: the obvious way to subtract, and it adds instead.
 * `vision.light.mask` is the `mask` property of `vision.light`, and PIXI renders a Graphics mask
 * through the stencil buffer, which ignores blend modes entirely. The umbra went into the stencil
 * as ordinary coverage, so the region it was meant to hide became the one region reliably revealed.
 * Core's `vision.darkness` gets away with `ERASE` by being a child of `vision`, composited to a
 * texture — not the same thing one level down.
 *
 * Swapping in a trimmed polygon and letting core draw it: nearly right, failing in exactly one
 * case. `light − umbra` yields a ring with a hole whenever the umbra is fully surrounded, and
 * `drawShape` takes a single contour, so keeping the largest ring fills the hole back in — a dark
 * umbra vanished while wholly enclosed and reappeared the moment any part of it reached the rim of
 * the light polygon. Reported 2026-08-23 with exactly that signature. The first version's comment
 * called dropping a ring the conservative error; it is the opposite, since a dropped hole
 * over-reveals.
 *
 * So core is handed an empty polygon and the mask contribution is drawn here instead, with
 * `beginHole`/`endHole` — the only version that survives a fully enclosed umbra.
 *
 * And it must be drawn during the refresh, not after. `refreshVisibility` ends by committing fog,
 * and the commit renders the whole `vision` container, so a contribution added once the method has
 * returned is correct on screen and invisible to exploration. That cost fog of war entirely for a
 * while (2026-08-24); see {@link drawPending}.
 *
 * It hides, it does not dim — a mask is binary. A limitation, but not the whole story: hiding and
 * dimming answer different questions, and this file was briefly deleted-in-place on the mistaken
 * belief that they were the same one.
 *
 * The division with `render/paint.mjs`, corrected 2026-08-23: the two compose, and the clamp tier
 * decides which does the work.
 *
 * | Clamp | Mechanism | Why |
 * | --- | --- | --- |
 * | below `SIGHT_TIER` | this file hides | Dark means the observer perceives nothing there; withholding the reveal is the honest render |
 * | `SIGHT_TIER` and above | the texture dims | Dim means they can see, so hiding would overstate the rule |
 *
 * They also overlap harmlessly on a Dark clamp, and usefully: the mask removes the region from
 * light perception while the texture still writes the tier, so a darkvision observer — whose
 * `vision.sight` is not gated by `light.mask` — gets the region revealed and rendered dark, which
 * neither mechanism produces alone.
 *
 * The wrong version stood this file down entirely whenever the texture was active, reasoning that
 * hiding beats dimming so the two cannot compose. True of one region, irrelevant here: a region's
 * clamp picks its mechanism, so the conflict never arises.
 *
 * Neither dims a region lit by a light source. The texture governs the background only, and a
 * light's mesh composites over it with `MAX_COLOR`, so Dim-clamped torchlight is still unexpressed.
 * Dark-clamped torchlight is fine, the mask removing the light's contribution outright (the
 * illumination layer is masked by the vision texture).
 */

import {
  CLIPPER_SCALE,
  difference,
  fromClipperPaths,
  splitRings,
  toClipperPath,
} from "../geometry.mjs";
import { SIGHT_TIER } from "./perception.mjs";
import { regionsFor } from "./umbra.mjs";

const PATCH_MARK = "pf1LightingUmbraMaskPatched";

/** Handed to core in place of a vision source's light polygon; `drawShape` renders nothing. */
const EMPTY = new PIXI.Polygon([]);

let patched = false;

/**
 * Rings awaiting the `visibilityRefresh` hook, or null between refreshes.
 *
 * @remarks
 * Module-scoped rather than closed over per call, so {@link drawPending} can be a plain listener
 * registered once and a refresh that throws before the hook leaves nothing for the next one to
 * draw.
 */
let pending = null;

/** Diagnostics for the last pass; see {@link status}. */
let lastPass = { observers: 0, trimmed: 0, rings: 0, holes: 0, drawn: 0 };

/**
 * The umbra paths that actually hide something from this observer.
 *
 * @remarks
 * Only regions the observer cannot see at all. `SIGHT_TIER` is the dimmest tier ordinary sight
 * works in, so a Dim-clamped umbra is left alone — the observer can see there, and hiding it would
 * be a worse error than not dimming it.
 */
function blockingPaths(source) {
  const paths = [];
  for (const region of regionsFor(source)) {
    if (region.clamp >= SIGHT_TIER) continue;
    for (const polygon of region.polygons) {
      const path = toClipperPath(polygon, CLIPPER_SCALE);
      if (path.length >= 3) paths.push(path);
    }
  }
  return paths;
}

/**
 * What this observer's light perception should contribute to the mask, umbra removed.
 *
 * @param {PointVisionSource} source
 * @returns {PIXI.Polygon[]|null} Rings to draw, or null to leave the source alone
 */
function trimmedLight(source) {
  const light = source?.light;
  if (!light?.points?.length) return null;

  const blocking = blockingPaths(source);
  if (!blocking.length) return null;

  // One `difference` handles every region at once: Clipper unions the clip set under non-zero fill,
  // so no separate union pass is needed.
  const remaining = difference([toClipperPath(light, CLIPPER_SCALE)], blocking);
  return fromClipperPaths(remaining, CLIPPER_SCALE);
}

/**
 * Draw one observer's trimmed light perception into the mask, holes included.
 *
 * @remarks
 * `beginHole`/`endHole` is the reason this is done by hand — see the header. Same even-odd
 * reasoning as the umbra overlay: a ring wound against the largest one is a hole, and filling it is
 * the bug this replaced.
 */
function drawTrimmed(mask, rings) {
  const { outers, holes } = splitRings(rings);
  mask.beginFill(0xffffff, 1);
  for (const polygon of outers) {
    if (polygon.points?.length) mask.drawPolygon(polygon.points);
  }
  for (const polygon of holes) {
    if (!polygon.points?.length) continue;
    mask.beginHole();
    mask.drawPolygon(polygon.points);
    mask.endHole();
  }
  mask.endFill();
  lastPass.rings += outers.length;
  lastPass.holes += holes.length;
}

/**
 * Substitute trimmed light perception for the duration of one visibility refresh.
 *
 * @remarks
 * A prototype patch, and a second wrapper on `refreshVisibility` alongside `clip.patchVisibility` —
 * deliberately separate rather than merged, the two answering different questions on different
 * sides of the module's layering. Merging them would mean `render/` importing from `vision/`.
 *
 * `source.light` is a plain assigned property (`point-vision-source.mjs:232`), restored in a
 * `finally`. `los` is never touched, which matters: the umbra is computed from `los` and cached on
 * its identity, so modifying it would invalidate the cache that produced the modification.
 */
export function applyPatch() {
  if (patched) return;
  const proto = foundry.canvas.groups?.CanvasVisibility?.prototype;
  if (!proto?.refreshVisibility || proto[PATCH_MARK]) return;
  patched = true;
  proto[PATCH_MARK] = true;

  const original = proto.refreshVisibility;
  proto.refreshVisibility = function pf1LightingUmbraRefreshVisibility(...args) {
    lastPass = { observers: 0, trimmed: 0, rings: 0, holes: 0, drawn: 0 };

    const swapped = [];
    pending = [];

    for (const source of canvas.effects?.visionSources ?? []) {
      if (!source.active) continue;
      lastPass.observers++;
      let rings = null;
      try {
        rings = trimmedLight(source);
      } catch (error) {
        // A geometry fault must never stop the canvas drawing its visibility. Failing open leaves
        // the pre-umbra picture rather than a broken one.
        console.error("PF1 Lighting | umbra mask trim failed", error);
      }
      if (!rings) continue;
      swapped.push([source, source.light]);
      // Core is given nothing to draw for this source; the trimmed version is drawn below, only a
      // hand-drawn contribution being able to carry holes.
      source.light = EMPTY;
      if (rings.length) pending.push(rings);
      lastPass.trimmed++;
    }

    try {
      return original.apply(this, args);
    } finally {
      for (const [source, light] of swapped) source.light = light;
      // The draw happens in `visibilityRefresh`, mid-call — see {@link drawPending}. What is left
      // here is dropping anything the hook did not consume, so a throw before the hook cannot leave
      // stale rings for the next refresh.
      pending = null;
    }
  };

  // Ordering is the point of using the hook. Core calls `visibilityRefresh` immediately before its
  // `endFill`s and before `canvas.fog.commit()` (`groups/visibility.mjs:588-606`), the only window
  // where a contribution to `vision.light.mask` is both inside the fill and visible to fog.
  Hooks.on("visibilityRefresh", drawPending);
}

/**
 * Draw the trimmed light perception this refresh computed, into the mask core is still filling.
 *
 * @remarks
 * This used to run in the wrapper's `finally`, and that broke fog of war (found 2026-08-24, reported
 * as non-darkvision tokens clearing no fog at all and darkvision tokens clearing only their
 * darkvision radius).
 *
 * `refreshVisibility` ends with `if ( commitFog ) canvas.fog.commit()`, and `commit()` renders the
 * whole `vision` container, masked by `vision.light.mask` (`perception/fog.mjs:330-355`). Drawing
 * after `original` returned put the contribution in after that snapshot. The mask is a persistent
 * `LegacyGraphics`, so the screen was right from the next frame onward and only the exploration
 * texture was wrong — which is why it survived every visual check. A deferred write is invisible to
 * everything except the one consumer that reads mid-call.
 *
 * The symptoms follow from what was left in the mask at commit time. Each swapped source had been
 * handed {@link EMPTY}, so light perception contributed nothing, and `vision.sight` — a sibling of
 * `vision.light`, and so unmasked — was all fog ever saw. A token with no darkvision has
 * `visionSource.radius === 0` and draws no sight FOV, so it explored nothing; a token with
 * darkvision explored its darkvision radius and no further.
 *
 * `commitFog` is unaffected by the swap: core sets it from
 * `lightRadius > 0 && !blinded && !isPreview`, never from what the polygon contains, so an empty
 * shape still schedules the commit. That is why fog updated at all rather than freezing, which
 * would have been a much louder failure.
 *
 * @param {CanvasVisibility} visibility
 */
function drawPending(visibility) {
  const rings = pending;
  // Consume only what this module's wrapper set on this call. A `visibilityRefresh` raised from
  // anywhere else finds nothing, and the `finally` clears it if this was never reached.
  pending = null;
  if (!rings?.length) return;

  const mask = visibility?.vision?.light?.mask;
  if (!mask) return;

  for (const ring of rings) {
    try {
      drawTrimmed(mask, ring);
      lastPass.drawn++;
    } catch (error) {
      console.error("PF1 Lighting | umbra mask draw failed", error);
    }
  }
}

/**
 * Console readout.
 *
 * @remarks
 * The per-observer geometry is here because a bare pass/fail counter cannot separate the several
 * ways this goes quiet: a bounded `lightRadius` bounding the trim, a wall making the umbra genuinely
 * short, or every region resolving to Dim and being left alone deliberately.
 *
 * `holes` is worth watching. A dark umbra fully enclosed by a dim one produces exactly one, and
 * mishandling it is what made an enclosed umbra vanish.
 *
 * `drawn` must equal `trimmed`. They differ only if the `visibilityRefresh` hook did not reach
 * {@link drawPending} — the shape the fog-of-war bug had, and the shape it would have again if
 * anything swallowed that hook. The screen looks correct either way.
 */
export function status() {
  const observers = [];
  for (const source of canvas?.effects?.visionSources ?? []) {
    if (!source.active) continue;
    const regions = regionsFor(source);
    observers.push({
      id: source.sourceId,
      lightRadius: Math.round(source.lightRadius ?? 0),
      losRadius: Math.round(source.los?.config?.radius ?? 0),
      // Foundry returns `los` itself when unconstrained, so true means light perception is
      // scene-wide and cannot be limiting the shadow.
      lightIsLos: source.light === source.los,
      regions: regions.length,
      clamps: regions.map((r) => r.clamp),
      // Only regions below `SIGHT_TIER` hide anything. `blocking: 0` with `regions > 0` is the
      // documented Dim limitation rather than a fault.
      blocking: regions.filter((r) => r.clamp < SIGHT_TIER).length,
    });
  }

  const report = {
    patched,
    ...lastPass,
    observers,
    // Not observer-relative: such a light draws its full polygon into `light.mask`
    // (`visibility.mjs:542-546`), and drawing a separate contribution does not remove it. A
    // non-zero count here is the remaining known hole in this approach.
    visionProvidingLights: [...(canvas?.effects?.lightSources ?? [])].filter(
      (s) => s.active && s.data?.vision
    ).length,
  };
  console.error("PF1 Lighting | umbra mask", report);
  return report;
}
