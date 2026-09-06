/**
 * Sightless — a creature with no visual senses. DESIGN.md §4.5.4.
 *
 * A grimlock, an eyeless ooze, an oracle with the blind curse. It perceives by blindsight,
 * tremorsense, scent, blindsense or lifesense, and by nothing else.
 *
 * **Not the blinded condition.** A grimlock takes no −2 to AC, keeps its Dex bonus, and is not
 * flat-footed. Beyond the flavour, `blinded.blind` feeds `PointVisionSource#isBlinded`, which swaps
 * the vision mode to `blindness` and draws no sight FOV at all — a *rendering* verdict, and one this
 * needs left computed rather than asserted, since a Sightless creature with blindsight must still
 * paint terrain. So this never writes that record. It removes the senses, and lets `isBlinded` reach
 * its own conclusion from what is left. A creature with nothing else then blinds itself, correctly
 * and without a line of code.
 *
 * **What goes, and why it is stricter than it looks.** PF1 ships the rules text, and it settles the
 * question rather than leaving it to a reading (`packs/rules/universal-monster-rules-umr`):
 * darkvision is "black and white only but *otherwise like normal sight*", low-light vision "can
 * *see* twice as far… retains the ability to distinguish color and detail", see in darkness "can
 * *see* perfectly in darkness of any kind". Against the *blinded* condition's "all checks and
 * activities that rely on vision automatically fail", all three go, along with true seeing and see
 * invisibility. Blindsight is "using *nonvisual* senses", blindsense "notices things it cannot see",
 * lifesense "as if it had blindsight" — those stay.
 *
 * The lenient reading, keeping darkvision, was the first design and is the intuitive one: darkvision
 * *feels* non-visual, being the sense you use when there is nothing to see by. It is not, and the
 * system says so in as many words.
 */

import { MODULE_ID } from "../constants.mjs";
import { t } from "../i18n.mjs";

export const FLAG = "sightless";

/** Marks the form handler this module has already wrapped. */
const PATCHED = Symbol.for("pf1LightingSightlessPatched");

/**
 * The visual senses this overrides, as they are named for the notice.
 *
 * @remarks
 * Ordered as the Senses window lists them, so the notice reads as a subset of what is on screen
 * rather than as an unrelated list. `read` answers "is this sense actually set", since naming a
 * sense the sheet does not have would be noise.
 */
const VISUAL_SENSES = [
  { key: "PF1.Sense.lowlight", read: (s) => s?.ll?.enabled === true },
  { key: "PF1.Sense.darkvision", read: (s) => (s?.dv?.total ?? s?.dv?.value ?? 0) > 0 },
  { key: "PF1.Sense.seeInvis", read: (s) => s?.si === true },
  { key: "PF1.Sense.trueseeing", read: (s) => (s?.tr?.total ?? s?.tr?.value ?? 0) > 0 },
  { key: "PF1.Sense.seeInDark", read: (s) => s?.sid === true },
];

/* -------------------------------------------- */
/*  The verdict                                 */
/* -------------------------------------------- */

/**
 * Does this actor have no visual senses?
 *
 * @param {Actor|null} actor
 * @returns {boolean}
 */
export function isSightless(actor) {
  return actor?.getFlag?.(MODULE_ID, FLAG) === true;
}

/**
 * The same, from a vision source.
 *
 * @remarks
 * Separate so the call sites that hold a source — the detection mixins and the `_initialize`
 * override — do not each repeat the walk down to the actor, which is the sort of expression that
 * acquires a different `?.` on every copy.
 *
 * @param {PointVisionSource|null} source
 * @returns {boolean}
 */
export function sourceIsSightless(source) {
  return isSightless(source?.object?.actor);
}

/* -------------------------------------------- */
/*  The Senses window                           */
/* -------------------------------------------- */

/**
 * PF1's own label for a sense, for the overridden-senses notice.
 *
 * @remarks
 * Localised from the system's keys rather than restated in this module's `lang/en.json`. The notice
 * names rows that are on screen a few pixels away, and a translated world showing four PF1 labels
 * beside one of ours would read as a bug in the window.
 */
function senseLabel(key) {
  return game.i18n.localize(key);
}

/** Which visual senses this actor has set, by label — empty when none. */
function overriddenSenses(actor) {
  const senses = actor?.system?.traits?.senses;
  if (!senses) return [];
  return VISUAL_SENSES.filter((s) => s.read(senses)).map((s) => senseLabel(s.key));
}

/**
 * Add the checkbox, and the line naming what it overrides.
 *
 * @remarks
 * Placed above *Low-light Vision* rather than beside the other checkboxes at the foot of the list.
 * It governs every row in the visual half, and a switch that disables six rows belongs above them.
 *
 * The notice names the overridden senses rather than greying their inputs out. Greying is the more
 * obvious signal and the worse one: it hides a statblock's own darkvision value from whoever is
 * reading the sheet, trading a confusing display for a lossy one. This is the only place the strict
 * rules reading is likely to surprise anybody, so it is the one place worth the line.
 *
 * Its *content* is computed from saved data and so refreshes on the next render — after Save, which
 * is when the sheet's other numbers commit too. Only its visibility follows the checkbox live,
 * through `hidden` rather than a style, so nothing here needs a stylesheet rule.
 */
function injectCheckbox(app, element) {
  const root = element instanceof HTMLElement ? element : element?.[0];
  const section = root?.querySelector(".form-body");
  if (!section || section.querySelector(`.${MODULE_ID}-sightless`)) return;

  const actor = app.document;
  const id = `senses-sightless-${actor.id}`;
  const checked = isSightless(actor);
  const overridden = overriddenSenses(actor);

  const group = document.createElement("div");
  group.classList.add("form-group", `${MODULE_ID}-sightless`);
  group.innerHTML = `
    <label for="${id}">${t("Senses.Sightless")}</label>
    <div class="form-fields">
      <input id="${id}" type="checkbox" name="flags.${MODULE_ID}.${FLAG}" ${checked ? "checked" : ""}>
    </div>`;

  const note = document.createElement("p");
  note.classList.add("hint", `${MODULE_ID}-sightless-note`);
  note.hidden = !checked || overridden.length === 0;
  note.textContent = t("Senses.SightlessOverrides", {
    senses: overridden.join(", "),
  });

  section.prepend(group, note);

  group.querySelector("input")?.addEventListener("change", (event) => {
    note.hidden = !event.currentTarget.checked || overridden.length === 0;
  });

  // The window is sized to its content and was laid out before this ran, so two new rows overflow
  // it. Only when it is not being resized by the user, which `setPosition` with no height would
  // otherwise undo.
  if (app.options?.window?.resizable !== true) app.setPosition({ height: "auto" });
}

/** Disable the injected input along with the rest when the sheet is not editable. */
function respectLock(app, element) {
  if (app.isEditable) return;
  const root = element instanceof HTMLElement ? element : element?.[0];
  for (const el of root?.querySelectorAll(`.${MODULE_ID}-sightless input`) ?? []) {
    el.disabled = true;
  }
}

/**
 * Re-derive vision when the flag changes.
 *
 * @remarks
 * Nothing else would. The flag feeds three things that are each computed once and cached — the two
 * radii in the vision source's `_initialize`, and PF1's low-light multiplier, which is baked into
 * every light source's own `data` — and none of them is recomputed by an actor update Foundry does
 * not recognise as a vision change. Without this, ticking the box does nothing visible until the
 * token is moved or the scene reloaded, which reads as the checkbox not working.
 *
 * The lights are re-initialised through PF1's own debounced helper, since PF1 records
 * (`low-light-vision.mjs:119-126`) that a perception update alone stopped being sufficient in v12.
 */
function onFlagChange(actor, changed) {
  const flags = changed?.flags?.[MODULE_ID];
  if (!flags || !(FLAG in flags || `-=${FLAG}` in flags)) return;

  for (const token of actor.getActiveTokens?.() ?? []) token.initializeVisionSource?.();
  pf1?.canvas?.lowLightVision?.debouncedLightSourceReInit?.();
  if (canvas?.ready) {
    canvas.perception.update({ initializeVision: true, refreshVision: true, refreshLighting: true });
  }
}

export function registerHooks() {
  Hooks.on("renderSensesSelector", (app, element) => {
    try {
      injectCheckbox(app, element);
      respectLock(app, element);
    } catch (error) {
      // A window that opens without the checkbox is a missing feature; one that throws while
      // rendering is a broken sheet.
      console.error(`${MODULE_ID} | senses window injection failed`, error);
    }
  });

  Hooks.on("updateActor", onFlagChange);
}

/**
 * Make the Senses window's Save button write the flag.
 *
 * @remarks
 * `SensesSelector._onSave` ends at `this.document.update({ "system.traits.senses": senses })`
 * (`pf1/module/applications/senses-selector.mjs`) — it reads the whole form and then commits one
 * subtree of it, so a `flags.…` input reaches `formData` and is discarded. The field needs a writer.
 *
 * **`DEFAULT_OPTIONS.form.handler`, not the static method.** `DEFAULT_OPTIONS` is built at class
 * definition time and its `handler: this._onSave` captures the *function object*, so reassigning
 * `SensesSelector._onSave` afterwards changes nothing — the options object still holds the original.
 * `ApplicationV2` reads `cls.DEFAULT_OPTIONS` per construction (`application.mjs:390`) and freezes
 * only the merged result on the instance, so the class-level object is both writable and read late
 * enough for this to take.
 *
 * Wrapping rather than replacing, for the same reason `_syncSenses` runs PF1's own function: the
 * unit conversion and the delete-disabled-senses pass in there are PF1's business and change with
 * PF1.
 *
 * Writing the flag *after* the original resolves, and only when the input was actually present, so
 * a window rendered before this module loaded cannot clear a flag it never showed.
 */
export function applyFormPatch() {
  const cls = pf1?.applications?.SensesSelector;
  const form = cls?.DEFAULT_OPTIONS?.form;
  if (!form || typeof form.handler !== "function" || form[PATCHED]) return;

  const original = form.handler;
  form[PATCHED] = true;

  form.handler = async function pf1LightingSensesSave(event, formElement, formData) {
    let value;
    try {
      value = foundry.utils.getProperty(
        foundry.utils.expandObject(formData.object),
        `flags.${MODULE_ID}.${FLAG}`
      );
    } catch {
      value = undefined;
    }

    await original.call(this, event, formElement, formData);

    if (value === undefined) return;
    await this.document.setFlag(MODULE_ID, FLAG, value === true);
  };
}

/**
 * Show *Sightless* in the Attributes tab's Senses row.
 *
 * @remarks
 * `ActorSheetPF#_prepareSenseLabels` builds the tag list the row renders
 * (`pf1/module/applications/actor/actor-sheet.mjs:661`, consumed by
 * `templates/actors/parts/actor-traits.hbs:42-44`), and it is defined exactly once on the base sheet
 * that every actor type's sheet extends — so one prototype patch covers character, NPC, haunt, trap,
 * vehicle and the two loot sheets.
 *
 * Through the template rather than by injecting an `<li>` on `renderActorSheet`. The tag then gets
 * PF1's own markup and classes for free, survives a partial re-render, and needs no stylesheet rule
 * of this module's — which matters more than it sounds, module CSS being unlayered and outranking
 * everything core puts in a layer.
 *
 * **First in the list, and the order is the object's.** The template iterates insertion order, and
 * PF1 builds its entries in `template.json` key order, so spreading the original after this one puts
 * *Sightless* ahead of the senses it governs rather than somewhere inside them.
 *
 * No entry when the flag is off, so a sheet that has never heard of this feature is untouched.
 */
export function applySheetPatch() {
  const proto = pf1?.applications?.actor?.ActorSheetPF?.prototype;
  if (!proto || proto[PATCHED]) return;

  const original = proto._prepareSenseLabels;
  if (typeof original !== "function") return;

  Object.defineProperty(proto, PATCHED, { value: true, enumerable: false });

  proto._prepareSenseLabels = function pf1LightingSenseLabels(...args) {
    const result = original.apply(this, args);
    if (!isSightless(this.actor)) return result;
    // `cssId` becomes `tag-id-sightless` on the `li`. Named rather than run through
    // `createTag` like the custom entries: this is a fixed key, not user text.
    return { sightless: { label: t("Senses.Sightless"), cssId: FLAG }, ...result };
  };
}

/** Are the patches installed? Read by `probe.vision()`. */
export function status() {
  return {
    formPatched: pf1?.applications?.SensesSelector?.DEFAULT_OPTIONS?.form?.[PATCHED] === true,
    sheetPatched: pf1?.applications?.actor?.ActorSheetPF?.prototype?.[PATCHED] === true,
  };
}
