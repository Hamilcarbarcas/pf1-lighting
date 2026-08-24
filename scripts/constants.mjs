import { TIER } from "./model/tiers.mjs";

export const MODULE_ID = "pf1-lighting";

/**
 * The renderer's master switch.
 *
 * @remarks
 * Here rather than in `render/renderer.mjs`, which is where it is registered, because
 * `render/paint.mjs` also has to read it and the renderer imports *that*. A settings key in a
 * leaf module is one import; the alternative is a cycle between a settings reader and a model
 * query, which is the shape this project has already agreed not to build (see the architecture
 * note on `suppression.setVisionModel`).
 */
export const SETTING_RENDER = "renderEnabled";

/**
 * Property stamped on every source this module creates.
 *
 * DESIGN.md §6.6 — our synthetic sources land in `canvas.effects.lightSources` where
 * anything iterating that collection will see them. Tag them so they can be skipped.
 */
export const SYNTHETIC_MARK = "pf1LightingSynthetic";

/** True if a source was created by this module rather than by a placeable. */
export const isSynthetic = (source) => source?.[SYNTHETIC_MARK] === true;

/**
 * The clipped polygon a source should be **drawn** with, leaving `shape` untouched.
 *
 * DESIGN.md §6.2.4. `shape` is load-bearing for at least three consumers and only one of
 * them is rendering:
 *
 *   - `testPoint` is `shape.contains(x, y)` (`base-effect-source.mjs:343-345`), which the
 *     model uses to ask where a light reaches;
 *   - Foundry builds the **visibility mask** from it —
 *     `vision.light.sources.drawShape(lightSource.shape)` (`groups/visibility.mjs:562`);
 *   - `_updateGeometry` meshes it (`point-effect-source.mjs:173-189`).
 *
 * Clipping `shape` therefore did far more than clip the picture: it shrank the model's
 * own view of each light, and punched holes in what tokens could *see* — black discs
 * that blocked darkvision and vanished where fog was already lifted. Only the third
 * consumer should see the clip.
 */
export const RENDER_SHAPE = "pf1LightingRenderShape";

/** The clip polygon the renderer assigned to a source, if any. */
export const CLIP = "pf1LightingClip";

/**
 * A per-source Foundry lighting level, overriding the class default.
 *
 * Needed because `_dimLightingLevel` / `_brightLightingLevel` are read off the
 * *constructor* (`base-light-source.mjs:213-214`), so they cannot vary per source.
 */
export const LEVEL = "pf1LightingLevel";

/**
 * The lighting level for a light's **outer band**, when it differs from its inner zone.
 *
 * @remarks
 * §3.2.1 gave the two zones different meanings — the inner one provides a set level, the outer
 * raises whatever is already there — so they routinely want different levels. Foundry already
 * separates them: `dimLevelCorrection` and `brightLevelCorrection` are distinct uniforms
 * (`base-lighting.mjs:368-369`), which is what made the old radius-shifting version of
 * reduction unnecessary (§6.2.2).
 */
export const BAND_LEVEL = "pf1LightingBandLevel";

/**
 * How hard a darkness source should darken, 0..1, where 1 is its authored strength.
 *
 * Separate from {@link LEVEL} because the darkness layer's shader ignores lighting
 * levels entirely — it renders from `color` and `colorationAlpha`
 * (`point-darkness-source.mjs:206-213`). Alpha is the only dial that makes a darkness
 * source darken an area *partially*, which is what a one-step reduction is.
 */
export const STRENGTH = "pf1LightingStrength";

/**
 * Draw this darkness source for its **animation only**, neutralising its darkening.
 *
 * @remarks
 * §6.2.6. An ordinary *darkness* is expressed by the darkness-level texture, so the source has
 * no darkening left to do — but an animation is a fragment shader on a mesh, and withholding
 * the mesh withholds the animation with it.
 *
 * The lever is **not** {@link STRENGTH}, and that mistake is worth recording because the name
 * invites it. `colorationAlpha` multiplies the shader's output colour
 * (`darkness-lighting.mjs:119`) rather than fading it in, so *lowering* it drives the result
 * toward black — a "faint" 0.2 renders a darkness at its most absolute. Neutral is the opposite
 * end: colour white, alpha 1, which leaves `finalColor` as the scene it sampled and lets the
 * animation be the only thing that moves it.
 */
export const DARK_ANIMATION = "pf1LightingDarkAnimation";

/**
 * Suppress a source's rendering entirely, without touching its data or geometry.
 *
 * @remarks
 * Zeroing `colorationAlpha` does **not** stop a darkness source drawing — measured
 * 2026-08-22, with `colorationAlpha: 0` on every source and the dark discs still on
 * screen. The darkness shader evidently darkens through more than that one uniform, so
 * the only reliable lever is to not draw the mesh at all.
 *
 * `_drawMesh` already has that path: it sets `mesh.visible = false` and returns null for
 * an inactive layer (`rendered-effect-source.mjs:413-416`). This reuses it.
 */
export const HIDDEN = "pf1LightingHidden";

/**
 * Force hard edges on a source whose cell was split into several rings.
 *
 * Soft edges inset the polygon and ramp depth 0→1 along its *entire* perimeter, cut
 * edges included, so two halves of a split cell fade against each other and leave a
 * visible seam. Overlapping them to hide it does not work: the coloration layer blends
 * additively, so the overlap reads *brighter*, not equal. Hard edges on both halves let
 * them abut exactly.
 */
export const HARD_EDGES = "pf1LightingHardEdges";

/**
 * The sight-edge priority ladder. DESIGN.md §4.3, §4.5.2.
 *
 * @remarks
 * Foundry skips an edge when `edge.priority < edgeType.priority`
 * (`clockwise-sweep.mjs:236`), which turns "who is blocked by what" into a single ordering.
 * Three behaviours ride on it:
 *
 *   - ordinary magical darkness must **cast an umbra** without blocking sight outright;
 *   - supernatural darkness must do both;
 *   - light-independent sight must ignore all of it.
 *
 * Splitting them by rank means one sweep per question rather than per source, and it is why
 * umbra costs a single extra sweep rather than two (see `vision/umbra.mjs`).
 *
 * **Walls are outside this ladder entirely.** `_determineEdgeTypes` registers them at
 * `-Infinity` (`clockwise-sweep.mjs:101`), so no value here can make a wall stop occluding.
 * That is what makes the mechanism safe to use rather than merely clever.
 */
/**
 * Edge rank **by tier**: darker regions rank higher.
 *
 * @remarks
 * Ranking by darkness rather than by a blocking/non-blocking flag is what makes per-tier
 * umbra fall out of the sweep instead of needing separate geometry. A sweep at rank *R*
 * respects every edge ranked *R* or above — that is, every region at least as dark as *R* —
 * so successive ranks yield **nested** umbra regions and the darkest one containing a point
 * is its clamp.
 *
 * **Normal is on the ladder; only Bright is not.** The first version stopped at Dim, on an
 * unstated assumption that a Normal-lit region is transparent. §4.3's rule does not say that —
 * it says you cannot see *through* a region more clearly than that region allows — so a
 * *darkness* cast at noon, whose interior resolves to Normal, must clamp directly sunlit ground
 * beyond it to Normal. Reported 2026-08-23 as *a Normal region casting no shadow onto a Bright
 * backdrop*, which is exactly the missing rung.
 *
 * Bright genuinely casts nothing, and needs no rung: nothing is brighter than Bright, so a
 * clamp to it can never be a reduction.
 *
 * The cost of the extra rung is one more sweep per observer **only on scenes that have a
 * Normal-tier suppressed region at all**, which means bright outdoor maps — the same maps where
 * the omission was visible.
 */
export const UMBRA_RANK = Object.freeze({
  [TIER.NORMAL]: 1,
  [TIER.DIM]: 2,
  [TIER.DARK]: 3,
  [TIER.SUPERNATURAL_DARK]: 4,
});

/** The rank a region of this tier emits at, or 0 for "casts nothing". */
export const umbraRank = (tier) => UMBRA_RANK[tier] ?? 0;

/** Sweep priorities that consume {@link UMBRA_RANK}. */
export const VISION_RANK = Object.freeze({
  /**
   * Ordinary sight. Blocked **only** by Supernatural Dark; everything less dark casts an
   * umbra it sweeps straight through, which is the whole point of the ladder — a *darkness*
   * dims what lies beyond without hiding it.
   */
  NORMAL: UMBRA_RANK[TIER.SUPERNATURAL_DARK],
  /** *See in darkness* / *true seeing*: above every darkness edge. Walls still apply. */
  PIERCING: UMBRA_RANK[TIER.SUPERNATURAL_DARK] + 1,
});
