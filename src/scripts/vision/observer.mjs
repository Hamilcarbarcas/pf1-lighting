/**
 * Observer resolution — DESIGN.md §5, §8.2 step 5.
 *
 * Whose field is being computed. Everything before this point answers the god's-eye question; this
 * decides which creature's point of view the answer is for — the premise the module rests on
 * (§2.2).
 *
 * It reduces to one method. `CanvasVisibility` already treats zero active vision sources as god's
 * eye (`visibility.mjs:497`, `:738`), so the entire §5.1 table is one override of
 * `Token#_isVisionSource()`: no mode flag, no branch in the model, no document writes, the method
 * being evaluated client-side during vision initialisation.
 *
 * PF1 replaces that method (`pf1/module/canvas/token.mjs:43-64`) and already satisfies four of the
 * six rows:
 *
 * | User | Selection | Wanted | PF1 today |
 * | --- | --- | --- | --- |
 * | GM | none | god's eye | ✓ `if (isGM) return false` → zero sources |
 * | GM | token | that token | ✓ `if (this.controlled) return true` |
 * | Player | none | union of owned/observed | ✓ via `guaranteedVision` |
 * | Player | token | that token only | ✗ vision sharing defeats it |
 *
 * So there are exactly two jobs here, neither a reimplementation.
 */

import { MODULE_ID, setSettingVisibility } from "../constants.mjs";
import { t } from "../i18n.mjs";

export const SETTING_GM_OBSERVER = "gmObserverMode";

const PATCH_MARK = "pf1LightingObserverPatched";

/**
 * Does a GM's selected token become the observer?
 *
 * @remarks
 * Client-scoped: a question about what one GM is currently looking at, not about how the world
 * behaves. Two GMs should be able to disagree, and neither should write to the scene to change
 * their own view.
 *
 * Defaults on, matching PF1's existing behaviour — selecting a token shows its view. Off keeps
 * god's eye while a token is selected, which suits moving tokens around rather than adjudicating
 * what one can see.
 */
export function isGmObserverMode() {
  try {
    return game.settings.get(MODULE_ID, SETTING_GM_OBSERVER) === true;
  } catch {
    return true;
  }
}

/** Flip the toggle and re-resolve vision. No document writes — see {@link refreshVision}. */
export async function toggleGmObserverMode() {
  const next = !isGmObserverMode();
  await game.settings.set(MODULE_ID, SETTING_GM_OBSERVER, next);
  return next;
}

/**
 * Re-run vision resolution.
 *
 * @remarks
 * `initializeVision` is not enough, which is why the toggle did nothing (found 2026-08-22).
 * `CanvasVisibility#initializeSources()` re-initialises the vision sources that already exist
 * (`groups/visibility.mjs:173-177`) but never re-decides membership. That decision lives in
 * `Token#initializeVisionSource()`, called from the control and release paths only, so flipping a
 * setting `_isVisionSource()` reads changed a value nothing asked again.
 *
 * The loop is core's own idiom (`placeables/token.mjs:4160`): `!token.vision` agreeing with
 * `token._isVisionSource()` means the token's current state contradicts what it should be, so only
 * those rebuild.
 *
 * Still no document writes. `_isVisionSource()` is evaluated client-side, so switching observers
 * costs a local recompute — no scene round-trip, and none of the screen-flash that flipping
 * `tokenVision` needs a blackout tile to hide.
 */
export function refreshVision() {
  if (!canvas?.ready) return;
  for (const token of canvas.tokens.placeables) {
    if (!token.vision === token._isVisionSource()) token.initializeVisionSource();
  }
  canvas.perception.update({ initializeVision: true, refreshVision: true });
}

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTING_GM_OBSERVER, {
    name: "PF1LIGHTING.Setting.gmObserverMode.Name",
    hint: "PF1LIGHTING.Setting.gmObserverMode.Hint",
    // Client-scoped and GM-only, which Foundry has no single answer for. The value must be
    // per-client — two GMs must be able to disagree, and §5.1's point is that changing one's own
    // view never writes to the scene — but a player has no use for it: the keybinding is
    // `restricted` and the scene-control toggle returns early for non-GMs, leaving the settings row
    // as the one leak (2026-08-26).
    //
    // Registered visible and hidden at `ready`, `game.user` not existing yet here.
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => refreshVision(),
  });
}

/**
 * Hide the row from players.
 *
 * @remarks
 * `ready`, not `init`: `game.user` is assigned during `Game#setupGame`, well after settings are
 * registered. Nothing else about the setting changes — a non-GM's stored value stays whatever it
 * was and `isGmObserverMode` already returns early for them.
 */
export function registerHooks() {
  Hooks.once("ready", () => setSettingVisibility(SETTING_GM_OBSERVER, game.user?.isGM === true));
}

export function registerKeybindings() {
  game.keybindings.register(MODULE_ID, "toggleGmObserverMode", {
    name: "PF1LIGHTING.Keybind.toggleGmObserverMode.Name",
    hint: "PF1LIGHTING.Keybind.toggleGmObserverMode.Hint",
    editable: [{ key: "KeyO", modifiers: ["Alt"] }],
    restricted: true,
    onDown: () => {
      toggleGmObserverMode().then((active) => {
        ui.controls?.render();
        ui.notifications.info(t(active ? "Notify.ObserverOn" : "Notify.ObserverOff"));
      });
      return true;
    },
  });
}

/**
 * Add the toggle to the token controls.
 *
 * @remarks
 * v13 passes `controls` as a Record keyed by control name, not an array
 * (`applications/ui/scene-controls.mjs:326-336`). The v12 `controls.find(c => ...)` idiom silently
 * does nothing here rather than erroring.
 */
export function registerSceneControls() {
  Hooks.on("getSceneControlButtons", (controls) => {
    if (!game.user.isGM) return;
    const tokens = controls.tokens;
    if (!tokens?.tools) return;

    tokens.tools.pf1LightingObserver = {
      name: "pf1LightingObserver",
      order: 90,
      // A key rather than a string: `scene-controls-tools.hbs:5` renders it through `{{localize}}`.
      title: "PF1LIGHTING.Control.ObserverView",
      icon: "fa-solid fa-eye",
      toggle: true,
      active: isGmObserverMode(),
      onChange: (_event, active) => {
        // The setting's own onChange calls refreshVision, which rebuilds membership.
        game.settings.set(MODULE_ID, SETTING_GM_OBSERVER, active);
      },
    };
  });
}

/* -------------------------------------------- */
/*  The override                                */
/* -------------------------------------------- */

/**
 * Mix over whatever `Token` class is installed.
 *
 * @remarks
 * Over PF1's override, not core's — its semantics differ and are mostly the wanted ones (see the
 * table at the top of this file). Subclassing the core class directly would discard
 * `guaranteedVision`, §5.1's player-side setting, already built and configurable.
 *
 * Applied at `setup`, alongside the other placeable-class mixins, and once.
 */
export function applyMixin() {
  const Base = CONFIG.Token.objectClass;
  if (!Base || Base[PATCH_MARK]) return;

  CONFIG.Token.objectClass = class extends Base {
    static [PATCH_MARK] = true;

    /**
     * @override
     * @remarks
     * Two corrections to PF1's version, both narrowing rather than replacing.
     *
     * 1. The GM toggle. With observer mode off, a GM's controlled tokens do not become vision
     *    sources, leaving the count at zero so `CanvasVisibility` falls back to god's eye on its
     *    own. Nothing else has to know the mode exists.
     * 2. Vision sharing must not defeat selection-narrows. PF1 returns `true` for a shared-vision
     *    token before reaching its "no other controlled token with sight" check
     *    (`pf1/module/canvas/token.mjs:57` vs `:63`), so a player selecting one token still gets
     *    the union of every vision-shared token in the party, and §5.1's invariant that selection
     *    narrows to exactly that token does not hold for them.
     *
     * The narrowing test is the same expression PF1 uses on its last line, applied to the branch
     * that skipped it. Harmless where redundant.
     */
    _isVisionSource() {
      if (game.user.isGM && this.controlled && !isGmObserverMode()) return false;

      if (!super._isVisionSource()) return false;

      if (!this.controlled && this.actor?.sharesVision === true) {
        return !this.layer.controlled.some((t) => !t.document.hidden && t.hasSight);
      }
      return true;
    }
  };
}

/* -------------------------------------------- */
/*  Diagnostics                                 */
/* -------------------------------------------- */

/**
 * Who is the field being computed for, and why?
 *
 * @remarks
 * Zero-vision-sources-means-god's-eye is an implicit contract that nothing states, and a single
 * token wrongly returning `true` turns the GM's whole view into that token's without an error.
 * This makes the count and each token's verdict explicit.
 */
export function status() {
  const report = {
    isGM: game.user.isGM,
    gmObserverMode: isGmObserverMode(),
    controlled: canvas.tokens.controlled.map((t) => t.name),
    activeVisionSources: canvas.effects.visionSources.filter((s) => s.active).length,
    // The whole table collapses to this: zero means god's eye.
    resolvedMode:
      canvas.effects.visionSources.filter((s) => s.active).length === 0
        ? "god's eye"
        : "observer",
    tokens: canvas.tokens.placeables
      .filter((t) => t.hasSight)
      .map((t) => ({
        name: t.name,
        controlled: t.controlled,
        hidden: t.document.hidden,
        sharesVision: t.actor?.sharesVision === true,
        isVisionSource: t._isVisionSource(),
      })),
  };
  console.error("PF1 Lighting | observer resolution", report);
  return report;
}
