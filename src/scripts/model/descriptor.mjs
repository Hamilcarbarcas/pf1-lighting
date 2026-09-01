/**
 * The per-item light descriptor. DESIGN.md §12.7, §12.13 step 8.
 *
 * One flag shape on an item, whatever its type, so every declarative trigger reads the same record:
 *
 * ```js
 * flags["pf1-lighting"].emits = {
 *   enabled: true,
 *   trigger: "active",              // decided by the item's type, not chosen — see triggerFor
 *   preset: "torch",
 *   light: {}, config: {},          // overrides on top of the preset; no sheet control yet
 *   fuel: { item: "Oil (flask)", hours: 6 },   // "lit" only; omit for indefinite
 * }
 * ```
 *
 * ## Pure on purpose
 *
 * Nothing here applies anything. It reads a flag and answers what it means, which is why both
 * consumers can share it without either importing the other: `model/light-items.resolve` for the
 * *lit* trigger, `model/buff-driver` for the *active* one. The shape is stated once and normalised
 * once, so a half-filled descriptor cannot mean one thing to the picker and another to the driver.
 *
 * ## Normalisation is the substance
 *
 * A sheet submits every field it renders, so a fuel row left blank arrives as `{item: "", hours:
 * null}` rather than as an absence. Read raw, that is a light which consumes an item named "" —
 * which nobody holds, so the picker greys the lantern out and reports it as being out of oil. Every
 * read goes through {@link read}, which drops a fuel entry that names nothing or lasts no time, and
 * that is the difference between "burns indefinitely" and "is broken".
 *
 * A preset the world has since deleted resolves to nothing for the same reason it does in the item
 * table: an entry that no longer resolves is not an error, it is an entry that would light nothing.
 */

import { MODULE_ID } from "../constants.mjs";
import { table as presetTable } from "./presets.mjs";

/** Where a descriptor lives, under this module's flag scope. */
export const EMITS_FLAG = "emits";

/**
 * What makes the light appear. Two, and there will not be a third here.
 *
 * @remarks
 * **The descriptor answers what an object *is*, not what a use *does*** (Hamilcarbarcas,
 * 2026-08-31). A lantern is a light source; a buff is one while it runs. A *darkness* spell is a
 * spell, and what it does to its targets is the caller's business — `api.lights.apply`, or a buff
 * carrying one of these and delivered to the target. An on-use trigger was built and withdrawn for
 * exactly that reason; see DESIGN.md §12.13 step 10 before adding one back.
 */
export const TRIGGER = Object.freeze({ ACTIVE: "active", LIT: "lit" });

/**
 * The trigger an item's type implies.
 *
 * @remarks
 * Derived, never chosen, because there is exactly one answer per type: a buff has an active state
 * and nothing else, a lantern is lit and nothing else. The field is still *stored*, so consumers
 * read one shape and a later trigger needs no migration.
 *
 * @param {Item} item
 * @returns {string|null} A {@link TRIGGER} value, or null for a type with no descriptor
 */
export function triggerFor(item) {
  if (!item) return null;
  if (item.type === "buff") return TRIGGER.ACTIVE;
  if (item.isPhysical) return TRIGGER.LIT;
  return null;
}

/** Does this item type have a descriptor at all? Gates the sheet section. */
export const supports = (item) => triggerFor(item) !== null;

/** The raw flag, whatever state it is in. For the sheet, which has to render a half-filled one. */
export const raw = (item) => item?.getFlag?.(MODULE_ID, EMITS_FLAG) ?? null;

/**
 * A fuel entry, or nothing.
 *
 * @remarks
 * Both halves have to be real. A named item with no duration burns nothing per unit and would
 * consume forever; a duration with no item names nothing to consume. Either way the answer is that
 * this source has no fuel — which is what *everburning* means and is a legitimate thing to be.
 */
function normaliseFuel(fuel) {
  const item = String(fuel?.item ?? "").trim();
  const hours = Number(fuel?.hours);
  if (!item || !(hours > 0)) return null;
  return { item, hours };
}

/**
 * What this item's descriptor says, normalised, or null if it says nothing usable.
 *
 * @param {Item} item
 * @returns {{trigger: string, preset: string, name: string, light: object, config: object,
 *   fuel?: {item: string, hours: number}}|null}
 */
export function read(item) {
  const stored = raw(item);
  if (!stored?.enabled || !stored.preset) return null;
  // A preset the table no longer holds. Same rule as `model/light-items.resolve`: not an error, just
  // an entry that would light nothing.
  if (!presetTable()[stored.preset]) return null;

  // **Derived, never the stored value.** Both triggers follow from the item's type, so a stored one
  // can only be stale — a `"use"` left by the withdrawn build, or a descriptor copied onto an item
  // of another type. Trusting it would put a light on something no sheet could have configured.
  const trigger = triggerFor(item);
  if (!trigger) return null;

  const fuel = trigger === TRIGGER.LIT ? normaliseFuel(stored.fuel) : null;

  return {
    trigger,
    preset: stored.preset,
    name: item.name,
    light: stored.light ?? {},
    config: stored.config ?? {},
    ...(fuel ? { fuel } : {}),
  };
}
