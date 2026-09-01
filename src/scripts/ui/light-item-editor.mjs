/**
 * The light-source table editor — a sub-window off the module settings. DESIGN.md §12.8.
 *
 * The table says which items give off light, what preset they give off, and what they burn. It ships
 * populated with PF1's core sources at RAW burn times, so a world that never opens this window still
 * gets a torch that lights and a lantern that drinks oil. This is where a world's own kit goes in —
 * a homebrew everburning lamp, a house-ruled burn time, an item named in another language.
 *
 * ## The name is the key, and that is the feature
 *
 * `model/light-items` matches by item name, which torch's own README concedes the cost of: play in
 * another language and you write your own table. That is exactly what this window is for. The item's
 * own descriptor (`model/descriptor`, on its Advanced tab) is the other half — it wins wherever a GM
 * has been specific, and needs no table entry at all. Name matching as a *fallback* costs nothing;
 * name matching as the *only* route was the mistake.
 *
 * ## Held as a list, stored as a map
 *
 * The working copy is an **array** while the window is open, and only becomes the name-keyed object
 * on Save. Editing the key of a keyed object in place means deleting and re-inserting on every
 * keystroke, which reorders the list under the cursor and loses an entry the moment two rows are
 * briefly identical. A list has neither problem, and it makes the duplicate check one pass.
 *
 * Everything else follows `ui/preset-editor.mjs`: a working copy, nothing written until Save, and
 * closing without saving discards the lot.
 */

import { MODULE_ID } from "../constants.mjs";
import { t } from "../i18n.mjs";
import { CUSTOM, presetChoices } from "../model/presets.mjs";
import {
  BUILT_IN_ITEMS,
  SETTING_ITEMS,
  setTable,
  table as itemTable,
} from "../model/light-items.mjs";

export const MENU_KEY = "lightItemEditor";

/**
 * What separates one alias from the next in the editor's text field.
 *
 * @remarks
 * **A semicolon, not a comma** (Hamilcarbarcas, 2026-08-30), and the shipped table is its own
 * proof: `Lamp` is also called *Lamp, common*. Splitting on commas turns that one alias into two
 * useless ones — `Lamp`, which is the entry's own name, and `common`, which is nothing. PF1 names
 * its equipment this way throughout (*Lantern, hooded*; *Lantern, bullseye*), so the comma was
 * never available here.
 *
 * This is the text field's grammar only. The table stores an array, so no saved world is affected
 * and there is nothing to migrate.
 */
const ALIAS_SEPARATOR = ";";

/* -------------------------------------------- */
/*  Markup                                      */
/* -------------------------------------------- */

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

function select(name, options, value) {
  const body = options
    .map(
      (option) =>
        `<option value="${esc(option.value)}"${
          String(option.value) === String(value) ? " selected" : ""
        }>${esc(option.label)}</option>`
    )
    .join("");
  return `<select name="${esc(name)}">${body}</select>`;
}

/**
 * Preset options, with a dead key kept rather than quietly corrected.
 *
 * @remarks
 * An entry naming a preset the world has since deleted would otherwise land on whatever happens to
 * be first in the list, and the harvest would write that back on the next keystroke — a silent
 * change of what an item emits, made by opening a window to look at it. The missing key is offered
 * as its own selected option instead, so the GM is told and decides.
 */
function presetOptions(current) {
  const options = presetChoices().filter((choice) => choice.value !== CUSTOM);
  if (current && !options.some((choice) => choice.value === current)) {
    options.unshift({ value: current, label: t("Items.MissingPreset", { key: current }) });
  }
  return options;
}

/** A blank entry, so New lands on something that already works. */
const blankEntry = () => ({
  name: t("Items.New"),
  aliases: "",
  // The first real preset. `presetChoices` leads with Custom, which means *from nowhere in
  // particular* and is not a thing an item can emit.
  preset: presetChoices().find((choice) => choice.value !== CUSTOM)?.value ?? "",
  fuelItem: "",
  fuelHours: "",
});

/* -------------------------------------------- */
/*  The application                             */
/* -------------------------------------------- */

class LightItemEditor extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "pf1-lighting-light-item-editor",
    tag: "form",
    classes: ["pf1-lighting", "light-item-editor", "pf1-lighting-rows"],
    window: {
      title: "PF1LIGHTING.Items.Title",
      icon: "fa-solid fa-fire",
      contentClasses: ["standard-form"],
      resizable: true,
    },
    position: { width: 560, height: "auto" },
    form: {
      handler: LightItemEditor.#onSubmit,
      // Save validates — two entries cannot share a name — and a refusal has to leave the window
      // open on the offending row. Closed manually on success instead.
      closeOnSubmit: false,
    },
    actions: {
      create: LightItemEditor.#onCreate,
      duplicate: LightItemEditor.#onDuplicate,
      remove: LightItemEditor.#onRemove,
      reset: LightItemEditor.#onReset,
    },
  };

  /** The working copy, as a list. Nothing here is stored until Save. */
  #working = LightItemEditor.#toList(itemTable());

  /** Index into {@link #working}, not a key — the name is editable and cannot address a row. */
  #current = 0;

  /* -------------------------------------------- */
  /*  Shape conversion                            */
  /* -------------------------------------------- */

  /** The stored map, as the flat rows this window edits. */
  static #toList(table) {
    return Object.entries(table ?? {}).map(([name, entry]) => ({
      name,
      aliases: (entry.aliases ?? []).join(`${ALIAS_SEPARATOR} `),
      preset: entry.preset ?? "",
      fuelItem: entry.fuel?.item ?? "",
      fuelHours: entry.fuel?.hours ?? "",
    }));
  }

  /**
   * The rows, back as the stored map.
   *
   * @remarks
   * A fuel entry needs **both** halves to mean anything: an item with no duration would consume
   * forever, a duration with no item names nothing to consume. Either way the answer is *this
   * source has no fuel*, which is what an everburning torch is and a legitimate thing to be — the
   * same normalisation `model/descriptor` applies to the sheet's version of these fields.
   */
  static #toTable(rows) {
    const table = {};
    for (const row of rows) {
      const name = row.name?.trim();
      if (!name || !row.preset) continue;

      const aliases = String(row.aliases ?? "")
        .split(ALIAS_SEPARATOR)
        .map((alias) => alias.trim())
        .filter(Boolean);

      const fuelItem = String(row.fuelItem ?? "").trim();
      const fuelHours = Number(row.fuelHours);

      table[name] = {
        preset: row.preset,
        ...(aliases.length ? { aliases } : {}),
        ...(fuelItem && fuelHours > 0 ? { fuel: { item: fuelItem, hours: fuelHours } } : {}),
      };
    }
    return table;
  }

  /* -------------------------------------------- */

  /** @override */
  async _renderHTML() {
    if (this.#current >= this.#working.length) this.#current = this.#working.length - 1;
    if (this.#current < 0) this.#current = 0;

    const options = this.#working.map((row, index) => ({
      value: String(index),
      label: row.name?.trim() || t("Items.Unnamed"),
    }));
    const row = this.#working[this.#current] ?? null;

    return `
<div class="form-group">
  <label>${esc(t("Items.Which"))}</label>
  <div class="form-fields">
    ${
      options.length
        ? select("__which", options, String(this.#current))
        : `<select name="__which" disabled><option>${esc(t("Items.None"))}</option></select>`
    }
    <button type="button" class="icon" data-action="create"
            data-tooltip="${esc(t("Items.Create"))}"><i class="fa-solid fa-plus"></i></button>
    <button type="button" class="icon" data-action="duplicate"
            data-tooltip="${esc(t("Presets.Duplicate"))}"
            ${row ? "" : "disabled"}><i class="fa-solid fa-clone"></i></button>
    <button type="button" class="icon" data-action="remove"
            data-tooltip="${esc(t("Presets.Delete"))}"
            ${row ? "" : "disabled"}><i class="fa-solid fa-trash"></i></button>
  </div>
  <p class="hint">${t("Items.WhichHint")}</p>
</div>

<hr>

${row ? this.#pane(row) : `<p class="notification info">${esc(t("Items.NoneYet"))}</p>`}

<footer class="form-footer">
  <button type="button" data-action="reset">
    <i class="fa-solid fa-rotate-left"></i> ${esc(t("Common.RestoreDefaults"))}</button>
  <button type="submit"><i class="fa-solid fa-save"></i> ${esc(t("Common.Save"))}</button>
</footer>`;
  }

  /* -------------------------------------------- */

  /** The pane for one entry: what it is called, what it emits, and what it burns. */
  #pane(row) {
    const listId = "pf1-lighting-item-fuel-list";
    const suggestions = new Set([row.name?.trim()].filter(Boolean));
    for (const other of this.#working) if (other.fuelItem?.trim()) suggestions.add(other.fuelItem.trim());

    return `
<div class="form-group">
  <label>${esc(t("Items.Name"))}</label>
  <div class="form-fields">
    <input type="text" name="name" value="${esc(row.name ?? "")}" autocomplete="off">
  </div>
  <p class="hint">${t("Items.NameHint")}</p>
</div>

<div class="form-group">
  <label>${esc(t("Items.Aliases"))}</label>
  <div class="form-fields">
    <input type="text" name="aliases" value="${esc(row.aliases ?? "")}" autocomplete="off">
  </div>
  <p class="hint">${t("Items.AliasesHint")}</p>
</div>

<div class="form-group">
  <label>${esc(t("Emits.Preset"))}</label>
  <div class="form-fields">
    ${select("preset", presetOptions(row.preset), row.preset)}
  </div>
</div>

<div class="form-group">
  <label>${esc(t("Emits.Fuel"))}</label>
  <div class="form-fields">
    <input type="text" name="fuelItem" value="${esc(row.fuelItem ?? "")}" list="${listId}"
           autocomplete="off" placeholder="${esc(t("Emits.FuelNone"))}">
    <input type="number" name="fuelHours" value="${row.fuelHours ?? ""}" min="0" step="0.25"
           placeholder="${esc(t("Emits.FuelHours"))}">
  </div>
  <datalist id="${listId}">
    ${[...suggestions].map((name) => `<option value="${esc(name)}"></option>`).join("")}
  </datalist>
  <p class="hint">${t("Emits.FuelHint")}</p>
</div>`;
  }

  /* -------------------------------------------- */

  /** @override */
  _replaceHTML(result, content) {
    content.innerHTML = result;
  }

  /**
   * One delegated listener, for `ui/preset-editor.mjs`'s reason: the controls come and go with the
   * selected row, and a per-control listener would need re-binding on every render. A stable bound
   * field removed before it is added, or `_onRender` stacks a copy per render.
   */
  #onChange = (event) => {
    const name = event.target?.name;
    if (!name) return;

    if (name === "__which") {
      this.#harvest();
      this.#current = Number(event.target.value) || 0;
      this.render();
      return;
    }

    this.#harvest();

    // The name is what the select shows, so it has to re-render — but only on the name, and only on
    // `change`, which fires at blur. Re-rendering per keystroke would rebuild the input under the
    // cursor.
    if (name === "name") this.render();
  };

  /** @override */
  _onRender() {
    this.element.removeEventListener("change", this.#onChange);
    this.element.addEventListener("change", this.#onChange);
  }

  /* -------------------------------------------- */
  /*  Working copy                                */
  /* -------------------------------------------- */

  /** Read the visible pane back into the working copy. */
  #harvest() {
    const row = this.#working[this.#current];
    if (!row) return;
    const read = (field) => this.element.querySelector(`[name="${field}"]`)?.value ?? "";
    row.name = read("name");
    row.aliases = read("aliases");
    row.preset = read("preset");
    row.fuelItem = read("fuelItem");
    row.fuelHours = read("fuelHours");
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  static #onCreate() {
    this.#harvest();
    this.#working.push(blankEntry());
    this.#current = this.#working.length - 1;
    this.render();
  }

  static #onDuplicate() {
    this.#harvest();
    const source = this.#working[this.#current];
    if (!source) return;
    const copy = { ...source, name: `${source.name} (copy)` };
    this.#working.splice(this.#current + 1, 0, copy);
    this.#current += 1;
    this.render();
  }

  static async #onRemove() {
    const row = this.#working[this.#current];
    if (!row) return;
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: t("Items.Remove.Title") },
      content: t("Items.Remove.Body", { label: esc(row.name?.trim() || t("Items.Unnamed")) }),
    });
    if (!ok) return;
    this.#working.splice(this.#current, 1);
    this.render();
  }

  static async #onReset() {
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: t("Items.Reset.Title") },
      content: t("Items.Reset.Body"),
    });
    if (!ok) return;
    await setTable({});
    this.#working = LightItemEditor.#toList(BUILT_IN_ITEMS);
    this.#current = 0;
    this.render();
  }

  /**
   * @remarks
   * Two entries with the same name is the one thing a keyed table cannot express, and the failure is
   * silent: the second simply replaces the first, so a GM's edit disappears with no message. Refused
   * here, naming the duplicate — and the window stays open, which is why `closeOnSubmit` is off.
   *
   * A row with no name or no preset is dropped rather than refused. That is a *New light source*
   * somebody added and thought better of, not a mistake to argue with, and it names nothing so it
   * can collide with nothing.
   */
  static async #onSubmit() {
    this.#harvest();

    const seen = new Set();
    for (const row of this.#working) {
      const name = row.name?.trim().toLowerCase();
      if (!name) continue;
      if (seen.has(name)) {
        ui.notifications.warn(t("Items.Duplicate", { name: row.name.trim() }));
        return;
      }
      seen.add(name);
    }

    const table = LightItemEditor.#toTable(this.#working);
    await setTable(table);
    ui.notifications.info(t("Items.Saved", { count: Object.keys(table).length }));
    this.close();
  }
}

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

export function registerSettings() {
  game.settings.registerMenu(MODULE_ID, MENU_KEY, {
    name: "PF1LIGHTING.Menu.lightItemEditor.Name",
    label: "PF1LIGHTING.Menu.lightItemEditor.Label",
    hint: "PF1LIGHTING.Menu.lightItemEditor.Hint",
    icon: "fa-solid fa-fire",
    type: LightItemEditor,
    restricted: true,
  });
}

/** Open it from the console: `game.pf1Lighting.lightItems.edit()` */
export function open() {
  return new LightItemEditor().render({ force: true });
}

/** Which table is in force, and whether it is this world's or the module's. */
export function status() {
  let stored = {};
  try {
    stored = game.settings.get(MODULE_ID, SETTING_ITEMS) ?? {};
  } catch {
    /* settings not ready */
  }
  const live = itemTable();
  const report = {
    // `false` means the world has never saved the editor and tracks the module's built-ins.
    customised: Object.keys(stored).length > 0,
    count: Object.keys(live).length,
    items: Object.entries(live).map(([name, entry]) => ({
      name,
      preset: entry.preset,
      fuel: entry.fuel ? `${entry.fuel.item} / ${entry.fuel.hours}h` : "none",
      aliases: entry.aliases ?? [],
    })),
  };
  console.error(`${MODULE_ID} | light source table`, report);
  return report;
}
