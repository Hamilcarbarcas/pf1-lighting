/**
 * Observer-side blindness — DESIGN.md §4.5.1.
 *
 * The third question, separated only when testing forced it:
 *
 *   1. How bright is this point?                     §3, §4.1
 *   2. Can something at that point be made out?      §4.8, perception
 *   3. Does vision work at all, where the observer stands?   here
 *
 * Found by testing 2026-08-22: a darkvision token in Supernatural Dark still painted
 * black-and-white terrain around itself. Perception could never have fixed that — terrain comes
 * from the vision source's own polygon and vision mode, while perception governs detection modes.
 * Nothing had told the vision source it was in trouble.
 *
 * Only Supernatural Dark. The obvious rule — blind an observer whenever the tier at its feet
 * defeats every sense it has — fails in an ordinary case: a creature without darkvision on unlit
 * Dark ground, with a lit room 30 ft away, cannot see its own feet but can certainly see the room.
 * Blinding the source there would black out the room too. Ordinary Dark is an absence of light, not
 * a disability, and the renderer already expresses it by having nothing to draw.
 *
 * Supernatural Dark from a magical source differs in kind, not degree: standing inside an
 * umbra-casting suppressor makes §4.3's cone 360°, every outbound sightline crossing the boundary
 * and clamping to the same tier. Nothing is left to see in any direction, so blinding is exact
 * rather than an approximation, and stays exact once umbra exists.
 *
 * Hence two conditions: the tier, and {@link castsUmbra}. Level 0 is mundane darkness and never
 * blinds, however dark it is configured to be.
 *
 * This is native path 4 restored with a condition. Foundry blinds a vision source whose origin is
 * inside any active darkness (`point-vision-source.mjs:198`), disabled in §4.1.1 for being
 * indiscriminate — it fires for ordinary darkness too, where darkvision should work perfectly. The
 * behaviour was never wrong, only its trigger; the trigger becomes the model and Foundry's own
 * blinding machinery does the rest.
 */

import { MODULE_ID } from "../constants.mjs";
import { castsUmbra } from "../model/contest.mjs";
import { evaluate } from "../model/evaluate.mjs";
import { TIER } from "../model/tiers.mjs";
import { blindsightRange, darkSightRange, isPerceptionEnabled, refresh } from "./perception.mjs";

export const SETTING_DARK_SIGHT_BRIGHTNESS = "darkSightBrightness";

/**
 * How much to dim what light-independent sight reveals.
 *
 * @remarks
 * Revealing and brightening are the same act in Foundry, which is why this dial exists at all.
 * `data.radius` makes a region render as directly seen rather than merely explored — the same
 * mechanism by which darkvision shows an unlit room. Terrain cannot be revealed without being
 * lightened.
 *
 * Filling a creature's whole line of sight therefore reads brighter than the same scene with
 * nothing selected. Whether that is right is a question of table taste rather than rules: see in
 * darkness is perfect vision, so seeing clearly is arguably correct, but it flattens the sense that
 * unlit ground is unlit.
 *
 * `visionModeOverrides.brightness` is applied per source from `data.brightness`
 * (`point-vision-source.mjs:256`), making it a real dial rather than a global filter.
 *
 * Defaults to 0, no change — a non-zero default would silently alter how the scene looks for a
 * feature about what a creature can see.
 */
export function registerSettings() {
  game.settings.register(MODULE_ID, SETTING_DARK_SIGHT_BRIGHTNESS, {
    name: "See-in-darkness brightness",
    hint:
      "Adjusts how bright terrain looks to a creature with see in darkness or true seeing. Foundry " +
      "cannot reveal an area without also lightening it, so their view reads brighter than the " +
      "scene's own lighting. Negative values dim it back toward that. 0 leaves it alone.",
    scope: "world",
    // Edited in the Configure visuals window, not the flat list (§10.6, 2026-08-26). Registered
    // here, where the code that reads it lives; `ui/visuals.mjs` reads and writes it by key
    // without owning it.
    config: false,
    type: Number,
    range: { min: -1, max: 1, step: 0.05 },
    default: 0,
    onChange: () => refresh(),
  });
}

/**
 * The configured brightness offset for a source with light-independent sight.
 *
 * @param {PointVisionSource} source
 * @returns {number} 0 when the setting is untouched or the creature has no such sense
 */
export function darkSightBrightness(source) {
  if (darkSightRadius(source) <= 0) return 0;
  try {
    return game.settings.get(MODULE_ID, SETTING_DARK_SIGHT_BRIGHTNESS) ?? 0;
  } catch {
    return 0;
  }
}

/**
 * How far this creature's terrain rendering must reach, in pixels — `0` for none.
 *
 * @remarks
 * Light-independent sight is a rendering rule as well as a detection one, and the rendering half is
 * the easy one to miss. Detection is handled by {@link perceives} and {@link darkvisionSees}, but
 * terrain is revealed by the vision source's own `data.radius` painting the vision mask
 * (`groups/visibility.mjs:575-590`). With detection alone a creature makes out every token in line
 * of sight while standing in a black void.
 *
 * - See in darkness has no range in the rules, so it fills the whole LOS. Walls still block, the
 *   LOS polygon being what is filled.
 * - True seeing needs nothing here — PF1 already bumps `sight.range` to the spell's range
 *   (`pf1/module/documents/token.mjs:229-232`). Returning its range anyway is harmless, the caller
 *   taking a maximum, and keeps both senses on one path rather than depending on PF1 continuing to
 *   do that.
 *
 * The vision mode stays `basic` unless the creature also has darkvision, so lit and unlit ground
 * still read as brighter and darker rather than flattening to grey — GM vision without the
 * god's-eye.
 *
 * @param {PointVisionSource} source
 * @returns {number}
 */
export function darkSightRadius(source) {
  if (!isPerceptionEnabled()) return 0;
  const range = darkSightRange(source);
  // `data.radius` must be a finite number of pixels. `maxR` is the scene diagonal, unbounded for
  // every purpose a vision polygon has.
  if (range === Infinity) return canvas?.dimensions?.maxR ?? 0;
  return range;
}

/**
 * How far a blinded creature still perceives, in pixels — its blindsight range, or `0`.
 *
 * @remarks
 * The blinded condition must not take away blindsight (2026-08-26). Blindsight is not sight: a
 * creature mapping a room by echo loses nothing by being unable to see, and PF1 already models the
 * detection half — its `blindSight` mode is type `OTHER` with `_canDetect() { return true }`, so it
 * survives core's status-effect gate on sight modes (`perception/detection-mode.mjs:107`).
 *
 * Terrain did not survive, for the reason running through all of §4.5.1:
 * `Token#_getVisionBlindedStates` sets `blinded.blind` from the status effect
 * (`placeables/token.mjs:911`), `isBlinded` swaps the vision mode to `blindness`, and
 * `refreshVisibility` draws no sight FOV — so the creature detected every token in range while
 * standing in an unpainted void. The failure {@link darkSightRadius} was written for, down a
 * different path.
 *
 * Blindsight alone, not `darkSightRange`: the other two light-independent senses are still sight,
 * and a blinded creature does not get to use true seeing, so the subset surviving blinding is
 * narrower than the subset surviving darkness. See `perception.blindsightRange`.
 *
 * Gated on the perception setting rather than one of its own — this is a rule about what a sense
 * does, and that switch turns the senses layer on. Otherwise it costs a twentieth flat setting.
 *
 * @param {PointVisionSource} source
 * @returns {number} Pixels
 */
export function blindsightRadius(source) {
  if (!isPerceptionEnabled()) return 0;
  return blindsightRange(source);
}

/**
 * Re-entrancy guard.
 *
 * @remarks
 * Defensive rather than diagnosed. `blinded.darkness` is read during source initialisation, and
 * this resolver walks the registry, which walks `canvas.effects.lightSources` — a path touching no
 * vision source today, so no known cycle. A hang is a far worse failure than a wrong pixel and the
 * guard costs one boolean.
 */
let resolving = false;

/**
 * Should the model blind this vision source outright?
 *
 * @param {PointVisionSource} source
 * @returns {boolean}
 */
export function modelBlinds(source) {
  if (!isPerceptionEnabled()) return false;
  if (resolving) return false;

  // Any light-independent sight exempts the observer: the question is about its own square, at
  // distance zero, so even a bounded range covers it.
  if (darkSightRange(source) > 0) return false;

  resolving = true;
  try {
    const origin = {
      x: source.x,
      y: source.y,
      elevation: source.elevation ?? source.data?.elevation ?? 0,
    };

    // `evaluate` rather than `perceivedTier`: the tier alone is not enough, what made it that dark
    // matters. Cheap — once per vision source per initialisation, not per frame.
    const result = evaluate(origin);
    if (result.tier > TIER.SUPERNATURAL_DARK) return false;

    // The suppressor must be magical. Blinding is the degenerate case of a 360° umbra (§4.3), so
    // it is only correct where an umbra would exist. A mundane source cannot normally reach
    // Supernatural Dark, but a homebrew one with an explicit `floor` could — and standing in a
    // very dark room is not a disability.
    return castsUmbra(result.winner);
  } catch {
    // A diagnostic layer must never be the reason a canvas fails to draw.
    return false;
  } finally {
    resolving = false;
  }
}
