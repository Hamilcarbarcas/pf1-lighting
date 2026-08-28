/**
 * Observer-side blindness — DESIGN.md §4.5.1.
 *
 * The third question, and the one the document did not separate until testing forced it:
 *
 *   1. How bright is this point?                        §3, §4.1
 *   2. Can I make out something *at* that point?        §4.8, perception
 *   3. **Does my vision work at all, where I stand?**   here
 *
 * Found by testing 2026-08-22: a darkvision token in Supernatural Dark still painted
 * black-and-white terrain around itself. Perception could never have fixed that — terrain
 * comes from the vision source's own polygon and vision mode, while perception governs
 * detection modes. Nothing had told the *vision source* it was in trouble.
 *
 * ## Why only Supernatural Dark
 *
 * The obvious rule — "blind me when the tier at my feet defeats every sense I have" — is
 * wrong, and wrong in an ordinary case rather than an exotic one:
 *
 * > A creature without darkvision stands on unlit ground, Dark. A lit room lies 30 ft
 * > away. It cannot see the ground at its feet, and it can certainly see the room.
 *
 * Blinding the source there would black out the room too. Ordinary Dark is not a
 * disability, it is an absence of light, and the renderer already expresses it by there
 * being nothing to draw.
 *
 * Supernatural Dark from a **magical** source is different, and not by degree. Standing
 * inside an umbra-casting suppressor means §4.3's cone covers **360°** — every outbound
 * sightline crosses the boundary and clamps to the same tier. There is nothing left to see
 * in any direction, so blinding is the exact answer rather than an approximation of one,
 * and it stays exact once umbra exists.
 *
 * Hence two conditions, not one: the tier, and {@link castsUmbra}. Level 0 is mundane
 * darkness and never blinds, however dark it is configured to be.
 *
 * ## This is native path 4, restored with a condition
 *
 * Foundry blinds a vision source whose origin is inside *any* active darkness
 * (`point-vision-source.mjs:198`). We disabled that (§4.1.1) because it is indiscriminate:
 * it fires for ordinary *darkness* too, where darkvision is supposed to work perfectly.
 * The behaviour was never wrong — only its trigger. So the trigger becomes the model, and
 * Foundry's own blinding machinery does the rest.
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
 * **Revealing and brightening are the same act in Foundry**, which is why this dial has to
 * exist at all. `data.radius` makes a region render as *directly seen* rather than merely
 * explored, and that is the identical mechanism by which darkvision shows an unlit room —
 * there is no way to reveal terrain without also lightening it.
 *
 * Filling a creature's whole line of sight therefore reads noticeably brighter than the same
 * scene does with nothing selected. Whether that is right is a question about the table's
 * taste rather than the rules: *see in darkness* is "perfect vision", so seeing clearly is
 * arguably correct, but it flattens the sense that unlit ground is unlit.
 *
 * `visionModeOverrides.brightness` is applied per source from `data.brightness`
 * (`point-vision-source.mjs:256`), so it is a real dial rather than a global filter.
 *
 * Defaults to **0 — no change**. A non-zero default would silently alter how the scene looks
 * for a feature that is meant to be about what a creature can *see*.
 */
export function registerSettings() {
  game.settings.register(MODULE_ID, SETTING_DARK_SIGHT_BRIGHTNESS, {
    name: "See-in-darkness brightness",
    hint:
      "Adjusts how bright terrain looks to a creature with see in darkness or true seeing. Foundry " +
      "cannot reveal an area without also lightening it, so their view reads brighter than the " +
      "scene's own lighting. Negative values dim it back toward that. 0 leaves it alone.",
    scope: "world",
    // **Edited in the *Configure visuals* window, not the flat list** (§10.6, 2026-08-26).
    // Registered here, where the code that reads it lives; `ui/visuals.mjs` reads and writes it
    // by key and does not own it.
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
 * Light-independent sight is not only a detection rule; it is a **rendering** one, and the
 * rendering half is the part that is easy to miss. Detection is handled by
 * {@link perceives} and {@link darkvisionSees}, but terrain is revealed by the vision
 * source's own `data.radius` painting the vision mask (`groups/visibility.mjs:575-590`).
 * With detection alone, a creature would make out every token in line of sight while
 * standing in a black void.
 *
 * - *See in darkness* has no range in the rules, so it fills the whole LOS. Walls still
 *   block, because the LOS polygon is what is being filled.
 * - *True seeing* needs nothing from us here — PF1 already bumps `sight.range` to the
 *   spell's range (`pf1/module/documents/token.mjs:229-232`). Returning its range anyway is
 *   harmless, since the caller takes a maximum, and it keeps the two senses on one path
 *   rather than making one of them depend on PF1 continuing to do that.
 *
 * The vision mode stays `basic` unless the creature also has darkvision, so lit and unlit
 * ground still read as brighter and darker rather than flattening to grey — GM vision
 * without the god's-eye.
 *
 * @param {PointVisionSource} source
 * @returns {number}
 */
export function darkSightRadius(source) {
  if (!isPerceptionEnabled()) return 0;
  const range = darkSightRange(source);
  // `data.radius` must be a finite number of pixels. `maxR` is the scene diagonal, which is
  // unbounded for every purpose a vision polygon has.
  if (range === Infinity) return canvas?.dimensions?.maxR ?? 0;
  return range;
}

/**
 * How far a **blinded** creature still perceives, in pixels — its blindsight range, or `0`.
 *
 * @remarks
 * The rules answer to *"the blinded condition should not take away blindsight"* (Patrick,
 * 2026-08-26). Blindsight is not sight: a creature that maps a room by echo has nothing taken
 * from it by being unable to see, and PF1 already models the detection half — its `blindSight`
 * mode is type `OTHER` with `_canDetect() { return true }`, so it survives core's
 * status-effect gate on sight modes (`perception/detection-mode.mjs:107`).
 *
 * What did **not** survive is *terrain*, and for the reason that runs through all of §4.5.1:
 * `Token#_getVisionBlindedStates` sets `blinded.blind` from the status effect
 * (`placeables/token.mjs:911`), `isBlinded` then swaps the vision mode to `blindness` and
 * `refreshVisibility` draws no sight FOV — so the creature detected every token in range while
 * standing in an unpainted void. Exactly the failure {@link darkSightRadius} was written for,
 * arriving down a different path.
 *
 * **Blindsight alone, not `darkSightRange`.** The other two light-independent senses are still
 * *sight* — a blinded creature does not get to use *true seeing* — so the subset that survives
 * blinding is narrower than the subset that survives darkness. See
 * `perception.blindsightRange`.
 *
 * Gated on the perception setting rather than on one of its own: this is a rule about what a
 * sense does, and that switch is what turns the senses layer on. It costs a twentieth flat
 * setting not to.
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
 * Defensive rather than diagnosed. `blinded.darkness` is read during source
 * initialisation, and this resolver walks the registry, which walks
 * `canvas.effects.lightSources`. That path touches no vision source today, so there is no
 * known cycle — but a hang is a far worse failure than a wrong pixel, and the guard costs
 * one boolean.
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

  // Any light-independent sight at all exempts the observer: the question is about its own
  // square, which is at distance zero, so even a bounded range covers it.
  if (darkSightRange(source) > 0) return false;

  resolving = true;
  try {
    const origin = {
      x: source.x,
      y: source.y,
      elevation: source.elevation ?? source.data?.elevation ?? 0,
    };

    // `evaluate` rather than `perceivedTier`, because the tier alone is not enough: we need
    // to know *what* made it that dark. Cheap — once per vision source per initialisation,
    // not per frame.
    const result = evaluate(origin);
    if (result.tier > TIER.SUPERNATURAL_DARK) return false;

    // **The suppressor must be magical.** Blinding is the degenerate case of a 360° umbra
    // (§4.3), so it is only correct where an umbra would exist at all. A mundane source
    // cannot normally reach Supernatural Dark, but a homebrew one with an explicit `floor`
    // could — and standing in a very dark room is not a disability.
    return castsUmbra(result.winner);
  } catch {
    // A diagnostic layer must never be the reason a canvas fails to draw.
    return false;
  } finally {
    resolving = false;
  }
}
