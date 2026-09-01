/**
 * The light-effect management window. DESIGN.md §12.10, §12.13 step 9.
 *
 * What is lit on this scene, and why. Every effect with its anchor, what it emits, what put it
 * there, what it is burning and when it ends — plus a per-row *put it out* and a bulk
 * *clear orphans*.
 *
 * ## Scene-scoped, and that is a decision rather than a shortcut
 *
 * Only the drawn scene has live sources. A world-wide list could report a record and an anchor for
 * an off-scene token and nothing at all about whether anything is actually burning there — a list
 * that looks like an answer and is half of one. This shows what is on the map in front of you, where
 * every column means what it says.
 *
 * **The reaper stays world-wide**, and the split is the point: it runs on `ready` and `canvasReady`,
 * costs a flag read over `game.scenes` and touches no canvas, so orphans on scenes nobody has opened
 * clear themselves without anyone going looking. This window is a convenience and a debugging
 * surface, not the repair mechanism.
 *
 * ## One definition of orphaned
 *
 * The *source gone* column and the **Clear orphans** button both call `companion.orphaned` — the
 * predicate the reaper itself uses. A second implementation here would look identical and then
 * drift, and the failure would be this window reporting rows the reaper declines to collect, or
 * collecting rows it never showed.
 *
 * ## Live, without a hook per row
 *
 * Records live in anchor flags, so any change to one fires `updateToken` / `updateTile` /
 * `updateMeasuredTemplate` on every client. The window re-renders from those three while it is open
 * and unsubscribes on close, which is what keeps a row that another GM just cleared from staying on
 * screen as a button that does nothing.
 */

import { MODULE_ID } from "../constants.mjs";
import { t } from "../i18n.mjs";
import * as companion from "../model/companion.mjs";
import { presetLabel } from "../model/presets.mjs";
import { isWriter } from "./scene-config.mjs";

const HOUR = 3600;

/* -------------------------------------------- */
/*  Markup                                      */
/* -------------------------------------------- */

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

/**
 * A span of game time, in the largest unit that keeps it readable.
 *
 * @remarks
 * Rounded rather than exact. Nothing here is arithmetic a GM checks — it answers *has this been
 * burning a while*, and "3.4 hours" answers it no better than "3 hours" while reading worse.
 */
function duration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return t("Effects.Seconds", { n: s });
  if (s < HOUR) return t("Effects.Minutes", { n: Math.round(s / 60) });
  if (s < 24 * HOUR) return t("Effects.Hours", { n: Math.round(s / HOUR) });
  return t("Effects.Days", { n: Math.round(s / (24 * HOUR)) });
}

/** What put this effect here, as a name rather than a uuid. */
function sourceCell(record, owner) {
  if (!record.source) return `<span class="pf1-lighting-effects-none">${esc(t("Effects.NoSource"))}</span>`;
  if (!owner) {
    return `<span class="pf1-lighting-effects-orphan" data-tooltip="${esc(record.source)}">
      <i class="fa-solid fa-link-slash"></i> ${esc(t("Effects.Orphaned"))}</span>`;
  }
  return `<span data-tooltip="${esc(record.source)}">${esc(owner.name ?? owner.uuid)}</span>`;
}

/** What it is burning, and how far through. */
function fuelCell(record, worldTime) {
  if (!record.fuel?.item) return `<span class="pf1-lighting-effects-none">—</span>`;
  const burnt = Math.max(0, worldTime - (record.litAt ?? worldTime));
  const spent = record.fuel.consumed ?? 0;
  const tip = t("Effects.FuelTip", {
    hours: record.fuel.hours,
    burnt: duration(burnt),
  });
  return `<span data-tooltip="${esc(tip)}">${esc(record.fuel.item)}${
    spent ? ` <strong>×${spent}</strong>` : ""
  }</span>`;
}

/** When it ends, if anything has said. */
function expiryCell(record, worldTime) {
  if (!Number.isFinite(record.expires)) {
    return `<span class="pf1-lighting-effects-none" data-tooltip="${esc(t("Effects.NoExpiryTip"))}">—</span>`;
  }
  const left = record.expires - worldTime;
  if (left <= 0) return `<span class="pf1-lighting-effects-orphan">${esc(t("Effects.Due"))}</span>`;
  return `<span>${esc(duration(left))}</span>`;
}

/* -------------------------------------------- */
/*  The application                             */
/* -------------------------------------------- */

class EffectsWindow extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "pf1-lighting-effects",
    tag: "div",
    classes: ["pf1-lighting", "effects-window"],
    window: {
      title: "PF1LIGHTING.Effects.Title",
      icon: "fa-solid fa-lightbulb",
      resizable: true,
    },
    position: { width: 720, height: "auto" },
    actions: {
      clearOne: EffectsWindow.#onClearOne,
      clearOrphans: EffectsWindow.#onClearOrphans,
      panTo: EffectsWindow.#onPanTo,
      refresh: EffectsWindow.#onRefresh,
    },
  };

  /* -------------------------------------------- */

  /**
   * Every effect on this scene, with what it needs to be described.
   *
   * @remarks
   * `orphaned` is awaited per record, which is why this is async and the rows are built here rather
   * than inline in the markup. It resolves a uuid, which for a compendium source is a load — rare,
   * but not something to do inside a template string.
   */
  async #rows() {
    const worldTime = game.time?.worldTime ?? 0;
    const rows = [];

    for (const doc of companion.anchorsOnScene()) {
      for (const record of companion.list(doc)) {
        let owner = null;
        if (record.source) {
          try {
            owner = await fromUuid(record.source);
          } catch {
            owner = null;
          }
        }
        rows.push({
          doc,
          record,
          owner,
          orphan: await companion.orphaned(record),
          worldTime,
        });
      }
    }
    return rows;
  }

  /** @override */
  async _renderHTML() {
    const rows = await this.#rows();
    const orphans = rows.filter((row) => row.orphan).length;

    if (!rows.length) {
      return `
<p class="notification info">${esc(t("Effects.Empty"))}</p>
${this.#footer(0)}`;
    }

    const body = rows
      .map(
        ({ doc, record, owner, orphan, worldTime }) => `
    <tr${orphan ? ' class="pf1-lighting-effects-row-orphan"' : ""}>
      <td>
        <a data-action="panTo" data-anchor="${esc(doc.uuid)}"
           data-tooltip="${esc(t("Effects.PanTo"))}">${esc(doc.name ?? doc.documentName)}</a>
      </td>
      <td>${esc(record.label ?? "")}</td>
      <td>${esc(record.preset ? presetLabel(record.preset) : "—")}</td>
      <td>${sourceCell(record, owner)}</td>
      <td>${fuelCell(record, worldTime)}</td>
      <td>${expiryCell(record, worldTime)}</td>
      <td class="pf1-lighting-effects-controls">
        <a data-action="clearOne" data-anchor="${esc(doc.uuid)}" data-record="${esc(record.id)}"
           data-tooltip="${esc(t("Effects.Clear"))}"><i class="fa-solid fa-xmark"></i></a>
      </td>
    </tr>`
      )
      .join("");

    return `
<table class="pf1-lighting-effects-table">
  <thead>
    <tr>
      <th>${esc(t("Effects.Anchor"))}</th>
      <th>${esc(t("Effects.Label"))}</th>
      <th>${esc(t("Common.Preset"))}</th>
      <th>${esc(t("Effects.Source"))}</th>
      <th>${esc(t("Emits.Fuel"))}</th>
      <th>${esc(t("Effects.Expires"))}</th>
      <th></th>
    </tr>
  </thead>
  <tbody>${body}</tbody>
</table>
${this.#footer(orphans)}`;
  }

  #footer(orphans) {
    return `
<footer class="form-footer pf1-lighting-effects-footer">
  <button type="button" data-action="refresh">
    <i class="fa-solid fa-rotate"></i> ${esc(t("Effects.Refresh"))}</button>
  <button type="button" data-action="clearOrphans" ${orphans ? "" : "disabled"}>
    <i class="fa-solid fa-broom"></i> ${esc(t("Effects.ClearOrphans", { count: orphans }))}</button>
</footer>`;
  }

  /** @override */
  _replaceHTML(result, content) {
    content.innerHTML = result;
  }

  /* -------------------------------------------- */
  /*  Staying current                             */
  /* -------------------------------------------- */

  /**
   * Re-render when an anchor's records change.
   *
   * @remarks
   * Records live in anchor flags, so every write fires one of these three on every client. Without
   * it a row another GM has just cleared stays on screen as a button that does nothing — and the
   * fuel and expiry columns are time-derived, so `updateWorldTime` is the fourth.
   *
   * A stable bound field so `close` can remove exactly what `_onRender` added; an anonymous
   * handler would leak one listener per render and each copy would re-render.
   */
  #onDocChange = () => this.render();

  /** @override */
  _onRender() {
    for (const hook of EffectsWindow.#HOOKS) Hooks.off(hook, this.#onDocChange);
    for (const hook of EffectsWindow.#HOOKS) Hooks.on(hook, this.#onDocChange);
  }

  /** @override */
  _onClose() {
    for (const hook of EffectsWindow.#HOOKS) Hooks.off(hook, this.#onDocChange);
  }

  static #HOOKS = ["updateToken", "updateTile", "updateMeasuredTemplate", "updateWorldTime"];

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  static async #onPanTo(event, target) {
    const doc = await fromUuid(target.dataset.anchor);
    const object = doc?.object;
    if (!object) return;
    await canvas.animatePan({ x: object.center?.x ?? doc.x, y: object.center?.y ?? doc.y });
    object.control?.({ releaseOthers: true });
  }

  static async #onClearOne(event, target) {
    const { anchor, record } = target.dataset;
    const doc = await fromUuid(anchor);
    if (!doc) return;
    // Through the ordinary API, relay and ownership check included (§12.5). A GM passes, but the
    // window has no business having a second route to the same write.
    await companion.clear(doc, record);
    this.render();
  }

  /**
   * @remarks
   * `companion.reap()` rather than a loop of `clear` calls: it is the same predicate this window
   * displays, it is already GM-gated, and it walks the **world** — so pressing this on one scene
   * also tidies the ones nobody has opened. The count on the button is scene-local because that is
   * what the list shows; the report says what actually came off.
   */
  static async #onClearOrphans() {
    const report = await companion.reap();
    ui.notifications.info(t("Effects.Reaped", { count: report.removed }));
    this.render();
  }

  static #onRefresh() {
    this.render();
  }
}

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

/** @type {EffectsWindow|null} One window, so the scene-control button toggles rather than stacks. */
let instance = null;

export function open() {
  instance ??= new EffectsWindow();
  return instance.rendered ? instance.close() : instance.render({ force: true });
}

export function registerSceneControls() {
  Hooks.on("getSceneControlButtons", (controls) => {
    // GM only. A player cannot modify an effect on a token they do not own and has no use for a
    // list of what is burning on someone else's.
    if (!game.user.isGM) return;
    const lighting = controls.lighting;
    if (!lighting?.tools) return;

    lighting.tools.pf1LightingEffects = {
      name: "pf1LightingEffects",
      // After the four tier buttons (`ui/scene-config` takes 2–5) and before core's reset and
      // clear, which that module renumbers to 6 and 7.
      order: 5.5,
      title: "PF1LIGHTING.Effects.Control",
      icon: "fa-solid fa-lightbulb",
      button: true,
      onChange: () => open(),
    };
  });
}

/** The same query as the window, for the console. `game.pf1Lighting.effects.status()` covers more. */
export function status(scene = canvas?.scene) {
  const worldTime = game.time?.worldTime ?? 0;
  const rows = [];
  for (const doc of companion.anchorsOnScene(scene)) {
    for (const record of companion.list(doc)) {
      rows.push({
        anchor: doc.name ?? doc.uuid,
        id: record.id,
        label: record.label,
        preset: record.preset,
        source: record.source ?? null,
        fuel: record.fuel?.item ?? null,
        burntSeconds: Math.max(0, worldTime - (record.litAt ?? worldTime)),
        expires: record.expires ?? null,
      });
    }
  }
  const report = { scene: scene?.name ?? null, writer: isWriter(), count: rows.length, rows };
  console.error(`${MODULE_ID} | light effects on this scene`, report);
  return report;
}
