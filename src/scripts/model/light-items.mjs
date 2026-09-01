/**
 * Light-bearing items, their fuel, and the burn clock. DESIGN.md §12.8, §12.13 step 7.
 *
 * A lantern is the thing that carries the light; a flask of oil is what it burns. An everburning
 * torch carries the light and burns nothing. So an entry names **a preset**, optionally **a
 * consumable**, and **how long one unit of that consumable lasts** — and that is the whole schema,
 * because everything about how the light looks or reaches comes from the preset (§10.2.2).
 *
 * ## The table is the default; an item's own descriptor is the override
 *
 * Keyed by item name, which torch's own README concedes the cost of: play in another language and
 * you write your own table. Both halves of that are true and they are not in conflict — the table
 * gives a freshly dragged core *Torch* the right behaviour with no configuration, and
 * `flags["pf1-lighting"].emits` on the item wins wherever a GM has been specific
 * (`model/descriptor`, edited from the item sheet's Advanced tab). Name matching as a *fallback*
 * costs nothing; name matching as the *only* route was torch's mistake.
 *
 * ## The fuel clock derives, and only persists a remainder
 *
 * Two pieces of state on two documents, because they have different lifetimes:
 *
 * | Where | What | Lives |
 * | --- | --- | --- |
 * | the effect record | `litAt`, `fuel.consumed` | this burn |
 * | **the light item's flags** | `burn.carried` — seconds into the current unit | across burns |
 *
 * While lit nothing accumulates: `total = carried + (worldTime - litAt)` and `due = floor(total /
 * unitSeconds)`. On extinguish, and only then, the remainder is written back. An accumulating
 * counter would double-count when two clients see one `updateWorldTime` and lose time across a
 * reload; deriving *within* a burn and persisting only *between* burns puts the idempotence where
 * the repeated events are and the memory where it is needed.
 *
 * **That is what makes partial use survive.** A hooded lantern lit for half an hour and doused
 * carries 1800 seconds; lit again three days later it burns thirty more minutes before the next
 * flask goes. A ten-minute torch relit four times is consumed on the fifth. Same arithmetic; only
 * `unitSeconds` differs.
 */

import { MODULE_ID } from "../constants.mjs";
import { table as presetTable } from "./presets.mjs";
import * as descriptor from "./descriptor.mjs";
import * as socket from "../socket.mjs";
import { isWriter } from "../ui/scene-config.mjs";

export const SETTING_ITEMS = "lightItems";
export const SETTING_CONSUMPTION = "fuelConsumption";

/** Where a part-burnt unit is remembered, on the **light item**. */
export const BURN_FLAG = "burn";

const HOUR = 3600;

/**
 * The table as shipped — PF1's core light sources, at RAW burn times.
 *
 * @remarks
 * `fuel.item` naming the light item itself is how a self-consuming source is expressed: a torch is
 * its own fuel, so burning one out decrements the stack of torches. A lantern names something else.
 * An entry with no `fuel` burns forever, which is what *everburning* means.
 *
 * @type {Record<string, {preset: string, fuel?: {item: string, hours: number}, aliases?: string[]}>}
 */
export const BUILT_IN_ITEMS = Object.freeze({
  Torch: { preset: "torch", fuel: { item: "Torch", hours: 1 }, aliases: ["Torches"] },
  Candle: { preset: "candle", fuel: { item: "Candle", hours: 1 }, aliases: ["Candles"] },
  Lamp: { preset: "lampCommon", fuel: { item: "Oil (flask)", hours: 6 }, aliases: ["Lamp, common"] },
  "Lantern, hooded": { preset: "lanternHooded", fuel: { item: "Oil (flask)", hours: 6 } },
  "Lantern, bullseye": { preset: "lanternBullseye", fuel: { item: "Oil (flask)", hours: 6 } },
  Sunrod: { preset: "sunrod", fuel: { item: "Sunrod", hours: 6 } },
  "Everburning torch": { preset: "continualFlame" },
});

/* -------------------------------------------- */
/*  The table                                   */
/* -------------------------------------------- */

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTING_ITEMS, {
    scope: "world",
    config: false,
    type: Object,
    default: {},
  });

  game.settings.register(MODULE_ID, SETTING_CONSUMPTION, {
    name: "PF1LIGHTING.Setting.fuelConsumption.Name",
    hint: "PF1LIGHTING.Setting.fuelConsumption.Hint",
    scope: "world",
    config: true,
    type: String,
    // *Announce only* is the default deliberately. A table that forgets to douse a torch should not
    // lose its equipment to bookkeeping, and the report is the part that has any value at the table.
    default: "announce",
    choices: {
      consume: "PF1LIGHTING.Setting.fuelConsumption.consume",
      both: "PF1LIGHTING.Setting.fuelConsumption.both",
      announce: "PF1LIGHTING.Setting.fuelConsumption.announce",
    },
  });
}

/** The table in force. Empty until a world edits it, so an untouched world tracks the built-ins. */
export function table() {
  let stored;
  try {
    stored = game.settings.get(MODULE_ID, SETTING_ITEMS);
  } catch {
    return BUILT_IN_ITEMS;
  }
  if (!stored || typeof stored !== "object" || !Object.keys(stored).length) return BUILT_IN_ITEMS;
  return stored;
}

export const setTable = (next) => game.settings.set(MODULE_ID, SETTING_ITEMS, next ?? {});

/** Name → entry, case-insensitively, aliases included. Rebuilt per lookup; the table is tiny. */
function index() {
  const map = new Map();
  for (const [name, entry] of Object.entries(table())) {
    if (!entry?.preset) continue;
    map.set(name.toLowerCase(), { ...entry, name });
    for (const alias of entry.aliases ?? []) map.set(String(alias).toLowerCase(), { ...entry, name });
  }
  return map;
}

/**
 * What this item lights, if anything.
 *
 * @remarks
 * The item's own descriptor wins over the table, and a descriptor may name a preset the table would
 * not have. Read through `model/descriptor`, which is where the flag's shape and its normalisation
 * live: a fuel row left blank on the sheet arrives as `{item: "", hours: null}` rather than as an
 * absence, and read raw that is a lantern consuming an item nobody holds — offered, greyed, and
 * reported as out of oil. There is one reader so the picker and the buff driver cannot disagree.
 *
 * @param {Item} item
 * @returns {{preset: string, fuel?: {item: string, hours: number}, name: string,
 *   light?: object, config?: object}|null}
 */
export function resolve(item) {
  if (!item?.name) return null;

  const own = descriptor.read(item);
  if (own?.trigger === descriptor.TRIGGER.LIT) return own;

  const entry = index().get(item.name.toLowerCase());
  if (!entry) return null;
  // A preset the table names but the world has since deleted is not an error; it is an entry that
  // no longer resolves, and offering it would light nothing.
  return presetTable()[entry.preset] ? entry : null;
}

/**
 * Every light source an actor is carrying, with its supply.
 *
 * @remarks
 * `quantity > 0` gates the item itself, not its fuel: a lantern with no oil is still a lantern and
 * should be offered, exhausted, rather than hidden — a picker that silently omits the thing a player
 * is holding reads as a bug.
 *
 * @param {Actor} actor
 * @returns {{item: Item, entry: object, supply: number, exhausted: boolean}[]}
 */
export function carriedBy(actor) {
  const out = [];
  for (const item of actor?.items ?? []) {
    if ((item.system?.quantity ?? 0) <= 0) continue;
    const entry = resolve(item);
    if (!entry) continue;
    const supply = entry.fuel ? supplyOf(actor, entry.fuel.item) : Infinity;
    out.push({ item, entry, supply, exhausted: supply <= 0 });
  }
  return out;
}

/** How many units of a named fuel an actor holds. */
function supplyOf(actor, name) {
  const wanted = String(name ?? "").toLowerCase();
  let total = 0;
  for (const item of actor?.items ?? []) {
    if (item.name?.toLowerCase() === wanted) total += item.system?.quantity ?? 0;
  }
  return total;
}

/* -------------------------------------------- */
/*  The burn clock                              */
/* -------------------------------------------- */

/** Seconds already burnt into the current unit, remembered on the light item. */
const carriedOn = (item) => Number(item?.getFlag?.(MODULE_ID, `${BURN_FLAG}.carried`)) || 0;

/**
 * Work out what one lit effect owes.
 *
 * @remarks
 * Pure: it reads and returns, and every caller decides what to do with the answer. That is what lets
 * the sweep report *"your lantern ran dry four hours ago"* — the moment it went out is arithmetic,
 * not something that has to be observed as it happens.
 *
 * @param {object} record - The effect record, carrying `litAt` and `fuel`
 * @param {Item|null} item - The **light** item, which remembers the part-burnt remainder
 * @param {Actor} actor
 * @param {number} worldTime
 * @returns {{owed: number, affordable: number, total: number, dry: boolean, wentOutAt: number|null}}
 */
export function owedBy(record, item, actor, worldTime) {
  const unit = (record.fuel?.hours ?? 0) * HOUR;
  if (!(unit > 0)) return { owed: 0, affordable: 0, total: 0, dry: false, wentOutAt: null };

  // Clamped at zero: GMs rewind the clock, and a flask half burnt is not un-burnt by moving time
  // backwards. `carried` is never rewound either.
  const elapsed = Math.max(0, worldTime - (record.litAt ?? worldTime));
  const total = carriedOn(item) + elapsed;
  const due = Math.floor(total / unit);
  const owed = Math.max(0, due - (record.fuel?.consumed ?? 0));

  const held = supplyOf(actor, record.fuel.item);
  const affordable = Math.min(owed, held);
  // Dry when there was not enough **or** when paying takes the last of it. The second half is the
  // one that is easy to miss and wrong to omit: light your only torch, burn for an hour, and the
  // torch you were holding is now spent — the light goes out *at that moment*, not an hour later
  // when the next unit falls due and there is nothing to pay it with. Reported 2026-08-30.
  const dry = owed > affordable || held - affordable <= 0;

  // The instant the last affordable unit ran out, which is knowable exactly rather than noticed
  // late. `carried` is subtracted because the first unit was already part-burnt when this began.
  const wentOutAt = dry
    ? (record.litAt ?? worldTime) + ((record.fuel?.consumed ?? 0) + held) * unit - carriedOn(item)
    : null;

  return { owed, affordable, total, dry, wentOutAt };
}

/**
 * Charge every lit effect for the time that has passed. **Active GM only.**
 *
 * @param {number} worldTime - From the hook, never `game.time.worldTime` — see `companion.sweep`
 */
export async function burn(worldTime = game.time?.worldTime ?? 0) {
  const report = { charged: 0, extinguished: 0 };
  if (!isWriter()) return report;

  const mode = consumptionMode();

  for (const scene of game.scenes ?? []) {
    for (const doc of scene.tokens ?? []) {
      const actor = doc.actor;
      if (!actor) continue;

      for (const record of companionList(doc)) {
        if (!record.fuel?.item || !(record.fuel.hours > 0)) continue;
        // The **light** item, not the fuel: `carried` — the part-burnt remainder — is remembered on
        // the lantern, because it is the lantern that was half through a flask. Recorded as an id
        // when the light was lit, so a rename cannot lose it.
        const item = actor.items.get(record.fuel.itemId);
        const result = owedBy(record, item, actor, worldTime);
        if (!result.owed) continue;

        if (mode !== "announce") await spend(actor, record.fuel.item, result.affordable);
        announce(actor, record, result, mode);
        report.charged += result.affordable;

        // In *announce only* mode nothing was taken, so nothing ran out: the light keeps burning and
        // the message says what it would have cost. Extinguishing on a supply this mode never
        // touched would be the module enforcing a rule it had just been told not to enforce.
        if (result.dry && mode !== "announce") {
          // Out of fuel: the effect ends, and `carried` resets to zero rather than to a remainder —
          // the last unit burnt out, so there is nothing left of it.
          await item?.unsetFlag?.(MODULE_ID, BURN_FLAG);
          await socket.request("clear", { anchorUuid: doc.uuid, id: record.id });
          report.extinguished++;
        } else {
          // `consumed` advances in every mode, announce included: it is the record of what has been
          // *reported*, and without it a six-hour jump would re-announce the same six flasks on
          // every subsequent tick.
          await socket.request("apply", {
            anchorUuid: doc.uuid,
            record: { ...record, fuel: { ...record.fuel, consumed: (record.fuel.consumed ?? 0) + result.affordable } },
          });
        }
      }
    }
  }
  return report;
}

/** Read through `model/companion.mjs` without importing it — see the note in `registerHooks`. */
let companionList = () => [];

/** Injected in `module.mjs`, the seam `suppression.setVisionModel` established. */
export function setRecordReader(fn) {
  companionList = fn;
}

const consumptionMode = () => {
  try {
    return game.settings.get(MODULE_ID, SETTING_CONSUMPTION);
  } catch {
    return "announce";
  }
};

/** Take `count` units of a named item off an actor, deleting a stack that reaches zero. */
async function spend(actor, name, count) {
  let left = count;
  const wanted = String(name ?? "").toLowerCase();
  for (const item of actor.items) {
    if (left <= 0) break;
    if (item.name?.toLowerCase() !== wanted) continue;
    const have = item.system?.quantity ?? 0;
    const take = Math.min(have, left);
    left -= take;
    // Zeroed, never deleted (Hamilcarbarcas, 2026-08-30). A spent stack is a thing the character
    // still owns the idea of — an empty flask slot to refill in town — and deleting it silently
    // removes a line from a sheet the player was reading. It also makes the loss unrecoverable by
    // hand, where a zero is one edit away from being right again.
    await item.update({ "system.quantity": have - take });
  }
}

/**
 * Tell the people who own the actor what it cost.
 *
 * @remarks
 * One message for the whole advance rather than one per unit — a six-hour jump reports *six flasks*
 * once. Whispered to the actor's owners plus a public card, because the second is what stops a
 * player discovering the cost only when they next look at their sheet.
 */
function announce(actor, record, result, mode) {
  // Mode decides first, `dry` second. In *announce only* nothing was taken and nothing ran out, so
  // the "went out" wording would be reporting an event that did not happen — the light is still
  // burning and the fuel is still on the sheet.
  const key = mode === "announce" ? "Fuel.Would" : result.dry ? "Fuel.RanDry" : "Fuel.Spent";
  const content = game.i18n.format(`PF1LIGHTING.${key}`, {
    actor: actor.name,
    light: record.label,
    count: result.affordable,
    fuel: record.fuel.item,
  });
  ChatMessage.create({
    content,
    speaker: ChatMessage.getSpeaker({ actor }),
    whisper: game.users.filter((u) => u.isGM || actor.testUserPermission(u, "OWNER")).map((u) => u.id),
  });
}

/**
 * Put a lit source out, remembering how far into the current unit it got.
 *
 * @remarks
 * The only place `carried` is ever written, and the reason the clock can be derived everywhere else.
 * Called when a light is switched off deliberately; a light that runs *dry* takes the other branch
 * in {@link burn}, which resets the remainder to zero because the last unit burnt out.
 *
 * @param {foundry.abstract.Document} anchorDoc
 * @param {object} record
 */
export async function douse(anchorDoc, record, worldTime = game.time?.worldTime ?? 0) {
  const actor = anchorDoc?.actor;
  const item = actor?.items?.get(record?.fuel?.itemId);
  const unit = (record?.fuel?.hours ?? 0) * HOUR;

  if (item && unit > 0) {
    const elapsed = Math.max(0, worldTime - (record.litAt ?? worldTime));
    const total = carriedOn(item) + elapsed;
    await item.setFlag(MODULE_ID, `${BURN_FLAG}.carried`, total - Math.floor(total / unit) * unit);
  }
  return socket.request("clear", { anchorUuid: anchorDoc.uuid, id: record.id });
}

/* -------------------------------------------- */

export function registerHooks() {
  // The hook's own `worldTime`, for `model/companion.sweep`'s reason: time updates are async and
  // nothing awaits a hook, so the global can still hold the previous value here.
  Hooks.on("updateWorldTime", (worldTime) => {
    burn(worldTime).catch((error) => console.error(`${MODULE_ID} | fuel sweep failed`, error));
  });
}
