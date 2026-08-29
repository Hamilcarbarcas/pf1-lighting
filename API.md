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
- [Who can see whom](#who-can-see-whom)
- [The scene's light level](#the-scenes-light-level)
- [Hooks](#hooks)
- [Cost](#cost)
- [Not in the API](#not-in-the-api)
- [Examples](#examples)


# Versioning

| | |
| --- | --- |
| `api.version` | `1`. Incremented on a **breaking** change only |

Feature-detect on this rather than on the module's own version.


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

`Scene#_preUpdate` silently deletes `environment.darknessLevel` from an update when the lock is set,
so the refusal is the only honest answer. The lock means frozen, not "ignore the clock" — a locked
scene cannot be changed from the dropdown either.


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
