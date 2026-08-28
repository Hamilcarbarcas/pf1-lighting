/**
 * The preset editor — a sub-window off the module settings. DESIGN.md §10.2.
 *
 * `model/presets.mjs` holds PF1's vocabulary: a GM places a *deeper darkness*, not `level: 3`
 * plus `reduce 2` plus a Supernatural floor, correct and in agreement with each other. This is
 * where that vocabulary stops being the module's and becomes the world's — new entries for
 * whatever a table actually uses, and the shipped ones retuned to house numbers.
 *
 * ## One preset at a time, not all of them at once
 *
 * A preset has two mutually exclusive halves, and rendering every entry's fields down one page
 * means rendering both halves of each — twelve fields per row, most of them inapplicable. So the
 * window edits **one** preset, chosen from a select, with the same branch-switching the light
 * sheet uses. Same shape, same labels, deliberately: the editor and the sheet must not develop
 * two vocabularies for one model.
 *
 * ## What is edited is a working copy
 *
 * Nothing reaches the setting until *Save*. Switching between presets harvests the visible pane
 * into that copy first, so a half-finished edit survives a look at another entry, and *Close*
 * without saving discards the lot. Both are what a GM will assume without being told, and the
 * cost is one field of state.
 *
 * ## The key is identity; the label is not
 *
 * A document records **where its numbers came from** in `config.preset`, which is history. So
 * renaming a preset keeps its key and the documents that reference it stay attached; deleting
 * one leaves those documents holding a dead key, which reports as Custom and changes nothing,
 * because nothing in the model reads `preset` at all. See §10.2.
 *
 * Editing a preset does **not** reach back into lights already placed from it — `applyPreset`
 * writes values at the moment it is chosen and nothing re-reads the table afterwards. That is
 * the one-way sync seen from the far side, and the window says so rather than leaving it to be
 * discovered.
 */

import { MODULE_ID } from "../constants.mjs";
import { TIER } from "../model/tiers.mjs";
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
/*  Choices — the sheet's vocabulary, verbatim   */
/* -------------------------------------------- */

const TIER_CHOICES = [
  { value: TIER.DIM, label: "Dim" },
  { value: TIER.NORMAL, label: "Normal" },
  { value: TIER.BRIGHT, label: "Bright" },
];

const FLOOR_CHOICES = [
  { value: TIER.DARK, label: "Dark" },
  { value: TIER.SUPERNATURAL_DARK, label: "Supernatural Dark" },
];

/** Stops at Dim for `ui/light-config.mjs`'s reason: `clamp` only lowers. */
const CLAMP_CHOICES = [
  { value: TIER.SUPERNATURAL_DARK, label: "Supernatural Dark" },
  { value: TIER.DARK, label: "Dark" },
  { value: TIER.DIM, label: "Dim" },
];

const EFFECT_CHOICES = [
  { value: "reduce", label: "Decrease by" },
  { value: "clamp", label: "Set level to" },
];

const KIND_CHOICES = [
  { value: "light", label: "Light" },
  { value: "darkness", label: "Darkness" },
];

function levelChoices(zeroLabel) {
  const out = [{ value: 0, label: zeroLabel }];
  for (let i = 1; i <= 9; i++) out.push({ value: i, label: `Level ${i}` });
  return out;
}

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

/** A blank entry, so *New* lands on something that already works. */
const blankPreset = () => ({
  label: "New preset",
  negative: false,
  config: {
    kind: "mundane",
    level: 0,
    cancelsDarkness: false,
    emitTier: TIER.NORMAL,
    steps: 1,
    cap: TIER.NORMAL,
  },
  light: { bright: 20, dim: 40 },
});

/* -------------------------------------------- */
/*  The application                             */
/* -------------------------------------------- */

/**
 * @remarks
 * Built by hand rather than through `HandlebarsApplicationMixin`. The module has no `templates/`
 * directory and this would be the only thing in it, so a template would put half of one window's
 * markup in a second file and a second language for the sake of a list and a form. §10.6's
 * settings menu is the point at which that trade changes.
 */
class PresetEditor extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "pf1-lighting-preset-editor",
    tag: "form",
    classes: ["pf1-lighting", "preset-editor"],
    window: {
      title: "Lighting Presets",
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
    },
  };

  /** The working copy. Nothing here is stored until *Save*. */
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
  <label>Preset</label>
  <div class="form-fields">
    ${
      options.length
        ? select("__which", options, this.#current)
        : `<select name="__which" disabled><option>No presets</option></select>`
    }
    <button type="button" class="icon" data-action="create" data-tooltip="New preset">
      <i class="fa-solid fa-plus"></i></button>
    <button type="button" class="icon" data-action="duplicate" data-tooltip="Duplicate"
            ${preset ? "" : "disabled"}><i class="fa-solid fa-clone"></i></button>
    <button type="button" class="icon" data-action="remove" data-tooltip="Delete"
            ${preset ? "" : "disabled"}><i class="fa-solid fa-trash"></i></button>
  </div>
  <p class="hint">Changing a preset here does not alter lights already placed from it — a preset
    fills fields in at the moment it is chosen and is never read again afterwards.</p>
</div>

<hr>

${preset ? this.#pane(preset) : `<p class="notification info">No presets. Add one.</p>`}

<footer class="form-footer">
  <button type="button" data-action="reset">
    <i class="fa-solid fa-rotate-left"></i> Restore defaults</button>
  <button type="submit"><i class="fa-solid fa-save"></i> Save</button>
</footer>`;
  }

  /* -------------------------------------------- */

  /** The fields for one preset. Same labels and same branch split as the light sheet. */
  #pane(preset) {
    const config = preset.config ?? {};
    const light = preset.light ?? {};
    const transform = config.transform ?? {};
    const op = transform.op ?? "reduce";
    const negative = preset.negative === true;
    const magical = (config.kind ?? "mundane") === "magical";
    const off = (hidden) => (hidden ? ' class="pf1-lighting-off"' : "");

    return `
<div class="form-group">
  <label>Name</label>
  <div class="form-fields">
    <input type="text" name="label" value="${esc(preset.label ?? "")}">
  </div>
</div>

<div class="form-group">
  <label>Source</label>
  <div class="form-fields">
    ${select("negative", KIND_CHOICES, negative ? "darkness" : "light")}
  </div>
  <p class="hint">A darkness lowers the light level in its area instead of raising it.</p>
</div>

<div class="form-group">
  <label>Magical</label>
  <div class="form-fields">
    <input type="checkbox" name="magical"${magical ? " checked" : ""}>
  </div>
  <p class="hint">Magical light of a higher level than a darkness overrides it. A magical
    darkness also blocks sight through itself.</p>
</div>

<div data-branch="light"${negative ? ' class="pf1-lighting-off"' : ""}>
  <div class="form-group">
    <label>Spell level</label>
    <div class="form-fields">
      ${select("level", levelChoices("Level 0 (cantrip)"), config.level ?? 0)}
    </div>
  </div>

  <div class="form-group">
    <label>Counts as <em>daylight</em></label>
    <div class="form-fields">
      <input type="checkbox" name="cancelsDarkness"${config.cancelsDarkness ? " checked" : ""}>
    </div>
    <p class="hint">Annihilates with a darkness of its own level or lower.</p>
  </div>

  <div class="form-group slim">
    <label>Brightness</label>
    <div class="form-fields">
      <label>Level</label>
      ${select("emitTier", TIER_CHOICES, config.emitTier ?? TIER.NORMAL)}
      <label>Radius</label>
      <input type="number" name="bright" value="${esc(light.bright ?? 20)}" min="0" step="any">
    </div>
    <p class="hint">The level this light provides outright, out to that radius.</p>
  </div>

  <div class="form-group slim">
    <label>Increase brightness</label>
    <div class="form-fields">
      <label>Radius</label>
      <input type="number" name="dim" value="${esc(light.dim ?? 40)}" min="0" step="any">
      <label>Steps</label>
      <input type="number" name="steps" value="${esc(config.steps ?? 1)}" min="0" max="4" step="1">
      <label>Maximum</label>
      ${select("cap", TIER_CHOICES, config.cap ?? config.emitTier ?? TIER.NORMAL)}
    </div>
    <p class="hint">Beyond the inner radius the light raises whatever level is already there by
      that many steps, never past the maximum.</p>
  </div>
</div>

<div data-branch="darkness"${negative ? "" : ' class="pf1-lighting-off"'}>
  <div class="form-group slim">
    <label>Radius</label>
    <div class="form-fields">
      <input type="number" name="darkRadius" value="${esc(light.dim ?? 20)}" min="0" step="any">
    </div>
    <p class="hint">A darkness has one radius.</p>
  </div>

  <div class="form-group">
    <label>Spell level</label>
    <div class="form-fields">
      ${select("darkLevel", levelChoices("Mundane / unlit area"), config.level ?? 2)}
    </div>
    <p class="hint">Level 0 darkens without blinding — an unlit cellar, which you can still see
      out of. Level 1 and above cast an umbra.</p>
  </div>

  <div class="form-group slim">
    <label>Effect</label>
    <div class="form-fields">
      ${select("transformOp", EFFECT_CHOICES, op)}
      <span data-effect="reduce"${off(op !== "reduce")}>
        <input type="number" name="transformSteps" value="${esc(transform.steps ?? 1)}"
               min="1" max="4" step="1">
      </span>
      <span data-effect="clamp"${off(op !== "clamp")}>
        ${select("transformMax", CLAMP_CHOICES, transform.max ?? TIER.DARK)}
      </span>
    </div>
    <p class="hint"><em>Set level to</em> never brightens: over ground that is already darker, it
      leaves it alone.</p>
  </div>

  <div class="form-group" data-effect="reduce"${off(op !== "reduce")}>
    <label>Floor</label>
    <div class="form-fields">
      ${select("floor", FLOOR_CHOICES, config.floor ?? TIER.DARK)}
    </div>
    <p class="hint">The darkest this can drive an area.</p>
  </div>
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
   * A stable bound field, removed before it is added. `_onRender` fires on **every** render and
   * `this.element` survives them — only the content inside it is replaced — so an anonymous
   * handler would stack one copy per render, and each copy would harvest and re-render, which is
   * the shape of bug that looks like the window getting slower the longer it is open.
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

    this.#harvest();

    // Only two fields change what is *shown*. Everything else has already been recorded by the
    // harvest above, and re-rendering for it would rebuild the pane under the GM's cursor.
    if (name === "negative" || name === "transformOp") this.render();
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
    if (!this.#current) return;
    const root = this.element;
    const value = (name) => root.querySelector(`[name="${name}"]`);
    const num = (name, fallback) => {
      const raw = Number(value(name)?.value);
      return Number.isFinite(raw) ? raw : fallback;
    };
    const checked = (name) => value(name)?.checked === true;

    const negative = value("negative")?.value === "darkness";
    const kind = checked("magical") ? "magical" : "mundane";
    const op = value("transformOp")?.value === "clamp" ? "clamp" : "reduce";
    const max = num("transformMax", TIER.DARK);

    const preset = {
      label: value("label")?.value?.trim() || "Untitled",
      negative,
      config: negative
        ? {
            kind,
            level: num("darkLevel", 2),
            // Under `clamp` the target **is** the floor: `applyTransform` ignores `floor` on that
            // branch while `resolveTier` applies it separately, so a mismatch would quietly raise
            // a *set* darkness back up. The sheet does the same thing in `sync()`; doing it here
            // as well means a preset cannot be authored inconsistent in the first place. §10.4.
            transform:
              op === "clamp" ? { op, max } : { op, steps: num("transformSteps", 1) },
            floor: op === "clamp" ? max : num("floor", TIER.DARK),
          }
        : {
            kind,
            level: num("level", 0),
            // `&& magical` for `model/contest.mjs:235`'s reason: `breaks()` reads this flag
            // without first checking `kind`, so a mundane *daylight* would go on annihilating.
            cancelsDarkness: kind === "magical" && checked("cancelsDarkness"),
            emitTier: num("emitTier", TIER.NORMAL),
            steps: num("steps", 1),
            cap: num("cap", TIER.NORMAL),
          },
      // A darkness's two radii are collapsed to their maximum by
      // `PointDarknessSource#_initialize`, so authoring anything but `bright: 0` here would
      // write a number that cannot mean what it says.
      light: negative ? { bright: 0, dim: num("darkRadius", 20) } : {
        bright: num("bright", 20),
        dim: num("dim", 40),
      },
    };

    this.#working[this.#current] = preset;
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

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
      window: { title: "Delete preset" },
      content: `<p>Delete <strong>${esc(label)}</strong>?</p>
        <p>Lights already placed from it keep their settings and will simply read as Custom.</p>`,
    });
    if (!ok) return;
    delete this.#working[this.#current];
    this.#current = Object.keys(this.#working)[0] ?? null;
    this.render();
  }

  static async #onReset() {
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Restore default presets" },
      content: `<p>Discard this world's preset table and go back to the module's own?</p>
        <p>The world will then track the built-in presets as the module changes them.</p>`,
    });
    if (!ok) return;
    await resetTable();
    this.#working = foundry.utils.deepClone(BUILT_IN);
    this.#current = Object.keys(this.#working)[0] ?? null;
    this.render();
  }

  /**
   * @remarks
   * The visible pane is harvested first. `FormDataExtended` would not do it: the fields are typed
   * by hand here — `negative` is a select of two words, a darkness's radius is one field standing
   * for two, and `transform` is a nested object whose shape depends on another control — so
   * building the entry is exactly the work {@link #harvest} already does on every change.
   */
  static async #onSubmit() {
    this.#harvest();
    await setTable(this.#working);
    ui.notifications.info(
      `PF1 Lighting | ${Object.keys(this.#working).length} lighting presets saved.`
    );
  }
}

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

export function registerSettings() {
  game.settings.registerMenu(MODULE_ID, MENU_KEY, {
    name: "Lighting Presets",
    label: "Edit Presets",
    hint:
      "The named light and darkness configurations offered on a light's Lighting Configuration " +
      "section — torch, darkness, daylight and so on. Add your own, or retune the ones that " +
      "ship with the module to your table's numbers.",
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
