/**
 * Perception steps during token movement. DESIGN.md §9.14.
 *
 * Core re-sweeps a moving token's sources every animation frame, and every later stage repeats with
 * them. Here the sprite keeps the frame rate and the sources step on a clock. A deferred token is
 * flushed when the interval runs out, so the last position of a move is always applied.
 *
 * Other tokens' and door icons' visibility is tested a few each frame while steps are coming, and
 * the ones still waiting finish the same way once they stop. Those frames are never a step's.
 */

import { MODULE_ID } from "../constants.mjs";
import { number } from "../settings-cache.mjs";

export const SETTING_STEP = "movementPerceptionStep";

/** For bisecting from the console, as `game.pf1Lighting.motionSwitches`. §9.14. */
export const switches = { hold: true, queue: true, trail: true, light: true };

/** What waiting visibility tests may spend in one frame, in milliseconds. */
const FRAME_BUDGET_MS = 5;
/** Frames left free between a held step going out and the next one starting, about two. */
const RELEASE_GAP_MS = 34;
/** How long after the last step tests go back to running at once, at least. */
const SETTLE_MS = 400;
/** A step costing less than this leaves the interval as set. */
const WIDEN_ABOVE_MS = 50;
/** Step to step, in multiples of what a step costs, so some frames aren't step frames. */
const COST_FACTOR = 1.5;
const MAX_INTERVAL_MS = 120;

const pending = new Set();
const owed = new Map();
let testing = false;
let stepping = false;
let holding = false;
let releasedAt = -Infinity;
let drainPeakMs = 0;
let cycle = {};
let listening = false;
let stepCost = 0;
let stepCount = 0;
let moving = false;
let settleTimer = null;
let stepAt = -Infinity;
let stepTick = null;
let timer = null;
let flushing = false;
let paying = false;
/** Light updates waiting for a held step to go out, by what they move. */
const lights = new Map();

/** The interval in milliseconds; 0 restores core's every-frame update. */
export const stepMs = () => Math.max(0, number(SETTING_STEP, 50));

/** The setting, lengthened while steps are expensive. §9.14. */
export function intervalMs() {
  const base = stepMs();
  if (!base || (stepCost < WIDEN_ABOVE_MS)) return base;
  return Math.max(base, Math.min(MAX_INTERVAL_MS, stepCost * COST_FACTOR));
}

/** Have steps been coming? Anything arriving now may trail by a step. */
export const isMoving = () => moving;

/** Which step this is. */
export const stepId = () => stepCount;

/** Is a step's refresh waiting on its worker jobs? Its visuals go out together, §9.14. */
export const isHolding = () => holding;

/** How long until a step may start. */
function stepWait(interval, now) {
  return Math.max(interval - (now - stepAt), RELEASE_GAP_MS - (now - releasedAt));
}

/** The next step waits for a held one, and leaves on the interval after it's released. */
export function setHolding(value) {
  if (holding === value) return;
  holding = value;
  if (holding) return;
  const now = performance.now();
  releasedAt = now;
  if (pending.size) timer ??= setTimeout(flush, Math.max(0, stepWait(intervalMs(), now)));
}

/** The last step's timings, for the console. */
export function noteCycle(values) {
  cycle = { ...cycle, ...values };
}

function settle() {
  settleTimer = null;
  moving = false;
  stepCost = 0;
  // Whatever followed the last step's release; nothing holds it now.
  if (lights.size && canvas?.ready) {
    payLights();
    canvas.perception.update({ refreshLighting: true, refreshVision: true });
  }
}

function markStep() {
  moving = true;
  stepping = true;
  stepCount++;
  // The rest of this frame and whatever it held the next one back by.
  const start = performance.now();
  requestAnimationFrame(() => {
    if (!moving) return;
    // Slow to rise and quick to fall, so one long frame doesn't space out the steps after it.
    const sample = performance.now() - start;
    stepCost = stepCost ? Math.min(sample, (stepCost + sample) / 2) : sample;
  });
  clearTimeout(settleTimer);
  settleTimer = setTimeout(settle, Math.max(SETTLE_MS, intervalMs() + 100));
}

const retestToken = (token) => {
  if (token.mesh) token._refreshVisibility();
};

const retestDoor = (door) => {
  door.visible = door.isVisible;
};

function drain() {
  // A step's frame is full already, and the first test after it pays to rebuild what it invalidated.
  if (holding || stepping) {
    stepping = false;
    return;
  }
  if (!owed.size) return;
  const start = performance.now();
  const end = start + FRAME_BUDGET_MS;
  testing = true;
  try {
    // Setting an existing key keeps its place when it's flagged again, so the oldest go first.
    for (const [item, retest] of owed) {
      owed.delete(item);
      if (!item.destroyed) retest(item);
      if (performance.now() >= end) break;
    }
  } finally {
    testing = false;
    drainPeakMs = Math.max(drainPeakMs, performance.now() - start);
  }
}

function queue(item, retest) {
  owed.set(item, retest);
  if (!listening) {
    listening = true;
    // After the frame is drawn: core's animation clock counts whatever runs before it. §9.14.
    canvas.app.ticker.add(drain, null, PIXI.UPDATE_PRIORITY.LOW - 1);
  }
  return true;
}

/**
 * Should this token's visibility test wait for a frame with budget?
 *
 * @param {Token} token
 * @returns {boolean} True when the test was queued.
 */
export function queueVisibility(token) {
  if (testing) return false;
  const waits = switches.queue && moving && stepMs() && !token.controlled && !token.hover && !token.isPreview
    && !token.vision?.active && !token.animationContexts?.size;
  if (waits) return queue(token, retestToken);
  owed.delete(token);
  return false;
}

/**
 * Should this door icon's visibility test wait? It keeps its current state until then.
 *
 * @param {DoorControl} door
 * @returns {boolean} True when the test was queued.
 */
export function queueDoor(door) {
  if (testing) return false;
  if (switches.queue && moving && stepMs()) return queue(door, retestDoor);
  owed.delete(door);
  return false;
}

function flush() {
  timer = null;
  if (holding) return;
  const tokens = [...pending];
  pending.clear();
  if (!canvas?.ready || !tokens.length) return;
  stepAt = performance.now();
  stepTick = canvas.app.ticker.lastTime;
  markStep();
  flushing = true;
  try {
    for (const token of tokens) {
      if (!token.destroyed) token.initializeSources();
    }
  } finally {
    flushing = false;
  }
}

/** Is a timed step updating its tokens' sources? */
export const isFlushing = () => flushing;

/**
 * Should a light update go out with the next held step? Every step's first refresh holds.
 *
 * @param {object} key  What the update moves; a later one for the same key replaces it
 * @param {Function} update
 * @returns {boolean} True when it waits for {@link payLights}.
 */
export function owe(key, update) {
  if (paying || !switches.light || !switches.hold || !moving || !stepMs()) return false;
  lights.set(key, update);
  return true;
}

/** A step's own light, for the observer mixin. */
export function oweLight(token) {
  return owe(token, () => {
    if (token.destroyed) return;
    token.initializeLightSource();
    // Uniforms, which core's `refreshLightSources` would update in this frame.
    token.light?.refresh();
  });
}

/**
 * Run the light updates owed by held steps.
 *
 * @returns {boolean} Whether there were any.
 */
export function payLights() {
  if (!lights.size) return false;
  const updates = [...lights.values()];
  lights.clear();
  paying = true;
  try {
    for (const update of updates) {
      try {
        update();
      } catch (error) {
        console.error(`${MODULE_ID} | a held light update failed`, error);
      }
    }
  } finally {
    paying = false;
  }
  return true;
}

/**
 * Should this animation frame's source update wait?
 *
 * @param {Token} token
 * @returns {boolean} True when the update was queued for the next step.
 */
export function defer(token) {
  const interval = intervalMs();
  if (!interval) return false;
  // `lastTime` holds still for a whole tick, so tokens moving together share one step.
  const tick = canvas.app.ticker.lastTime;
  const now = performance.now();
  if (tick === stepTick) {
    pending.delete(token);
    return false;
  }
  if (holding) {
    pending.add(token);
    return true;
  }
  const wait = stepWait(interval, now);
  if (wait <= 0) {
    stepAt = now;
    stepTick = tick;
    markStep();
    pending.delete(token);
    return false;
  }
  pending.add(token);
  timer ??= setTimeout(flush, wait);
  return true;
}

export function status() {
  const drainMs = +drainPeakMs.toFixed(1);
  drainPeakMs = 0;
  return { moving, holding, owed: owed.size, intervalMs: intervalMs(), stepCostMs: +stepCost.toFixed(1), drainPeakMs: drainMs, ...cycle };
}

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTING_STEP, {
    name: "PF1LIGHTING.Setting.movementPerceptionStep.Name",
    hint: "PF1LIGHTING.Setting.movementPerceptionStep.Hint",
    scope: "client",
    config: true,
    type: Number,
    range: { min: 0, max: 150, step: 10 },
    default: 50,
  });
}

export function registerHooks() {
  Hooks.on("canvasTearDown", () => {
    clearTimeout(timer);
    clearTimeout(settleTimer);
    canvas.app?.ticker?.remove(drain);
    listening = false;
    timer = null;
    settleTimer = null;
    moving = false;
    holding = false;
    stepping = false;
    releasedAt = -Infinity;
    stepCost = 0;
    pending.clear();
    owed.clear();
    lights.clear();
    flushing = false;
    paying = false;
    stepAt = -Infinity;
    stepTick = null;
  });
}
