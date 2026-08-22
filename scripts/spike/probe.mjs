/**
 * Vertical slice, steps 3 and 4 — readouts. DESIGN.md §8.1.
 *
 * Console-facing helpers for checking what the model thinks, and for confirming our
 * source subclass is actually sitting on top of PF1's and `limits`' mixins rather
 * than beside them (§6.6).
 */

import { CLIP, MODULE_ID, RENDER_SHAPE, STRENGTH, isSynthetic } from "../constants.mjs";
import { evaluate } from "../model/evaluate.mjs";
import { TIER_NAME } from "../model/tiers.mjs";
import * as registry from "../model/registry.mjs";
import { isNativeSuppressionDisabled } from "../suppression.mjs";

/**
 * One-line summary of an evaluation.
 *
 * Spells out the `winner` / `applied` distinction, because a suppressor being *present*
 * and a suppressor having *done something* are different facts and the shorter readout
 * conflated them.
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

/**
 * Light level at a point, or under the cursor if no point is given.
 *
 * @param {number} [x] - Scene pixel X
 * @param {number} [y] - Scene pixel Y
 * @param {number} [elevation=0]
 * @returns {object} The full evaluate() result
 */
export function at(x, y, elevation = 0) {
  if (x === undefined || y === undefined) {
    const p = canvas.mousePosition;
    x = p.x;
    y = p.y;
  }
  const result = evaluate({ x, y, elevation });
  console.error(
    `PF1 Lighting | (${Math.round(x)}, ${Math.round(y)}) → ${describe(result)}`,
    result
  );
  return result;
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
 * DESIGN.md §6.6 — we, PF1 and `limits` all mix over `_createShapes` on the same
 * classes. Application order decides who wins, and the wrong order silently disables
 * one of us. This prints the prototype chain so the order is visible rather than
 * assumed.
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
 * Three separate things have to line up, and a failure in any of them looks identical on
 * screen: the class must carry our mixin, the renderer must have assigned a strength, and
 * the shader uniform must reflect it. This reports all three side by side.
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
    // The vision blocker. A darkness source's edges are what stop a vision sweep, so if
    // `requiresEdges` is true or `edges` is non-empty while native suppression is
    // supposed to be off, our override is not taking effect — and that, not any
    // rendering path, is what makes a region unseeable.
    requiresEdges: s.requiresEdges,
    edges: s.edges?.length ?? s.edges?.size ?? null,
    strength: s[STRENGTH],
    hasClip: !!s[CLIP],
    clipPoints: s[CLIP]?.points?.length ?? null,
    shapePoints: s.shape?.points?.length ?? null,
    dataAlpha: s.data?.alpha,
    // What the shader is actually using. If `strength` is set but this still equals
    // `dataAlpha * 2`, the override never ran.
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
 * (`point-vision-source.mjs:198`), and a blinded source is switched to the `blindness`
 * vision mode outright (`:250`). Our mixin neutralises the `darkness` key, so this
 * reports whether that is actually taking effect and, if it is, what else is left.
 *
 * @returns {object[]}
 */
export function vision() {
  const report = [...canvas.effects.visionSources].map((v) => ({
    id: v.sourceId,
    cls: v.constructor.name,
    // If `isBlinded` is true, our override is not reaching this source. If it is false
    // and vision is still cut, the cause is downstream of blinding entirely.
    isBlinded: v.isBlinded,
    blinded: { ...v.blinded },
    visionMode: v.visionMode?.id ?? null,
    radius: v.data?.radius,
    lightRadius: v.data?.lightRadius,
    shapePoints: (v.shape?.points?.length ?? 0) / 2,
    active: v.active,
  }));
  console.error("PF1 Lighting | vision sources", report);
  return report;
}

/**
 * Where are the polygons the model is actually working with?
 *
 * @remarks
 * Area alone is ambiguous: a truncated arc and a smaller circle can have the same area,
 * and both look identical in a cell count. Bounds and origin together say whether a shape
 * is the circle its area implies, and whether it is centred where its source is.
 *
 * Built after two polygons with individually correct areas reported an intersection of
 * 45 px² where the geometry said 27,000.
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
    // A shape centred away from its origin, or narrower than 2×radius on one side, is a
    // truncated sweep — walls, scene bounds, or another source's edges.
    bounds: box(entry.shape),
    points: (entry.shape?.points?.length ?? 0) / 2,
    // `shape` must stay whole: it drives `testPoint` and the visibility mask. Only
    // `renderShape` may be narrowed. If these are equal, the clip is not being applied;
    // if `shape` is smaller than the source's radius implies, the clip leaked into it.
    renderShapePoints: (entry.source[RENDER_SHAPE]?.points?.length ?? 0) / 2,
    clipPoints: (entry.source[CLIP]?.points?.length ?? 0) / 2,
    radiusData: entry.source.radius,
    padding: entry.source._padding ?? 0,
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
