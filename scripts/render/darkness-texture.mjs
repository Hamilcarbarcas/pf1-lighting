/**
 * Painting the model's tiers into Foundry's **darkness-level texture**. DESIGN.md §7.0.
 *
 * The renderer's other half expresses "this area is Dim" by synthesising a *light source* — an
 * object with an origin, a falloff, a wall sweep, a darkness band and a dozen uniforms — where
 * what the model actually has is a number. Every seam bug of 2026-08-23 was a property of
 * `GlobalLightSource` that a stand-in had failed to clone.
 *
 * Foundry has exactly one channel shaped like *"here is my computed field, please render it"*:
 * `canvas.effects.illumination.darknessLevelMeshes`, a cached container rendered to a texture
 * and handed to every lighting **and vision** shader as `darknessLevelTexture`. That second
 * word is the whole reason this file exists. A region written here keeps its brightness
 * *through* a vision source's paint, so god's eye, *true seeing* and see-in-darkness all still
 * show the map's light levels instead of flattening them — which a light fill structurally
 * cannot do, because `vision.sight` is not gated by `light.mask` and revealing is the same act
 * as brightening (§4.5.1).
 *
 * ## Two meshes per region, and they answer different questions
 *
 * Core's own "Adjust Darkness Level" behaviour makes a pair, and so do we
 * (`data/region-behaviors/adjust-darkness-level.mjs:68-85`):
 *
 * | Mesh | Container | Question |
 * | --- | --- | --- |
 * | `AdjustDarknessLevelRegionShader` | `illumination.darknessLevelMeshes` | how **bright** is this ground |
 * | `IlluminationDarknessLevelRegionShader` | `visibility.vision.light.global.meshes` | does global light **reveal** it |
 *
 * The second is only created where the answer is *no*. `#refreshDynamicIllumination`
 * (`groups/visibility.mjs:643-651`) walks that container and flips a mesh to `ERASE` when its
 * darkness level falls outside the global light's band — so a mesh there cuts the region out of
 * what global illumination lets a creature see, which is exactly what a *darkness* should do to
 * a normal-sighted observer, while darkvision (which comes from `vision.sight`) is untouched.
 *
 * ## What this file draws, and what composites over it
 *
 * These meshes are the **partition**: one per merged ground region, opaque, flat. They are the base
 * layer and nothing here overlaps anything else here.
 *
 * Three other passes composite on top, and they are not in this file — `render/gradient.mjs` owns
 * the pool, `render/darkness-shaders.mjs` owns the order:
 *
 * ```
 *   6      seam backstop            (retired; see backstopFor)
 *   4‥5    §3.4 spill gradients
 *   2‥3    these meshes             GROUND_SORT + level
 *   1      light contributions      MIN_COLOR — brightest wins
 *   0.5    ground halos             MIN_COLOR — only when the field blur is off
 *   0      clamps                   MAX_COLOR — darkest wins, drawn last
 * ```
 *
 * `MIN`/`MAX` on a *darkness* level are brightest-wins and darkest-wins per fragment, which is why
 * overlap is the mechanism rather than the hazard it was before §7.0 step 6. An earlier version of
 * this note said the opposite and was correct about the default blend mode.
 *
 * Since §6.4.4 the whole container is blurred in one pass, which is what softens every boundary in
 * it — see `render/texture-blur.mjs`. The only filter left on an individual mesh is the one on the
 * `il` half (§6.4.5), where alpha genuinely *is* the quantity.
 *
 * The texture is cleared to `canvas.environment.darknessLevel`, and since §7.0 step 6 the ground
 * covers the scene rect unconditionally, so that clear is unreachable.
 *
 * ## Duck-typing a Region
 *
 * `RegionMesh` wants a Region placeable and we have bare polygons. It reads five things, and a
 * missing one throws **inside PIXI's render loop** — once per frame, blacking the canvas out
 * rather than producing an attributable error. They are enumerated in {@link regionStub} rather
 * than discovered, after two were found one crash at a time during the spike.
 */

import { MODULE_ID } from "../constants.mjs";
import {
  CLIPPER_SCALE,
  containsPoint,
  fromClipperPaths,
  groupRings,
  toClipperPath,
  union,
} from "../geometry.mjs";
import { BACKSTOP_SORT, GROUND_SORT, classes } from "./darkness-shaders.mjs";
import * as gradient from "./gradient.mjs";
import { darknessFor } from "./levels.mjs";
import * as fieldBlur from "./texture-blur.mjs";
import { width as transitionWidth } from "./transition.mjs";

/**
 * `AdjustDarknessLevelRegionBehaviorType.MODES.OVERRIDE` — the level *is* the number, rather
 * than a modifier on the scene's. The model has already resolved what the ground should be.
 */
const MODE_OVERRIDE = 0;

/**
 * The modifier given to an erasing illumination mesh.
 *
 * @remarks
 * Core expresses "this region is not lit by global light" as *outside the global light's
 * darkness band* (`visibility.mjs:646`), and going through its own test is what also sets
 * `#needsContainment` — a private field that enables the fence filter keeping an `ERASE` blend
 * inside the container. Setting `blendMode` by hand would skip that.
 *
 * `-1` is below **every** possible band because `darkness.min` is an `AlphaField` and so is
 * never negative (`common/data/data.mjs:64`). The upper bound is not usable for this: its
 * default is 1 and nothing exceeds it.
 *
 * This value only ever reaches the band comparison. The erasing shader's fragment program
 * writes `vec4(1.0)` and never reads the level, and the *brightness* of the region is carried
 * by the other mesh of the pair.
 */
const ERASE_MODIFIER = -1;

/**
 * Modifier for a parked illumination mesh.
 *
 * @remarks
 * Zero rather than {@link ERASE_MODIFIER} because `#refreshDynamicIllumination` walks *every*
 * child of the container, visible or not, and a parked mesh left out of band would keep setting
 * `#needsContainment` and so keep the fence filter on for nothing. Zero is inside the default
 * band; a GM who has raised `darkness.min` above it costs a redundant filter and nothing more,
 * since a parked mesh does not draw.
 */
const PARKED_MODIFIER = 0;

/** Pool of mesh pairs, reused across rebuilds. @type {object[]} */
const pool = [];
let used = 0;

/** Cells the level merge collapsed on the last paint — see {@link mergeByLevel}. */
let merged = 0;

/** Whether the last paint added a seam backstop — see {@link backstopFor}. */
let backstopped = false;

/* -------------------------------------------- */
/*  Ground softening (§6.4.2, reopened)         */
/* -------------------------------------------- */

/**
 * Blur quality — how many passes the separable blur makes per axis.
 *
 * @remarks
 * Core uses 2 for its own darkness mesh (`adjust-darkness-level.mjs:71`) rather than
 * `CONFIG.Canvas.blurQuality`, which defaults to 4. Matching core: this is a soft boundary
 * between two flat values, not a bloom, and the second pass is already past the point where
 * another one is visible. It doubles as a cost lever if the filter turns out to be expensive.
 */
const BLUR_QUALITY = 2;

/**
 * **A §3.4 spill band is no longer blurred at all — it is a gradient mesh.** DESIGN.md §7.0 step 5.
 *
 * @remarks
 * Three settings lived here and all three are gone: a spill-specific softening multiplier, a blur
 * pass count and a blur tap count. Each was an attempt to make a falloff read as a gradient by
 * filtering flat stripes, and the last of them found why none of them could:
 * `PIXI.BlurFilter(strength, quality, resolution, kernelSize)` spreads a **fixed** number of taps
 * across its width rather than adding more, so a wide blur samples five points eleven pixels apart
 * and produces a staircase. Raising the taps to 15 helped and still bounded the result at the
 * number of stripes underneath it, because a blur softens a boundary between two levels and cannot
 * invent one between them.
 *
 * `render/gradient.mjs` draws the falloff as one mesh with a level per vertex instead, which the
 * rasteriser interpolates per fragment. Spill cells that were not clamped by an umbra are skipped
 * here — see {@link mergeByLevel} — so nothing in this file feathers them any more.
 */

/**
 * Detach any blur left on a ground mesh, and keep the one on its erase partner in step.
 *
 * @remarks
 * **Only the darkness-level mesh, never the illumination one.** `entry.il` answers a *binary*
 * question — does global light reveal this region — by being in or out of a band
 * (`visibility.mjs:643-651`), and its fragment program writes `vec4(1.0)` without ever reading a
 * level. Blurring a mesh whose only content is "yes" produces a soft-edged yes, which is not a
 * softer boundary but a partially transparent one. The reveal edge stays hard; that is §6.4.2's
 * `eraseDisabled` experiment's whole subject and it is a separate question from this one.
 *
 * **Detached at zero, not zeroed.** A `PIXI.BlurFilter` at strength 0 still costs a filtered
 * render pass — an extra texture allocation, a blit out and a blit back — per mesh per container
 * render. `filters = null` costs nothing.
 *
 * Registration goes through `canvas.addBlurFilter` (via `createBlurFilter`) so the strength is
 * kept in **world** units and re-derived on zoom; re-adding an existing filter is safe, since
 * `blurFilters` is a `Set` and `addBlurFilter` recomputes from `_configuredStrength`.
 */
function syncFilter(entry) {
  // **The ground blur is retired, since §6.4.3.** It was the module's only softening that was not
  // a gradient: a `PIXI.BlurFilter` fades a mesh's *alpha* to reveal whatever is beneath it, which
  // can soften a boundary between two levels but — as §7.0 step 5 established the hard way — can
  // never invent one between them. §6.4.4 now blurs the composited field instead, in one pass.
  const dl = entry.dl;
  if (dl && !dl._destroyed && dl.filters?.length) dl.filters = null;

  syncEraseFilter(entry);
}

/**
 * Soften the **reveal** boundary — the last hard edge on the map. DESIGN.md §6.4.5.
 *
 * @remarks
 * Patrick, 2026-08-27, with the two halves of the diagnosis in two sentences: *"it doesn't seem to
 * be applying to borders between a light and dark source when the darkness is overriding the
 * light"*, and then *"only has this effect when the global illumination is brighter than dim"*.
 *
 * That second clause names the mechanism outright. `darknessFor` sets `erase` when a region is
 * darker than `globalLightCutoff()`, which **is** the Dim threshold; an erasing region gets a
 * second mesh in `canvas.visibility.vision.light.global.meshes`, blended `ERASE`, cutting it out of
 * what global illumination reveals. That container is not the darkness-level texture, so §6.4.4's
 * field blur cannot reach it — and it only *matters* where global light is actually revealing,
 * which is exactly "brighter than Dim".
 *
 * §6.4.2a recorded this as permanent — *"whether global illumination reveals a region is a
 * yes-or-no question rather than a level"* — and `create()` refused to blur these meshes on the
 * grounds that "blurring a mesh whose only content is *yes* produces a soft-edged yes, which is not
 * a softer boundary but a partially transparent one."
 *
 * **That is exactly what is wanted here, and the objection had the sign backwards.** The quantity
 * this mesh carries *is* coverage: it writes `vec4(1.0)` and composites `ERASE`. A blurred rim is a
 * partially transparent erase, which is a *partial reveal* — a gradient in precisely the variable
 * the boundary is made of. It is the one place in this module where blurring alpha is the correct
 * operation rather than a substitute for a gradient, and that is why it survives §6.4.3's removal
 * of every other filter.
 *
 * Matched to the field blur's strength so the reveal boundary and the brightness boundary fade over
 * the same distance; they are the same edge to look at.
 */
function syncEraseFilter(entry) {
  const mesh = entry.il;
  if (!mesh || mesh._destroyed) return;

  const strength = entry.erase && fieldBlur.isEnabled() ? transitionWidth() / 2 : 0;

  if (!(strength > 0)) {
    if (entry.eraseBlur) {
      canvas?.blurFilters?.delete(entry.eraseBlur);
      entry.eraseBlur = null;
    }
    if (mesh.filters?.length) mesh.filters = null;
    return;
  }

  if (!entry.eraseBlur) entry.eraseBlur = canvas.createBlurFilter(strength, 4);
  else if (entry.eraseBlur._configuredStrength !== strength) {
    entry.eraseBlur._configuredStrength = strength;
    canvas.addBlurFilter(entry.eraseBlur);
  }

  // **The filter composites, not the mesh.** PIXI renders a filtered display object into a
  // temporary texture and then draws *that* with `filter.blendMode`, which defaults to `NORMAL`.
  // So attaching a blur to an `ERASE`-blended mesh quietly converts it into a normal-blended one:
  // it stops erasing and starts painting white into the global light's mask, which is either
  // invisible or the exact opposite of the intent depending on what lies under it.
  //
  // Read off the mesh rather than assumed, because core owns it — `#refreshDynamicIllumination`
  // assigns `ERASE` or `MAX_COLOR` per mesh depending on whether the region falls outside the
  // global light's band (`visibility.mjs:643-651`), and it runs on its own clock.
  entry.eraseBlur.blendMode = mesh.blendMode;

  if (mesh.filters?.[0] !== entry.eraseBlur) mesh.filters = [entry.eraseBlur];
}

/**
 * A cell's outer ring and holes as Clipper paths.
 *
 * @remarks
 * A near-twin of `paint.mjs`'s function of the same name, and kept separate for the reason
 * `geometry.mjs`'s header already gives about `field.mjs`: the two call sites want the same
 * conversion at different moments in the pipeline, and sharing it would create a dependency
 * between the umbra pass and the texture for the sake of six lines.
 */
function cellPaths(cell) {
  const paths = [toClipperPath(cell.polygon, CLIPPER_SCALE)];
  for (const hole of cell.holes ?? []) {
    const path = toClipperPath(hole, CLIPPER_SCALE);
    if (path.length >= 3) paths.push(path);
  }
  return paths;
}

/**
 * Union every cell that resolves to the same darkness level into one region.
 *
 * @remarks
 * **Required by the blur, and it is the fix for the halo (found 2026-08-24).**
 *
 * The model's cells partition the scene by *treatment* (§6.1), not by brightness, so two cells
 * that abut can carry the identical level. Inside an umbra that is the normal case rather than
 * an edge case: `applyShadows` skips any cell already at or below the clamp, so a *darkness*
 * disc stays its own `dark` cell while the surrounding ambient is cut down to the same Dark by
 * the shadow. Two meshes, one brightness, sharing an exact boundary.
 *
 * Unblurred that is invisible, because the two meshes are opaque and abut exactly. Blurred it is
 * not: a `BlurFilter` fades a mesh's **alpha** at its rim, both meshes fade at the shared edge,
 * and neither covers it fully — so the composite there is partly the container's clear colour,
 * which is `canvas.environment.darknessLevel`. On a lit map that clear is much *brighter* than
 * either neighbour, and it shows through as a bright ring around every darkness inside a shadow.
 * Patrick reported exactly that, and the tell was that the rings appeared on ground that was
 * uniformly dark on both sides — a feather cannot brighten a boundary between two equal values,
 * so whatever was showing through had to be coming from underneath.
 *
 * Merging removes the boundary rather than papering over it. It is also the honest geometry:
 * a region at one brightness is one region, and the split into two cells was an artefact of how
 * the field arrived at the answer.
 *
 * **Level, not tier.** Dark and Supernatural Dark share a level by design
 * (`TIER_TO_DARKNESS`), and the difference between them is carried by the darkness source's own
 * overlay, not by this texture — so merging them here loses nothing. `erase` is derived from the
 * level too, so a merged group has one answer for that as well.
 *
 * Cost is one Clipper union per distinct level, at most five, and usually one or two. Groups of
 * a single cell skip Clipper entirely — which is the common case on a scene with no umbra.
 *
 * @param {{polygon: PIXI.Polygon, holes?: PIXI.Polygon[], tier: number}[]} cells
 * @returns {{outer: PIXI.Polygon, holes: PIXI.Polygon[], level: number, erase: boolean}[]}
 */
function mergeByLevel(cells) {
  const groups = new Map();
  // §7.0 step 5. A spill band the umbra left alone is drawn by its window's gradient mesh, which
  // covers the same ground continuously; painting the flat version as well would put a stripe back
  // over the ramp. A band the umbra **clamped** is a constant again and belongs here, and it lands
  // *above* the gradient in the sort — that overpainting is what saves re-cutting the gradient's
  // geometry every time a token moves. See `render/gradient.mjs`.
  const skipSpill = gradient.isActive();
  for (const cell of cells) {
    if (skipSpill && cell.spill === true && cell.clamped !== true) continue;
    // A ring needs three points to enclose anything; earcut on fewer yields no triangles and a
    // mesh that silently draws nothing.
    if (!(cell?.polygon?.points?.length >= 6)) continue;
    if (cell.tier === undefined) continue;
    const { level, erase } = darknessFor(cell.tier);
    // **Part of the key, not just a passenger.** Two cells at one level merge because the
    // boundary between them is an artefact; but a feathered cell and a hard-edged one at the
    // same level are two different *treatments*, and unioning them would have to pick one.
    // In practice they rarely meet — an ambient area whose tier equals its surroundings emits
    // no cell at all (`domainNeedsCell`) — so this costs nothing and cannot silently blur a
    // wall.
    const hardEdge = cell.hardEdge === true;
    // **`spill` is no longer part of the key.** It was, while a band took a wider feather than
    // ordinary ground and merging the two would have had to pick a width. Everything that reaches
    // here now takes the same one: an un-clamped band is skipped above, and a clamped one is a
    // flat region like any other.
    const key = `${level}|${hardEdge ? 1 : 0}`;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { level, erase, hardEdge, cells: [] }));
    group.cells.push(cell);
  }

  const out = [];
  for (const group of groups.values()) {
    const { level, erase, hardEdge } = group;

    if (group.cells.length === 1) {
      const cell = group.cells[0];
      out.push({ outer: cell.polygon, holes: cell.holes ?? [], level, erase, hardEdge });
      continue;
    }

    const paths = [];
    for (const cell of group.cells) paths.push(...cellPaths(cell));
    // `pftNonZero` over outer rings and their oppositely-wound holes together, which is what
    // `union` already does — a hole survives the union unless another cell fills it, which is
    // the correct answer in both directions.
    for (const ring of groupRings(fromClipperPaths(union(paths), CLIPPER_SCALE))) {
      out.push({ outer: ring.outer, holes: ring.holes, level, erase, hardEdge });
    }
  }
  return out;
}

/**
 * A scene-wide region at the darkest level present, to sit under every seam.
 *
 * @remarks
 * The second half of the halo fix, for the case {@link mergeByLevel} cannot reach: two regions
 * at **different** levels that are both darker than the container's clear colour. Merging does
 * not apply — they really are different brightnesses — but their shared boundary still shows the
 * clear through the seam once both rims are blurred, and on a lit map the clear is brighter than
 * either. A Dim region abutting a Dark one on Normal-lit ground is the case.
 *
 * A backstop removes the possibility rather than the instance. Sorting is **descending by
 * level** (`illumination-effects.mjs:106-110`), so the darkest child draws first: a region at
 * `max(level)` covering the scene rect lands underneath everything and is covered by every other
 * mesh's opaque interior. What changes is only what a seam reveals — the darkest level present
 * instead of the scene's own. That biases every soft boundary very slightly dark, which is the
 * right direction: one side of any such boundary *is* the darker value, so the seam reads as
 * part of the feather rather than as a line of its own.
 *
 * Three things it deliberately is not:
 *
 * - **Not `erase`.** The illumination half of a pair cuts global light out of a region, and a
 *   scene-wide one would cut it out of the map. This mesh makes no claim about revelation.
 * - **Not a claimant.** Its `rings` are left empty so `region.document.testPoint` answers false
 *   and `canvas.effects.getDarknessLevel` never returns its level. Core walks the children
 *   backwards and returns the first that claims the point (`effects.mjs:391-396`), so the
 *   backstop would only ever be reached where no cell covers the point — and there the honest
 *   answer is the scene's own darkness, which is what the clear already gives.
 * - **Not present unless it can do something.** No blur or a single level means no seam to fill,
 *   and the mesh would be pure cost.
 *
 * @param {{level: number}[]} regions
 * @returns {object|null}
 */
function backstopFor(regions) {
  // **Nothing left to back up, since §6.4.3.** This existed for one failure: two blurred meshes
  // fading at a shared boundary, neither covering it, letting the container's clear colour through
  // as a bright seam. With the blur gone the meshes are opaque to their own edges and there is no
  // seam to fill — and §7.0 step 6 made the ground cover the scene rect unconditionally, so the
  // clear is unreachable anyway. Kept as a guarded no-op rather than deleted, because its two
  // reasons are worth reading before anyone reintroduces a filter here.
  return null;
  // eslint-disable-next-line no-unreachable
  if (regions.length < 2) return null;
  // Every region hard-edged means nothing is blurred, so there is no fade for a backstop to
  // catch — an ambient-area-only scene (§10.7) with the softening still switched on.
  if (regions.every((region) => region.hardEdge)) return null;

  let level = -Infinity;
  for (const region of regions) if (region.level > level) level = region.level;
  // One level across the whole scene: {@link mergeByLevel} has already made those a single
  // region, so there is no seam for a backstop to sit under.
  if (regions.every((region) => region.level === level)) return null;

  const rect = canvas?.dimensions?.sceneRect;
  if (!rect) return null;

  return {
    outer: new PIXI.Polygon([
      rect.x, rect.y,
      rect.x + rect.width, rect.y,
      rect.x + rect.width, rect.y + rect.height,
      rect.x, rect.y + rect.height,
    ]),
    holes: [],
    level,
    erase: false,
    backstop: true,
    hardEdge: false,
  };
}

/**
 * Detach and unregister an entry's blur filter.
 *
 * @remarks
 * `Canvas#blurFilters` is a `Set` the canvas walks on **every zoom** to rescale each member
 * (`board.mjs:1670`). Core clears it on teardown, but a pool dropped by {@link stale} — the case
 * where `canvasTearDown` did not reach us before the layers were rebuilt — would otherwise leave
 * filters in it whose meshes are gone, rescaled forever and holding their GPU textures.
 */
function dropFilter(entry) {
  if (entry?.eraseBlur) {
    canvas?.blurFilters?.delete(entry.eraseBlur);
    if (entry.il && !entry.il._destroyed) entry.il.filters = null;
    entry.eraseBlur = null;
  }
  if (!entry?.blur) return;
  canvas?.blurFilters?.delete(entry.blur);
  if (entry.dl && !entry.dl._destroyed) entry.dl.filters = null;
  try {
    entry.blur.destroy();
  } catch {
    /* already gone with the renderer */
  }
  entry.blur = null;
}

/**
 * Re-sync every pooled mesh's filter and repaint the container.
 *
 * @remarks
 * Wired to the setting's `onChange` through `soften.setGroundRefresh`. Deliberately does **not**
 * recompute the field or re-initialise any source: the filter is a property of a mesh that is
 * already drawn, so the whole change is a `filters` assignment and a cached-container
 * invalidation. That is the property that makes this affordable where §6.4.2's geometric feather
 * was not — that one rebuilt 41 cells into 166 meshes on every repaint.
 */
export function refreshFilters() {
  if (!canvas?.ready) return 0;
  let touched = 0;
  for (const entry of pool) {
    if (entry.dl?._destroyed) continue;
    syncFilter(entry);
    touched++;
  }
  // The gradient meshes take the same anti-aliasing blur off the same setting, and they are in the
  // same container — so one refresh covers both rather than two settings hooks racing each other.
  touched += gradient.refreshFilters();
  refresh();
  return touched;
}

/* -------------------------------------------- */
/*  Geometry                                    */
/* -------------------------------------------- */

/**
 * Everything `RegionMesh` and its shaders read off a Region, enumerated in one place.
 *
 * @remarks
 * Listed rather than discovered. A stub that satisfies the constructor but not a later reader
 * throws inside the render loop, so "add the next missing property when it crashes" costs a
 * canvas blackout and a reload per property.
 *
 * | Property | Read by |
 * | --- | --- |
 * | `geometry` | ctor `refCount`, `_render` bind (`regions/mesh.mjs:22`, `:180`, `:213`) |
 * | `bounds` | `_calculateBounds` (`:192`) |
 * | `document.elevation` | `AbstractDarknessLevelRegionShader#_preRender` (`adjust-darkness-level.mjs:57`) |
 * | `document.polygonTree` | `containsPoint` (`:204`) |
 * | `document.testPoint` | `EffectsCanvasGroup#getDarknessLevel` (`effects.mjs:394`) |
 *
 * The two `testPoint`s answer `false` while the entry is parked, so
 * `canvas.effects.getDarknessLevel()` never reports a level from a mesh that is not drawing.
 */
function regionStub(entry) {
  // Even-odd across outer and holes together, not "inside the outer ring". A point in an
  // ambient cell's hole is inside a *darkness*, and answering `true` there would make
  // `canvas.effects.getDarknessLevel()` report the ambient level over a darkness — the exact
  // inversion, and in the one place a caller has no way to notice.
  const inside = (point) =>
    entry.active && containsPoint(entry.rings, { x: point.x, y: point.y });

  return {
    geometry: entry.geometry,
    bounds: entry.bounds,
    document: {
      testPoint: inside,
      polygonTree: { testPoint: inside },

      // **Required, and its absence throws once per frame.** `_preRender` destructures it
      // unguarded. Unbounded is safe: `mapElevation` binary-searches a sorted table and
      // returns 0 below its first entry (`masks/depth.mjs:55-57`), converging to the extremes.
      elevation: { bottom: -Infinity, top: Infinity },
    },
  };
}

/**
 * Triangulate a cell into the buffers `RegionGeometry` exposes, updating them in place.
 *
 * @remarks
 * **Holes are the point.** `PIXI.utils.earcut(vertices, holeIndices, 2)` takes them natively,
 * which is what lets an `ambient` cell stay a single mesh — "the scene, less every darkness on
 * it" is one outer ring with N holes, and that shape is the entire reason §6.2.1's annulus
 * splitting existed. A mesh does not need it; a light source did. Every full-width horizontal
 * artefact of 2026-08-23 came from those cuts, so removing them is the fix rather than making
 * the seams meet better.
 *
 * Clipper already emits holes with the opposite winding to their outer, which is what earcut
 * wants, so the rings pass through untouched.
 *
 * Buffers are updated rather than replaced so the pool never churns GPU allocations. PIXI
 * re-uploads on `Buffer#update` and grows the underlying store when the data outgrows it
 * (`GeometrySystem#updateBuffers`), so a cell changing vertex count needs nothing special.
 */
function setGeometry(entry, outer, holes) {
  let points = outer.points;
  let holeIndices = null;

  if (holes?.length) {
    points = Array.from(outer.points);
    holeIndices = [];
    for (const hole of holes) {
      if (!(hole?.points?.length >= 6)) continue;
      holeIndices.push(points.length / 2);
      for (const value of hole.points) points.push(value);
    }
    if (!holeIndices.length) holeIndices = null;
  }

  const indices = PIXI.utils.earcut(points, holeIndices, 2);

  entry.vertices = points.length / 2;
  entry.triangles = indices.length / 3;
  entry.holes = holeIndices?.length ?? 0;

  entry.geometry.getBuffer("aVertexPosition").update(new Float32Array(points));
  // Uint32 unconditionally: v13 requires WebGL2, where 32-bit indices are core, and a buffer
  // that changed integer width between rebuilds would need the geometry rebound.
  entry.geometry.getIndex().update(new Uint32Array(indices));

  entry.bounds.copyFrom(outer.getBounds());
  // `_calculateBounds` reads `region.bounds`, which PIXI has no way to know just changed.
  entry.dl._boundsID++;
  entry.il._boundsID++;
}

/* -------------------------------------------- */
/*  Pool                                        */
/* -------------------------------------------- */

function meshClass() {
  const regions = foundry.canvas.placeables?.regions ?? foundry.canvas.regions;
  return regions?.RegionMesh ?? null;
}

/**
 * Build one mesh pair and attach it to both containers.
 *
 * @returns {object|null} The pool entry, or `null` if the canvas cannot host it
 */
function create(index) {
  const RegionMesh = meshClass();
  const shaders = foundry.canvas.rendering?.shaders;
  const ours = classes();
  const dlContainer = canvas.effects?.illumination?.darknessLevelMeshes;
  const ilContainer = canvas.visibility?.vision?.light?.global?.meshes;
  if (!RegionMesh || !shaders || !ours || !dlContainer || !ilContainer) {
    console.error(`${MODULE_ID} | darkness texture: canvas is missing a required container.`);
    return null;
  }

  const geometry = new PIXI.Geometry();
  geometry.addAttribute(
    "aVertexPosition",
    new PIXI.Buffer(new Float32Array(0), false, false),
    2
  );
  geometry.addIndex(new PIXI.Buffer(new Uint32Array(0), false, true));
  // `RegionMesh` manages this and disposes the geometry when it reaches zero.
  geometry.refCount = 0;
  // Foundry's own `RegionGeometry` defines this; PIXI does not, and `_render` calls it
  // unconditionally. Our buffers are uploaded by PIXI's own dirty tracking, so it is a no-op.
  geometry._updateBuffers = () => {};

  const entry = {
    active: false,
    // Outer first, then holes — the argument order `containsPoint` wants and the order the
    // geometry was built in.
    rings: [],
    level: null,
    erase: false,
    vertices: 0,
    triangles: 0,
    holes: 0,
    geometry,
    bounds: new PIXI.Rectangle(),
    /** This entry's ground-softening filter, or null while the setting is 0. */
    blur: null,
    /** Is this the scene-wide seam backstop rather than a region? {@link backstopFor} */
    backstop: false,
    /** Is this boundary architecture rather than a light falloff? {@link syncFilter} */
    hardEdge: false,
  };
  entry.stub = regionStub(entry);

  // **Ours, not core's, and the difference is one getter.** `SortableDarknessRegionShader` splits
  // the sort key from the painted level so the backstop can be pinned below the gradient meshes
  // (§7.0 step 5). Everything else about it is core's shader.
  entry.dl = new RegionMesh(entry.stub, ours.sortable);
  entry.il = new RegionMesh(entry.stub, shaders.IlluminationDarknessLevelRegionShader);
  entry.dl.name = `${MODULE_ID}.dl.${index}`;
  entry.il.name = `${MODULE_ID}.il.${index}`;
  for (const mesh of [entry.dl, entry.il]) {
    mesh.shader.mode = MODE_OVERRIDE;
    mesh.visible = false;
  }
  // The blur is opt-in and lives on `entry.dl` only — see {@link syncFilter}. This used to be a
  // flat refusal ("§6.2 wants suppressor edges sharp"), which was the right call for the
  // *reveal* boundary and got applied to the brightness one by association.
  syncFilter(entry);

  dlContainer.addChild(entry.dl);
  ilContainer.addChild(entry.il);
  pool.push(entry);
  return entry;
}

function take(index) {
  return pool[index] ?? create(index);
}

/**
 * Has the canvas replaced the containers under us?
 *
 * @remarks
 * The layers are rebuilt on every scene draw, so a pool held across one points at meshes that
 * were destroyed with their parent. `canvasTearDown` normally clears it first, but hook order
 * is not ours to guarantee and the failure is silent — a full pool of dead meshes paints
 * nothing and reports itself healthy. Checking the first entry is enough: they are all attached
 * and detached together.
 */
function stale() {
  const first = pool[0];
  if (!first) return false;
  return (
    first.dl._destroyed === true ||
    first.dl.parent !== canvas.effects?.illumination?.darknessLevelMeshes
  );
}

/** Stop an entry contributing, without giving up its allocation. */
function park(entry) {
  entry.active = false;
  entry.rings = [];
  entry.level = null;
  entry.erase = false;
  // Sticky per-entry state across pool reuse is this project's recurring pooling bug
  // (`HARD_EDGES`, 2026-08-23). `apply` reassigns it too; clearing here keeps a *parked* entry
  // from telling `refreshFilters` it is something it is no longer going to be.
  entry.backstop = false;
  entry.hardEdge = false;
  entry.dl.visible = false;
  entry.il.visible = false;
  // Invisible is not enough on its own — see {@link PARKED_MODIFIER}.
  entry.il.shader.modifier = PARKED_MODIFIER;
}

/**
 * Debug switch: paint brightness but never cut global illumination's reveal.
 *
 * @remarks
 * An A/B for one specific confusion, added 2026-08-23. Every region painted darker than Dim
 * gets a **second** mesh in the visibility mask, blended `ERASE`, which removes it from what
 * global light reveals (`groups/visibility.mjs:643-651`). That boundary is binary and lives in
 * a different container from the brightness — so the §6.4.1 blur cannot touch it, and a
 * *darkness* disc can keep a hard rim while every other transition on the map is soft.
 *
 * The distinguishing experiment, because the two candidate causes need opposite fixes: turn the
 * erase off and see whether the disc softens. If it does, the reveal boundary is the culprit.
 * If it does not, the blur is not reaching the texture at all.
 *
 * Not a setting — with this on, a *darkness* on a globally-lit map stops being dark, which is
 * the whole thing §7.0 exists to fix.
 */
let eraseDisabled = false;

/** @param {boolean} disabled @returns {boolean} The flag now in force */
export function setEraseDisabled(disabled) {
  eraseDisabled = !!disabled;
  return eraseDisabled;
}

export const isEraseDisabled = () => eraseDisabled;

function apply(entry, outer, holes, level, erase, backstop = false, hardEdge = false) {
  if (eraseDisabled) erase = false;
  entry.active = true;
  // **Empty for the backstop, on purpose.** `rings` is what `regionStub`'s `testPoint` answers
  // from, and a scene-wide claimant would put its level in front of `getDarknessLevel` for any
  // point no cell covers. See {@link backstopFor}.
  entry.rings = backstop ? [] : holes?.length ? [outer, ...holes] : [outer];
  entry.level = level;
  entry.erase = erase;
  entry.backstop = backstop;
  // **Assigned unconditionally, like every other per-entry flag.** A pooled entry that carried
  // `hardEdge` from a previous rebuild and is reused for an ordinary darkness would silently
  // lose its feather — the fourth instance of this project's recurring pooling bug, after
  // `animation`, `HARD_EDGES` and `HIDDEN`.
  entry.hardEdge = hardEdge;

  setGeometry(entry, outer, holes);

  // Cheap, and it covers the one case `refreshFilters` cannot: an entry created while the
  // setting was zero, then painted after it was raised. A parked mesh needs no sync — PIXI
  // skips an invisible child before it reaches the filter stack. Order matters: `backstop` is
  // read inside, so it has to be assigned above.
  syncFilter(entry);

  entry.dl.visible = true;
  entry.dl.shader.modifier = level;
  // **Where this mesh sits in the container's draw order** — the ladder lives in
  // `render/darkness-shaders.mjs` and is the composition rule for the whole texture (§7.0 step 6).
  // Sorting is descending, so the biggest number draws first and sits at the bottom. Ground cells
  // take `GROUND_SORT + level`, which keeps their old relative order — irrelevant anyway, since
  // they partition space — while leaving the two bands below them free for the light and clamp
  // passes, which must composite *over* finished ground. The backstop goes under everything,
  // including the spill gradients it exists to sit beneath.
  entry.dl.shader.sortLevel = backstop ? BACKSTOP_SORT : GROUND_SORT + level;
  // `getDarknessLevel` reads the *uniform*, which `_preRender` only writes when the mesh is
  // drawn (`effects.mjs:395`). Setting it here keeps a point query correct on the same tick
  // the cell was painted, rather than one frame behind.
  entry.dl.shader.uniforms.darknessLevel = level;

  entry.il.visible = erase;
  entry.il.shader.modifier = erase ? ERASE_MODIFIER : PARKED_MODIFIER;
}

/* -------------------------------------------- */
/*  Public API                                  */
/* -------------------------------------------- */

/**
 * Paint a set of cells, replacing whatever was painted before.
 *
 * Cells are merged by resolved level first — see {@link mergeByLevel}, which is load-bearing
 * for the ground blur and not merely a tidy-up.
 *
 * @param {{polygon: PIXI.Polygon, holes?: PIXI.Polygon[], tier: number}[]} cells
 * @returns {number} How many regions were painted
 */
export function paint(cells) {
  if (!canvas?.ready) return 0;
  if (stale()) {
    for (const entry of pool) dropFilter(entry);
    pool.length = 0;
    used = 0;
  }

  const regions = mergeByLevel(cells);
  merged = cells.length - regions.length;

  // Underneath everything, and only when the blur can produce a seam for it to fill.
  const backstop = backstopFor(regions);
  if (backstop) regions.push(backstop);
  backstopped = !!backstop;

  let index = 0;
  for (const region of regions) {
    const entry = take(index);
    if (!entry) break;
    apply(
      entry,
      region.outer,
      region.holes,
      region.level,
      region.erase,
      region.backstop,
      region.hardEdge
    );
    index++;
  }

  for (let i = index; i < pool.length; i++) park(pool[i]);
  used = index;

  refresh();
  return used;
}

/** Park every mesh, handing the scene back to its own darkness level. */
export function clear() {
  if (!used && !pool.length) return;
  for (const entry of pool) park(entry);
  used = 0;
  merged = 0;
  backstopped = false;
  refresh();
}

/**
 * Ask the container to re-render and re-sort.
 *
 * @remarks
 * `force`, because `hasDynamicDarknessLevel` is a child *count* and our children are pooled —
 * they stay attached while parked, so the count never reaches zero and never proves anything
 * either way. It also marks the vision mask dirty when global light is active, which is what
 * carries an `ERASE` change through.
 *
 * Deliberately **not** a `canvas.perception.update` call: the renderer makes exactly one at the
 * end of its rebuild, and adding a second here is how the last cycle of self-triggering
 * rebuilds started (see `renderer.rebuild`).
 */
function refresh() {
  canvas.effects?.illumination?.invalidateDarknessLevelContainer(true);
}

/**
 * Destroy every mesh. Scene teardown only.
 *
 * @remarks
 * Guarded, because the containers these live in belong to the canvas layers and are rebuilt on
 * every scene change — so by the time this runs the meshes may already have been destroyed
 * from underneath us. Dropping our references is the part that has to happen; the `destroy()`
 * is a courtesy to the GPU buffers when we get there first.
 */
export function dispose() {
  for (const entry of pool) {
    dropFilter(entry);
    for (const mesh of [entry.dl, entry.il]) {
      if (!mesh || mesh._destroyed) continue;
      try {
        mesh.destroy();
      } catch {
        /* the container went first */
      }
    }
  }
  pool.length = 0;
  used = 0;
}

/**
 * Which pooled mesh claims a point, and what the **rendered texture** actually says there.
 *
 * @remarks
 * **`canvas.effects.getDarknessLevel` and the shader do not read the same thing**, and that gap
 * is where a whole class of bug hides. The JS query walks our meshes calling
 * `region.document.testPoint` — a ring test on the *polygon* — and returns a shader uniform.
 * Every shader that cares samples `texture2D(darknessLevelTexture, …)`, which is the polygon
 * **after earcut, rasterisation and the container's sort**. A mesh whose geometry failed to
 * triangulate, or that never rendered, answers the first and not the second.
 *
 * Worth having because the difference is invisible from every other angle: the model is right,
 * the cell is right, the point query is right, and the screen is wrong.
 *
 * `pixel` costs a GPU→CPU readback, so this is a console tool and nothing else may call it.
 *
 * @param {number} [x]
 * @param {number} [y]
 */
export function meshAt(x, y) {
  if (!canvas?.ready) return null;
  const point = x === undefined ? canvas.mousePosition : { x, y };

  const claims = pool
    .filter((entry) => entry.active && containsPoint(entry.rings, point))
    .map((entry) => ({
      name: entry.dl.name,
      level: entry.level,
      erase: entry.erase,
      rings: entry.rings.length,
      holes: entry.holes,
      vertices: entry.vertices,
      // Zero here with the point inside the polygon is the failure this readout exists for:
      // earcut produced nothing, so the mesh claims ground it never paints.
      triangles: entry.triangles,
      visible: entry.dl.visible,
      inBounds: entry.bounds.contains(point.x, point.y),
    }));

  let pixel = null;
  try {
    const texture = canvas.effects.illumination.renderTexture;
    const screen = canvas.stage.worldTransform.apply({ x: point.x, y: point.y });
    const frame = new PIXI.Rectangle(Math.round(screen.x), Math.round(screen.y), 1, 1);
    pixel = canvas.app.renderer.extract.pixels(texture, frame)?.[0] / 255;
  } catch (error) {
    console.error(`${MODULE_ID} | texture readback failed`, error);
  }

  const report = {
    point: { x: Math.round(point.x), y: Math.round(point.y) },
    // What the meshes claim.
    claims,
    // What the JS query answers — `effects.mjs:391-396`.
    queried: canvas.effects.getDarknessLevel({ x: point.x, y: point.y, elevation: 0 }),
    // **What the shaders actually sample.** Disagreeing with `queried` is the finding.
    pixel,
    sceneDarkness: canvas.environment?.darknessLevel ?? null,
  };
  console.error(`${MODULE_ID} | mesh at`, report);
  return report;
}

/**
 * Read the texture along a horizontal line through the cursor. **The boundary discriminator.**
 *
 * @remarks
 * Written to end a class of question that had cost several rounds: *this edge looks hard — is it
 * hard in the brightness field, or is something else drawing over it?* Those need completely
 * different fixes and the map cannot be asked which.
 *
 * Every layer that can put a visible edge on screen is either **in** this texture or **not**:
 *
 * | In it, and softened by §6.4.4's field blur | Not in it |
 * | --- | --- |
 * | ground cells, spill, light zones, halos, clamps | a light's **coloration** mesh |
 * | | a **darkness source**'s own disc and rim |
 * | | the **visibility** mask, binary by nature |
 * | | the `il` **erase** meshes — §6.4.5 blurs those separately |
 *
 * Hover the edge, call this, read `biggestStep`. A **ramp** means the field is smooth and the hard
 * edge belongs to the right-hand column — chase it there, not here. A **step** means the blur is
 * not reaching that boundary, which is this file's problem.
 *
 * One `extract.pixels` call for the whole strip rather than one per sample: a readback is a
 * GPU→CPU stall, and forty of them would take longer than the frame being measured.
 *
 * @param {number} [length=200] - Width of the transect in **screen** pixels, centred on the cursor
 * @param {number} [samples=21]
 */
export function transect(length = 200, samples = 21) {
  if (!canvas?.ready) return null;
  const point = canvas.mousePosition;
  const screen = canvas.stage.worldTransform.apply({ x: point.x, y: point.y });
  const width = Math.max(2, Math.round(length));
  const x0 = Math.round(screen.x - width / 2);
  const y = Math.round(screen.y);

  let strip = null;
  try {
    const texture = canvas.effects.illumination.renderTexture;
    strip = canvas.app.renderer.extract.pixels(texture, new PIXI.Rectangle(x0, y, width, 1));
  } catch (error) {
    console.error(`${MODULE_ID} | transect readback failed`, error);
    return null;
  }

  const stride = Math.max(1, Math.floor(width / (samples - 1)));
  const values = [];
  for (let i = 0; i < width; i += stride) values.push(+(strip[i * 4] / 255).toFixed(3));

  let biggest = 0;
  for (let i = 1; i < values.length; i++) {
    biggest = Math.max(biggest, Math.abs(values[i] - values[i - 1]));
  }

  const report = {
    at: { x: Math.round(point.x), y: Math.round(point.y) },
    screenPixels: width,
    values,
    // **The number that answers it.** A field blurred over `transitionWidth` cannot produce a big
    // jump between neighbouring samples; a step in the texture is exactly a big one.
    biggestStep: +biggest.toFixed(3),
  };
  console.error(`${MODULE_ID} | transect`, report);
  return report;
}

/**
 * Debug readout.
 *
 * @remarks
 * Reports the *sample* alongside the pool because "the mesh exists" and "the texture carries
 * its value" are different claims, and only the second one is what any shader sees.
 */
export function status(x, y) {
  const point =
    x === undefined ? (canvas?.mousePosition ?? { x: 0, y: 0 }) : { x, y };

  const report = {
    painted: used,
    // Cells the level merge collapsed. **Above zero is what keeps the blur honest** — every one
    // of these was a boundary between two meshes at the same brightness, and a blurred boundary
    // like that shows the container's clear colour through the seam (§6.4.2a). Inside an umbra
    // it is normally several.
    merged,
    // The second half of the same fix — a scene-wide mesh at the darkest level, under every
    // seam. Only present with the blur on and more than one level in play.
    backstopped,
    pooled: pool.length,
    erasing: pool.filter((e) => e.active && e.erase).length,
    levels: pool.filter((e) => e.active).map((e) => e.level),
    // Above zero is the observable proof that the ambient complement is one mesh rather than
    // a stack of full-width strips — the difference §6.2.1's splitting used to force.
    holes: pool.reduce((sum, e) => sum + (e.active ? e.holes : 0), 0),
    triangles: pool.reduce((sum, e) => sum + (e.active ? e.triangles : 0), 0),
    // The ground's softening is one blur on the whole container now — `render.blur()` reports it.
    blurred: pool.filter((e) => e.active && e.dl?.filters?.length).length,
    // §6.4.5 — erasing regions whose *reveal* boundary is softened. Should equal `erasing` while
    // the field blur is on; below it means the last hard edge on the map is back.
    eraseBlurred: pool.filter((e) => e.active && e.il?.filters?.length).length,
    blurStrength: pool.find((e) => e.blur)?.blur?.blur ?? null,
    stageScale: canvas?.stage?.scale?.x ?? null,
    blurRegistered: canvas?.blurFilters?.size ?? null,
    dlChildren: canvas?.effects?.illumination?.darknessLevelMeshes?.children?.length ?? null,
    ilChildren: canvas?.visibility?.vision?.light?.global?.meshes?.children?.length ?? null,
    sceneDarkness: canvas?.environment?.darknessLevel ?? null,
    // What Foundry itself reports at the point — the read-back that proves the texture took.
    sampled: canvas?.ready
      ? canvas.effects.getDarknessLevel({ x: point.x, y: point.y, elevation: 0 })
      : null,
  };
  console.error(`${MODULE_ID} | darkness texture`, report);
  return report;
}

/* -------------------------------------------- */
/*  Layer bisection                             */
/* -------------------------------------------- */

/** What {@link isolate} has switched off, so it can be switched back on. @type {Map<string, object>} */
const hidden = new Map();

/**
 * The layers that can draw an edge this texture does not contain.
 *
 * @remarks
 * Resolved lazily rather than captured, because every one of them is rebuilt on a scene draw.
 */
const LAYERS = {
  // A light's colour, clipped to its cell by `RENDER_SHAPE`. The clip boundary is a polygon edge
  // and its feather is `edgeSoftness`, which is a different and much smaller number than
  // `transitionWidth` — so a colour edge can be sharp across a brightness boundary that is not.
  coloration: () => canvas?.effects?.coloration,
  // A `PointDarknessSource`'s own disc, drawn only for Supernatural Dark (§6.4.1). Its rim is
  // `darknessPadding`, a third mechanism again.
  darkness: () => canvas?.effects?.darkness,
  // Light *illumination* meshes. Inert under §7.0 step 6, which withholds their contribution — so
  // if the line vanishes with these hidden, the withholding is not working.
  lights: () => canvas?.effects?.illumination?.lights,
  // The vision mask and fog. Binary by nature, and the one layer whose edges are *supposed* to be
  // hard — but §6.4.5 softens the reveal boundary inside it, so it is worth being able to exclude.
  visibility: () => canvas?.visibility,
};

/**
 * Hide one rendering layer, to find which one owns a visible edge.
 *
 * @remarks
 * **Built after `transect` proved the field was smooth and the line was still there.** At that
 * point the question is no longer *is the gradient right* but *which layer is drawing over it*,
 * and every candidate is a separate mechanism with its own softening: a light's coloration has
 * `edgeSoftness`, a darkness disc has `darknessPadding`, the vision mask has none by design. They
 * are indistinguishable by eye and immediate by bisection.
 *
 * Purely visual and entirely reversible — nothing is recomputed, so a layer switched off and on
 * leaves no trace.
 *
 * @param {string|null} [layer] - A key of {@link LAYERS}; `null` or omitted restores everything
 * @returns {object} What is hidden now
 */
export function isolate(layer = null) {
  if (!layer) {
    for (const [, target] of hidden) target.visible = true;
    hidden.clear();
  } else {
    const target = LAYERS[layer]?.();
    if (!target) {
      console.error(
        `${MODULE_ID} | no such layer "${layer}". Try: ${Object.keys(LAYERS).join(", ")}`
      );
    } else if (hidden.has(layer)) {
      target.visible = true;
      hidden.delete(layer);
    } else {
      target.visible = false;
      hidden.set(layer, target);
    }
  }

  const report = { hidden: [...hidden.keys()], available: Object.keys(LAYERS) };
  console.error(`${MODULE_ID} | layers`, report);
  return report;
}
