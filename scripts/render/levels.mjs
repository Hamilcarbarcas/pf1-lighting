/**
 * Tier → Foundry lighting level. DESIGN.md §6.2.3.
 *
 * `CONST.LIGHTING_LEVELS` has six values and the model has five tiers, so the mapping is
 * exact with one to spare. Notably `BRIGHTEST` is a fully rendered level that **nothing
 * in core produces** — it draws from `canvas.colors.ambientBrightest`, itself set from
 * `CONFIG.Canvas.brightestColor` (`environment.mjs:156`, `rendered-effect-source.mjs:587`).
 *
 * That is what §3.2.1's added Bright tier renders as. No custom shader, no invented
 * path: Foundry already had a level for it and no use of its own.
 */

import { TIER, darknessTable } from "../model/tiers.mjs";

/**
 * The tier → darkness-level table **lives in `model/tiers.mjs`** and is re-exported here.
 *
 * Moved 2026-08-23 with §3.2.1's rewrite: band stacking is additive on rungs, so the ambient
 * rung is the base of every sum the model computes, and it has to come from the same ladder
 * the renderer paints with. Re-exported rather than relocated-and-chased so `render/ambient.mjs`
 * and the console API keep their import paths.
 */
export {
  TIER_TO_DARKNESS,
  DARKNESS_PRESETS,
  darknessTable,
  setDarknessTable,
  tierFromDarkness,
} from "../model/tiers.mjs";

/**
 * The Foundry lighting level that paints `target` **against a background of `background`**.
 *
 * @remarks
 * §6.2.3's table — Bright→`BRIGHTEST`, Normal→`BRIGHT`, Dim→`DIM`, Dark→`UNLIT`, Supernatural
 * Dark→`DARKNESS` — **is only correct when the background is Dark**, and since §7.0 the
 * background is whatever our texture put there. This is the general form, and it superseded
 * that table outright. Getting it wrong overshoots in exactly the case the two-zone model made
 * common: a torch's band on a Normal-lit map, capped at Normal, should add *nothing*, and a
 * straight lookup paints it at `BRIGHT` — brighter than the ground it stands on.
 *
 * The four reachable outcomes are **relative**, not absolute (`base-lighting.mjs:155-166`):
 *
 * | Level | Paints | Rungs above background |
 * | --- | --- | --- |
 * | `UNLIT` (0) | `computedBackgroundColor` | 0 |
 * | `DIM` (1) | `mix(bg, brightColor, weightDim)` | 1 |
 * | `BRIGHT` (2) | `mix(bg, ambientBrightest, weightBright)` | 2 |
 * | `BRIGHTEST` (3) | `ambientBrightest` | absolute |
 *
 * and {@link deriveWeights} solves the two weights so that, **on unlit ground**, `DIM` lands on
 * our Dim and `BRIGHT` on our Normal. So the level to ask for is the *distance* from the
 * background to the target, which reduces to §6.2.3's table exactly when the background is
 * Dark — the case that table was written for.
 *
 * Bright is the exception and stays absolute: it means full daylight, which is what
 * `ambientBrightest` is, and mixing toward it would make it depend on the ground it fell on.
 *
 * @param {number} target - The {@link TIER} this zone should read as
 * @param {number} background - The {@link TIER} of the ground beneath it
 * @returns {number} A `CONST.LIGHTING_LEVELS` value
 */
export function levelForTier(target, background) {
  if (target === TIER.BRIGHT) return 3; // BRIGHTEST — absolute, and the only one that is
  if (target === TIER.SUPERNATURAL_DARK) return -2; // DARKNESS — the violet
  const rungs = target - background;
  if (rungs <= 0) return 0; // UNLIT — the background itself; this zone adds nothing
  if (rungs === 1) return 1; // DIM
  return 2; // BRIGHT
}

/**
 * Every `dark` cell is drawn by a **darkness** source, whatever its tier.
 *
 * @remarks
 * This was nearly got wrong twice. A `dark` cell's tier is ambient reduced one step, so
 * it is always ≤ ambient — and the first build rendered it with a *light* source, which
 * can only add, turning a *darkness* cast at noon into a glow. The second reading was
 * that it therefore could not be drawn at all until §7.1 gave us global illumination.
 *
 * Both were wrong for the same reason: a darkness source **subtracts**, and once its
 * lighting level can be set per source (see `clip.setLevel`) it subtracts *down to that
 * tier* rather than to black. Bright ambient with a *darkness* over it becomes Normal,
 * which is exactly the rule.
 *
 * `TIER.DARK` still draws — as `UNLIT`, which on an already-unlit scene is a no-op and
 * on a lit one is the full reduction the spell is entitled to.
 */

/**
 * The darkness level at or below which **global illumination still renders**.
 *
 * @remarks
 * Global light paints at Foundry's `DIM`, which is our Normal-and-Dim territory, and it has no
 * business lighting ground the model calls Dark. So the cutoff sits exactly at the Dim/Dark
 * boundary and the rule is one sentence: *global illumination renders where the model says Dim
 * or brighter.* Derived from the live table rather than fixed, so retuning cannot silently
 * move a tier across the cutoff.
 *
 * This replaces §7.0's geometric takeover. Cutting ambient out of a darkness used to mean
 * handing `GlobalLightSource` a `customPolygon` — one ring, no holes, which is precisely the
 * shape "scene minus a darkness in the middle" is not (see `render/ambient.mjs`). The shader
 * already had a per-fragment version of the same test:
 *
 * ```glsl
 * if ( globalLight && ((computedDarknessLevel < globalLightThresholds[0])
 *                   || (computedDarknessLevel > globalLightThresholds[1])) ) discard;
 * ```
 *
 * so narrowing the upper threshold to this value makes every region we paint darker than Dim
 * discard global light *by itself*, holes and all, with no geometry involved.
 */
export const globalLightCutoff = () => darknessTable()[TIER.DIM];

/**
 * The darkness level a tier should be painted at, and whether global light survives it.
 *
 * @param {number} tier - A {@link TIER} value
 * @returns {{level: number, erase: boolean}} `erase` marks a region global illumination must
 *   neither light nor **reveal** — the visibility half of the same decision, applied by
 *   `render/darkness-texture.mjs`.
 */
export function darknessFor(tier) {
  const table = darknessTable();
  const level = table[tier] ?? table[TIER.DARK];
  return { level, erase: level > globalLightCutoff() };
}

/* -------------------------------------------- */
/*  Putting lights on the same ladder            */
/* -------------------------------------------- */

/**
 * Derive `CONFIG.Canvas.lightLevels` so a light's zones land on the ambient tiers.
 *
 * @remarks
 * **`weights.bright` defaulting to `1.0` is what made lights immune to everything this module
 * does**, and it is worth stating exactly why, because the conclusion is the opposite of the one
 * this file reached a day earlier.
 *
 * ```glsl
 * computedBrightColor = mix(computedBackgroundColor, ambientBrightest, weights.bright);
 * computedDimColor    = mix(computedBackgroundColor, computedBrightColor, weights.dim);
 * ```
 *
 * At `weights.bright = 1` the first line collapses to `ambientBrightest` — the background term
 * cancels out entirely. So a light's bright zone is an absolute colour that **nothing** can
 * influence: not the scene's darkness, not our tier field, not an umbra. That is why a *darkness*
 * cast between an observer and a torch-lit patch dimmed the ambient around the torch and left
 * the torch untouched (reported 2026-08-23 as light overriding the dim umbra), and it is also
 * why `BRIGHTEST` and `BRIGHT` render identically, collapsing our five tiers to four.
 *
 * **This supersedes the `computeIllumination = false` proposal in DESIGN.md §7.0.** That would
 * have made every light's colours absolute *by design* — which reads as the same goal ("a Normal
 * zone is always the same RGB") and is in fact the exact failure above, made permanent. Lights
 * must stay **relative to the background**, because the background is the only channel through
 * which the model can reach them. The fix is not to disconnect them; it is to stop the weight
 * from cancelling the connection.
 *
 * So the weights are *derived* rather than chosen, from one source of truth — the tier table —
 * by asking where a light's zones fall on unlit ground and solving for the weight that puts them
 * on the matching ambient tier:
 *
 * ```
 * bright zone on unlit ground  =  mix(bgDark, ambientBrightest, wB)  ==  bg(NORMAL)
 * dim zone on unlit ground     =  mix(bgDark, brightZone,       wD)  ==  bg(DIM)
 * ```
 *
 * Rec. 709 luminance rather than a single channel, since `ambientDarkness` is blue-tinted by
 * default and a red-channel solve would put the tiers visibly off.
 *
 * **It is a partial answer and should be read as one.** A light inside a Dim umbra now *dims*,
 * because its colour is anchored on a background the umbra darkened — but it does not *clamp* to
 * Dim, because the shader has no path from the darkness texture to a light's lighting level.
 * Getting that exactly right needs the light's own geometry clipped per observer, which is the
 * §9.5 cost this design exists to avoid.
 *
 * @returns {{dark: number, halfdark: number, dim: number, bright: number}|null}
 */
export function deriveWeights() {
  const colors = canvas?.colors;
  if (!colors?.ambientDarkness) return null;

  const lum = (color) => {
    const [r, g, b] = color.rgb;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };

  const dark = lum(colors.ambientDarkness);
  const daylight = lum(colors.ambientDaylight);
  const brightest = lum(colors.ambientBrightest);

  // The ambient ladder, as the background shader computes it.
  const bg = (level) => daylight + (dark - daylight) * level;

  const table = darknessTable();
  const floor = bg(table[TIER.DARK]);
  const normal = bg(table[TIER.NORMAL]);
  const dim = bg(table[TIER.DIM]);

  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  const wBright = brightest > floor ? clamp01((normal - floor) / (brightest - floor)) : 1;
  const wDim = normal > floor ? clamp01((dim - floor) / (normal - floor)) : 0;

  // `dark` and `halfdark` are left at core's values: neither is reachable from our tiers
  // (§6.2.3 — HALFDARK is unused by core too), so there is nothing to solve for.
  return { dark: 0, halfdark: 0.5, dim: +wDim.toFixed(4), bright: +wBright.toFixed(4) };
}

/** What `CONFIG.Canvas.lightLevels` held before we touched it. */
let savedWeights = null;

const sameWeights = (a, b) =>
  !!a && !!b && ["dark", "halfdark", "dim", "bright"].every((k) => a[k] === b[k]);

/**
 * Install the derived weights, if they differ from what is already there.
 *
 * @remarks
 * Guarded on equality because applying them means `canvas.environment.initialize()`, which
 * fires a hook and a perception update — and this is called from hooks. Re-entering it on every
 * canvas event would be a loop rather than a refresh.
 *
 * @returns {object|null} The weights now in force, or null if nothing changed
 */
export function applyLightWeights() {
  const next = deriveWeights();
  if (!next) return null;
  if (sameWeights(CONFIG.Canvas.lightLevels, next)) return null;

  savedWeights ??= { ...(CONFIG.Canvas.lightLevels ?? {}) };
  CONFIG.Canvas.lightLevels = next;
  // `canvas.environment.weights` is copied from CONFIG on initialise (`environment.mjs:174`) and
  // uploaded to every light shader from there, so the assignment alone reaches nothing.
  canvas?.environment?.initialize();
  return next;
}

/** Hand Foundry back its own light levels. */
export function restoreLightWeights() {
  if (!savedWeights) return;
  CONFIG.Canvas.lightLevels = savedWeights;
  savedWeights = null;
  canvas?.environment?.initialize();
}
