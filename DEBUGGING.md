# Debugging PF1 Lighting

Reference for `game.pf1Lighting`, the module's console surface.

> `game.pf1Lighting` is a **debug** surface. It logs to `console.error`, its fields change whenever
> a diagnosis needs them, and several entries hand back live internal objects. Do not build a module
> on it — [API.md](API.md) is the half that promises not to move.

Console output is deliberately untranslated, whatever language the world is set to.

---

## Contents

- [Overlays](#overlays)
- [Probes](#probes)
- [Settings](#settings)
- [The model](#the-model)
- [Registry](#registry)
- [Field](#field)
- [The renderer](#the-renderer)
- [Vision, perception and umbra](#vision-perception-and-umbra)
- [Light spill and geodesic distance](#light-spill-and-geodesic-distance)
- [Regions, scenes, lights and presets](#regions-scenes-lights-and-presets)
- [Windows](#windows)
- [Performance](#performance)
- [Synthetic sources](#synthetic-sources)

---

## Overlays

| Function | What it does |
| --- | --- |
| `game.pf1Lighting.overlay.levels()` | Toggles the brightness map: every region the renderer draws from, coloured and labelled by tier, plus each light's two zones, each spill band, and the clamp count. Follows repaints. Console line reports counts by tier plus `lights`, `halos`, `clamps`, `spillBands` |
| `game.pf1Lighting.overlay.levels(false)` | Turns it off |
| `game.pf1Lighting.overlay.draw()` | Toggles the field-cell overlay: the model's cells coloured by **kind** rather than brightness. Persisted as a client setting |
| `game.pf1Lighting.overlay.draw(false)` | Turns it off |
| `game.pf1Lighting.overlay.toggle()` | Flips the persisted setting |
| `game.pf1Lighting.overlay.clear()` | Removes the drawing without changing the setting |
| `game.pf1Lighting.umbra.draw()` | Draws each observer's umbra regions, coloured by the tier each clamps to |
| `game.pf1Lighting.umbra.clear()` | Removes it |
| `game.pf1Lighting.geodesic.draw()` | Draws the spill ladder, flat per tier. Red hatch marks where light was told it may not pass; a break in the hatch is somewhere light gets through. Marches one aperture at a time, where `spill` marches one room |
| `game.pf1Lighting.geodesic.draw({ mode: "distance" })` | Draws the raw distance field the contour cuts |
| `game.pf1Lighting.geodesic.draw({ widths: { bright: 40, normal: 20, dim: 10 } })` | Draws it at other band widths |
| `game.pf1Lighting.geodesic.clear()` | Removes it |
| `game.pf1Lighting.geodesic.compare(...)` | Compares two ladders |

---

## Probes

| Function | What it does |
| --- | --- |
| `game.pf1Lighting.probe.at()` | Light level under the cursor, with the cells covering it, and marks the point |
| `game.pf1Lighting.probe.at(x, y)` | The same at a scene pixel coordinate |
| `game.pf1Lighting.probe.tokens()` | Light level at each selected token's centre |
| `game.pf1Lighting.probe.stack()` | Mixin order on the source classes, and live source counts |
| `game.pf1Lighting.probe.sources()` | Every emitter and suppressor with its resolved config |
| `game.pf1Lighting.probe.geometry()` | Origins, bounds and clip state of every source |
| `game.pf1Lighting.probe.darkness()` | Per suppressor: edges, strength, alpha, clip |
| `game.pf1Lighting.probe.vision()` | Per vision source: blinding, mode, radius, polygon, `shapePoints` |
| `game.pf1Lighting.probe.perception()` | From the selected token, why each other token is or is not visible — each term of the conjunction separately: tier, LOS, distance, and each detection mode |
| `game.pf1Lighting.probe.paintersAt()` | What is painting a point, as against what the model says |
| `game.pf1Lighting.probe.cellsAt()` | Which field cells cover a point, with each cell's `kind`, `tier` and `base` |
| `game.pf1Lighting.probe.reveals()` | Which of Foundry's reveal paths paints a point, per observer |
| `game.pf1Lighting.probe.mark()` | Marks a point on the canvas |
| `game.pf1Lighting.probe.clearMark()` | Removes the mark |

---

## Settings

The module owns around forty settings. Five have a row in the settings list and three more are edited
in their own windows; the rest are reachable only from here.

| Function | What it does |
| --- | --- |
| `game.pf1Lighting.settings()` | Every setting and its value, with `hidden: true` marked |
| `game.pf1Lighting.settings("renderEnabled")` | Reads one. An unknown key prints the full list |
| `game.pf1Lighting.settings("renderEnabled", true)` | Writes one |
| `game.pf1Lighting.settingsCache()` | Read-through cache state: hit rate, keys held, invalidations |
| `game.pf1Lighting.settingsCache.invalidate()` | Drops the cache; the next read re-fetches |

### Core

| Key | Default | What turning it off does |
| --- | --- | --- |
| `renderEnabled` | `true` | Stops drawing from the model; Foundry renders the scene its own way |
| `ambientTakeover` | `true` | The model no longer paints Foundry's darkness-level texture — a *darkness* on a lit map computes correctly and draws not at all |
| `perceptionEnabled` | `true` | What a creature can see goes back to Foundry's raw light polygons |
| `umbraPerception` | `true` | Light levels stop being observer-relative. Has a settings row — **Magical darkness casts shadows** |
| `disableNativeSuppression` | `true` | Foundry's own darkness suppression comes back, and light shines straight through a darkness because nothing re-applies suppression. Prerequisite for `renderEnabled` and `perceptionEnabled` (DESIGN.md §4.1.1) |

### Appearance

| Key | Default | Notes |
| --- | --- | --- |
| `tierLevelBright` / `tierLevelNormal` / `tierLevelDim` / `tierLevelDark` | evenly spaced | *Configure Visuals* → **Darkness levels**; should descend in brightness |
| `transitionWidth` | `0.75` | *Configure Visuals* → **Brightness transition width**. Grid squares; one width for every brightness boundary. `0` = hard edges everywhere |
| `unseenDimming` | `0.2` | *Configure Visuals* → **Unseen ground dimming** (Foundry hard-codes 0.5) |
| `darkSightBrightness` | — | *Configure Visuals* → **See-in-darkness brightness**. Negative dims it back toward normal vision |
| `edgeSoftness` | `0.05` | Console only. A light's own colour edge. Inert below Medium performance mode, and never applies to an unobstructed circular light |
| `darknessSoftness` | `0.5` | Console only. The rim of a *supernatural* darkness disc. A fixed distance, so a large darkness looks harder-edged than a small one |
| `blurTransitions` | `true` | One blur of the whole field, versus a gradient per region |
| `sharpWalls` | `true` | Holds the field sharp along any wall that blocks light, so a lit room does not glow through its own walls |

### Behaviour

| Key | Default | Notes |
| --- | --- | --- |
| `absoluteLightLevels` | `true` | A light's zones painted at the same brightness the ground would be at that tier, rather than relative to what they land on |
| `lightsInTexture` | `true` | Lights drawn as brightness regions rather than as Foundry's radial falloff |
| `regionalGreyscale` | `true` | Darkvision greys only where the model says it is dark, rather than the whole canvas |
| `greyscaleInFog` | — | `0` = remembered terrain keeps its colour, `1` = treated like ground in view |
| `hideUnseenGround` | `true` | Ground the viewer cannot see is drawn Dark |
| `softClamps` | `true` | The umbra and the edge of vision fade in rather than stepping |
| `maskDarknessByVision` | `true` | A darkness source is withheld outside vision, the way a light already is |
| `fogIgnoresModel` | `true` | Unseen ground reads at one fixed brightness instead of reproducing the model |
| `darknessAnimationStrength` | `true` | Draws an ordinary darkness faintly so a chosen animation has a surface to run on. Costs an extra mesh per lit area it crosses |
| `showStackedOverlaps` | `false` | Draws two lights' overlapping outer bands a step brighter. The overlap is computed either way |
| `desaturateDarkness` | — | Fallback greyscale path; does nothing while `regionalGreyscale` is on |
| `guardNegativeLowLight` | — | Stops PF1's low-light multiplier doubling the radius of darkness sources |
| `readoutEnabled` | `false` | Client. The light-level chip beside the cursor; also on a keybinding |
| `readoutGmOnly` | `false` | World. Withholds the chip from non-GM users |
| `readoutDetail` | `true` | World. Whether the chip explains itself — *reduced from normal*, *seen through darkness* |
| `spillEnabled`, `spillRadiusBright/Normal/Dim`, `spillCellSize` | 40 / 20 / 10 ft | Also in *Configure Light Spill* |
| `presetTable` | `{}` | The preset table, edited in *Edit Presets* |
| `cellOverlay` | `false` | The field-cell overlay's persisted state |

---

## The model

| Function | What it does |
| --- | --- |
| `game.pf1Lighting.evaluate(canvas.mousePosition)` | The model's one query: `{ B, tier, tierName, baseline, baselineTier, emitters, suppressors, winner, applied, negated }`. God's-eye only — observer resolution is layered on in `perception`/`umbra` |
| `game.pf1Lighting.gatherEmitters(point)` | The emitters reaching a point, with their contributions |
| `game.pf1Lighting.gatherSuppressors(point)` | The suppressors covering a point |
| `game.pf1Lighting.contest(emitters, suppressors)` | Resolves a set of emitters against a set of suppressors |
| `game.pf1Lighting.brightnessAt(point)` | Brightness alone, 0..1 |
| `game.pf1Lighting.contributionAt(...)` | What one source contributes at a point |
| `game.pf1Lighting.emissionOf(...)` | A source's resolved emission — set tier, radii, steps, cap |
| `game.pf1Lighting.stackEmitters(emitters)` | Stacks emitters: set levels contend, relative bands sum. Takes the shape `evaluate().emitters` returns |
| `game.pf1Lighting.tiers` | The tier module — constants, names, thresholds, the darkness table |

---

## Registry

A resolved snapshot of everything on the scene that affects light level, between Foundry's source
collections and the model. Rebuilds lazily on a dirty flag; `version()` bumps on each rebuild and is
the cache key for anything derived from it.

| Function | What it does |
| --- | --- |
| `game.pf1Lighting.registry.stats()` | Counts, generation, dirty flag |
| `game.pf1Lighting.registry.emitters()` | Resolved emitters with kind, level and emission |
| `game.pf1Lighting.registry.suppressors()` | Resolved suppressors with level, transform, floor, eligibility |
| `game.pf1Lighting.registry.emittersAt(canvas.mousePosition)` | Those reaching a point |
| `game.pf1Lighting.registry.suppressorsAt(canvas.mousePosition)` | Those covering a point |
| `game.pf1Lighting.registry.version()` | The current generation number |
| `game.pf1Lighting.registry.invalidate()` | Forces a rebuild on next read |

---

## Field

The whole-scene cell decomposition — what the renderer consumes. Cells partition space by treatment
(which suppressor applies), and each is a simple hole-free polygon.

| Function | What it does |
| --- | --- |
| `game.pf1Lighting.field.stats()` | Counts, Clipper ops, ms. `grounds` counts the distinct ground tiers the map resolved into, regions included; `domains` counts only §10.7 ambient areas. No cells returned |
| `game.pf1Lighting.field.get()` | The cached field; recomputed when the registry changes |
| `game.pf1Lighting.field.compute({ filter: false })` | Recomputes without the bounds pre-filter. Identical cells |
| `game.pf1Lighting.field.explain()` | Per region: breakers and area carved. Per emitter: area lost |
| `game.pf1Lighting.field.invalidate()` | Drops the cache |

| Cell kind | Geometry | Renders as |
| --- | --- | --- |
| `clip` | emitter minus everything eligible to block it | the real source, clipped |
| `dark` | the whole suppressor region | the ground, at the tier the suppressor reduced it to |
| `ambient` | the scene minus every suppressor region | the scene's own tier |
| `stack` | where two or more relative bands overlap | nothing, unless `showStackedOverlaps` is on |

`base` on a cell is the ground tier it stands on, and a darkness region is one of those (DESIGN.md
§4.1.1a). `reduced` was a fifth kind, retired 2026-08-29.

---

## The renderer

| Function | What it does |
| --- | --- |
| `game.pf1Lighting.render.rebuild()` | Forces a rebuild |
| `game.pf1Lighting.render.stats()` | Timings and cell counts from the last one. `painted > 0` means the model is reaching the screen |
| `game.pf1Lighting.render.reset()` | Drops all clips and restores stock Foundry rendering |
| `game.pf1Lighting.render.pool()` | The synthetic-source pool |
| `game.pf1Lighting.render.repaint()` | Forces one repaint |
| `game.pf1Lighting.render.paint()` | Per-stage cost of the last repaint, plus `fieldStable` — `true` when the repaint was triggered by an observer moving rather than by the scene changing. Also reports the observer's shadow: tiers found, cells cut, cost |

### The darkness-level texture

| Function | What it does |
| --- | --- |
| `game.pf1Lighting.render.ambient()` | Whether global-illumination takeover is live, and whether this scene gives it anything to do |
| `game.pf1Lighting.render.texture()` | What is painted, and the level under the cursor |
| `game.pf1Lighting.render.meshAt()` | Which mesh claims a point, and what the rendered texture says there. The two can disagree — the JS query is a ring test, the shaders sample the rasterised result |
| `game.pf1Lighting.render.transect()` | Whether the edge under the cursor is a step in the field or a ramp |
| `game.pf1Lighting.render.isolate("coloration")` | Hides every layer but one. Also `"darkness"`, `"lights"`, `"visibility"`. Nothing is recomputed |
| `game.pf1Lighting.render.isolate()` | Restores every layer |
| `game.pf1Lighting.render.noErase(true)` | Suppresses the `ERASE` mesh every region darker than Dim adds to the visibility mask. With it off, a *darkness* on a globally-lit map stops being dark |
| `game.pf1Lighting.render.noErase(false)` | Puts it back |

### Brightness ladder and transitions

| Function | What it does |
| --- | --- |
| `game.pf1Lighting.render.gradient()` | Ground, light and clamp meshes, and the per-light cache. `ramps` below `spill.stats().windows` means a window failed to triangulate and is painted flat; `sortLevels` says each mesh landed below the ordinary ground cells |
| `game.pf1Lighting.render.regradient()` | Rebuilds them |
| `game.pf1Lighting.render.zones()` | Every light's zones in luminance, against the ladder — whether Normal is the same brightness in a dim room as in a dark one |
| `game.pf1Lighting.render.transitionWidth()` | The width in force, in pixels and grid squares |
| `game.pf1Lighting.render.blur()` | Whether the field takes one blur or a gradient per region. `sharpWalls: true` with `wall.segments: 0` on a walled scene means every edge reported `light === NONE` |
| `game.pf1Lighting.render.walls()` | The segments the blur is held off, and the band width |
| `game.pf1Lighting.render.soften()` | Source edges, and whether Foundry is honouring them. `softEdgesAvailable: false` means the performance mode is below Medium |
| `game.pf1Lighting.render.levels("bands")` | Swaps in the tier-ceiling ladder — dark scenes stay dark. Rebuilds immediately, persists nothing |
| `game.pf1Lighting.render.levels("even")` | Swaps in the ladder where Supernatural Dark gets its own level |
| `game.pf1Lighting.render.levels(null)` | Reloads the four `tierLevel*` settings |
| `game.pf1Lighting.render.presets()` | The ladders on offer |

### Masking and greyscale

| Function | What it does |
| --- | --- |
| `game.pf1Lighting.render.darknessMask()` | Whether both masks are in force, and why they might not be. `applied: true` with `enableVisionMasking: false` is a scene with **Token Vision** off |
| `game.pf1Lighting.render.greyscale()` | Whether it is running and what the ramp resolved to. Takes a point, defaulting to the cursor, and reports `pixel`, the rasterised level the filter samples there. Every entry under `routes` should read zero or empty |
| `game.pf1Lighting.render.darknessGates()` | Every gate between a darkness source and its animation reaching the screen |

---

## Vision, perception and umbra

| Function | What it does |
| --- | --- |
| `game.pf1Lighting.perception.status()` | Whether the layer is live, and which detection modes are patched |
| `game.pf1Lighting.perception.isEnabled()` | The switch alone |
| `game.pf1Lighting.perception.sees(point)` | Whether ordinary sight works at a point |
| `game.pf1Lighting.perception.darkvisionSees(point)` | The same for darkvision |
| `game.pf1Lighting.perception.tierAt(point, source)` | The tier at a point as one observer sees it |
| `game.pf1Lighting.perception.viewerTier()` | The tier as the current view sees it — what the readout reports |
| `game.pf1Lighting.perception.blinds(source)` | Whether the model blinds this vision source |
| `game.pf1Lighting.perception.darkSightRange(source)` | The observer's light-independent sight range |
| `game.pf1Lighting.perception.refresh()` | Re-runs perception |

### Umbra

| Function | What it does |
| --- | --- |
| `game.pf1Lighting.umbra.stats()` | Regions, tiers present, edge count, rebuild cost. `rebuildMs` is the cold path by construction |
| `game.pf1Lighting.umbra.cache()` | The per-observer cache — the path `perceivedTier` actually calls |
| `game.pf1Lighting.umbra.clampAt(point, observer)` | The tier a point is clamped to for one observer, or `null` |
| `game.pf1Lighting.umbra.regionsFor(observer)` | That observer's regions, cached |
| `game.pf1Lighting.umbra.for(observer)` | The same, rebuilt |
| `game.pf1Lighting.umbra.all()` | Every observer's regions, rebuilt |
| `game.pf1Lighting.umbra.edges()` | The sight-blocking edges emitted for Supernatural Dark |
| `game.pf1Lighting.umbra.resync()` | Forces those edges to be rebuilt |
| `game.pf1Lighting.umbra.mask()` | The mask that withholds the reveal below `SIGHT_TIER` |
| `game.pf1Lighting.umbra.isEnabled()` | The switch alone |
| `game.pf1Lighting.umbra.invalidate()` | Drops the cache |

### Observer

| Function | What it does |
| --- | --- |
| `game.pf1Lighting.observer.status()` | Resolved observer mode, and each token's verdict |
| `game.pf1Lighting.observer.toggle()` | Toggles GM observer mode — same as Alt+O |
| `game.pf1Lighting.observer.isGmObserverMode()` | The current mode |
| `game.pf1Lighting.observer.refresh()` | Re-resolves it |

### Native suppression

| Function | What it does |
| --- | --- |
| `game.pf1Lighting.suppression.isDisabled()` | Whether Foundry's own darkness suppression is stood down |
| `game.pf1Lighting.suppression.reinitialise()` | Re-applies the current setting to every source |

---

## Light spill and geodesic distance

| Function | What it does |
| --- | --- |
| `game.pf1Lighting.spill.stats()` | Windows found, rooms marched, bands drawn, and why there might be none |
| `game.pf1Lighting.spill.at({ x: 1000, y: 1200 })` | Which bands cover a point |
| `game.pf1Lighting.spill.list()` | Every band |
| `game.pf1Lighting.spill.rebuild()` | Forces a rebuild |
| `game.pf1Lighting.spill.config()` | Opens *Configure Light Spill* |
| `game.pf1Lighting.geodesic.fill(...)` | The flood fill behind the ladder |
| `game.pf1Lighting.geodesic.ladder(...)` | The tier ladder derived from a distance field |
| `game.pf1Lighting.geodesic.cellSize()` | The marching cell size in pixels |

Spill requires `ambientTakeover`, the scene's global illumination, and a sky brighter than the room.
Drawing functions are under [Overlays](#overlays).

---

## Regions, scenes, lights and presets

| Function | What it does |
| --- | --- |
| `game.pf1Lighting.areas.status()` | Every ambient area, whether the behaviour is `declared` (the module.json half — needs a world relaunch, not an F5), and whether an area can change the picture, which needs `ambientTakeover` |
| `game.pf1Lighting.areas.list()` | The areas alone |
| `game.pf1Lighting.areas.tierAt(point)` | The ambient tier at a point |
| `game.pf1Lighting.areas.invalidate()` | Drops the cache |
| `game.pf1Lighting.render.scenes()` | Which scenes carry a tier, and whether their stored darkness matches it. `matches: false` on an unlocked scene means the sync did not run |
| `game.pf1Lighting.render.resyncScenes()` | Forces that pass |
| `game.pf1Lighting.render.setSceneTier(2)` | Sets the current scene's tier — 4 Bright, 3 Normal, 2 Dim, 1 Dark. What the lighting-control buttons do |
| `game.pf1Lighting.render.lights()` | Which lights carry an activation range, and whether their stored numbers match it |
| `game.pf1Lighting.render.resyncLights()` | Forces that pass |
| `game.pf1Lighting.presets.table()` | Every preset and its values, as currently configured |
| `game.pf1Lighting.presets.builtIn` | The module's own table, whatever this world has done |
| `game.pf1Lighting.presets.apply("deeperDarkness")` | The flat update a light document wants — `light.document.update(game.pf1Lighting.presets.apply("deeperDarkness"))` |
| `game.pf1Lighting.presets.choices()` | Name/label pairs for a dropdown |
| `game.pf1Lighting.presets.label(name)` | One preset's label |
| `game.pf1Lighting.presets.status()` | `customised: false` means this world still tracks the module's table |
| `game.pf1Lighting.presets.edit()` | Opens *Edit Presets* |
| `game.pf1Lighting.presets.reset()` | Back to the built-ins |

Two model inputs have no control: which lights a darkness extinguishes rather than merely dims, and
whether a magical darkness casts an umbra. Both follow from the rules and remain settable through the
`pf1-lighting.config` flag.

---

## Windows

| Function | What it does |
| --- | --- |
| `game.pf1Lighting.render.visuals()` | Opens *Configure Visuals* |
| `game.pf1Lighting.spill.config()` | Opens *Configure Light Spill* |
| `game.pf1Lighting.presets.edit()` | Opens *Edit Presets* |

---

## Performance

Target is a full field recompute inside 16 ms (DESIGN.md §9.1).

| Function | What it does |
| --- | --- |
| `game.pf1Lighting.spike.bench(fn, { label })` | Warms up, then reports the median of repeated runs |
| `game.pf1Lighting.spike.compare({ a: fn, b: fn })` | Runs its cases round-robin, so none absorbs the others' warm-up |
| `game.pf1Lighting.spike.churn()` | Times source construction: 30 sources × 20 cycles, all modes |
| `game.pf1Lighting.spike.churn({ count: 60 })` | The same at another source count |
| `game.pf1Lighting.spike.churn({ modes: ["direct"] })` | One mode only |
| `game.pf1Lighting.spike.churn({ softEdges: false })` | Isolates `PolygonMesher`'s cost |
| `game.pf1Lighting.spike.subdivide()` | Times the polygon boolean algebra that decides which source applies where (DESIGN.md §6.1), against the scene's real swept polygons. 20 iterations, all modes |
| `game.pf1Lighting.spike.subdivide({ radius: 20 })` | The same with a wide suppressor |
| `game.pf1Lighting.spike.subdivide({ suppressors: 4, bands: 2 })` | The same at another shape count |
| `game.pf1Lighting.spike.subdivide({ modes: ["tight"] })` | One mode only |
| `game.pf1Lighting.spike.emitterPaths()` | The emitter paths the harness would use |
| `game.pf1Lighting.spike.suppressorPaths()` | The suppressor paths the harness would use |

### `churn` modes

| Mode | What it measures |
| --- | --- |
| `sweep` | Foundry's normal path — what a real placed light costs |
| `constrain` | Sweep, then narrow with Clipper — the cost of clipping a real source |
| `direct` | Supply the polygon, skip the sweep — the cost of a synthetic fill |
| `reuse` | Re-`initialize()` a fixed pool — isolates construction from geometry |

### `subdivide` modes

| Mode | What it measures |
| --- | --- |
| `naive` | No pre-filter — every emitter clipped, fill unioned over all emitters |
| `filtered` | One box around the whole suppressor union |
| `tight` | One box per union ring, plus a per-band test before each intersection |

Every mode produces the same cell count; the harness warns if one does not. Each gets 5 untimed
warm-up iterations, and numbers are comparable within one invocation, not across page loads.

`subdivide` also reports **`annuli`**, cells with a hole from a suppressor sitting wholly inside an
emitter, each of which needs splitting before it can be rendered; and **`extra paths`**, results with
more than one path, which is the number of cells `PIXI.Polygon#intersectPolygon` would silently have
lost. Ceiling is ~8 ms — the 16 ms frame budget less ~3 ms of pooled source construction for 60
sources (DESIGN.md §9.5).

---

## Synthetic sources

Document-less light sources with optionally injected polygons — the mechanism the renderer design
depends on.

| Function | What it does |
| --- | --- |
| `game.pf1Lighting.spike.spawn({ id: "a", ...canvas.mousePosition, dim: canvas.grid.size * 6 })` | A plain synthetic light |
| `game.pf1Lighting.spike.spawn({ id: "b", ...canvas.mousePosition, dim: canvas.grid.size * 6, constrainTo: new PIXI.Circle(canvas.mousePosition.x, canvas.mousePosition.y, canvas.grid.size * 3) })` | The same light, sweep narrowed to a given shape |
| `game.pf1Lighting.spike.list()` | Every synthetic source |
| `game.pf1Lighting.spike.refresh()` | Re-initialises them |
| `game.pf1Lighting.spike.ngon(...)` | Builds a regular polygon to constrain with |
| `game.pf1Lighting.spike.destroy("a")` | Removes one |
| `game.pf1Lighting.spike.clear()` | Removes all |
| `game.pf1Lighting.spike.darknessBands()` | Paints test bands into the darkness-level texture |
| `game.pf1Lighting.spike.darknessPaint()` | Paints a test region |
| `game.pf1Lighting.spike.darknessAt()` | The level the texture holds at a point |
| `game.pf1Lighting.spike.darknessClear()` | Clears the test paint |

---

## See also

- [README.md](README.md) — what the module does, for a GM
- [API.md](API.md) — the supported surface for other modules
- DESIGN.md — the full design record, and the section numbers referenced above
