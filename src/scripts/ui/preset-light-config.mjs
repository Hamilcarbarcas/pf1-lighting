/**
 * A preset edited through Foundry's own light sheet. DESIGN.md §10.2.2.
 *
 * The preset editor used to reimplement a subset of the light configuration sheet, which meant a
 * second set of labels, a second layout, and a table that could only ever hold the fields somebody
 * had got round to reproducing. This opens **the real `AmbientLightConfig`** on a document that is
 * never saved, and harvests the form on submit.
 *
 * ## Why an unsaved document is safe here
 *
 * The same trick as `model/companion.mjs`, and core does the guarding:
 *
 * - **No preview.** `_prepareContext` builds one only `if (options.isFirstRender &&
 *   context.document.object)` (`sheets/ambient-light-config.mjs:104`). This document has no
 *   placeable, so `preview` stays undefined and every preview path returns early —
 *   `_previewChanges`, `_resetPreview`, `_preRender`, `_onClose` all test it. Nothing reaches the
 *   canvas.
 * - **No accidental write.** `DocumentSheetV2._processSubmitData` writes only
 *   `if (document.collection?.has(document.id))`, and creates only `else if (this.options.canCreate)`
 *   — which defaults to false (`api/document-sheet.mjs:51,455-463`). So core's own submit is a no-op
 *   for this document and the override below is purely additive.
 * - **The document still needs an `_id`.** Not for core's sake here but for ours: `isPreview` is
 *   `!!this._original || !this.document.id`, and a preview sheet would take a different path.
 *
 * ## What comes for free
 *
 * `renderAmbientLightConfig` fires for subclasses — `#callHooks` walks the inheritance chain — so
 * `ui/light-config.mjs` injects this module's own Lighting Configuration fieldset with no new code,
 * and reads it back off `app.document` because there is no preview to prefer. The preset editor and
 * the light sheet are now the same form by construction rather than by maintenance.
 *
 * ## What is hidden, and the rule
 *
 * **Anything not harvested is hidden.** A control that submits into nothing is worse than an absent
 * one: it invites a GM to set a value that silently evaporates. So the placement fields go —
 * coordinates and elevation are properties of a light *somewhere*, not of the kind of light this is
 * — along with Wall Height's two injections, which are the same thing by another name
 * (`wall-height.js:137-170`: a `levels.rangeTop` elevation row and an `advancedLighting` flag, both
 * meaningless without a position).
 *
 * Rotation, angle and walls stay, at Hamilcarbarcas's direction (2026-08-30): they say what kind of
 * light this is rather than where it is, and keeping them here is what lets §12.8's item table carry
 * nothing but a preset, a fuel item and a burn time.
 */

import { MODULE_ID } from "../constants.mjs";
import { t } from "../i18n.mjs";

/**
 * Fields that live at the document root rather than inside `config`, and are therefore stored in a
 * preset's `placement` bucket rather than its `light` one.
 *
 * @remarks
 * `angle` is deliberately absent: it *is* `LightData` (`config.angle`), so it rides in `light` with
 * the radii and belongs to every consumer including a token's own light. These three do not — a
 * `TokenDocument` has no `walls` on its light and takes its rotation from the token.
 */
export const PLACEMENT_FIELDS = Object.freeze(["rotation", "walls", "vision"]);

/** Selectors for every control the harvest does not read. Hidden rather than left to mislead. */
const HIDDEN_FIELDS = [
  '[name="x"]',
  '[name="y"]',
  '[name="elevation"]',
  // Wall Height, when present. Its elevation row is a sibling of the coordinates group rather than
  // inside it, so hiding the group above does not take it with it.
  '[name="flags.levels.rangeTop"]',
  '[name="flags.wall-height.advancedLighting"]',
];

/**
 * An unsaved `AmbientLightDocument` carrying a preset's values.
 *
 * @param {object} preset
 * @returns {AmbientLightDocument}
 */
function documentFor(preset) {
  const placement = preset.placement ?? {};
  return new CONFIG.AmbientLight.documentClass(
    {
      _id: foundry.utils.randomID(),
      x: 0,
      y: 0,
      elevation: 0,
      rotation: placement.rotation ?? 0,
      walls: placement.walls ?? true,
      vision: placement.vision ?? false,
      hidden: false,
      config: { ...(preset.light ?? {}), negative: preset.negative === true },
      flags: { [MODULE_ID]: { config: preset.config ?? {} } },
    },
    // A parent is required: `PlaceableObject` demands `isEmbedded`, and the sheet reads
    // `document.parent.grid.units` for its unit labels.
    { parent: canvas?.scene ?? game.scenes?.contents[0] ?? null }
  );
}

/* -------------------------------------------- */

const Base = foundry.applications.sheets.AmbientLightConfig;

export class PresetLightConfig extends Base {
  /**
   * @param {object} options
   * @param {object} options.preset - The working copy to edit
   * @param {string} options.label  - Shown in the window title, so the GM knows which one this is
   * @param {(preset: object) => void} options.onSave - Handed the harvested preset on submit
   */
  constructor({ preset, label, onSave, ...options } = {}) {
    super({ ...options, document: documentFor(preset) });
    this.#preset = preset;
    this.#label = label;
    this.#onSave = onSave;
  }

  #preset;
  #label;
  #onSave;

  static DEFAULT_OPTIONS = {
    // Not `id: "{id}"`. The inherited default keys the application by document id, which is a fresh
    // `randomID()` every time this opens — so each edit would register a new application and the old
    // ones would never be collected.
    id: "pf1-lighting-preset-light-config",
    classes: ["pf1-lighting-preset-light"],
    form: { closeOnSubmit: true },
  };

  /** @inheritDoc */
  get title() {
    return t("Presets.EditTitle", { label: this.#label ?? "" });
  }

  /**
   * Always editable.
   *
   * @remarks
   * `DocumentSheetV2#isEditable` asks `document.testUserPermission(user, editPermission)`
   * (`api/document-sheet.mjs:113-119`), and this document is in no collection for ownership to be
   * derived from. The window itself is only reachable from the GM-only settings menu, so the
   * question has already been answered one level up.
   */
  get isEditable() {
    return true;
  }

  /** @inheritDoc */
  async _onRender(context, options) {
    await super._onRender(context, options);

    for (const selector of HIDDEN_FIELDS) {
      const field = this.element.querySelector(selector);
      // The whole row, not the input: a label with nothing under it reads as a rendering fault.
      field?.closest(".form-group")?.classList.add("pf1-lighting-off");
    }

    // Third-party rows sit between core's, so the placement fieldset can end up holding nothing but
    // hidden children and its own legend. Take the legend with them.
    for (const fieldset of this.element.querySelectorAll("fieldset")) {
      const rows = [...fieldset.querySelectorAll(".form-group")];
      if (rows.length && rows.every((row) => row.classList.contains("pf1-lighting-off"))) {
        fieldset.classList.add("pf1-lighting-off");
      }
    }
  }

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    // Core labels the submit button CREATE for a document its collection does not hold, which is
    // true and unhelpful — nothing is created.
    const submit = context.buttons?.find((button) => button.type === "submit");
    if (submit) submit.label = t("Presets.SaveEdits");
    return context;
  }

  /**
   * Harvest the form into the preset instead of updating the document.
   *
   * @remarks
   * `submitData` has already been cleaned and validated against `AmbientLightDocument`'s schema by
   * `_prepareSubmitData`, so a malformed colour or an out-of-range alpha never reaches the table.
   * That validation is most of what reusing the real sheet buys.
   *
   * `super` is deliberately **not** called. It is a no-op for this document today
   * (`document.collection.has(id)` is false, `canCreate` is false), and relying on that would make
   * this quietly start creating stray `AmbientLight`s the day either changes.
   */
  async _processSubmitData(event, form, submitData) {
    const config = submitData.config ?? {};

    // `negative` decides which branch every consumer takes, and it lives on the preset rather than
    // inside `light` — the one field that is structural rather than data.
    const negative = config.negative === true;
    delete config.negative;

    const placement = {};
    for (const key of PLACEMENT_FIELDS) {
      if (submitData[key] !== undefined) placement[key] = submitData[key];
    }

    // A darkness's two radii are collapsed to their maximum by `PointDarknessSource#_initialize`,
    // so storing anything but `bright: 0` would record a number that cannot mean what it says. The
    // hand-built editor enforced this and the native sheet does not, so it is enforced here.
    if (negative) {
      config.dim = Math.max(config.dim ?? 0, config.bright ?? 0);
      config.bright = 0;
    }

    this.#onSave?.({
      ...this.#preset,
      negative,
      light: config,
      placement,
      config: foundry.utils.getProperty(submitData, `flags.${MODULE_ID}.config`) ?? this.#preset.config ?? {},
    });
  }
}

/**
 * Open the sheet for one preset.
 *
 * @param {object} preset
 * @param {string} label
 * @param {(preset: object) => void} onSave
 * @returns {PresetLightConfig}
 */
export function edit(preset, label, onSave) {
  const app = new PresetLightConfig({ preset, label, onSave });
  app.render({ force: true });
  return app;
}
