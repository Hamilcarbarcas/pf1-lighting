/**
 * Buffs that emit light. DESIGN.md §12.7, §12.13 step 8.
 *
 * A buff carrying a descriptor with `trigger: "active"` puts a light on its actor's tokens while it
 * is active, and takes it off when it is not. That covers rather more than toggling: the hook fires
 * on create-while-active, on toggle, on delete (`item-buff.mjs:52`, `:68`, `:93`), and **duration
 * expiry arrives through it as a toggle to false** — `Actor#expireActiveEffects` writes
 * `system.active: false` on the buff (`actor-pf.mjs:322`). So buff durations cost this module
 * nothing at all.
 *
 * ## Reconcile, don't react
 *
 * The obvious build is *apply on true, clear on false*, and it is wrong in one ordinary case: the
 * hook fires on every client, but the write only happens on one, so any client that was looking at
 * another scene when the buff was toggled never had an anchor to write to. Come back to that scene
 * and the light is missing — or still burning, which is worse.
 *
 * So the hooks do not carry the change. Each of them says *this actor may have moved* and
 * {@link reconcile} works out the difference between what the actor's buffs want and what its tokens
 * are carrying. That makes the whole thing idempotent, which in turn makes `canvasReady` a legal
 * trigger — and `canvasReady` is what closes the missed-scene gap, since a scene the GM was not
 * looking at is reconciled the moment they arrive.
 *
 * ## What the driver owns, and how it knows
 *
 * Records whose id begins with {@link PREFIX}, and nothing else. A HUD light (`id: "hud"`), an API
 * caller's effect and an item lit from the picker all sit on the same anchor and must survive a
 * reconcile untouched — so ownership is read off the id rather than inferred from the item, which
 * would fail the moment a GM cleared a descriptor and left the record it had made behind.
 *
 * `source` is still recorded as the buff's uuid. That is belt and braces: the reaper (§12.5.2)
 * collects records whose source no longer resolves, so a buff deleted while nobody was on the scene
 * is cleaned up even if nothing ever reconciles that actor again.
 */

import { MODULE_ID } from "../constants.mjs";
import * as descriptor from "./descriptor.mjs";
import * as companion from "./companion.mjs";
import { isWriter } from "../ui/scene-config.mjs";

/** Every record this driver owns is `emit:<itemId>`, and no record it does not own ever is. */
const PREFIX = "emit:";

const recordId = (item) => `${PREFIX}${item.id}`;
const isOurs = (record) => typeof record?.id === "string" && record.id.startsWith(PREFIX);

/**
 * The effects this actor's buffs currently ask for, keyed by record id.
 *
 * @param {Actor} actor
 * @param {Set<string>} off - Item ids to treat as inactive whatever they currently say
 */
function wantedOn(actor, off) {
  const wanted = new Map();
  for (const item of actor?.items ?? []) {
    if (item.type !== "buff") continue;
    // `off` is how a delete is survived. `_onDelete` fires the toggle hook while the item can still
    // be reachable through the collection, so an active buff being deleted would otherwise read as
    // an active buff and be re-applied on the way out.
    if (off.has(item.id) || !item.isActive) continue;

    const emits = descriptor.read(item);
    if (!emits || emits.trigger !== descriptor.TRIGGER.ACTIVE) continue;

    wanted.set(recordId(item), {
      id: recordId(item),
      source: item.uuid,
      preset: emits.preset,
      label: item.name,
      light: emits.light,
      config: emits.config,
    });
  }
  return wanted;
}

/** Has the descriptor moved under a record that is already placed? */
const differs = (record, effect) =>
  record.preset !== effect.preset ||
  record.label !== effect.label ||
  record.source !== effect.source;

/**
 * Bring an actor's tokens into line with what its buffs ask for. **Active GM only.**
 *
 * @param {Actor} actor
 * @param {object} [options]
 * @param {Iterable<string>} [options.off] - Item ids to treat as inactive
 * @param {string|null} [options.force] - A record id to re-apply even if it looks unchanged
 * @returns {Promise<{applied: number, cleared: number}>}
 */
export async function reconcile(actor, { off = [], force = null } = {}) {
  const report = { applied: 0, cleared: 0 };
  // One writer, as everywhere else in §12. Every client sees the hook; exactly one acts on it.
  if (!isWriter() || !actor) return report;

  const anchors = companion.anchorsOf(actor);
  // No token on the drawn scene is not a failure and must not warn — it is the ordinary state of
  // most actors in a world. `canvasReady` picks the scene up when someone goes to it.
  if (!anchors.length) return report;

  const wanted = wantedOn(actor, new Set(off));

  for (const doc of anchors) {
    const current = companion.list(doc);

    for (const record of current) {
      if (!isOurs(record) || wanted.has(record.id)) continue;
      report.cleared += (await companion.clear(doc, record.id)) > 0 ? 1 : 0;
    }

    for (const [id, effect] of wanted) {
      const existing = current.find((record) => record.id === id);
      // Already correct: skipped rather than rewritten, so a scene load with nothing to do performs
      // no document writes at all.
      if (existing && id !== force && !differs(existing, effect)) continue;
      if (await companion.apply(doc, effect)) report.applied++;
    }
  }

  return report;
}

/* -------------------------------------------- */

/**
 * One reconcile at a time per actor.
 *
 * @remarks
 * `reconcile` reads an anchor's records before it enqueues a write, so two overlapping runs would
 * both decide against the same pre-state (`reference_hook_flag_lost_update`). The relay's per-anchor
 * queues make the *writes* safe on their own — the GM re-reads the list inside each operation — so
 * what this prevents is redundant work rather than a lost update. Two toggles in the same frame is
 * an ordinary thing for a buff macro to do.
 */
const queues = new Map();

function run(actor, options) {
  if (!actor?.id) return;
  const previous = queues.get(actor.id) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => reconcile(actor, options))
    .catch((error) => console.error(`${MODULE_ID} | buff light reconcile failed`, error))
    .finally(() => {
      if (queues.get(actor.id) === next) queues.delete(actor.id);
    });
  queues.set(actor.id, next);
}

/**
 * Did this update touch the descriptor?
 *
 * @remarks
 * Both spellings, because clearing a flag arrives as `-=emits` rather than as `emits: null`, and a
 * GM switching a descriptor off is exactly the case that has to reach the light already burning.
 */
function touchesDescriptor(changes) {
  const flags = changes?.flags?.[MODULE_ID];
  if (!flags) return false;
  return Object.keys(flags).some(
    (key) => key === descriptor.EMITS_FLAG || key === `-=${descriptor.EMITS_FLAG}`
  );
}

export function registerHooks() {
  // Covers toggle, create-while-active, delete-while-active and duration expiry — one hook for all
  // four (`item-buff.mjs:52`, `:68`, `:93`).
  Hooks.on("pf1ToggleActorBuff", (actor, item, active) => {
    run(actor, { off: active ? [] : [item?.id] });
  });

  // The descriptor edited on a buff that is already active: nothing about the buff's state changed,
  // so the toggle hook is silent and the light on the token would go on being the old one.
  Hooks.on("updateItem", (item, changes) => {
    if (!item?.actor || !touchesDescriptor(changes)) return;
    run(item.actor, { force: recordId(item) });
  });

  // A token dropped for an actor whose buff is already active.
  Hooks.on("createToken", (doc) => {
    if (doc?.actor) run(doc.actor);
  });

  // The one that closes the missed-scene gap. Every actor with a token here, reconciled on arrival —
  // cheap because an actor already in the right state performs no writes.
  Hooks.on("canvasReady", () => {
    if (!isWriter()) return;
    const actors = new Set();
    for (const token of canvas?.tokens?.placeables ?? []) {
      if (token.actor) actors.add(token.actor);
    }
    for (const actor of actors) run(actor);
  });
}

/** What the driver believes, for the console. */
export function status() {
  const out = [];
  for (const token of canvas?.tokens?.placeables ?? []) {
    for (const record of companion.list(token.document)) {
      if (isOurs(record)) out.push({ token: token.name, id: record.id, preset: record.preset, source: record.source });
    }
  }
  return { writer: isWriter(), pending: queues.size, records: out };
}
