# PF1 Lighting — API

For module and macro authors. Everything a GM needs is in [README.md](README.md); the console debug
surface is in [DEBUGGING.md](DEBUGGING.md).

```js
const api = game.modules.get("pf1-lighting")?.api;
```

That is the address. It is published at **`init`**, so it is there for your `setup` and `ready` alike
— an API published at `ready` races every consumer's own `ready` on module load order, which makes
its existence depend on alphabetical luck.

`game.pf1Lighting.api` is the same frozen object under a shorter name for console use. It exists only
because `pf1-lighting.api` cannot be typed in JavaScript — the hyphen is a minus sign, so it parses as
`pf1 - lighting.api`.

> **Bind to `api`, not to `game.pf1Lighting`.** Everything else on `game.pf1Lighting` is a debug
> readout: it logs, its fields change whenever a diagnosis needs them, and several entries hand back
> live internals. A consumer that binds to it will break, and should.

---

## Contents

- [Versioning](#versioning)
- [Tiers](#tiers)
- [Arrays in, arrays out](#arrays-in-arrays-out)
- [Brightness](#brightness)
- [Sampling](#sampling)
- [Who can see whom](#who-can-see-whom)
- [The scene's light level](#the-scenes-light-level)
- [Hooks](#hooks)
- [Cost](#cost)
- [What is deliberately not here](#what-is-deliberately-not-here)

---

## Versioning

```js
api.version   // 1
```

Incremented on a **breaking** change only — a removed function, a changed return shape, or a changed
meaning. Added fields and new functions do not move it. Feature-detect on this rather than on the
module's own version.

---

## Tiers

Tiers cross the boundary as **ordered numbers**, so `>=` means what it looks like.

```js
api.TIER
// { SUPERNATURAL_DARK: 0, DARK: 1, DIM: 2, NORMAL: 3, BRIGHT: 4 }

api.tierName(2)        // "Dim"
api.tierName(99)       // null
```

`tierName` returns the module's own English names, deliberately untranslated, so a script that keys
off them keeps working whatever language the table plays in. If you need a localised label, use
`game.i18n.localize("PF1LIGHTING.Tier.Dim")` and friends.

---

## Arrays in, arrays out

**Every query takes one subject or an array of them, and the return shape follows the argument.** An
array in gives an array out; a scalar gives a scalar.

That is not just ergonomics. The model rebuilds its field when the scene changes, so ten separate
calls can pay for that ten times where one call with ten subjects pays once.

```js
api.brightnessOf(token)          // 3
api.brightnessOf([a, b, c])      // [3, 1, 2]
```

[`perceive`](#who-can-see-whom) is the one exception and says so: it returns one record per
(observer, observed) pair, so a matrix has no scalar shape.

### What counts as a subject

Anywhere a point or a token is taken, all of these work:

| You have | Accepted |
| --- | --- |
| `{ x, y }` or `{ x, y, elevation }` | ✅ |
| A `Token` (canvas placeable) | ✅ — its centre |
| A `TokenDocument` (what a hook hands you) | ✅ — resolved to its placeable |
| A token id string | ✅ — looked up on the current canvas |

Elevation is carried and then ignored: the model is flat. It is taken anyway so the signature does not
have to change on the day that stops being true.

---

## Brightness

```js
api.brightnessAt(point)                        // the tier there, as the GM sees it
api.brightnessAt(point, { observer: token })   // as that token sees it
api.brightnessOf(token, { sample: "min" })     // the tier a token is standing in
api.brightnessInSquare(point)                  // the grid square, by the same rule a token uses
```

All three return a `TIER` value, or an array of them.

### `observer` asks a different question

Omitting `observer` gives the **god's-eye** answer: the map's own light level, what a GM sees, what
the readout reports. Passing one gives what that creature can actually **see by** — clamped by any
magical darkness between the observer and the point.

They are two answers, not a default and a refinement:

```js
api.brightnessAt(p)                       // 4 — the room is brightly lit
api.brightnessAt(p, { observer: rogue })  // 1 — the rogue is looking through a darkness
```

### `brightnessInSquare`

Snaps to the grid space containing the point and evaluates its centre — **the same rule a token
gets**, so a token and the square it stands in cannot disagree. It exists as a separate function
rather than leaving callers to snap themselves precisely because the snapping rule is the module's to
keep consistent.

---

## Sampling

```js
api.SAMPLE   // { CENTER: "center", MIN: "min", MAX: "max" }
```

How a subject occupying more than one square resolves to a single tier. Accepted by `brightnessOf`,
`perceive` and `perceivedBy`.

| `sample` | Rule | Use for |
| --- | --- | --- |
| `"center"` (default) | The token's centre point | Everything ordinary. Matches the readout and a grid square |
| `"min"` | The darkest square the token occupies | **The hider's rule** |
| `"max"` | The brightest square it occupies | **The spotter's rule** |

A Large creature straddling a boundary genuinely has no single answer, and the stealth case is
asymmetric — a creature hides in the darkest square it occupies and is spotted from the brightest. So
`min` and `max` are opt-in and nothing defaults to them.

There is deliberately no `average`: averaging tiers and re-thresholding produces a number that matches
no rule in the game.

---

## Who can see whom

```js
api.perceive(observer, target)                // one pair → one record
api.perceive([a, b], [x, y])                  // → 4 records, each naming both ends
api.perceivedBy(token, { sample: "min" })     // the stealth call
```

### `perceivedBy(observed, options)`

Every token on the scene that might see `observed`, sorted so the ones that **can** see come first and
the brightest perception first within that — because the caller's next step is almost always to
partition the list.

| Option | Default | |
| --- | --- | --- |
| `observers` | every other token on the scene with sight enabled | Narrow it yourself: *which* NPCs are entitled to notice is a table question, not the module's |
| `sample` | `"center"` | `"min"` is the hider's rule |

One field build and one sweep per candidate, rather than N calls each paying for both.

### The record

Both calls return records of the same shape:

| Field | |
| --- | --- |
| `observer`, `observed` | The two `Token`s |
| `visible` | Boolean |
| `reason` | **Which sense did it** — the first mode that succeeded, or `null` |
| `reasons` | *Every* mode that would have succeeded, in core's own order |
| `tier` | The tier the observer perceives the target at |
| `tierName` | Its English name |
| `lightIndependent` | Whether `reason` cares about light at all. `null` = unregistered mode |
| `blinded` | Whether the observer's vision source is blinded |
| `distance` | In scene units, to 2dp |
| `losBlocked` | Whether a wall is between them |
| `ephemeral` | The observer had no live vision source, so one was built for the question — this is also the expensive path |

Foundry itself will only tell you yes or no, and it short-circuits on the first mode that succeeds.
The **why** is the part this adds: a target hidden behind a wall and a target hidden by darkness need
different rulings, and `visible: false` alone cannot tell them apart.

Known `reason` values include `basicSight` (where PF1 puts darkvision, and where blindsight rides
in), `lightPerception`, `feelTremor`, `seeInvisibility`, and `visionLight` — a vision-granting light
source, which is a fourth route core tests before any detection mode. It has no mode id and no
observer, so it reveals to everyone equally.

### Teaching it about a custom sense

```js
api.registerLightIndependentMode("myBlindsense");   // → the full set
```

`lightIndependent` is the field a stealth pass actually branches on: for these observers the light
tier is irrelevant, so a hider in pitch darkness is no better off than one in daylight. There is
nothing on a `DetectionMode` that declares this, so it is a registry rather than a detection. An
unregistered id answers `null` rather than `false`, so a consumer can tell *this sense ignores light*
from *we have never heard of this sense*.

---

## The scene's light level

```js
api.sceneTier()                         // → a TIER value; defaults to canvas.scene
api.sceneTier(someScene)
await api.setSceneTier(api.TIER.DIM)    // → the tier set, or null
await api.setSceneTier(api.TIER.DARK, someScene)
```

`sceneTier` reads the stored tier where the scene has been set through this module, and the nearest
rung to its raw darkness where it has not. A caller cannot tell those apart and does not need to —
both are the answer to *what light level is this scene*.

`setSceneTier` is **GM only** and is **refused on a darkness-locked scene**, returning `null`. That
is not a courtesy check: `Scene#_preUpdate` silently *deletes* `environment.darknessLevel` from an
update when the lock is set, so writing anyway would report success and change nothing.

That makes the lock the natural filter for a time-of-day driver, with one consequence worth knowing:
**it means frozen, not "ignore the clock"**. A locked dungeon cannot be changed by a GM from the
dropdown either.

---

## Hooks

```js
api.TIER_CHANGED_HOOK   // "pf1-lighting.sceneTierChanged"

Hooks.on("pf1-lighting.sceneTierChanged", (scene, tier, previous) => {
  // ...
});
```

Fires only when the level actually changes rung, from **any** source — the scene config dropdown, a
lighting-control button, or `setSceneTier`. Use it instead of watching `updateScene` and working the
tier out yourself.

---

## Cost

Two things in this API are expensive, and both are named rather than hidden behind a cache that would
go stale on the first wall.

**`perceive` and `perceivedBy` cost a polygon sweep per observer that is not currently a vision
source** — which is most NPCs, since Foundry only builds vision for tokens the current user controls.
`Token#initializeVisionSource` destroys the source whenever `_isVisionSource()` is false, so
`token.vision` is `undefined` precisely when the question is worth asking. The API builds a throwaway
one (never registered on the canvas, so nothing needs cleaning up), and reports `ephemeral: true` when
it did.

Affordable **once per die roll** for a scene's worth of NPCs. Far too slow on a movement hook.

**Batch your brightness queries.** `evaluate` reads the field, and the field rebuilds when the
registry version moves — that is why every call takes an array.

```js
// Good
const tiers = api.brightnessOf(tokens);

// Bad
const tiers = tokens.map((t) => api.brightnessOf(t));
```

---

## What is deliberately not here

> Expose a question only this module can answer, or an answer only this module can assemble cheaply.
> Everything else stays core's.

Distance, wall collisions, ownership and the raw `scene.environment.darknessLevel` are all core's and
are absent. What is here is the tier ladder, the observer-relative answer, and the **assembly** — one
call that returns what a stealth check needs instead of nine.

Also absent, and by design:

- **A preset matcher.** A light stores *which* preset filled its fields in; that is history, and it is
  not recoverable by looking at the numbers afterwards.
- **A settings surface.** The module's own settings are not part of the contract. If you need one,
  `game.settings.get("pf1-lighting", key)` still works — see [DEBUGGING.md](DEBUGGING.md) for the
  keys — but nothing promises it will keep working.
- **Rendering control.** How the map is drawn is the GM's, through the settings windows.

---

## A worked example

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

And a day/night driver that respects the lock:

```js
for (const scene of game.scenes) {
  // Returns null on a darkness-locked scene; nothing else to check.
  await api.setSceneTier(api.TIER.DARK, scene);
}
```
