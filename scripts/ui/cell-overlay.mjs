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
import * as field from "../model/field.mjs";

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
  if (!canvas?.ready) return;

  if (!active()) {
    clear();
    return;
  }

  // `field.get()` returns the same object when nothing it depends on has changed, so this
  // is the whole reason the overlay can be hooked to something as frequent as token
  // refresh: a redraw during a drag that changed no geometry costs one reference compare.
  const current = field.get();
  if (!force && graphics && current === lastDrawn) return;
  lastDrawn = current;

  if (!graphics) {
    graphics = new PIXI.Graphics();
    graphics.eventMode = "none";
    // Above the lighting layer so the cells are legible against what they describe.
    canvas.interface.addChild(graphics);
  }

  graphics.clear();

  const { cells, stats } = current;
  const order = ["ambient", "clip", "reduced", "dark"];

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
    config: true,
    type: Boolean,
    default: false,
    onChange: () => draw({ force: true, log: true }),
  });
}

export function registerHooks() {
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
