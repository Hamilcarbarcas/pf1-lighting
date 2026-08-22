export const MODULE_ID = "pf1-lighting";

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
 * How hard a darkness source should darken, 0..1, where 1 is its authored strength.
 *
 * Separate from {@link LEVEL} because the darkness layer's shader ignores lighting
 * levels entirely — it renders from `color` and `colorationAlpha`
 * (`point-darkness-source.mjs:206-213`). Alpha is the only dial that makes a darkness
 * source darken an area *partially*, which is what a one-step reduction is.
 */
export const STRENGTH = "pf1LightingStrength";

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
