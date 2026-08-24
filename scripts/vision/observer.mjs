/**
 * Observer resolution — DESIGN.md §5, §8.2 step 5.
 *
 * *Whose* field is being computed. Everything before this point answers the god's-eye
 * question; this decides which creature's point of view the answer is for, which is the
 * premise the whole module rests on (§2.2).
 *
 * ## It reduces to one method
 *
 * `CanvasVisibility` already treats **zero active vision sources** as god's eye
 * (`visibility.mjs:497`, `:738`). So the entire §5.1 table is expressible as one override of
 * `Token#_isVisionSource()` — no separate mode flag, no branch in the model, and no document
 * writes, because the method is evaluated client-side during vision initialisation.
 *
 * ## Most of it is already built, by PF1
 *
 * PF1 replaces this method (`pf1/module/canvas/token.mjs:43-64`) and its version already
 * satisfies four of the six rows:
 *
 * | User | Selection | Wanted | PF1 today |
 * | --- | --- | --- | --- |
 * | GM | none | god's eye | ✓ `if (isGM) return false` → zero sources |
 * | GM | token | that token | ✓ `if (this.controlled) return true` |
 * | Player | none | union of owned/observed | ✓ via `guaranteedVision` |
 * | Player | token | that token only | ✗ **vision sharing defeats it** |
 *
 * So there are exactly two jobs here, and neither is a reimplementation.
 */

import { MODULE_ID } from "../constants.mjs";

export const SETTING_GM_OBSERVER = "gmObserverMode";

const PATCH_MARK = "pf1LightingObserverPatched";

/**
 * Does a GM's selected token become the observer?
 *
 * @remarks
 * Client-scoped, because it is a question about what *this* GM is currently looking at, not
 * about how the world behaves. Two GMs should be able to disagree, and neither should be
 * writing to the scene to change their own view.
 *
 * Defaults **on**, which is PF1's existing behaviour — selecting a token shows you its view.
 * Turning it off keeps god's eye while a token is selected, which is what you want when
 * moving tokens around rather than adjudicating what one can see.
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
 * **`initializeVision` is not enough, and that is why the toggle did nothing** (found
 * 2026-08-22). `CanvasVisibility#initializeSources()` re-initialises the vision sources that
 * already exist (`groups/visibility.mjs:173-177`); it never re-decides *membership*. That
 * decision lives in `Token#initializeVisionSource()`, which is called from the control and
 * release paths only — so flipping a setting that `_isVisionSource()` reads changed a value
 * nothing asked again.
 *
 * The loop is core's own idiom (`placeables/token.mjs:4160`): `!token.vision` and
 * `token._isVisionSource()` agreeing means the token's *current* state contradicts what it
 * *should* be, so only those get rebuilt.
 *
 * Still no document writes. `_isVisionSource()` is evaluated client-side, so switching
 * observers costs a local recompute — no scene round-trip, and none of the screen-flash that
 * flipping `tokenVision` needs a blackout tile to hide.
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
    name: "GM sees through the selected token",
    hint:
      "When on, selecting a token as GM shows you what that token perceives. When off, you keep the " +
      "god's-eye view even with a token selected. Per-client, and toggleable from the token controls.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => refreshVision(),
  });
}

export function registerKeybindings() {
  game.keybindings.register(MODULE_ID, "toggleGmObserverMode", {
    name: "Toggle GM observer view",
    hint: "Switch between the god's-eye view and the selected token's point of view.",
    editable: [{ key: "KeyO", modifiers: ["Alt"] }],
    restricted: true,
    onDown: () => {
      toggleGmObserverMode().then((active) => {
        ui.controls?.render();
        ui.notifications.info(
          `PF1 Lighting | ${active ? "Seeing through the selected token." : "God's-eye view."}`
        );
      });
      return true;
    },
  });
}

/**
 * Add the toggle to the token controls.
 *
 * @remarks
 * v13 passes `controls` as a **Record keyed by control name**, not an array
 * (`applications/ui/scene-controls.mjs:326-336`) — the v12 `controls.find(c => ...)` idiom
 * silently does nothing here rather than erroring, which is the worst kind of API change.
 */
export function registerSceneControls() {
  Hooks.on("getSceneControlButtons", (controls) => {
    if (!game.user.isGM) return;
    const tokens = controls.tokens;
    if (!tokens?.tools) return;

    tokens.tools.pf1LightingObserver = {
      name: "pf1LightingObserver",
      order: 90,
      title: "Observer view (selected token's point of view)",
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
 * Over **PF1's** override, not core's — its semantics differ and are mostly what we want
 * (see the table at the top of this file). Subclassing the core class we happen to know
 * Foundry ships would discard `guaranteedVision`, which is §5.1's player-side setting
 * already built and configurable.
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
     * **1. The GM toggle.** With observer mode off, a GM's controlled tokens do not become
     * vision sources, which leaves the count at zero and `CanvasVisibility` falls back to
     * god's eye on its own. Nothing else has to know the mode exists.
     *
     * **2. Vision sharing must not defeat "selection narrows".** PF1 returns `true` for a
     * shared-vision token *before* reaching its "no other controlled token with sight" check
     * (`pf1/module/canvas/token.mjs:57` vs `:63`). So a player who selects one token still
     * gets the union of every vision-shared token in the party, and §5.1's invariant — that
     * selection always narrows to exactly that token — quietly does not hold for them.
     *
     * The narrowing test is the same expression PF1 already uses on its last line, applied
     * to the branch that skipped it. Harmless where it is redundant.
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
 * "Zero vision sources means god's eye" is an *implicit* contract — nothing anywhere says
 * so, and a single token wrongly returning `true` turns the GM's whole view into that
 * token's without any error. This makes the count and each token's verdict explicit.
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
