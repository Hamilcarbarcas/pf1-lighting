/**
 * The GM relay. DESIGN.md §12.5 and §12.13 step 2.
 *
 * Every write to a light-effect record goes through **the active GM**, and this is the wire.
 *
 * ## Why one writer
 *
 * `pf1ToggleActorBuff` is fired from `_onUpdate` and `_onDelete`, so it runs on every connected
 * client. Left alone, a five-player table would issue five identical writes against one document and
 * the record array would lose whichever landed second — `reference_hook_flag_lost_update`'s failure,
 * exactly. A player can legitimately write their own token's flags (a `TokenDocument`'s ownership is
 * its actor's, `common/documents/token.mjs:977-979`), and that is precisely the path not taken: the
 * moment a second writer exists the array is unsafe.
 *
 * It also puts §12.4's resolution in one place. What ends up on a document is never a function of who
 * happened to trigger it.
 *
 * ## Two operations, and why that is not a per-feature handler
 *
 * `feedback_gm_socket_design` says handlers must be generic primitives rather than one per feature,
 * and this obeys it rather than making an exception. `apply` and `clear` are the *only* mutations
 * §12 has: every trigger in §12.7 — a buff toggling, a lantern being lit, a spell used on a target,
 * an API call, the HUD button — reduces to one of the two. Adding a third handler for any of them
 * would be the sprawl that rule exists to prevent.
 *
 * A generic *document-update* primitive was considered and is worse on both counts: it would let any
 * client hand the GM an arbitrary update to execute, and it would move record resolution back out to
 * the callers, which is the thing one writer exists to prevent.
 *
 * ## The relay is not an authorisation bypass
 *
 * Corrected 2026-08-30, having first been built the other way round. A relay exists so that one
 * client *writes*, not so that any client may write *anything*: the GM performs the update, and it
 * still has to be an update the requester was entitled to ask for.
 *
 * So every operation checks the **sender's** ownership of the anchor, on the GM's side, against the
 * `senderId` Foundry appends itself (`dist/server/sockets.mjs`, `handleCustomSocket`) rather than
 * anything the message claims. A client-side check runs first for a prompt response, but it is
 * advisory; this one decides.
 *
 * What that leaves out is deliberate and has its own answer. An effect on a token the player does
 * **not** own — *darkness* cast on an enemy's weapon, on a trap, on a vehicle — is not a silent
 * write, it is a **request the GM acts on**, in the shape this world already uses for buff delivery:
 * the player's card carries a button and the GM presses it. That flow belongs with §12.7's on-use
 * targeting, which is where the button would live; until then such a request is refused with a
 * message saying so, rather than quietly succeeding.
 *
 * ## The operation is sent, never the result
 *
 * A request says *add this record* or *remove what matches this*, and the GM computes the new array
 * from **its own** view of the document. Sending a finished array instead would embed the sender's
 * possibly-stale copy, and two clients acting in the same moment would each overwrite the other's
 * addition with a list that never contained it. The whole point is that one client reads and writes.
 */

import { MODULE_ID } from "./constants.mjs";
import { isWriter } from "./ui/scene-config.mjs";

/** Foundry's per-module channel. Requires `"socket": true` in `module.json`. */
const CHANNEL = `module.${MODULE_ID}`;

/** How long a requester waits for the GM before giving up. */
const TIMEOUT_MS = 10_000;

/** op → handler, registered by the module that owns the operation. */
const handlers = new Map();

/** requestId → {resolve, reject, timer} on the requesting client. */
const pending = new Map();

/**
 * Per-anchor promise chains, on the GM.
 *
 * @remarks
 * One writer is not on its own enough: two requests for the same token arriving in the same tick
 * would both read the document before either wrote it. Serialising per anchor — rather than
 * globally — keeps two unrelated tokens from waiting on each other, which matters when a
 * six-second time advance expires four buffs at once.
 */
const queues = new Map();

function enqueue(key, task) {
  const previous = queues.get(key) ?? Promise.resolve();
  // `then(task, task)` rather than `.then(task)`: a failed predecessor must not cancel the queue.
  const next = previous.then(task, task);
  // The stored link swallows rejections, so a failure surfaces to its own caller and nowhere else.
  const link = next.catch(() => {});
  queues.set(key, link);
  // Drop the entry once nothing has queued behind it, or a long session accumulates one per anchor
  // ever touched. Identity check, so a later request that reset the tail is left alone.
  link.then(() => {
    if (queues.get(key) === link) queues.delete(key);
  });
  return next;
}

/**
 * Register an operation the GM will perform on request.
 *
 * @param {string} op
 * @param {(payload: object, senderId: string) => Promise<unknown>} handler
 */
export function register(op, handler) {
  handlers.set(op, handler);
}

/**
 * Perform an operation as the active GM, from wherever it was asked for.
 *
 * @remarks
 * Runs inline when this client *is* the active GM — the common case at this table, and it keeps a
 * console call synchronous in spirit and free of a socket round trip it does not need.
 *
 * @param {string} op
 * @param {object} payload - Must carry `anchorUuid`; it is the queue key
 * @returns {Promise<unknown>}
 */
export async function request(op, payload = {}) {
  if (!handlers.has(op)) throw new Error(`${MODULE_ID}: unknown operation "${op}"`);

  if (isWriter()) return run(op, payload, game.user.id);

  if (!game.users?.activeGM) {
    // The honest answer, and the one consequence of one-writer worth stating out loud: with no GM
    // connected, nothing happens rather than something half-happening.
    ui.notifications?.warn(
      game.i18n?.localize?.("PF1LIGHTING.Socket.NoGM") ?? "No GM is connected, so the lighting change was not made."
    );
    return null;
  }

  const id = foundry.utils.randomID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${MODULE_ID}: the GM did not answer a "${op}" request in time`));
    }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    game.socket.emit(CHANNEL, { type: "request", id, op, payload });
  });
}

/** Run a handler, serialised against everything else touching the same anchor. */
function run(op, payload, senderId) {
  const key = payload?.anchorUuid ?? "*";
  return enqueue(key, () => handlers.get(op)(payload, senderId));
}

/* -------------------------------------------- */

/**
 * @param {object} message
 * @param {string} senderId - Foundry appends the sending user's id itself
 *   (`dist/server/sockets.mjs`, `handleCustomSocket`), so a client cannot claim to be someone else.
 */
async function onMessage(message, senderId) {
  // Every path is wrapped, because socket.io does not await this handler and does not catch it: an
  // `async` listener that throws becomes an unhandled promise rejection with no attribution to the
  // module that caused it. The inner `try` reports a *handler* failing, which is a normal outcome
  // reported back over the wire; this one is for the frame around it — `isWriter` before `game.users`
  // exists, an `emit` on a torn-down socket, a malformed message from a future version.
  try {
    if (!message || typeof message !== "object") return;

    if (message.type === "request") {
      // Every client receives it; only one acts. `isWriter` is `activeGM.isSelf`, so exactly one
      // client answers true even with several GMs connected.
      if (!isWriter()) return;
      if (!handlers.has(message.op)) return;

      let result = null;
      let error = null;
      try {
        result = await run(message.op, message.payload ?? {}, senderId);
      } catch (caught) {
        error = caught?.message ?? String(caught);
        console.error(`${MODULE_ID} | relayed "${message.op}" failed`, caught);
      }
      game.socket.emit(CHANNEL, { type: "response", id: message.id, result, error });
      return;
    }

    if (message.type === "response") {
      const entry = pending.get(message.id);
      // Not ours. Every client sees every response, so this is the ordinary case.
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error));
      else entry.resolve(message.result);
    }
  } catch (caught) {
    console.error(`${MODULE_ID} | socket listener failed`, caught, message);
  }
}

export function registerHooks() {
  Hooks.once("ready", () => {
    if (!game.modules.get(MODULE_ID)?.socket) {
      // Silent failure otherwise: the server only binds the channel when the manifest declares it
      // (`dist/packages/package.mjs`, `registerCustomSocket`), so an emit is accepted and discarded.
      console.error(
        `${MODULE_ID} | "socket": true is missing from module.json — light effects cannot be relayed`
      );
      return;
    }
    game.socket.on(CHANNEL, onMessage);
  });
}

/** Debug readout. */
export function status() {
  const report = {
    channel: CHANNEL,
    declared: game.modules.get(MODULE_ID)?.socket === true,
    isWriter: isWriter(),
    activeGM: game.users?.activeGM?.name ?? null,
    operations: [...handlers.keys()],
    pending: pending.size,
    queues: queues.size,
  };
  console.error(`${MODULE_ID} | socket`, report);
  return report;
}
