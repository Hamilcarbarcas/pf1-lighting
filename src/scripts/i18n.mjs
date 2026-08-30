/**
 * `t()`, and the one ordering rule that decides where you can call it. DESIGN.md §10.11.
 *
 * ## `game.i18n` is empty during `init`
 *
 * `Game#initialize` calls the `init` hook and *then* awaits `i18n.initialize()`:
 *
 * ```js
 * Hooks.callAll("init");
 * this.registerSettings();
 * await this.i18n.initialize();   // ← the translations load here
 * ```
 *
 * So a `localize` call made from a `registerSettings` function returns the key it was given,
 * verbatim, and the settings list would read `PF1LIGHTING.Setting.readoutEnabled.Name`. This is
 * not a race that sometimes works — it is deterministic. **Nothing in this module localises at
 * registration time.**
 *
 * Foundry's answer is that registration takes a **key** and Foundry localises it at render:
 *
 * | Registered | Localised by |
 * | --- | --- |
 * | a setting's `name` / `hint` | `applications/settings/config.mjs:116-117` |
 * | a menu's `name` / `label` / `hint` | `templates/settings/config-category.hbs:4,10,14` |
 * | a keybinding's `name` / `hint` | `applications/sidebar/apps/controls-config.mjs:154` |
 * | a scene control tool's `title` | `templates/ui/scene-controls-tools.hbs:5` |
 * | an `ApplicationV2`'s `window.title` | `ApplicationV2#title` |
 * | a `DataField`'s `label` / `hint` | the form-group helper |
 *
 * Those sites hold a literal `"PF1LIGHTING.…"` string, which is what makes a key greppable from
 * the JSON entry to its one consumer. {@link t} is for everything else — window markup, dialogs,
 * notifications, the readout chip — all of which runs long after `ready`.
 *
 * A `DataField`'s `choices` is the one thing a key does not solve: Foundry localises a choice
 * label only when the caller passes `localize: true`, which `RegionBehaviorConfig` does not.
 * `choices` accepts a **function**, evaluated at render. See `model/areas.mjs`.
 *
 * ## What is deliberately not translated
 *
 * **The console.** `game.pf1Lighting.*` readouts, every `console.error` diagnostic, and
 * `TIER_NAME` — which is what `api.tierName()` hands another module — stay English. Those are
 * identifiers and developer output.
 *
 * That rule reaches further than it looks: **32 of the module's 38 settings are `config: false`**
 * (§10.6 took their rows out of the menu), so the only thing that ever prints their name is
 * `game.pf1Lighting.settings()`. Their `name` and `hint` are therefore plain English strings at
 * the registration site, not keys — putting them in `lang/en.json` would have asked a translator
 * for 32 paragraphs that no user can reach (Hamilcarbarcas, 2026-08-28). Only the six with a
 * rendered row are keyed.
 *
 * The two debug overlays keep their English for the same reason. `ui.notifications` is the
 * exception and is always translated: a toast is UI whatever provoked it.
 */

const ROOT = "PF1LIGHTING";

/**
 * A localised string, **at render time only**.
 *
 * @param {string} path - Below `PF1LIGHTING.`, e.g. `"Visuals.Levels.Legend"`
 * @param {object} [data] - Interpolation values; switches to `game.i18n.format`
 * @returns {string}
 */
export function t(path, data) {
  const key = `${ROOT}.${path}`;
  return data ? game.i18n.format(key, data) : game.i18n.localize(key);
}
