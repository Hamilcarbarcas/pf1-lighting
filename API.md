# PF1 Lighting — API

```js
const api = game.modules.get("pf1-lighting")?.api;
```

> **Bind to `api`, not to `game.pf1Lighting`.** Everything else on `game.pf1Lighting` is a debug readout.


# Contents

- [Versioning](#versioning)
- [Tiers](#tiers)
- [Subjects and shapes](#subjects-and-shapes)
- [Brightness](#brightness)
- [Sampling](#sampling)
- [Who can see who](#who-can-see-who)
- [The scene's light level](#the-scenes-light-level)
- [Light effects](#light-effects)
- [Withheld regions](#withheld-regions)
- [Revealed regions](#revealed-regions)
- [Unexplored regions](#unexplored-regions)
- [Hooks](#hooks)
- [Cost](#cost)
- [Examples](#examples)

# Versioning

| | |
| --- | --- |
| `api.version` | `1`. Incremented on a **breaking** change only |

What this build actually exposes:

```js
console.log(game.modules.get("pf1-lighting")?.api);
```

# Tiers

Tiers cross the boundary as **ordered numbers**, so `>=` means what it looks like.

| | |
| --- | --- |
| `api.TIER` | `{ SUPERNATURAL_DARK: 0, DARK: 1, DIM: 2, NORMAL: 3, BRIGHT: 4 }` |
| `api.tierName(tier)` | The module's own name for a tier — `api.tierName(2)` is `"Dim"`. `null` for an unknown value |


# Subjects and shapes

Every query takes one subject or an array of them, and the return shape follows the argument.

```js
api.brightnessOf(token)          // 3
api.brightnessOf([a, b, c])      // [3, 1, 2]
```

[`perceive`](#who-can-see-who) is the one exception: it returns one record per (observer, observed)
pair, so a matrix has no scalar shape.

Anywhere a point or a token is taken:

| You have | Accepted |
| --- | --- |
| `{ x, y }` or `{ x, y, elevation }` | ✅ |
| A `Token` (canvas placeable) | ✅ — its centre |
| A `TokenDocument` (what a hook hands you) | ✅ — resolved to its placeable |
| A token id string | ✅ — looked up on the current canvas |

Elevation is carried and ignored; the model is flat.


# Brightness

All three return a `TIER` value, or an array of them.

| Function | What it answers |
| --- | --- |
| `api.brightnessAt(point)` | The tier at a point, god's-eye — the map's own light level, what a GM sees |
| `api.brightnessAt(point, { observer })` | The tier that creature can **see by** there, clamped by any magical darkness between the two |
| `api.brightnessOf(token, { sample, observer })` | The tier a token is standing in |
| `api.brightnessInSquare(point, { observer })` | The grid square containing the point, evaluated by the same rule a token gets |

`observer` asks a different question rather than refining the first:

```js
api.brightnessAt(p)                       // 4 — the room is brightly lit
api.brightnessAt(p, { observer: rogue })  // 1 — the rogue is looking through magical darkness
```


# Sampling

`api.SAMPLE` is `{ CENTER: "center", MIN: "min", MAX: "max" }` — how a subject occupying more than one
square resolves to a single tier. Accepted by `brightnessOf`, `perceive` and `perceivedBy` — a grid
square has one centre, so `brightnessInSquare` has nothing to sample.

| `sample` | Rule | Use for |
| --- | --- | --- |
| `"center"` (default) | The token's centre point | Everything ordinary. Matches the readout and a grid square |
| `"min"` | The darkest square the token occupies | The hider's rule |
| `"max"` | The brightest square it occupies | The spotter's rule |

There is no `average`: averaging tiers and re-thresholding produces a number that matches no rule in
the game.


# Who can see who

| Function | Returns |
| --- | --- |
| `api.perceive(observer, target, { sample })` | One record. Arrays on either side give one record per pair |
| `api.perceivedBy(observed, { observers, sample })` | A record per candidate observer, those that **can** see first, brightest perception first within that |

`perceivedBy` defaults `observers` to every other token on the scene with sight enabled. Narrow it
yourself — which NPCs are entitled to notice is a table question.

## The record

| Field | |
| --- | --- |
| `observer`, `observed` | The two `Token`s |
| `visible` | Boolean |
| `reason` | Which sense did it — the first mode that succeeded, or `null` |
| `reasons` | *Every* mode that would have succeeded, in core's own order |
| `tier` | The tier the observer perceives the target at |
| `tierName` | Its English name |
| `lightIndependent` | Whether `reason` cares about light at all. `null` = unregistered mode |
| `blinded` | Whether the observer's vision source is blinded |
| `distance` | In scene units, to 2dp |
| `losBlocked` | Whether a wall is between them |
| `ephemeral` | The observer had no live vision source, so one was built for the question — also the expensive path |

Known `reason` values include `basicSight` (where PF1 puts darkvision, and where blindsight rides in),
`lightPerception`, `feelTremor`, `seeInvisibility`, and `visionLight` — a vision-granting light source,
which core tests before any detection mode; it has no mode id and no observer, so it reveals to
everyone equally.

## Custom senses

| Function | |
| --- | --- |
| `api.registerLightIndependentMode(id)` | Declares a detection mode as ignoring light, and returns the full set |

`lightIndependent` is what a stealth pass branches on. Nothing on a `DetectionMode` declares it, so
this is a registry. An unregistered id answers `null`, not `false` — *this sense ignores light* and
*we have never heard of this sense* are different answers.


# The scene's light level

| Function | |
| --- | --- |
| `api.sceneTier(scene?)` | The scene's tier, defaulting to `canvas.scene`. The stored tier where the scene was set through this module, the nearest rung to its raw darkness where it was not |
| `await api.setSceneTier(tier, scene?)` | Sets it. Returns the tier set, or `null`. **GM only**, and refused on a darkness-locked scene |
| `api.sceneTierUpdate(tier)` | The update `setSceneTier` would write, as a flat object, or `null` for a tier a scene can't hold. For adding the tier to an update of your own. Does **not** check the darkness lock |

`Scene#_preUpdate` silently deletes `environment.darknessLevel` from an update when the lock is set,
so the refusal is the only honest answer. The lock means frozen, not "ignore the clock" — a locked
scene cannot be changed from the dropdown either.


# Light effects

Control *light* or *darkness* effects that are attached to actors, tokens, tiles, or templates.
Configured effects are separate and independent from a token's own light configuration, and multiple
effects can be stacked on a single target.

| Function | |
| --- | --- |
| `await api.lights.apply(anchor, effect)` | Attach an effect. Returns its **id**, or `null` if nothing was applied |
| `await api.lights.clear(anchor, ref)` | Remove an effect. `ref` is an id **or** `{ source: uuid }`. Returns how many came off |
| `await api.lights.clearAll(anchor)` | Remove every effect. Returns how many were removed |
| `api.lights.list(anchor)` | The effect records currently on an anchor |
| `await api.lights.place(point, options)` | Create an `AmbientLight`. **Not an effect** — see below |

`anchor` takes a `Token`, `TokenDocument`, token id, `Tile`, `MeasuredTemplate`, or an array of any
of them. It can also accept an `Actor`, which will apply to all linked tokens (primary use case for
buffs that apply light or darkness effects). Bare points are not anchors; use `place`, which places
an actual light object on the scene.

## The effect

Every field is optional.

| Field | |
| --- | --- |
| `preset` | A key from the preset table — `"torch"`, `"darkness"`, `"daylight"`… Resolved **once**, at call time |
| `light` | `LightData` overrides on top of the preset: `{ bright, dim, color, angle, negative, … }`. Radii in scene units |
| `config` | Module overrides: `{ kind, level, emitTier, steps, cap, cancelsDarkness, transform, floor }` |
| `label` | What the effect is called in readouts. Defaults to the preset's label |
| `source` | The uuid that owns this effect (displays in light effects list) |
| `id` | Defaults to one derived from `source`. **Applying the same id twice replaces rather than stacks** |
| `expires` | A world-time stamp in seconds. Omit for untimed effects |
| `followRotation` | Turn the light with the anchor's facing, for lights with limited cones |

## `source`

Pass the owning document's uuid and `clear` takes the same uuid back, so a toggle does not have to
record what it created:

```js
const api = game.modules.get("pf1-lighting")?.api;
if (state) await api.lights.apply(actor, { preset: "light", source: item.uuid, label: item.name });
else await api.lights.clear(actor, { source: item.uuid });
```

An effect whose `source` no longer resolves — the item deleted, the owning buff switched off — is
removed by a GM-side sweep on world load and on scene change. An effect with **no** `source` is never
swept and lasts until something clears it.

## Ownership

Checked on the GM's side against the caller. For a token that is its **actor's** ownership: a player
can light their own character and cannot light an NPC. A refusal is a warning notification and a
`null` return, never a silent no-op.

To light something the caller does not own, raise a prompt for a GM instead of calling `apply`. An
item with an on-use light descriptor already does this — the chat card carries the button.

**Every write is performed by the active GM.** With no GM connected nothing happens and the caller is
told. Records live in a document flag, so the single writer also keeps two clients'
read-modify-writes from overwriting each other.

## `place`

```js
await api.lights.place({ x, y }, { preset: "torch" });   // → the AmbientLightDocument
```

Creates an ordinary `AmbientLight` on the scene — permanent, selectable, and editable in the light
config sheet. It is not an effect: it has no anchor, carries no `source`, and does not appear in
`list`. GM only.


# Withheld regions

Hide areas of the map from a particular observer: what they reveal there stays fogged and is never
explored, as if a wall stood in the way. The areas are yours to compute; this module only carves
them out of what each observer sees. Purely visual: brightness, perception and token detection are
unaffected, so if tokens standing in a hidden area should be hidden too, that is the caller's job.

Feature-detect with `api.withheld !== undefined`.

| | |
| --- | --- |
| `api.withheld.register(id, provider, { layers })` | Register a provider. Returns a function that unregisters it |
| `api.withheld.unregister(id)` | Remove a provider |
| `api.withheld.invalidate()` | Your provider's output changed for a reason other than an observer moving: a setting, your own data. Triggers a vision refresh |
| `api.withheld.active()` | `true` while the carve is installed, which is always while this module is enabled |
| `api.withheld.LAYERS` | `{ LIGHT: "light", SIGHT: "sight" }` |
| `api.withheld.generation` | A counter that changes whenever any provider's output may have |

**`provider(visionSource)`** returns an array of `PIXI.Polygon` to hide from that observer, or
`null`. Polygons may overlap. It is called during every visibility refresh, so it must be cheap when
called again for the same `visionSource.los`, which Foundry replaces (never mutates) whenever the
observer moves or the walls change: cache on that object. A provider that throws is logged once and
contributes nothing until `invalidate()`.

**`layers`** chooses what is hidden, both by default:

| Layer | Hides |
| --- | --- |
| `"light"` | What the observer sees by light |
| `"sight"` | What the observer sees without light: darkvision and the like |

Hidden from both, an area is also painted as unseen ground: fogged at the scene's darkness, with the
light-level readout reporting fog rather than a level.

Register at `setup` or later; the API is published during this module's own `init`, and modules'
`init` hooks do not run in dependency order.

```js
const api = game.modules.get("pf1-lighting")?.api;
// Hide a 200 px square in front of every observer (a test, not a use case).
api.withheld.register("my-module.test", (source) => {
  const { x, y } = source.origin;
  return [new PIXI.Polygon([x + 100, y - 100, x + 300, y - 100, x + 300, y + 100, x + 100, y + 100])];
});
```


# Revealed regions

The opposite of withheld regions: show a particular observer areas beyond what it can normally see.
A revealed area is lit like any other ground (dark where no light reaches, within darkvision range
for darkvision), counts as seen ground, and is never explored: once the reveal ends, the area returns
to whatever fog it had. Withheld regions do not apply to it: they carve what the observer sees of the
ground, and a reveal is something your provider has already decided is seen. Purely visual, as with
withheld regions.

Feature-detect with `api.revealed !== undefined`.

| | |
| --- | --- |
| `api.revealed.register(id, provider, { layers })` | Register a provider. Returns a function that unregisters it |
| `api.revealed.unregister(id)` | Remove a provider |
| `api.revealed.invalidate()` | Your provider's output changed for a reason other than an observer moving. Triggers a vision refresh |
| `api.revealed.active()` | `true` while reveals are drawn, which is always while this module is enabled |
| `api.revealed.LAYERS` | `{ LIGHT: "light", SIGHT: "sight" }` |
| `api.revealed.generation` | A counter that changes whenever any provider's output may have |

**`provider(visionSource)`** returns an array of `PIXI.Polygon` to reveal to that observer, or
`null`, with the same caching contract as withheld regions. Reveals beyond the observer's range for a
layer (its light-perception range for `"light"`, its sight range for `"sight"`) are trimmed off.

**Raised surfaces.** Set `elevation` on a returned polygon (`polygon.elevation = 15`) when it shows
something above the ground, such as a rooftop. Its `"light"` reveal then shows only where light
reaches that height: lights at or above it, or global illumination when the scene is bright enough
to light roofs. Without it, a lamp inside a building would count as lighting the roof above it.

**`layers`** chooses what is revealed, both by default: `"light"` shows the area where light reaches
it, `"sight"` within darkvision. Revealed on both, the area is also painted as seen ground.

```js
const api = game.modules.get("pf1-lighting")?.api;
// Show every observer a 200 px square beyond a wall (a test, not a use case).
api.revealed.register("my-module.test", (source) => {
  const { x, y } = source.origin;
  return [new PIXI.Polygon([x + 300, y - 100, x + 500, y - 100, x + 500, y + 100, x + 300, y + 100])];
});
```


# Unexplored regions

Parts of an observer's view that show normally but are never recorded in fog of war. Use it for
things the observer sees over or onto without seeing into, such as a roof seen from above: the roof
shows, and the room under it stays unexplored until someone actually sees inside. Purely about fog:
light, the light level tooltip, and token visibility treat the area as seen.

Feature-detect with `api.unexplored !== undefined`.

| | |
| --- | --- |
| `api.unexplored.register(id, provider, { layers })` | Register a provider. Returns a function that unregisters it |
| `api.unexplored.unregister(id)` | Remove a provider |
| `api.unexplored.invalidate()` | Your provider's output changed for a reason other than an observer moving. Triggers a vision refresh |
| `api.unexplored.active()` | `true` while the split is applied, which is always while this module is enabled |
| `api.unexplored.LAYERS` | `{ LIGHT: "light", SIGHT: "sight" }` |
| `api.unexplored.generation` | A counter that changes whenever any provider's output may have |

**`provider(visionSource)`** returns an array of `PIXI.Polygon` to keep out of fog for that observer,
or `null`, with the same caching contract as withheld regions. Withheld regions still win: a part of
the view another provider withholds stays hidden, kept or not.

# Hooks

| | |
| --- | --- |
| `api.TIER_CHANGED_HOOK` | `"pf1-lighting.sceneTierChanged"` |

```js
Hooks.on("pf1-lighting.sceneTierChanged", (scene, tier, previous) => {
  // ...
});
```

Fires only when the level changes rung, from any source — the scene config dropdown, a
lighting-control button, or `setSceneTier`.


# Cost

**`perceive` and `perceivedBy` cost a polygon sweep per observer that is not currently a vision
source** — which is most NPCs, since Foundry only builds vision for tokens the current user controls.
The API builds a throwaway source, never registered on the canvas, and reports `ephemeral: true` when
it did. Affordable once per die roll for a scene's worth of NPCs; too slow on a movement hook.

**Batch brightness queries.** The field rebuilds when the scene changes, so one call with ten subjects
pays for that once where ten calls pay ten times.

```js
const tiers = api.brightnessOf(tokens);            // one field build
const tiers = tokens.map((t) => api.brightnessOf(t));  // ten
```

# Examples

A stealth check that asks who could have noticed, and why:

```js
const api = game.modules.get("pf1-lighting")?.api;
if (!api || api.version !== 1) return;

// The hider gets the darkest square they occupy.
const watchers = api.perceivedBy(hider, { sample: "min" });

for (const w of watchers) {
  if (!w.visible) continue;

  // A sense that ignores light gets no concealment bonus from the dark.
  const concealed = !w.lightIndependent && w.tier <= api.TIER.DARK;

  console.log(
    `${w.observer.name} sees ${w.observed.name} via ${w.reason}` +
    ` at ${w.tierName}, ${w.distance} ft` +
    (concealed ? " — but it is dark enough to hide in" : "")
  );
}
```

A day/night driver that respects the lock:

```js
for (const scene of game.scenes) {
  // Returns null on a darkness-locked scene; nothing else to check.
  await api.setSceneTier(api.TIER.DARK, scene);
}
```

Light-based concealment for one attacker against one target:

```js
const [{ visible, tier, lightIndependent }] = [api.perceive(attacker, target)].flat();
if (visible && !lightIndependent && tier <= api.TIER.DIM) {
  // 20% miss chance in dim light, total concealment in the dark.
}
```

Reacting to the scene going dark:

```js
Hooks.on(game.modules.get("pf1-lighting").api.TIER_CHANGED_HOOK, (scene, tier, previous) => {
  if (tier <= api.TIER.DARK && previous > api.TIER.DARK) ui.notifications.info("Night falls.");
});
```
