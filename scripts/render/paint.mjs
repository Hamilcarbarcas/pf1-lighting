/**
 * What the darkness-level texture should say, for **this** observer. DESIGN.md §4.3, §7.0.
 *
 * `field()` answers "how bright is the ground everywhere", god's eye, once per scene state.
 * That is the right decomposition for light sources and the wrong one for umbra, which is a
 * property of the *path* between an observer and a point (§4.3) and so has no god's-eye answer
 * at all. This file is the seam: it takes the field's cells, clamps them where the selected
 * observer is looking through a darkness, and hands the result to the painter.
 *
 * ## Why this is not part of `renderer.rebuild()`
 *
 * **Because it runs on a different clock.** The renderer is driven by field staleness and ends
 * by re-initialising every source whose clip changed — §9.5 measured source construction as the
 * dominant cost in the whole module. Umbra changes whenever an observer *moves*, which is the
 * most frequent event there is. Putting one behind the other would pay ~10 ms of source
 * construction per frame of a token drag to express something that costs a triangulation.
 *
 * So the two are split: sources rebuild when the scene changes, the texture repaints when
 * either the scene **or** the point of view changes. Nothing here constructs a source.
 *
 * ## Overlap is not an option, and that decides the whole shape
 *
 * The obvious implementation — paint the umbra as extra meshes on top of the ambient — cannot
 * work. `invalidateDarknessLevelContainer` sorts the container by darkness level *descending*,
 * so where two meshes overlap the **lowest level wins**, i.e. the brightest
 * (`illumination-effects.mjs:106-110`). An umbra laid over the ambient would be erased by the
 * ambient, which is the exact opposite of the intent.
 *
 * So the shadow is not added, it is **cut in**: each base cell is split against the shadow, the
 * inside piece taking the clamped tier and the outside piece keeping its own. The result stays
 * a disjoint set, which is the invariant the painter needs.
 *
 * Two things keep that cheap. A cell already at or below the clamp is skipped whole — the clamp
 * only ever darkens (§4.3) — which on a typical scene leaves just the ambient cell to split.
 * And the whole pass is skipped unless something it depends on changed.
 *
 * ## Several observers
 *
 * §5.3's rule is `max` over observers of the resolved brightness: a point shadowed for one
 * creature and lit for another is **lit**. That is exact and cheap here rather than an
 * approximation, because
 *
 * ```
 * { p : max_o clamp_o(p) <= C }  ==  ∩_o { p : clamp_o(p) <= C }
 * ```
 *
 * — so the region clamped to `C` or darker is the *intersection* of the observers' own such
 * regions, and an observer with no umbra at all short-circuits the entire pass to "no clamp
 * anywhere", which is correct and is the common case the moment anyone has *see in darkness*.
 */

import { MODULE_ID, SETTING_RENDER } from "../constants.mjs";
import {
  CLIPPER_SCALE,
  difference,
  fromClipperPaths,
  groupRings,
  intersection,
  toClipperPath,
  union,
} from "../geometry.mjs";
import * as field from "../model/field.mjs";
import * as umbra from "../vision/umbra.mjs";
import * as ambientTakeover from "./ambient.mjs";
import * as darknessTexture from "./darkness-texture.mjs";

let signature = null;
let lastStats = null;
let scheduled = false;

/**
 * Both switches, because painting needs both.
 *
 * The setting is read from `constants.mjs` rather than from `renderer.mjs`, which registers it:
 * the renderer imports this module, so importing it back would be a cycle.
 */
function active() {
  if (!ambientTakeover.isEnabled()) return false;
  try {
    return game.settings.get(MODULE_ID, SETTING_RENDER) === true;
  } catch {
    return false;
  }
}

/* -------------------------------------------- */
/*  Inputs                                      */
/* -------------------------------------------- */

/** Active vision sources, in a stable order so the signature is comparable. */
function observers() {
  return [...(canvas?.effects?.visionSources?.values() ?? [])].filter((s) => s.active);
}

/**
 * Cell kinds that say how bright the **ground** is, and therefore paint into the texture.
 *
 * @remarks
 * `clip`, `reduced` and `stack` are light and belong to sources. The rest are ground:
 *
 *   - `ambient` — the scene's own tier, where no suppressor governs
 *   - `dark` — a suppressor's region, at the transformed ambient tier
 *
 * **`stack` was here and is deliberately not any more (2026-08-23).** A flat fill in the
 * texture could not sit next to a light: `SWITCH_COLOR` blends a light's two zones across 72%
 * of its ratio at the default attenuation (`base-lighting.mjs:312-318`), so a light is nearly
 * all gradient and a plateau butted against it reads as a hard step. Stack cells are now drawn
 * by cloning their own emitters at a raised level, which reproduces the same curve — see
 * `renderer.mjs`.
 *
 * The cost of that move is the umbra clamp: an overlap is a light now, and a light in an umbra
 * dims without clamping (§7.0). Accepted deliberately (Patrick, 2026-08-23) because the torches
 * that *made* the overlap already behave that way — the clamped stack cell was the one thing in
 * the region that did not.
 */
const GROUND_KINDS = new Set(["ambient", "dark"]);

/** The field's paintable cells: everything whose job is to say how bright the ground is. */
function baseCells() {
  const out = [];
  for (const cell of field.get().cells) {
    if (!GROUND_KINDS.has(cell.kind)) continue;
    if (cell.tier === undefined) continue;
    out.push(cell);
  }
  return out;
}

/**
 * Cumulative shadow regions, darkest tier first.
 *
 * @returns {{clamp: number, paths: object[][]}[]} Each entry is *"everywhere clamped to this
 *   tier or darker"* — cumulative, not disjoint. {@link applyShadows} relies on that: it
 *   processes darkest first and skips cells already at or below the clamp, so the cumulative
 *   regions produce disjoint output with no extra difference.
 */
function shadowRegions() {
  const sources = observers();
  // God's eye. No observer, no path, no umbra — §5.4.
  if (!sources.length) return [];

  const perObserver = sources.map((source) => umbra.regionsFor(source));
  // One observer that shadows nothing means `max` over observers clamps nothing, anywhere.
  // Also the state when `umbraPerception` is off, which is why no separate check is needed.
  if (perObserver.some((regions) => !regions.length)) return [];

  const tiers = new Set();
  for (const regions of perObserver) for (const region of regions) tiers.add(region.clamp);
  // Darkest first. TIER ascends with brightness, so Supernatural Dark (0) leads.
  const ordered = [...tiers].sort((a, b) => a - b);

  const out = [];
  for (const clamp of ordered) {
    const perObserverPaths = perObserver.map((regions) =>
      union(
        regions
          .filter((region) => region.clamp <= clamp)
          .flatMap((region) => region.polygons.map((p) => toClipperPath(p, CLIPPER_SCALE)))
          .filter((path) => path.length >= 3)
      )
    );

    if (perObserverPaths.some((paths) => !paths.length)) continue;

    // `∩` across observers, exactly as the identity above requires. One observer needs none.
    let paths = perObserverPaths[0];
    for (let i = 1; i < perObserverPaths.length && paths.length; i++) {
      paths = intersection(paths, perObserverPaths[i]);
    }
    if (paths.length) out.push({ clamp, paths });
  }
  return out;
}

/* -------------------------------------------- */
/*  The split                                   */
/* -------------------------------------------- */

/** A cell's rings as Clipper paths — outer plus holes, which `pftNonZero` reads correctly. */
function cellPaths(cell) {
  const paths = [toClipperPath(cell.polygon, CLIPPER_SCALE)];
  for (const hole of cell.holes ?? []) {
    const path = toClipperPath(hole, CLIPPER_SCALE);
    if (path.length >= 3) paths.push(path);
  }
  return paths;
}

/** Rebuild a cell over new geometry at a new tier. */
function cellsFromPaths(paths, template, tier) {
  return groupRings(fromClipperPaths(paths, CLIPPER_SCALE)).map(({ outer, holes }) => ({
    ...template,
    polygon: outer,
    holes,
    tier,
  }));
}

/**
 * Cut the shadow into the cells.
 *
 * @param {object[]} cells
 * @param {{clamp: number, paths: object[][]}[]} shadows - Darkest first
 * @returns {{cells: object[], ops: number, split: number}}
 */
function applyShadows(cells, shadows) {
  let working = cells;
  let ops = 0;
  let split = 0;

  for (const { clamp, paths } of shadows) {
    const next = [];
    for (const cell of working) {
      // **The clamp only ever darkens** (§4.3). A cell already at or below it is finished, and
      // skipping it here is what keeps the common scene down to a single split: with a Dark
      // clamp, every `dark` cell is already Dark or lower and only the ambient survives to be
      // cut. Nothing between two points can make the far one brighter.
      if (cell.tier <= clamp) {
        next.push(cell);
        continue;
      }

      const subject = cellPaths(cell);
      const inside = intersection(subject, paths);
      ops++;
      if (!inside.length) {
        next.push(cell);
        continue;
      }

      const outside = difference(subject, paths);
      ops++;
      split++;

      next.push(...cellsFromPaths(inside, cell, clamp));
      next.push(...cellsFromPaths(outside, cell, cell.tier));
    }
    working = next;
  }

  return { cells: working, ops, split };
}

/* -------------------------------------------- */
/*  Driving it                                  */
/* -------------------------------------------- */

/**
 * Everything the painted result depends on, as references.
 *
 * @remarks
 * The same identity trick the umbra cache and `field.currentSignature` use, for the same reason:
 * both dependencies announce a change by *becoming a different object*. `field.get()` returns
 * the same object until the scene changes, and `source.los` is **replaced** by `_createShapes`
 * rather than mutated, so an observer stepping one pixel invalidates the pass and nobody else's
 * movement does.
 *
 * That is what makes this safe to hang off `refreshToken`, which fires far above frame rate.
 */
function currentSignature() {
  const parts = [field.get()];
  for (const source of observers()) parts.push(source.los);
  return parts;
}

function matches(next) {
  if (!signature || signature.length !== next.length) return false;
  for (let i = 0; i < next.length; i++) if (signature[i] !== next[i]) return false;
  return true;
}

/**
 * Recompute and repaint the tier field for the current point of view.
 *
 * @param {object} [options]
 * @param {boolean} [options.force] - Repaint even if nothing it depends on changed
 * @returns {object|null}
 */
export function repaint({ force = false } = {}) {
  if (!canvas?.ready) return null;

  if (!active()) {
    if (lastStats) {
      darknessTexture.clear();
      lastStats = null;
      signature = null;
    }
    return null;
  }

  const next = currentSignature();
  if (!force && matches(next)) return lastStats;
  signature = next;

  const t0 = performance.now();
  const base = baseCells();
  const shadows = shadowRegions();
  const { cells, ops, split } = shadows.length
    ? applyShadows(base, shadows)
    : { cells: base, ops: 0, split: 0 };

  const painted = darknessTexture.paint(cells);

  lastStats = {
    base: base.length,
    painted,
    shadows: shadows.length,
    // Cells the shadow actually cut. Zero with `shadows` above zero is the state that reads as
    // "umbra painting is broken" and usually is not — see {@link explainQuiet}.
    split,
    ops,
    ms: +(performance.now() - t0).toFixed(2),
    ...(shadows.length && !split ? { quiet: explainQuiet(base, shadows) } : {}),
  };
  return lastStats;
}

/**
 * Why did a live shadow cut nothing?
 *
 * @remarks
 * **`shadows > 0, split: 0` is the single most misleading state this pass can be in**, because
 * it looks identical to a broken clamp and is almost always correct. There are two ordinary
 * reasons and they need opposite responses, so the readout names which:
 *
 *   - *nothing to darken* — the umbra falls on ground with no cell under it. At scene darkness
 *     1 there is no `ambient` cell at all (`ambientB` is 0, so `field()` emits none), and the
 *     texture is already at its clear colour there. Correct, and invisible: **umbra painting
 *     needs a lit scene to show anything.**
 *   - *already dark enough* — every cell the shadow lands on is at or below the clamp. A Dark
 *     umbra over `dark` cells is a no-op by definition (§4.3, the clamp only darkens).
 *
 * The third possibility, a clamp that should have bitten and did not, is what is left when
 * neither line fits.
 */
function explainQuiet(base, shadows) {
  const darkest = Math.min(...shadows.map((s) => s.clamp));
  const above = base.filter((cell) => cell.tier > darkest).length;
  if (!base.length) return "no ambient or dark cells at all — a lit scene is needed to see this";
  if (!above) return `every cell is already at or below the clamp (tier ${darkest})`;
  return `${above} cell(s) above the clamp were not cut — the shadow may not reach them`;
}

/** Coalesce to one repaint per frame; the driving hooks fire well above frame rate. */
function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    repaint();
  });
}

export function registerHooks() {
  // `initializeVisionSources` is the signal that an observer's `los` was rebuilt, which is the
  // umbra half; the rest are the field half, matching the renderer's set for the same reasons
  // (a light-bearing token moving does not fire `initializeLightSources`).
  for (const hook of [
    "initializeVisionSources",
    "initializeLightSources",
    "refreshAmbientLight",
    "refreshToken",
    "canvasReady",
  ]) {
    Hooks.on(hook, () => schedule());
  }

  Hooks.on("canvasTearDown", () => {
    signature = null;
    lastStats = null;
  });
}

/** Drop the cached signature so the next call recomputes. */
export function invalidate() {
  signature = null;
}

/**
 * Debug readout.
 *
 * @remarks
 * `shadows` above zero with `split` at zero is the interesting state and not a fault: the
 * observer *is* looking through a darkness, and every cell it falls on was already at or below
 * the clamp. On an unlit scene that is every cell, which is why umbra painting shows nothing
 * there and shows a great deal at noon.
 */
export function stats() {
  const report = {
    enabled: active(),
    observers: observers().length,
    umbraTiers: shadowTiers(),
    ...(repaint({ force: true }) ?? { note: "needs the renderer and 'Model global illumination'" }),
    texture: darknessTexture.status(),
  };
  console.error(`${MODULE_ID} | tier paint`, report);
  return report;
}

/** Which clamp tiers are currently shadowing anything. */
const shadowTiers = () => shadowRegions().map((s) => s.clamp);
