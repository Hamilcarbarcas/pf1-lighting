/**
 * *Restrict Global Illumination* — a region that moves the light-level floor. DESIGN.md §10.7.
 *
 * Hamilcarbarcas's fourth control point was *"a region that excludes global illumination"*, and this is
 * that generalised by one step: a region carrying a **tier** and a **mode**, which sets, lowers
 * or raises the ambient light level inside it. "Exclude global illumination" is *at most Dark*.
 *
 * The name is the scope. This changes **global illumination and nothing else** — it is not a
 * dimmer, not a suppressor, and it has no opinion about any light in it. Everything below that
 * looks like a general "ambient" mechanism is that one claim seen from a different angle.
 *
 * ## Why not core's `AdjustDarknessLevel`
 *
 * Because we paint over it, and reported so: core's behaviour builds a `RegionMesh` with
 * `AdjustDarknessLevelRegionShader` into `canvas.effects.illumination.darknessLevelMeshes`
 * (`adjust-darkness-level.mjs:66-88`), and `render/darkness-texture.mjs` builds meshes of the
 * same class, with the same shader, in `MODE_OVERRIDE`, into the same container. `addChild`
 * appends, ours draw last, and our ground fill covers the whole scene rect. The region's value
 * is overwritten everywhere it could matter.
 *
 * Cooperating with it was possible and wrong for §4.1.1's reason: it makes the *picture* the
 * arbiter of a value the model owns, and composes by draw order rather than by the contest.
 *
 * ## What this is, in the model
 *
 * The ambient tier is `A` — the base every §3.2.1 band adds rungs to, and what a suppressor
 * transforms *down from*. An ambient area makes `A` **position-dependent** and changes nothing
 * else. Concretely:
 *
 * - Lights inside still light, and still add their bands. A torch in an unlit cellar is a torch.
 * - A *darkness* inside still suppresses, from the lower base.
 * - The area casts **no umbra** and is not a suppressor. It is not magical darkness; it is an
 *   unlit room. `castsUmbra` never sees it.
 * - Nothing about it is observer-relative.
 *
 * That is the whole feature, and it is why it composes: everything downstream already reads `A`
 * through {@link ambientTierAt}.
 *
 * ## How it reaches the screen
 *
 * It does not draw anything of its own. `field.compute` emits the area as an ordinary
 * `kind: "ambient"` cell at the area's tier, `render/paint.mjs` puts it in the darkness-level
 * texture with every other ground cell, and §7.0's shader threshold discards global
 * illumination per fragment wherever that texture reads darker than {@link globalLightCutoff}.
 * No polygon on the global light source, no second mechanism.
 *
 * **So this needs *Model global illumination* on to be visible.** With it off the model answers
 * correctly — the readout, perception and detection all move — and the map does not change,
 * because the texture is the only channel through which anything can be darkened below global
 * light. {@link status} reports that rather than leaving it to be discovered.
 *
 * ## The cost, and the case that must stay free
 *
 * A scene with no ambient areas must take exactly the path it took before this existed, down to
 * the Clipper op count. {@link areas} returns an empty array and every consumer's `if` short-
 * circuits — the same discipline as the no-suppressor fast path in `field.compute`.
 */

import { MODULE_ID } from "../constants.mjs";
import { CLIPPER_SCALE, containsPoint } from "../geometry.mjs";
import { TIER, TIER_NAME } from "./tiers.mjs";

/**
 * The behavior type key.
 *
 * @remarks
 * Foundry namespaces module-provided sub-types as `${moduleId}.${type}`, and the bare half has
 * to be declared in `module.json` under `documentTypes.RegionBehavior` — a data-model class
 * registered into `CONFIG.RegionBehavior.dataModels` without the manifest entry is never offered
 * in the *Add Behavior* list. So this string is authored in two places that must agree, and the
 * manifest half is why the feature needs a **full Foundry reload** rather than an F5.
 */
export const BEHAVIOR_TYPE = `${MODULE_ID}.globalIllumination`;

/**
 * How an area's tier combines with the scene's.
 *
 * @remarks
 * `AT_MOST` is the default, and the reason is time of day. *Set* looks like the obvious
 * semantics until an outdoor scene's ambient drops to Dark at night, at which point a cellar
 * configured *set Dark* is exactly as bright as the field outside it — and a cellar configured
 * *set Dim* is **brighter**. A room that is unlit is unlit relative to whatever the sky is
 * doing, which is a clamp, not an assignment.
 *
 * `SET` is kept because a magically lit vault on a dark map is a real case and a clamp cannot
 * express it. `AT_LEAST` is that case's other half and costs one line.
 */
export const MODE = Object.freeze({
  SET: "set",
  AT_MOST: "atMost",
  AT_LEAST: "atLeast",
});

const MODE_LABEL = Object.freeze({
  [MODE.SET]: "Set to",
  [MODE.AT_MOST]: "At most",
  [MODE.AT_LEAST]: "At least",
});

/** Tier choices for a select, ascending. */
const TIER_CHOICES = Object.freeze(
  Object.fromEntries(Object.values(TIER).map((tier) => [tier, TIER_NAME[tier]])),
);

/* -------------------------------------------- */
/*  The behavior                                */
/* -------------------------------------------- */

/**
 * Build the `RegionBehaviorType` subclass.
 *
 * @remarks
 * Built inside a function rather than at module scope because `foundry.data.regionBehaviors`
 * does not exist until Foundry's own modules have evaluated, and an ES import of this file runs
 * before that. Called from {@link registerBehavior} at `init`.
 *
 * **No `static events`.** Every other behaviour in core reacts to tokens entering and leaving;
 * this one is a passive value that the model reads by position, so there is no event whose
 * firing would tell us anything. What it needs instead is *invalidation*, which is
 * {@link registerHooks} — a different mechanism for a different question.
 *
 * Labels are hardcoded English, like every other user-facing string in this module. §10.6 moves
 * the lot into `lang/en.json` in one pass; splitting it early would leave this file as the one
 * place where a label lives somewhere other than the thing it describes.
 */
function defineBehavior() {
  const { StringField, NumberField } = foundry.data.fields;
  const Base = foundry.data.regionBehaviors.RegionBehaviorType;

  return class GlobalIlluminationBehaviorType extends Base {
    static defineSchema() {
      return {
        mode: new StringField({
          required: true,
          blank: false,
          initial: MODE.AT_MOST,
          choices: MODE_LABEL,
          label: "Mode",
          hint:
            "At most is an unlit interior — dark relative to whatever the sky is doing, so it " +
            "stays dark when the scene brightens and does not become a light source at night. " +
            "Set overrides the scene outright.",
        }),
        tier: new NumberField({
          required: true,
          nullable: false,
          integer: true,
          initial: TIER.DARK,
          choices: TIER_CHOICES,
          label: "Light level",
          hint:
            "The ambient level inside this region. Lights placed here still light it and a " +
            "darkness still suppresses it; only the base level moves.",
        }),
      };
    }
  };
}

/**
 * Register the data model and its icon.
 *
 * @remarks
 * **The label is not set here, and the first build's attempt to was wrong** (found by Hamilcarbarcas
 * 2026-08-26 — the *Create Region Behavior* dropdown showed the raw type key). Assigning a plain
 * English string into `CONFIG.RegionBehavior.typeLabels` works in two of the three places Foundry
 * shows it and fails in the one that matters most:
 *
 * ```js
 * let label = CONFIG[this.documentName]?.typeLabels?.[type];
 * label = label && game.i18n.has(label) ? game.i18n.localize(label) : type;
 * ```
 *
 * `ClientDocument.createDialog` (`abstract/client-document.mjs:822-823`) demands a **key that
 * exists**, not a string that localises — `game.i18n.has()` is false for any literal — and falls
 * back to the bare type name. `RegionConfig` (`sheets/region-config.mjs:114`) calls plain
 * `localize`, which is why the behaviour list beside it read correctly and the dropdown did not.
 * A readout that is right in the places you happen to look.
 *
 * So the label lives in `lang/en.json` under the key `Localization#initialize` writes by default
 * (`helpers/localization.mjs:72-73`) and nothing is assigned here at all. This is the one
 * user-facing string in the module that **cannot** stay in the source it describes; §10.6 moves
 * the rest to join it.
 *
 * `typeIcons` is untouched by any of that — it is a class name, never localised.
 */
export function registerBehavior() {
  const models = CONFIG.RegionBehavior?.dataModels;
  if (!models || models[BEHAVIOR_TYPE]) return;

  models[BEHAVIOR_TYPE] = defineBehavior();
  // Deliberately **not** `fa-circle-half-stroke`: that is core's *Adjust Darkness Level*, the one
  // behaviour this replaces and the one a GM is most likely to reach for by mistake. Two entries
  // in the same list wearing the same icon is the wrong place to save a decision.
  CONFIG.RegionBehavior.typeIcons[BEHAVIOR_TYPE] = "fa-solid fa-brightness-low";
}

/* -------------------------------------------- */
/*  Resolution                                  */
/* -------------------------------------------- */

/** @type {{behavior: object, region: object, mode: string, tier: number}[]|null} */
let cache = null;

/** @type {(() => object[])[]} Sources of computed areas — see {@link registerProvider}. */
const providers = [];

/** Bumped on every invalidation; the field's signature rides on it. */
let generation = 0;

/** @returns {number} */
export const version = () => generation;

export function invalidate() {
  cache = null;
  generation++;
}

/**
 * Every enabled ambient area on the current scene.
 *
 * @remarks
 * Order is document order and is **not** a precedence: {@link ambientTierAt} folds the modes in
 * sequence, so two overlapping areas compose rather than one winning. Two *at most* areas is a
 * `min`, which is order-independent; a *set* under an *at most* is not, and that is the GM's
 * problem in the same way two overlapping darkness sources are.
 *
 * Geometry comes from `RegionDocument#polygonTree`, whose nodes carry `isHole` — so a region
 * with a hole in it reaches Clipper as a hole rather than as a second filled island. The
 * placeable's own `polygons`/`testPoint` accessors are deprecated in v13 in favour of the
 * document's, which is what these are.
 *
 * @returns {{behavior: object, region: object, mode: string, tier: number}[]}
 */
export function areas() {
  if (cache) return cache;

  const out = [];
  const scene = canvas?.scene;
  if (!scene) return (cache = out);

  for (const region of scene.regions ?? []) {
    for (const behavior of region.behaviors ?? []) {
      if (behavior.type !== BEHAVIOR_TYPE || behavior.disabled) continue;
      const tier = behavior.system?.tier;
      if (!Number.isFinite(tier)) continue;
      out.push({
        behavior,
        region,
        mode: behavior.system?.mode ?? MODE.AT_MOST,
        tier,
      });
    }
  }

  // **Derived areas last, and the order is load-bearing.** {@link ambientTierAt} and
  // `field.ambientDomains` both fold in list order, and the modes do not commute: §3.4's spill
  // is an `AT_LEAST` into a room a drawn region clamped with `AT_MOST`, so
  // `max(min(Bright, Dark), Bright)` is Bright only while the clamp runs first. Reversed, the
  // clamp eats the spill and the feature silently does nothing.
  for (const provider of providers) {
    const derived = provider();
    if (derived?.length) out.push(...derived);
  }

  return (cache = out);
}

/**
 * Register a source of **computed** ambient areas — §3.4's light spill, today.
 *
 * @remarks
 * A provider rather than an import so the dependency runs one way: `model/spill.mjs` reads this
 * module freely, and this module knows nothing about it. That is what makes the feature
 * separable — a build with spill disabled registers no provider and every loop below is
 * identical to the one that existed before it.
 *
 * A provider must be a **pure cache read**. It is called from inside {@link areas}, so anything
 * that rebuilds lazily here would re-enter this function through its own ambient queries.
 *
 * @param {() => object[]} provider
 */
export function registerProvider(provider) {
  if (!providers.includes(provider)) providers.push(provider);
  invalidate();
}

/**
 * Fold one area's mode into a running tier.
 *
 * @remarks
 * Exported because `field.ambientDomains` folds the same way over polygons that this folds over
 * a point, and the two agreeing is not something a comment can enforce.
 *
 * @param {number} base
 * @param {{mode: string, tier: number}} area
 * @returns {number}
 */
export function foldTier(base, area) {
  switch (area.mode) {
    case MODE.SET:
      return area.tier;
    case MODE.AT_LEAST:
      return Math.max(base, area.tier);
    default:
      return Math.min(base, area.tier);
  }
}

/**
 * Does an area cover a point?
 *
 * @remarks
 * **Deliberately 2D**, per §3.6. A region carries `elevation.bottom`/`top` and
 * `RegionDocument#testPoint` tests them, but the model has no elevation anywhere else — every
 * emitter is a disc on the floor — so consulting it here would make ambient the one quantity
 * with a third dimension, and a cellar region authored at its real depth would then apply to
 * nothing. Revisit when §3.6 does.
 */
export function covers(area, point) {
  // A derived area (§3.4) has no document and no `polygonTree`; it carries its own rings, and
  // they can contain holes, so the test has to be even-odd across all of them rather than
  // "inside any" — see `geometry.containsPoint`.
  if (area.derived) return containsPoint(area.polygons ?? [], point);
  return area.region.polygonTree?.testPoint(point) === true;
}

/**
 * The ambient tier at a point, given the scene's.
 *
 * @remarks
 * The scene tier is passed in rather than read, because the two callers already have it and one
 * of them (`registry.ambientTier`) is what would be re-entered if this read it back.
 *
 * @param {{x: number, y: number}} [point] - Omit for the scene tier untouched
 * @param {number} base - The scene's ambient tier
 * @param {object} [options]
 * @param {boolean} [options.derived=true] - Include computed areas (§3.4's spill). Pass `false`
 *   to ask what tier **the room** is, ignoring anything spilled into it. `model/spill.mjs` needs
 *   that and is the only caller that does: reading the folded answer would make a patch this
 *   file lit last frame report the spill tier, fail spill's own `spillTier > interiorTier`
 *   guard, and switch the feature off one rebuild after it started working.
 * @returns {number} A {@link TIER} value
 */
export function ambientTierAt(point, base, { derived = true } = {}) {
  const list = areas();
  if (!list.length || !point) return base;

  let tier = base;
  for (const area of list) {
    if (!derived && area.derived) continue;
    if (covers(area, point)) tier = foldTier(tier, area);
  }
  return tier;
}

/* -------------------------------------------- */
/*  Geometry, for the field                     */
/* -------------------------------------------- */

/**
 * An area's outline as Clipper paths at `scale`, holes wound against their outer ring.
 *
 * @remarks
 * Orientation is normalised from `node.isHole` rather than trusted from the source paths,
 * because `field.mjs` runs Clipper with `pftNonZero` — under which a hole wound the same way as
 * its outer ring fills solid instead of cutting. Foundry does wind them correctly today
 * (`polygon-tree.mjs:264` sets `_isPositive` from the same flag); normalising costs one
 * orientation test per ring and removes the dependency.
 *
 * @param {object} area
 * @param {number} scale
 * @returns {{X: number, Y: number}[][]}
 */
export function pathsFor(area, scale) {
  // Derived areas (§3.4) arrive already in Clipper space at `CLIPPER_SCALE`, because they were
  // built there. Rescaling is a loop nobody has needed yet — `field` and `spill` both work at
  // that scale — but it is written out rather than asserted, so a future caller at another
  // scale gets the right answer instead of a polygon a hundred times too big.
  if (area.derived) {
    if (scale === CLIPPER_SCALE) return area.paths;
    const k = scale / CLIPPER_SCALE;
    return area.paths.map((path) => path.map((p) => ({ X: Math.round(p.X * k), Y: Math.round(p.Y * k) })));
  }

  const paths = [];
  for (const node of area.region.polygonTree ?? []) {
    const points = node.polygon?.points;
    if (!points?.length) continue;

    const path = new Array(points.length / 2);
    for (let i = 0, j = 0; i < points.length; i += 2, j++) {
      path[j] = { X: Math.round(points[i] * scale), Y: Math.round(points[i + 1] * scale) };
    }

    // `Orientation` is true for a positively-oriented ring. An outer must be positive and a
    // hole negative for NonZero to cut rather than fill.
    if (ClipperLib.Clipper.Orientation(path) === node.isHole) path.reverse();
    paths.push(path);
  }
  return paths;
}

/* -------------------------------------------- */
/*  Invalidation                                */
/* -------------------------------------------- */

/**
 * @remarks
 * Both halves are needed and they are not the same event. A region's *shape* changes on
 * `updateRegion`; its *values* change on `updateRegionBehavior`, which does not touch the
 * region document at all. Missing the second is the failure where editing the tier does
 * nothing until the region is nudged.
 *
 * `canvasReady` clears rather than rebuilds — the next read does that, and on a scene with no
 * areas there is nothing to build.
 */
export function registerHooks() {
  const dirty = () => {
    invalidate();
    // The field caches on a signature that includes {@link version}, so this is what makes the
    // ambient cells rebuild. Requested as a lighting change, not a vision one: the area moves
    // the ground's tier, and vision follows from the tier rather than the other way round.
    if (canvas?.ready) {
      canvas.perception.update({ refreshLighting: true, refreshVision: true });
    }
  };

  for (const hook of ["createRegion", "updateRegion", "deleteRegion"]) Hooks.on(hook, dirty);
  for (const hook of ["createRegionBehavior", "updateRegionBehavior", "deleteRegionBehavior"]) {
    Hooks.on(hook, dirty);
  }
  Hooks.on("canvasReady", () => invalidate());
}

/* -------------------------------------------- */
/*  Diagnostics                                 */
/* -------------------------------------------- */

/**
 * What ambient areas exist, and whether they can be seen.
 *
 * @remarks
 * `visible: false` with areas present is the expected shape of "I added the region and nothing
 * happened": the model has moved and the picture cannot, because §7.0's texture is the only
 * route by which anything darkens global illumination.
 */
export function status() {
  const list = areas();
  const drawn = list.filter((area) => !area.derived);
  // The key by name rather than `ambient.SETTING_AMBIENT` by import: `model/` does not import
  // from `render/`, and a diagnostic is not the place to open that direction. The cost of the
  // string going stale is one wrong line in a readout.
  const takeover = (() => {
    try {
      return game.settings.get(MODULE_ID, "ambientTakeover") === true;
    } catch {
      return false;
    }
  })();

  const report = {
    registered: !!CONFIG.RegionBehavior?.dataModels?.[BEHAVIOR_TYPE],
    // The manifest half. `false` means `documentTypes` is missing from module.json or the world
    // has not been relaunched since it was added, and the behaviour is not offered in the UI
    // however healthy `registered` looks.
    declared: game.documentTypes?.RegionBehavior?.includes(BEHAVIOR_TYPE) ?? false,
    // **The third independent half**, and it fails on its own. The label reaches the *Create
    // Region Behavior* dropdown only through `game.i18n.has()`, so a missing `lang/en.json` — or
    // a world not relaunched since `languages` was added to the manifest — leaves the type
    // registered, working, and listed under its raw key. Anything other than the label here
    // means the language file did not load.
    label: (() => {
      const key = CONFIG.RegionBehavior?.typeLabels?.[BEHAVIOR_TYPE];
      return key && game.i18n.has(key) ? game.i18n.localize(key) : `UNLOCALISED (${key})`;
    })(),
    // Drawn regions only. Derived areas (§3.4) are in the same list and fold the same way, but
    // this readout is about the *behaviour* — every field below it reads off a document — and
    // they have their own: `game.pf1Lighting.spill.stats()`.
    count: drawn.length,
    derived: list.length - drawn.length,
    // Whether an area can change the picture at all — see the file header.
    visible: takeover,
    // **The other way an area does nothing.** These regions move the *ambient*, and global
    // illumination is where the ambient comes from: with it disabled on the scene there is no
    // ambient entry in the registry, so there is nothing to override and a *set Bright* area is
    // as inert as a *set Dark* one. Place a light instead.
    globalLight: canvas?.scene?.environment?.globalLight?.enabled ?? null,
    generation,
    areas: drawn.map((area) => ({
      region: area.region.name,
      mode: MODE_LABEL[area.mode] ?? area.mode,
      tier: TIER_NAME[area.tier],
      shapes: area.region.polygonTree ? [...area.region.polygonTree].length : 0,
      elevation: { ...area.region.elevation },
    })),
  };
  console.error(`${MODULE_ID} | ambient areas`, report);
  return report;
}
