/**
 * The light-level readout — DESIGN.md §8.2 step 2.
 *
 * A fresh implementation against this module's API, not a reparenting of
 * `pf1-light-level-tooltip`; that module stays alive standalone for anyone using it.
 *
 * Two things it does that the standalone cannot, both because it reads the model rather
 * than re-deriving light from Foundry's source data:
 *
 *   - **The level under the cursor**, continuously, not only on token hover.
 *   - **Why** — "Dim, reduced from Normal by darkness" rather than just "Dim". The
 *     model already computes the baseline and the deciding suppressor (§4.1); throwing
 *     that away at the last step would be the whole point of `evaluate()` wasted.
 *
 * It is also the first consumer of the public API, which is what proves the API is
 * usable before the renderer depends on it. Two model bugs during development were
 * found by reading `evaluate()` output by hand and noticing a wrong number; this puts
 * that in front of you continuously instead.
 *
 * ## Why plain DOM rather than ApplicationV2
 *
 * This is a cursor-following chip with no frame, no header, no interaction and no
 * lifecycle worth managing. ApplicationV2 buys nothing here and fights the one thing
 * that matters — following the pointer at frame rate.
 */

import { MODULE_ID, setSettingVisibility } from "../constants.mjs";
import { evaluate } from "../model/evaluate.mjs";
import { TIER, TIER_NAME } from "../model/tiers.mjs";
import { viewerTier } from "../vision/perception.mjs";

export const SETTING_ENABLED = "readoutEnabled";
export const SETTING_DETAIL = "readoutDetail";

/**
 * Whether the readout is the GM's alone.
 *
 * @remarks
 * **World scope, and defaulting on** (Patrick, 2026-08-26). Foundry hides a world-scoped setting
 * from non-GM clients outright (`applications/settings/config.mjs:67`), so the scope does the
 * "GM only" half of the job for free — and defaulting it on is what makes the readout off for
 * players without a second per-user default, which a client setting registered at `init` could
 * not express anyway (`game.user` does not exist yet).
 *
 * The light level *is* information — a player who can read the exact tier under their token
 * knows things their character has to work out — so the GM opting players in is the right
 * direction for the default to point.
 */
export const SETTING_DM_ONLY = "readoutGmOnly";

/** CSS modifier per tier, so the chip can carry a colour cue. */
const TIER_CLASS = {
  [TIER.SUPERNATURAL_DARK]: "supernatural",
  [TIER.DARK]: "dark",
  [TIER.DIM]: "dim",
  [TIER.NORMAL]: "normal",
  [TIER.BRIGHT]: "bright",
};

let element = null;
let hovered = null;
let pointer = { x: 0, y: 0 };
let frame = null;

/**
 * Is the pointer over the scene itself, with nothing on top of it?
 *
 * @remarks
 * The chip used to follow the cursor across sheets, dialogs and the sidebar, reporting the light
 * level at whatever canvas position happened to be underneath (Patrick, 2026-08-26). It is a
 * readout *of the scene* and has no business being drawn over a character sheet.
 *
 * Answered from the `mousemove` target rather than by hit-testing rectangles, which is what
 * makes "with no window in the way" fall out for free: the target **is** the topmost element
 * under the pointer, so anything drawn over the board — a sheet, a menu, a tooltip, the HUD's
 * own buttons — reports itself instead of `#board` and the chip goes away.
 */
let overBoard = false;

const gmOnly = () => {
  try {
    return game.settings.get(MODULE_ID, SETTING_DM_ONLY) === true;
  } catch {
    return true;
  }
};

/**
 * Is the readout this user's to have at all?
 *
 * @remarks
 * **Kept separate from {@link showing}, and the first version's failure to is instructive**
 * (Patrick, 2026-08-26: *"the hotkey just keeps toggling it on and never toggles off"*). One
 * function answering both questions returns `false` for a player under the GM-only switch
 * however their own preference is stored — so `!enabled()` is permanently `true` and the
 * keybinding writes `true` every press. A toggle needs to read *the thing it writes*, and that
 * is never the effective answer when the effective answer has a second term in it.
 */
const available = () => game.user?.isGM === true || !gmOnly();

/** The client's own preference, whatever the GM has allowed. What the keybinding toggles. */
const showing = () => {
  try {
    return game.settings.get(MODULE_ID, SETTING_ENABLED) === true;
  } catch {
    return false;
  }
};

/** Should the chip be on screen right now? */
const enabled = () => available() && showing();

/* -------------------------------------------- */
/*  Token names                                 */
/* -------------------------------------------- */

/**
 * The name to show for a hovered token, never leaking what this user should not see.
 *
 * @remarks
 * **The chip is the module's only player-facing surface that prints a token's name**, so it is
 * the only place this can leak from — the probes and the overlay are console tools and the
 * canvas nameplate is already substituted by the randomizer itself.
 *
 * Two layers, in order, because they answer different questions:
 *
 * 1. **`pf1-token-randomizer`'s obscured name**, if that module is present and its gate applies.
 *    A DM authors a replacement name on a token and the module shows it to anyone below
 *    Observer; a feature that prints `token.name` instead hands back the real one. Routed
 *    through its own `shouldObscure`/`getObscuredName` rather than re-reading the flags, so the
 *    policy lives in one place and cannot drift — the module's own comment asks for exactly
 *    that.
 * 2. **Foundry's native nameplate visibility**, which applies with or without that module. A
 *    token whose nameplate is hidden from a player is not a token whose name should appear in a
 *    tooltip six inches away.
 *
 * **A soft tie-in and nothing more.** No manifest relationship, no notification, no check at
 * startup: the module is looked up per call and its absence is simply the first layer not
 * applying. `tr?.active` matters as well as `tr?.api` — an installed-but-disabled module keeps
 * its entry in `game.modules` and, since the API is assigned at its own `setup`, would have no
 * `api` to call anyway.
 *
 * @param {Token} token - The placeable, not the document
 * @returns {string}
 */
function tokenLabel(token) {
  const doc = token?.document;
  if (!doc) return "";

  const tr = game.modules.get("pf1-token-randomizer");
  if (tr?.active && tr.api?.shouldObscure?.(doc)) {
    return tr.api.getObscuredName?.(doc) || "???";
  }

  if (game.user.isGM) return doc.name;
  if (doc.actor?.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.LIMITED)) {
    return doc.name;
  }
  // `HOVER` and `ALWAYS` are the two modes that show the plate to everyone; the owner-only and
  // control-only modes are the ones worth hiding a name for.
  const shownToAll = [CONST.TOKEN_DISPLAY_MODES.HOVER, CONST.TOKEN_DISPLAY_MODES.ALWAYS];
  return shownToAll.includes(doc.displayName) ? doc.name : "???";
}

/**
 * @remarks
 * **GM-gated in the feature as well as in the menu.** The world scope already hides the control
 * from players; this makes it impossible for the explanation to reach one even when the GM has
 * shared the readout. The *why* — "reduced from normal", "darkness cancelled by daylight" — is
 * a statement about causes the character has no way to know, which is a different thing from
 * the level itself.
 */
const detailed = () => {
  try {
    if (!game.user?.isGM) return false;
    return game.settings.get(MODULE_ID, SETTING_DETAIL) === true;
  } catch {
    return false;
  }
};

/* -------------------------------------------- */
/*  Sampling                                    */
/* -------------------------------------------- */

/**
 * Light level for a token, sampled across its footprint.
 *
 * @remarks
 * A large token does not occupy a point. Sampling only the centre gives the wrong answer
 * for anything bigger than 1×1 straddling a light's edge, so we take the centre plus four
 * quarter-offset points and keep the **brightest**.
 *
 * Brightest rather than average or darkest because the question this readout usually
 * serves is "can it be seen" — being lit anywhere is what matters, and it is the
 * conservative answer for the creature trying to hide.
 */
function evaluateToken(token) {
  const centre = token.center;
  const elevation = token.document.elevation ?? 0;
  const dx = (token.document.width * canvas.grid.size) / 4;
  const dy = (token.document.height * canvas.grid.size) / 4;

  const points = [
    centre,
    { x: centre.x - dx, y: centre.y - dy },
    { x: centre.x + dx, y: centre.y - dy },
    { x: centre.x - dx, y: centre.y + dy },
    { x: centre.x + dx, y: centre.y + dy },
  ];

  let best = null;
  let at = centre;
  for (const point of points) {
    const result = evaluate({ x: point.x, y: point.y, elevation });
    if (!best || result.B > best.B) {
      best = result;
      at = point;
    }
    if (best.tier === TIER.BRIGHT) break; // nothing can beat it
  }
  // The winning sample carried out, so the umbra clamp is applied at the same place the
  // brightness was measured rather than at the centre.
  return { ...best, point: { x: at.x, y: at.y, elevation } };
}

/* -------------------------------------------- */
/*  Rendering                                   */
/* -------------------------------------------- */

/**
 * The explanatory half of the chip.
 *
 * Deliberately says nothing when nothing happened. A suppressor that is merely *present*
 * is not news; one that changed the answer is.
 */
function reasonFor(result) {
  if (result.negated?.length) {
    return `${result.negated.length > 1 ? "darkness effects" : "darkness"} cancelled by daylight`;
  }
  if (!result.winner) return null;
  if (!result.applied) return "darkness present, no effect";
  if (result.baselineTier > result.tier) {
    return `reduced from ${TIER_NAME[result.baselineTier].toLowerCase()}`;
  }
  return "suppressed";
}

function update() {
  frame = null;
  if (!element) return;

  // `hovered` is allowed through without `overBoard`, because a token can only be hovered while
  // the pointer is on the board and `hoverToken(false)` fires before it can be anywhere else.
  if (!enabled() || !canvas?.ready || (!overBoard && !hovered)) {
    element.style.display = "none";
    return;
  }

  let result;
  let label = null;
  if (hovered) {
    result = evaluateToken(hovered);
    label = tokenLabel(hovered);
  } else {
    const point = canvas.mousePosition;
    if (!point) {
      element.style.display = "none";
      return;
    }
    result = { ...evaluate({ x: point.x, y: point.y, elevation: 0 }), point: { ...point, elevation: 0 } };
  }

  // **The readout is a view, so it reports what the view sees.** `evaluate()` is god's eye and
  // has no observer, so it cannot know that a *darkness* lies between the selected token and
  // this point (§4.3) — which is why the chip went on calling a lit room bright while the
  // screen, correctly, had it shadowed. The model was never wrong; the readout was asking the
  // wrong one of its two questions.
  //
  // `null` means god's eye, where there is no observer and so no clamp — and the raw tier is
  // then the right answer rather than a fallback.
  const seen = viewerTier(result.point);
  const clamped = seen !== null && seen < result.tier ? seen : null;
  const tierShown = clamped ?? result.tier;

  const reason = detailed() ? (clamped !== null ? "seen through darkness" : reasonFor(result)) : null;

  element.className = `pf1-lighting-readout tier-${TIER_CLASS[tierShown] ?? "dark"}`;
  element.innerHTML = "";

  if (label) {
    const name = document.createElement("span");
    name.className = "readout-name";
    name.textContent = label;
    element.append(name);
  }

  const tier = document.createElement("span");
  tier.className = "readout-tier";
  tier.textContent = TIER_NAME[tierShown];
  element.append(tier);

  if (reason) {
    const note = document.createElement("span");
    note.className = "readout-reason";
    note.textContent = reason;
    element.append(note);
  }

  element.style.display = "flex";
  element.style.left = `${pointer.x + 16}px`;
  element.style.top = `${pointer.y + 16}px`;
}

/**
 * Batch DOM work to one write per frame.
 *
 * `evaluate` is 0.0025 ms (§9.7) so the *model* could be queried on every mousemove
 * event without noticing. Layout and paint could not, and mousemove fires well above
 * frame rate.
 */
function schedule() {
  frame ??= requestAnimationFrame(update);
}

/* -------------------------------------------- */
/*  Wiring                                      */
/* -------------------------------------------- */

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTING_ENABLED, {
    name: "Show light level",
    hint:
      "Displays the light level under the cursor, or of a hovered token, as a chip beside the " +
      "pointer. Alt+L toggles it.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => schedule(),
  });

  game.settings.register(MODULE_ID, SETTING_DM_ONLY, {
    name: "Light level is GM only",
    hint:
      "Keeps the readout to the GM. Turn this off to let players see the light level their own " +
      "tokens are standing in; they each still choose whether to show it.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => {
      // A player who may no longer have the readout must not keep a row for it — the switch
      // takes the feature away, so it takes its control surface with it.
      syncVisibility();
      schedule();
    },
  });

  game.settings.register(MODULE_ID, SETTING_DETAIL, {
    name: "Explain the light level",
    hint:
      "Adds why the level is what it is — 'reduced from normal', 'darkness cancelled by " +
      "daylight'. GM only, whoever the readout is shown to.",
    // **World, not client, and the scope is doing two jobs.** It hides the control from players
    // (`applications/settings/config.mjs:67`), and it says what the setting is: whether
    // explanations exist at this table, not whether one GM likes seeing them.
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => schedule(),
  });
}

export function registerKeybindings() {
  game.keybindings.register(MODULE_ID, "toggleReadout", {
    name: "Toggle light level readout",
    hint: "Show or hide the light level chip.",
    // Alt+L matches `pf1-light-level-tooltip`'s binding. Deliberate — this replaces it,
    // and Foundry will fire both if that module is also active and bound the same way.
    editable: [{ key: "KeyL", modifiers: ["Alt"] }],
    onDown: () => {
      // **Not consumed when the readout is not this user's to toggle.** Returning `false` lets
      // the press fall through to any lower-precedence binding — `pf1-light-level-tooltip`
      // binds the same chord — which is a better answer than a notification saying no.
      if (!available()) return false;

      const next = !showing();
      game.settings.set(MODULE_ID, SETTING_ENABLED, next);
      ui.notifications?.info(`PF1 Lighting | Readout ${next ? "shown" : "hidden"}.`);
      return true;
    },
    restricted: false,
    precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL,
  });
}

/**
 * Take the readout's own row away from a user who cannot have the readout.
 *
 * @remarks
 * `SETTING_ENABLED` is client-scoped — it is a personal preference and has to be — so Foundry's
 * own "hide world settings from players" rule does not reach it, and a player under the GM-only
 * switch was left with a control that did nothing (Patrick, 2026-08-26). Re-run whenever the
 * GM's switch changes, not only at `ready`, since it can change while a player is looking at it.
 */
function syncVisibility() {
  setSettingVisibility(SETTING_ENABLED, available());
}

export function registerHooks() {
  Hooks.once("ready", () => {
    element = document.createElement("div");
    element.id = "pf1-lighting-readout";
    element.className = "pf1-lighting-readout";
    element.style.display = "none";
    document.body.append(element);

    const board = () => canvas?.app?.view ?? null;

    window.addEventListener("mousemove", (event) => {
      pointer = { x: event.clientX, y: event.clientY };
      overBoard = !!board() && event.target === board();
      schedule();
    });

    // Leaving the window entirely fires no further `mousemove`, so without this the chip stays
    // wherever it was last drawn.
    document.addEventListener("mouseleave", () => {
      overBoard = false;
      schedule();
    });

    syncVisibility();
  });

  Hooks.on("hoverToken", (token, isHovered) => {
    hovered = isHovered ? token : hovered === token ? null : hovered;
    schedule();
  });

  // The light under a stationary cursor can change without the cursor moving — a lit
  // token walking past, a door opening, dawn breaking. Cheap to cover: `update` is
  // rAF-batched and `evaluate` is 0.0025 ms, so re-running it on these costs nothing.
  Hooks.on("refreshToken", schedule);
  Hooks.on("refreshAmbientLight", schedule);
  Hooks.on("initializeLightSources", schedule);

  // A token can stop being hovered by being deleted or by the canvas going away, neither
  // of which fires `hoverToken`.
  Hooks.on("canvasTearDown", () => {
    hovered = null;
  });
}
