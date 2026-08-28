/**
 * The lighting controls, injected into the light and token config sheets. DESIGN.md §10.3.
 *
 * ## Inside the Basic tab, not beside it
 *
 * The first plan was a fourth tab on `AmbientLightConfig`. Patrick's objection settled it, and
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
 */

import { MODULE_ID } from "../constants.mjs";
import { CUSTOM, GOVERNED, presetChoices, table as presetTable } from "../model/presets.mjs";
import { TIER } from "../model/tiers.mjs";
import * as registry from "../model/registry.mjs";

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

const TIER_CHOICES = [
  { value: TIER.DIM, label: "Dim" },
  { value: TIER.NORMAL, label: "Normal" },
  { value: TIER.BRIGHT, label: "Bright" },
];

const FLOOR_CHOICES = [
  { value: TIER.DARK, label: "Dark" },
  { value: TIER.SUPERNATURAL_DARK, label: "Supernatural Dark" },
];

/**
 * Targets a *darkness* may be set to.
 *
 * @remarks
 * Deliberately stops at Dim. `clamp` only ever lowers, so offering Normal or Bright would offer
 * a darkness that does nothing on all but the brightest ground — a control whose most likely
 * setting is a no-op.
 */
const CLAMP_CHOICES = [
  { value: TIER.SUPERNATURAL_DARK, label: "Supernatural Dark" },
  { value: TIER.DARK, label: "Dark" },
  { value: TIER.DIM, label: "Dim" },
];

/** `set` and `decrease` are `clamp` and `reduce`; the labels are the GM-facing names. */
const EFFECT_CHOICES = [
  { value: "reduce", label: "Decrease by" },
  { value: "clamp", label: "Set level to" },
];

/** Spell levels, with 0 named for what it means rather than numbered. */
function levelChoices(zeroLabel) {
  const out = [{ value: 0, label: zeroLabel }];
  for (let i = 1; i <= 9; i++) out.push({ value: i, label: `Level ${i}` });
  return out;
}

/**
 * The fieldset, with empty slots where the native inputs will be moved in.
 *
 * @param {object} config - Current module flags
 * @param {boolean} negative - Is this currently a darkness?
 */
function fieldset(config, negative) {
  const magical = (config.kind ?? "mundane") === "magical";
  const transform = config.transform ?? {};
  const op = transform.op ?? "reduce";
  const emitTier = config.emitTier ?? TIER.NORMAL;

  return `
<fieldset class="${MARKER}">
  <legend>Lighting Configuration</legend>

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
    <label>Preset</label>
    <div class="form-fields">
      ${select(`${FLAG}.preset`, presetChoices(), config.preset ?? CUSTOM)}
    </div>
    <p class="hint">Fills in the fields below. Changing any of them afterwards sets this back to
      Custom, and it stays Custom until a preset is chosen again.</p>
  </div>

  <div class="form-group" data-slot="negative">
    <label>Darkness source</label>
    <div class="form-fields"></div>
    <p class="hint">A darkness lowers the light level in its area instead of raising it.</p>
  </div>

  <div data-branch="light"${negative ? ' class="pf1-lighting-off"' : ""}>
    <div class="form-group">
      <label>Magical</label>
      <div class="form-fields">
        <input type="checkbox" data-drives="${FLAG}.kind"${magical ? " checked" : ""}>
      </div>
      <p class="hint">Magical light of a higher level than a darkness overrides it.</p>
    </div>

    <div class="form-group" data-needs="magical">
      <label>Spell level</label>
      <div class="form-fields">
        ${select(null, levelChoices("Level 0 (cantrip)"), config.level ?? 0, {
          drives: `${FLAG}.level`,
          disabled: !magical,
        })}
      </div>
    </div>

    <div class="form-group" data-needs="magical">
      <label>Counts as <em>daylight</em></label>
      <div class="form-fields">
        <input type="checkbox" data-drives="${FLAG}.cancelsDarkness"${
          config.cancelsDarkness ? " checked" : ""
        }${magical ? "" : " disabled"}>
      </div>
      <p class="hint">Annihilates with a darkness of its own level or lower — both effects
        vanish where they overlap.</p>
    </div>

    <div class="form-group slim">
      <label>Brightness</label>
      <div class="form-fields">
        <label>Level</label>
        ${select(`${FLAG}.emitTier`, TIER_CHOICES, emitTier, { numeric: true })}
        <label>Radius</label>
        <span data-slot="bright"></span>
      </div>
      <p class="hint">The level this light provides outright, out to that radius.</p>
    </div>

    <div class="form-group slim">
      <label>Increase brightness</label>
      <div class="form-fields">
        <label>Radius</label>
        <span data-slot="dim"></span>
        <label>Steps</label>
        <input type="number" name="${FLAG}.steps" value="${esc(config.steps ?? 1)}"
               min="0" max="4" step="1">
        <label>Maximum</label>
        ${select(`${FLAG}.cap`, TIER_CHOICES, config.cap ?? emitTier, { numeric: true })}
      </div>
      <p class="hint">Beyond the inner radius the light raises whatever level is already there
        by that many steps, never past the maximum.</p>
    </div>
  </div>

  <div data-branch="darkness"${negative ? "" : ' class="pf1-lighting-off"'}>
    <div class="form-group slim">
      <label>Radius</label>
      <div class="form-fields">
        <span data-slot="dim-dark"></span>
      </div>
      <p class="hint">A darkness has one radius. It is the same field as the light's outer
        radius, moved here.</p>
    </div>

    <div class="form-group">
      <label>Spell level</label>
      <div class="form-fields">
        ${select(null, levelChoices("Mundane / unlit area"), config.level ?? 2, {
          drives: `${FLAG}.level`,
        })}
      </div>
      <p class="hint">Level 0 darkens without blinding — an unlit cellar, which you can still
        see out of. Level 1 and above cast an umbra.</p>
    </div>

    <div class="form-group slim">
      <label>Effect</label>
      <div class="form-fields">
        ${select(`${FLAG}.transform.op`, EFFECT_CHOICES, op)}
        <span data-effect="reduce"${op === "reduce" ? "" : ' class="pf1-lighting-off"'}>
          <input type="number" name="${FLAG}.transform.steps"
                 value="${esc(transform.steps ?? 1)}" min="1" max="4" step="1">
        </span>
        <span data-effect="clamp"${op === "clamp" ? "" : ' class="pf1-lighting-off"'}>
          ${select(`${FLAG}.transform.max`, CLAMP_CHOICES, transform.max ?? TIER.DARK, {
            numeric: true,
          })}
        </span>
      </div>
      <p class="hint"><em>Set level to</em> never brightens: over ground that is already darker,
        it leaves it alone.</p>
    </div>

    <div class="form-group" data-effect="reduce"${op === "reduce" ? "" : ' class="pf1-lighting-off"'}>
      <label>Floor</label>
      <div class="form-fields">
        ${select(`${FLAG}.floor`, FLOOR_CHOICES, config.floor ?? TIER.DARK, { numeric: true })}
      </div>
      <p class="hint">The darkest this can drive an area. Only a <em>deeper darkness</em> and
        its like should reach Supernatural Dark.</p>
    </div>
  </div>
</fieldset>`;
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
function sync(root, prefix) {
  const fieldsetEl = root.querySelector(`.${MARKER}`);
  if (!fieldsetEl) return;

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

    sync(root, prefix);
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
  host.insertAdjacentHTML("afterend", fieldset(config, negative));

  const fieldsetEl = root.querySelector(`.${MARKER}`);
  relocate(root, `${prefix}.bright`, fieldsetEl.querySelector('[data-slot="bright"]'));
  relocate(root, `${prefix}.dim`, fieldsetEl.querySelector('[data-slot="dim"]'));
  relocate(
    root,
    `${prefix}.negative`,
    fieldsetEl.querySelector('[data-slot="negative"] .form-fields')
  );

  wire(root, prefix);
  sync(root, prefix);
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
}
