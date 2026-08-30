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
import { t } from "../i18n.mjs";
import { TIER, tierLabel } from "../model/tiers.mjs";
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

/**
 * **Functions, not constants.** These were module-level arrays, which is evaluated at import —
 * before `game.i18n` has loaded a single translation (see `i18n.mjs`). A `const` built from
 * {@link tierLabel} would freeze the keys into the dropdowns for the session. Called from
 * `_renderHTML`, which is late enough.
 */
const tierChoices = () => [TIER.DIM, TIER.NORMAL, TIER.BRIGHT].map(tierChoice);

const floorChoices = () => [TIER.DARK, TIER.SUPERNATURAL_DARK].map(tierChoice);

/** Stops at Dim for `ui/light-config.mjs`'s reason: `clamp` only lowers. */
const clampChoices = () => [TIER.SUPERNATURAL_DARK, TIER.DARK, TIER.DIM].map(tierChoice);

/**
 * Scene light levels a light may be switched on at, brightest first.
 *
 * Mirrors `ui/light-config.ACTIVATION_TIERS` and for its reason: the test is against the
 * *ambient*, and Supernatural Dark is not somewhere ambient light can be.
 */
const ACTIVATION_TIERS = [TIER.BRIGHT, TIER.NORMAL, TIER.DIM, TIER.DARK];

const activationChoices = () => ACTIVATION_TIERS.map(tierChoice);

/** A stored tier, or null if it is not one this control could have written. */
const storedTier = (value) =>
  Number.isFinite(value) && ACTIVATION_TIERS.includes(value) ? value : null;

const tierChoice = (tier) => ({ value: tier, label: tierLabel(tier) });

const effectChoices = () => [
  { value: "reduce", label: t("LightConfig.Effects.reduce") },
  { value: "clamp", label: t("LightConfig.Effects.clamp") },
];

const kindChoices = () => [
  { value: "light", label: t("Presets.Kind.light") },
  { value: "darkness", label: t("Presets.Kind.darkness") },
];

/** Spell levels, with 0 named for what it means rather than numbered. */
function levelChoices(zeroLabel) {
  const out = [{ value: 0, label: t(`LightConfig.SpellLevel.${zeroLabel}`) }];
  for (let i = 1; i <= 9; i++) {
    out.push({ value: i, label: t("LightConfig.SpellLevel.Numbered", { n: i }) });
  }
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
  <label>${esc(t("Presets.Name"))}</label>
  <div class="form-fields">
    <input type="text" name="label" value="${esc(preset.label ?? "")}">
  </div>
</div>

<div class="form-group">
  <label>${esc(t("Presets.Source"))}</label>
  <div class="form-fields">
    ${select("negative", kindChoices(), negative ? "darkness" : "light")}
  </div>
  <p class="hint">${t("Presets.SourceHint")}</p>
</div>

<div data-branch="light"${negative ? ' class="pf1-lighting-off"' : ""}>
  <!--
    **Magical is inside the light branch, and that is the model rather than tidiness** (§10.1).
    Nothing reads a *suppressor's* \`kind\`: \`breaks()\` and the eligibility preset both test
    \`emitter.kind\`, and a darkness's umbra comes from \`castsUmbra\`, which is \`level >= 1\`.
    So for a darkness this checkbox moved nothing, and its hint used to claim otherwise.
    \`ui/light-config.mjs\` has always had it here; this pane was the one that did not
    (Hamilcarbarcas, 2026-08-29: *"is the magical checkbox superfluous for darkness sources?"* — it
    was). On the emitter side the two axes are genuinely independent, which is why it stays.
  -->
  <div class="form-group">
    <label>${esc(t("Presets.Magical"))}</label>
    <div class="form-fields">
      <input type="checkbox" name="magical"${magical ? " checked" : ""}>
    </div>
    <p class="hint">${t("Presets.MagicalHint")}</p>
  </div>

  <!--
    **Both are withheld entirely when the light is mundane, not merely disabled**
    (Hamilcarbarcas, 2026-08-29). A mundane light has no spell level — \`breaks()\` and the
    eligibility preset gate every use of \`level\` on \`kind === "magical"\` — and \`#harvest\`
    already forces \`cancelsDarkness\` to false for one, so a visible checkbox there is a control
    whose value is overruled on save. \`ui/light-config.mjs\` greys them instead of hiding them,
    which is the right call on a sheet whose rows must not reflow under the cursor; a window that
    re-renders on the toggle anyway can just take them away.
  -->
  <div data-needs="magical"${off(!magical)}>
    <div class="form-group">
      <label>${esc(t("Common.SpellLevel"))}</label>
      <div class="form-fields">
        ${select("level", levelChoices("Cantrip"), config.level ?? 0)}
      </div>
    </div>

    <div class="form-group">
      <label>${t("Presets.Daylight")}</label>
      <div class="form-fields">
        <input type="checkbox" name="cancelsDarkness"${config.cancelsDarkness ? " checked" : ""}>
      </div>
      <p class="hint">${t("Presets.DaylightHint")}</p>
    </div>
  </div>

  <div class="form-group slim">
    <label>${esc(t("Presets.Brightness"))}</label>
    <div class="form-fields">
      <label>${esc(t("Common.Level"))}</label>
      ${select("emitTier", tierChoices(), config.emitTier ?? TIER.NORMAL)}
      <label>${esc(t("Common.Radius"))}</label>
      <input type="number" name="bright" value="${esc(light.bright ?? 20)}" min="0" step="any">
    </div>
    <p class="hint">${t("Presets.BrightnessHint")}</p>
  </div>

  <div class="form-group slim">
    <label>${esc(t("Presets.Increase"))}</label>
    <div class="form-fields">
      <label>${esc(t("Common.Radius"))}</label>
      <input type="number" name="dim" value="${esc(light.dim ?? 40)}" min="0" step="any">
      <label>${esc(t("Presets.Steps"))}</label>
      <input type="number" name="steps" value="${esc(config.steps ?? 1)}" min="0" max="4" step="1">
      <!-- Forced, not left to wrapping. Three controls do not fit and the natural break fell
           *between* "Maximum" and its dropdown, stranding the label on the row above. -->
      <span class="pf1-lighting-break"></span>
      <label>${esc(t("Presets.Maximum"))}</label>
      ${select("cap", tierChoices(), config.cap ?? config.emitTier ?? TIER.NORMAL)}
    </div>
    <p class="hint">${t("Presets.IncreaseHint")}</p>
  </div>
</div>

<div data-branch="darkness"${negative ? "" : ' class="pf1-lighting-off"'}>
  <div class="form-group">
    <label>${esc(t("Common.SpellLevel"))}</label>
    <div class="form-fields">
      ${select("darkLevel", levelChoices("Mundane"), config.level ?? 2)}
    </div>
    <p class="hint">${t("Presets.DarkLevelHint")}</p>
  </div>

  <!--
    **One group, two rows — *Effect* owns the radius and the floor** (Hamilcarbarcas, 2026-08-29).
    Neither is a decision separate from what the darkness does: the floor is the bottom of the
    same transform, and a darkness has exactly one radius. Laid out like *Increase Brightness*
    above — what the control does on the first line, what bounds it on the second.

    The break is a \`flex-basis: 100%\` spacer rather than natural wrapping, for the same reason
    as up there: left to itself the row breaks wherever it runs out of width, which is usually
    between a label and the field it names.

    \`Floor\` keeps \`data-effect="reduce"\` — under *set level to* the target **is** the floor
    (\`#harvest\` writes \`floor: max\` on that branch), so offering a second control for it would
    be offering one that contradicts itself. Its own hint is folded into the group's.
  -->
  <div class="form-group slim">
    <label>${esc(t("Presets.Effect"))}</label>
    <div class="form-fields">
      ${select("transformOp", effectChoices(), op)}
      <span data-effect="reduce"${off(op !== "reduce")}>
        <input type="number" name="transformSteps" value="${esc(transform.steps ?? 1)}"
               min="1" max="4" step="1">
      </span>
      <span data-effect="clamp"${off(op !== "clamp")}>
        ${select("transformMax", clampChoices(), transform.max ?? TIER.DARK)}
      </span>

      <span class="pf1-lighting-break"></span>

      <span data-effect="reduce"${off(op !== "reduce")}>
        <label>${esc(t("Presets.Floor"))}</label>
        ${select("floor", floorChoices(), config.floor ?? TIER.DARK)}
      </span>
      <label>${esc(t("Common.Radius"))}</label>
      <input type="number" name="darkRadius" value="${esc(light.dim ?? 20)}" min="0" step="any">
    </div>
    <p class="hint">${t("Presets.EffectHint")}</p>
  </div>
</div>

${this.#activation(config)}`;
  }

  /**
   * The activation range — §10.4.1's control, as a preset can carry it.
   *
   * @remarks
   * **Outside both branches**, because Foundry gates a darkness source on the same field
   * (`light.mjs:148-159` runs before the source is built), exactly as `ui/light-config.mjs` has it.
   *
   * **The full ladder means *always*, and is stored by storing nothing.** `activationRange`
   * resolves Bright→Dark to `{min: 0, max: 1}`, which is Foundry's own default — so a preset
   * showing the whole range is a preset with no opinion, and {@link #harvest} omits the pair.
   * That is what keeps every built-in preset from acquiring a range it never had and overwriting
   * one a GM set by hand on a light. Narrow it and it starts being written.
   */
  #activation(config) {
    const from = storedTier(config.activeFrom) ?? TIER.BRIGHT;
    const to = storedTier(config.activeTo) ?? TIER.DARK;

    return `
<div class="form-group slim">
  <label>${esc(t("LightConfig.Activation.Label"))}</label>
  <div class="form-fields">
    ${select("activeFrom", activationChoices(), from)}
    <label>${esc(t("LightConfig.Activation.DownTo"))}</label>
    ${select("activeTo", activationChoices(), to)}
  </div>
  <p class="hint">${t("Presets.ActivationHint")}</p>
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
    // `magical` joined the list on 2026-08-29, when *Spell Level* and *Counts as Daylight*
    // started being withheld rather than greyed for a mundane light.
    if (name === "negative" || name === "transformOp" || name === "magical") this.render();
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

    // **A darkness's `kind` is derived from its level, not from the checkbox.** The checkbox is
    // in the light branch now and a hidden branch keeps its DOM, so reading it here would write
    // whatever the *light* half happened to be left at. Nothing consumes a suppressor's `kind`
    // (§10.1), so this is only about the flag being coherent to read — and `level >= 1` is
    // exactly what `castsUmbra` means by magical. Still written rather than omitted, because
    // `applyPreset` writes the keys it has and an absent one would leave a light's stale value
    // behind when a darkness preset is chosen over it.
    const darkKind = num("darkLevel", 2) >= 1 ? "magical" : "mundane";

    // **The full ladder is stored as nothing at all.** Bright→Dark resolves to `{min: 0, max: 1}`
    // — Foundry's own default — so a preset showing the whole range has no opinion about
    // activation, and one with no opinion must not write the fields: `applyPreset` would then
    // reset a range the GM had set by hand on the light it is applied to. Narrowing either end
    // starts writing both. See `#activation`.
    const activeFrom = num("activeFrom", TIER.BRIGHT);
    const activeTo = num("activeTo", TIER.DARK);
    const gated = !(activeFrom >= TIER.BRIGHT && activeTo <= TIER.DARK);
    const activation = gated ? { activeFrom, activeTo } : {};

    const preset = {
      label: value("label")?.value?.trim() || t("Presets.Untitled"),
      negative,
      config: negative
        ? {
            kind: darkKind,
            level: num("darkLevel", 2),
            // Under `clamp` the target **is** the floor: `applyTransform` ignores `floor` on that
            // branch while `resolveTier` applies it separately, so a mismatch would quietly raise
            // a *set* darkness back up. The sheet does the same thing in `sync()`; doing it here
            // as well means a preset cannot be authored inconsistent in the first place. §10.4.
            transform:
              op === "clamp" ? { op, max } : { op, steps: num("transformSteps", 1) },
            floor: op === "clamp" ? max : num("floor", TIER.DARK),
            ...activation,
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
            ...activation,
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
   * The visible pane is harvested first. `FormDataExtended` would not do it: the fields are typed
   * by hand here — `negative` is a select of two words, a darkness's radius is one field standing
   * for two, and `transform` is a nested object whose shape depends on another control — so
   * building the entry is exactly the work {@link #harvest} already does on every change.
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
