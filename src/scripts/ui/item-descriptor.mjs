/**
 * The light descriptor's section on the PF1 item sheet. DESIGN.md §12.7, §12.13 step 8.
 *
 * Injected into the **Advanced** tab, which every relevant PF1 item type has
 * (`templates/items/buff.hbs:53`) and where `ckl-roll-bonuses` and `item-hints` already put their
 * per-item controls, so a GM looks in one place for module settings on an item.
 *
 * PF1's item sheet is still `ItemSheet` — legacy V1 (`applications/item/item-sheet.mjs:20`) — so
 * this is a `renderItemSheet` hook and jQuery, unlike everything else this module injects. Two rules
 * from prior injuries apply and are the reason for the shapes below:
 *
 * - **The de-dup class is this feature's own**, never one shared with another section
 *   (`reference_shared_css_class_dedup_trap`). Removing `.pf1-lighting-*` on render would delete
 *   another feature's panel the day one exists.
 * - **Every selector is scoped**, module CSS being unlayered and outranking core's `@layer`s
 *   (`feedback_css_scope_every_selector`).
 *
 * ## No trigger control
 *
 * The trigger is the item's type: a buff has an active state and nothing else, a lantern is lit and
 * nothing else (`model/descriptor.triggerFor`). It is stored anyway so consumers read one shape, but
 * it is always *written* from the type and never *read back* — see the note in `inject`.
 *
 * ## Why the inputs write flags directly
 *
 * `name="flags.pf1-lighting.emits.preset"` is submitted by `FormDataExtended` like any other field
 * and expanded by PF1's `_updateObject` before it reaches `Item#update`, so the descriptor needs no
 * submit handler of its own. The module id's hyphen is safe: `expandObject` splits on dots.
 */

import { MODULE_ID } from "../constants.mjs";
import { t } from "../i18n.mjs";
import { CUSTOM, presetChoices } from "../model/presets.mjs";
import * as descriptor from "../model/descriptor.mjs";
import { table as lightItemTable } from "../model/light-items.mjs";

/** De-dup marker. Per-feature, never a shared class. */
const MARKER = "pf1-lighting-emits";

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

/**
 * Names worth suggesting for the fuel field.
 *
 * @remarks
 * A fuel entry has to match an item name exactly or it consumes nothing, and typing "Oil (flask)"
 * from memory is precisely the sort of thing that fails silently — the picker greys the lantern out
 * and reports that you are out of oil, which is true of an item nobody holds. The suggestions are
 * the item's own name first (a torch burns torches), then whatever the light-source table already
 * consumes, then the rest of the actor's inventory when there is one.
 */
function fuelSuggestions(item) {
  const names = new Set();
  if (item?.name) names.add(item.name);
  for (const entry of Object.values(lightItemTable())) {
    if (entry?.fuel?.item) names.add(entry.fuel.item);
  }
  for (const sibling of item?.actor?.items ?? []) {
    if (sibling.isPhysical && sibling.name) names.add(sibling.name);
  }
  return [...names];
}

/* -------------------------------------------- */
/*  Markup                                      */
/* -------------------------------------------- */

function presetOptions(selected) {
  // `Custom` means *these numbers came from nowhere in particular*, which is not something to emit.
  return presetChoices()
    .filter((choice) => choice.value !== CUSTOM)
    .map(
      (choice) =>
        `<option value="${esc(choice.value)}"${choice.value === selected ? " selected" : ""}>${esc(choice.label)}</option>`
    )
    .join("");
}

/**
 * The badge shown at the header's right edge while collapsed.
 *
 * @remarks
 * A configured *count* is what the astora sections carry, and it would read `1` here forever. The
 * preset's name is the same one glance for a section that only ever holds one thing, so a collapsed
 * header says **Light · Torch** rather than **Light · 1**.
 */
function badgeFor(stored) {
  if (stored?.enabled !== true || !stored.preset) return "";
  return presetChoices().find((choice) => choice.value === stored.preset)?.label ?? stored.preset;
}

function section(item, { trigger, stored, editable }) {
  const lit = trigger === descriptor.TRIGGER.LIT;
  const enabled = stored?.enabled === true;
  const disabled = editable ? "" : " disabled";
  const listId = `${MARKER}-fuel-${item.id ?? "new"}`;
  const badge = badgeFor(stored);

  const fuelRow = lit
    ? `
    <div class="form-group ${MARKER}-row">
      <label>${esc(t("Emits.Fuel"))}</label>
      <div class="form-fields">
        <input type="text" name="flags.${MODULE_ID}.${descriptor.EMITS_FLAG}.fuel.item"
               value="${esc(stored?.fuel?.item ?? "")}" list="${esc(listId)}" autocomplete="off"
               placeholder="${esc(t("Emits.FuelNone"))}"${disabled}>
        <input type="number" name="flags.${MODULE_ID}.${descriptor.EMITS_FLAG}.fuel.hours"
               value="${stored?.fuel?.hours ?? ""}" min="0" step="0.25"
               placeholder="${esc(t("Emits.FuelHours"))}"${disabled}>
      </div>
      <datalist id="${esc(listId)}">
        ${fuelSuggestions(item).map((name) => `<option value="${esc(name)}"></option>`).join("")}
      </datalist>
      <p class="notes">${esc(t("Emits.FuelHint"))}</p>
    </div>`
    : "";

  // The header is the disclosure control and carries the section's own topical icon — the same
  // bulb as the token HUD button, so the two read as one feature. `p.notes` is core's hint class
  // rather than one of ours: this module is not entitled to an opinion about how a PF1 sheet's hint
  // text looks, and matching the sheet is the whole point of the exercise.
  return `
<div class="${MARKER}${enabled ? "" : ` ${MARKER}-off`}">
  <h3 class="form-header ${MARKER}-header">
    <i class="fa-solid fa-lightbulb" inert></i> ${esc(t("Emits.Header"))}
    <span class="${MARKER}-badge"${badge ? "" : ' style="display:none"'}>${esc(badge)}</span>
  </h3>

  <div class="${MARKER}-body">
    <div class="form-group">
      <label class="checkbox">
        <input type="checkbox" name="flags.${MODULE_ID}.${descriptor.EMITS_FLAG}.enabled"
               ${enabled ? "checked" : ""}${disabled}> ${esc(t("Emits.Enabled"))}
      </label>
      <p class="notes">${esc(t(lit ? "Emits.LitHint" : "Emits.ActiveHint"))}</p>
    </div>

    <div class="form-group ${MARKER}-row">
      <label>${esc(t("Emits.Preset"))}</label>
      <div class="form-fields">
        <select name="flags.${MODULE_ID}.${descriptor.EMITS_FLAG}.preset"${disabled}>
          ${presetOptions(stored?.preset ?? null)}
        </select>
      </div>
      <p class="notes">${esc(t("Emits.PresetHint"))}</p>
    </div>
    ${fuelRow}
  </div>

  <input type="hidden" name="flags.${MODULE_ID}.${descriptor.EMITS_FLAG}.trigger" value="${esc(trigger)}">
</div>`;
}

/* -------------------------------------------- */
/*  Collapse                                    */
/* -------------------------------------------- */

/**
 * Expanded state, for as long as the sheet is open. `${appId}:${key}`.
 *
 * @remarks
 * In memory and never on the document, so opening an item to look at it writes nothing. Reopening
 * re-applies the default, which is *open only if this section is actually configured* — the
 * majority of items configure nothing and should cost one line of the tab rather than a screen of
 * it.
 */
const expandedByApp = new Map();

/**
 * Turn the section's header into its disclosure control.
 *
 * @remarks
 * Deliberately the same interaction and the same cues as `astora-mod`'s collapsible item-sheet
 * sections, which is the established shape on this table's Advanced tabs: the section's own topical
 * icon doubles as the control — full strength open, dimmed closed — so an expanded header looks
 * exactly as it would without the mechanism, and a badge keeps the configured value readable while
 * shut. Reimplemented rather than shared, because a lighting module must not take a dependency on a
 * personal mod; the classes are this module's own and its stylesheet reproduces the same look.
 */
function makeCollapsible(app, root, { key, configured }) {
  const header = root?.querySelector(`.${MARKER}-header`);
  const body = root?.querySelector(`.${MARKER}-body`);
  if (!header || !body) return;

  const memoKey = `${app.appId}:${key}`;
  let expanded = expandedByApp.get(memoKey) ?? !!configured;

  const apply = () => {
    root.classList.toggle(`${MARKER}-collapsed`, !expanded);
    body.style.display = expanded ? "" : "none";
  };
  apply();

  header.addEventListener("click", (event) => {
    // A header may carry its own controls one day; let those win rather than swallowing the click.
    if (event.target.closest("a, button, input, select")) return;
    event.preventDefault();
    expanded = !expanded;
    expandedByApp.set(memoKey, expanded);
    apply();
  });
}

/* -------------------------------------------- */
/*  Injection                                   */
/* -------------------------------------------- */

function inject(app, html) {
  const item = app?.item ?? app?.object;
  // Derived, never the stored value — the same rule `descriptor.read` follows. Both triggers come
  // from the item's type, so a stored one can only be stale, and honouring a leftover `"use"` would
  // draw this section on a spell sheet where it does not belong.
  const stored = descriptor.raw(item);
  const trigger = descriptor.triggerFor(item);
  if (!trigger) return;

  const root = html instanceof HTMLElement ? html : html?.[0];
  const tab = root?.querySelector('.tab[data-tab="advanced"]');
  if (!tab) return;

  for (const stale of tab.querySelectorAll(`.${MARKER}`)) stale.remove();

  // Inside the tab's own column, so the section sits below Flags and Script Calls rather than
  // beside them (`templates/items/parts/item-advanced.hbs:2`).
  const host = tab.querySelector(".flexcol") ?? tab;
  host.insertAdjacentHTML(
    "beforeend",
    section(item, { trigger, stored, editable: app.isEditable !== false })
  );

  const container = host.querySelector(`.${MARKER}`);
  if (!container) return;

  // The dependent rows follow the checkbox immediately rather than waiting for the sheet to come
  // back from a submit — a control that stays visible after being switched off reads as one that did
  // not take. The badge follows the preset for the same reason: it is what the collapsed header
  // says, and it must not describe the state before the last edit.
  const enabledBox = container.querySelector(
    `input[name="flags.${MODULE_ID}.${descriptor.EMITS_FLAG}.enabled"]`
  );
  const presetSelect = container.querySelector(
    `select[name="flags.${MODULE_ID}.${descriptor.EMITS_FLAG}.preset"]`
  );
  const badgeEl = container.querySelector(`.${MARKER}-badge`);

  const refresh = () => {
    const on = enabledBox?.checked === true;
    container.classList.toggle(`${MARKER}-off`, !on);
    if (!badgeEl) return;
    const label = on ? (presetSelect?.selectedOptions?.[0]?.textContent ?? "") : "";
    badgeEl.textContent = label;
    badgeEl.style.display = label ? "" : "none";
  };

  enabledBox?.addEventListener("change", refresh);
  presetSelect?.addEventListener("change", refresh);

  // Collapsed unless this item actually emits something. Most items on an Advanced tab configure
  // nothing here and should cost a line rather than a screen.
  makeCollapsible(app, container, { key: "emits", configured: stored?.enabled === true });
}

/* -------------------------------------------- */

/**
 * Keep a descriptor off every item that never wanted one.
 *
 * @remarks
 * The section injects into **every** physical item and every buff, and a legacy sheet submits every
 * named field it renders. So without this, editing the weight of a rope writes
 * `{enabled: false, preset: "…", trigger: "lit", fuel: {…}}` onto it — a flag on a large fraction of
 * the items in a world, all of it meaning *no*.
 *
 * The test is not "is it enabled" but "has anyone ever said anything here". An item with a stored
 * descriptor keeps it when the box is unchecked, so switching a lantern off and on again does not
 * lose the preset that was chosen for it; an item with none, submitting a `false`, is saying
 * nothing and is left alone.
 *
 * `preUpdateItem` runs only on the client that requested the update and mutating `changes` there is
 * what the hook is for, so the field never reaches the database rather than being cleaned up after.
 */
function stripEmptyDescriptor(item, changes) {
  const flags = changes?.flags?.[MODULE_ID];
  const incoming = flags?.[descriptor.EMITS_FLAG];
  if (!incoming || incoming.enabled === true) return;
  if (descriptor.raw(item)) return;

  delete flags[descriptor.EMITS_FLAG];
  if (!Object.keys(flags).length) delete changes.flags[MODULE_ID];
  if (!Object.keys(changes.flags).length) delete changes.flags;
}

export function registerHooks() {
  Hooks.on("renderItemSheet", (app, html) => {
    try {
      inject(app, html);
    } catch (error) {
      console.error(`${MODULE_ID} | item sheet descriptor injection failed`, error);
    }
  });

  Hooks.on("preUpdateItem", (item, changes) => {
    try {
      stripEmptyDescriptor(item, changes);
    } catch (error) {
      console.error(`${MODULE_ID} | descriptor cleanup failed`, error);
    }
  });

  // Drop a sheet's remembered expansion when it closes, so reopening an item re-applies the
  // "open only if configured" default rather than whatever was last left behind.
  Hooks.on("closeItemSheet", (app) => {
    const prefix = `${app.appId}:`;
    for (const key of expandedByApp.keys()) {
      if (key.startsWith(prefix)) expandedByApp.delete(key);
    }
  });
}
