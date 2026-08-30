/**
 * Tier → Foundry lighting level. DESIGN.md §6.2.3.
 *
 * `CONST.LIGHTING_LEVELS` has six values and the model has five tiers, so the mapping is exact with
 * one to spare. `BRIGHTEST` is a fully rendered level nothing in core produces — it draws from
 * `canvas.colors.ambientBrightest`, itself set from `CONFIG.Canvas.brightestColor`
 * (`environment.mjs:156`, `rendered-effect-source.mjs:587`).
 *
 * That is what §3.2.1's added Bright tier renders as. No custom shader and no invented path:
 * Foundry already had a level for it and no use of its own.
 */

import { MODULE_ID } from "../constants.mjs";
import { TIER, TIER_TO_DARKNESS, darknessTable, setDarknessTable } from "../model/tiers.mjs";

/**
 * The tier → darkness-level table lives in `model/tiers.mjs` and is re-exported here.
 *
 * Moved 2026-08-23 with §3.2.1's rewrite: band stacking is additive on rungs, so the ambient rung is
 * the base of every sum the model computes and has to come from the same ladder the renderer paints
 * with. Re-exported rather than relocated-and-chased, so `render/ambient.mjs` and the console API
 * keep their import paths.
 */
export {
  TIER_TO_DARKNESS,
  DARKNESS_PRESETS,
  darknessTable,
  setDarknessTable,
  tierFromDarkness,
  darknessBand,
} from "../model/tiers.mjs";

/**
 * The Foundry lighting level that paints `target` against a background of `background`.
 *
 * @remarks
 * The four reachable outcomes (`base-lighting.mjs:155-166`):
 *
 * | Level | Paints |
 * | --- | --- |
 * | `UNLIT` (0) | `computedBackgroundColor` — the ground itself |
 * | `DIM` (1) | `mix(bg, computedBrightColor, weightDim)` |
 * | `BRIGHT` (2) | `mix(bg, ambientBrightest, weightBright)` |
 * | `BRIGHTEST` (3) | `ambientBrightest`, absolutely |
 *
 * and {@link deriveWeights} solves the two weights so that on unlit ground `DIM` lands on Dim and
 * `BRIGHT` on Normal.
 *
 * An absolute lookup with a floor, not a rung distance. Corrected 2026-08-25: the previous version
 * returned `target - background` clamped to `[0, 2]`, reasoning that the levels are relative to the
 * background so the level to ask for is the distance to climb. The middle two levels are relative
 * but not evenly relative, and a rung of this ladder is not a rung of Foundry's.
 *
 * Reported as Normal and Dim being almost indistinguishable with global illumination set to Dim —
 * the two tiers being 0.9 and 0.1, nearly the whole range — and, decisively, every other ambient
 * behaving. That is the shape of the bug written out:
 *
 * | Ambient | One-rung target | Level asked for | Weight solved for |
 * | --- | --- | --- | --- |
 * | Dark | Dim | `DIM` | a Dark background — correct |
 * | Dim | Normal | `DIM` | a Dark background — wrong |
 * | Normal | Bright | `BRIGHTEST` | absolute — correct |
 * | Bright | — | `UNLIT` | — |
 *
 * Dim ambient is the only background on which a one-rung step lands on a middle level, and the
 * middle levels carry a weight solved against Dark. With a typical `ambientDarkness`, a torch's
 * Normal ring on Dim ground came out at luminance ≈0.23 against a ground of ≈0.145, where Normal is
 * ≈0.905. Barely a difference, exactly as reported.
 *
 * So ask for the level whose absolute result is the target tier, falling back to `UNLIT` when the
 * target is not brighter than the ground — the case the relative form was introduced to fix, and
 * the only thing it was needed for.
 *
 * Why that is safe, since absolute is true of only one of them:
 *
 * - `DIM` is asked for only when the target is Dim and the background darker, which means the
 *   background is Dark — precisely the case its weight is solved for.
 * - `BRIGHT` is asked for on a Dark or a Dim background, and `mix(bg, ambientBrightest,
 *   weightBright)` barely moves between the two, `weightBright` being large (≈0.9 with the default
 *   table). Both land on Normal.
 * - `BRIGHTEST` and `UNLIT` do not depend on the weights at all.
 *
 * @param {number} target - The {@link TIER} this zone should read as
 * @param {number} background - The {@link TIER} of the ground beneath it
 * @returns {number} A `CONST.LIGHTING_LEVELS` value
 */
export function levelForTier(target, background) {
  if (target === TIER.SUPERNATURAL_DARK) return -2; // DARKNESS — the violet
  // Nothing to add: this zone is no brighter than the ground it falls on. The reason the background
  // is a parameter, and the only thing the relative form got right.
  if (target <= background) return 0; // UNLIT
  switch (target) {
    case TIER.BRIGHT:
      return 3; // BRIGHTEST — `ambientBrightest` outright
    case TIER.NORMAL:
      return 2; // BRIGHT
    case TIER.DIM:
      return 1; // DIM
    default:
      return 0; // UNLIT — Dark is the absence of light, not a level to paint
  }
}

/*
 * Every `dark` cell is drawn by a darkness source, whatever its tier.
 *
 * Nearly got wrong twice. A `dark` cell's tier is ambient reduced one step, so it is always ≤
 * ambient, and the first build rendered it with a light source, which can only add — turning a
 * darkness cast at noon into a glow. The second reading was that it therefore could not be drawn at
 * all until §7.1 provided global illumination.
 *
 * Both were wrong for the same reason: a darkness source subtracts, and once its lighting level can
 * be set per source (see `clip.setLevel`) it subtracts down to that tier rather than to black.
 * Bright ambient with a darkness over it becomes Normal, which is the rule.
 *
 * `TIER.DARK` still draws, as `UNLIT` — a no-op on an already-unlit scene, and on a lit one the
 * full reduction the spell is entitled to.
 */

/**
 * The darkness level at or below which **global illumination still renders**.
 *
 * @remarks
 * Global light paints at Foundry's `DIM`, which is Normal-and-Dim territory, and has no business
 * lighting ground the model calls Dark. So the cutoff sits at the Dim/Dark boundary and the rule is
 * one sentence: global illumination renders where the model says Dim or brighter. Derived from the
 * live table rather than fixed, so retuning cannot silently move a tier across the cutoff.
 *
 * This replaces §7.0's geometric takeover. Cutting ambient out of a darkness used to mean handing
 * `GlobalLightSource` a `customPolygon` — one ring, no holes, precisely the shape
 * scene-minus-a-darkness-in-the-middle is not (see `render/ambient.mjs`). The shader already had a
 * per-fragment version of the same test:
 *
 * ```glsl
 * if ( globalLight && ((computedDarknessLevel < globalLightThresholds[0])
 *                   || (computedDarknessLevel > globalLightThresholds[1])) ) discard;
 * ```
 *
 * so narrowing the upper threshold to this value makes every region painted darker than Dim discard
 * global light by itself, holes and all, with no geometry involved.
 */
export const globalLightCutoff = () => darknessTable()[TIER.DIM];

/**
 * The darkness level a tier should be painted at, and whether global light survives it.
 *
 * @param {number} tier - A {@link TIER} value
 * @returns {{level: number, erase: boolean}} `erase` marks a region global illumination must
 *   neither light nor reveal — the visibility half of the same decision, applied by
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
 * `weights.bright` defaulting to `1.0` is what made lights immune to everything this module does,
 * and the reason is worth stating exactly, the conclusion being the opposite of the one this file
 * reached a day earlier.
 *
 * ```glsl
 * computedBrightColor = mix(computedBackgroundColor, ambientBrightest, weights.bright);
 * computedDimColor    = mix(computedBackgroundColor, computedBrightColor, weights.dim);
 * ```
 *
 * At `weights.bright = 1` the first line collapses to `ambientBrightest`, the background term
 * cancelling entirely. So a light's bright zone is an absolute colour nothing can influence: not the
 * scene's darkness, not the tier field, not an umbra. That is why a darkness cast between an
 * observer and a torch-lit patch dimmed the ambient around the torch and left the torch untouched
 * (reported 2026-08-23 as light overriding the dim umbra), and also why `BRIGHTEST` and `BRIGHT`
 * render identically, collapsing five tiers to four.
 *
 * This supersedes the `computeIllumination = false` proposal in DESIGN.md §7.0, which would have
 * made every light's colours absolute by design — reading as the same goal (a Normal zone always
 * the same RGB) while being the exact failure above, made permanent. Lights must stay relative to
 * the background, the background being the only channel through which the model can reach them. The
 * fix is not to disconnect them but to stop the weight cancelling the connection.
 *
 * So the weights are derived rather than chosen, from one source of truth — the tier table — by
 * asking where a light's zones fall on unlit ground and solving for the weight that puts them on the
 * matching ambient tier:
 *
 * ```
 * bright zone on unlit ground  =  mix(bgDark, ambientBrightest, wB)  ==  bg(NORMAL)
 * dim zone on unlit ground     =  mix(bgDark, brightZone,       wD)  ==  bg(DIM)
 * ```
 *
 * Rec. 709 luminance rather than a single channel, `ambientDarkness` being blue-tinted by default
 * so a red-channel solve would put the tiers visibly off.
 *
 * A partial answer, and should be read as one. A light inside a Dim umbra now dims, its colour being
 * anchored on a background the umbra darkened, but it does not clamp to Dim, the shader having no
 * path from the darkness texture to a light's lighting level. Getting that exactly right needs the
 * light's geometry clipped per observer, which is the §9.5 cost this design exists to avoid.
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

  // `dark` and `halfdark` are left at core's values: neither is reachable from these tiers (§6.2.3
  // — HALFDARK is unused by core too), so there is nothing to solve for.
  return { dark: 0, halfdark: 0.5, dim: +wDim.toFixed(4), bright: +wBright.toFixed(4) };
}

/** What `CONFIG.Canvas.lightLevels` held before this module touched it. */
let savedWeights = null;

const sameWeights = (a, b) =>
  !!a && !!b && ["dark", "halfdark", "dim", "bright"].every((k) => a[k] === b[k]);

/**
 * Install the derived weights, if they differ from what is already there.
 *
 * @remarks
 * Guarded on equality because applying them means `canvas.environment.initialize()`, which fires a
 * hook and a perception update, and this is called from hooks. Re-entering on every canvas event
 * would be a loop rather than a refresh.
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

/* -------------------------------------------- */
/*  The tier table as settings                  */
/* -------------------------------------------- */

/**
 * One setting per tier, holding the darkness level that tier paints at.
 *
 * @remarks
 * §10.5's world-default half, brought forward 2026-08-25. Until then the table was retunable only
 * from the console (`render.levels("even")`) and persisted nowhere, so a value settled by looking at
 * a real map had to be re-entered every session.
 *
 * Four settings, not five. Supernatural Dark tracks Dark rather than having its own, because
 * {@link TIER_TO_DARKNESS} deliberately gives them the same level: Dark means no light and
 * `ambientDarkness` is what no light looks like, so there is nothing below it to reserve, and the
 * two are told apart by the darkness source's own overlay. The `even` preset, which does separate
 * them, stays reachable from the console.
 */
export const TIER_SETTINGS = Object.freeze({
  [TIER.BRIGHT]: "tierLevelBright",
  [TIER.NORMAL]: "tierLevelNormal",
  [TIER.DIM]: "tierLevelDim",
  [TIER.DARK]: "tierLevelDark",
});

const readLevel = (tier) => {
  const fallback = TIER_TO_DARKNESS[tier];
  try {
    const value = game.settings.get(MODULE_ID, TIER_SETTINGS[tier]);
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
  } catch {
    return fallback;
  }
};

/**
 * Build the table from the settings and install it.
 *
 * @remarks
 * Re-solving the light weights is not optional. `deriveWeights` reads the table — it asks where a
 * light's zones land on unlit ground and solves for the weight that puts them on the matching
 * ambient tier — so a table change without a re-solve leaves every light painting against the old
 * ladder while the ground paints against the new one, the §6.2.3 mismatch this file exists to
 * prevent.
 *
 * It re-solves only if the levels are already being driven, which `savedWeights` records. With the
 * global-illumination takeover off, `CONFIG.Canvas.lightLevels` holds Foundry's own values and
 * replacing them would apply a feature the GM has switched off. Reading that state locally also
 * keeps this out of a cycle — `render/ambient.mjs`, which owns the takeover setting, already
 * imports this file.
 *
 * @returns {Record<number, number>} The table now in force
 */
export function applyTierTable() {
  const dark = readLevel(TIER.DARK);
  const table = {
    [TIER.BRIGHT]: readLevel(TIER.BRIGHT),
    [TIER.NORMAL]: readLevel(TIER.NORMAL),
    [TIER.DIM]: readLevel(TIER.DIM),
    [TIER.DARK]: dark,
    [TIER.SUPERNATURAL_DARK]: dark,
  };
  setDarknessTable(table);
  if (savedWeights) applyLightWeights();
  return table;
}

/**
 * Announced whenever the tier table changes. `ui/scene-config.mjs` listens.
 *
 * @remarks
 * A hook rather than an injected callback, for the direction of the dependency rather than taste.
 * `ui/scene-config.mjs` reads the table from here, so this file cannot import it back; the two
 * `set…Refresh` seams elsewhere exist for exactly that shape, and a third for a genuine broadcast —
 * one producer, any number of listeners, none of which this file should know about — is the wrong
 * tool. It also makes the change observable to a macro, which the setters are not.
 */
export const TABLE_CHANGED_HOOK = `${MODULE_ID}.tierTableChanged`;

function onTierLevelChange() {
  const table = applyTierTable();
  // After the table is installed, before the canvas is told. A listener that re-derives a stored
  // value — which the scene sync does — has to see the new table, and one that repaints has to run
  // before the perception update rather than triggering a second one.
  Hooks.callAll(TABLE_CHANGED_HOOK, table);
  if (!canvas?.ready) return;
  // `initializeLighting`, not merely `refreshLighting`. The table is a model input — the base of
  // every additive sum in §3.2.1, through `ambientTier` — so the field has to be recomputed rather
  // than repainted. Re-initialising light sources reallocates their shapes, which is the field's
  // cache key, and the `initializeLightSources` hook is what the renderer schedules a rebuild from.
  // `refreshVision` because the darkness texture's erase meshes live in the visibility mask and
  // their band test is re-run there.
  canvas.perception.update({
    initializeLighting: true,
    refreshLighting: true,
    refreshVision: true,
  });
}

export function registerSettings() {
  const label = { [TIER.BRIGHT]: "Bright", [TIER.NORMAL]: "Normal", [TIER.DIM]: "Dim", [TIER.DARK]: "Dark" };

  for (const tier of [TIER.BRIGHT, TIER.NORMAL, TIER.DIM, TIER.DARK]) {
    game.settings.register(MODULE_ID, TIER_SETTINGS[tier], {
      // English rather than a translation key: `config: false` below, so the only thing printing
      // this is `game.pf1Lighting.settings()`. The Configure visuals window has its own translated
      // label per rung and does not read this. §10.11.
      name: `Brightness of ${label[tier]}`,
      // No hint, deliberately. Four settings differing in one word do not want four near-identical
      // paragraphs; the Configure visuals window carries one hint above the group, which is where
      // the rule about them descending belongs (2026-08-26).
      scope: "world",
      // Edited in the Configure visuals window, not the flat list (§10.6, 2026-08-26). Registered
      // here, where the code that reads it lives; `ui/visuals.mjs` reads and writes it by key
      // without owning it.
      config: false,
      type: Number,
      default: TIER_TO_DARKNESS[tier],
      onChange: onTierLevelChange,
    });
  }

  // Adopt whatever is stored, so the table is right before anything reads it. Safe here:
  // `registerSettings` runs at `init`, and a setting is readable as soon as it is registered.
  applyTierTable();
}
