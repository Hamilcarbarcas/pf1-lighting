/**
 * The emitter pip: a small badge on a token carrying a light effect. DESIGN.md §12.9.2.
 *
 * Hangs half off the token's right edge at mid-height, the one spot clear of status icons
 * (top-left, filling rightward), the selective-vision marker (top-right), bar values (bottom
 * corners), and the bars themselves. Flame for a light, moon for a darkness; one pip per kind.
 *
 * Reads companion records only. A light configured on the token itself is not an effect and gets no
 * pip, or every glowing monster would carry one permanently.
 */

import { MODULE_ID } from "../constants.mjs";
import * as settingsCache from "../settings-cache.mjs";
import * as companion from "../model/companion.mjs";

const SETTING = "emitterPip";

/** Per-token container. A symbol, so nothing else can collide with it. */
const PIP = Symbol("pf1LightingPip");

const FONT = "Font Awesome 6 Pro";
const GLYPH = { light: "\u{f7e4}", darkness: "\u{f186}" }; // fire-flame-curved, moon
const LIGHT_DEFAULT = 0xffc061;
const DARKNESS_TINT = 0xa58bd8;

/** Diameter at uiScale 1; core's status icons are 20. */
const SIZE = 16;

/** False until the icon font is ready; a glyph drawn before then caches as tofu. */
let fontReady = false;

/* -------------------------------------------- */

/** The light's own color, or a warm default for white/uncolored lights. */
function tintOf(record) {
  const raw = record.light?.color;
  if (raw === null || raw === undefined || raw === "") return LIGHT_DEFAULT;
  const color = foundry.utils.Color.from(raw);
  return color.valid ? Number(color) : LIGHT_DEFAULT;
}

/** What to draw: at most one light pip and one darkness pip. */
function pipsFor(doc) {
  let light = null;
  let darkness = false;
  for (const record of companion.list(doc)) {
    if (record.light?.negative === true) darkness = true;
    else light ??= tintOf(record);
  }
  const out = [];
  if (light !== null) out.push({ glyph: GLYPH.light, tint: light });
  if (darkness) out.push({ glyph: GLYPH.darkness, tint: DARKNESS_TINT });
  return out;
}

function build(pips, s) {
  const root = new PIXI.Container();
  root.eventMode = "none";
  const d = SIZE * s;
  pips.forEach(({ glyph, tint }, i) => {
    const pip = new PIXI.Container();
    pip.y = i * (d + 2 * s);

    const disc = new PIXI.Graphics();
    disc.lineStyle(s, tint, 0.9).beginFill(0x000000, 0.65).drawCircle(0, 0, d / 2).endFill();
    pip.addChild(disc);

    const text = new foundry.canvas.containers.PreciseText(glyph, {
      fontFamily: FONT,
      fontWeight: "900",
      fontSize: Math.round(d * 0.6),
      fill: tint,
    });
    text.anchor.set(0.5, 0.5);
    pip.addChild(text);

    root.addChild(pip);
  });
  return root;
}

/** Create, update, or hide one token's pip. Cheap when nothing changed: a flag read and a move. */
function sync(token) {
  if (!token || token.destroyed || token.isPreview) return;
  let root = token[PIP];
  if (root?.destroyed) root = token[PIP] = null;

  const pips = fontReady && settingsCache.flag(SETTING, true) ? pipsFor(token.document) : [];
  if (!pips.length) {
    if (root) root.visible = false;
    return;
  }

  const s = canvas.dimensions.uiScale ?? 1;
  const key = `${s}|${pips.map((p) => `${p.glyph}${p.tint}`).join("|")}`;
  if (!root || root.pipKey !== key) {
    root?.destroy({ children: true });
    root = token[PIP] = token.addChild(build(pips, s));
    root.pipKey = key;
  }

  const span = (pips.length - 1) * (SIZE + 2) * s;
  root.position.set(token.w, token.h / 2 - span / 2);
  root.visible = true;
}

function syncAll() {
  for (const token of canvas?.tokens?.placeables ?? []) sync(token);
}

/* -------------------------------------------- */

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTING, {
    name: "PF1LIGHTING.Setting.emitterPip.Name",
    hint: "PF1LIGHTING.Setting.emitterPip.Hint",
    scope: "user",
    config: true,
    type: Boolean,
    default: true,
    // The cache clears on `updateSetting`, which fires before this.
    onChange: () => syncAll(),
  });
}

export function registerHooks() {
  Hooks.on("refreshToken", sync);

  // A flag-only update does not refresh the token, so a light going on or off needs its own nudge.
  Hooks.on("updateToken", (doc, changed) => {
    const flags = changed.flags?.[MODULE_ID];
    if (flags && (companion.EFFECTS_FLAG in flags || `-=${companion.EFFECTS_FLAG}` in flags)) {
      sync(doc.object);
    }
  });

  Hooks.on("canvasReady", async () => {
    if (!fontReady) {
      try {
        await document.fonts.load(`900 16px "${FONT}"`);
        fontReady = true;
      } catch (error) {
        console.error(`${MODULE_ID} | emitter pip: icon font failed to load`, error);
        return;
      }
    }
    syncAll();
  });
}

/**
 * Debug readout.
 *
 *   game.pf1Lighting.effects.pips()
 */
export function status() {
  const rows = (canvas?.tokens?.placeables ?? [])
    .filter((token) => companion.list(token.document).length)
    .map((token) => ({
      name: token.name,
      records: companion.list(token.document).length,
      pips: pipsFor(token.document).length,
      drawn: !!token[PIP] && !token[PIP].destroyed && token[PIP].visible,
    }));
  const report = { enabled: settingsCache.flag(SETTING, true), fontReady, tokens: rows };
  console.error(`${MODULE_ID} | emitter pips`, report);
  return report;
}
