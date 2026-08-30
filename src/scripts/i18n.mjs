/**
 * `t()`, and the ordering rule that decides where it can be called. DESIGN.md §10.11.
 *
 * `game.i18n` is empty during `init`: `Game#initialize` calls the `init` hook, then
 * `registerSettings()`, and only then awaits `i18n.initialize()`. A `localize` call from a
 * `registerSettings` function therefore returns its key verbatim — deterministically, not as a
 * race. Nothing in this module localises at registration time.
 *
 * Registration takes a key instead, localised by Foundry at render:
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
 * Those sites hold a literal `"PF1LIGHTING.…"`, keeping a key greppable from JSON entry to
 * consumer. {@link t} covers everything else — window markup, dialogs, notifications, the readout
 * chip — all of which runs long after `ready`.
 *
 * A `DataField`'s `choices` is the exception a key does not solve: Foundry localises choice labels
 * only when passed `localize: true`, which `RegionBehaviorConfig` does not. `choices` accepts a
 * function, evaluated at render — see `model/areas.mjs`.
 *
 * Not translated: the console. `game.pf1Lighting.*` readouts, `console.error` diagnostics, and
 * `TIER_NAME` (what `api.tierName()` hands other modules) stay English as developer output.
 *
 * That reaches further than it looks. 32 of the module's 38 settings are `config: false` (§10.6),
 * so only `game.pf1Lighting.settings()` ever prints their names; those are plain English at the
 * registration site rather than keys, since translating 32 unreachable paragraphs helps nobody
 * (2026-08-28). Only the six with a rendered row are keyed. The two debug overlays likewise.
 * `ui.notifications` is always translated — a toast is UI whatever provoked it.
 */

const ROOT = "PF1LIGHTING";

/**
 * A localised string, at render time only.
 *
 * @param {string} path - Below `PF1LIGHTING.`, e.g. `"Visuals.Levels.Legend"`
 * @param {object} [data] - Interpolation values; switches to `game.i18n.format`
 * @returns {string}
 */
export function t(path, data) {
  const key = `${ROOT}.${path}`;
  return data ? game.i18n.format(key, data) : game.i18n.localize(key);
}
