/**
 * Named light and darkness configurations. DESIGN.md §10.2.
 *
 * Model, not UI, for two reasons. The table is PF1's vocabulary rather than a widget's convenience
 * — a GM places a deeper darkness, not `level: 3` plus `reduce 2` plus a Supernatural floor,
 * correct and in agreement with each other. And `field.explain` and `probe` should eventually be
 * able to name a Darkness instead of reciting four flags.
 *
 * The sync is one way, and the preset is stored. Selecting a preset pre-fills the fields and
 * nothing more. Changing any field the preset governs flips the record to `custom` immediately, and
 * it never flips back — setting the values to a preset's exact numbers leaves it Custom until the
 * preset is chosen again.
 *
 * So there is an {@link applyPreset} and deliberately no matcher. The stored name answers where the
 * numbers came from, a fact about history that cannot be recovered by looking at them. Deriving it
 * on render would answer what the numbers currently resemble — a different and worse question,
 * which makes a hand-tuned light silently claim to be a torch and changes the label under a GM who
 * never touched the select.
 *
 * Nothing in the model reads `preset`. It is provenance for the sheet, so it cannot go stale in a
 * way that changes what anything renders.
 *
 * The table is data and the built-ins are its default. {@link BUILT_IN} is what ships; {@link table}
 * is what the sheet reads, a world setting the GM edits through `ui/preset-editor.mjs`.
 *
 * The setting stores the whole table rather than a diff against the built-ins, and is empty until
 * the editor is saved. Both halves matter:
 *
 * - Empty until saved means a world that never opens the editor tracks the module's built-ins as
 *   they change, and `resetTable` returns a world to that state rather than writing the current
 *   defaults out as a snapshot.
 * - Whole table rather than a diff means that once a world edits, it owns the lot. A diff would
 *   merge a later change to Deeper darkness's floor into an entry a GM had already retuned,
 *   producing a preset with no author. Overriding one field and inheriting the rest reads as
 *   convenient and behaves as unpredictable — the argument §10.2 makes against a preset matcher.
 *
 * Editing a preset does not reach back into lights already placed from it: the one-way sync seen
 * from the other side. `applyPreset` writes values when it is chosen and nothing re-reads the table
 * afterwards. Deleting one is equally harmless — a document left holding a dead key reports Custom,
 * nothing in the model reading `preset`.
 */

import { MODULE_ID } from "../constants.mjs";
import { t } from "../i18n.mjs";
import { TIER, activationRange } from "./tiers.mjs";

/** The stored value meaning "these numbers came from nowhere in particular". */
export const CUSTOM = "custom";

/**
 * Which config keys a preset governs, and therefore which ones flip the select to Custom.
 *
 * @remarks
 * Radii are absent even though a preset writes them. A torch is 20/40 feet, so applying the preset
 * fills those in — but a GM dragging the radius out to light a bigger room has not stopped placing
 * a torch, and demoting the label for it would be pedantry. The resulting rule: a preset writes
 * more than it governs.
 */
export const GOVERNED = Object.freeze([
  "kind",
  "level",
  "cancelsDarkness",
  "emitTier",
  "steps",
  "cap",
  "transform",
  "floor",
]);

/**
 * @typedef {object} Preset
 * @property {string} label      - What the select shows
 * @property {boolean} negative  - Is this a darkness? Decides which branch of the sheet applies
 * @property {object} config     - Flag values to write under `flags.pf1-lighting.config`
 * @property {object} [light]    - Native `LightData` values to write alongside, in **feet**
 * @property {object} [placement] - `AmbientLightDocument` root fields (`rotation`, `walls`,
 *   `vision`). Written only for an ambient light; a token's light has no home for them.
 */

/* -------------------------------------------- */
/*  Appearance (§12.13 step 5)                  */
/* -------------------------------------------- */

/**
 * **Every preset states every appearance field, or none may state any.**
 *
 * @remarks
 * `applyPreset` copies whatever `preset.light` holds and writes nothing for what it omits, so a
 * field one preset sets and another leaves out *persists across a change of preset*. Re-preset a
 * torch to a sunrod and it stays orange; the light claims to be a sunrod and is not one.
 *
 * This is the same trap the bullseye lantern's cone is left out for — see `lanternBullseye` below,
 * which has carried the argument since before there was anything to apply it to — and the same shape
 * as `render/pool.mjs`'s rule that every property a pooled source can carry must be assigned on
 * every fill, a default of "leave whatever the last tenant set" never being right. Three separate
 * instances of one mistake, so it is worth stating as a rule rather than as a caution.
 *
 * The consequence is that {@link NEUTRAL} exists: a preset with nothing to say about colour says so
 * explicitly. `color: null` is a real `LightData` value meaning *untinted*, not an absence.
 *
 * `angle` is still **not** here, and now for a second reason as well as the first: §12.8 gives it to
 * the item table, where a bullseye lantern is always a bullseye lantern.
 */
export const APPEARANCE = Object.freeze(["color", "alpha", "attenuation", "animation"]);

/** No animation, spelled out. Assigning this is what stops a previous preset's flicker persisting. */
const STILL = Object.freeze({ type: null, speed: 5, intensity: 5, reverse: false });

/** A flame. `torch` is Foundry's *Flickering Light*; `flame` is its *Torch* (`client/config.mjs:753`). */
const flicker = (speed, intensity) => Object.freeze({ type: "torch", speed, intensity, reverse: false });

/** What a preset with no opinion about its appearance writes. */
const NEUTRAL = Object.freeze({ color: null, alpha: 0.5, attenuation: 0.5, animation: STILL });

/**
 * The table as shipped. Keys are stored verbatim in `config.preset`.
 *
 * @remarks
 * The default for {@link table}, and what {@link resetTable} returns a world to. Not read directly
 * anywhere else: a caller reaching for this instead of `table()` would silently ignore everything
 * the GM configured.
 *
 * @type {Record<string, Preset>}
 */
export const BUILT_IN = Object.freeze({
  candle: {
    label: "Candle",
    negative: false,
    config: {
      kind: "mundane",
      level: 0,
      cancelsDarkness: false,
      // `emitTier` never applies and matches the cap anyway. The inner radius is zero, so
      // `contributionAt` reaches the inner zone only at the origin point itself (`ramp.mjs:86`) —
      // a candle sets no light level, it only raises whatever is there.
      //
      // It used to matter that the two agreed, `normaliseEmission` having floored `cap` at `tier`
      // so a higher `emitTier` silently raised the ceiling. That floor went on 2026-08-28 and `cap`
      // now means what it says, so this is redundancy rather than a constraint. Left matching
      // because a preset that reads oddly invites a fix.
      emitTier: TIER.NORMAL,
      steps: 1,
      cap: TIER.NORMAL,
    },
    // No inner zone at all — the whole of a candle is its one-step band.
    light: { bright: 0, dim: 5, color: "#ff9329", alpha: 0.22, attenuation: 0.65, animation: flicker(2, 2) },
  },

  torch: {
    label: "Torch",
    negative: false,
    config: {
      kind: "mundane",
      level: 0,
      cancelsDarkness: false,
      emitTier: TIER.NORMAL,
      steps: 1,
      cap: TIER.NORMAL,
    },
    light: { bright: 20, dim: 40, color: "#ff9329", alpha: 0.32, attenuation: 0.5, animation: flicker(3, 3) },
  },

  lampCommon: {
    label: "Lamp, common",
    negative: false,
    config: {
      kind: "mundane",
      level: 0,
      cancelsDarkness: false,
      emitTier: TIER.NORMAL,
      steps: 1,
      cap: TIER.NORMAL,
    },
    light: { bright: 15, dim: 30, color: "#ffb066", alpha: 0.3, attenuation: 0.5, animation: flicker(1, 1) },
  },

  lanternBullseye: {
    label: "Lantern, bullseye",
    negative: false,
    config: {
      kind: "mundane",
      level: 0,
      cancelsDarkness: false,
      emitTier: TIER.NORMAL,
      steps: 1,
      cap: TIER.NORMAL,
    },
    // Radii only; the cone is not expressed. PF1's bullseye lantern lights a 60-foot cone, and a
    // preset could write `angle` here since `applyPreset` copies whatever `light` holds. It
    // deliberately does not: `angle` written by one preset and not the others would leave a light
    // re-presetted from bullseye to torch stuck in a cone. Either every preset carries an angle or
    // none does, and what a cone is worth is a table decision. Set Angle by hand after applying
    // this one.
    light: { bright: 60, dim: 120, color: "#ffd6a0", alpha: 0.3, attenuation: 0.4, animation: STILL },
  },

  lanternHooded: {
    label: "Lantern, hooded",
    negative: false,
    config: {
      kind: "mundane",
      level: 0,
      cancelsDarkness: false,
      emitTier: TIER.NORMAL,
      steps: 1,
      cap: TIER.NORMAL,
    },
    light: { bright: 30, dim: 60, color: "#ffb066", alpha: 0.3, attenuation: 0.5, animation: STILL },
  },

  sunrod: {
    label: "Sunrod",
    negative: false,
    config: {
      kind: "mundane",
      level: 0,
      cancelsDarkness: false,
      emitTier: TIER.NORMAL,
      steps: 1,
      cap: TIER.NORMAL,
    },
    light: { bright: 30, dim: 60, color: "#cfe4ff", alpha: 0.35, attenuation: 0.5, animation: STILL },
  },

  continualFlame: {
    label: "Continual flame",
    negative: false,
    config: {
      // Level 2, split from light on 2026-08-26. The two shared one entry labelled Light /
      // continual flame, wrong in the way that matters here: `level` is what the §4.1 contest
      // weighs against a darkness, so a continual flame at level 0 lost to a darkness it should
      // out-level.
      kind: "magical",
      level: 2,
      cancelsDarkness: false,
      emitTier: TIER.NORMAL,
      steps: 1,
      cap: TIER.NORMAL,
    },
    light: { bright: 20, dim: 40, color: "#b8d8ff", alpha: 0.35, attenuation: 0.5, animation: flicker(2, 2) },
  },

  light: {
    label: "Light",
    negative: false,
    config: {
      kind: "magical",
      level: 0,
      cancelsDarkness: false,
      emitTier: TIER.NORMAL,
      steps: 1,
      cap: TIER.NORMAL,
    },
    light: { bright: 20, dim: 40, ...NEUTRAL },
  },

  daylight: {
    label: "Daylight",
    negative: false,
    config: {
      kind: "magical",
      level: 3,
      // The point of the preset: daylight annihilates with a darkness of its own level or lower
      // rather than merely out-levelling it (§4.1.2).
      cancelsDarkness: true,
      emitTier: TIER.BRIGHT,
      steps: 1,
      cap: TIER.BRIGHT,
    },
    light: { bright: 60, dim: 120, color: "#fff4e0", alpha: 0.4, attenuation: 0.5, animation: STILL },
  },

  darkness: {
    label: "Darkness",
    negative: true,
    config: {
      kind: "magical",
      level: 2,
      transform: { op: "reduce", steps: 1 },
      floor: TIER.DARK,
    },
    light: { bright: 0, dim: 20, ...NEUTRAL },
  },

  deeperDarkness: {
    label: "Deeper darkness",
    negative: true,
    config: {
      kind: "magical",
      level: 3,
      transform: { op: "reduce", steps: 2 },
      floor: TIER.SUPERNATURAL_DARK,
    },
    light: { bright: 0, dim: 60, ...NEUTRAL },
  },
});

/* -------------------------------------------- */
/*  The table as a setting                      */
/* -------------------------------------------- */

export const SETTING_TABLE = "presetTable";

/** The hook fired when the stored table changes, so open sheets can rebuild their selects. */
export const TABLE_CHANGED_HOOK = `${MODULE_ID}.presetsChanged`;

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTING_TABLE, {
    // Never in the flat list: this is a table, and its control surface is the editor. §10.6's menu
    // gets a button to it rather than a row for it.
    scope: "world",
    config: false,
    type: Object,
    default: {},
    onChange: () => Hooks.callAll(TABLE_CHANGED_HOOK, table()),
  });
}

/**
 * The table in force.
 *
 * @remarks
 * Validated on the way out rather than the way in: the stored value is a plain object a macro or a
 * botched merge can reach as easily as the editor can, and a malformed entry must cost a missing
 * row in a select rather than a sheet that fails to render. An entry needs a label and a `config`
 * object; everything else has a defensible default.
 *
 * Not cached. It is read on sheet render and on `applyPreset`, both rare, and a cache would need
 * invalidating from a setting whose `onChange` does not fire on the writing client in every Foundry
 * version.
 *
 * @returns {Record<string, Preset>}
 */
export function table() {
  let stored;
  try {
    stored = game.settings.get(MODULE_ID, SETTING_TABLE);
  } catch {
    return BUILT_IN;
  }
  if (!stored || typeof stored !== "object" || !Object.keys(stored).length) return BUILT_IN;

  const out = {};
  for (const [key, preset] of Object.entries(stored)) {
    if (!preset || typeof preset !== "object") continue;
    if (typeof preset.label !== "string" || !preset.label) continue;
    if (!preset.config || typeof preset.config !== "object") continue;
    out[key] = {
      label: preset.label,
      negative: preset.negative === true,
      config: preset.config,
      light: preset.light && typeof preset.light === "object" ? preset.light : undefined,
      placement:
        preset.placement && typeof preset.placement === "object" ? preset.placement : undefined,
    };
  }
  return Object.keys(out).length ? out : BUILT_IN;
}

/**
 * Replace the stored table.
 *
 * @param {Record<string, Preset>|null} next - `null` restores the built-ins
 */
export async function setTable(next) {
  return game.settings.set(MODULE_ID, SETTING_TABLE, next ?? {});
}

/** Put this world back on the module's built-in table. */
export const resetTable = () => setTable(null);

/**
 * A key that is not taken, derived from a label.
 *
 * @remarks
 * The key is identity and the label is not. Renaming a preset must not orphan the documents that
 * recorded where their numbers came from, so this runs once at creation and never again on edit.
 * That means a key can end up reading nothing like its label, which is correct and invisible — the
 * key is never shown.
 *
 * @param {string} label
 * @param {Record<string, unknown>} existing
 * @returns {string}
 */
export function newKey(label, existing = {}) {
  const base =
    String(label ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(" ")
      .map((word, i) => (i === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
      .join("") || "preset";

  if (base !== CUSTOM && !(base in existing)) return base;
  let n = 2;
  while (`${base}${n}` in existing) n++;
  return `${base}${n}`;
}

/* -------------------------------------------- */
/*  Consumers                                   */
/* -------------------------------------------- */

/**
 * Options for a select, Custom first.
 *
 * @param {boolean} [negative] - Restrict to darkness or to light presets; omit for all
 * @returns {{value: string, label: string}[]}
 */
export function presetChoices(negative) {
  // `Custom` is translated and the preset labels are not, and the line between them is storage.
  // This entry is chrome — it means not-from-a-preset and is never written anywhere. A preset's
  // label is seed data for an editable world setting: translate it and the first GM to press Save
  // in the editor persists a translation into their world's table, where it stops following the
  // language. See `BUILT_IN`.
  const out = [{ value: CUSTOM, label: t("Presets.Custom") }];
  for (const [value, preset] of Object.entries(table())) {
    if (negative !== undefined && preset.negative !== negative) continue;
    out.push({ value, label: preset.label });
  }
  return out;
}

/**
 * The update a preset expands to, ready for `document.update` or `FormDataExtended`.
 *
 * @remarks
 * Returns flat dotted paths rather than a nested object, because both consumers want that:
 * `document.update` treats `flags.pf1-lighting.config.level` as a merge into the existing flag
 * rather than a replacement, and the sheet's field names are the same strings. Nesting would
 * replace the whole `config` object and silently drop anything the preset does not mention.
 *
 * Radii come back in scene units, matching `LightData`, not the pixels the model reads — the
 * conversion is Foundry's and happens well downstream.
 *
 * @param {string} name - A key of {@link table}, or {@link CUSTOM}
 * @param {object} [options]
 * @param {string} [options.prefix="config"] - `"config"` for an AmbientLight, `"light"` for a
 *   token's light. The flag path is the same either way; only the native fields move.
 * @param {boolean} [options.radii=true] - Write the preset's radii too
 * @returns {Record<string, any>} Empty for Custom, which changes nothing by design
 */
export function applyPreset(name, { prefix = "config", radii = true } = {}) {
  const preset = table()[name];
  if (!preset) return {};

  const update = { [`flags.pf1-lighting.config.preset`]: name };
  for (const [key, value] of Object.entries(preset.config)) {
    update[`flags.pf1-lighting.config.${key}`] = value;
  }

  // `negative` decides which source class the document becomes, so it is not optional the way the
  // radii are — a darkness preset on a light that stays positive would configure a suppressor
  // nothing ever reads.
  update[`${prefix}.negative`] = preset.negative;

  if (radii && preset.light) {
    for (const [key, value] of Object.entries(preset.light)) {
      update[`${prefix}.${key}`] = value;
    }
  }

  // `placement` holds the fields that live at an `AmbientLightDocument`'s **root** rather than
  // inside its `config` — rotation, walls, vision (§10.2.2). They are written only for an ambient
  // light: a `TokenDocument` has no `walls` on its light and takes its rotation from the token, so
  // writing `light.rotation` there would put a key into `LightData` that is not one of its fields.
  //
  // `angle` is not among them and never will be: it *is* `LightData`, so it rides in `light` with
  // the radii and reaches a token's light correctly.
  if (prefix === "config" && preset.placement) {
    for (const [key, value] of Object.entries(preset.placement)) {
      update[key] = value;
    }
  }

  // The activation range is stored as two tiers and written as two raw numbers (§10.4.1).
  // `activeFrom`/`activeTo` are only a memo, so the sheet's dropdowns can be restored to what was
  // chosen; what Foundry gates the source on is `darkness.min`/`max`. Deriving them here rather
  // than storing them means a preset follows the tier table when the GM retunes how bright each
  // level is.
  //
  // Absence means always, and is left alone. A preset carrying no range — every built-in one —
  // writes neither field, so applying it does not disturb a range the GM set by hand on that light.
  // The editor expresses always by omitting the pair rather than storing the full ladder, which
  // would resolve to `{min: 0, max: 1}` and overwrite.
  const { activeFrom, activeTo } = preset.config ?? {};
  if (Number.isFinite(activeFrom) && Number.isFinite(activeTo)) {
    const { min, max } = activationRange(Math.max(activeFrom, activeTo), Math.min(activeFrom, activeTo));
    update[`${prefix}.darkness.min`] = min;
    update[`${prefix}.darkness.max`] = max;
  }

  return update;
}

/**
 * The label to show for a stored preset value.
 *
 * @param {string} [name]
 * @returns {string}
 */
export function presetLabel(name) {
  return table()[name]?.label ?? "Custom";
}
