import { TIER } from "./model/tiers.mjs";

export const MODULE_ID = "pf1-lighting";

/**
 * The renderer's master switch.
 *
 * @remarks
 * Here rather than in `render/renderer.mjs` where it is registered, because `render/paint.mjs`
 * reads it too and the renderer imports that. A settings key in a leaf module is one import; the
 * alternative is a cycle between a settings reader and a model query — the shape ruled out in the
 * architecture note on `suppression.setVisionModel`.
 */
export const SETTING_RENDER = "renderEnabled";

/**
 * Property stamped on every source this module creates.
 *
 * DESIGN.md §6.6 — synthetic sources land in `canvas.effects.lightSources`, visible to anything
 * iterating that collection. Tagged so they can be skipped.
 */
export const SYNTHETIC_MARK = "pf1LightingSynthetic";

/** True if a source was created by this module rather than by a placeable. */
export const isSynthetic = (source) => source?.[SYNTHETIC_MARK] === true;

/**
 * Property stamped on every **light effect** source — DESIGN.md §12.4.
 *
 * Deliberately *not* {@link SYNTHETIC_MARK}, and the distinction is load-bearing. §6.6 excludes
 * marked sources from the registry so the renderer never reads its own output back; an effect
 * source is a real spell or a real lantern and must be read like any other light. Reusing the
 * renderer's mark would produce a source that draws and does not exist — the same failure as the
 * `isPreview` trap in §12.4, by a different route.
 *
 * Nothing in `usable()` tests this. It exists so a readout can tell an effect's source from a
 * placeable's, and so a future filter has something to name.
 */
export const EFFECT_MARK = "pf1LightingEffect";

/** True if a source belongs to a §12 light effect rather than to a placed light or token. */
export const isEffectSource = (source) => source?.[EFFECT_MARK] === true;

/**
 * The clipped polygon a source is drawn with, leaving `shape` untouched.
 *
 * DESIGN.md §6.2.4. `shape` has three consumers and only one is rendering:
 *
 *   - `testPoint` is `shape.contains(x, y)` (`base-effect-source.mjs:343-345`), the model's
 *     question of where a light reaches;
 *   - Foundry builds the visibility mask from it —
 *     `vision.light.sources.drawShape(lightSource.shape)` (`groups/visibility.mjs:562`);
 *   - `_updateGeometry` meshes it (`point-effect-source.mjs:173-189`).
 *
 * Clipping `shape` therefore did more than clip the picture: it shrank the model's own view of
 * each light and punched holes in what tokens could see — black discs blocking darkvision, gone
 * where fog was already lifted. Only the third consumer should see the clip.
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
 * The lighting level for a light's outer band, when it differs from its inner zone.
 *
 * @remarks
 * §3.2.1 gave the two zones different meanings — inner provides a set level, outer raises whatever
 * is already there — so they routinely want different levels. Foundry already separates them:
 * `dimLevelCorrection` and `brightLevelCorrection` are distinct uniforms
 * (`base-lighting.mjs:368-369`), which retired the radius-shifting form of reduction (§6.2.2).
 */
export const BAND_LEVEL = "pf1LightingBandLevel";

/**
 * The three tiers a light's zones resolve to, for absolute rendering. DESIGN.md §6.2.9.
 *
 * @remarks
 * `{ inner, band, base }`, all {@link TIER} values rather than Foundry lighting levels.
 *
 * {@link LEVEL} asks for one of Foundry's four levels, answered relative to the ground beneath —
 * `computedBrightColor = mix(computedBackgroundColor, ambientBrightest, weightBright)`
 * (`base-lighting.mjs:363`), so the same level renders brighter over Dim ground than over Dark.
 * This states what brightness the zone actually is, absolutely.
 *
 * Both are set and both are used: the relative path runs with the global-illumination takeover
 * off, and is Foundry's own behaviour.
 */
export const TIERS = "pf1LightingTiers";

/**
 * How hard a darkness source should darken, 0..1, where 1 is its authored strength.
 *
 * Separate from {@link LEVEL} because the darkness layer's shader ignores lighting levels entirely,
 * rendering from `color` and `colorationAlpha` (`point-darkness-source.mjs:206-213`). Alpha is the
 * only dial that darkens partially, which is what a one-step reduction is.
 */
export const STRENGTH = "pf1LightingStrength";

/**
 * Draw this darkness source for its animation only, neutralising its darkening.
 *
 * @remarks
 * §6.2.6. An ordinary darkness is expressed by the darkness-level texture, leaving the source no
 * darkening to do — but an animation is a fragment shader on a mesh, so withholding the mesh
 * withholds the animation too.
 *
 * The lever is not {@link STRENGTH}, despite the name inviting it. `colorationAlpha` multiplies
 * the shader's output colour (`darkness-lighting.mjs:119`) rather than fading it in, so lowering
 * it drives toward black — a "faint" 0.2 renders a darkness at its most absolute. Neutral is the
 * other end: colour white, alpha 1, leaving `finalColor` as the sampled scene so the animation is
 * the only thing that moves it.
 */
export const DARK_ANIMATION = "pf1LightingDarkAnimation";

/**
 * Suppress a source's rendering entirely, without touching its data or geometry.
 *
 * @remarks
 * Zeroing `colorationAlpha` does not stop a darkness source drawing — measured 2026-08-22 with
 * `colorationAlpha: 0` on every source and the dark discs still on screen. The shader darkens
 * through more than that one uniform, so the only reliable lever is not drawing the mesh.
 *
 * `_drawMesh` already has that path: `mesh.visible = false`, return null for an inactive layer
 * (`rendered-effect-source.mjs:413-416`). Reused here.
 */
export const HIDDEN = "pf1LightingHidden";

/**
 * Force hard edges on a source whose cell was split into several rings.
 *
 * Soft edges inset the polygon and ramp depth 0→1 along its entire perimeter, cut edges included,
 * so two halves of a split cell fade against each other and leave a seam. Overlapping to hide it
 * fails — the coloration layer blends additively, so the overlap reads brighter, not equal. Hard
 * edges on both halves let them abut exactly.
 */
export const HARD_EDGES = "pf1LightingHardEdges";

/**
 * The sight-edge priority ladder: edge rank by tier, darker regions ranking higher.
 * DESIGN.md §4.3, §4.5.2.
 *
 * @remarks
 * Foundry skips an edge when `edge.priority < edgeType.priority` (`clockwise-sweep.mjs:236`),
 * turning "who is blocked by what" into a single ordering. Three behaviours ride on it:
 *
 *   - ordinary magical darkness casts an umbra without blocking sight outright;
 *   - supernatural darkness does both;
 *   - light-independent sight ignores all of it.
 *
 * Splitting by rank costs one sweep per question rather than per source, which is why umbra costs
 * a single extra sweep rather than two (see `vision/umbra.mjs`).
 *
 * Ranking by darkness rather than a blocking flag makes per-tier umbra fall out of the sweep
 * instead of needing separate geometry. A sweep at rank R respects every edge ranked R or above —
 * every region at least as dark as R — so successive ranks yield nested umbra regions, and the
 * darkest one containing a point is its clamp.
 *
 * Normal is on the ladder; only Bright is not. The first version stopped at Dim, assuming a
 * Normal-lit region is transparent. §4.3 says instead that a region cannot be seen through more
 * clearly than it allows, so a darkness cast at noon, interior resolving to Normal, must clamp
 * sunlit ground beyond it to Normal. Reported 2026-08-23 as a Normal region casting no shadow onto
 * a Bright backdrop — exactly the missing rung. Bright needs no rung: nothing is brighter, so a
 * clamp to it can never reduce.
 *
 * The extra rung costs one more sweep per observer only on scenes with a Normal-tier suppressed
 * region — bright outdoor maps, the same ones where the omission showed.
 *
 * Walls sit outside this ladder entirely: `_determineEdgeTypes` registers them at `-Infinity`
 * (`clockwise-sweep.mjs:101`), so no value here can stop a wall occluding.
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
   * Ordinary sight. Blocked only by Supernatural Dark; anything less dark casts an umbra it
   * sweeps straight through — the point of the ladder, a darkness dimming what lies beyond
   * without hiding it.
   */
  NORMAL: UMBRA_RANK[TIER.SUPERNATURAL_DARK],
  /** See in darkness / true seeing: above every darkness edge. Walls still apply. */
  PIERCING: UMBRA_RANK[TIER.SUPERNATURAL_DARK] + 1,
});

/* -------------------------------------------- */
/*  Settings visibility                         */
/* -------------------------------------------- */

/**
 * Show or hide a registered setting's row after the fact.
 *
 * @remarks
 * For client-scoped settings that are still not everyone's business. Foundry hides world-scoped
 * settings from non-GM clients on its own (`applications/settings/config.mjs:67`), which is right
 * when the value belongs to the world and wrong for a GM-only per-client preference — *GM sees
 * through the selected token* must stay client-scoped so two GMs can disagree, while still not
 * appearing in a player's settings.
 *
 * `config` is read at render time from the entry in `game.settings.settings`, so flipping it
 * afterwards suffices: no re-registration, no second copy of the definition. Registration keeps
 * `config: true` so a setting reads as a menu row by default and this only ever takes rows away —
 * the safe direction if the call is missed.
 *
 * @param {string} key
 * @param {boolean} visible
 * @returns {boolean} Whether anything changed
 */
export function setSettingVisibility(key, visible) {
  const setting = game.settings?.settings?.get(`${MODULE_ID}.${key}`);
  if (!setting || setting.config === visible) return false;
  setting.config = visible;

  // A settings window open when the answer changes is showing the old one. Reachable from a GM
  // toggling "Light level is GM only" while a player has their settings open — exactly when
  // someone is looking.
  foundry.applications.instances?.get("settings-config")?.render();
  return true;
}
