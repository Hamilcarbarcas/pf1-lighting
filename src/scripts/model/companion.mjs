/**
 * Light effects — the companion source. DESIGN.md §12.2 D, §12.3, §12.4.
 *
 * A *light* or *darkness* that follows what it was cast on, and a lantern that follows its bearer.
 * The durable state is a record on the **anchor's** flags; every client reads those records and
 * builds a real `PointLightSource` or `PointDarknessSource` from each one, positioned at the
 * anchor. Nothing on the anchor's own `light` is ever written.
 *
 * ## Why the source has a document
 *
 * Three places in the model reach a source through its document — `registry.configOf`,
 * `ramp.emissionOf` and `ramp.baseRadiusOf` — and PF1's low-light multiplier lives on the
 * *placeable* (`vision/llv.mjs`), not on the source. A bare synthetic source of the kind
 * `render/pool.mjs` makes would need a parallel path through all four, and `baseRadiusOf`
 * returning `null` would degenerate `cancelRadius` to `Infinity`, reintroducing §4.4a's bug by a
 * different route.
 *
 * So each effect gets an **unsaved `AmbientLightDocument` and an unattached placeable**: never
 * `create()`d in the database, never parented to `canvas.lighting.objects`. Every seam above then
 * works untouched. `PlaceableObject`'s constructor demands `document.isEmbedded`, which
 * `_getParentCollection` answers from the parent's class alone with no membership test
 * (`common/abstract/document.mjs:279-283`), so `{parent: scene}` is enough.
 *
 * It is invisible to the front end because `layer.placeables` is `this.objects.children`
 * (`layers/base/placeables-layer.mjs:151-154`) and `_updateQuadtree` bails when
 * `this.parent !== layer.objects` (`placeables/placeable-object.mjs:488-492`). Not in the layer,
 * not in the quadtree, not selectable, absent from the lighting layer.
 *
 * ## Two traps, both load-bearing
 *
 * 1. **Every document gets an `_id`.** `isPreview` is `!!this._original || !this.document.id`
 *    (`placeable-object.mjs:209`) and `registry.usable()` excludes previews, so an id-less document
 *    would render perfectly while being invisible to the model — the right picture over the wrong
 *    light levels. The id is generated once, stored on the record, and replicated, so every client
 *    builds the same `sourceId`.
 * 2. **`hidden` is not invisibility.** `_isLightSourceDisabled()` returns true for a hidden light
 *    (`placeables/light.mjs:149-152`), which means it emits nothing. Invisibility comes from not
 *    being in the layer; `hidden` stays false.
 *
 * ## Why `_getLightSourceData` rather than `initializeLightSource`
 *
 * Core's `AmbientLight#initializeLightSource` does everything needed and then some: it ends with
 * `this.layer.active` and a `renderFlags.set`, both meaningless for a placeable that is not in a
 * layer, and it issues a full `canvas.perception.update` on every call — including the
 * `initializeLighting` a darkness demands, which is the expensive path and must not run per
 * animation frame. So the data assembly is borrowed and the lifecycle is not: `_getLightSourceData`
 * carries PF1's low-light multiplier and every field core would have set, and this module decides
 * when to disturb perception.
 */

import { EFFECT_MARK, MODULE_ID } from "../constants.mjs";
import { applyPreset, table as presetTable } from "./presets.mjs";
import * as registry from "./registry.mjs";
import * as socket from "../socket.mjs";
import { isWriter } from "../ui/scene-config.mjs";

/** Flag key on the anchor. An array; order is stable and readable. */
export const EFFECTS_FLAG = "effects";

/** Anchors this module will attach an effect to. Bare points are refused — DESIGN.md §12.11. */
const ANCHOR_TYPES = new Set(["Token", "Tile", "MeasuredTemplate"]);

/* -------------------------------------------- */
/*  Anchors                                     */
/* -------------------------------------------- */

/**
 * The document whose flags hold the records, from whatever a caller had to hand.
 *
 * @remarks
 * An `Actor` expands to every one of its tokens on the canvas, which is what a buff driver has —
 * see {@link anchorsOf}. This resolves one thing to one document.
 *
 * @param {object|string} subject
 * @returns {foundry.abstract.Document|null}
 */
export function anchorOf(subject) {
  if (!subject) return null;
  if (typeof subject === "string") {
    return canvas?.tokens?.get(subject)?.document ?? null;
  }
  // A placeable hands over its document; a document is already one.
  const doc = subject.document ?? subject;
  return ANCHOR_TYPES.has(doc?.documentName) ? doc : null;
}

/**
 * Every anchor a subject stands for.
 *
 * @remarks
 * The `Actor` case is the reason this exists separately: `apply` on an actor attaches to each of
 * its tokens on the canvas. Several tokens of one linked actor is rare to the point of never
 * (§12.14) — the requirement is only that it neither throws nor half-applies.
 *
 * @param {object|string|Array} subject
 * @returns {foundry.abstract.Document[]}
 */
export function anchorsOf(subject) {
  const list = Array.isArray(subject) ? subject : [subject];
  const out = [];
  for (const entry of list) {
    if (entry?.documentName === "Actor") {
      for (const token of entry.getActiveTokens?.(false, true) ?? []) out.push(token);
      continue;
    }
    const doc = anchorOf(entry);
    if (doc) out.push(doc);
  }
  // An actor with several tokens, plus the same token named directly, must not be attached twice.
  return [...new Set(out)];
}

/**
 * Where an anchor's light sits, in scene pixels, and which way it faces.
 *
 * @remarks
 * A token reads from its **placeable's** centre rather than the document's `x`/`y`, and that is
 * what makes an effect follow a walking creature rather than jump to its destination: v13 puts the
 * document at the target the moment `updateToken` fires and animates the placeable there afterwards
 * (`placeables/token.mjs:3774-3847`). The placeable's centre is the animated position.
 *
 * A template is anchored at its origin, not its centre, and carries its facing in `direction`.
 */
function anchorPoint(doc) {
  const object = doc.object;
  const elevation = doc.elevation ?? 0;

  if (doc.documentName === "MeasuredTemplate") {
    return { x: doc.x, y: doc.y, elevation, rotation: doc.direction ?? 0 };
  }

  const centre = object?.center;
  if (centre) return { x: centre.x, y: centre.y, elevation, rotation: doc.rotation ?? 0 };

  // No placeable — the anchor is on a scene that is not drawn. Fall back to the document, which is
  // correct for everything except a token mid-animation, and a token mid-animation on an undrawn
  // scene is not a case.
  const w = (doc.width ?? 0) * (canvas?.grid?.size ?? 0);
  const h = (doc.height ?? 0) * (canvas?.grid?.size ?? 0);
  return { x: (doc.x ?? 0) + w / 2, y: (doc.y ?? 0) + h / 2, elevation, rotation: doc.rotation ?? 0 };
}

/* -------------------------------------------- */
/*  Records                                     */
/* -------------------------------------------- */

/** The records on an anchor, always an array. */
export function list(anchor) {
  const doc = anchorOf(anchor);
  const stored = doc?.flags?.[MODULE_ID]?.[EFFECTS_FLAG];
  return Array.isArray(stored) ? stored : [];
}

/**
 * Expand a caller's descriptor into a stored record.
 *
 * @remarks
 * The preset is resolved **once, here** and the values are stored — §10.2's provenance rule seen
 * from a third side. Editing the preset table afterwards does not reach back into an effect already
 * running, exactly as it does not reach back into a light already placed.
 *
 * `negative` comes from the preset rather than from `light`, because it decides which source class
 * the effect becomes; an explicit `light.negative` still wins, for a caller who means it.
 */
function toRecord(effect = {}) {
  const preset = effect.preset ? presetTable()[effect.preset] : null;

  const light = {
    ...(preset?.light ?? {}),
    ...(preset ? { negative: preset.negative === true } : {}),
    ...(effect.light ?? {}),
  };
  const config = { ...(preset?.config ?? {}), ...(effect.config ?? {}) };

  const id =
    effect.id ??
    (effect.source ? `src:${effect.source}` : `eff:${foundry.utils.randomID()}`);

  const record = {
    id,
    // Stable across rebuilds and identical on every client, so `sourceId` does not churn.
    docId: effect.docId ?? foundry.utils.randomID(),
    label: effect.label ?? preset?.label ?? "Light",
    preset: effect.preset ?? null,
    light,
    config,
    source: effect.source ?? null,
    litAt: effect.litAt ?? game.time?.worldTime ?? 0,
  };

  if (effect.expires !== undefined) record.expires = effect.expires;
  if (effect.fuel) record.fuel = effect.fuel;
  return record;
}

/**
 * Write the record list back to an anchor. **Runs on the active GM only.**
 *
 * @remarks
 * `-=` on an empty list, so an anchor that has never carried an effect and one whose last effect
 * ended look the same to everything downstream, including the reaper.
 */
async function write(doc, records) {
  if (records.length) {
    await doc.update({ [`flags.${MODULE_ID}.${EFFECTS_FLAG}`]: records });
  } else {
    await doc.update({ [`flags.${MODULE_ID}.-=${EFFECTS_FLAG}`]: null });
  }
  return records.length;
}

/* -------------------------------------------- */
/*  The two GM-side primitives (§12.5)          */
/* -------------------------------------------- */

/**
 * May this user attach or remove a light effect here?
 *
 * @remarks
 * The anchor's own ownership, which for a `TokenDocument` is its actor's
 * (`common/documents/token.mjs:977-979`) — so "a token the player owns" is exactly what this
 * answers, and a GM always passes.
 *
 * Run on the GM's side against the sender, where it is authoritative, and again on the requester's
 * side beforehand, where it is only there to give an immediate answer instead of a round trip.
 *
 * @param {foundry.abstract.Document} doc
 * @param {User} user
 * @returns {boolean}
 */
export function mayModify(doc, user = game.user) {
  if (!doc || !user) return false;
  if (user.isGM) return true;
  return doc.canUserModify?.(user, "update") === true;
}

/** The refusal, worded so it names the thing that has to happen instead. */
function refuse(doc) {
  return new Error(
    `${doc?.name ?? "that token"} is not yours to light — a GM has to make this change`
  );
}

/**
 * Add or replace one record. Registered as the relay's `apply` operation.
 *
 * @remarks
 * Takes a **uuid rather than a document**, because it runs on whichever client is the active GM and
 * that client has to resolve the anchor for itself. The record was built by the requester so its id
 * is decided once and can be returned without waiting for an answer.
 *
 * The current list is read here, not sent: two clients acting in the same moment would otherwise
 * each write a list that never contained the other's addition.
 *
 * `senderId` comes from Foundry rather than from the message, so the ownership test cannot be
 * talked out of by a crafted payload.
 */
async function applyOnAnchor({ anchorUuid, record }, senderId) {
  const doc = await fromUuid(anchorUuid);
  if (!doc) throw new Error(`no anchor at ${anchorUuid}`);
  if (!mayModify(doc, game.users.get(senderId))) throw refuse(doc);
  // Same id replaces rather than stacks, so re-applying a buff that was never cleared cannot leave
  // two sources burning at one point.
  const next = list(doc).filter((r) => r.id !== record.id);
  next.push(record);
  await write(doc, next);
  return record.id;
}

/** Remove records matching an id, a source uuid, or everything. The relay's `clear` operation. */
async function clearOnAnchor(
  { anchorUuid, id = null, source = null, ids = null, all = false },
  senderId
) {
  const doc = await fromUuid(anchorUuid);
  if (!doc) throw new Error(`no anchor at ${anchorUuid}`);
  if (!mayModify(doc, game.users.get(senderId))) throw refuse(doc);
  const current = list(doc);
  if (!current.length) return 0;

  // `ids` is the upkeep passes' form (§12.5.2): they have already decided which records are dead and
  // need to say so precisely. A finished *list* is still never accepted — only which ids to drop —
  // so the read-modify-write stays here and a concurrent request cannot be overwritten by a stale
  // snapshot.
  const doomed = ids ? new Set(ids) : null;

  const next = all
    ? []
    : current.filter(
        (r) => !((id && r.id === id) || (source && r.source === source) || doomed?.has(r.id))
      );
  if (next.length === current.length) return 0;
  await write(doc, next);
  return current.length - next.length;
}

export function registerOperations() {
  socket.register("apply", applyOnAnchor);
  socket.register("clear", clearOnAnchor);
}

/* -------------------------------------------- */
/*  Public                                      */
/* -------------------------------------------- */

/**
 * Attach an effect to one or more anchors.
 *
 * @remarks
 * The record is built **here**, on the requesting client, so `id` and `docId` are decided once and
 * every client ends up building the same `sourceId` from them. Only the write is relayed.
 *
 * No `sync()` afterwards: the GM's write fires `updateToken` on every client, which is what rebuilds
 * the sources. Calling it here would race the update it is trying to reflect and, on a player's
 * client, run before the write had even happened.
 *
 * @param {object|string|Array} subject - Token, TokenDocument, id, Actor, Tile, MeasuredTemplate
 * @param {object} effect - See {@link toRecord}
 * @returns {Promise<string|null>} The record's id
 */
export async function apply(subject, effect = {}) {
  const anchors = anchorsOf(subject);
  if (!anchors.length) {
    ui.notifications?.warn(`${MODULE_ID}: nothing to attach a light to`);
    return null;
  }

  const record = toRecord(effect);
  let applied = 0;
  for (const doc of anchors) {
    // Advisory — the GM checks again, and that check is the one that decides. This one exists so a
    // player is told immediately rather than after a round trip.
    if (!mayModify(doc)) {
      ui.notifications?.warn(refuse(doc).message);
      continue;
    }
    try {
      await socket.request("apply", { anchorUuid: doc.uuid, record });
      applied++;
    } catch (error) {
      ui.notifications?.warn(error.message);
      console.error(`${MODULE_ID} | could not apply a light effect to ${doc.uuid}`, error);
    }
  }
  return applied ? record.id : null;
}

/**
 * Remove an effect.
 *
 * @param {object|string|Array} subject
 * @param {string|{id?: string, source?: string}} ref - An id, or the uuid that owns it. The second
 *   form is what makes a buff toggle script two lines — it never has to remember what it created.
 * @returns {Promise<number>} How many records were removed
 */
export async function clear(subject, ref) {
  const id = typeof ref === "string" ? ref : (ref?.id ?? null);
  const source = typeof ref === "string" ? null : (ref?.source ?? null);

  return removeWhere(subject, { id, source });
}

/** Remove every effect from an anchor. */
export async function clearAll(subject) {
  return removeWhere(subject, { all: true });
}

/** The shared body of {@link clear} and {@link clearAll}, ownership and reporting included. */
async function removeWhere(subject, criteria) {
  let removed = 0;
  for (const doc of anchorsOf(subject)) {
    if (!mayModify(doc)) {
      ui.notifications?.warn(refuse(doc).message);
      continue;
    }
    try {
      removed += (await socket.request("clear", { anchorUuid: doc.uuid, ...criteria })) ?? 0;
    } catch (error) {
      ui.notifications?.warn(error.message);
      console.error(`${MODULE_ID} | could not clear a light effect on ${doc.uuid}`, error);
    }
  }
  return removed;
}

/* -------------------------------------------- */
/*  Live sources                                */
/* -------------------------------------------- */

/**
 * One built effect: an unsaved document, an unattached placeable, and a live source.
 *
 * @remarks
 * The three are created together and destroyed together. The document exists so the model can read
 * the effect's config through the same path it reads every other light's; the placeable exists so
 * PF1's low-light mixin and `_getLightSourceData` apply; the source is the thing Foundry renders.
 */
class Companion {
  constructor(anchorDoc, record) {
    this.anchorUuid = anchorDoc.uuid;
    this.record = record;
    this.negative = record.light?.negative === true;

    const point = anchorPoint(anchorDoc);
    this.doc = new CONFIG.AmbientLight.documentClass(
      {
        // Trap 1. Without an id the placeable is a preview and `registry.usable()` drops it.
        _id: record.docId,
        x: Math.round(point.x),
        y: Math.round(point.y),
        elevation: point.elevation,
        rotation: point.rotation,
        walls: true,
        // Never a vision source. A light that grants sight goes into `light.mask` whole and
        // unclipped (`visibility.mjs:542-546`), which defeats the umbra for every observer.
        vision: false,
        // Trap 2. `hidden` means off, not invisible.
        hidden: false,
        config: record.light ?? {},
        flags: {
          [MODULE_ID]: {
            // What `registry.configOf` and `ramp.emissionOf` read.
            config: record.config ?? {},
            // Provenance, for readouts and the management window.
            effect: record.id,
          },
        },
      },
      { parent: anchorDoc.parent ?? canvas.scene }
    );

    this.object = new CONFIG.AmbientLight.objectClass(this.doc);

    const cls = this.negative
      ? CONFIG.Canvas.darknessSourceClass
      : CONFIG.Canvas.lightSourceClass;
    this.source = new cls({ sourceId: this.object.sourceId, object: this.object });
    this.source[EFFECT_MARK] = true;
    // `force`: the constructor set the document's position, so the equality check would say nothing
    // moved and skip the one initialisation that has to happen.
    this.refresh(anchorDoc, { force: true });
  }

  /**
   * Bring the source into line with its anchor.
   *
   * @remarks
   * Returns false when nothing moved, and the caller must respect it. `refreshToken` fires for
   * hovering, targeting, a hit-point change and half a dozen other things that are not movement, and
   * `source.initialize()` is a full wall sweep — the expensive operation in this module (§9.6). Left
   * ungated, the commonest events on the canvas each cost a sweep per effect.
   *
   * Every key is assigned on the way in, never conditionally: `initialize` writes only the keys the
   * payload mentions and keeps the previous occupant's value for the rest
   * (`reference_effect_source_initialize_merges`, and `render/pool.mjs`'s four bugs).
   *
   * @param {foundry.abstract.Document} anchorDoc
   * @param {object} [options]
   * @param {boolean} [options.force] - Re-initialise even if the position is unchanged, for a
   *   rebuild where the source is new or the record's values have moved
   * @returns {boolean} Whether the source was re-initialised
   */
  refresh(anchorDoc, { force = false } = {}) {
    const point = anchorPoint(anchorDoc);
    const next = {
      x: Math.round(point.x),
      y: Math.round(point.y),
      elevation: point.elevation,
      // Always the anchor's facing (2026-08-30). There is no case for a carried light pointing a
      // fixed compass direction regardless of which way its bearer is turned, and it is harmless
      // where the angle is 360°. Dropping the flag is what lets §12.8's item table carry nothing but
      // a preset, a fuel item and a burn time.
      rotation: point.rotation,
    };

    if (!force &&
        this.doc.x === next.x && this.doc.y === next.y &&
        this.doc.elevation === next.elevation && this.doc.rotation === next.rotation) {
      return false;
    }

    this.doc.updateSource(next);
    this.source.initialize(this.object._getLightSourceData());
    this.source.add();
    return true;
  }

  destroy() {
    try {
      this.source.remove();
      this.source.destroy?.();
    } catch {
      /* PIXI teardown, nothing to salvage */
    }
  }
}

/** Key → Companion, for the current scene only. */
const live = new Map();

/**
 * The anchor uuids that have at least one companion.
 *
 * @remarks
 * Derived from {@link live} and kept alongside it purely so the movement path can reject in one
 * lookup. `refreshToken` fires for every token on the scene on every refresh, and without this the
 * per-frame cost would be a `startsWith` over every live companion for every token that moved,
 * whether or not it carries anything.
 */
const liveAnchors = new Set();

function reindex() {
  liveAnchors.clear();
  for (const companion of live.values()) liveAnchors.add(companion.anchorUuid);
}

const keyOf = (anchorDoc, record) => `${anchorDoc.uuid}::${record.id}`;

/**
 * Every anchor on a scene that carries at least one record.
 *
 * @remarks
 * Defaults to the drawn scene, which is what `sync` wants. Takes one explicitly for
 * {@link anchorsInWorld}, and is exported for the management window (§12.10) — scene-scoped
 * deliberately, since only the drawn scene has live sources.
 *
 * @param {Scene} [scene=canvas.scene]
 * @returns {foundry.abstract.Document[]}
 */
export function anchorsOnScene(scene = canvas?.scene) {
  if (!scene) return [];
  const out = [];
  for (const collection of [scene.tokens, scene.tiles, scene.templates]) {
    for (const doc of collection ?? []) {
      if (list(doc).length) out.push(doc);
    }
  }
  return out;
}

/**
 * Reconcile the live sources against the records on the current scene.
 *
 * @remarks
 * Wholesale, and cheap enough to be: the outer loop is a flag read per placeable and the inner work
 * is skipped for every effect already built. Per-anchor invalidation is available later by calling
 * this with a filter, and choosing a granularity before anything has been measured is the mistake
 * `registry` deliberately did not make.
 *
 * @returns {{built: number, refreshed: number, removed: number}}
 */
export function sync() {
  const report = { built: 0, refreshed: 0, removed: 0 };
  if (!canvas?.ready) return report;

  const seen = new Set();
  let membershipChanged = false;
  let touchedDarkness = false;

  for (const doc of anchorsOnScene()) {
    for (const record of list(doc)) {
      const key = keyOf(doc, record);
      seen.add(key);
      const existing = live.get(key);

      // A record whose light changed is rebuilt rather than re-initialised: `negative` decides the
      // source class, and a light that became a darkness cannot be the same object.
      if (existing && existing.record.docId === record.docId &&
          existing.negative === (record.light?.negative === true)) {
        // `force`: the record's own values may have changed — a preset re-applied, a radius edited —
        // even though the anchor has not moved an inch.
        existing.record = record;
        existing.refresh(doc, { force: true });
        report.refreshed++;
        continue;
      }

      if (existing) {
        existing.destroy();
        live.delete(key);
        membershipChanged = true;
        touchedDarkness ||= existing.negative;
      }

      try {
        const companion = new Companion(doc, record);
        live.set(key, companion);
        report.built++;
        membershipChanged = true;
        touchedDarkness ||= companion.negative;
      } catch (error) {
        console.error(`${MODULE_ID} | could not build a light effect on ${doc.uuid}`, error);
      }
    }
  }

  for (const [key, companion] of live) {
    if (seen.has(key)) continue;
    companion.destroy();
    live.delete(key);
    report.removed++;
    membershipChanged = true;
    touchedDarkness ||= companion.negative;
  }

  if (membershipChanged) {
    reindex();
    registry.invalidate();
    perceptionUpdate(touchedDarkness);
  }
  return report;
}

/**
 * Ask the canvas to catch up.
 *
 * @remarks
 * **`initializeLighting` is deliberately not requested, and that is the whole performance story of
 * this file.** It propagates to `initializeLightSources`, which is
 * `for (const source of this.lightSources) source.initialize()`
 * (`canvas/groups/effects.mjs:172-175`) — a wall sweep for *every light on the scene*. Core's
 * `AmbientLight#initializeLightSource` asks for it because that is how it re-initialises its own
 * source: it goes through the collection. This module initialises its source directly, one line
 * earlier, so asking for the collection pass as well re-sweeps every other light on the map to
 * achieve nothing.
 *
 * Requested per animation frame it dropped the frame rate through the floor on the first test
 * (reported 2026-08-30). What a moving darkness actually needs is its **edges** rebuilt, which is a
 * separate and far cheaper flag: `refreshEdges` → `canvas.edges.refresh()`
 * (`perception/perception-manager.mjs:85`).
 *
 * If darkness edges ever look stale after a move, `initializeLighting` is the flag that was removed
 * — but the fix is then to find out why `refreshEdges` was insufficient, not to put the sweep back.
 *
 * @param {boolean} edges - Does a darkness source take part? Only darkness creates edges.
 */
function perceptionUpdate(edges) {
  canvas?.perception?.update({
    refreshEdges: edges,
    // The umbra is swept per observer against the edges above, so it has to follow them.
    initializeVision: edges,
    refreshLighting: true,
    refreshVision: true,
  });
}

/* -------------------------------------------- */

/**
 * Does core re-initialise sources during a token's movement animation?
 *
 * @remarks
 * `core.visionAnimation` gates exactly that in `Token#_onAnimationUpdate`
 * (`placeables/token.mjs:2236`): with it off, core stops updating light and vision mid-animation and
 * everything settles on arrival. An effect that kept following per frame would be both inconsistent
 * with every other light in the world and the expensive half of a trade the user has already
 * declined. §9.8 named this setting the single largest performance lever available.
 *
 * Cached locally rather than through `settings-cache.mjs`, which is namespaced to this module.
 * `game.settings.get` is O(n) over every Setting document in the world (§9.8.1, 14.7 µs) and this
 * would otherwise be read once per token per frame.
 */
let visionAnimation = null;

function followsAnimation() {
  if (visionAnimation === null) {
    try {
      visionAnimation = game.settings.get("core", "visionAnimation") === true;
    } catch {
      return true;
    }
  }
  return visionAnimation;
}

/**
 * Move the companions belonging to one anchor, without touching membership.
 *
 * @remarks
 * The movement path, and it deliberately does none of {@link sync}'s reconciliation: a token
 * walking changes no record, so there is nothing to diff. `registry` is not invalidated either —
 * position is not cached there (`contributionAt` reads `source.x` live), so a light-bearing token
 * moving does not stale it.
 */
export function moved(anchorDoc) {
  if (!anchorDoc || !canvas?.ready) return 0;
  const prefix = `${anchorDoc.uuid}::`;
  let count = 0;
  let edges = false;
  for (const [key, companion] of live) {
    if (!key.startsWith(prefix)) continue;
    // Skipped when the anchor has not actually moved, which is most `refreshToken` events.
    if (!companion.refresh(anchorDoc)) continue;
    // A darkness creates edges, so moving one leaves the umbra geometry stale unless they are
    // rebuilt. §12.6's asymmetry at its sharpest: a *darkness* following a fleeing rogue pays an
    // edge refresh and a vision re-initialise per frame where a torch pays neither.
    edges ||= companion.negative;
    count++;
  }
  // Only when something actually moved. Asking for a perception update per `refreshToken` would
  // undo the guard above, the flags being the expensive half rather than the sweep.
  if (count) perceptionUpdate(edges);
  return count;
}

/** Drop everything. Scene teardown, and the first half of a rebuild. */
export function teardown() {
  for (const companion of live.values()) companion.destroy();
  live.clear();
  liveAnchors.clear();
}

/* -------------------------------------------- */
/*  Upkeep — the reaper and the expiry sweep    */
/* -------------------------------------------- */

/**
 * Every anchor in the **world** that carries a record.
 *
 * @remarks
 * All scenes, not just the drawn one, and that is the point of the reaper: an orphan sits on a token
 * nobody is looking at, and the management window is deliberately scene-scoped (§12.10). This costs
 * a flag read per placeable per scene and touches no canvas, which is what makes running it on
 * `ready` affordable. `ui/light-config.syncAllLights` walks the world the same way.
 */
function anchorsInWorld() {
  const out = [];
  for (const scene of game.scenes ?? []) out.push(...anchorsOnScene(scene));
  return out;
}

/**
 * Is this record's owner gone, or no longer in force?
 *
 * @remarks
 * A record with **no `source` is never reaped** — that is what an API caller opts into by omitting
 * it, and the reaper must not quietly collect an effect nothing claims to own.
 *
 * A deactivated PF1 buff counts as gone. The ordinary route out is the toggle driver (§12.7), which
 * clears on `pf1ToggleActorBuff`; this catches the crash between the buff switching off and the
 * clear landing, which is exactly the case the reaper exists for.
 *
 * Exported so the management window's *orphaned* column and its **Clear orphans** button use the
 * reaper's own predicate rather than a second one that looks the same. Two definitions of orphaned
 * would eventually disagree, and the window would then be reporting rows the reaper declines to
 * collect — or, worse, the other way round.
 */
export async function orphaned(record) {
  if (!record?.source) return false;
  let owner = null;
  try {
    owner = await fromUuid(record.source);
  } catch {
    return true;
  }
  if (!owner) return true;
  if (owner.documentName === "Item" && owner.type === "buff" && owner.system?.active === false) {
    return true;
  }
  return false;
}

/**
 * Drop records whose owner has gone. **Active GM only.**
 *
 * @remarks
 * `isWriter` rather than `isGM`: a world setting's `onChange` and a `ready` hook both fire on every
 * connected client, so without it every GM present would issue the same deletions and the players
 * would each attempt one they are refused. The same guard `ui/scene-config` and `ui/light-config`
 * already use.
 *
 * @returns {Promise<{checked: number, removed: number, anchors: number}>}
 */
export async function reap() {
  const report = { checked: 0, removed: 0, anchors: 0 };
  if (!isWriter()) return report;

  for (const doc of anchorsInWorld()) {
    const dead = [];
    for (const record of list(doc)) {
      report.checked++;
      if (await orphaned(record)) dead.push(record.id);
    }
    if (!dead.length) continue;
    report.anchors++;
    report.removed += (await socket.request("clear", { anchorUuid: doc.uuid, ids: dead })) ?? 0;
  }

  if (report.removed) console.error(`${MODULE_ID} | reaped orphaned light effects`, report);
  return report;
}

/**
 * End effects whose time is up. **Active GM only.**
 *
 * @remarks
 * `worldTime` is taken from the hook argument rather than from `game.time.worldTime`, and that is
 * not fussiness: time updates are async and nothing awaits a hook, so at a turn boundary
 * `game.time.worldTime` can still hold the previous value while the hook is being told the new one
 * (`reference_pf1_expiration_timeoffset`). Reading the clock here would expire a round late, once,
 * intermittently — the worst shape of bug to be handed.
 *
 * Effects with no `expires` last until something removes them, which is every effect a buff or a
 * lantern owns; duration for those belongs to the thing that owns them, not to this.
 *
 * @param {number} [worldTime=game.time.worldTime]
 * @returns {Promise<{expired: number}>}
 */
export async function sweep(worldTime = game.time?.worldTime ?? 0) {
  const report = { expired: 0 };
  if (!isWriter()) return report;

  for (const doc of anchorsInWorld()) {
    const done = list(doc)
      .filter((r) => Number.isFinite(r.expires) && r.expires <= worldTime)
      .map((r) => r.id);
    if (!done.length) continue;
    report.expired += (await socket.request("clear", { anchorUuid: doc.uuid, ids: done })) ?? 0;
  }
  return report;
}

/* -------------------------------------------- */
/*  Placing a real light                        */
/* -------------------------------------------- */

/**
 * Create an ordinary `AmbientLight` at a point, configured from a preset.
 *
 * @remarks
 * Not an effect, and deliberately a different verb. DESIGN.md §12.11 refuses a *bare point* as an
 * anchor because a light that stays at a spot is an `AmbientLight` — so this is the answer to the
 * question that asked for one: a permanent, GM-editable placeable, created and then owned by the
 * scene rather than by this module.
 *
 * `presets.applyPreset` already returns exactly the creation payload, in dotted paths, for the
 * `config` prefix an AmbientLight uses.
 *
 * @param {{x: number, y: number}} point - Scene pixels
 * @param {object} [options]
 * @param {string} [options.preset]
 * @param {object} [options.config] - Extra `AmbientLightDocument` fields, e.g. `{rotation, walls}`
 * @param {Scene} [options.scene=canvas.scene]
 * @returns {Promise<AmbientLightDocument|null>}
 */
export async function place(point, { preset, config = {}, scene = canvas?.scene } = {}) {
  if (!scene) return null;
  // GM only. Creating an `AmbientLight` is a scene-level document creation, and Hamilcarbarcas
  // 2026-08-30: a player could reasonably be allowed this in niche cases, but does not need it. The
  // relay would carry it the day one turns up; nothing here has to change but this test.
  if (!game.user.isGM) {
    ui.notifications?.warn(`${MODULE_ID}: only a GM can place a light`);
    return null;
  }
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
    ui.notifications?.warn(`${MODULE_ID}: a light needs a point to be placed at`);
    return null;
  }

  // `config` is the AmbientLight's own prefix, and `applyPreset` already returns dotted paths for
  // it — the native fields and the module's flags together.
  const data = foundry.utils.expandObject({
    ...(preset ? applyPreset(preset, { prefix: "config" }) : {}),
    x: Math.round(point.x),
    y: Math.round(point.y),
  });
  foundry.utils.mergeObject(data, config);

  const [created] = await scene.createEmbeddedDocuments("AmbientLight", [data]);
  return created ?? null;
}

/* -------------------------------------------- */
/*  Hooks                                       */
/* -------------------------------------------- */

/** Anchors whose companions need moving, flushed once per frame. */
const dirty = new Set();
let frame = null;

function markMoved(doc) {
  // The rejection that keeps this off the drag profile: `refreshToken` fires for every token on the
  // scene, and almost none of them carry an effect.
  if (!doc || !liveAnchors.has(doc.uuid)) return;
  dirty.add(doc);
  if (frame !== null) return;
  frame = requestAnimationFrame(() => {
    frame = null;
    const docs = [...dirty];
    dirty.clear();
    for (const d of docs) moved(d);
  });
}

/** Did an update touch the records? */
const touchesEffects = (changed) =>
  foundry.utils.hasProperty(changed, `flags.${MODULE_ID}.${EFFECTS_FLAG}`) ||
  foundry.utils.hasProperty(changed, `flags.${MODULE_ID}.-=${EFFECTS_FLAG}`);

export function registerHooks() {
  Hooks.on("canvasReady", () => {
    teardown();
    sync();
  });
  Hooks.on("canvasTearDown", teardown);

  for (const type of ["Token", "Tile", "MeasuredTemplate"]) {
    Hooks.on(`update${type}`, (doc, changed) => {
      if (touchesEffects(changed)) sync();
      // Position, and only for anchors that carry something — `markMoved` returns immediately
      // otherwise, which is every token on an ordinary scene.
      else if ("x" in changed || "y" in changed || "rotation" in changed ||
               "direction" in changed || "elevation" in changed) {
        markMoved(doc);
      }
    });
    Hooks.on(`delete${type}`, () => sync());
    Hooks.on(`create${type}`, (doc) => {
      if (list(doc).length) sync();
    });
  }

  // The animated position. `updateToken` puts the document at its destination immediately and the
  // placeable walks there afterwards (§12.4), so following the document alone would teleport the
  // light and leave the token behind it. Coalesced to one flush per frame, like this module's five
  // other `refreshToken` listeners (§9.8).
  Hooks.on("refreshToken", (token) => {
    if (!liveAnchors.size) return;
    // A drag preview is a clone that KEEPS ITS ID — `this.document.clone({}, {keepId: true})`
    // (`placeables/placeable-object.mjs:658`) — so it has the anchor's uuid and passes every test
    // below it. Left alone, the preview and the original both drove the same companion on every
    // frame of a drag, each writing the other's position back: reported as "a lot of glitching when
    // clicking to drag the token" on the first test, 2026-08-30.
    //
    // The effect settles on drop, which is `registry.usable()`'s answer to the identical problem
    // (`model/registry.mjs:402-406`) and the module's established position on previews.
    if (token.isPreview) return;
    if (!followsAnimation()) return;
    markMoved(token.document);
  });

  // The one setting read on a per-frame path, so its value is held rather than fetched.
  Hooks.on("updateSetting", (setting) => {
    if (setting?.key === "core.visionAnimation") visionAnimation = null;
  });

  // Upkeep (§12.5.2). Both are `isWriter`-gated inside, so they are no-ops on every other client.
  //
  // `ready` catches whatever happened while nobody was connected — a buff deleted, a world rolled
  // back, a crash between a toggle and its clear. `canvasReady` is the cheap safety net for the
  // scene actually being looked at.
  Hooks.once("ready", () => reap());
  Hooks.on("canvasReady", () => reap());

  // The hook's own `worldTime`, never `game.time.worldTime` — see `sweep`.
  Hooks.on("updateWorldTime", (worldTime) => sweep(worldTime));
}

/* -------------------------------------------- */

/**
 * Debug readout.
 *
 *   game.pf1Lighting.effects.status()
 */
export function status() {
  const rows = [];
  for (const [key, companion] of live) {
    rows.push({
      key,
      label: companion.record.label,
      preset: companion.record.preset,
      kind: companion.negative ? "darkness" : "light",
      sourceId: companion.source.sourceId,
      active: companion.source.active,
      // The trap that would otherwise be invisible: a preview source renders and is ignored by the
      // model, so this must read false on every row.
      isPreview: companion.object.isPreview,
      x: companion.doc.x,
      y: companion.doc.y,
      source: companion.record.source,
    });
  }
  const report = {
    live: rows.length,
    anchors: canvas?.ready ? anchorsOnScene().length : 0,
    effects: rows,
  };
  console.error(`${MODULE_ID} | light effects`, report);
  return report;
}
