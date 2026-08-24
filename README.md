# PF1 Lighting

Observer-relative light levels for Pathfinder 1e on Foundry VTT.

**Status: model, renderer, perception and umbra.** Everything that changes behaviour is
behind a world setting, off by default. Light levels are now genuinely observer-relative —
what a creature can see depends on the darkness *between* it and the target, not only on
the darkness *at* the target — which was the point of the whole thing.

The largest gap left is that global illumination is not yet a real light source, so a
*darkness* on a bright map is computed correctly and drawn not at all, and a shadowed area
goes undetectable while still looking lit. See [DESIGN.md](DESIGN.md) §7.1 and §8.2.

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
never created per frame (§9.5). How dark an area *is*, as opposed to what lights reach it, is
painted separately — see **Global illumination** below.

**Known consequence: darkness *animations* only play on supernatural darkness.** An ordinary
*darkness* is rendered by removing light rather than by drawing anything, so there is no mesh
for a shader animation to run on — pick *Roiling Darkness* on one and the dropdown does
nothing. Turning the renderer off restores stock behaviour.

### Global illumination

Off by default. **Model global illumination** (world setting) paints the model's five
brightness tiers into Foundry's darkness-level texture, so every area of the map renders at
the tier the model says it is. Requires the renderer.

Without it, a *darkness* cast on a brightly lit map is computed correctly and drawn not at
all: Foundry's global light is unconditional, illumination composites by taking the brightest
contributor, and so anything painted on top loses to the ambient beneath it. With it, a
*darkness* at noon visibly drops the area a step.

It also fixes the reverse problem. Brightness is information a GM needs, and a region drawn as
*absence of light* stops reading as dark the moment anything reveals it — so under god's eye,
*true seeing* or *see in darkness* the map used to flatten out. The darkness-level texture is
read by Foundry's vision shaders as well as its lighting ones, so those views now show terrain
**and** its true light level at the same time.

**Ambient brightness becomes quantised.** The scene's darkness slider moves in five steps
rather than continuously, because every region — including plain open ground — is painted on
the same five-tier ladder. That is what makes the step between two tiers readable, and it is
the most visible thing this switch does.

### Soft transitions

Two settings, for the two kinds of edge a light has.

**Light edge softening** widens the fade on a light whose shape has been clipped, cut by a
wall, or drawn for a band overlap. Foundry's own value is 0.08; the default here is 0.3. It
costs a polygon-offsetting pass per 3 pixels, and a feather wider than a narrow region can
swallow it, which is why the range stops at one square. Two Foundry behaviours can make it look
inert: soft edges are off entirely below **Medium** performance mode, and they never apply to
an unobstructed circular light, which fades by its own attenuation instead.

**Darkness edge softening** widens the fade at the rim of a *supernatural* darkness disc — the
only kind that draws a darkness source of its own. Foundry's value is 0.5, which is where this
defaults; because that is a fixed distance rather than a proportion, a large darkness looks
harder-edged than a small one, and raising it widens only the picture.

Neither affects where a light or a darkness *reaches*, only how its edge is drawn.

An ordinary darkness effect keeps a hard edge, deliberately. It is drawn by removing light
rather than by painting a surface, so there is nothing there to fade — and a magical darkness
with a crisp boundary is a reasonable thing for a magical darkness to look like.

### Animated darkness

An ordinary darkness has no surface, so an animation chosen in its config has nothing to run
on and does nothing. **Animated darkness visibility** draws one faintly so the animation shows.
It tints the area slightly darker than the rules say, which is the price; 0 turns it off, and
it only ever applies to a darkness that actually has an animation set. A *deeper darkness* is
unaffected either way — it already draws.

### How a light source works

A light provides a **set light level** out to its `bright` radius, then **raises** the
prevailing level by one step from there to its `dim` radius, never above its own level. A
torch at `bright: 20 / dim: 40` is *normal light to 20 feet, one step up to 40* — which is
what the rules say a torch does, and it is why the two native radius fields need nothing
added to them.

The consequences are mostly invisible until a map is already lit:

- A torch in a **dim-lit** room brightens its rim to normal. It does not pin the rim at dim,
  and it can never make an area darker than it already was.
- **Two torches whose outer bands overlap** raise that overlap two steps — darkness to normal.
  A third adds nothing, because each light caps the increase at its own level.
- A torch at **noon** contributes nothing at all, which is correct and now also looks it.

That second case is **computed but not drawn** by default. The overlap really is one step
brighter as far as every rule is concerned — the readout says so, and it is what creatures can
see by — but the renderer leaves it looking like plain overlapping light unless *Draw
overlapping light bands brighter* is switched on.

Three per-light flags tune this, all defaulting to the ordinary case: the set level
(`emitTier`, default normal), how many steps the band raises (`steps`, default 1), and the
ceiling on that increase (`cap`, default the set level). Most lights need none of them; a rare
effect that brightens by two steps sets `steps: 2`.

Looking **through** a magical darkness dims what lies beyond it to the darkness's own level
(see *Darkness shadows what lies beyond it*, below). With this on, that shadow is drawn: the
area beyond renders at the clamped tier rather than being hidden outright, so a *darkness* cast
across a lit room makes the room read dark instead of making it disappear. Without it, the same
rule still applies to what creatures can **detect**; it just can't be seen.

```js
game.pf1Lighting.render.ambient()   // is it live, and does this scene give it anything to do
game.pf1Lighting.render.texture()   // what is painted, and the level under the cursor
game.pf1Lighting.render.paint()     // the observer's shadow: tiers found, cells cut, cost
game.pf1Lighting.render.stats()     // painted > 0 means the model is reaching the screen

game.pf1Lighting.render.levels("bands")  // alternative tier→brightness table (see below)
game.pf1Lighting.render.levels(null)     // back to the default
```

Two tables are provided, and which one looks right is a matter for a real map. The default,
`"even"`, spaces the five tiers equally and separates them as clearly as possible, at the cost
of night scenes reading brighter than stock. `"bands"` renders each tier at the top of its own
brightness range, so a dark scene stays dark, at the cost of squashing Bright against Normal.
Neither is persisted — pick one by looking, and say which.

This is the largest single change to how a scene looks, which is why it's a separate switch
from the renderer — if the map looks wrong, turning this off narrows it in one step.

### Perception

Off by default. **Perceive by light level** (world setting) decides what a creature can see
from the lighting model rather than from Foundry's raw light polygons. Requires **Disable
native darkness suppression**, for the same reason the renderer does.

| Sense | Rule |
| --- | --- |
| Ordinary sight | needs **Dim** light or better |
| Darkvision | works at any tier **except Supernatural Dark**, within its range |
| *See in darkness* | works everywhere, at any range, and reveals terrain across its whole line of sight |
| *True seeing* | the same, bounded to the spell's range |
| *See invisibility* | in range, or wherever ordinary sight would work |

A creature in **magical** Supernatural Dark is blinded outright, unless it has *see in
darkness*. Mundane darkness — a source at level 0 — never blinds and never blocks sight
through it, however dark it is: standing on an unlit hillside you can still see a lit window
thirty feet away.

*See in darkness* is worth calling out because **PF1 models the sense and then never uses
it** — it has a trait and a change flag and appears on the sheet, but nothing in Foundry has
ever consumed it. Here it does something for the first time.

Without this, a token standing in a *darkness* is still plainly visible: Foundry asks
whether the point is inside some light source's polygon, and the module deliberately never
clips those (doing so punched holes in what tokens could see — DESIGN.md §6.2.4). The
darkness is drawn correctly and perceived as if it weren't there.

```js
game.pf1Lighting.perception.status()          // is it live, and which modes are patched
game.pf1Lighting.perception.sees(point)       // would ordinary sight work here
game.pf1Lighting.perception.darkvisionSees(point)
```

Low-light vision and grayscale darkvision are still unimplemented. Dim light's 20%
concealment is a mechanical consumer rather than a visibility rule, so it isn't applied
either.

### Umbra — darkness shadows what lies beyond it

On by default, alongside **Perceive by light level**. **Darkness shadows what lies beyond
it** (world setting) makes light levels *observer-relative*: looking through a magical
darkness lowers everything past it to the darkness's own level.

So a lit room seen through a *darkness* spell is as dark as the spell, and a creature with
ordinary sight can no longer pick tokens out of it. A creature with darkvision still can —
ordinary *darkness* clamps to Dark, which darkvision handles — but *deeper darkness* clamps
to Supernatural Dark and defeats it. Standing **inside** a bubble shadows every direction at
once, with no special case: the umbra is simply 360°.

The rule is "you cannot see through a darkness more clearly than the darkness allows". It
clamps, it doesn't stack: a torch on the far side is reduced to the spell's level and no
further, and it never makes anything *darker* than it already was.

Each part of a darkness casts its own strength. A slice cancelled by a *daylight* casts no
shadow at all, and a source with a dark core and a dimmer rim casts two different shadows
from the one orb.

*See in darkness*, *true seeing* and blindsight are unaffected — they see straight through.

```js
game.pf1Lighting.umbra.draw()     // overlay, coloured by the tier each region clamps to
game.pf1Lighting.umbra.stats()    // regions, tiers present, edge count, rebuild cost
game.pf1Lighting.umbra.cache()    // is the per-observer cache hitting, and by how much
game.pf1Lighting.probe.perception()   // per-target: rawTier, tier, umbraApplied
```

What this does **not** yet do is repaint the shadowed area. The room goes undetectable while
still looking lit, because painting it needs the global-illumination rework (DESIGN.md §7.1)
that is also what makes a *darkness* visible on a bright map at all.

### Observer view

Whose point of view the lighting is resolved for. **Alt+O**, a toggle in the token controls,
or a per-client setting.

- **On** (default) — selecting a token as GM shows you what that token perceives.
- **Off** — you keep the god's-eye view even with a token selected, which is what you want
  while moving tokens rather than adjudicating what one can see.

```js
game.pf1Lighting.observer.status()   // resolved mode, and each token's verdict
```

Players are unaffected by the toggle: selection always narrows to the selected token, and
with nothing selected they get the union of the tokens they own or observe (PF1's
**Guaranteed Vision** setting decides which). One fix rides along here — PF1 lets a
vision-shared token stay a vision source even when a player has selected something else, so
selecting one token didn't actually narrow their view. It does now.

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
(§4.4), darkvision as a tier remap (§4.5) and umbra (§4.3) are not implemented. Perception
(§4.8) is built on top of this and inherits the limitation.

### Registry

A resolved snapshot of everything on the scene that affects light level, sitting between
Foundry's source collections and the model.

```js
game.pf1Lighting.registry.stats()         // counts, generation, dirty flag
game.pf1Lighting.registry.emitters()      // resolved emitters with kind/level/emission
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
| `reduced` | emitter ∩ suppressor region | the same source at a lowered light level |
| `dark` | suppressor region minus all light | flat fill, Supernatural Dark |
| `ambient` | the scene minus every suppressor region | the scene's own tier |
| `stack` | where two or more relative bands overlap | nothing, unless *Draw overlapping light bands brighter* is on |

`reduced` cells keep their gradient: reducing a tier lowers the light's *set level* and
leaves its radii alone, so a torch inside a *darkness* still falls off from the flame rather
than becoming a uniform disc. See DESIGN.md §3.2.1.

The renderer consumes these directly; the overlay above draws them for inspection.

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
game.pf1Lighting.probe.perception()  // from the selected token: why each other token is or isn't visible
game.pf1Lighting.field.explain()   // per region: breakers, area carved; per emitter, area lost
```

`probe.perception()` reports each term of the visibility conjunction separately — tier, LOS,
distance, and each of the observer's detection modes independently — because they all fail
identically on screen: the token is simply not there.

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

It also stands down four other things Foundry does with darkness that the model has to own
instead — light-priority edges, origin containment, and two independent ways a darkness
source blinds a token outright (DESIGN.md §4.1.1 lists all five).

**On its own, this makes darkness appear not to work**: light shines straight through,
because nothing is re-applying suppression. Turn on **Render the lighting model** with it.
It is the prerequisite for both that and **Perceive by light level**.

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

Low-light vision, grayscale darkvision, interiors and apertures, diffuse spill, dim-light
concealment.

The largest gap is **global illumination as a real light source** — until it is one, a
*darkness* cast on a brightly lit map is computed correctly and drawn not at all. The same
rework is what would let an umbra be *painted* rather than only detected, so the shadowed
side of a darkness currently goes undetectable while still looking lit.

## Requirements

Foundry VTT v13, Pathfinder 1e v11+.
