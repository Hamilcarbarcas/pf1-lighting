/**
 * Field-cell debug overlay.
 *
 * Draws `field()`'s output on the canvas so the subdivision can be *seen* rather than
 * inferred from `field.stats()` integers. Not part of the shipped feature set — this is
 * the verification tool for §8.2 step 3.
 *
 * It exists because everything downstream is geometry, and geometry is the one thing a
 * console readout is bad at. An annulus split into two halves, a suppressor region
 * carved by a *daylight*, a cell that should have been clipped at a wall — all of those
 * are obvious at a glance and nearly invisible as counts.
 *
 * It is also a dry run for the renderer: same cells, same polygons, same per-kind
 * treatment. What differs is that this paints flat debug colour and the renderer will
 * assign pooled light sources (§9.5).
 */

import { MODULE_ID } from "../constants.mjs";
import { t } from "../i18n.mjs";
import {
  CLIPPER_SCALE,
  difference,
  fromClipperPaths,
  groupRings,
  intersection,
  toClipperPath,
  union,
} from "../geometry.mjs";
import * as field from "../model/field.mjs";
import * as spill from "../model/spill.mjs";
import * as lightRamps from "../render/light-ramps.mjs";
import * as tierPaint from "../render/paint.mjs";
import { status as transitionStatus } from "../render/transition.mjs";

export const SETTING_OVERLAY = "cellOverlay";

/** Fill and line colour per cell kind. */
const STYLE = {
  // Faint, and drawn first. An ambient cell covers most of the scene, so anything more
  // assertive would wash out the three kinds that describe a *specific* light.
  ambient: { fill: 0x88dd99, line: 0x449966, alpha: 0.06 },
  clip: { fill: 0x66ccff, line: 0x2288cc, alpha: 0.12 },
  reduced: { fill: 0xffaa33, line: 0xcc7700, alpha: 0.18 },
  dark: { fill: 0x9d6bd8, line: 0x6a3ba8, alpha: 0.25 },
  // Where two or more relative bands overlap (§3.2.1). Drawn last and hottest: it is the one
  // kind whose *existence* is the interesting fact, since the shader cannot show it unaided.
  stack: { fill: 0xffe066, line: 0xd4a017, alpha: 0.3 },
};

let graphics = null;

/** The field object last painted, so repeat calls with nothing changed cost nothing. */
let lastDrawn = null;

const active = () => {
  try {
    return game.settings.get(MODULE_ID, SETTING_OVERLAY) === true;
  } catch {
    return false;
  }
};

/**
 * Draw the current field.
 *
 * Cells are drawn in kind order — `ambient` beneath, then `clip`, `reduced`, `dark` — so the
 * suppressed regions read on top of the light they replace. That is the same ordering
 * question the renderer has to answer, and getting it visibly wrong here is cheap.
 */
export function draw({ force = false, log = false } = {}) {
  if (!canvas?.ready) return { drawn: false, reason: "canvas not ready" };

  if (!active()) {
    clear();
    // **Reported rather than returned bare** (Hamilcarbarcas, 2026-08-27: *"I get undefined for
    // `overlay.draw()`"*). This is the hook path's correct behaviour — the overlay is off — but
    // from the console it was indistinguishable from a broken function, because nothing was drawn
    // and nothing was said. {@link show} is the console door and turns the setting on first.
    return { drawn: false, reason: `${SETTING_OVERLAY} is off — use game.pf1Lighting.overlay.draw()` };
  }

  // `field.get()` returns the same object when nothing it depends on has changed, so this
  // is the whole reason the overlay can be hooked to something as frequent as token
  // refresh: a redraw during a drag that changed no geometry costs one reference compare.
  const current = field.get();
  if (!force && graphics && current === lastDrawn) return { drawn: false, reason: "unchanged" };
  lastDrawn = current;

  if (!graphics) {
    graphics = new PIXI.Graphics();
    graphics.eventMode = "none";
    // Above the lighting layer so the cells are legible against what they describe.
    canvas.interface.addChild(graphics);
  }

  graphics.clear();

  const { cells, stats } = current;
  // **`stack` last, and its absence here was a bug for as long as the kind has existed.**
  // `STYLE.stack` was written with a comment saying it is "drawn last and hottest… the one kind
  // whose *existence* is the interesting fact, since the shader cannot show it unaided" — and then
  // the kind was left out of this list, so the cells were computed, counted in `byKind`, and never
  // drawn. Found 2026-08-27 from a scene reporting `5 stack` with nothing on screen to match.
  const order = ["ambient", "clip", "reduced", "dark", "stack"];

  for (const kind of order) {
    const style = STYLE[kind];
    for (const cell of cells) {
      if (cell.kind !== kind) continue;
      const points = cell.polygon?.points;
      if (!points?.length) continue;
      graphics.lineStyle(2, style.line, 0.9);
      graphics.beginFill(style.fill, style.alpha);
      graphics.drawPolygon(points);
      // Punched, not painted. An `ambient` cell is the scene *less* every darkness on it, so
      // filling its holes would shade the overlay most strongly exactly where ambient does
      // **not** apply — the overlay asserting the opposite of the model, in the one place it
      // is being consulted about.
      for (const hole of cell.holes ?? []) {
        if (!hole.points?.length) continue;
        graphics.beginHole();
        graphics.drawPolygon(hole.points);
        graphics.endHole();
      }
      graphics.endFill();
    }
  }

  // Only on request. Automatic redraws happen on token refresh, and a log line per step
  // of a drag would bury everything else in the console.
  if (log) {
    console.error(
      `PF1 Lighting | cell overlay — ${stats.cells} cells ` +
        `(${Object.entries(stats.byKind).map(([k, n]) => `${n} ${k}`).join(", ")}), ` +
        `${stats.annuli} annuli, ${stats.ops} ops, ${stats.ms} ms, ambient ${stats.ambientB ?? "—"}`
    );
  }

  return { drawn: true, ...stats };
}

/**
 * The console door for the cell overlay — **same signature as {@link levels}**.
 *
 * `show()` toggles, `show(true)` turns it on, `show(false)` turns it off.
 *
 * @remarks
 * {@link draw} is also the **hook** path, called on token refresh, where self-enabling would turn
 * the overlay on for anyone who moved a token. So the enabling lives here instead, and {@link
 * levels} needs no equivalent because it owns its own visibility rather than a setting.
 *
 * **Deliberately identical to `levels` in behaviour, not merely in spelling.** Two debug overlays
 * on the same feature, driven by two different mechanisms, cost this project two rounds in one
 * session: `draw()` silently no-opped with the setting off and returned `undefined` (Hamilcarbarcas,
 * 2026-08-27: *"I get undefined for `game.pf1Lighting.overlay.draw()`"*), and then there was no
 * obvious way to turn it back off (*"how do I turn off the cell overlay?"*). The underlying
 * asymmetry is real and cannot go away — one is a persisted setting, the other is not — so it is
 * hidden behind a matching signature instead.
 *
 * @param {boolean} [on] - Omit to toggle
 */
export function show(on) {
  const wanted = on === undefined ? !active() : !!on;
  try {
    if (wanted !== active()) game.settings.set(MODULE_ID, SETTING_OVERLAY, wanted);
  } catch {
    /* Setting unavailable — `draw` will report it. */
  }
  if (!wanted) {
    clear();
    return { drawn: false, reason: "turned off" };
  }
  return draw({ force: true, log: true });
}

/* -------------------------------------------- */
/*  The brightness map                          */
/* -------------------------------------------- */

/** @type {PIXI.Container|null} */
let levelLayer = null;
let levelsOn = false;

/**
 * One colour per tier, brightest to darkest, for {@link levels}.
 *
 * @remarks
 * Deliberately **not** greyscale. A greyscale overlay of a brightness field is unreadable against
 * the brightness field it describes — the thing being debugged and the tool debugging it would be
 * the same colour. Hue carries the tier; the map underneath stays visible through the alpha.
 */
const TIER_STYLE = {
  4: { fill: 0xfff1a8, name: "Bright" },
  3: { fill: 0x9adcff, name: "Normal" },
  2: { fill: 0x7f7fe0, name: "Dim" },
  1: { fill: 0xc0508a, name: "Dark" },
  0: { fill: 0x6a1040, name: "Supernatural Dark" },
};

/**
 * Draw **what the painter was actually given** — the ground regions and their tiers.
 *
 * @remarks
 * Hamilcarbarcas, 2026-08-27: *"Do I have a function available to see the lighting model backend that
 * we're drawing the lighting based on?"* He did not, and that gap is why the last three rounds of
 * this were diagnosed from screenshots.
 *
 * {@link draw} is not it and never was. It draws `field()`'s cells by **kind** — is this ambient,
 * a clip, a suppressor's region — which is the question §8.2 was asking. The question now is
 * *what brightness is this piece of ground, and where exactly does it stop being that*, and the
 * cells that answer it are the ones after the umbra and unseen clamps have been cut in. Those live
 * in `render/paint.mjs`, not in the field.
 *
 * Every boundary drawn here is a real boundary in the model. **If a transition on screen does not
 * sit on a line in this overlay, the renderer invented it** — which is the single most useful
 * thing this can tell you, and it is not answerable any other way.
 *
 * @param {boolean} [on] - Omit to toggle
 * @returns {object|null} What was drawn, by tier
 */
export function levels(on) {
  if (!canvas?.ready) return null;

  const wanted = on === undefined ? !levelsOn : !!on;
  levelsOn = wanted;
  if (!wanted) {
    levelLayer?.destroy({ children: true });
    levelLayer = null;
    return null;
  }
  return drawLevels({ log: true });
}

/** Redraw if it is showing. Wired to `paint.PAINTED_HOOK`, so it follows a drag. */
export function refreshLevels() {
  if (levelsOn) drawLevels({ log: false });
}

/**
 * Every claim on a piece of ground, resolved into **one region per tier, with no overlaps**.
 *
 * @remarks
 * Hamilcarbarcas, 2026-08-27, twice: *"are we able to do away with the overlaps in the overlay?"*
 *
 * The first version layered its sources — ground cells, then light zones, then spill bands — which
 * is how they are *drawn* and not how they *resolve*. A light sits on ground that already has a
 * tier and its band sits on its own inner zone, so a faithful layered drawing has overlaps
 * everywhere by construction, and an overlap in a debug overlay is indistinguishable from a fault.
 * Reading it meant doing the resolution in your head, which is the thing the tool exists to avoid.
 *
 * So the claims are resolved here the same way the renderer resolves them — **brightest wins** —
 * and by exactly the mechanism the texture uses, since `MIN_COLOR` over a darkness level *is*
 * brightest-wins (§7.0 step 6). Taking the tiers from brightest down and subtracting everything
 * already claimed yields a genuine partition: every point is drawn once, in one colour, and
 * **any overlap left on screen is now a real fault.**
 *
 * Deliberately *not* how the renderer computes its meshes. This is a second, independent answer to
 * the same question, in flat regions — so where it disagrees with the map, one of the two is wrong
 * and the disagreement itself is the finding.
 */
function resolvedPartition(cells, ramps) {
  const claims = new Map();
  const claim = (tier, paths) => {
    if (tier === undefined || !paths?.length) return;
    if (!claims.has(tier)) claims.set(tier, []);
    claims.get(tier).push(...paths);
  };

  const pathsOf = (polygon) => {
    const path = toClipperPath(polygon, CLIPPER_SCALE);
    return path.length >= 3 ? [path] : [];
  };

  for (const cell of cells) {
    if (!(cell?.polygon?.points?.length >= 6)) continue;
    const paths = pathsOf(cell.polygon);
    for (const hole of cell.holes ?? []) paths.push(...pathsOf(hole));
    claim(cell.tier, paths);
  }

  for (const ramp of ramps) {
    if (ramp.kind !== "light" || !ramp.debug) continue;
    const d = ramp.debug;
    const region = pathsOf(d.region);
    if (!region.length) continue;

    // The band covers the whole region; the inner zone is a true circle cut to it. Claiming both
    // and letting the resolution sort them out is what keeps this from re-deriving the geometry.
    claim(d.bandTier, region);
    if (d.inner > 0) {
      const circle = new PIXI.Circle(d.x, d.y, d.inner).toPolygon({ density: 60 });
      const inner = intersection(pathsOf(circle), region);
      claim(d.innerTier, inner);
    }
  }

  // Brightest first — TIER ascends with brightness — each subtracting everything already taken.
  const out = [];
  let taken = [];
  for (const tier of [...claims.keys()].sort((a, b) => b - a)) {
    let paths = union(claims.get(tier));
    if (taken.length) paths = difference(paths, taken);
    if (!paths.length) continue;
    out.push({ tier, paths });
    taken = taken.length ? union([...taken, ...paths]) : paths;
  }
  return out;
}

function drawLevels({ log = false } = {}) {
  const cells = tierPaint.lastCells();
  if (!cells) {
    if (log) ui.notifications?.warn(t("Notify.NothingPainted"));
    return null;
  }

  levelLayer?.destroy({ children: true });
  levelLayer = new PIXI.Container();
  levelLayer.eventMode = "none";
  canvas.interface.addChild(levelLayer);

  const graphics = new PIXI.Graphics();
  levelLayer.addChild(graphics);

  const ramps = tierPaint.lastRamps();
  const regions = resolvedPartition(cells, ramps);
  const counts = {};

  for (const { tier, paths } of regions) {
    const style = TIER_STYLE[tier];
    if (!style) continue;

    for (const { outer, holes } of groupRings(fromClipperPaths(paths, CLIPPER_SCALE))) {
      if (!(outer?.points?.length >= 6)) continue;
      counts[style.name] = (counts[style.name] ?? 0) + 1;

      graphics.lineStyle(2, style.fill, 0.9);
      graphics.beginFill(style.fill, 0.3);
      graphics.drawPolygon(outer.points);
      for (const hole of holes ?? []) {
        if (!hole?.points?.length) continue;
        graphics.beginHole();
        graphics.drawPolygon(hole.points);
        graphics.endHole();
      }
      graphics.endFill();

      // At the ring's own first vertex rather than its centroid: a centroid can land outside a
      // C-shaped region, and after the subtraction most of these are C-shaped.
      const text = new PIXI.Text(style.name, {
        fontSize: 15,
        fill: style.fill,
        stroke: 0x000000,
        strokeThickness: 4,
      });
      text.position.set(outer.points[0] + 4, outer.points[1] + 4);
      levelLayer.addChild(text);
    }
  }

  // A dot per light, so it is obvious *why* a region is the shape it is without an outline that
  // would put an overlap back.
  graphics.lineStyle(0);
  for (const ramp of ramps) {
    if (ramp.kind !== "light" || !ramp.debug) continue;
    graphics.beginFill(0xffffff, 0.9);
    graphics.drawCircle(ramp.debug.x, ramp.debug.y, 4);
    graphics.endFill();
  }

  const report = {
    // Regions in the **resolved partition**, so this is how many distinct pieces of ground there
    // are — not how many meshes were painted, which is `render.texture().painted`.
    regions: regions.reduce((n, r) => n + r.paths.length, 0),
    byTier: counts,
    lights: ramps.filter((r) => r.kind === "light").length,
    halos: ramps.filter((r) => r.kind === "halo").length,
    clamps: ramps.filter((r) => r.kind === "clamp").length,
    lightsRejected: lightRamps.stats().rejected,
    spillBands: spill.spillAreas().length,
    // **The first thing to check if gradients look absent**, and reported in parts rather than as
    // one product: `screenPixels` in single digits is a hard edge however correct the geometry is,
    // and `squares` says whether that is the setting or the grid.
    transition: transitionStatus(),
  };
  if (log) console.error(`${MODULE_ID} | brightness map`, report);
  return report;
}

/** Remove the overlay. */
export function clear() {
  lastDrawn = null;
  if (!graphics) return;
  graphics.destroy();
  graphics = null;
}

/** Toggle and redraw. */
export function toggle() {
  const next = !active();
  game.settings.set(MODULE_ID, SETTING_OVERLAY, next);
  return next;
}

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTING_OVERLAY, {
    name: "Show field cell overlay (debug)",
    hint:
      "Draws the lighting model's computed cells over the canvas: blue for unsuppressed light, " +
      "orange for reduced, violet for darkness fill. Development aid, not a play feature.",
    scope: "client",
    // **No control surface, by decision (Hamilcarbarcas, 2026-08-26).** It was always a development
    // aid rather than a play feature; `game.pf1Lighting.overlay.toggle()` is its real interface
    // and always was.
    config: false,
    type: Boolean,
    default: false,
    onChange: () => draw({ force: true, log: true }),
  });
}

export function registerHooks() {
  // The brightness map follows the painter rather than the field: it shows what was *drawn*, which
  // includes the umbra and vision clamps, and those move on every step an observer takes. One hook,
  // fired at the end of a repaint, and it early-outs when the overlay is off.
  Hooks.on(tierPaint.PAINTED_HOOK, () => refreshLevels());

  // `initializeLightSources` is the broad signal, but it deliberately does *not* fire for
  // an ordinary light-bearing token moving (`placeables/token.mjs:792-798`) — so hooking
  // it alone would leave the overlay stale exactly when the geometry is changing most.
  // `refreshToken` covers that, and is safe to hook because `draw` early-outs on an
  // unchanged field.
  // Coalesced to one redraw per frame for the same reason the renderer is: these hooks
  // fire well above frame rate while the lighting layer is active.
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      draw();
    });
  };

  Hooks.on("initializeLightSources", schedule);
  Hooks.on("refreshToken", schedule);
  Hooks.on("refreshAmbientLight", schedule);

  Hooks.on("canvasReady", () => {
    graphics = null;
    lastDrawn = null;
    if (active()) draw({ log: true });
  });

  Hooks.on("canvasTearDown", () => {
    graphics = null;
    lastDrawn = null;
  });
}
