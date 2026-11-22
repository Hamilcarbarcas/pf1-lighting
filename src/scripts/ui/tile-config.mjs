/**
 * The Light tab on the tile sheet. DESIGN.md §12.9.4.
 *
 * Injected into core's `TileConfig` (AppV2) as a fourth tab. Core's `changeTab` works on the DOM
 * alone, so an injected nav link and `.tab` section switch like core's own. Re-injected on every
 * render; the active tab is restored from `app.tabGroups.sheet`.
 *
 * The select submits with the form. The custom light is saved straight to the tile with
 * `render: false`, so unsaved edits on other tabs survive.
 */

import { MODULE_ID } from "../constants.mjs";
import { t } from "../i18n.mjs";
import { CUSTOM, presetChoices, table as presetTable } from "../model/presets.mjs";
import * as tileLight from "../model/tile-light.mjs";
import { PresetLightConfig } from "./preset-light-config.mjs";

const MARKER = "pf1-lighting-tile-config";
const TAB = "pf1-lighting";
const GROUP = "sheet";
const PATH = `flags.${MODULE_ID}.${tileLight.EMITS_FLAG}`;

/** Fields the companion sets for itself. Same list as the item sheet's. */
const HIDDEN_FIELDS = ['[name="rotation"]', '[name="walls"]', '[name="vision"]', '[name="hidden"]'];

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

function options(selected) {
  const choices = presetChoices();
  const presets = choices.filter((choice) => choice.value !== CUSTOM);
  const custom = choices.filter((choice) => choice.value === CUSTOM);
  return [{ value: "", label: t("TileLight.None") }, ...presets, ...custom]
    .map(
      (choice) =>
        `<option value="${esc(choice.value)}"${choice.value === selected ? " selected" : ""}>${esc(choice.label)}</option>`
    )
    .join("");
}

function seedFor(doc, selected) {
  if (selected === CUSTOM || !selected) return tileLight.customOf(doc) ?? { light: {}, config: {} };
  const preset = presetTable()[selected];
  return preset ? foundry.utils.deepClone(preset) : { light: {}, config: {} };
}

function editCustom(doc, selected, onSaved) {
  const id = `${MARKER}-light-${doc.uuid.replace(/\./g, "-")}`;
  const open = foundry.applications.instances.get(id);
  if (open) return open.bringToFront();

  const app = new PresetLightConfig({
    id,
    preset: seedFor(doc, selected),
    label: t("TileLight.Tile"),
    title: t("TileLight.EditTitle"),
    submitLabel: t("Emits.SaveLight"),
    hide: HIDDEN_FIELDS,
    onSave: ({ negative, light, config }) =>
      doc
        .update(
          {
            [`${PATH}.preset`]: CUSTOM,
            [`${PATH}.==${tileLight.CUSTOM_KEY}`]: { negative, light, config },
          },
          { render: false }
        )
        .then(onSaved)
        .catch((error) => console.error(`${MODULE_ID} | custom tile light save failed`, error)),
  });
  app.render({ force: true });
  return app;
}

function inject(app, root) {
  const doc = app.document;
  if (!doc || !root) return;

  const nav = root.querySelector(`nav.tabs`);
  const footer = root.querySelector(".form-footer");
  if (!nav || !footer) return;

  for (const stale of root.querySelectorAll(`.${MARKER}`)) stale.remove();

  const active = app.tabGroups?.[GROUP] === TAB;
  const stored = tileLight.raw(doc);
  const selected = stored?.preset ?? "";
  const unset = selected === CUSTOM && !tileLight.customOf(doc);
  // A tile still being created has nothing to save a custom light onto.
  const saved = doc.collection?.has(doc.id) === true;

  nav.insertAdjacentHTML(
    "beforeend",
    `<a class="${MARKER}${active ? " active" : ""}" data-action="tab" data-group="${GROUP}" data-tab="${TAB}">
       <i class="fa-solid fa-lightbulb" inert></i><span>${esc(t("TileLight.Tab"))}</span>
     </a>`
  );

  footer.insertAdjacentHTML(
    "beforebegin",
    `<div class="tab scrollable ${MARKER}${active ? " active" : ""}" data-group="${GROUP}" data-tab="${TAB}">
       <div class="form-group">
         <label>${esc(t("TileLight.Light"))}</label>
         <div class="form-fields">
           <select name="${PATH}.preset">${options(selected)}</select>
           <button type="button" class="${MARKER}-edit" data-tooltip="${esc(t("TileLight.Customize"))}"
                   aria-label="${esc(t("TileLight.Customize"))}"${saved ? "" : " disabled"}>
             <i class="fa-solid fa-pen-to-square" inert></i>
           </button>
         </div>
         <p class="hint">${esc(t("TileLight.Hint"))}</p>
         <p class="hint ${MARKER}-unset"${unset ? "" : " hidden"}>${esc(t("TileLight.CustomUnset"))}</p>
       </div>
     </div>`
  );

  const tab = root.querySelector(`.tab.${MARKER}`);
  const select = tab?.querySelector("select");
  const unsetEl = tab?.querySelector(`.${MARKER}-unset`);
  const refresh = () => {
    if (unsetEl) unsetEl.hidden = !(select?.value === CUSTOM && !tileLight.customOf(doc));
  };
  select?.addEventListener("change", refresh);
  tab?.querySelector(`.${MARKER}-edit`)?.addEventListener("click", (event) => {
    event.preventDefault();
    editCustom(doc, select?.value ?? "", () => {
      if (select) select.value = CUSTOM;
      refresh();
    });
  });
}

/**
 * Keep the flag off tiles that never set one: the form submits the select on every save.
 * A stored configuration keeps its custom light when set back to None.
 */
function stripEmpty(doc, changes) {
  const flags = changes?.flags?.[MODULE_ID];
  const incoming = flags?.[tileLight.EMITS_FLAG];
  if (!incoming || incoming.preset) return;
  if (tileLight.raw(doc)) return;
  delete flags[tileLight.EMITS_FLAG];
  if (!Object.keys(flags).length) delete changes.flags[MODULE_ID];
  if (!Object.keys(changes.flags).length) delete changes.flags;
}

export function registerHooks() {
  Hooks.on("renderTileConfig", (app, html) => {
    try {
      inject(app, html instanceof HTMLElement ? html : html?.[0]);
    } catch (error) {
      console.error(`${MODULE_ID} | tile config injection failed`, error);
    }
  });

  Hooks.on("preCreateTile", (doc, data) => {
    if (foundry.utils.getProperty(data, `${PATH}.preset`) === "") {
      doc.updateSource({ [`flags.${MODULE_ID}.-=${tileLight.EMITS_FLAG}`]: null });
    }
  });

  Hooks.on("preUpdateTile", (doc, changes) => {
    try {
      stripEmpty(doc, changes);
    } catch (error) {
      console.error(`${MODULE_ID} | tile light cleanup failed`, error);
    }
  });
}
