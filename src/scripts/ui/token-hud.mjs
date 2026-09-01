/**
 * The Token HUD light button. DESIGN.md §12.9, §12.13 step 6.
 *
 * One button on a token, in the place torch's has always been. Click toggles the light off, or
 * opens the picker when there is none; right-click opens the picker regardless, so a light can be
 * swapped without being turned off first.
 *
 * ## The GM half, and why it lands first
 *
 * This is §12.1's original problem answered with no scripting at all: **select a trap, a vehicle or
 * an enemy's token, choose *Darkness*, done.** No buff — those actor types have no buff tab — no
 * item, no macro. It reaches further than the trigger it was meant to precede, which is why §12.13
 * moved it ahead of the item descriptor.
 *
 * The player half is step 7 and is a different question: which of the light sources *on this actor*
 * may be lit, and what burning one costs. That needs §12.8's item table, so the picker is GM-only
 * until it exists rather than showing players a list they have no claim to.
 *
 * ## Why the effect carries no `source`
 *
 * A HUD light is nobody's: no buff owns it, no item owns it, and it should outlive everything except
 * someone turning it off. §12.5.2's reaper only collects records whose `source` no longer resolves
 * and never touches a record without one, so omitting it is exactly the opt-out this needs — the
 * same opt-out the API documents for a caller who wants an effect to persist.
 *
 * The fixed {@link HUD_ID} is what makes the toggle work: applying the same id replaces rather than
 * stacks, so a second choice from the picker swaps the light instead of lighting two.
 */

import { MODULE_ID } from "../constants.mjs";
import { t } from "../i18n.mjs";
import { CUSTOM, presetChoices } from "../model/presets.mjs";
import * as companion from "../model/companion.mjs";
import * as lightItems from "../model/light-items.mjs";

/** De-dup marker. Per-feature, never a shared class — `reference_shared_css_class_dedup_trap`. */
const MARKER = "pf1-lighting-hud";

/**
 * The record id every HUD-lit effect uses.
 *
 * @remarks
 * Fixed rather than generated, and that is the whole toggle. `apply` replaces a record of the same
 * id (`model/companion.applyOnAnchor`), so picking a second preset swaps the light; `clear` with
 * this id puts it out. A token can still carry other effects from buffs or the API alongside it, and
 * the button neither sees nor disturbs them.
 */
export const HUD_ID = "hud";

/** Is this token carrying a HUD-lit light right now? */
const litBy = (doc) => companion.list(doc).find((record) => record.id === HUD_ID) ?? null;

/* -------------------------------------------- */
/*  Markup                                      */
/* -------------------------------------------- */

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

function button(lit) {
  return `
<button type="button" class="control-icon ${MARKER}${lit ? " active" : ""}"
        data-action="pf1LightingToggle" data-tooltip="${esc(t("Hud.Tooltip"))}">
  <i class="fa-solid fa-lightbulb" inert></i>
</button>`;
}

/**
 * The light sources an actor is carrying.
 *
 * @remarks
 * Exhausted entries are shown and disabled rather than omitted. A picker that silently drops the
 * lantern a player is holding reads as a bug in the picker; one that shows it greyed says *you are
 * out of oil*, which is the information they actually wanted.
 */
function carriedRows(actor, current) {
  return lightItems
    .carriedBy(actor)
    .map(({ item, entry, supply, exhausted }) => {
      const count = Number.isFinite(supply) ? ` (${supply})` : "";
      return `
    <a class="${MARKER}-choice${item.id === current ? " active" : ""}${exhausted ? " disabled" : ""}"
       ${exhausted ? "" : `data-action="pf1LightingPick" data-item="${esc(item.id)}"`}>
      <img class="${MARKER}-icon" src="${esc(item.img)}"><span>${esc(entry.name)}${esc(count)}</span>
    </a>`;
    })
    .join("");
}

/**
 * Every preset, for a GM.
 *
 * @remarks
 * `.palette` is core's own class and carries its positioning and its hidden/visible states
 * (`foundry2.css:8093-8121`), so this is styled by being in the left column rather than by anything
 * of ours. `Custom` is filtered out: it means *these numbers came from nowhere in particular*, which
 * is not a thing to light a token with.
 */
function paletteRows(current) {
  return presetChoices()
    .filter((choice) => choice.value !== CUSTOM)
    .map(
      (choice) => `
    <a class="${MARKER}-choice${choice.value === current ? " active" : ""}"
       data-action="pf1LightingPick" data-preset="${esc(choice.value)}">
      <span>${esc(choice.label)}</span>
    </a>`
    )
    .join("");
}

/* -------------------------------------------- */
/*  Injection                                   */
/* -------------------------------------------- */

/**
 * @param {object} hud - The `TokenHUD` application
 * @param {HTMLElement} html
 */
function inject(hud, html) {
  const doc = hud.object?.document;
  if (!doc) return;

  // Two audiences, one button (§12.9). A GM picks any preset outright, ignoring inventory and fuel,
  // which is what makes a trap or a vehicle a one-click job. A player picks from what their actor is
  // actually carrying, and burning it costs them.
  const isGM = game.user.isGM;
  const carried = lightItems.carriedBy(doc.actor);
  // Nothing to offer and no authority to invent one: no button at all, rather than one that opens an
  // empty list. A GM always has the override, so this only ever silences a player.
  if (!isGM && !carried.length) return;

  const column = html.querySelector(".col.left");
  if (!column) return;
  // The HUD element is reused between tokens, so a stale button can outlive its render.
  for (const stale of html.querySelectorAll(`.${MARKER}, .${MARKER}-palette`)) stale.remove();

  const record = litBy(doc);

  // Both audiences see the same list — what this actor is carrying — because a GM playing an NPC
  // wants exactly what a player wants (Hamilcarbarcas, 2026-08-30). The GM additionally gets one row
  // above it that opens the full preset list, which is the override: light anything, ignoring
  // inventory and fuel entirely. That is the trap-and-vehicle case, kept as a deliberate step off
  // the ordinary path rather than as the ordinary path itself.
  const override = isGM
    ? `<a class="${MARKER}-choice ${MARKER}-override" data-action="pf1LightingOverride">
         <i class="fa-solid fa-wand-sparkles"></i><span>${esc(t("Hud.Override"))}</span></a>`
    : "";

  // **Exactly one `.palette`, and it is the button's next sibling.** The two lists used to be two
  // elements, which was cheaper to toggle and wrong: `astora-mod/hud-overflow` relocates a button
  // together with *the `.palette` that is its next sibling*, so the second panel would have been
  // left behind in the left column, opening beside nothing. One element that swaps its contents
  // keeps the button-and-panel pair the single adjacent thing that heuristic can see.
  //
  // Swapping `innerHTML` costs nothing here and rebinds nothing: the handlers live on
  // `hud.options.actions` and are dispatched by `data-action` from the application root, so new rows
  // are live the moment they exist.
  const carriedList = `${override}${carriedRows(doc.actor, record?.fuel?.itemId ?? null)}`;
  const presetList = isGM ? paletteRows(record?.preset ?? null) : "";

  column.insertAdjacentHTML(
    "afterbegin",
    `${button(!!record)}<div class="palette ${MARKER}-palette"></div>`
  );

  const buttonEl = column.querySelector(`.${MARKER}`);
  const paletteEl = column.querySelector(`.${MARKER}-palette`);
  if (paletteEl) paletteEl.innerHTML = carriedList;

  /**
   * Line a panel's top up with the button, and let it grow downwards.
   *
   * @remarks
   * Core positions `.palette` horizontally and says nothing about the vertical, so a panel lands at
   * whatever its static position happens to be — which drifts as the column's contents change,
   * `#token-hud .col.left` being `justify-content: center`. Aligning to the button is the thing a
   * reader expects and it cannot be written as a fixed offset for that reason.
   *
   * Both elements share a containing block — `.col` is `position: absolute` — so `offsetTop` and
   * `top` are in the same coordinates and no arithmetic about the page is needed.
   *
   * **The flip.** `#token-hud .col` runs from 50px above the token to 50px below it, so the token's
   * own bottom edge is `clientHeight - 50`. A list long enough to pass that would run into the
   * health bars and the quick-action row beneath, so it is shifted up until its bottom sits on that
   * line — clamped at the column's top, since a list taller than the whole column has nowhere to go
   * and is better cut off below than started off-screen above.
   *
   * Measured while hidden, which works: `.palette` is `visibility: hidden`, not `display: none`, so
   * it has a box. That is what avoids positioning it after it is already visible, which would show
   * as a jump.
   */
  const place = (panel) => {
    if (!panel || !buttonEl) return;

    // **Stand down once the button has been relocated.** `astora-mod/hud-overflow` moves overflowing
    // controls out of `.col.left` into a block above the token, and positions their panels from its
    // own stylesheet (`bottom: calc(100% + 8px); top: auto`). Two things break if this keeps going:
    //
    //  - *Inline styles win.* `top` and `bottom` written here beat that rule outright, so this
    //    module's arithmetic would silently override the layout of a module that owns the container.
    //  - *Mixed coordinate spaces.* `buttonEl.offsetTop` would then be relative to the block, while
    //    `limit` still comes from the captured `.col.left`. The two numbers stop describing the same
    //    space and the result is arbitrary rather than merely wrong.
    //
    // So: bail, and **clear what a previous open may have written**, or a stale inline `top` from
    // when the button was still in the column would outlive the move. Diagnosed by Hamilcarbarcas,
    // 2026-08-30, from the other side of the fence.
    if (buttonEl.closest(".col.left") !== column) {
      panel.style.top = "";
      panel.style.bottom = "";
      return;
    }

    panel.style.bottom = "auto";

    const height = panel.offsetHeight;
    // The token's own bottom edge: `#token-hud .col` runs 50px above the token to 50px below it, so
    // anything past this would sit over the health bars and the quick-action row.
    const limit = column.clientHeight - 50;
    let top = buttonEl.offsetTop;
    if (top + height > limit) top = limit - height;

    // Rise as far as it needs to and no further than the screen. The earlier version clamped at the
    // column's own top, which for the eleven-entry preset list meant "give up and overflow
    // downwards" — the one outcome the flip exists to avoid (reported 2026-08-30). There is open
    // canvas above a token and nothing to collide with there, so the only real bound is the viewport.
    const minTop = 8 - column.getBoundingClientRect().top;
    panel.style.top = `${Math.max(minTop, top)}px`;
  };

  const isOpen = () => paletteEl?.classList.contains("active") === true;

  const showPalette = (visible) => {
    if (!paletteEl) return;
    // Reopening always starts on the carried list rather than wherever it was left.
    if (visible) {
      paletteEl.innerHTML = carriedList;
      place(paletteEl);
    }
    paletteEl.classList.toggle("active", visible);
  };

  // v13 dispatches HUD buttons by `data-action` from the application root, so the handler is
  // registered on the application rather than bound to the node — the pattern torch uses and the
  // one that survives the node being moved by an overflow handler (`reference_token_hud_layout`).
  hud.options.actions.pf1LightingToggle = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const lit = litBy(doc);
    if (lit) {
      // Through `douse`, not `clear`: it banks how far into the current unit of fuel this got, which
      // is the only place that remainder is ever written (§12.8).
      await lightItems.douse(doc, lit);
      buttonEl?.classList.remove("active");
      showPalette(false);
      return;
    }
    // Either panel counts as open. Testing only the carried list meant clicking the button while
    // the preset list was showing opened the carried one *behind* it — two panels, one of them
    // unreachable (reported 2026-08-30).
    showPalette(!isOpen());
  };

  hud.options.actions.pf1LightingOverride = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!paletteEl) return;
    paletteEl.innerHTML = presetList;
    // Re-placed, not left where the carried list sat: the preset list is much the longer of the two
    // and may need the flip where the other did not.
    place(paletteEl);
    paletteEl.classList.add("active");
  };

  hud.options.actions.pf1LightingPick = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    showPalette(false);

    const itemId = event.target?.closest("[data-item]")?.dataset?.item;
    if (itemId) {
      const item = doc.actor?.items?.get(itemId);
      const entry = item ? lightItems.resolve(item) : null;
      if (!entry) return;
      const applied = await companion.apply(doc, {
        id: HUD_ID,
        preset: entry.preset,
        label: entry.name,
        // A descriptor may override the preset's own numbers (`model/descriptor`); a table entry
        // carries none and these are empty. Passed through rather than resolved here, so the sheet
        // is the only place that decides what an item's light looks like.
        light: entry.light,
        config: entry.config,
        // `itemId` is what the burn clock looks the light item up by, so a rename cannot lose the
        // part-burnt remainder recorded on it (`model/light-items.douse`).
        fuel: entry.fuel ? { ...entry.fuel, consumed: 0, itemId: item.id } : undefined,
      });
      buttonEl?.classList.toggle("active", !!applied);
      return;
    }

    const preset = event.target?.closest("[data-preset]")?.dataset?.preset;
    if (!preset) return;
    const applied = await companion.apply(doc, {
      id: HUD_ID,
      preset,
      label: presetChoices().find((choice) => choice.value === preset)?.label ?? preset,
    });
    buttonEl?.classList.toggle("active", !!applied);
  };

  // Right-click opens the picker whether or not something is lit, so a light can be swapped without
  // being put out first. Bound to the node: `contextmenu` is not one of the events core delegates.
  buttonEl?.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    showPalette(!isOpen());
  });
}

/* -------------------------------------------- */

export function registerHooks() {
  Hooks.on("renderTokenHUD", (hud, html) => {
    try {
      inject(hud, html instanceof HTMLElement ? html : html?.[0]);
    } catch (error) {
      console.error(`${MODULE_ID} | token HUD injection failed`, error);
    }
  });
}
