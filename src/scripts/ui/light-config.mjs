/**
 * The lighting controls, injected into the light and token config sheets. DESIGN.md §10.3.
 *
 * ## Inside the Basic tab, not beside it
 *
 * One fieldset between the radius fieldset and whatever follows it, carrying every control
 * including the two radii — not a fourth tab. The module's fields and Foundry's two radii
 * describe one light between them, and the radii no longer mean what their labels say: "Dim
 * Radius" is §3.2.1's *increase* band, nothing to do with dim light. A separate tab leaves that
 * mislabelling standing with its explanation a click away.
 *
 * ## The native inputs are MOVED, not copied
 *
 * `config.bright`, `config.dim` and `config.negative` are real `LightData` paths. A second input
 * with the same `name` is not a mirror: `FormDataExtended` collects same-named fields into a
 * `RadioNodeList` and returns an array (`form-data-extended.mjs:176-183`), so the document would
 * get `[20, 20]` for its bright radius. Relocating the one existing node keeps its value, its
 * binding and core's delegated listeners intact.
 *
 * Their old rows are hidden rather than deleted, so a re-render finds the DOM it expects.
 *
 * ## Built as a string, not a template
 *
 * `foundry.applications.handlebars.renderTemplate` is async and hook callbacks are not awaited,
 * so async injection would leave the sheet visible without the fieldset and race the de-dup
 * guard against a second render. The markup is simple enough that a synchronous build costs
 * nothing.
 *
 * ## …and one of them is shown as a dropdown
 *
 * `config.negative` is a checkbox in core's sheet and a *Type* dropdown in the preset editor;
 * the two forms read as one (2026-08-29). The dropdown names both states rather than only the
 * odd one, and *Darkness source* was the one row where the shared layout scope carried
 * different-looking controls.
 *
 * The checkbox still submits — it moves into a hidden slot and an unnamed `<select>` drives it.
 * Naming the select would put `"darkness"` where a boolean belongs, and a second field of that
 * name returns an array from `FormDataExtended`.
 *
 * ## Light↔darkness swaps by visibility, never by re-render
 *
 * `AmbientLightConfig#_onChangeForm` re-renders exactly `["animation", "advanced"]` on a
 * `config.negative` change (`ambient-light-config.mjs:169`) — never `basic`. So both field groups
 * render and one is hidden.
 *
 * Beyond cheapness: hidden inputs still submit, and the model reads `emitTier`/`steps`/`cap`
 * only for emitters, `transform`/`floor` only for suppressors. A light toggled to darkness and
 * back keeps its emission settings, and the opposite-mode flags are inert by construction.
 *
 * ## The activation range is a tier range (§10.4.1)
 *
 * `config.darkness.min`/`max` gate the source on `canvas.darknessLevel` — a raw `[0,1]` number
 * against a model quantised to four ambient rungs, so §10.5's argument about the scene slider
 * applies: a continuous control offers precision that does not exist. Both inputs move into
 * hidden slots, driven by tier dropdowns.
 *
 * Two easy ways to get the mapping plausibly wrong:
 *
 * - Bands, not points. `darknessTable()[tier]` is the level a tier *paints* at; the levels that
 *   *read* as that tier are `darknessBand(tier)`. Point levels would leave a light set to
 *   *Normal* dark on a scene at darkness 0.30, which the module itself calls Normal.
 * - The ends invert. Low darkness is bright light, so the brightest tier drives `min` and the
 *   darkest drives `max`. Labels are in tiers throughout and never say min/max.
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

/** De-dup marker. Per-feature, never a shared utility class. */
const MARKER = "pf1-lighting-config";

/** Applied to the core rows whose inputs were taken. */
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
 * Three shapes, one function. `AmbientLightConfig` previews into a clone and exposes `preview`;
 * `TokenConfig` and `PrototypeTokenConfig` both answer `token` through their shared mixin, which
 * already resolves to the preview when there is one (`sheets/token/prototype-config.mjs:53-55`).
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
 * `data-dtype="Number"` on every numeric one. A select's value is a string and
 * `FormDataExtended` only casts when told (`form-data-extended.mjs:188`). Without it a tier
 * arrives as `"3"` and `stepTier`'s `tier + steps` concatenates instead of adding — a plausible
 * wrong answer rather than an error.
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
 * Functions, not constants, for `ui/preset-editor.mjs`'s reason: a module-level array is built at
 * import, and `game.i18n` holds no translations until after `init` (see `i18n.mjs`). All of these
 * are called from `fieldset`, which runs on sheet render.
 */
const tierChoice = (tier) => ({ value: tier, label: tierLabel(tier) });

const tierChoices = () => [TIER.DIM, TIER.NORMAL, TIER.BRIGHT].map(tierChoice);

const floorChoices = () => [TIER.DARK, TIER.SUPERNATURAL_DARK].map(tierChoice);

/**
 * Targets a *darkness* may be set to.
 *
 * @remarks
 * Stops at Dim. `clamp` only lowers, so Normal or Bright would offer a darkness that does
 * nothing on all but the brightest ground — a control whose likeliest setting is a no-op.
 */
const clampChoices = () => [TIER.SUPERNATURAL_DARK, TIER.DARK, TIER.DIM].map(tierChoice);

/** `set` and `decrease` are `clamp` and `reduce`; the labels are the GM-facing names. */
const effectChoices = () => [
  { value: "reduce", label: t("LightConfig.Effects.reduce") },
  { value: "clamp", label: t("LightConfig.Effects.clamp") },
];

/**
 * *Light* or *Darkness* — the two words core's `config.negative` checkbox stands for.
 *
 * @remarks
 * A dropdown rather than the native checkbox (2026-08-29), matching the preset editor's *Type*
 * row. The two forms show the same controls in the same order; this was the one row where they
 * disagreed about how to ask the same question — a checkbox reading *Darkness source* beside a
 * dropdown reading *Light / Darkness*. The checkbox still submits; see {@link wire}.
 *
 * Duplicated from `ui/preset-editor.mjs` rather than shared, like `effectChoices` and
 * `tierChoice`, strings included. `lang/en.json` keeps one section per form throughout
 * (`Presets.Magical` and `LightConfig.Magical` are already the same word) so each form reads as a
 * whole to a translator, without cross-references out of it.
 */
const kindChoices = () => [
  { value: "light", label: t("LightConfig.Kind.light") },
  { value: "darkness", label: t("LightConfig.Kind.darkness") },
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

/** Float comparison: the stored number is still the one this control would write. */
const NEAR = 1e-6;

/**
 * A tier range → the `darkness.min`/`max` pair Foundry gates the source on.
 *
 * @remarks
 * Moved to `model/tiers.mjs` (2026-08-29), kept here under its old name. The preset editor needs
 * the same arithmetic, and two copies of a rounding rule is how the sheet and the preset table
 * come to disagree about which tier a light switches on at.
 */
const rangeFor = activationRange;

/** A stored tier, or null if it is not one this control can have written. */
const storedTier = (value) =>
  Number.isFinite(value) && ACTIVATION_TIERS.includes(value) ? value : null;

/**
 * The tier range a light is set to, and whether it was set *through this control*.
 *
 * @remarks
 * Flags first, numbers as fallback — §10.5.1's argument. A light never set through this control
 * shows the nearest rungs so it reads sensibly, and nothing is written until the GM picks one:
 * opening a sheet to change a radius must not quietly move a hand-authored range onto the nearest
 * band edge. Foundry's defaults of `0`/`1` read back as Bright→Dark, which is "always on" in
 * tiers.
 *
 * `exact` is the price of that restraint. Where the numbers do not sit on the band edges the
 * dropdowns claim, the two disagree — a light reading *Dim down to Dark* with `min = 0.6` is off
 * at a scene darkness of 0.55, which is Dim. The hint says so rather than the control pretending
 * otherwise; picking either dropdown resolves it.
 */
function activationOf(config, minValue, maxValue) {
  const storedFrom = storedTier(config?.activeFrom);
  const storedTo = storedTier(config?.activeTo);
  const stored = storedFrom !== null || storedTo !== null;

  let from = storedFrom ?? tierFromDarkness(minValue);
  let to = storedTo ?? tierFromDarkness(maxValue);
  // Brightest carries the higher TIER value, so the valid relation is `from >= to`.
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
 * @param {string} prefix - `config` or `light`, the sheet's own field-name prefix. Needed here
 *   only so the *Type* dropdown can name the checkbox it drives.
 */
function fieldset(config, negative, activation, prefix) {
  const magical = (config.kind ?? "mundane") === "magical";
  const transform = config.transform ?? {};
  const op = transform.op ?? "reduce";
  const emitTier = config.emitTier ?? TIER.NORMAL;

  return `
<!--
  \`pf1-lighting-rows\` is the shared layout scope, carried by this fieldset and the preset
  editor's window alike — see \`styles/config.css\`. \`MARKER\` is the identity class: what
  \`inject\` and \`sync\` find this element by, and what marks it as this module's inside another
  sheet. One says how a row lays out, the other says whose element it is.
-->
<fieldset class="${MARKER} pf1-lighting-rows">
  <legend>${esc(t("LightConfig.Legend"))}</legend>

  <!--
    Two values with no control of their own. \`kind\` is a string to the model and a checkbox in
    the sheet; \`level\` is one number with two label sets depending on the branch. Both ride a
    hidden input the visible controls drive, so exactly one field of each name submits and no junk
    key reaches the flag. Naming the visible controls instead and letting the disabled one drop
    out loses the value whenever the branch that owns it is the hidden one.
  -->
  <input type="hidden" name="${FLAG}.kind" value="${magical ? "magical" : "mundane"}">
  <input type="hidden" name="${FLAG}.level" value="${esc(config.level ?? 0)}" data-dtype="Number">
  <!--
    \`cancelsDarkness\` is carried too, for a sharper reason. \`breaks()\` tests it without
    consulting \`kind\` (\`model/contest.mjs:235\`), unlike every other use of \`level\`, which is
    gated on the light being magical — so a light once a *daylight* and since made mundane would
    go on annihilating darkness. A disabled checkbox does not fix that: \`FormDataExtended\` omits
    disabled fields, so the stale \`true\` persists in the flag. The hidden field always submits,
    and \`sync\` writes \`magical && checked\` into it.
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

  <!--
    Visible control is a dropdown; the field that submits is still core's checkbox.
    \`config.negative\` is a real \`LightData\` path, so the checkbox moves into the hidden slot
    below rather than being replaced — a \`<select name="config.negative">\` hands the document the
    string "darkness", and a second field of that name makes \`FormDataExtended\` return an array.
    The dropdown carries no name and writes the checkbox in \`wire\`.

    Same arrangement as \`ui/scene-config.mjs\`'s light-level row: the native control is kept
    alive and driven, never re-implemented.
  -->
  <div class="form-group">
    <label>${esc(t("LightConfig.Source"))}</label>
    <div class="form-fields">
      ${select(null, kindChoices(), negative ? "darkness" : "light", {
        drives: `${prefix}.negative`,
      })}
    </div>
    <span data-slot="negative" hidden></span>
    <p class="hint">${t("LightConfig.SourceHint")}</p>
  </div>

  <div data-branch="light"${negative ? ' class="pf1-lighting-off"' : ""}>
    <div class="form-group">
      <label>${esc(t("LightConfig.Magical"))}</label>
      <div class="form-fields">
        <input type="checkbox" data-drives="${FLAG}.kind"${magical ? " checked" : ""}>
      </div>
      <p class="hint">${t("LightConfig.MagicalHint")}</p>
    </div>

    <!--
      Both withheld when the light is mundane, not greyed, mirroring the preset editor
      (2026-08-29). Previously pf1-lighting-dim + disabled, on the argument that a vanishing
      control reads as a bug — but switching *Darkness source* already takes a whole branch away,
      so vanishing is this sheet's idiom rather than an exception to it. Safe because neither
      carries a name attribute: both drive a hidden input that always submits, so nothing is lost
      from FormDataExtended by their absence.
    -->
    <div data-needs="magical"${magical ? "" : ' class="pf1-lighting-off"'}>
      <div class="form-group">
        <label>${esc(t("Common.SpellLevel"))}</label>
        <div class="form-fields">
          ${select(null, levelChoices("Cantrip"), config.level ?? 0, {
            drives: `${FLAG}.level`,
          })}
        </div>
      </div>

      <div class="form-group">
        <label>${t("LightConfig.Daylight")}</label>
        <div class="form-fields">
          <input type="checkbox" data-drives="${FLAG}.cancelsDarkness"${
            config.cancelsDarkness ? " checked" : ""
          }>
        </div>
        <p class="hint">${t("LightConfig.DaylightHint")}</p>
      </div>
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
        <!-- Forced, not left to wrapping: the natural break fell between "Max" and its dropdown,
             stranding the label on the row above. Same as the preset editor's. -->
        <span class="pf1-lighting-break"></span>
        <!-- "Max", not "Maximum" (2026-08-28). Three controls shared this row and the long label
             took the width the dropdown needed for its own value. Kept even though the break now
             gives it its own line: lang/en.json holds LightConfig.Max and Presets.Maximum
             separately, so the two are free to differ. -->
        <label>${esc(t("LightConfig.Max"))}</label>
        ${select(`${FLAG}.cap`, tierChoices(), config.cap ?? emitTier, { numeric: true })}
      </div>
      <p class="hint">${t("LightConfig.IncreaseHint")}</p>
    </div>
  </div>

  <div data-branch="darkness"${negative ? "" : ' class="pf1-lighting-off"'}>
    <div class="form-group">
      <label>${esc(t("Common.SpellLevel"))}</label>
      <div class="form-fields">
        ${select(null, levelChoices("Mundane"), config.level ?? 2, {
          drives: `${FLAG}.level`,
        })}
      </div>
      <p class="hint">${t("LightConfig.DarkLevelHint")}</p>
    </div>

    <!--
      One group, two rows: *Effect* owns the radius and the floor, mirroring the preset editor.
      Neither is a decision separate from what the darkness does — the floor is the bottom of the
      same transform, and a darkness has exactly one radius. Both lose their own hints; the
      floor's folds into this group's, where it can also say why the control disappears under
      *set level to*.

      The radius is still the relocated native input. syncRadii and relocate find the slot by
      [data-slot="dim-dark"], so moving the span in the DOM costs them nothing.
    -->
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

        <span class="pf1-lighting-break"></span>

        <span data-effect="reduce"${op === "reduce" ? "" : ' class="pf1-lighting-off"'}>
          <label>${esc(t("LightConfig.Floor"))}</label>
          ${select(`${FLAG}.floor`, floorChoices(), config.floor ?? TIER.DARK, { numeric: true })}
        </span>
        <label>${esc(t("Common.Radius"))}</label>
        <span data-slot="dim-dark"></span>
      </div>
      <p class="hint">${t("LightConfig.EffectHint")}</p>
    </div>
  </div>
${activation ? activationGroup(activation) : ""}
</fieldset>`;
}

/**
 * The activation range, in tiers. DESIGN.md §10.4.1.
 *
 * @remarks
 * Outside both branches, because Foundry gates a darkness source on the same field
 * (`light.mjs:148-159` runs before the source is built, so it applies to either kind).
 *
 * The two hidden slots sit outside `.form-fields` deliberately: `styles/config.css` gives
 * `.form-fields > span[data-slot]` `display: contents`, which overrides the `hidden` attribute
 * and puts the raw 0–1 numbers back on screen beside the dropdowns.
 */
function activationGroup({ from, to, stored, exact }) {
  // Disabled until the range is this control's to own. `FormDataExtended` omits disabled fields,
  // so a light never set through here submits no flag and stays untouched — the restraint §10.5.1
  // applies to scenes. `syncActivation` enables them the moment a dropdown moves.
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
      // Only for a light this control has never owned. A stored range that has drifted is snapped
      // by the first `sync`, so "set by hand" would describe a state already corrected.
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
 * Move a native input into one of the fieldset's slots and hide the row it came from.
 *
 * @remarks
 * Hidden rather than removed. Core built the row and may re-render around it, and a missing node
 * turns a cosmetic clash into an exception inside someone else's code.
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
 * A class, not `hidden` and not `style.display`. `hidden` loses to any `display` rule the sheet's
 * own stylesheet carries, and inline styles mean fighting whatever set them last.
 */
function show(node, visible) {
  if (node) node.classList.toggle("pf1-lighting-off", !visible);
}

/**
 * Reflect the current form state: which branch, which fields are live, and what the hidden
 * fields carry.
 *
 * @remarks
 * Idempotent and cheap, so it runs after every change rather than only the ones that matter.
 * Working out which control affects which other one is a second dependency graph to keep in step
 * with the first.
 */
function sync(root, prefix, changed) {
  const fieldsetEl = root.querySelector(`.${MARKER}`);
  if (!fieldsetEl) return;

  syncActivation(fieldsetEl, prefix, changed);

  const negative = root.querySelector(`[name="${prefix}.negative"]`)?.checked === true;
  // The checkbox is the truth, the dropdown its face, so the dropdown is written from it and not
  // the reverse. That is what lands a preset flipping `negative`, or a core re-render, on the
  // visible control without a second code path.
  const typeSelect = fieldsetEl.querySelector(`select[data-drives="${prefix}.negative"]`);
  if (typeSelect) typeSelect.value = negative ? "darkness" : "light";

  const lightBranch = fieldsetEl.querySelector('[data-branch="light"]');
  const darkBranch = fieldsetEl.querySelector('[data-branch="darkness"]');
  show(lightBranch, !negative);
  show(darkBranch, negative);
  syncRadii(fieldsetEl, prefix, negative);

  // The emitter half. `level` and `cancelsDarkness` mean nothing on a mundane light, so they are
  // taken away rather than greyed (2026-08-29, mirroring the preset editor) — the branch switch
  // two lines above does the same with a whole half of the fieldset.
  //
  // No `disabled` toggle, and none needed: neither control carries a `name`. Both drive a hidden
  // input that always submits, so `FormDataExtended` sees the same fields either way. That is
  // what makes hiding safe here where it would not be for a named field.
  const magical = fieldsetEl.querySelector(`[data-drives="${FLAG}.kind"]`)?.checked === true;
  setHidden(fieldsetEl, `${FLAG}.kind`, magical ? "magical" : "mundane");
  for (const group of fieldsetEl.querySelectorAll('[data-needs="magical"]')) {
    show(group, magical);
  }

  // `&& magical`, not just the checkbox — see the markup's note. The one flag the model reads
  // without first asking whether the light is magical.
  const daylight =
    magical &&
    fieldsetEl.querySelector(`[data-drives="${FLAG}.cancelsDarkness"]`)?.checked === true;
  setHidden(fieldsetEl, `${FLAG}.cancelsDarkness`, daylight ? "true" : "false");

  // The visible branch owns `level`. Both selects drive the same hidden field, so the one the GM
  // can see is the one whose value counts; the other is brought into line so it reads correctly
  // if the branch is switched.
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

  // Under `clamp` the target is the floor, and the model does not make that true by itself.
  // `applyTransform` ignores `floor` on that branch (correctly — clamping toward a named tier
  // needs no lower bound) while `resolveTier` applies `floor` separately at thresholding. So a
  // darkness set to Supernatural Dark yields B = 0, resolves through the default floor of Dark,
  // and comes out Dark. One line in the writer beats teaching the model a rule it has no reason
  // to hold. See §10.4.
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
 * The dropdowns carry no `name`, so only the derived numbers and the two flag carriers reach
 * `FormDataExtended`. Written here rather than on submit because
 * `AmbientLightConfig#_onChangeForm` rebuilds a `FormDataExtended` from the live DOM on every
 * change and previews it (`ambient-light-config.mjs:163-169`); this fieldset's listener is inside
 * the form's, so the numbers are in place before core reads them and the preview light goes out
 * the moment the GM picks a range excluding the current darkness.
 *
 * Ordering is enforced here, not left to the schema. `LightData` refuses
 * `darkness.max < darkness.min` outright (`common/data/data.mjs:68`), which surfaces as a
 * validation error on save rather than anything the GM sees coming. Brightest carries the higher
 * `TIER` value, so the valid relation is `from >= to`, and whichever select the GM just moved
 * keeps its value.
 */
function syncActivation(fieldsetEl, prefix, changed) {
  const fromSel = fieldsetEl.querySelector(`[data-drives="${FLAG}.activeFrom"]`);
  const toSel = fieldsetEl.querySelector(`[data-drives="${FLAG}.activeTo"]`);
  if (!fromSel || !toSel) return;

  // Moving either dropdown is the GM adopting the control; from then on the numbers are kept in
  // step here, including on the sheet's first `sync` after a later re-render.
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
 * A darkness has one radius, and Foundry decides which. `PointDarknessSource#_initialize`
 * collapses the pair on every initialise (`point-darkness-source.mjs:117`):
 *
 * ```js
 * this.data.radius = this.data.bright = this.data.dim = Math.max(this.data.dim ?? 0, this.data.bright ?? 0);
 * ```
 *
 * So for a suppressor the document's two values mean nothing except through their maximum, and a
 * control bound to `dim` alone lies whenever `bright` exceeds it. Not hypothetical:
 * `{bright: 60, dim: 0}` is the natural way to author *bright out to here* (see
 * `ramp.normaliseEmission`), and flipping such a light to a darkness gives a 60-foot darkness
 * over a Radius field reading 0.
 *
 * The input moves between branches rather than being duplicated, for the reason the natives were
 * moved out of core's rows: two fields sharing a name yield an array.
 *
 * `bright` is then clamped down to it, only when it exceeds — the one case needing correction. An
 * ordinary light has `bright <= dim`, so flipping to a darkness and back leaves both radii as
 * they were and the emission settings survive the round trip.
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

  // The driven controls need setting from the other direction: they carry no `name`, so the loop
  // above never reaches them, and `sync` reads them to write the hidden fields — leaving them
  // stale would undo the preset on the next call.
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
    // Choosing that preset is the GM adopting the range, so the carriers come off `disabled` —
    // `put` above set their values, but a disabled field still does not submit.
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
 * One delegated listener on the fieldset rather than one per control: the controls come and go
 * with the branch, so per-control listeners would need re-binding on every sync.
 *
 * `change` events are re-dispatched, not synthesised into a preview call. Core's `_onChangeForm`
 * is bound to the form and does the previewing; letting the event bubble to it makes a preset
 * selection preview exactly like a hand edit, `AmbientLightConfig`'s re-render on a
 * `config.negative` move included.
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
        // that is the name `AmbientLightConfig#_onChangeForm` tests when deciding to re-render the
        // animation and advanced parts, and a preset can flip it.
        const negative = root.querySelector(`[name="${prefix}.negative"]`);
        negative?.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return;
    }

    // The *Type* dropdown writes the checkbox and gets out of the way. The event is dispatched
    // from the checkbox rather than previewed here because core decides whether to re-render the
    // animation and advanced parts by testing `event.target.name` against `config.negative`
    // (`ambient-light-config.mjs:169`) — a name only the real field has. Bubbling makes picking
    // *Darkness* behave exactly as ticking the box did, and the re-entered event drives `sync`.
    if (target.dataset?.drives === `${prefix}.negative`) {
      const box = root.querySelector(`[name="${prefix}.negative"]`);
      if (box) {
        box.checked = target.value === "darkness";
        box.dispatchEvent(new Event("change", { bubbles: true }));
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

    // Activation is deliberately not in `GOVERNED`. It says when the GM wants this particular
    // light lit, not what kind of thing it is — the argument the radii are left ungoverned on. A
    // torch that only burns after dark is still a torch.
    sync(root, prefix, target);
  });

  // The `negative` checkbox now lives in this fieldset but belongs to core, so its own change
  // needs to reach `sync` too. It bubbles through the same listener — nothing extra needed.
}

/** Build and insert the fieldset. Idempotent. */
function inject(app, element, prefix) {
  const root = element instanceof HTMLElement ? element : element?.[0];
  if (!root) return;
  // Re-renders of other parts leave this fieldset standing; a full render replaces it. Either
  // way, one.
  if (root.querySelector(`.${MARKER}`)) {
    sync(root, prefix);
    return;
  }

  const anchor = anchorFor(root, prefix);
  const host = anchor?.closest("fieldset");
  if (!host) return;

  const config = configOf(app);
  const negative = root.querySelector(`[name="${prefix}.negative"]`)?.checked === true;

  // Only where core drew the fields. `templates/scene/token/light.hbs` has no activation range,
  // though `LightData` carries one — so on a token sheet there is nothing to relocate and the row
  // is left out rather than rendered with nothing behind it.
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

  host.insertAdjacentHTML("afterend", fieldset(config, negative, activation, prefix));

  const fieldsetEl = root.querySelector(`.${MARKER}`);
  relocate(root, `${prefix}.bright`, fieldsetEl.querySelector('[data-slot="bright"]'));
  relocate(root, `${prefix}.dim`, fieldsetEl.querySelector('[data-slot="dim"]'));
  // Out of sight, not out of the form: it still submits, still previews, and is still what decides
  // which branch is showing.
  relocate(root, `${prefix}.negative`, fieldsetEl.querySelector('[data-slot="negative"]'));
  if (activation) {
    // Both live in one core row, so the second `relocate` re-hides a row already hidden.
    relocate(root, `${prefix}.darkness.min`, fieldsetEl.querySelector('[data-slot="darkness-min"]'));
    relocate(root, `${prefix}.darkness.max`, fieldsetEl.querySelector('[data-slot="darkness-max"]'));
    // A light already set through this control is kept in step from here — including snapping a
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
 * §10.5.1's obligation on scenes, same reason and same guard: the tier is the GM's decision and
 * the numbers are derived, so moving Dim from 0.67 to 0.80 carries every light set to *Dim down
 * to Dark* with it. Lights with no flag are skipped — never set through this control.
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

  // These fields do not preview. `registry.usable()` excludes previews because a drag creates a
  // second live source, and counting both made the model resolve a scene that did not exist
  // (`model/registry.mjs:190`). The config sheet's preview is the same kind of clone, so the model
  // sees these values only once committed — and has to be told to look. `affectsRegistry` already
  // tests the flag namespace, but a flag-only update fires no `refreshAmbientLight`, so the
  // invalidation is explicit here.
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
