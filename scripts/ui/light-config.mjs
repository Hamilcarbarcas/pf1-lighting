/**
 * The lighting controls, injected into the light and token config sheets. DESIGN.md §10.3.
 *
 * ## Inside the Basic tab, not beside it
 *
 * The first plan was a fourth tab on `AmbientLightConfig`. Hamilcarbarcas's objection settled it, and
 * it is not a matter of taste: our fields and Foundry's own two radii describe **one** light
 * between them, and the radii no longer mean what their labels say — "Dim Radius" is §3.2.1's
 * *increase* band and has nothing to do with dim light. A separate tab leaves that mislabelling
 * in place and puts the fields that explain it a click away.
 *
 * So one fieldset, between the radius fieldset and whatever follows it, carrying every control
 * including the two radii.
 *
 * ## The native inputs are MOVED, not copied
 *
 * `config.bright`, `config.dim` and `config.negative` are real `LightData` paths. A second input
 * carrying the same `name` would not be a mirror — `FormDataExtended` collects same-named fields
 * into a `RadioNodeList` and returns an **array** (`form-data-extended.mjs:176-183`), so the
 * document would be handed `[20, 20]` for its bright radius. There is exactly one of each input
 * on the page and we relocate the node, which keeps its value, its binding and core's delegated
 * listeners intact, and costs nothing.
 *
 * The rows they came from are hidden rather than deleted, so a re-render finds the DOM it
 * expects.
 *
 * ## Built as a string, not a template
 *
 * `foundry.applications.handlebars.renderTemplate` is **async**, and hook callbacks are not
 * awaited. Injecting asynchronously would leave a window in which the sheet is visible without
 * our fieldset, and would race our own de-duplication guard against a second render. The markup
 * here is simple enough that a synchronous build is the whole cost of avoiding that.
 *
 * ## Light↔darkness swaps by visibility, never by re-render
 *
 * `AmbientLightConfig#_onChangeForm` re-renders exactly `["animation", "advanced"]` when
 * `config.negative` changes (`ambient-light-config.mjs:169`) — never `basic`, where we live. So
 * both field groups are rendered and one is hidden.
 *
 * That has a real benefit beyond cheapness: hidden inputs still submit, and the model reads
 * `emitTier`/`steps`/`cap` **only** for emitters and `transform`/`floor` **only** for
 * suppressors. A light toggled to darkness and back keeps its emission settings, and the
 * opposite-mode flags sitting in the document are inert by construction.
 *
 * ## The activation range is a tier range (§10.4.1)
 *
 * `config.darkness.min`/`max` gate the source on `canvas.darknessLevel` — a raw `[0,1]` number
 * against a model that quantises to four ambient rungs, so the same argument §10.5 makes about
 * the scene slider applies: a continuous control offers precision that does not exist. Both
 * inputs are moved into hidden slots and driven by a pair of tier dropdowns.
 *
 * Two things the mapping has to get right, and both are easy to get plausibly wrong:
 *
 * - **The range is bands, not points.** `darknessTable()[tier]` is the level a tier *paints* at;
 *   the set of levels that *read* as that tier is `darknessBand(tier)`. Writing the point levels
 *   would leave a light set to *Normal* off on a scene at darkness 0.30, which the module itself
 *   calls Normal.
 * - **The two ends invert.** Low darkness is bright light, so the *brightest* tier drives `min`
 *   and the *darkest* drives `max`. The labels are in tiers throughout and never say min/max.
 */

import { MODULE_ID } from "../constants.mjs";
import { t } from "../i18n.mjs";
import { CUSTOM, GOVERNED, presetChoices, table as presetTable } from "../model/presets.mjs";
import {
  TIER,
  TIER_NAME,
  activationRange,
  tierFromDarkness,
  tierLabel,
} from "../model/tiers.mjs";
import { TABLE_CHANGED_HOOK } from "../render/levels.mjs";
import * as registry from "../model/registry.mjs";
import { isWriter } from "./scene-config.mjs";

/** Our own de-dup marker. Per-feature, never a shared utility class. */
const MARKER = "pf1-lighting-config";

/** Applied to the core rows whose inputs we have taken. */
const HIDDEN_ROW = "pf1-lighting-moved";

/** Flag path prefix. Identical on an AmbientLightDocument and a TokenDocument. */
const FLAG = `flags.${MODULE_ID}.config`;

/* -------------------------------------------- */
/*  Reading the current state                   */
/* -------------------------------------------- */

/**
 * The document whose flags the sheet is editing.
 *
 * @remarks
 * Three shapes behind one function. `AmbientLightConfig` previews into a clone and exposes
 * `preview`; `TokenConfig` and `PrototypeTokenConfig` both answer `token` through their shared
 * mixin, which already resolves to the preview when there is one
 * (`sheets/token/prototype-config.mjs:53-55`).
 */
function subject(app) {
  return app.preview ?? app.token ?? app.document ?? null;
}

/** Current module config, straight off the flags rather than through `getFlag`. */
function configOf(app) {
  const doc = subject(app);
  return doc?.flags?.[MODULE_ID]?.config ?? doc?._source?.flags?.[MODULE_ID]?.config ?? {};
}

/* -------------------------------------------- */
/*  Markup                                      */
/* -------------------------------------------- */

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

/**
 * A `<select>`.
 *
 * @remarks
 * **`data-dtype="Number"` on every numeric one.** A select's value is a string, and
 * `FormDataExtended` only casts when told to (`form-data-extended.mjs:188`). Without it a tier
 * arrives as `"3"`, and `stepTier`'s `tier + steps` would concatenate rather than add — the kind
 * of failure that produces a plausible wrong answer rather than an error.
 */
function select(name, options, value, { numeric = false, disabled = false, drives = "" } = {}) {
  const attrs = [
    name ? `name="${esc(name)}"` : "",
    drives ? `data-drives="${esc(drives)}"` : "",
    numeric ? 'data-dtype="Number"' : "",
    disabled ? "disabled" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const body = options
    .map(
      (option) =>
        `<option value="${esc(option.value)}"${
          String(option.value) === String(value) ? " selected" : ""
        }>${esc(option.label)}</option>`
    )
    .join("");
  return `<select ${attrs}>${body}</select>`;
}

/**
 * **Functions, not constants**, for `ui/preset-editor.mjs`'s reason: a module-level array is
 * built at import, and `game.i18n` holds no translations until after `init` (see `i18n.mjs`).
 * Every one of these is called from `fieldset`, which runs on sheet render.
 */
const tierChoice = (tier) => ({ value: tier, label: tierLabel(tier) });

const tierChoices = () => [TIER.DIM, TIER.NORMAL, TIER.BRIGHT].map(tierChoice);

const floorChoices = () => [TIER.DARK, TIER.SUPERNATURAL_DARK].map(tierChoice);

/**
 * Targets a *darkness* may be set to.
 *
 * @remarks
 * Deliberately stops at Dim. `clamp` only ever lowers, so offering Normal or Bright would offer
 * a darkness that does nothing on all but the brightest ground — a control whose most likely
 * setting is a no-op.
 */
const clampChoices = () => [TIER.SUPERNATURAL_DARK, TIER.DARK, TIER.DIM].map(tierChoice);

/** `set` and `decrease` are `clamp` and `reduce`; the labels are the GM-facing names. */
const effectChoices = () => [
  { value: "reduce", label: t("LightConfig.Effects.reduce") },
  { value: "clamp", label: t("LightConfig.Effects.clamp") },
];

/* -------------------------------------------- */
/*  Activation range (§10.4.1)                  */
/* -------------------------------------------- */

/**
 * Scene light levels a light may be switched on at, brightest first.
 *
 * Mirrors `ui/scene-config.SCENE_TIERS` and for the same reason: the test is against the
 * *ambient*, and Supernatural Dark is not somewhere ambient light can be.
 */
const ACTIVATION_TIERS = [TIER.BRIGHT, TIER.NORMAL, TIER.DIM, TIER.DARK];

const activationChoices = () => ACTIVATION_TIERS.map(tierChoice);

/** Float comparison for "the stored number is still the one we would write". */
const NEAR = 1e-6;

/**
 * A tier range → the `darkness.min`/`max` pair Foundry gates the source on.
 *
 * @remarks
 * **Moved to `model/tiers.mjs` on 2026-08-29** and kept here under its old name, because the
 * preset editor needs the same arithmetic and two copies of a rounding rule is how the sheet and
 * the preset table would come to disagree about which tier a light switches on at.
 */
const rangeFor = activationRange;

/** A stored tier, or null if it is not one this control can have written. */
const storedTier = (value) =>
  Number.isFinite(value) && ACTIVATION_TIERS.includes(value) ? value : null;

/**
 * The tier range a light is set to, and whether it was set *through this control*.
 *
 * @remarks
 * Flags first, numbers as the fallback — §10.5.1's argument, unchanged. A light that has never
 * been through this control shows the nearest rungs so it reads sensibly, and **nothing is
 * written until the GM picks one**: opening a sheet to change a radius must not quietly move a
 * hand-authored range onto the nearest band edge. Foundry's own defaults of `0`/`1` read back as
 * Bright→Dark, which is "always on" said in tiers.
 *
 * `exact` is the price of that restraint. Where the numbers do not already sit on the band edges
 * the dropdowns claim, the two disagree — a light reading *Dim down to Dark* with `min = 0.6` is
 * off at a scene darkness of 0.55, which is Dim. The hint says so rather than the control
 * pretending otherwise, and picking either dropdown resolves it.
 */
function activationOf(config, minValue, maxValue) {
  const storedFrom = storedTier(config?.activeFrom);
  const storedTo = storedTier(config?.activeTo);
  const stored = storedFrom !== null || storedTo !== null;

  let from = storedFrom ?? tierFromDarkness(minValue);
  let to = storedTo ?? tierFromDarkness(maxValue);
  // Brightest carries the *higher* TIER value, so this is `from >= to`, not the other way.
  if (from < to) [from, to] = [to, from];

  const want = rangeFor(from, to);
  const exact =
    Math.abs(minValue - want.min) <= NEAR && Math.abs(maxValue - want.max) <= NEAR;
  return { from, to, stored, exact };
}

/** Spell levels, with 0 named for what it means rather than numbered. */
function levelChoices(zeroLabel) {
  const out = [{ value: 0, label: t(`LightConfig.SpellLevel.${zeroLabel}`) }];
  for (let i = 1; i <= 9; i++) {
    out.push({ value: i, label: t("LightConfig.SpellLevel.Numbered", { n: i }) });
  }
  return out;
}

/**
 * The fieldset, with empty slots where the native inputs will be moved in.
 *
 * @param {object} config - Current module flags
 * @param {boolean} negative - Is this currently a darkness?
 * @param {?{from: number, to: number}} activation - Tier range, or null if this sheet has no
 *   `darkness.min`/`max` fields to drive (the token sheet does not)
 */
function fieldset(config, negative, activation) {
  const magical = (config.kind ?? "mundane") === "magical";
  const transform = config.transform ?? {};
  const op = transform.op ?? "reduce";
  const emitTier = config.emitTier ?? TIER.NORMAL;

  return `
<fieldset class="${MARKER}">
  <legend>${esc(t("LightConfig.Legend"))}</legend>

  <!--
    **The two values with no control of their own.** \`kind\` is a string the model reads and a
    checkbox in the sheet; \`level\` is one number with two different sets of labels depending on
    the branch. Both are carried by a hidden input that the visible controls drive, so exactly
    one field of each name submits and no junk key ends up in the flag. The alternative — naming
    the visible controls and letting the disabled one drop out — loses the value whenever the
    branch that owns it is the hidden one.
  -->
  <input type="hidden" name="${FLAG}.kind" value="${magical ? "magical" : "mundane"}">
  <input type="hidden" name="${FLAG}.level" value="${esc(config.level ?? 0)}" data-dtype="Number">
  <!--
    \`cancelsDarkness\` is carried too, and for a sharper reason than the other two.
    \`breaks()\` tests it **without** consulting \`kind\` (\`model/contest.mjs:235\`) — unlike
    every other use of \`level\`, which is gated on the light being magical. So a light that was
    once a *daylight* and has since been made mundane would go on annihilating darkness, and a
    *disabled* checkbox does not fix that: \`FormDataExtended\` omits disabled fields by default,
    so the stale \`true\` would simply persist in the flag. The hidden field always submits, and
    \`sync\` writes \`magical && checked\` into it.
  -->
  <input type="hidden" name="${FLAG}.cancelsDarkness" data-dtype="Boolean"
         value="${magical && config.cancelsDarkness ? "true" : "false"}">

  <div class="form-group">
    <label>${esc(t("Common.Preset"))}</label>
    <div class="form-fields">
      ${select(`${FLAG}.preset`, presetChoices(), config.preset ?? CUSTOM)}
    </div>
    <p class="hint">${t("LightConfig.PresetHint")}</p>
  </div>

  <div class="form-group" data-slot="negative">
    <label>${esc(t("LightConfig.Negative"))}</label>
    <div class="form-fields"></div>
    <p class="hint">${t("LightConfig.NegativeHint")}</p>
  </div>

  <div data-branch="light"${negative ? ' class="pf1-lighting-off"' : ""}>
    <div class="form-group">
      <label>${esc(t("LightConfig.Magical"))}</label>
      <div class="form-fields">
        <input type="checkbox" data-drives="${FLAG}.kind"${magical ? " checked" : ""}>
      </div>
      <p class="hint">${t("LightConfig.MagicalHint")}</p>
    </div>

    <div class="form-group" data-needs="magical">
      <label>${esc(t("Common.SpellLevel"))}</label>
      <div class="form-fields">
        ${select(null, levelChoices("Cantrip"), config.level ?? 0, {
          drives: `${FLAG}.level`,
          disabled: !magical,
        })}
      </div>
    </div>

    <div class="form-group" data-needs="magical">
      <label>${t("LightConfig.Daylight")}</label>
      <div class="form-fields">
        <input type="checkbox" data-drives="${FLAG}.cancelsDarkness"${
          config.cancelsDarkness ? " checked" : ""
        }${magical ? "" : " disabled"}>
      </div>
      <p class="hint">${t("LightConfig.DaylightHint")}</p>
    </div>

    <div class="form-group slim">
      <label>${esc(t("LightConfig.Brightness"))}</label>
      <div class="form-fields">
        <label>${esc(t("Common.Level"))}</label>
        ${select(`${FLAG}.emitTier`, tierChoices(), emitTier, { numeric: true })}
        <label>${esc(t("Common.Radius"))}</label>
        <span data-slot="bright"></span>
      </div>
      <p class="hint">${t("LightConfig.BrightnessHint")}</p>
    </div>

    <div class="form-group slim">
      <label>${esc(t("LightConfig.Increase"))}</label>
      <div class="form-fields">
        <label>${esc(t("Common.Radius"))}</label>
        <span data-slot="dim"></span>
        <label>${esc(t("LightConfig.Steps"))}</label>
        <input type="number" name="${FLAG}.steps" value="${esc(config.steps ?? 1)}"
               min="0" max="4" step="1">
        <!-- "Max", not "Maximum" (Hamilcarbarcas, 2026-08-28). Three controls share this row and the
             long label was taking the width the dropdown needed to show its own value. The two
             live in lang/en.json as LightConfig.Max and Presets.Maximum, deliberately separate:
             only this row is cramped. -->
        <label>${esc(t("LightConfig.Max"))}</label>
        ${select(`${FLAG}.cap`, tierChoices(), config.cap ?? emitTier, { numeric: true })}
      </div>
      <p class="hint">${t("LightConfig.IncreaseHint")}</p>
    </div>
  </div>

  <div data-branch="darkness"${negative ? "" : ' class="pf1-lighting-off"'}>
    <div class="form-group slim">
      <label>${esc(t("Common.Radius"))}</label>
      <div class="form-fields">
        <span data-slot="dim-dark"></span>
      </div>
      <p class="hint">${t("LightConfig.DarkRadiusHint")}</p>
    </div>

    <div class="form-group">
      <label>${esc(t("Common.SpellLevel"))}</label>
      <div class="form-fields">
        ${select(null, levelChoices("Mundane"), config.level ?? 2, {
          drives: `${FLAG}.level`,
        })}
      </div>
      <p class="hint">${t("LightConfig.DarkLevelHint")}</p>
    </div>

    <div class="form-group slim">
      <label>${esc(t("LightConfig.Effect"))}</label>
      <div class="form-fields">
        ${select(`${FLAG}.transform.op`, effectChoices(), op)}
        <span data-effect="reduce"${op === "reduce" ? "" : ' class="pf1-lighting-off"'}>
          <input type="number" name="${FLAG}.transform.steps"
                 value="${esc(transform.steps ?? 1)}" min="1" max="4" step="1">
        </span>
        <span data-effect="clamp"${op === "clamp" ? "" : ' class="pf1-lighting-off"'}>
          ${select(`${FLAG}.transform.max`, clampChoices(), transform.max ?? TIER.DARK, {
            numeric: true,
          })}
        </span>
      </div>
      <p class="hint">${t("LightConfig.EffectHint")}</p>
    </div>

    <div class="form-group" data-effect="reduce"${op === "reduce" ? "" : ' class="pf1-lighting-off"'}>
      <label>${esc(t("LightConfig.Floor"))}</label>
      <div class="form-fields">
        ${select(`${FLAG}.floor`, floorChoices(), config.floor ?? TIER.DARK, { numeric: true })}
      </div>
      <p class="hint">${t("LightConfig.FloorHint")}</p>
    </div>
  </div>
${activation ? activationGroup(activation) : ""}
</fieldset>`;
}

/**
 * The activation range, in tiers. DESIGN.md §10.4.1.
 *
 * @remarks
 * **Outside both branches**, because Foundry gates a darkness source on the same field
 * (`light.mjs:148-159` runs before the source is built, so it applies whichever kind this is).
 *
 * The two hidden slots sit outside `.form-fields` deliberately: `styles/config.css` gives
 * `.form-fields > span[data-slot]` `display: contents`, which would override the `hidden`
 * attribute and put the raw 0–1 numbers back on screen beside the dropdowns.
 */
function activationGroup({ from, to, stored, exact }) {
  // **Disabled until the range is this control's to own.** `FormDataExtended` omits disabled
  // fields, so an untouched light that has never been set through here submits no flag at all
  // and stays untouched — the same restraint §10.5.1 applies to scenes. `syncActivation` enables
  // them the moment a dropdown moves.
  const off = stored ? "" : " disabled";
  return `
  <div class="form-group slim">
    <label>${esc(t("LightConfig.Activation.Label"))}</label>
    <div class="form-fields">
      ${select(null, activationChoices(), from, { drives: `${FLAG}.activeFrom` })}
      <label>${esc(t("LightConfig.Activation.DownTo"))}</label>
      ${select(null, activationChoices(), to, { drives: `${FLAG}.activeTo` })}
    </div>
    <span data-slot="darkness-min" hidden></span>
    <span data-slot="darkness-max" hidden></span>
    <input type="hidden" name="${FLAG}.activeFrom" value="${from}" data-dtype="Number"${off}>
    <input type="hidden" name="${FLAG}.activeTo" value="${to}" data-dtype="Number"${off}>
    <p class="hint">${t("LightConfig.Activation.Hint")}${
      // Only for a light this control has never owned. A *stored* range that has drifted is
      // snapped by the first `sync`, so saying it was set by hand would be describing a state
      // the sheet has already corrected.
      stored || exact ? "" : t("LightConfig.Activation.HandSet")
    }</p>
  </div>`;
}

/* -------------------------------------------- */
/*  Injection                                   */
/* -------------------------------------------- */

/** The one field every version of this sheet has, and the anchor for everything else. */
const anchorFor = (root, prefix) => root.querySelector(`[name="${prefix}.dim"]`);

function rowOf(input) {
  return input?.closest(".form-group") ?? null;
}

/**
 * Move a native input into one of our slots and hide the row it came from.
 *
 * @remarks
 * The row is hidden rather than removed. Core built it and core may re-render around it, and a
 * missing node is the sort of thing that turns a cosmetic clash into an exception inside
 * someone else's code.
 */
function relocate(root, name, slot) {
  const input = root.querySelector(`[name="${name}"]`);
  if (!input || !slot) return false;
  const row = rowOf(input);
  slot.replaceChildren(input);
  if (row) row.classList.add(HIDDEN_ROW);
  return true;
}

/**
 * Toggle a group on or off.
 *
 * @remarks
 * A class, not `hidden` and not `style.display`. `hidden` is trivially overridden by any
 * `display` rule the sheet's own stylesheet carries, and writing inline styles means fighting
 * whatever set them last.
 */
function show(node, visible) {
  if (node) node.classList.toggle("pf1-lighting-off", !visible);
}

/**
 * Reflect the current form state: which branch, which fields are live, and what the hidden
 * fields carry.
 *
 * @remarks
 * Idempotent and cheap, and called after every change rather than only after the ones that
 * matter. The alternative — working out which control affects which other one — is a second
 * dependency graph to keep in step with the first.
 */
function sync(root, prefix, changed) {
  const fieldsetEl = root.querySelector(`.${MARKER}`);
  if (!fieldsetEl) return;

  syncActivation(fieldsetEl, prefix, changed);

  const negative = root.querySelector(`[name="${prefix}.negative"]`)?.checked === true;
  const lightBranch = fieldsetEl.querySelector('[data-branch="light"]');
  const darkBranch = fieldsetEl.querySelector('[data-branch="darkness"]');
  show(lightBranch, !negative);
  show(darkBranch, negative);
  syncRadii(fieldsetEl, prefix, negative);

  // The emitter half. `level` and `cancelsDarkness` mean nothing on a mundane light, and
  // disabling rather than hiding says so — a control that vanishes reads as a bug.
  const magical = fieldsetEl.querySelector(`[data-drives="${FLAG}.kind"]`)?.checked === true;
  setHidden(fieldsetEl, `${FLAG}.kind`, magical ? "magical" : "mundane");
  for (const group of fieldsetEl.querySelectorAll('[data-needs="magical"]')) {
    group.classList.toggle("pf1-lighting-dim", !magical);
    for (const field of group.querySelectorAll("input, select")) field.disabled = !magical;
  }

  // `&& magical`, not just the checkbox — see the markup's note. This is the one flag the model
  // reads without first asking whether the light is magical at all.
  const daylight =
    magical &&
    fieldsetEl.querySelector(`[data-drives="${FLAG}.cancelsDarkness"]`)?.checked === true;
  setHidden(fieldsetEl, `${FLAG}.cancelsDarkness`, daylight ? "true" : "false");

  // **The visible branch owns `level`.** Both selects drive the same hidden field, so the one
  // the GM can actually see is the one whose value counts, and the other is brought into line
  // so it reads correctly if the branch is switched.
  const owner = (negative ? darkBranch : lightBranch)?.querySelector(
    `[data-drives="${FLAG}.level"]`
  );
  if (owner) {
    setHidden(fieldsetEl, `${FLAG}.level`, owner.value);
    for (const driver of fieldsetEl.querySelectorAll(`[data-drives="${FLAG}.level"]`)) {
      if (driver !== owner) driver.value = owner.value;
    }
  }

  // The suppressor half: `reduce` takes steps and a floor, `clamp` takes a target level.
  const op = fieldsetEl.querySelector(`[name="${FLAG}.transform.op"]`)?.value ?? "reduce";
  for (const node of fieldsetEl.querySelectorAll("[data-effect]")) {
    show(node, node.dataset.effect === op);
  }

  // **Under `clamp` the target IS the floor, and the model does not make that true by itself.**
  // `applyTransform` ignores `floor` on that branch (correctly — clamping toward a named tier
  // needs no lower bound) while `resolveTier` applies `floor` separately at thresholding. So a
  // darkness *set* to Supernatural Dark yields B = 0, resolves through the default floor of
  // Dark, and comes out Dark. One line in the writer, rather than teaching the model a rule it
  // has no reason to hold. See §10.4.
  if (op === "clamp") {
    const max = fieldsetEl.querySelector(`[name="${FLAG}.transform.max"]`)?.value;
    const floor = fieldsetEl.querySelector(`[name="${FLAG}.floor"]`);
    if (floor && max !== undefined) floor.value = max;
  }
}

/**
 * Drive `darkness.min`/`max` from the two tier dropdowns.
 *
 * @remarks
 * The dropdowns carry no `name`, so nothing but the derived numbers and the two flag carriers
 * reach `FormDataExtended`. The write happens here rather than on submit because
 * `AmbientLightConfig#_onChangeForm` rebuilds a `FormDataExtended` from the live DOM on **every**
 * change and previews it (`ambient-light-config.mjs:163-169`) — our fieldset's listener is inside
 * the form's, so the numbers are already in place by the time core reads them, and the preview
 * light goes out on screen the moment the GM picks a range that excludes the current darkness.
 *
 * **Ordering is enforced here, not left to the schema.** `LightData` refuses
 * `darkness.max < darkness.min` outright (`common/data/data.mjs:68`), which as a failure mode is
 * a validation error on save rather than anything the GM can see coming. Brightest carries the
 * higher `TIER` value, so the valid relation is `from >= to`, and whichever select the GM just
 * moved is the one that keeps its value.
 */
function syncActivation(fieldsetEl, prefix, changed) {
  const fromSel = fieldsetEl.querySelector(`[data-drives="${FLAG}.activeFrom"]`);
  const toSel = fieldsetEl.querySelector(`[data-drives="${FLAG}.activeTo"]`);
  if (!fromSel || !toSel) return;

  // Moving either dropdown is the GM adopting the control; from then on the numbers are ours to
  // keep in step, including on the sheet's first `sync` after a later re-render.
  if (changed === fromSel || changed === toSel) fieldsetEl.dataset.activation = "set";
  if (fieldsetEl.dataset.activation !== "set") return;

  let from = Number(fromSel.value);
  let to = Number(toSel.value);
  if (from < to) {
    if (changed === toSel) from = to;
    else to = from;
    fromSel.value = from;
    toSel.value = to;
  }

  const write = (name, value) => {
    const input = fieldsetEl.querySelector(`[name="${name}"]`);
    if (!input) return;
    input.disabled = false;
    input.value = value;
  };
  write(`${FLAG}.activeFrom`, from);
  write(`${FLAG}.activeTo`, to);

  const { min, max } = rangeFor(from, to);
  write(`${prefix}.darkness.min`, min);
  write(`${prefix}.darkness.max`, max);
}

/**
 * Put the outer-radius input in whichever branch is showing, and keep a darkness honest about
 * how big it is.
 *
 * @remarks
 * **A darkness has one radius, and Foundry decides which one it is.**
 * `PointDarknessSource#_initialize` collapses the pair on every initialise
 * (`point-darkness-source.mjs:117`):
 *
 * ```js
 * this.data.radius = this.data.bright = this.data.dim = Math.max(this.data.dim ?? 0, this.data.bright ?? 0);
 * ```
 *
 * So the document's two values are meaningless for a suppressor except through their maximum,
 * and a control bound to `dim` alone would be **lying** whenever `bright` exceeded it. That is
 * not hypothetical: `{bright: 60, dim: 0}` is the natural way to author *bright out to here*
 * (see `ramp.normaliseEmission`), and flipping such a light to a darkness would give a 60-foot
 * darkness over a Radius field reading 0.
 *
 * The input is **moved** between the two branches rather than duplicated, for the same reason
 * the natives were moved out of core's rows in the first place: two fields sharing a name yield
 * an array.
 *
 * `bright` is then clamped down to it — **only when it exceeds**, which is the one case that
 * needs correcting. An ordinary light has `bright <= dim`, so flipping to a darkness and back
 * leaves its two radii exactly as they were, and the emission settings survive the round trip
 * as designed.
 */
function syncRadii(fieldsetEl, prefix, negative) {
  const dim = fieldsetEl.querySelector(`[name="${prefix}.dim"]`);
  const slot = fieldsetEl.querySelector(
    negative ? '[data-slot="dim-dark"]' : '[data-slot="dim"]'
  );
  if (dim && slot && dim.parentElement !== slot) slot.replaceChildren(dim);
  if (!negative) return;

  const bright = fieldsetEl.querySelector(`[name="${prefix}.bright"]`);
  if (!bright || !dim) return;
  const outer = Number(dim.value);
  if (Number.isFinite(outer) && Number(bright.value) > outer) bright.value = outer;
}

/** Write a value into one of the fieldset's hidden carriers. */
function setHidden(fieldsetEl, name, value) {
  const field = fieldsetEl.querySelector(`input[type="hidden"][name="${name}"]`);
  if (field) field.value = value;
}

/** Write a preset's values into the form. */
function fill(root, name, prefix) {
  const preset = presetTable()[name];
  if (!preset) return;

  const put = (fieldName, value) => {
    for (const field of root.querySelectorAll(`[name="${fieldName}"]`)) {
      if (field.type === "checkbox") field.checked = !!value;
      else field.value = value;
    }
  };

  for (const [key, value] of Object.entries(preset.config)) {
    // `transform` is the one nested value, and the form carries its parts as separate fields.
    if (value && typeof value === "object") {
      for (const [inner, innerValue] of Object.entries(value)) {
        put(`${FLAG}.${key}.${inner}`, innerValue);
      }
      continue;
    }
    put(`${FLAG}.${key}`, value);
  }

  // The driven controls have to be set from the other direction: they carry no `name`, so the
  // loop above never reaches them, and `sync` reads *them* to write the hidden fields — so
  // leaving them stale would undo the preset on the very next call.
  const magical = preset.config.kind === "magical";
  for (const driver of root.querySelectorAll(`[data-drives="${FLAG}.kind"]`)) {
    driver.checked = magical;
  }
  for (const driver of root.querySelectorAll(`[data-drives="${FLAG}.level"]`)) {
    driver.value = preset.config.level ?? 0;
  }
  for (const driver of root.querySelectorAll(`[data-drives="${FLAG}.cancelsDarkness"]`)) {
    driver.checked = !!preset.config.cancelsDarkness;
  }
  // No shipped preset sets an activation range, and one that did would otherwise write the
  // hidden carrier without moving the dropdown that `syncActivation` reads back out of it.
  for (const key of ["activeFrom", "activeTo"]) {
    if (preset.config[key] === undefined) continue;
    for (const driver of root.querySelectorAll(`[data-drives="${FLAG}.${key}"]`)) {
      driver.value = preset.config[key];
    }
    // Choosing that preset is the GM adopting the range, so the carriers have to come off
    // `disabled` — `put` above set their values but a disabled field still does not submit.
    const fieldsetEl = root.querySelector(`.${MARKER}`);
    if (fieldsetEl) fieldsetEl.dataset.activation = "set";
  }

  // Radii are written but not governed (§10.2's `GOVERNED`): applying a preset should fill in a
  // torch's 20/40, and a GM who then drags the radius out to light a bigger room has not
  // stopped placing a torch.
  if (preset.light) {
    for (const [key, value] of Object.entries(preset.light)) put(`${prefix}.${key}`, value);
  }
  put(`${prefix}.negative`, preset.negative);
}

/**
 * Wire the fieldset's own behaviour.
 *
 * @remarks
 * One delegated listener on the fieldset rather than one per control, because the controls come
 * and go with the branch and a per-control listener would have to be re-bound on every sync.
 *
 * **`change` events are re-dispatched, not synthesised into a preview call.** Core's
 * `_onChangeForm` is bound to the form and does the previewing; letting the event bubble to it
 * is what makes a preset selection preview exactly like a hand edit, including
 * `AmbientLightConfig`'s re-render when `config.negative` moves.
 */
function wire(root, prefix) {
  const fieldsetEl = root.querySelector(`.${MARKER}`);
  if (!fieldsetEl) return;

  fieldsetEl.addEventListener("change", (event) => {
    const target = event.target;
    if (!target?.name && !target?.dataset?.drives) return;

    if (target.name === `${FLAG}.preset`) {
      if (target.value !== CUSTOM) {
        fill(root, target.value, prefix);
        sync(root, prefix);
        // Let core preview the whole new state. Dispatched from the `negative` checkbox because
        // that is the name `AmbientLightConfig#_onChangeForm` tests when deciding to re-render
        // the animation and advanced parts, and a preset can flip it.
        const negative = root.querySelector(`[name="${prefix}.negative"]`);
        negative?.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return;
    }

    // Any governed field flips the preset to Custom, and it stays there — §10.2's one-way sync.
    // The driven controls count: they are the visible face of `kind` and `level`.
    const drives = target.dataset?.drives ?? "";
    const governed = GOVERNED.some((key) => {
      const path = `${FLAG}.${key}`;
      return (
        drives === path ||
        target.name === path ||
        target.name?.startsWith(`${path}.`)
      );
    });
    if (governed) {
      const preset = fieldsetEl.querySelector(`[name="${FLAG}.preset"]`);
      if (preset) preset.value = CUSTOM;
    }

    // Activation is deliberately **not** in `GOVERNED`. It says where this particular light is
    // placed and when the GM wants it lit, not what kind of thing it is — the same argument the
    // radii are left ungoverned on. A torch that only burns after dark is still a torch.
    sync(root, prefix, target);
  });

  // The `negative` checkbox lives in our fieldset now but belongs to core, so its own change
  // needs to reach `sync` as well. It bubbles through the same listener — nothing extra needed.
}

/** Build and insert the fieldset. Idempotent. */
function inject(app, element, prefix) {
  const root = element instanceof HTMLElement ? element : element?.[0];
  if (!root) return;
  // Re-renders of other parts leave ours standing; a full render replaces it. Either way, one.
  if (root.querySelector(`.${MARKER}`)) {
    sync(root, prefix);
    return;
  }

  const anchor = anchorFor(root, prefix);
  const host = anchor?.closest("fieldset");
  if (!host) return;

  const config = configOf(app);
  const negative = root.querySelector(`[name="${prefix}.negative"]`)?.checked === true;

  // **Only where core drew the fields.** `templates/scene/token/light.hbs` has no activation
  // range at all, though `LightData` carries one — so on a token sheet there is nothing to
  // relocate and the row is left out rather than rendered with nothing behind it.
  const minInput = root.querySelector(`[name="${prefix}.darkness.min"]`);
  const maxInput = root.querySelector(`[name="${prefix}.darkness.max"]`);
  // Empty means the field's own initial, not zero — `darkness.max` initialises to 1, and
  // `Number("0" || 1)` would answer 1 for a light genuinely set to 0.
  const numberOr = (input, fallback) => {
    const n = Number(input.value);
    return input.value === "" || !Number.isFinite(n) ? fallback : n;
  };
  const activation =
    minInput && maxInput
      ? activationOf(config, numberOr(minInput, 0), numberOr(maxInput, 1))
      : null;

  host.insertAdjacentHTML("afterend", fieldset(config, negative, activation));

  const fieldsetEl = root.querySelector(`.${MARKER}`);
  relocate(root, `${prefix}.bright`, fieldsetEl.querySelector('[data-slot="bright"]'));
  relocate(root, `${prefix}.dim`, fieldsetEl.querySelector('[data-slot="dim"]'));
  relocate(
    root,
    `${prefix}.negative`,
    fieldsetEl.querySelector('[data-slot="negative"] .form-fields')
  );
  if (activation) {
    // Both live in one core row, so the second `relocate` re-hides a row already hidden.
    relocate(root, `${prefix}.darkness.min`, fieldsetEl.querySelector('[data-slot="darkness-min"]'));
    relocate(root, `${prefix}.darkness.max`, fieldsetEl.querySelector('[data-slot="darkness-max"]'));
    // A light already set through this control is ours to keep in step — including snapping a
    // range left stale by a tier-table change the resync pass did not reach.
    if (activation.stored) fieldsetEl.dataset.activation = "set";
  }

  wire(root, prefix);
  sync(root, prefix);
}

/* -------------------------------------------- */
/*  Keeping lights in step with the table       */
/* -------------------------------------------- */

/**
 * Rewrite `darkness.min`/`max` on every light that carries an activation tier.
 *
 * @remarks
 * The same obligation §10.5.1 puts on scenes, for the same reason and with the same guard: the
 * tier is the GM's decision and the numbers are derived output, so moving Dim from 0.67 to 0.80
 * has to carry every light set to *Dim down to Dark* along with it. Lights with no flag are
 * skipped — they were never set through this control.
 *
 * `isWriter` is shared with `ui/scene-config.mjs` rather than reimplemented: a world setting's
 * `onChange` fires on every connected client, so without it players attempt a write they are
 * refused and every GM issues the same one.
 *
 * @param {Scene[]} scenes
 * @returns {Promise<{updated: number, checked: number}>}
 */
export async function syncLights(scenes) {
  const report = { updated: 0, checked: 0 };
  if (!isWriter()) return report;

  for (const scene of scenes ?? []) {
    const updates = [];
    for (const light of scene.lights ?? []) {
      const config = light.flags?.[MODULE_ID]?.config;
      const from = storedTier(config?.activeFrom);
      const to = storedTier(config?.activeTo);
      if (from === null || to === null) continue;
      report.checked++;

      const { min, max } = rangeFor(Math.max(from, to), Math.min(from, to));
      const current = light.config?.darkness ?? {};
      if (
        Math.abs((current.min ?? 0) - min) <= NEAR &&
        Math.abs((current.max ?? 1) - max) <= NEAR
      ) {
        continue;
      }
      updates.push({ _id: light.id, "config.darkness.min": min, "config.darkness.max": max });
    }
    if (updates.length) {
      await scene.updateEmbeddedDocuments("AmbientLight", updates);
      report.updated += updates.length;
    }
  }
  return report;
}

/** Every light in the world that has been given an activation range. */
export const syncAllLights = () => syncLights(game.scenes?.contents ?? []);

/** Debug readout: which lights carry an activation range, and whether their numbers match it. */
export function status() {
  const rows = [];
  for (const scene of game.scenes?.contents ?? []) {
    for (const light of scene.lights ?? []) {
      const config = light.flags?.[MODULE_ID]?.config;
      const from = storedTier(config?.activeFrom);
      const to = storedTier(config?.activeTo);
      if (from === null || to === null) continue;
      const want = rangeFor(Math.max(from, to), Math.min(from, to));
      const current = light.config?.darkness ?? {};
      rows.push({
        scene: scene.name,
        id: light.id,
        range: `${TIER_NAME[from]} → ${TIER_NAME[to]}`,
        stored: [+(current.min ?? 0).toFixed(4), +(current.max ?? 1).toFixed(4)],
        shouldBe: [+want.min.toFixed(4), +want.max.toFixed(4)],
        matches:
          Math.abs((current.min ?? 0) - want.min) <= NEAR &&
          Math.abs((current.max ?? 1) - want.max) <= NEAR,
      });
    }
  }
  const report = { writer: isWriter(), withRange: rows.length, lights: rows };
  console.error(`${MODULE_ID} | light activation ranges`, report);
  return report;
}

/* -------------------------------------------- */

export function registerHooks() {
  Hooks.on("renderAmbientLightConfig", (app, element) => {
    try {
      inject(app, element, "config");
    } catch (error) {
      console.error(`${MODULE_ID} | light config injection failed`, error);
    }
  });

  // One listener for both `TokenConfig` and `PrototypeTokenConfig`: `#callHooks` walks the
  // inheritance chain, so the shared mixin's own class name fires for both
  // (`api/application.mjs:1226-1232`).
  Hooks.on("renderTokenApplication", (app, element) => {
    try {
      inject(app, element, "light");
    } catch (error) {
      console.error(`${MODULE_ID} | token light config injection failed`, error);
    }
  });

  // **Our fields do not preview** — `registry.usable()` excludes previews, because a drag
  // creates a second live source and counting both made the model resolve a scene that did not
  // exist (`model/registry.mjs:190`). The config sheet's preview is the same kind of clone, so
  // the model only sees our values once they are committed, and it has to be told to look.
  // `affectsRegistry` already tests our flag namespace, but a flag-only update fires no
  // `refreshAmbientLight`, so the invalidation is made explicit here.
  Hooks.on("closeAmbientLightConfig", () => registry.invalidate());
  Hooks.on("closeTokenApplication", () => registry.invalidate());

  // The tier table moved: every light with an activation range now stores the wrong numbers.
  // Same two triggers as the scene sync (§10.5.1) — the broadcast for every scene, and
  // `canvasReady` as a safety net for the one being drawn.
  Hooks.on(TABLE_CHANGED_HOOK, () => {
    syncAllLights().then((report) => {
      if (report.updated) {
        console.error(`${MODULE_ID} | light activation ranges re-synced`, report);
      }
    });
  });
  Hooks.on("canvasReady", () => {
    if (canvas?.scene) syncLights([canvas.scene]);
  });
}
