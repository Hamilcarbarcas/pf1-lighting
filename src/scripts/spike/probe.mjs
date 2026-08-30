/**
 * Vertical slice, steps 3 and 4 — readouts. DESIGN.md §8.1.
 *
 * Console-facing helpers for checking what the model thinks, and for confirming the module's source
 * subclass sits on top of PF1's and `limits`' mixins rather than beside them (§6.6).
 */

import {
  CLIP,
  DARK_ANIMATION,
  HIDDEN,
  LEVEL,
  MODULE_ID,
  RENDER_SHAPE,
  STRENGTH,
  VISION_RANK,
  isSynthetic,
} from "../constants.mjs";
import { containsPoint } from "../geometry.mjs";
import { evaluate, evaluate as modelEvaluate } from "../model/evaluate.mjs";
import * as field from "../model/field.mjs";
import { TIER_NAME } from "../model/tiers.mjs";
import * as registry from "../model/registry.mjs";
import * as areas from "../model/areas.mjs";
import { suppressorConfigOf } from "../model/registry.mjs";
import { blocksSight, castsUmbra } from "../model/contest.mjs";
import { RAW_BLIND, RAW_BLINDED, isNativeSuppressionDisabled } from "../suppression.mjs";
import * as perceptionModel from "../vision/perception.mjs";
import * as blindness from "../vision/blindness.mjs";
import * as umbraModel from "../vision/umbra.mjs";
import { currentSaturation, observerIgnoresDarkness } from "../render/desaturate.mjs";

/**
 * One-line summary of an evaluation.
 *
 * Spells out the `winner` / `applied` distinction: a suppressor being present and a suppressor
 * having done something are different facts, and the shorter readout conflated them.
 */
function describe(result) {
  const head = `${result.tierName} (B=${result.B.toFixed(3)})`;
  if (result.negated?.length) {
    return `${head} — ${result.negated.length} suppressor(s) annihilated by daylight`;
  }
  if (!result.winner) return head;
  if (!result.applied) return `${head} — suppressor present but ineffective`;
  return `${head} — reduced from ${TIER_NAME[result.baselineTier]}`;
}

/* -------------------------------------------- */
/*  Where was actually sampled                  */
/* -------------------------------------------- */

let marker = null;
let markerTimer = null;

/**
 * Draw a crosshair at a sampled point.
 *
 * @remarks
 * `canvas.mousePosition` is the last position the pointer had over the canvas, and reaching the
 * console means leaving it. So every cursor-defaulting readout in this file samples wherever the
 * mouse was before typing started, which on a scene with two overlapping effects is reliably the
 * wrong side of a boundary — and the output looks healthy, being a correct answer to a question
 * nobody asked.
 *
 * Cost one round trip on 2026-08-23: a daylight absent from `emittersAt` read as the annihilation
 * failing, when the point was simply outside the daylight. Marking it makes the two cases
 * distinguishable at a glance instead of by arithmetic on the emission.
 */
export function mark(x, y, { ms = 6000 } = {}) {
  if (!canvas?.ready) return null;
  clearMark();

  marker = new PIXI.Graphics();
  marker.eventMode = "none";
  const r = canvas.dimensions.size / 2;
  marker.lineStyle(3, 0x00ffff, 1);
  marker.drawCircle(x, y, r);
  marker.moveTo(x - r * 1.5, y).lineTo(x + r * 1.5, y);
  marker.moveTo(x, y - r * 1.5).lineTo(x, y + r * 1.5);
  canvas.interface.addChild(marker);

  markerTimer = setTimeout(clearMark, ms);
  return marker;
}

/** Remove the crosshair. */
export function clearMark() {
  if (markerTimer) clearTimeout(markerTimer);
  markerTimer = null;
  if (!marker) return;
  marker.destroy();
  marker = null;
}

/**
 * Which of `field()`'s cells contain a point?
 *
 * @remarks
 * The missing half of every report that the tooltip disagrees with the screen. The tooltip is
 * `evaluate()` and the picture is `field()`, and until this existed nothing printed both for one
 * point — so a disagreement between the two model paths and a disagreement between the model and
 * someone's expectation looked identical.
 *
 * Even-odd across each cell's rings, because an `ambient` cell is the scene less every darkness on
 * it (§7.0) and testing only its outer ring would report ambient inside a bubble.
 *
 * @param {number} [x]
 * @param {number} [y]
 * @returns {object[]}
 */
export function cellsAt(x, y) {
  const point = x === undefined ? canvas.mousePosition : { x, y };
  const hits = [];

  for (const cell of field.get().cells) {
    if (!cell.polygon?.points?.length) continue;
    if (!containsPoint([cell.polygon, ...(cell.holes ?? [])], point)) continue;
    hits.push({
      kind: cell.kind,
      tier: cell.tier,
      tierName: cell.tier === undefined ? undefined : TIER_NAME[cell.tier],
      // The ground this cell is standing on, and since §4.1.1a a darkness region is one of those.
      // What `levelForTier` and `zonesFor` measure a light's zones against, so a light reading the
      // scene's tier here rather than the region's is the whole failure mode of that change — and it
      // is invisible in `tier`, which for a `clip` cell is undefined.
      base: cell.base,
      baseName: cell.base === undefined ? undefined : TIER_NAME[cell.base],
      emitter: cell.emitter?.id ?? null,
      suppressor: cell.suppressor?.id ?? null,
      holes: cell.holes?.length ?? 0,
      // `stack` only. How many relative bands overlap here and what they sum to (§3.2.1) — the two
      // numbers that say whether an over- or under-bright overlap is the geometry's fault or the
      // arithmetic's.
      ...(cell.kind === "stack" ? { bands: cell.bands, steps: cell.steps } : {}),
    });
  }
  return hits;
}

/**
 * Light level at a point, or under the cursor if no point is given.
 *
 * @remarks
 * Reports the cells alongside the evaluation, and marks the point on the canvas. Those two additions
 * answer the questions this readout could not previously distinguish: whether the model is
 * self-consistent here (evaluate vs. cells), and whether the point sampled is the intended one (the
 * mark).
 *
 * @param {number} [x] - Scene pixel X
 * @param {number} [y] - Scene pixel Y
 * @param {number} [elevation=0]
 * @returns {object} The full evaluate() result, plus the cells covering the point
 */
export function at(x, y, elevation = 0) {
  if (x === undefined || y === undefined) {
    const p = canvas.mousePosition;
    x = p.x;
    y = p.y;
  }
  const point = { x, y, elevation };
  const result = evaluate(point);
  const cells = cellsAt(x, y);
  mark(x, y);

  // Emitters that reach this point and contribute nothing. `evaluate()` reports what it counted, and
  // the failure that matters most is a source it silently did not — a light whose polygon covers the
  // point but whose `B` came out 0 is dropped by `emittersAt`, and an absence looks like nothing at
  // all in the output.
  //
  // Added 2026-08-23, after a daylight was missing from that list for exactly this reason (`bright`
  // past `dim`, see `ramp.normaliseEmission`). `emission` is printed alongside because the resolved
  // zones are the answer whenever this list is not empty and should be.
  const silent = registry
    .emitters()
    .filter(
      (e) => !e.isGlobal && !e.suppressedAtOrigin && e.contains(point) && e.brightnessAt(point) <= 0
    )
    .map((e) => ({ id: e.id, kind: e.kind, level: e.level, emission: e.emission }));

  // Lights that are out, and whose polygon still covers this point. A different absence from
  // `silent`, needing its own name because the two want opposite responses: a silent emitter reaches
  // and contributes nothing, usually a bug; an extinguished one stands inside a darkness that put it
  // out, which is §3.3.1 working. Reported as one list they would be indistinguishable, and the
  // reason a torch is dark is the first thing anyone asks.
  const extinguished = registry
    .emitters()
    .filter((e) => e.suppressedAtOrigin && e.contains(point))
    .map((e) => ({ id: e.id, kind: e.kind, level: e.level }));

  // The ambient here, next to the scene's. Since §10.7 a region can move the base tier, and an area
  // doing nothing looks identical to no area at all in every other field of this report: the
  // emitters, the suppressors and the winner are all unchanged, and only the number the bands are
  // added to has moved. `scene === here` with a region under the cursor is the whole symptom of a
  // behaviour that is disabled, mis-scoped or on the wrong region.
  const sceneAmbient = registry.ambientTier();

  // Split, since §3.4 put computed areas in the same list. They answer different questions — a drawn
  // region under the cursor that changed nothing is a mis-scoped behaviour, a spill band that
  // changed nothing is an ordinary overlap — and `areas.covers` is what tells either apart from no
  // area at all, a derived area having no document to test.
  const covering = areas.areas().filter((a) => areas.covers(a, point));
  const ambient = {
    scene: TIER_NAME[sceneAmbient],
    here: TIER_NAME[registry.ambientTier(point)],
    areas: covering.filter((a) => !a.derived).length,
    spill: covering.filter((a) => a.derived).length,
  };

  console.error(
    `PF1 Lighting | (${Math.round(x)}, ${Math.round(y)}) → ${describe(result)}` +
      ` | cells: ${cells.map((c) => c.kind).join(", ") || "none"}` +
      (silent.length ? ` | ${silent.length} silent emitter(s) reaching but contributing 0` : "") +
      (extinguished.length
        ? ` | ${extinguished.length} emitter(s) put out at their own origin (§3.3.1)`
        : "") +
      (ambient.areas ? ` | ambient ${ambient.scene} → ${ambient.here} (§10.7)` : "") +
      " — a cyan crosshair marks the point sampled",
    { ...result, cells, silent, extinguished, ambient }
  );
  return { ...result, cells, silent, extinguished, ambient };
}

/**
 * Light level at each controlled token's centre.
 *
 * @returns {object[]}
 */
export function tokens() {
  const controlled = canvas.tokens.controlled;
  if (!controlled.length) {
    ui.notifications.warn("PF1 Lighting | No tokens selected.");
    return [];
  }
  return controlled.map((token) => {
    const result = evaluate({
      x: token.center.x,
      y: token.center.y,
      elevation: token.document.elevation ?? 0,
    });
    console.error(`PF1 Lighting | ${token.name} → ${describe(result)}`, result);
    return { token: token.name, ...result };
  });
}

/**
 * Report the mixin stack on the configured source classes.
 *
 * DESIGN.md §6.6 — this module, PF1 and `limits` all mix over `_createShapes` on the same classes.
 * Application order decides which wins, and the wrong order silently disables one of them. This
 * prints the prototype chain so the order is visible rather than assumed.
 *
 * @returns {object}
 */
export function stack() {
  const chainOf = (cls) => {
    const names = [];
    let c = cls;
    while (c && c !== Function.prototype) {
      names.push(c.name || "(anonymous)");
      c = Object.getPrototypeOf(c);
    }
    return names;
  };

  const report = {
    lightSourceClass: chainOf(CONFIG.Canvas.lightSourceClass),
    darknessSourceClass: chainOf(CONFIG.Canvas.darknessSourceClass),
    visionSourceClass: chainOf(CONFIG.Canvas.visionSourceClass),
    nativeSuppressionDisabled: isNativeSuppressionDisabled(),
    activeModules: {
      limits: game.modules.get("limits")?.active ?? false,
      // Guarded: a diagnostic should not throw on a non-PF1 world.
      pf1SystemVision: (() => {
        try {
          return game.settings.get("pf1", "systemVision");
        } catch {
          return "n/a";
        }
      })(),
    },
    liveSources: {
      light: canvas.effects?.lightSources?.size ?? 0,
      darkness: canvas.effects?.darknessSources?.size ?? 0,
      synthetic: [...(canvas.effects?.lightSources ?? [])].filter(isSynthetic).length,
    },
  };

  console.error(`PF1 Lighting | source class stack`, report);
  return report;
}

/**
 * Why isn't the renderer affecting this darkness source?
 *
 * Three separate things have to line up, and a failure in any of them looks identical on screen: the
 * class must carry the mixin, the renderer must have assigned a strength, and the shader uniform
 * must reflect it. This reports all three side by side.
 *
 * @returns {object[]}
 */
export function darkness() {
  const chainOf = (cls) => {
    const names = [];
    let c = cls;
    while (c && c !== Function.prototype) {
      names.push(c.name || "(anonymous)");
      c = Object.getPrototypeOf(c);
    }
    return names;
  };

  const report = [...canvas.effects.darknessSources].map((s) => ({
    id: s.sourceId,
    chain: chainOf(s.constructor).join(" < "),
    patched: typeof s.constructor.pf1LightingClipPatched !== "undefined",
    // The vision blocker. A darkness source's edges are what stop a vision sweep, so `requiresEdges`
    // true or `edges` non-empty while native suppression is supposed to be off means the override is
    // not taking effect — and that, not any rendering path, is what makes a region unseeable.
    requiresEdges: s.requiresEdges,
    edges: s.edges?.length ?? s.edges?.size ?? null,
    // §4.5.2 — the two restrictions must be split. `light: 0` (NONE) with `sight: 20` (NORMAL) is
    // the healthy state: vision truncates at the boundary, light sweeps pass through so the model
    // still measures an unsuppressed baseline. Both 20 means the relaxation did not run and path 1
    // is back, corrupting the baseline.
    edgeLight: s.edges?.[0]?.light ?? null,
    edgeSight: s.edges?.[0]?.sight ?? null,
    // Foundry's document priority, which is NOT the model's level. Unrelated fields, and easy to
    // confuse: this readout showed only `priority`, so a source configured at document-priority 0
    // read as mundane while the model still had it at the `DEFAULT_SUPPRESSOR` level of 2 — magical,
    // and casting an umbra (2026-08-23).
    priority: s.priority,
    // The model's view, which decides umbra. `level` comes only from `flags["pf1-lighting"].config`
    // and defaults to 2/magical for a suppressor — an unconfigured darkness is a deeper darkness,
    // not a mundane one. §3.5's config UI is the real fix for this trap.
    ...(() => {
      const config = suppressorConfigOf(s);
      return {
        modelKind: config.kind,
        modelLevel: config.level,
        modelFloor: config.floor,
        // The two predicates, so neither has to be re-derived by hand from the fields above.
        castsUmbra: castsUmbra(config),
        blocksSight: blocksSight(config),
      };
    })(),
    strength: s[STRENGTH],
    // Whether the renderer withheld the mesh entirely. `hidden: true` on a source the model says is
    // Supernatural Dark means the renderer and the model disagree — a different bug from the source
    // drawing and something painting over it.
    hidden: s[HIDDEN] === true,
    meshVisible: s.layers?.darkness?.mesh?.visible ?? null,
    hasClip: !!s[CLIP],
    clipPoints: s[CLIP]?.points?.length ?? null,
    shapePoints: s.shape?.points?.length ?? null,
    dataAlpha: s.data?.alpha,
    // What the shader is actually using. `strength` set but this still equal to `dataAlpha * 2`
    // means the override never ran.
    colorationAlpha: s.layers?.darkness?.shader?.uniforms?.colorationAlpha ?? null,
    expected: s[STRENGTH] !== undefined ? s.data.alpha * 2 * s[STRENGTH] : null,
  }));

  console.error("PF1 Lighting | darkness sources", report);
  return report;
}

/**
 * Why can this token not see?
 *
 * @remarks
 * Foundry blinds a vision source whose origin is inside an active darkness source
 * (`point-vision-source.mjs:198`), and a blinded source is switched to the `blindness` vision mode
 * outright (`:250`). The mixin neutralises the `darkness` key, so this reports whether that is
 * taking effect and, if it is, what else is left.
 *
 * @returns {object[]}
 */
export function vision() {
  const report = [...canvas.effects.visionSources].map((v) => ({
    id: v.sourceId,
    cls: v.constructor.name,
    // `isBlinded` true means the override is not reaching this source. False with vision still cut
    // means the cause is downstream of blinding entirely.
    isBlinded: v.isBlinded,
    blinded: { ...v.blinded },
    // What Foundry wanted to set, before the module's record overrode it. `blindedRaw` true with
    // `blinded.darkness` false is the healthy state inside an ordinary darkness: Foundry blinded the
    // token and the model overruled it. Both false means it was never inside one, and a vision
    // problem has some other cause.
    blindedRaw: v.blinded?.[RAW_BLINDED] ?? null,
    // The blinded condition as Foundry set it, beside what the module reports. `blindRaw: true` with
    // `blinded.blind: false` is a blindsighted creature keeping its perception through the condition
    // — and `radius` should then equal `blindsight`, not the token's sight range.
    blindRaw: v.blinded?.[RAW_BLIND] ?? null,
    blindsight: perceptionModel.blindsightRange(v),
    // The model's own verdict (§4.5.1) — true only in magical Supernatural Dark, and only without
    // see-in-darkness. When this is true, `blinded.darkness` should be too.
    modelBlinds: blindness.modelBlinds(v),
    // Light-independent sight, in pixels. `Infinity` = see in darkness, a finite value = true
    // seeing, 0 = neither. Non-zero here should always mean `modelBlinds: false`.
    darkSight: perceptionModel.darkSightRange(v),
    visionMode: v.visionMode?.id ?? null,
    radius: v.data?.radius,
    lightRadius: v.data?.lightRadius,
    // Above every darkness source's priority means this observer sweeps through sight-blocking edges
    // (§4.5.2). Walls are registered at -Infinity and are never affected.
    priority: v.data?.priority,
    shapePoints: (v.shape?.points?.length ?? 0) / 2,
    active: v.active,
  }));
  console.error("PF1 Lighting | vision sources", report);
  return report;
}

/**
 * Why can this observer see — or not see — each token on the scene?
 *
 * @remarks
 * Visibility is a conjunction of six or seven things across three files, and every one fails the
 * same way on screen: the token is simply not there. This walks the same decision Foundry walks and
 * reports each term separately, so the failing one is a column rather than a hypothesis.
 *
 * Built before debugging the perception layer rather than during it — DESIGN.md §9's standing note
 * about instrumentation, applied in advance.
 *
 * @param {Token} [observer] - Defaults to the controlled token
 * @returns {object[]}
 */
export function perception(observerToken) {
  const token = observerToken ?? canvas.tokens.controlled[0];
  if (!token) {
    ui.notifications.warn("PF1 Lighting | Select a token to use as the observer.");
    return [];
  }

  const source = token.vision;
  if (!source) {
    ui.notifications.warn(`PF1 Lighting | ${token.name} has no vision source.`);
    return [];
  }

  const modes = token.document.detectionModes.filter((m) => m.enabled);

  const report = canvas.tokens.placeables
    .filter((t) => t !== token)
    .map((target) => {
      const point = { x: target.center.x, y: target.center.y, elevation: target.document.elevation ?? 0 };
      const light = perceptionModel.explainPoint(point, source);

      // Ask each mode the same question Foundry asks it, one at a time, so a target invisible
      // overall still says which senses declined it and why.
      const byMode = {};
      for (const mode of modes) {
        const dm = CONFIG.Canvas.detectionModes[mode.id];
        if (!dm) continue;
        byMode[mode.id] = dm.testVisibility(source, mode, {
          object: target,
          tests: [{ point, los: new Map() }],
        });
      }

      return {
        target: target.name,
        visible: target.visible,
        tier: light.tierName,
        // Why it is that tier, the question a bare tier cannot answer. `rawTier` is the god's-eye
        // reading at the target; `tier` is what this observer gets after the umbra between them.
        // When they differ, the target is not standing in the dark — the observer is looking through
        // it (§4.3). Two causes, two fixes, and without these they are indistinguishable here.
        rawTier: light.rawTierName,
        umbraClamp: light.umbraClamp,
        umbraApplied: light.umbraApplied,
        // The two model verdicts, independent of whether the token has the sense.
        litEnough: light.ordinarySight,
        darkvisionWorks: light.darkvision,
        // The observer's actual senses.
        ...byMode,
        // LOS is tested per mode, but when every mode says no it is usually this.
        inLOS: source.los?.contains(point.x, point.y) ?? null,
        // The same test `NonSightMixin` runs for blindsight and the other non-sight senses — a ray
        // at piercing rank, which should clear every darkness edge and stop only at walls. `inLOS:
        // false` with `losPiercing: true` is the healthy state inside a darkness: the shared polygon
        // is truncated and the non-sight path correctly ignores that. Both false means a wall.
        losPiercing: (() => {
          try {
            return !CONFIG.Canvas.polygonBackends.sight.testCollision(source.origin, point, {
              type: "sight",
              mode: "any",
              source,
              useThreshold: true,
              priority: VISION_RANK.PIERCING,
            });
          } catch (error) {
            return `error: ${error.message}`;
          }
        })(),
        distance: Math.round(canvas.grid.measurePath([token.center, target.center]).distance),
      };
    });

  console.error(
    `PF1 Lighting | perception from ${token.name} ` +
      `(modes: ${modes.map((m) => `${m.id}@${m.range}`).join(", ") || "none"})`,
    report
  );
  return report;
}

/**
 * Where are the polygons the model is actually working with?
 *
 * @remarks
 * Area alone is ambiguous: a truncated arc and a smaller circle can have the same area, and both
 * look identical in a cell count. Bounds and origin together say whether a shape is the circle its
 * area implies, and whether it is centred where its source is.
 *
 * Built after two polygons with individually correct areas reported an intersection of 45 px² where
 * the geometry said 27,000.
 *
 * @returns {object}
 */
export function geometry() {
  const box = (shape) => {
    const r = shape?.bounds ?? shape?.getBounds?.();
    if (!r) return null;
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
      cx: Math.round(r.x + r.width / 2),
      cy: Math.round(r.y + r.height / 2),
    };
  };

  const describe = (entry) => ({
    id: entry.id,
    origin: [Math.round(entry.source.x), Math.round(entry.source.y)],
    // A shape centred away from its origin, or narrower than 2×radius on one side, is a truncated
    // sweep — walls, scene bounds, or another source's edges.
    bounds: box(entry.shape),
    points: (entry.shape?.points?.length ?? 0) / 2,
    // `shape` must stay whole: it drives `testPoint` and the visibility mask. Only `renderShape` may
    // be narrowed. Equal means the clip is not being applied; a `shape` smaller than the source's
    // radius implies means the clip leaked into it.
    renderShapePoints: (entry.source[RENDER_SHAPE]?.points?.length ?? 0) / 2,
    clipPoints: (entry.source[CLIP]?.points?.length ?? 0) / 2,
    radiusData: entry.source.radius,
    padding: entry.source._padding ?? 0,
    // §3.2.1's origin rule. True here explains a light with a perfectly good clip polygon drawing
    // nothing at all, otherwise the most confusing state on this readout. Undefined on a suppressor,
    // which is why it is not defaulted.
    extinguished: entry.suppressedAtOrigin,
    hidden: entry.source[HIDDEN] === true,
  });

  const report = {
    emitters: registry.emitters().filter((e) => !e.isGlobal).map(describe),
    suppressors: registry.suppressors().map(describe),
  };
  console.error("PF1 Lighting | model geometry", report);
  return report;
}

/**
 * Dump every live emitter and suppressor with its resolved config, so a scene's
 * inputs can be inspected without guessing.
 *
 * @returns {object}
 */
/**
 * What is actually painting light at this point?
 *
 * @remarks
 * Written 2026-08-23 for a §7.0 symptom the existing readouts could not touch: the model and the
 * tooltip both said a point was dark, and the screen showed light. Every diagnostic to hand
 * described the model, so all agreed with each other and none looked at the thing that was wrong.
 *
 * The distinction that matters is `shape` versus the render shape. `shape` is what the model reads
 * and what Foundry's visibility mask draws; `RENDER_SHAPE` is the clipped polygon that reaches the
 * mesh (§6.2.4). A source whose `shape` contains the point but whose render shape does not is
 * correctly clipped; one where both contain it is painting, and is the culprit. Reporting them
 * separately is the value here — reporting only whether a source reaches the point is what
 * `sources()` already does, and it cannot distinguish the two.
 *
 * Defaults to the cursor, so it can be aimed at whatever looks wrong.
 *
 * @param {number} [x]
 * @param {number} [y]
 */
export function paintersAt(x, y) {
  const point =
    x === undefined
      ? canvas.mousePosition ?? canvas.app.renderer.events.pointer.getLocalPosition(canvas.stage)
      : { x, y };

  const describe = (s, collection) => {
    const render = s[RENDER_SHAPE] ?? null;
    return {
      collection,
      id: s.sourceId,
      synthetic: isSynthetic(s),
      active: s.active,
      // The two questions. `inShape` without `paints` is a correctly clipped source.
      inShape: s.shape?.contains?.(point.x, point.y) === true,
      paints: (render ?? s.shape)?.contains?.(point.x, point.y) === true,
      clipped: !!render,
      hidden: s[HIDDEN] === true,
      // Undefined means the class default.
      level: s[LEVEL],
      strength: s[STRENGTH],
    };
  };

  const all = [
    ...[...canvas.effects.lightSources].map((s) => describe(s, "light")),
    ...[...canvas.effects.darknessSources].map((s) => describe(s, "darkness")),
  ];

  const global = canvas.environment?.globalLightSource;
  if (global) {
    all.push({
      collection: "global",
      id: global.sourceId,
      synthetic: false,
      active: global.active,
      inShape: global.shape?.contains?.(point.x, point.y) === true,
      // The global source covers the whole scene rect and is no longer clipped (§7.0); where it
      // renders is decided per fragment by `darknessLevel` against `band` below.
      paints: global.shape?.contains?.(point.x, point.y) === true,
      clipped: false,
      hidden: false,
      level: undefined,
      strength: undefined,
    });
  }

  const painting = all.filter((s) => s.active && s.paints && !s.hidden);

  // §7.0 — since the texture took over, what paints here is no longer only a question about
  // sources. A point with an empty `painting` list can still be correctly lit, or correctly dim,
  // purely from the background: these two lines say which.
  const darknessLevel = canvas.effects.getDarknessLevel({ x: point.x, y: point.y, elevation: 0 });
  const band = canvas.environment?.globalLightSource?.data?.darkness ?? null;

  const report = {
    point: { x: Math.round(point.x), y: Math.round(point.y) },
    // What the model says should be here, so the two can be compared in one readout.
    model: modelEvaluate(point).tierName,
    // The texture's answer, and the scene's for comparison. Differing means a mesh is painting here;
    // equal means none is, whether by design or because the cell was never emitted.
    darknessLevel,
    sceneDarkness: canvas.environment?.darknessLevel ?? null,
    // The band as authored. `render/ambient.mjs` narrows only the shader uniform, so the effective
    // upper bound at render time is `min(band.max, GLOBAL_LIGHT_CUTOFF)`.
    band: band ? { ...band } : null,
    painting,
    // Reaching but correctly clipped away. A short list here with a wrong screen means the clipping
    // is right and something else is painting; a source appearing in `painting` that the model says
    // is blocked is the clip failing.
    clippedOut: all.filter((s) => s.active && s.inShape && !s.paints),
  };
  console.error("PF1 Lighting | painters", report);
  return report;
}

/**
 * What is revealing this point to this observer, and how?
 *
 * @remarks
 * Written 2026-08-23 for a symptom every existing readout is blind to: terrain rendering in colour
 * where it should be monochrome. Nothing in `probe.at`, `paintersAt` or `perception` touches that,
 * because it is not a light level, not a cell and not a detection verdict — it is a question about
 * which of Foundry's several reveal paths painted the ground.
 *
 * The paths differ in what they look like, which is the point of separating them:
 *
 * | Path | Shows as |
 * | --- | --- |
 * | `withinRadius` | directly seen — the vision source's own FOV, bright, coloured by the vision mode |
 * | `inLightMask` | lit ground, coloured by whatever light reaches it |
 * | `inLos` only | reachable but unrevealed — fog |
 *
 * §4.5.1's note that revealing terrain and brightening it are the same act is why `withinRadius`
 * matters most: `data.radius` is raised for any light-independent sense including blindsight, so a
 * creature that maps a room by echo gets a genuine visual FOV out to that range. A suspicious region
 * that turns out to be a circle centred on the observer rather than a wedge behind a darkness is
 * that, and the umbra is innocent.
 *
 * @param {number} [x]
 * @param {number} [y]
 */
export function reveals(x, y) {
  // Copied, not referenced. `canvas.mousePosition` returns a shared object Foundry mutates, so a
  // logged reference shows the console whatever the cursor is doing now — two samples taken at
  // different places print identical coordinates and read as one sample taken twice. Only the
  // numbers computed at call time (`distance`) survive honestly.
  const live = x === undefined ? canvas.mousePosition : { x, y };
  const point = { x: live.x, y: live.y };
  mark(point.x, point.y);

  const report = [...canvas.effects.visionSources]
    .filter((v) => v.active)
    .map((v) => {
      const distance = Math.hypot(point.x - v.x, point.y - v.y);
      const senses = v.object?.actor?.system?.traits?.senses ?? {};
      const raw = modelEvaluate(point);
      return {
        id: v.sourceId,
        distance: Math.round(distance),

        // --- Which path reveals it ---
        // The vision source's own FOV: directly seen, and the one that carries the vision
        // mode's colour treatment.
        withinRadius: distance <= (v.data?.radius ?? 0),
        inShape: v.shape?.contains?.(point.x, point.y) === true,
        inLos: v.los?.contains?.(point.x, point.y) === true,
        radius: Math.round(v.data?.radius ?? 0),
        lightRadius: Math.round(v.data?.lightRadius ?? 0),

        // --- Why the radius is what it is ---
        // `darkSightRange` includes blindsight and drives the radius; `visual` excludes it and
        // drives perception. The two disagreeing is normal, and is the tension §4.5.1 names —
        // blindsight perceives without seeing.
        darkSight: perceptionModel.darkSightRange(v),
        visualDarkSight: perceptionModel.visualDarkSightRange(v),
        blindsight: senses.bs?.total ?? 0,
        darkvision: senses.dv ?? 0,

        // --- What the model says should be here ---
        rawTier: raw.tierName,
        umbraClamp: umbraModel.clampAt(point, v),
        seenTier: TIER_NAME[perceptionModel.perceivedTier(point, v)],

        // --- What actually reached the screen ---
        // The clamp is a verdict; this is whether it was painted. Two points with different
        // `seenTier` and the same `darknessLevel` mean the model is right and the paint collapsed
        // them — which the current table does on purpose, Dark and Supernatural Dark sharing 1.0.
        // Different levels mean the paint is fine and the difference is downstream of it.
        darknessLevel: canvas.effects.getDarknessLevel({ x: point.x, y: point.y, elevation: 0 }),
        sceneDarkness: canvas.environment?.darknessLevel ?? null,

        // --- How it will be coloured ---
        visionMode: v.visionMode?.id ?? null,
        // `linkedToDarknessLevel` (`primary.mjs:204`). When true, the vision mode's colour
        // adjustment is mixed by the darkness level per fragment
        // (`color-adjustments.mjs:61-64`) rather than applied flat.
        adaptive: v.visionMode?.vision?.darkness?.adaptive ?? null,
        modeSaturation: v.visionModeOverrides?.saturation ?? null,
        // Darkness sources still drawing here. §6.2.5: a darkness source samples
        // `canvas.primary.renderTexture` raw and composites its own copy, so wherever one draws the
        // terrain arrives with the vision mode's colour adjustment already bypassed — full colour
        // unless `desaturate.mjs` puts the saturation back. The only mechanism in the module that
        // can make one region colour and its neighbour grey while every per-point measurement
        // matches.
        darknessDrawing: [...canvas.effects.darknessSources]
          .filter((s) => s.active && !s[HIDDEN])
          .filter((s) => ((s[RENDER_SHAPE] ?? s.shape)?.contains?.(point.x, point.y) === true))
          .map((s) => s.sourceId),
        // 0 = full colour, 1 = fully grey. Global to the observer, so it cannot differ between two
        // regions — two areas looking differently saturated is about which path revealed them, not
        // this number.
        saturation: currentSaturation(),
        darknessMeshWithheld: observerIgnoresDarkness(),
      };
    });

  console.error("PF1 Lighting | reveals", { point, sources: report });
  return report;
}

export function sources() {
  const describe = (s) => ({
    id: s.sourceId,
    synthetic: isSynthetic(s),
    active: s.active,
    x: Math.round(s.x),
    y: Math.round(s.y),
    bright: Math.round(s.data?.bright ?? 0),
    dim: Math.round(s.data?.dim ?? 0),
    priority: s.priority,
    flags: s.object?.document?.getFlag?.(MODULE_ID, "config") ?? null,
  });

  const report = {
    lights: [...canvas.effects.lightSources].map(describe),
    darkness: [...canvas.effects.darknessSources].map(describe),
  };
  console.error("PF1 Lighting | live sources", report);
  return report;
}

/**
 * Every gate between a darkness source and its animation appearing on screen.
 *
 * @remarks
 * Written 2026-08-25 after a report that see-in-darkness removes animations from darkness sources
 * while true seeing and darkvision do not — not resolvable by reading, because both senses take the
 * identical path through this module: same `darkSightRadius` shape, same `VISION_RANK.PIERCING`,
 * same `darkSightBrightness`. Whatever separates them is a gate one trips and the other does not,
 * and the gates live in four different files plus core.
 *
 * So this names all of them at once rather than testing a hypothesis. The one that differs between
 * two observers is the answer.
 *
 * Read it with the affected token selected, then again with a true-seeing token selected, and
 * compare. The likely discriminators, in the order worth checking:
 *
 * - `withheld` — the module's `_drawMesh` override, which is supposed to be blindsight only. True
 *   for a see-in-darkness observer means the sense test in `observerIgnoresDarkness` is catching
 *   something it should not.
 * - `shader` — the shader class actually attached. An animated darkness has an animation-specific
 *   class here; the plain adaptive one means the animation was never installed, a different failure
 *   from the mesh being withheld.
 * - `meshVisible` / `meshRenderable` — what `_drawMesh` last decided.
 * - `visionMasking` with `visionR` — core gates the whole darkness effect on the vision texture's
 *   red channel (`darkness-lighting.mjs:93`), so a region the observer does not see draws no
 *   darkness at all. A large `data.radius` changes what is in that texture.
 * - `suppressed` — core's own `suppression.light`, from `testInsideLight` at the source's origin.
 *
 * @param {number} [x]
 * @param {number} [y]
 */
export function darknessGates(x, y) {
  if (!canvas?.ready) return null;
  const point = x === undefined ? canvas.mousePosition : { x, y };

  // `visionModeData.source` is Foundry's primary vision source, not the selected token. Everything
  // observer-dependent in the render layer keys off it — `currentSaturation`,
  // `observerIgnoresDarkness`, this readout — so when the two disagree, a reading taken with the
  // right token selected describes the wrong creature. The first run of this readout (2026-08-25)
  // came back `seeInDarkness: false` while the see-in-darkness token was the one being tested.
  // `selected` and `visionSources` below make that visible instead of silent.
  const observer = canvas.visibility?.visionModeData?.source;
  const sensesOf = (source) => source?.object?.actor?.system?.traits?.senses ?? {};

  const describeObserver = (source, label) => {
    const sense = sensesOf(source);
    return {
      what: label,
      id: source?.sourceId ?? null,
      token: source?.object?.name ?? null,
      visionMode: source?.visionMode?.id ?? null,
      radius: Math.round(source?.radius ?? 0),
      blindsight: sense.bs?.total ?? 0,
      seeInDarkness: sense.sid ?? false,
      trueSeeing: sense.tr?.total ?? 0,
      darkSightRadius: Math.round(blindness.darkSightRadius(source) || 0),
      isPrimary: source === observer,
    };
  };

  const sources = [...canvas.effects.darknessSources].map((s) => {
    const layer = s.layers?.darkness;
    return {
      id: s.sourceId,
      synthetic: isSynthetic(s),
      // Does the model think it should draw at all?
      hidden: s[HIDDEN] === true,
      strength: s[STRENGTH],
      animationOnly: s[DARK_ANIMATION] === true,
      // Does core think it is live?
      active: s.active,
      suppressed: s.suppressed === true,
      suppression: { ...(s.suppression ?? {}) },
      hasActiveLayer: s.hasActiveLayer,
      // What the GM asked for, versus what is actually attached.
      animation: s.data?.animation?.type ?? null,
      shader: layer?.shader?.constructor?.name ?? null,
      meshVisible: layer?.mesh?.visible ?? null,
      meshRenderable: layer?.mesh?.renderable ?? null,
      // Core's own per-fragment gate.
      visionMasking: layer?.shader?.uniforms?.enableVisionMasking ?? null,
      colorationAlpha: layer?.shader?.uniforms?.colorationAlpha ?? null,
      saturationUniform: layer?.shader?.uniforms?.saturation ?? null,
      covers: (s[RENDER_SHAPE] ?? s.shape)?.contains?.(point.x, point.y) === true,
    };
  });

  const selected = canvas.tokens?.controlled?.map((t) => t.vision).filter(Boolean) ?? [];
  const active = [...(canvas.effects?.visionSources?.values() ?? [])].filter((v) => v.active);

  const report = {
    point: { x: Math.round(point.x), y: Math.round(point.y) },

    // The observer the render layer is actually using. The three senses that take different paths
    // sit side by side: whichever is set on the observer that misbehaves and unset on the one that
    // does not is where to look.
    observer: describeObserver(observer, "primary — what the render layer uses"),

    // Check this against `observer` before reading anything else. If the selected token is not the
    // primary vision source, every observer-dependent number above describes a different creature,
    // and the readout looks healthy while the wrong one is under test.
    selected: selected.map((v) => describeObserver(v, "selected")),
    visionSources: active.map((v) => describeObserver(v, "active")),
    observerIsSelected: selected.length === 0 || selected.includes(observer),

    // The blindsight-only mesh withholding. Should be false for see-in-darkness.
    withheld: observerIgnoresDarkness(),
    saturation: currentSaturation(),
    animateSetting: (() => {
      try {
        return game.settings.get(MODULE_ID, "darknessAnimationStrength");
      } catch {
        return null;
      }
    })(),
    sources,
  };
  console.error(`${MODULE_ID} | darkness sources`, report);
  return report;
}
