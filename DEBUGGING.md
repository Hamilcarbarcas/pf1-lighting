# Debugging PF1 Lighting

Everything here is reached from the browser console (**F12**), through `game.pf1Lighting`. None of
it is needed to play; it is the surface for working out why a map does not look the way you expect.

> `game.pf1Lighting` is a **debug** surface. It logs to `console.error`, its fields change whenever
> a diagnosis needs them, and several entries hand back live internal objects. Do not build a module
> on it — [API.md](API.md) is the half that promises not to move.

Console output is deliberately untranslated, whatever language the world is set to.

---

## Contents

- [Start here: is it the model or the picture?](#start-here-is-it-the-model-or-the-picture)
- [Overlays](#overlays)
- [Probes](#probes)
- [Settings, including the hidden ones](#settings-including-the-hidden-ones)
- [The model](#the-model)
- [The renderer](#the-renderer)
- [Vision, perception and umbra](#vision-perception-and-umbra)
- [Light spill and geodesic distance](#light-spill-and-geodesic-distance)
- [Regions, presets and scenes](#regions-presets-and-scenes)
- [Performance](#performance)
- [Synthetic sources](#synthetic-sources)
- [Recipes](#recipes)

---

## Start here: is it the model or the picture?

Almost every question about this module resolves to one of two: *the model computed the wrong
level*, or *the model was right and the renderer drew something else*. They look identical on
screen and nothing else will tell them apart.

```js
game.pf1Lighting.overlay.levels()
```

That draws the brightness map — every region the renderer is drawing from, coloured and labelled by
tier, plus each light's two zones, each spill band, and the count of clamps. It follows a repaint,
so it stays correct while you drag a token or a light.

**If a transition on screen is not sitting on a line in this overlay, the renderer invented it.**

The console line beside it reports counts by tier plus `lights`, `halos`, `clamps` and `spillBands`.
Zero `lights` with torches on the map means lights are not being drawn as brightness regions, so
Foundry is drawing them its own way and this overlay is describing a different picture from the one
on screen.

Both overlays take the same argument — call bare to toggle, pass `false` to turn off:

```js
game.pf1Lighting.overlay.levels(false)
```

---

## Overlays

### Brightness map

```js
game.pf1Lighting.overlay.levels()        // toggle
game.pf1Lighting.overlay.levels(false)
```

What the renderer painted. See above.

### Field cells

```js
game.pf1Lighting.overlay.draw()          // toggle
game.pf1Lighting.overlay.draw(false)
game.pf1Lighting.overlay.toggle()
game.pf1Lighting.overlay.clear()
```

An older, narrower view: the model's cells coloured by **kind** rather than by brightness — blue for
unsuppressed light, orange for reduced, violet for darkness fill. It answers *how did the field get
subdivided*, where the brightness map answers *what is being painted*. Comparing the two is how you
tell a model fault from a drawing one — a tier present here and absent there was lost between the
field and the picture.

This one is a persisted client setting underneath, unlike `levels()`.

### Umbra regions

```js
game.pf1Lighting.umbra.draw()
game.pf1Lighting.umbra.clear()
```

Coloured by the tier each region clamps to.

### Geodesic distance field

```js
game.pf1Lighting.geodesic.draw()                       // the ladder, flat per tier
game.pf1Lighting.geodesic.draw({ mode: "distance" })   // the raw field the contour cuts
game.pf1Lighting.geodesic.draw({ widths: { bright: 40, normal: 20, dim: 10 } })
game.pf1Lighting.geodesic.clear()
game.pf1Lighting.geodesic.compare(...)
```

The one to reach for when light spill looks wrong, because it shows the working rather than the
answer. **Red marks where light was told it may not pass**: a continuous red hatch along a wall is
that wall sealed, and a break in the hatch is somewhere light gets through — a doorway when you meant
one, a mis-drawn wall when you did not.

It marches one aperture at a time, where `spill` marches one room. That is deliberate: per-window is
what you want when the question is *what is this window doing*, and the two agree wherever a room has
a single window.

---

## Probes

```js
game.pf1Lighting.probe.at()          // light level under the cursor
game.pf1Lighting.probe.at(x, y)      // at a scene pixel coordinate
game.pf1Lighting.probe.tokens()      // at each selected token's centre
game.pf1Lighting.probe.stack()       // mixin order on the source classes, live source counts
game.pf1Lighting.probe.sources()     // every emitter and suppressor with its resolved config
game.pf1Lighting.probe.geometry()    // origins, bounds and clip state of every source
game.pf1Lighting.probe.darkness()    // per suppressor: edges, strength, alpha, clip
game.pf1Lighting.probe.vision()      // per vision source: blinding, mode, radius, polygon
game.pf1Lighting.probe.perception()  // from the selected token: why each other token is or isn't visible
game.pf1Lighting.probe.paintersAt()  // what is painting a point, as against what the model says
game.pf1Lighting.probe.cellsAt()     // which field cells cover a point
game.pf1Lighting.probe.reveals()     // which of Foundry's reveal paths paints a point, per observer
game.pf1Lighting.probe.mark()
game.pf1Lighting.probe.clearMark()
```

`probe.perception()` reports each term of the visibility conjunction separately — tier, LOS, distance,
and each of the observer's detection modes independently — because they all fail identically on
screen: the token is simply not there.

`probe.reveals()` is for *this terrain is the wrong colour or brightness*, as against *the wrong tier*.

**These exist because reading Foundry's source repeatedly produced plausible mechanisms that turned
out not to be the cause.** When a symptom survives a fix, reach for these before theorising again —
and check the *symptom*, not the thing you just changed. `probe.vision()` once reported a source that
was not blinded, in the right vision mode, with radius 1250 and active, that could see exactly one
square; the giveaway was `shapePoints: 16`, which had been in the output the whole time.

---

## Settings, including the hidden ones

The module owns around forty settings. Five have a row in the settings list and three more are edited
in their own windows; the rest are reachable only from here.

```js
game.pf1Lighting.settings()                        // every setting, with hidden: true marked
game.pf1Lighting.settings("renderEnabled")         // read one
game.pf1Lighting.settings("renderEnabled", true)   // write one
```

An unknown key prints the full list of known ones.

The switches that used to gate the renderer, the global-illumination model and the perception layer
were there to bisect problems during development; the rows are gone rather than the switches, because
a switch whose value is *"the module works"* is not a preference. **A world that explicitly turned one
off before that change keeps it off, so this is the first place to look if the module appears to do
nothing.**

### The load-bearing ones

| Key | Default | What turning it off does |
| --- | --- | --- |
| `renderEnabled` | `true` | Stops drawing from the model; Foundry renders the scene its own way |
| `ambientTakeover` | `true` | The model no longer paints Foundry's darkness-level texture — a *darkness* on a lit map computes correctly and draws not at all |
| `perceptionEnabled` | `true` | What a creature can see goes back to Foundry's raw light polygons |
| `umbraPerception` | `true` | Light levels stop being observer-relative. This is the one with a settings row — **Magical darkness casts shadows** |
| `disableNativeSuppression` | `true` | Foundry's own darkness suppression comes back — see below |

**`disableNativeSuppression` on its own makes darkness appear not to work**: light shines straight
through, because nothing is re-applying suppression. It stands down five things Foundry does with
darkness that the model has to own instead (DESIGN.md §4.1.1), and it is the prerequisite for both
`renderEnabled` and `perceptionEnabled`.

### Appearance

| Key | Default | Notes |
| --- | --- | --- |
| `tierLevelBright` / `tierLevelNormal` / `tierLevelDim` / `tierLevelDark` | evenly spaced | *Configure Visuals* → **Darkness levels**; should descend in brightness |
| `transitionWidth` | `0.75` | *Configure Visuals* → **Brightness transition width**. Grid squares; one width for every brightness boundary. `0` = hard edges everywhere |
| `unseenDimming` | `0.2` | *Configure Visuals* → **Unseen ground dimming** (Foundry hard-codes 0.5) |
| `darkSightBrightness` | — | *Configure Visuals* → **See-in-darkness brightness**. Negative dims it back toward normal vision |
| `edgeSoftness` | `0.05` | Console only. A **light's own colour edge**. Inert below Medium performance mode, and never applies to an unobstructed circular light |
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
| `showStackedOverlaps` | `false` | Draws two lights' overlapping outer bands a step brighter. The overlap is **computed** either way |
| `desaturateDarkness` | — | Fallback greyscale path; does nothing while `regionalGreyscale` is on |
| `guardNegativeLowLight` | — | Stops PF1's low-light multiplier doubling the radius of darkness sources |
| `spillEnabled`, `spillRadiusBright/Normal/Dim`, `spillCellSize` | 40 / 20 / 10 ft | Also in *Configure Light Spill* |
| `presetTable` | `{}` | The preset table, edited in *Edit Presets* |
| `cellOverlay` | `false` | The field-cell overlay's persisted state |

### Going back to Foundry's rendering

In increasing order of how much it puts back:

```js
game.pf1Lighting.settings("lightsInTexture", false)      // radial falloff again, levels still fixed
game.pf1Lighting.settings("absoluteLightLevels", false)  // relative brightening as well
game.pf1Lighting.settings("regionalGreyscale", false)    // whole-canvas darkvision greyscale
game.pf1Lighting.render.reset()                          // drop all clips, stock rendering
```

### The settings cache

Every setting read on a hot path goes through a read-through cache, because Foundry implements
`game.settings.get` as a linear scan of every Setting document in the world — 14.7 µs a call.

```js
game.pf1Lighting.settingsCache()            // hit rate, keys held, invalidations
game.pf1Lighting.settingsCache.invalidate() // drop it; the next read re-fetches
```

A `hitRate` well below 1 means something is bypassing it. `invalidations` climbing while nobody is
touching settings is the other failure worth seeing — either turns the cache into pure overhead, and
neither shows up in a timing.

---

## The model

`evaluate(point)` is the model's one query: what is the light level here, and why.

```js
game.pf1Lighting.evaluate(canvas.mousePosition)
// → { B, tier, tierName, emitters, suppressors, winner, cancelled }
```

It answers the **god's-eye** question only. Observer resolution is layered on top in
`perception`/`umbra` rather than here.

```js
game.pf1Lighting.gatherEmitters(point)
game.pf1Lighting.gatherSuppressors(point)
game.pf1Lighting.contest(...)
game.pf1Lighting.brightnessAt(point)
game.pf1Lighting.contributionAt(...)
game.pf1Lighting.emissionOf(...)
game.pf1Lighting.stackEmitters(emitters)   // set levels contend, relative bands sum
game.pf1Lighting.tiers                     // the tier module
```

`stackEmitters` takes the same shape `evaluate().emitters` returns, so a suspect reading can be
re-run by hand.

### Registry

A resolved snapshot of everything on the scene that affects light level, sitting between Foundry's
source collections and the model.

```js
game.pf1Lighting.registry.stats()         // counts, generation, dirty flag
game.pf1Lighting.registry.emitters()      // resolved emitters with kind/level/emission
game.pf1Lighting.registry.suppressors()
game.pf1Lighting.registry.emittersAt(canvas.mousePosition)
game.pf1Lighting.registry.suppressorsAt(canvas.mousePosition)
game.pf1Lighting.registry.version()
game.pf1Lighting.registry.invalidate()    // force a rebuild on next read
```

It rebuilds **lazily on a dirty flag** rather than on a debounce: hooks mark it stale and the next
read rebuilds. Bursts coalesce for free, there is no timing constant to tune, and no window in which
a read returns stale data. `version()` bumps on each rebuild and is the cache key for anything
derived from it.

### Field

The whole-scene cell decomposition — what the renderer consumes. Cells partition space by *treatment*
(which suppressor applies), and each is a simple hole-free polygon.

```js
game.pf1Lighting.field.stats()                      // counts, ops, ms — no cells returned
game.pf1Lighting.field.get()                        // cached; recomputed when the registry changes
game.pf1Lighting.field.compute({ filter: false })   // no pre-filter; identical cells
game.pf1Lighting.field.explain()                    // per region: breakers, area carved; per emitter, area lost
game.pf1Lighting.field.invalidate()
```

| Cell kind | Geometry | Renders as |
| --- | --- | --- |
| `clip` | emitter minus everything eligible to block it | the real source, clipped |
| `reduced` | emitter ∩ suppressor region | the same source at a lowered light level |
| `dark` | suppressor region minus all light | flat fill, Supernatural Dark |
| `ambient` | the scene minus every suppressor region | the scene's own tier |
| `stack` | where two or more relative bands overlap | nothing, unless `showStackedOverlaps` is on |

`reduced` cells keep their gradient: reducing a tier lowers the light's *set level* and leaves its
radii alone, so a torch inside a *darkness* still falls off from the flame rather than becoming a
uniform disc. See DESIGN.md §3.2.1.

---

## The renderer

```js
game.pf1Lighting.render.rebuild()   // force a rebuild
game.pf1Lighting.render.stats()     // timings and cell counts from the last one
game.pf1Lighting.render.reset()     // drop all clips, restore stock rendering
game.pf1Lighting.render.pool()      // the synthetic-source pool
```

`stats().painted > 0` means the model is reaching the screen.

### Where the time goes

```js
game.pf1Lighting.render.paint()          // per-stage cost of the last repaint
game.pf1Lighting.settingsCache()         // hit rate, keys held, invalidations
game.pf1Lighting.render.repaint()        // force one
```

`paint()` reports a `stage` breakdown per pass and `fieldStable`, which is `true` whenever a repaint
was triggered by an observer moving rather than by the scene changing — everything but `shadows` and
`clamps` should then be near zero.

It also reports the observer's shadow: tiers found, cells cut, cost. `shadows > 0, split: 0` means the
umbra is real and every cell it lands on was already at or below the clamp.

### The darkness-level texture

```js
game.pf1Lighting.render.ambient()    // is global-illumination takeover live, and does this scene give it anything to do
game.pf1Lighting.render.texture()    // what is painted, and the level under the cursor
game.pf1Lighting.render.meshAt()     // which mesh claims a point, and what the rendered texture says there
game.pf1Lighting.render.transect()   // is this edge hard in the field, or is another layer drawing over it?
game.pf1Lighting.render.isolate("coloration" | "darkness" | "lights" | "visibility")
```

`meshAt` and the texture can disagree — the JS query is a ring test, the shaders sample the rasterised
result.

**`transect()` then `isolate()` is the sequence for "why is this edge visible".** Hover the edge and
call `transect()`: a ramp means the field is smooth and the culprit is elsewhere (a light's coloration,
a darkness source's own disc, the visibility mask); a step means the blur is not reaching that
boundary. Once the field is known smooth, `isolate()` toggles one layer's visibility to say which one
owns the edge. No argument restores everything; nothing is recomputed, so it leaves no trace.

### Brightness ladder and transitions

```js
game.pf1Lighting.render.gradient()          // ground, light and clamp meshes, and the per-light cache
game.pf1Lighting.render.regradient()
game.pf1Lighting.render.zones()             // every light's zones in luminance, against the ladder
game.pf1Lighting.render.transitionWidth()
game.pf1Lighting.render.blur()              // one blur of the field, or a gradient per region
game.pf1Lighting.render.walls()             // the segments the blur is held off, and the band width
game.pf1Lighting.render.soften()            // source edges, and whether Foundry is honouring them
```

`render.zones()` is the one readout that answers *is Normal the same brightness in a dim room as in a
dark one*, which the map itself cannot be asked.

`render.gradient()`: `ramps` below `spill.stats().windows` means a window failed to triangulate and is
being painted flat. `sortLevels` proves each mesh landed below the ordinary ground cells, which is what
lets the umbra clamp overpaint it instead of having to cut it.

`render.blur()`: `sharpWalls: true` with `wall.segments: 0` on a walled scene means every edge reported
`light === NONE` and there is nothing to protect.

`render.soften()`: `softEdgesAvailable: false` means the performance mode is below Medium and the light
half does nothing whatever the setting says.

### Trying a whole tier ladder against a live map

```js
game.pf1Lighting.render.levels("bands")   // tier ceilings — dark scenes stay dark
game.pf1Lighting.render.levels("even")    // Supernatural Dark gets its own level
game.pf1Lighting.render.levels(null)      // back to the four saved settings
game.pf1Lighting.render.presets()         // the tables on offer
```

Rebuilds immediately and persists **nothing**. The four `tierLevel*` settings are the stored answer, and
`null` reloads them — an experiment is always one call from being undone. Changing any of those settings
also overwrites whatever was tried here.

### Masking and greyscale

```js
game.pf1Lighting.render.darknessMask()   // whether both masks are in force, and why they might not be
game.pf1Lighting.render.greyscale()      // is it running, and what the ramp resolved to
game.pf1Lighting.render.darknessGates()  // every gate between a darkness source and its animation reaching the screen
```

`darknessMask()` reporting `applied: true` with `enableVisionMasking: false` is a scene with **Token
Vision** switched off — Foundry disables every such mask there, and this one goes with them.

`greyscale()` takes a point (defaults to the cursor) and reports `pixel`, the **rasterised** level the
filter itself samples there — which is what separates *the greyscale is wrong* from *the field is
wrong*. Every entry under `routes` should read zero or empty; anything else is a second thing
desaturating.

`darknessGates()` was written for a report that two senses taking the same code path behaved
differently. Run it with each token selected and compare; the field that differs is the answer.

### The hard rim on a darkness disc

```js
game.pf1Lighting.render.noErase(true)    // then look
game.pf1Lighting.render.noErase(false)   // put it back
```

Every region darker than Dim also gets an `ERASE` mesh in the **visibility** mask, whose boundary is
binary and lives in a different container from the brightness — so the field blur cannot reach it.
Turn it off and repaint: if the rim softens, that boundary is the cause.

Not a setting, because with it off a *darkness* on a globally-lit map stops being dark.

---

## Vision, perception and umbra

```js
game.pf1Lighting.perception.status()             // is it live, and which modes are patched
game.pf1Lighting.perception.isEnabled()
game.pf1Lighting.perception.sees(point)          // would ordinary sight work here
game.pf1Lighting.perception.darkvisionSees(point)
game.pf1Lighting.perception.tierAt(point, source)
game.pf1Lighting.perception.viewerTier()         // the tier as the current view sees it — what the readout reports
game.pf1Lighting.perception.blinds(...)
game.pf1Lighting.perception.darkSightRange(...)
game.pf1Lighting.perception.refresh()
```

### Umbra

```js
game.pf1Lighting.umbra.draw()          // overlay, coloured by the tier each region clamps to
game.pf1Lighting.umbra.clear()
game.pf1Lighting.umbra.stats()         // regions, tiers present, edge count, rebuild cost
game.pf1Lighting.umbra.cache()         // is the per-observer cache hitting, and by how much
game.pf1Lighting.umbra.clampAt(point, observer)
game.pf1Lighting.umbra.regionsFor(observer)
game.pf1Lighting.umbra.for(observer)
game.pf1Lighting.umbra.all()
game.pf1Lighting.umbra.edges()
game.pf1Lighting.umbra.resync()
game.pf1Lighting.umbra.mask()
game.pf1Lighting.umbra.isEnabled()
game.pf1Lighting.umbra.invalidate()
```

`stats().rebuildMs` is the cold path by construction; `cache()` is the only readout that exercises the
one `perceivedTier` actually calls.

### Observer

```js
game.pf1Lighting.observer.status()     // resolved mode, and each token's verdict
game.pf1Lighting.observer.toggle()     // same as Alt+O
game.pf1Lighting.observer.isGmObserverMode()
game.pf1Lighting.observer.refresh()
```

### Native suppression

```js
game.pf1Lighting.suppression.isDisabled()
game.pf1Lighting.suppression.reinitialise()
```

---

## Light spill and geodesic distance

```js
game.pf1Lighting.spill.stats()                    // windows found, rooms marched, bands drawn, and why there might be none
game.pf1Lighting.spill.at({ x: 1000, y: 1200 })   // which bands cover a point
game.pf1Lighting.spill.list()
game.pf1Lighting.spill.rebuild()
game.pf1Lighting.spill.config()                   // open the settings window
```

```js
game.pf1Lighting.geodesic.draw()
game.pf1Lighting.geodesic.clear()
game.pf1Lighting.geodesic.fill(...)
game.pf1Lighting.geodesic.ladder(...)
game.pf1Lighting.geodesic.cellSize()
```

See [Overlays](#overlays) for what the geodesic drawing shows and how to read the red hatch.

---

## Regions, presets and scenes

### Regions with their own light level

```js
game.pf1Lighting.areas.status()    // every area, and the three reasons one might do nothing
game.pf1Lighting.areas.list()
game.pf1Lighting.areas.tierAt(point)
game.pf1Lighting.areas.invalidate()
game.pf1Lighting.probe.at()        // reports the ambient here next to the scene's
```

`status()` answers the two questions this feature generates: whether the behaviour is on offer at all
(`declared` is the module.json half and needs a **world relaunch**, not an F5), and whether an area can
change the *picture* — which needs `ambientTakeover` on, because the darkness-level texture is the only
channel by which anything darkens below global light.

### Scenes

```js
game.pf1Lighting.render.scenes()          // which scenes carry a tier, and whether they match
game.pf1Lighting.render.resyncScenes()    // force the pass
game.pf1Lighting.render.setSceneTier(2)   // what the lighting-control buttons do; 4 Bright … 1 Dark
```

`matches: false` on a scene that is not `locked` means the sync did not run — the usual reason is that
this client was not the active GM when the setting changed.

### Lights

```js
game.pf1Lighting.render.lights()        // which lights carry an activation range, and whether they match
game.pf1Lighting.render.resyncLights()  // force the pass
```

Same derivation and the same staleness conditions as scenes.

### Presets

```js
game.pf1Lighting.presets.table()      // every preset and its values, as currently configured
game.pf1Lighting.presets.builtIn      // the module's own table, whatever this world has done
game.pf1Lighting.presets.apply("deeperDarkness")   // the flat update a document wants
game.pf1Lighting.presets.choices()
game.pf1Lighting.presets.label(name)
game.pf1Lighting.presets.status()     // customised: false means this world still tracks the module's table
game.pf1Lighting.presets.edit()       // open the editor
game.pf1Lighting.presets.reset()      // back to the built-ins
```

From a macro:

```js
light.document.update(game.pf1Lighting.presets.apply("deeperDarkness"));
```

There is deliberately no matcher from values back to a preset name: the stored `preset` records where
the numbers came from, which is history and not recoverable by looking at them.

Two model inputs have no control and are not meant to — which lights a darkness *extinguishes* rather
than merely dims, and whether a magical darkness casts an umbra. Both follow from the rules, and both
remain settable through the `pf1-lighting.config` flag if a scene ever needs an exception.

### Windows

```js
game.pf1Lighting.render.visuals()   // Configure Visuals
game.pf1Lighting.spill.config()     // Configure Light Spill
game.pf1Lighting.presets.edit()     // Edit Presets
```

---

## Performance

Target is a full field recompute inside 16 ms (DESIGN.md §9.1).

### Benchmarking

```js
const F = game.pf1Lighting.field;
game.pf1Lighting.spike.bench(() => F.compute(), { label: "field.compute" });

game.pf1Lighting.spike.compare({
  filtered:   () => F.compute({ filter: true }),
  unfiltered: () => F.compute({ filter: false }),
});
```

`bench` warms up and reports the **median**; `compare` runs its cases **round-robin** so none of them
absorbs the others' warm-up. Both defaults exist because getting them wrong produced three separate
wrong conclusions on this module — a single-shot read of 0.9 ms for work doing no Clipper ops, a GC
spike that inverted a ranking via the mean, and a 5.7× speedup that was mostly measurement order.
**Don't hand-roll a timing loop.**

### Source construction

```js
game.pf1Lighting.spike.churn()                        // 30 sources × 20 cycles, all modes
game.pf1Lighting.spike.churn({ count: 60 })
game.pf1Lighting.spike.churn({ modes: ["direct"] })
game.pf1Lighting.spike.churn({ softEdges: false })    // isolate PolygonMesher's cost
```

| Mode | What it measures |
| --- | --- |
| `sweep` | Foundry's normal path — what a real placed light costs |
| `constrain` | Sweep, then narrow with Clipper — the cost of clipping a real source |
| `direct` | Supply the polygon, **skip the sweep** — the cost of a synthetic fill |
| `reuse` | Re-`initialize()` a fixed pool — isolates construction from geometry |

Run it on a **populated** scene. An empty one has no walls to sweep against and understates the cost
roughly fivefold.

### Subdivision

Times the polygon boolean algebra that decides which source applies where (DESIGN.md §6.1). Uses the
scene's **real** swept light polygons, since vertex count is what drives Clipper cost.

```js
game.pf1Lighting.spike.subdivide()                      // 20 iterations, all modes
game.pf1Lighting.spike.subdivide({ radius: 20 })        // wide suppressor — the worst case
game.pf1Lighting.spike.subdivide({ suppressors: 4, bands: 2 })
game.pf1Lighting.spike.subdivide({ modes: ["tight"] })
game.pf1Lighting.spike.emitterPaths()
game.pf1Lighting.spike.suppressorPaths()
```

| Mode | What it measures |
| --- | --- |
| `naive` | No pre-filter — every emitter clipped, fill unioned over all emitters |
| `filtered` | One box around the whole suppressor union |
| `tight` | One box per union ring, plus a per-band test before each intersection |

Every mode must produce the **same cell count** — the harness warns if one doesn't, since faster *with
fewer cells* is a correctness bug, not an optimisation.

Run it at a **large radius** too. The default 4 grid squares leaves most emitters untouched, which
flatters the pre-filter; a *deeper darkness* is 60 ft (12 squares), and a suppressor overlapping most of
the scene's lights is where the filter stops helping.

Each mode gets 5 untimed warm-up iterations first. Without them the first mode absorbed the JIT warm-up
for the others, and a second call in the same page session ran 1.9× faster than the first on identical
geometry — a bigger swing than any difference between modes. **Compare numbers within one invocation,
not across page loads.**

Also reported, and the reason this harness exists as much as the timings:

- **`annuli`** — cells with a hole, from a suppressor sitting wholly inside an emitter. A source shape
  cannot express one (`PolygonMesher` takes a single ring), so each needs splitting before it can be
  rendered.
- **`extra paths`** — results with more than one path. `PIXI.Polygon#intersectPolygon` returns only the
  first and discards the rest, so a non-zero count here is the number of cells that convenience method
  would silently have lost.

Ceiling is ~8 ms: the 16 ms frame budget less the ~3 ms pooled source construction costs for 60
sources (DESIGN.md §9.5).

---

## Synthetic sources

Document-less light sources with optionally injected polygons — the mechanism the renderer design
depends on.

```js
const g = canvas.grid.size;

// A plain synthetic light at the cursor
game.pf1Lighting.spike.spawn({ id: "a", ...canvas.mousePosition, dim: g * 6 });

// The same light, sweep narrowed to a circle half its size
game.pf1Lighting.spike.spawn({
  id: "b",
  ...canvas.mousePosition,
  dim: g * 6,
  constrainTo: new PIXI.Circle(canvas.mousePosition.x, canvas.mousePosition.y, g * 3),
});

game.pf1Lighting.spike.list()
game.pf1Lighting.spike.refresh()
game.pf1Lighting.spike.ngon(...)
game.pf1Lighting.spike.destroy("a")
game.pf1Lighting.spike.clear()
```

Darkness-level texture spikes:

```js
game.pf1Lighting.spike.darknessBands()
game.pf1Lighting.spike.darknessPaint()
game.pf1Lighting.spike.darknessAt()
game.pf1Lighting.spike.darknessClear()
```

---

## Recipes

### The module appears to do nothing

```js
game.pf1Lighting.settings()
```

Look for `renderEnabled`, `ambientTakeover`, `perceptionEnabled` or `disableNativeSuppression` at
`false`. A world that turned one off while they had settings rows keeps them off.

### A *darkness* is computed but not drawn

```js
game.pf1Lighting.render.ambient()   // live? does this scene give it anything to do?
game.pf1Lighting.render.texture()
```

Global illumination takeover is what lets anything paint darker than global light. Also check the
scene's own **Global Illumination** is enabled, since a region or a spill has nothing to override
without it.

### A transition on screen looks wrong

1. `game.pf1Lighting.overlay.levels()` — is the boundary in the model at all?
2. If yes, `game.pf1Lighting.render.transect()` on the edge — ramp or step?
3. If it ramps, `game.pf1Lighting.render.isolate(...)` — which layer owns it?

### Light spill isn't reaching a room

```js
game.pf1Lighting.spill.stats()     // why there might be none
game.pf1Lighting.geodesic.draw()   // red hatch = sealed; a break in it = light gets through
```

Also: spill needs `ambientTakeover` on, the scene's global illumination enabled, and the sky brighter
than the room.

### A token can't see something it should

```js
game.pf1Lighting.probe.perception()   // from the selected token, per target, per term
game.pf1Lighting.probe.vision()       // the source itself — check shapePoints
game.pf1Lighting.umbra.draw()         // is a darkness between them?
```

### A region behaviour isn't on offer

```js
game.pf1Lighting.areas.status()
```

`declared: false` needs a **world relaunch**, not an F5 — it is the module.json half.

### The canvas feels heavy while tokens move

```js
game.pf1Lighting.render.paint()      // fieldStable should be true; only shadows/clamps should cost
game.pf1Lighting.settingsCache()     // hitRate well below 1 means something is bypassing the cache
game.pf1Lighting.umbra.cache()
```

---

## See also

- [README.md](README.md) — what the module does, for a GM
- [API.md](API.md) — the supported surface for other modules
- DESIGN.md — the full design record, and the section numbers referenced above
