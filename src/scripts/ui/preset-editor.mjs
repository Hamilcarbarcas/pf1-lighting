/**
 * The preset editor — a sub-window off the module settings. DESIGN.md §10.2.
 *
 * `model/presets.mjs` holds PF1's vocabulary: a GM places a deeper darkness, not `level: 3` plus
 * `reduce 2` plus a Supernatural floor, correct and in agreement with each other. This is where that
 * vocabulary stops being the module's and becomes the world's — new entries for whatever a table
 * uses, and the shipped ones retuned to house numbers.
 *
 * **This window is a list, a name and a button** (§10.2.2, 2026-08-30). It used to reimplement most
 * of `AmbientLightConfig`, which bought a second set of labels, a second layout to keep in step, and
 * a table that could hold only the fields somebody had got round to reproducing. *Edit light* now
 * opens the real sheet on an unsaved document — `ui/preset-light-config.mjs` — so editor and sheet
 * are one form by construction rather than by maintenance.
 *
 * The name stays here because a light has no name: there is no field on that sheet to borrow and
 * nowhere honest to put one.
 *
 * What is edited is a working copy. Nothing reaches the setting until Save — including edits made in
 * the light sheet, which writes back through a callback into this copy rather than into the setting.
 * Close without saving discards the lot. That is what a GM assumes without being told, at the cost
 * of one field of state.
 *
 * The key is identity and the label is not. A document records where its numbers came from in
 * `config.preset`, which is history — so renaming a preset keeps its key and the documents
 * referencing it stay attached, while deleting one leaves those documents holding a dead key, which
 * reports as Custom and changes nothing, nothing in the model reading `preset` at all. See §10.2.
 *
 * Editing a preset does not reach back into lights already placed from it: `applyPreset` writes
 * values when it is chosen and nothing re-reads the table afterwards. The one-way sync seen from the
 * far side, and the window says so rather than leaving it to be discovered.
 */

import { MODULE_ID } from "../constants.mjs";
import { t } from "../i18n.mjs";
import { TIER } from "../model/tiers.mjs";
import { edit as editLight } from "./preset-light-config.mjs";
import {
  BUILT_IN,
  SETTING_TABLE,
  newKey,
  resetTable,
  setTable,
  table as presetTable,
} from "../model/presets.mjs";

export const MENU_KEY = "presetEditor";

/* -------------------------------------------- */
/*  Markup                                      */
/* -------------------------------------------- */

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );


/** The one select left in this window: which preset is being edited. */
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

/** A blank entry, so New lands on something that already works. */
const blankPreset = () => ({
  label: t("Presets.New"),
  negative: false,
  config: {
    kind: "mundane",
    level: 0,
    cancelsDarkness: false,
    emitTier: TIER.NORMAL,
    steps: 1,
    cap: TIER.NORMAL,
  },
  // A full appearance, because `model/presets.APPEARANCE` requires every preset to state every
  // field — a new preset omitting them is exactly the entry that would let the previous preset's
  // colour survive being replaced.
  light: {
    bright: 20,
    dim: 40,
    color: null,
    alpha: 0.5,
    attenuation: 0.5,
    animation: { type: null, speed: 5, intensity: 5, reverse: false },
  },
  placement: { rotation: 0, walls: true, vision: false },
});

/* -------------------------------------------- */
/*  The application                             */
/* -------------------------------------------- */

/**
 * @remarks
 * Built by hand rather than through `HandlebarsApplicationMixin`. The module has no `templates/`
 * directory and this would be the only thing in it, so a template would put half of one window's
 * markup in a second file and a second language for the sake of a list and a form. §10.6's settings
 * menu is where that trade changes.
 */
class PresetEditor extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "pf1-lighting-preset-editor",
    tag: "form",
    // `pf1-lighting-rows` is the layout scope this window shares with the fieldset injected into
    // the light sheet, so the two forms cannot drift apart. See `styles/config.css`.
    classes: ["pf1-lighting", "preset-editor", "pf1-lighting-rows"],
    window: {
      title: "PF1LIGHTING.Presets.Title",
      icon: "fa-solid fa-lightbulb",
      contentClasses: ["standard-form"],
      resizable: true,
    },
    position: { width: 520, height: "auto" },
    form: {
      handler: PresetEditor.#onSubmit,
      closeOnSubmit: true,
    },
    actions: {
      create: PresetEditor.#onCreate,
      duplicate: PresetEditor.#onDuplicate,
      remove: PresetEditor.#onRemove,
      reset: PresetEditor.#onReset,
      edit: PresetEditor.#onEdit,
    },
  };

  /** The working copy. Nothing here is stored until Save. */
  #working = foundry.utils.deepClone(presetTable());

  /** @type {string|null} */
  #current = Object.keys(presetTable())[0] ?? null;

  /* -------------------------------------------- */

  /** @override */
  async _renderHTML() {
    const keys = Object.keys(this.#working);
    if (this.#current && !keys.includes(this.#current)) this.#current = keys[0] ?? null;

    const options = keys.map((key) => ({ value: key, label: this.#working[key].label }));
    const preset = this.#current ? this.#working[this.#current] : null;

    return `
<div class="form-group">
  <label>${esc(t("Common.Preset"))}</label>
  <div class="form-fields">
    ${
      options.length
        ? select("__which", options, this.#current)
        : `<select name="__which" disabled><option>${esc(t("Presets.None"))}</option></select>`
    }
    <button type="button" class="icon" data-action="create"
            data-tooltip="${esc(t("Presets.Create"))}"><i class="fa-solid fa-plus"></i></button>
    <button type="button" class="icon" data-action="duplicate"
            data-tooltip="${esc(t("Presets.Duplicate"))}"
            ${preset ? "" : "disabled"}><i class="fa-solid fa-clone"></i></button>
    <button type="button" class="icon" data-action="remove"
            data-tooltip="${esc(t("Presets.Delete"))}"
            ${preset ? "" : "disabled"}><i class="fa-solid fa-trash"></i></button>
  </div>
  <p class="hint">${t("Presets.Which.Hint")}</p>
</div>

<hr>

${
  preset
    ? this.#pane(preset)
    : `<p class="notification info">${esc(t("Presets.NoneYet"))}</p>`
}

<footer class="form-footer">
  <button type="button" data-action="reset">
    <i class="fa-solid fa-rotate-left"></i> ${esc(t("Common.RestoreDefaults"))}</button>
  <button type="submit"><i class="fa-solid fa-save"></i> ${esc(t("Common.Save"))}</button>
</footer>`;
  }

  /* -------------------------------------------- */

  /**
   * The pane for one preset — a name, and a button to the real light sheet.
   *
   * @remarks
   * This used to reimplement most of `AmbientLightConfig`, which meant a second set of labels, a
   * second layout, and a table that could hold only the fields somebody had got round to
   * reproducing. §10.2.2 replaced it with the sheet itself, opened on a document that is never
   * saved (`ui/preset-light-config.mjs`).
   *
   * The name stays here rather than moving into that sheet: a light has no name, so there is no
   * field on it to borrow and nowhere honest to put one.
   */
  #pane(preset) {
    return `
<div class="form-group">
  <label>${esc(t("Presets.Name"))}</label>
  <div class="form-fields">
    <input type="text" name="label" value="${esc(preset.label ?? "")}">
  </div>
</div>

<div class="form-group pf1-lighting-preset-edit">
  <div class="form-fields">
    <button type="button" data-action="edit">
      <i class="fa-solid fa-sliders"></i> ${esc(t("Presets.EditLight"))}</button>
  </div>
  <p class="hint">${t("Presets.EditHint")}</p>
</div>`;
  }


  /* -------------------------------------------- */

  /** @override */
  _replaceHTML(result, content) {
    content.innerHTML = result;
  }

  /**
   * One delegated listener rather than one per control, because the controls come and go with
   * the branch and a per-control listener would have to be re-bound on every re-render.
   *
   * @remarks
   * A stable bound field, removed before it is added. `_onRender` fires on every render and
   * `this.element` survives them, only the content inside being replaced, so an anonymous handler
   * would stack one copy per render and each copy would harvest and re-render — the shape of bug
   * that looks like the window getting slower the longer it is open.
   */
  #onChange = (event) => {
    const name = event.target?.name;
    if (!name) return;

    if (name === "__which") {
      this.#harvest();
      this.#current = event.target.value;
      this.render();
      return;
    }

    // Only the name is left in this window; everything else moved to the light sheet (§10.2.2).
    // Harvest without re-rendering, or the input rebuilds under the GM's cursor on every keystroke.
    this.#harvest();
  };

  /** @override */
  _onRender() {
    this.element.removeEventListener("change", this.#onChange);
    this.element.addEventListener("change", this.#onChange);
  }

  /* -------------------------------------------- */
  /*  Working copy                                */
  /* -------------------------------------------- */

  /**
   * Read the visible pane back into the working copy.
   *
   * @remarks
   * One field. Everything else a preset holds is edited through the light sheet, which writes
   * straight into the working copy via its `onSave` callback (§10.2.2) — so there is nothing else
   * here to read back, and nothing that can be lost by switching preset mid-edit.
   */
  #harvest() {
    if (!this.#current) return;
    const label = this.element.querySelector('[name="label"]')?.value?.trim();
    if (label) this.#working[this.#current].label = label;
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  /**
   * Open the real light sheet on the current preset.
   *
   * @remarks
   * The sheet writes back through `onSave` into the working copy, not into the setting, so an edit
   * is still discarded by closing this window without saving — the rule the rest of the editor has
   * always followed, kept across a window boundary.
   *
   * `#harvest` first, or a name typed and not yet blurred is lost behind the sheet.
   */
  static #onEdit() {
    if (!this.#current) return;
    this.#harvest();
    const key = this.#current;
    const preset = this.#working[key];
    editLight(preset, preset.label, (updated) => {
      this.#working[key] = updated;
      this.render();
    });
  }

  static #onCreate() {
    this.#harvest();
    const preset = blankPreset();
    const key = newKey(preset.label, this.#working);
    this.#working[key] = preset;
    this.#current = key;
    this.render();
  }

  static #onDuplicate() {
    this.#harvest();
    if (!this.#current) return;
    const source = this.#working[this.#current];
    const preset = foundry.utils.deepClone(source);
    preset.label = `${source.label} (copy)`;
    const key = newKey(preset.label, this.#working);
    this.#working[key] = preset;
    this.#current = key;
    this.render();
  }

  static async #onRemove() {
    if (!this.#current) return;
    const label = this.#working[this.#current]?.label ?? this.#current;
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: t("Presets.Remove.Title") },
      content: t("Presets.Remove.Body", { label: esc(label) }),
    });
    if (!ok) return;
    delete this.#working[this.#current];
    this.#current = Object.keys(this.#working)[0] ?? null;
    this.render();
  }

  static async #onReset() {
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: t("Presets.Reset.Title") },
      content: t("Presets.Reset.Body"),
    });
    if (!ok) return;
    await resetTable();
    this.#working = foundry.utils.deepClone(BUILT_IN);
    this.#current = Object.keys(this.#working)[0] ?? null;
    this.render();
  }

  /**
   * @remarks
   * The visible pane is harvested first. `FormDataExtended` would not do it: the fields are typed by
   * hand — `negative` is a select of two words, a darkness's radius is one field standing for two,
   * and `transform` is a nested object whose shape depends on another control — so building the
   * entry is exactly the work {@link #harvest} already does on every change.
   */
  static async #onSubmit() {
    this.#harvest();
    await setTable(this.#working);
    ui.notifications.info(t("Presets.Saved", { count: Object.keys(this.#working).length }));
  }
}

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

export function registerSettings() {
  game.settings.registerMenu(MODULE_ID, MENU_KEY, {
    name: "PF1LIGHTING.Menu.presetEditor.Name",
    label: "PF1LIGHTING.Menu.presetEditor.Label",
    hint: "PF1LIGHTING.Menu.presetEditor.Hint",
    icon: "fa-solid fa-lightbulb",
    type: PresetEditor,
    restricted: true,
  });
}

/** Open it from the console: `game.pf1Lighting.presets.edit()` */
export function open() {
  return new PresetEditor().render({ force: true });
}

/** Which table is in force, and whether it is this world's or the module's. */
export function status() {
  let stored = {};
  try {
    stored = game.settings.get(MODULE_ID, SETTING_TABLE) ?? {};
  } catch {
    /* settings not ready */
  }
  const live = presetTable();
  const report = {
    // `false` means the world has never saved the editor and tracks the module's built-ins.
    customised: Object.keys(stored).length > 0,
    count: Object.keys(live).length,
    presets: Object.entries(live).map(([key, preset]) => ({
      key,
      label: preset.label,
      kind: preset.negative ? "darkness" : "light",
    })),
  };
  console.error(`${MODULE_ID} | lighting presets`, report);
  return report;
}
