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

import { MODULE_ID } from "../constants.mjs";
import { evaluate } from "../model/evaluate.mjs";
import { TIER, TIER_NAME } from "../model/tiers.mjs";

export const SETTING_ENABLED = "readoutEnabled";
export const SETTING_DETAIL = "readoutDetail";

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

const enabled = () => {
  try {
    return game.settings.get(MODULE_ID, SETTING_ENABLED) === true;
  } catch {
    return false;
  }
};

const detailed = () => {
  try {
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
  for (const point of points) {
    const result = evaluate({ x: point.x, y: point.y, elevation });
    if (!best || result.B > best.B) best = result;
    if (best.tier === TIER.BRIGHT) break; // nothing can beat it
  }
  return best;
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

  if (!enabled() || !canvas?.ready) {
    element.style.display = "none";
    return;
  }

  let result;
  let label = null;
  if (hovered) {
    result = evaluateToken(hovered);
    label = hovered.name;
  } else {
    const point = canvas.mousePosition;
    if (!point) {
      element.style.display = "none";
      return;
    }
    result = evaluate({ x: point.x, y: point.y, elevation: 0 });
  }

  const reason = detailed() ? reasonFor(result) : null;

  element.className = `pf1-lighting-readout tier-${TIER_CLASS[result.tier] ?? "dark"}`;
  element.innerHTML = "";

  if (label) {
    const name = document.createElement("span");
    name.className = "readout-name";
    name.textContent = label;
    element.append(name);
  }

  const tier = document.createElement("span");
  tier.className = "readout-tier";
  tier.textContent = result.tierName;
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
    name: "Show light level readout",
    hint: "Displays the light level under the cursor, or of a hovered token, as a chip beside the pointer.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => schedule(),
  });

  game.settings.register(MODULE_ID, SETTING_DETAIL, {
    name: "Explain the light level",
    hint: "Adds why the level is what it is — for example 'reduced from normal' where a darkness effect applies.",
    scope: "client",
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
      const next = !enabled();
      game.settings.set(MODULE_ID, SETTING_ENABLED, next);
      ui.notifications?.info(`PF1 Lighting | Readout ${next ? "shown" : "hidden"}.`);
      return true;
    },
    restricted: false,
    precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL,
  });
}

export function registerHooks() {
  Hooks.once("ready", () => {
    element = document.createElement("div");
    element.id = "pf1-lighting-readout";
    element.className = "pf1-lighting-readout";
    element.style.display = "none";
    document.body.append(element);

    window.addEventListener("mousemove", (event) => {
      pointer = { x: event.clientX, y: event.clientY };
      schedule();
    });
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
