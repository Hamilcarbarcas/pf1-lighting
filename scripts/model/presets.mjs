/**
 * Named light and darkness configurations. DESIGN.md §10.2.
 *
 * **Model, not UI**, for two reasons. The table is PF1's vocabulary rather than a widget's
 * convenience — a GM places a *deeper darkness*, not `level: 3` plus `reduce 2` plus a
 * Supernatural floor, correct and in agreement with each other. And `field.explain` and `probe`
 * should eventually be able to say *"this is a Darkness"* instead of reciting four flags.
 *
 * ## The sync is one way, and the preset is stored
 *
 * Selecting a preset **pre-fills** the fields and nothing more. Changing any field the preset
 * governs flips the record to `custom`, immediately, and it never flips back — setting the
 * values back to a preset's exact numbers leaves it Custom until the preset is chosen again.
 *
 * So there is an {@link applyPreset} and there is deliberately **no matcher**. The stored name
 * answers *"where did these numbers come from"*, which is a fact about history and cannot be
 * recovered by looking at the numbers. Deriving it on render would answer *"what do these
 * numbers currently resemble"* — a different and worse question, which makes a hand-tuned light
 * silently claim to be a torch and changes the label under a GM who never touched the select.
 *
 * **Nothing in the model reads `preset`.** It is provenance for the sheet, so it cannot go stale
 * in a way that changes what anything renders.
 *
 * ## The table is data, and the built-ins are its default
 *
 * {@link BUILT_IN} is what ships. {@link table} is what the sheet reads, and it is a world
 * setting the GM edits through `ui/preset-editor.mjs` — so the numbers below stopped being
 * placeholders-pending-Hamilcarbarcas's-own the moment there was somewhere to type them.
 *
 * **The setting stores the whole table, not a diff against the built-ins**, and it is empty
 * until the editor is saved. Both halves of that matter:
 *
 * - *Empty until saved* means a world that never opens the editor tracks the module's built-ins
 *   as they change, and `resetTable` puts a world back into that state rather than writing the
 *   current defaults out as a snapshot.
 * - *Whole table, not a diff* means that once a world does edit, it owns the lot. A diff would
 *   merge a later change to *Deeper darkness*'s floor into an entry a GM had already retuned,
 *   producing a preset with no author. Overriding one field and inheriting the rest reads as
 *   convenient and behaves as unpredictable, which is the same argument §10.2 makes against a
 *   preset matcher.
 *
 * Editing a preset does **not** reach back into lights already placed from it. That is the
 * one-way sync above, seen from the other side: `applyPreset` writes values at the moment it is
 * chosen, and nothing re-reads the table afterwards. Deleting one is equally harmless — a
 * document left holding a dead key reports Custom, because nothing in the model reads `preset`.
 */

import { MODULE_ID } from "../constants.mjs";
import { TIER } from "./tiers.mjs";

/** The stored value meaning "these numbers came from nowhere in particular". */
export const CUSTOM = "custom";

/**
 * Which config keys a preset governs, and therefore which ones flip the select to Custom.
 *
 * @remarks
 * Radii are **not** here even though a preset writes them. A torch is 20/40 feet, so applying
 * the preset should fill those in — but a GM who drags the radius out to light a bigger room has
 * not stopped placing a torch, and demoting the label for it would be pedantry. The rule that
 * results is worth stating plainly: **a preset writes more than it governs.**
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
 */

/**
 * The table as shipped. Keys are stored verbatim in `config.preset`.
 *
 * @remarks
 * The default for {@link table}, and what {@link resetTable} returns a world to. Not read
 * directly anywhere else — a caller reaching for this instead of `table()` would silently
 * ignore everything the GM configured.
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
      // **`emitTier` never applies and is set to match the cap anyway.** The inner radius is
      // zero, so `contributionAt` only reaches the inner zone at the origin point itself
      // (`ramp.mjs:86`) — a candle sets no light level, it only raises whatever is there.
      //
      // It used to matter that the two agreed, because `normaliseEmission` floored `cap` at
      // `tier` and a higher `emitTier` would silently raise the ceiling. That floor is gone as of
      // 2026-08-28 — `cap` now means what it says — so this is redundancy rather than a
      // constraint. Left matching because a preset that reads oddly invites someone to "fix" it.
      emitTier: TIER.NORMAL,
      steps: 1,
      cap: TIER.NORMAL,
    },
    // No inner zone at all — the whole of a candle is its one-step band.
    light: { bright: 0, dim: 5 },
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
    light: { bright: 20, dim: 40 },
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
    light: { bright: 15, dim: 30 },
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
    // **Radii only — the cone is not expressed.** PF1's bullseye lantern lights a 60-foot
    // *cone*, and a preset could write `angle` here since `applyPreset` copies whatever
    // `light` holds. It deliberately does not: `angle` written by one preset and not the
    // others would leave a light re-presetted from bullseye to torch stuck in a cone. Either
    // every preset carries an angle or none does, and which number a "cone" is worth is a
    // table decision. Set the Angle field by hand after applying this one.
    light: { bright: 60, dim: 120 },
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
    light: { bright: 30, dim: 60 },
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
    light: { bright: 30, dim: 60 },
  },

  continualFlame: {
    label: "Continual flame",
    negative: false,
    config: {
      // **Level 2, and split from *light* since 2026-08-26.** The two used to share one entry
      // labelled "Light / continual flame", which was wrong in the only way that matters here:
      // `level` is what the §4.1 contest weighs against a darkness, so a *continual flame* at
      // level 0 lost to a *darkness* it should out-level.
      kind: "magical",
      level: 2,
      cancelsDarkness: false,
      emitTier: TIER.NORMAL,
      steps: 1,
      cap: TIER.NORMAL,
    },
    light: { bright: 20, dim: 40 },
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
    light: { bright: 20, dim: 40 },
  },

  daylight: {
    label: "Daylight",
    negative: false,
    config: {
      kind: "magical",
      level: 3,
      // The whole point of the preset: *daylight* annihilates with a darkness of its own level
      // or lower rather than merely out-levelling it (§4.1.2).
      cancelsDarkness: true,
      emitTier: TIER.BRIGHT,
      steps: 1,
      cap: TIER.BRIGHT,
    },
    light: { bright: 60, dim: 120 },
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
    light: { bright: 0, dim: 20 },
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
    light: { bright: 0, dim: 60 },
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
    // Never in the flat list: this is a table, and its control surface is the editor. §10.6's
    // menu gets a button to it rather than a row for it.
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
 * Validated on the way out rather than on the way in, because the stored value is a plain object
 * that a macro or a botched merge can reach as easily as the editor can, and a malformed entry
 * must cost a missing row in a select rather than a sheet that fails to render. An entry needs a
 * label and a `config` object; everything else has a defensible default.
 *
 * Not cached. It is read on sheet render and on `applyPreset`, both of which are rare, and a
 * cache here would need invalidating from a setting whose `onChange` does not fire on the client
 * that wrote it in every Foundry version.
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
 * **The key is identity and the label is not.** Renaming a preset must not orphan the documents
 * that recorded where their numbers came from, so this runs once, at creation, and never again
 * on edit. That also means a key can end up reading nothing like its label, which is correct and
 * invisible — the key is never shown.
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
  const out = [{ value: CUSTOM, label: "Custom" }];
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
 * Returns **flat, dotted paths** rather than a nested object, because both consumers want that:
 * `document.update` treats `flags.pf1-lighting.config.level` as a merge into the existing flag
 * rather than a replacement of it, and the sheet's field names are the same strings. Nesting
 * would replace the whole `config` object and silently drop anything the preset does not
 * mention.
 *
 * Radii come back in **scene units**, matching `LightData`, not the pixels the model reads —
 * the conversion is Foundry's and happens well downstream of here.
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

  // `negative` decides which source class the document becomes, so it is not optional the way
  // the radii are — a *darkness* preset on a light that stays positive would configure a
  // suppressor nothing ever reads.
  update[`${prefix}.negative`] = preset.negative;

  if (radii && preset.light) {
    for (const [key, value] of Object.entries(preset.light)) {
      update[`${prefix}.${key}`] = value;
    }
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
