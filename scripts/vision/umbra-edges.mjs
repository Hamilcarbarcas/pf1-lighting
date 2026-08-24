/**
 * Sight edges derived from the **model**, not from source shapes. DESIGN.md §4.3, §4.5.2.
 *
 * ## Why this exists instead of `PointDarknessSource#_createEdges`
 *
 * Edges built inside a darkness source can only trace `this.shape` — the suppressor's *raw*
 * polygon. That is the wrong geometry, and wrong in three ways that all reduce to the same
 * mistake: **where a darkness is** is not **where a darkness is in effect**.
 *
 *   - A region annihilated by a *daylight* (§4.1.2) must cast nothing. Raw shapes cast it
 *     anyway; the model knows the slice is cancelled and the edges never heard.
 *   - A two-band suppressor (§3.3.1) should cast a weaker umbra from its rim than its core.
 *     One source, two tiers, one polygon.
 *   - "One orb, one umbra strength" is not a rule anywhere. It is an artefact of tracing a
 *     circle.
 *
 * `field()` already computes the right answer — effective regions with breakers subtracted,
 * each carrying a resolved tier. So the edges come from cells.
 *
 * ## Two traps, both found before writing
 *
 * **Cells must be unioned per tier before emitting.** `reduced` and `dark` cells tile a
 * suppressor's effective region between them, so emitting each cell's outline would put
 * edges on the boundaries *between* them — blocking sight *inside* a single darkness. Only
 * the union's outline is a real boundary. Holes in the union are real boundaries too, and are
 * emitted.
 *
 * **Ordering forbids doing this during source initialisation.** Cells need the whole scene
 * resolved, which needs every source built. So this is a post-field pass that syncs edges and
 * then asks for vision only — never lighting, which is what would close the
 * `initializeLighting` → hook → rebuild loop §8.3 warns about. Light sweeps ignore these
 * edges entirely (`light: NONE`), so lighting has no reason to re-run.
 */

import { MODULE_ID, umbraRank } from "../constants.mjs";
import { CLIPPER_SCALE, toClipperPath } from "../geometry.mjs";
import * as field from "../model/field.mjs";
import { castsUmbra } from "../model/contest.mjs";

/** Every edge we own is keyed under this, so reconciliation never touches a wall. */
const EDGE_PREFIX = `${MODULE_ID}.umbra`;

/** Ids currently registered in `canvas.edges`. */
let owned = new Set();

/** The field object the current edges were derived from. */
let lastField = null;

let scheduled = false;
let lastStats = null;

/**
 * Cell kinds that lie inside a suppressor's effective region.
 *
 * `clip` is the *unsuppressed* part of an emitter and is explicitly not darkness. `reduced`
 * and `dark` together tile what the suppressor actually governs.
 */
const SUPPRESSED_KINDS = new Set(["reduced", "dark"]);

function unionPaths(paths) {
  if (!paths.length) return [];
  const c = new ClipperLib.Clipper();
  c.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
  const solution = new ClipperLib.Paths();
  c.Execute(
    ClipperLib.ClipType.ctUnion,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero
  );
  return solution;
}

/**
 * Group the field's suppressed cells into one union per umbra rank.
 *
 * @returns {Map<number, {X: number, Y: number}[][]>} rank → union paths
 */
function ringsByRank(cells) {
  const byRank = new Map();

  for (const cell of cells) {
    if (!SUPPRESSED_KINDS.has(cell.kind)) continue;
    if (!cell.suppressor || !castsUmbra(cell.suppressor)) continue;

    // The tier *this part of the darkness* resolves to — the amended §4.3 rule, applied per
    // region rather than per source. A lit patch inside a darkness is a window, and casts a
    // correspondingly weaker umbra.
    const rank = umbraRank(cell.tier);
    if (rank <= 0) continue;

    const path = toClipperPath(cell.polygon, CLIPPER_SCALE);
    if (path.length < 3) continue;

    if (!byRank.has(rank)) byRank.set(rank, []);
    byRank.get(rank).push(path);
  }

  for (const [rank, paths] of byRank) byRank.set(rank, unionPaths(paths));
  return byRank;
}

/** Drop every edge we own. */
export function clear() {
  for (const id of owned) canvas?.edges?.delete(id);
  owned = new Set();
  lastField = null;
}

/**
 * Rebuild our edges from the current field.
 *
 * @param {object} [options]
 * @param {boolean} [options.force]
 * @returns {object|null} stats, or null if nothing was done
 */
export function sync({ force = false } = {}) {
  if (!canvas?.ready || !canvas.edges) return null;

  const current = field.get();
  if (!force && current === lastField) return lastStats;
  lastField = current;

  const t0 = performance.now();
  const byRank = ringsByRank(current.cells);

  const next = new Set();
  const Edge = foundry.canvas.geometry.edges.Edge;
  let count = 0;

  for (const [rank, rings] of byRank) {
    for (let r = 0; r < rings.length; r++) {
      const ring = rings[r];
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        const id = `${EDGE_PREFIX}.${rank}.${r}.${i}`;

        canvas.edges.set(
          id,
          new Edge(
            { x: a.X / CLIPPER_SCALE, y: a.Y / CLIPPER_SCALE },
            { x: b.X / CLIPPER_SCALE, y: b.Y / CLIPPER_SCALE },
            {
              id,
              type: "darkness",
              // Light must pass straight through, or the model loses the unsuppressed
              // baseline the contest is computed from — §4.1.1 path 1, the original reason
              // darkness edges were disabled at all.
              light: CONST.WALL_SENSE_TYPES.NONE,
              sight: CONST.WALL_SENSE_TYPES.NORMAL,
              // Bidirectional. One-directional edges are ignored when facing away from the
              // origin (`clockwise-sweep.mjs:250-253`), which silently deletes the 360° umbra
              // an observer standing inside a darkness must have (§4.3).
              direction: CONST.WALL_DIRECTIONS.BOTH,
              priority: rank,
            }
          )
        );
        next.add(id);
        count++;
      }
    }
  }

  // Reconcile rather than clear-and-rebuild, so ids that survive keep their identity and a
  // scene with nothing changed does no deletion work at all.
  for (const id of owned) {
    if (!next.has(id)) canvas.edges.delete(id);
  }
  owned = next;

  lastStats = {
    ranks: [...byRank.keys()].sort(),
    rings: [...byRank.values()].reduce((n, rings) => n + rings.length, 0),
    // Sweeps cost time per edge, and every sight sweep on the scene pays it — this is the
    // number to watch if vision starts feeling slow.
    edges: count,
    ms: Math.round((performance.now() - t0) * 100) / 100,
  };

  // Vision only. Requesting lighting here would close the loop §8.3 warns about, and there is
  // no reason to: these edges are invisible to light sweeps.
  canvas.perception.update({ initializeVision: true, refreshVision: true });

  return lastStats;
}

/** Coalesce to one sync per frame; the driving hooks fire well above frame rate. */
export function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    sync();
  });
}

export function stats() {
  const report = lastStats ?? sync({ force: true });
  console.error("PF1 Lighting | umbra edges", report);
  return report;
}

export function registerHooks() {
  // The same set the renderer and overlay use, for the same reason: `initializeLightSources`
  // is the broad signal but deliberately does not fire for a light-bearing token moving
  // (`placeables/token.mjs:792-798`). Each is cheap because `field.get()` returns the same
  // object when nothing changed, and `sync` early-outs on that.
  for (const hook of [
    "initializeLightSources",
    "canvasReady",
    "refreshAmbientLight",
    "refreshToken",
  ]) {
    Hooks.on(hook, () => schedule());
  }

  Hooks.on("canvasTearDown", () => clear());
}
