/**
 * The Tile HUD light button. DESIGN.md §12.9.3.
 *
 * GM-only (tiles are GM-only placeables). Top of the left column, above elevation. Click puts the
 * light out, or opens the preset list when nothing is lit; right-click opens the list regardless.
 * The record carries no `source`, so the reaper leaves it alone and it lasts until turned off
 * (§12.5.2). Same fixed id as the Token HUD's, so a second pick swaps the light.
 *
 * A tile with a Light tab configuration gets an *As configured* row first (§12.9.4). While lit that
 * way, a configuration edit re-applies or, when cleared, puts the light out.
 */

import { MODULE_ID } from "../constants.mjs";
import { t } from "../i18n.mjs";
import { CUSTOM, presetChoices } from "../model/presets.mjs";
import * as companion from "../model/companion.mjs";
import * as tileLight from "../model/tile-light.mjs";
import { isWriter } from "./scene-config.mjs";
import { HUD_ID } from "./token-hud.mjs";

/** Per-feature class (`reference_shared_css_class_dedup_trap`). */
const MARKER = "pf1-lighting-tile-hud";

const litBy = (doc) => companion.list(doc).find((record) => record.id === HUD_ID) ?? null;

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

function rows(doc) {
  const record = litBy(doc);
  const current = record?.configured ? null : (record?.preset ?? null);
  const configured = tileLight.effectFor(doc)
    ? `
    <a class="${MARKER}-choice ${MARKER}-configured${record?.configured ? " active" : ""}"
       data-action="pf1LightingTilePick" data-configured="1">
      <span>${esc(t("TileLight.AsConfigured"))}</span>
    </a>`
    : "";
  return configured + presetChoices()
    .filter((choice) => choice.value !== CUSTOM)
    .map(
      (choice) => `
    <a class="${MARKER}-choice${choice.value === current ? " active" : ""}"
       data-action="pf1LightingTilePick" data-preset="${esc(choice.value)}">
      <span>${esc(choice.label)}</span>
    </a>`
    )
    .join("");
}

/**
 * @param {object} hud - The `TileHUD` application
 * @param {HTMLElement} html
 */
function inject(hud, html) {
  if (!game.user.isGM) return;
  const doc = hud.object?.document;
  if (!doc) return;

  const column = html.querySelector(".col.left");
  if (!column) return;
  // The HUD element is reused between tiles.
  for (const stale of html.querySelectorAll(`.${MARKER}, .${MARKER}-palette`)) stale.remove();

  const record = litBy(doc);
  column.insertAdjacentHTML(
    "afterbegin",
    `<button type="button" class="control-icon ${MARKER}${record ? " active" : ""}"
             data-action="pf1LightingTileToggle" data-tooltip="${esc(t("Hud.Tooltip"))}">
       <i class="fa-solid fa-lightbulb" inert></i>
     </button>
     <div class="palette ${MARKER}-palette"></div>`
  );

  const buttonEl = column.querySelector(`.${MARKER}`);
  const paletteEl = column.querySelector(`.${MARKER}-palette`);
  if (!buttonEl || !paletteEl) return;

  const isOpen = () => paletteEl.classList.contains("active");
  const showPalette = (visible) => {
    if (visible) {
      paletteEl.innerHTML = rows(doc);
      // Top edge level with the button; the column is `flex-start`, so this is usually 0.
      paletteEl.style.top = `${buttonEl.offsetTop}px`;
    }
    paletteEl.classList.toggle("active", visible);
  };

  // Handlers live on the application and are dispatched by `data-action`.
  hud.options.actions.pf1LightingTileToggle = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (litBy(doc)) {
      await companion.clear(doc, HUD_ID);
      buttonEl.classList.remove("active");
      showPalette(false);
      return;
    }
    showPalette(!isOpen());
  };

  hud.options.actions.pf1LightingTilePick = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    showPalette(false);
    let effect = null;
    if (event.target?.closest("[data-configured]")) {
      effect = tileLight.effectFor(doc, { id: HUD_ID });
    } else {
      const preset = event.target?.closest("[data-preset]")?.dataset?.preset;
      if (preset) {
        effect = {
          id: HUD_ID,
          preset,
          label: presetChoices().find((choice) => choice.value === preset)?.label ?? preset,
        };
      }
    }
    if (!effect) return;
    const applied = await companion.apply(doc, effect);
    buttonEl.classList.toggle("active", !!applied);
  };

  // `contextmenu` is not delegated by core, so bound to the node.
  buttonEl.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    showPalette(!isOpen());
  });
}

/** Re-apply, or put out, a light lit from a configuration that just changed. Active GM only. */
async function follow(doc, changed) {
  if (!foundry.utils.hasProperty(changed, `flags.${MODULE_ID}.${tileLight.EMITS_FLAG}`) &&
      !foundry.utils.hasProperty(changed, `flags.${MODULE_ID}.-=${tileLight.EMITS_FLAG}`)) return;
  if (!isWriter() || !litBy(doc)?.configured) return;
  const effect = tileLight.effectFor(doc, { id: HUD_ID });
  if (effect) await companion.apply(doc, effect);
  else await companion.clear(doc, HUD_ID);
}

export function registerHooks() {
  Hooks.on("updateTile", (doc, changed) => {
    follow(doc, changed).catch((error) =>
      console.error(`${MODULE_ID} | tile light follow failed`, error));
  });

  Hooks.on("renderTileHUD", (hud, html) => {
    try {
      inject(hud, html instanceof HTMLElement ? html : html?.[0]);
    } catch (error) {
      console.error(`${MODULE_ID} | tile HUD injection failed`, error);
    }
  });
}
