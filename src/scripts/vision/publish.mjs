/**
 * A step's visuals go out together. DESIGN.md §9.14.
 *
 * While steps are coming, a vision refresh waits for the worker jobs its observers depend on, so the
 * umbras, the view and the lighting change in one frame. The limit keeps a slow job from stalling them.
 * A refresh that waits does nothing else: it doesn't flag tokens or test door icons either. A step's
 * light waits with it and is updated as the refresh goes out.
 */

import * as motion from "./motion.mjs";
import * as umbraMask from "./umbra-mask.mjs";
import * as withheld from "../withheld.mjs";

const HOLD_LIMIT_MS = 200;

let timer = null;
let expired = false;
let heldAt = null;
let busyPeak = 0;
let seenStep = 0;

/** Asks for each observer's providers and cut, which starts any job they need. */
function busy() {
  for (const source of canvas.effects?.visionSources ?? []) {
    if (!source.active) continue;
    withheld.collect(source);
    if (withheld.isPending(source) || umbraMask.cutPending(source)) return true;
  }
  return false;
}

function hold(start) {
  heldAt ??= start;
  motion.setHolding(true);
  timer ??= setTimeout(() => {
    timer = null;
    expired = true;
    motion.setHolding(false);
    if (canvas?.ready) canvas.perception.update({ refreshVision: true });
  }, HOLD_LIMIT_MS);
}

function holds() {
  if (!motion.switches.hold || !motion.isMoving() || expired) return false;
  const start = performance.now();
  // A step's own frame has its sweep. What depends on it starts on the next, so they don't stack.
  if (motion.stepId() !== seenStep) {
    seenStep = motion.stepId();
    hold(start);
    requestAnimationFrame(() => {
      if (canvas?.ready) canvas.perception.update({ refreshVision: true });
    });
    return true;
  }
  try {
    const isBusy = busy();
    busyPeak = Math.max(busyPeak, performance.now() - start);
    if (!isBusy) return false;
  } catch (error) {
    console.error("PF1 Lighting | vision hold failed; refreshing now", error);
    return false;
  }
  hold(start);
  return true;
}

function release() {
  if (heldAt !== null) motion.noteCycle({ holdMs: Math.round(performance.now() - heldAt) });
  heldAt = null;
  clearTimeout(timer);
  timer = null;
  expired = false;
  motion.setHolding(false);
}

/**
 * On `refresh`, around every `refreshVisibility` wrapper and core's flagging of tokens and doors.
 *
 * @param {object} [options]
 * @param {Function} [options.beforePublish]  Runs as a held step goes out, before anything draws
 */
export function applyPatch({ beforePublish } = {}) {
  const proto = foundry.canvas.groups?.CanvasVisibility?.prototype;
  if (!proto?.refresh) return;
  const original = proto.refresh;
  proto.refresh = function pf1LightingPublishRefresh(...args) {
    if (holds()) {
      // Core's `initializeSources` switches vision masking off for the refresh after it to switch
      // back on. Held, the lighting would show unmasked under fog until the release. §9.14.
      if (this.initialized) canvas.effects?.toggleMaskingFilters?.(this.visible);
      return;
    }
    const wasHeld = heldAt !== null;
    release();
    const start = performance.now();
    let lit = false;
    try {
      lit = wasHeld && motion.payLights();
    } catch (error) {
      console.error("PF1 Lighting | a held step's light failed", error);
    }
    if (wasHeld || lit) {
      try {
        beforePublish?.();
      } catch (error) {
        console.error("PF1 Lighting | rebuild for a held step failed", error);
      }
    }
    // Core's own pass ran earlier in this update, before the lights moved.
    if (lit) canvas.effects.refreshLighting();
    const result = original.apply(this, args);
    motion.noteCycle({ busyPeakMs: +busyPeak.toFixed(1), publishMs: +(performance.now() - start).toFixed(1) });
    busyPeak = 0;
    return result;
  };
  Hooks.on("canvasTearDown", release);
}
