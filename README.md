# PF1 Lighting

Observer-relative light levels for Pathfinder 1e on Foundry VTT.

**Status: model layer.** Not usable at a table yet. The module currently changes nothing
about how a scene renders — the architecture in [DESIGN.md](DESIGN.md) is validated
(§8.1) and the model that will drive the renderer is being built (§8.2 step 1).

## What it does today

### Light level readout

A chip beside the pointer showing the light level under the cursor, or of a hovered
token. **Alt+L** toggles it; both it and the explanation line are per-client settings.

With explanations on it says *why*, not just what — "Dim · reduced from normal", "Normal ·
darkness present, no effect", "Bright · darkness cancelled by daylight". That comes
straight out of `evaluate()`, which tracks the pre-suppression baseline and the deciding
suppressor.

Token readouts sample the centre plus four quarter-offset points and report the
**brightest**, so a large token straddling a light's edge reads as lit.

This is a fresh implementation, not a reparenting of `pf1-light-level-tooltip` — that
module is untouched and still works standalone. Note both bind Alt+L by default.

### Renderer

Off by default. **Render the lighting model** (world setting) draws the scene from the
model instead of Foundry's own lighting. Requires **Disable native darkness suppression**
to also be on — otherwise Foundry is still clipping light before the model sees it.

```js
game.pf1Lighting.render.rebuild()   // force a rebuild
game.pf1Lighting.render.stats()     // timings and cell counts from the last one
game.pf1Lighting.render.reset()     // drop all clips, restore stock rendering
```

Real light sources are **clipped, not replaced** — flicker, colour and falloff survive,
with a bite taken out where a darkness overlaps. Synthetic sources are pooled and reused,
never created per frame (§9.5). A `dark` fill at the Dark tier draws nothing at all:
clipping the light away already renders it.

### Field cell overlay (debug)

Draws the lighting model's computed cells on the canvas — blue for unsuppressed light,
orange for reduced, violet for darkness fill. Off by default; a client setting, or:

```js
game.pf1Lighting.overlay.toggle()
```

Development aid rather than a play feature, but it is how the subdivision gets verified
before anything renders for real.

### Console

Everything else is driven from the console via `game.pf1Lighting`.

### Model

`evaluate(point)` is the model's one query: what is the light level here, and why.

```js
game.pf1Lighting.evaluate(canvas.mousePosition)
// → { B, tier, tierName, emitters, suppressors, winner, cancelled }
```

It answers the **god's-eye** question only. Observer resolution (§5), low-light vision
(§4.4), darkvision (§4.5) and umbra (§4.3) are not implemented.

### Registry

A resolved snapshot of everything on the scene that affects light level, sitting between
Foundry's source collections and the model.

```js
game.pf1Lighting.registry.stats()         // counts, generation, dirty flag
game.pf1Lighting.registry.emitters()      // resolved emitters with kind/level/radii
game.pf1Lighting.registry.suppressors()
game.pf1Lighting.registry.emittersAt(canvas.mousePosition)
game.pf1Lighting.registry.invalidate()    // force a rebuild on next read
```

It rebuilds **lazily on a dirty flag** rather than on a debounce: hooks mark it stale and
the next read rebuilds. Bursts coalesce for free, there is no timing constant to tune,
and no window in which a read returns stale data. `version()` bumps on each rebuild and
is the cache key for anything derived from it.

### Field

The whole-scene cell decomposition — what the renderer will consume. Cells partition
space by *treatment* (which suppressor applies), and each is a simple hole-free polygon.

```js
game.pf1Lighting.field.stats()            // counts, ops, ms — no cells returned
game.pf1Lighting.field.get()              // cached; recomputed when the registry changes
game.pf1Lighting.field.compute({ filter: false })   // no pre-filter; identical cells
```

| Cell kind | Geometry | Will render as |
| --- | --- | --- |
| `clip` | emitter minus everything eligible to block it | the real source, clipped |
| `reduced` | emitter ∩ suppressor region | synthetic source, radii shifted one zone |
| `dark` | suppressor region minus all light | flat fill, Supernatural Dark |

`reduced` cells keep their gradient: reducing a tier is exactly shifting the zone radii
inward by one zone, so a torch inside a *darkness* still falls off from the flame rather
than becoming a uniform disc. See DESIGN.md §6.2.2.

Nothing draws these yet — the renderer is §8.2 step 3.

### Readouts

```js
game.pf1Lighting.probe.stack()     // mixin order on the source classes, live source counts
game.pf1Lighting.probe.sources()   // every emitter and suppressor with its resolved config
game.pf1Lighting.probe.at()        // light level under the cursor
game.pf1Lighting.probe.at(x, y)    // light level at a scene pixel coordinate
game.pf1Lighting.probe.tokens()    // light level at each selected token's centre
game.pf1Lighting.probe.geometry()  // origins, bounds and clip state of every source
game.pf1Lighting.probe.darkness()  // per suppressor: edges, strength, alpha, clip
game.pf1Lighting.probe.vision()    // per vision source: blinding, mode, radius, polygon
game.pf1Lighting.field.explain()   // per region: breakers, area carved; per emitter, area lost
```

These exist because reading Foundry's source repeatedly produced plausible mechanisms
that turned out not to be the cause. **When a symptom survives a fix, reach for these
before theorising again** — and check the *symptom*, not the thing you just changed.
`probe.vision()` once reported a source that was not blinded, in the right vision mode,
with radius 1250 and active, that could see exactly one square; the giveaway was
`shapePoints: 16`, which had been in the output the whole time.

### Synthetic sources

Document-less light sources with optionally injected polygons — the mechanism the
renderer design depends on.

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
game.pf1Lighting.spike.clear()
```

### Benchmarking

```js
const F = game.pf1Lighting.field;
game.pf1Lighting.spike.bench(() => F.compute(), { label: "field.compute" });

game.pf1Lighting.spike.compare({
  filtered: () => F.compute({ filter: true }),
  unfiltered: () => F.compute({ filter: false }),
});
```

`bench` warms up and reports the **median**; `compare` runs its cases **round-robin** so
none of them absorbs the others' warm-up. Both defaults exist because getting them wrong
produced three separate wrong conclusions on this module — a single-shot read of 0.9 ms
for work doing no Clipper ops, a GC spike that inverted a ranking via the mean, and a
5.7× speedup that was mostly measurement order. Don't hand-roll a timing loop.

### Performance — source construction

Compares four source-construction paths and prints a table:

| Mode | What it measures |
| --- | --- |
| `sweep` | Foundry's normal path — what a real placed light costs |
| `constrain` | Sweep, then narrow with Clipper — the cost of clipping a real source |
| `direct` | Supply the polygon, **skip the sweep** — the cost of a synthetic fill |
| `reuse` | Re-`initialize()` a fixed pool — isolates construction from geometry |

```js
game.pf1Lighting.spike.churn()                        // 30 sources × 20 cycles, all modes
game.pf1Lighting.spike.churn({ count: 60 })
game.pf1Lighting.spike.churn({ modes: ["direct"] })
game.pf1Lighting.spike.churn({ softEdges: false })    // isolate PolygonMesher's cost
```

Target is a full field recompute inside 16 ms (DESIGN.md §9.1). Run it on a *populated*
scene — an empty one has no walls to sweep against and understates the cost roughly
fivefold.

### Performance — subdivision

Times the polygon boolean algebra that decides which source applies where (DESIGN.md
§6.1). Uses the scene's **real** swept light polygons, since vertex count is what drives
Clipper cost. Real darkness sources are used as suppressors if the scene has any;
otherwise it generates some on top of existing lights.

```js
game.pf1Lighting.spike.subdivide()                    // 20 iterations, all modes
game.pf1Lighting.spike.subdivide({ radius: 20 })      // wide suppressor — the worst case
game.pf1Lighting.spike.subdivide({ suppressors: 4, bands: 2 })
game.pf1Lighting.spike.subdivide({ modes: ["tight"] })
```

| Mode | What it measures |
| --- | --- |
| `naive` | No pre-filter — every emitter clipped, fill unioned over all emitters |
| `filtered` | One box around the whole suppressor union |
| `tight` | One box per union ring, plus a per-band test before each intersection |

Every mode must produce the **same cell count** — the harness warns if one doesn't, since
faster *with fewer cells* is a correctness bug, not an optimisation.

Run it at a **large radius** too. The default 4 grid squares leaves most emitters
untouched, which flatters the pre-filter; a *deeper darkness* is 60 ft (12 squares), and
a suppressor overlapping most of the scene's lights is where the filter stops helping.

Each mode gets 5 untimed warm-up iterations first. Without them the first mode absorbed
the JIT warm-up for the others, and a second call in the same page session ran 1.9×
faster than the first on identical geometry — a bigger swing than any difference between
modes. Compare numbers **within** one invocation, not across page loads.

Also reported, and the reason this harness exists as much as the timings:

- **`annuli`** — cells with a hole, from a suppressor sitting wholly inside an emitter.
  A source shape cannot express one (`PolygonMesher` takes a single ring), so each needs
  splitting before it can be rendered.
- **`extra paths`** — results with more than one path. `PIXI.Polygon#intersectPolygon`
  returns only the first and discards the rest, so a non-zero count here is the number
  of cells that convenience method would silently have lost.

Ceiling is ~8 ms: the 16 ms frame budget less the ~3 ms that pooled source construction
costs for 60 sources (§9.5).

### Native darkness suppression

Foundry's darkness sources clip light sweeps, so the model can't see what the light
level would have been before darkness applied — see DESIGN.md §4.1.1. The setting
**Disable native darkness suppression** turns that off.

**While it is on, darkness will appear not to work** — light shines straight through it,
because this module's renderer doesn't exist yet to re-apply suppression properly.
Development use only.

## Configuring a darkness source

Place an **AmbientLight** with *Negative* (darkness) enabled. With no further setup it
behaves as a 2nd-level *darkness* spell — reduce one tier, blocking mundane light and
magical light of level 2 or lower.

To override, set a flag on the light document:

```js
light.setFlag("pf1-lighting", "config", {
  kind: "magical",
  level: 3,
  transform: { op: "reduce", steps: 2 },   // deeper darkness
  eligibility: "preset:darkness",
  blocksPath: true,
});
```

A light's **Bright** radius (our innermost tier, above Normal) is also a flag, in scene
distance units, and defaults to 0:

```js
light.setFlag("pf1-lighting", "brightRadius", 20);
```

## Not implemented yet

Low-light vision, darkvision, umbra (sight through magical darkness), observer
filtering, the renderer, interiors and apertures, diffuse spill. `evaluate()` currently
answers the god's-eye question only.

## Requirements

Foundry VTT v13, Pathfinder 1e v11+.
