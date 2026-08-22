# pf1-lighting — Design

**Status:** design complete, no code written. Next step is the §8.1 vertical slice.
**Last revised:** 2026-08-21.

Source of truth. Update this file when decisions change; rejected alternatives live in
Appendix A so the body stays readable.

---

## 1. The whole thing in one page

**Light level is a number, computed in JS, for a given observer at a given point. The
renderer is told what to draw from that number — never the other way round.**

```
B ∈ [0,1]                          brightness, the primary quantity
tier = threshold(B)                Bright / Normal / Dim / Dark / Supernatural Dark
```

Everything is one pipeline:

```
evaluate(point, observer) →

  1.  gather   E = emitters, S = suppressors covering point, filtered by observer
  2.  LLV      scale E's radii for this observer          (geometric, pre-contest)
  3.  base     B = max over E of each emitter's ramp at point
  4.  contest  highest-level effect in E ∪ S wins; equal levels cancel
  5.  path     if the sightline crosses a path-blocking suppressor, apply its transform
  6.  vision   darkvision overrides the resolved tier      (post-contest)
```

Three things make this harder than it sounds, and each maps to one part of the design:

| Problem | Where it's solved |
| --- | --- |
| Foundry's light level is per-**point**; ours is per-**(observer, point)** | §5 observer resolution |
| Foundry blends light with unordered `MAX_COLOR`; our rules are ordered | §4.1 contest, resolved in JS *before* rendering |
| "Looking **through** darkness" has no representation in Foundry at all | §4.3 umbra |

The renderer (§6) then takes the resolved field, clips real light sources to it, and
adds synthetic sources only where no real source exists. Because the field is resolved
into **disjoint** regions first, Foundry's max-blending can't corrupt the ordering.

---

## 2. Why

### 2.1 What Foundry does

Light sources rasterise once per client into shared buffers with `MAX_COLOR` blending
(`base-light-source.mjs` `_layers`) — an unordered max over a continuous field, with no
observer in the picture anywhere.

### 2.2 What we need

An ordered, observer-filtered field with five discrete rule tiers. The mismatch is one
of **algebra, not missing features** — which is why the current scene-regions +
`limits` setup can't be configured into doing it.

Secondary problems this also fixes:

- PF1's low-light vision is a **global light-radius multiplier** keyed to which tokens
  happen to be selected (`pf1/module/canvas/low-light-vision.mjs` `LLVMixin.getRadius`).
- PF1 has **no concealment or miss-chance code at all** — only compendium prose and two
  roll tables. No mechanical hook for light level exists.
- Global illumination is unconditional and cannot be occluded or filtered.

### 2.3 The motivating failure case

A token with darkvision 60 ft looks across an area of magical darkness. `limits`
correctly clips its sight to 60 ft (`limits/scripts/canvas/sources/vision.mjs`
`_createShapes` / `_testLimit`). But the lit ground *beyond* the darkness, still inside
60 ft, renders fully bright — when it should be dark, because the observer is looking
**through** magical darkness to see it.

Both halves are individually correct. The lighting buffer says "globally illuminated";
the vision polygon says "visible". What's missing is attenuation along the
observer→point path, which Foundry has no concept of. Solved in §4.3.

---

## 3. The model

### 3.1 Brightness and tiers

**`B` ∈ [0,1] is primary. Tiers are a thresholding of it.** Thresholds are settings.

| `B` | Tier | `LIGHTING_LEVELS` |
| --- | --- | --- |
| > 0.9 | Bright | `BRIGHTEST` (3) |
| > 0.5, ≤ 0.9 | Normal | `BRIGHT` (2) |
| > 0.1, ≤ 0.5 | Dim | `DIM` (1) |
| ≤ 0.1 | Dark | `UNLIT` (0) |
| pinned 0 | Supernatural Dark | `DARKNESS` (-2) |

Brightness-primary rather than discrete tiers because the renderer is already
continuous — so the picture and the mechanics derive from one scalar instead of two
things kept in agreement. Tier boundaries become isosurfaces of a field rather than
geometry, which is what §6.2 depends on.

`HALFDARK` (-1) is **not spare** — it is the darkness ramp's outer band. See §3.3.1.

**Supernatural Dark is not a point on the ramp.** It renders on Foundry's separate
`darkness` layer via `AdaptiveDarknessShader`, default colour `#8651d5`
(`darkness-lighting.mjs:43`). `B` pinned to 0 *and* drawn by the darkness shader;
Foundry already keeps these separate.

**`B` is defined on the lighting model, never the rendered pixel.** `exposure`,
`contrast`, `saturation` and vision-mode tints are presentation and must not feed the
tier — otherwise nudging a torch's luminosity would silently change concealment. Note
`exposure = luminosity · 2 − 1` (`base-light-source.mjs:218`), which puts luminosity on
the presentation side. Rationale: PF1 specifies a torch by radii (20 ft normal / 40 ft
dim), not by glow.

### 3.2 Emitters

```
Emitter {
  shape      : polygon provider (Foundry's wall sweep — occlusion is free)
  radii      : { bright, normal, dim }        see §3.2.1
  kind       : "ambient" | "mundane" | "magical"
  level      : integer                        spell level for magical; else 0
  targeting  : { include: [tokenId], exclude: [tokenId] } | null
  samples    : integer = 1                    >1 = area light (§7.2)
}
```

- `ambient` — sun, moon, stars, global illumination
- `mundane` — torches, candles, lanterns, sunrods
- `magical` — spell effects; `level` drives the §4.1 contest

#### 3.2.1 Three zones — the added one is Bright, innermost

**Foundry's two native radii already are our Normal and Dim.** Foundry `bright` = our
Normal, Foundry `dim` = our Dim. A PF1 torch at Foundry `bright: 20 / dim: 40` is
exactly Normal 20 / Dim 40 — what the rules say a torch does.

So we **add a Bright radius, innermost, defaulting to 0** — not a Normal radius in the
middle. It lives in flags (`LightData`'s schema is fixed), read by our source subclass,
with config UI beside the native fields.

| Zone | `B` range |
| --- | --- |
| bright | 1.0 → 0.9 |
| normal | 0.9 → 0.5 |
| dim | 0.5 → 0.1 |
| taper | 0.1 → 0 |

The ramp, per source, at distance `d`:

```
d ≤ rB :  B = mix(1.0, 0.9, d / rB)               omit when rB = 0
d ≤ rN :  B = mix(0.9, 0.5, (d − rB) / (rN − rB))
d ≤ rD :  B = mix(0.5, 0.1, (d − rN) / (rD − rN))
else   :  B = 0.1 → 0 taper
```

Consequences:

- **No migration.** Every existing light is already correct; the new field defaults to
  0. (A middle radius would have required touching every light in the world.)
- **Bright is rare** — in PF1 only daylight and direct sun — so nearly every light is
  genuinely two-zone, which is exactly what Foundry's native renderer draws. This is
  why §6.3 needs no custom shader.
- **Centre value.** With `rB = 0` a light's centre reads `B = 0.9`, not `1.0`. Start
  the ramp at 0.9 rather than treating the first segment as degenerate.

**The three zones are mechanical only.** The renderer keeps Foundry's native two-zone
gradient (§6.3). The third radius is a flag, `evaluate()` reads flags, and the shader
is not in the mechanics path at all.

### 3.3 Suppressors

```
Suppressor {
  shape        : polygon provider
  transform    : { op: "reduce", steps: n } | { op: "clamp", max: tier }
  eligibility  : predicate(Emitter) -> bool     which emitters it removes
  level        : integer
  floor        : tier = DARK                    lowest tier it can reach
  blocksPath   : bool                           participates in §4.3 umbra
  targeting    : { include: [tokenId], exclude: [tokenId] } | null
  stacks       : bool = false                   see §4.2
}
```

**A suppressor does two separate things, and conflating them is a bug.** *Darkness* both
**removes** eligible light sources and **drops** the resulting illumination one step.
Eligible sources are not dimmed — they stop counting entirely: *"nonmagical sources of
light, such as torches and lanterns, do not increase the light level in an area of
darkness."*

Found in testing 2026-08-21. An earlier `contest` folded the two together, taking a max
over every emitter and reducing that once, so three torches inside a *darkness* resolved
to Dim instead of Dark. Three categories, not two:

| Category | Test | Effect |
| --- | --- | --- |
| **counters** | ineligible, magical, level above the suppressor's | defeats it outright; light untouched |
| **blocked** | eligible per the preset | contributes nothing at all |
| **passthrough** | everything else — ambient | contributes, and *is* transformed |

`floor` **defaults to Dark.** Not everything capable of darkening an area is capable of
*supernatural* darkness; reaching it is an explicit opt-in per source, which is what
distinguishes *deeper darkness* from *darkness*.

*Darkness* (2nd level): `transform = reduce 1`, `level = 2`, `floor = DARK`,
`blocksPath = true`, `eligibility = kind === "mundane" || (kind === "magical" && level <= 2)`.
Ambient light isn't eligible, so it is *not removed* — but it is still transformed, which
is what makes the spell do something outdoors. 3rd-level *daylight* isn't eligible either
**and** out-levels the spell, so it counters it outright.

`eligibility` (which emitters get blocked, by kind) is **orthogonal** to the §4.1
contest (what happens among effects that do interact).

**Authoring:** no GM writes a predicate. Ship presets — Darkness, Deeper Darkness, Fog
— as a dropdown, with a raw override behind an advanced toggle.

**`blocksPath` scope:** only zones that *reduce light sources* participate, and those
are exclusively magical — walls already handle mundane occlusion. The flag is close to
definitional, and it is what bounds §4.3's cost to scenes that actually contain magical
darkness.

#### 3.3.1 Two-band darkness sources

`PointDarknessSource` declares `_dimLightingLevel = HALFDARK` and
`_brightLightingLevel = DARKNESS` (`point-darkness-source.mjs:22-25`) — mirroring a
light's `BRIGHT`/`DIM` pair. A dark core with a partially-dark rim.

It never renders, because `_initialize` collapses the radii
(`point-darkness-source.mjs:117`):

```js
this.data.radius = this.data.bright = this.data.dim = Math.max(this.data.dim ?? 0, this.data.bright ?? 0);
```

One radius, so no outer band — and downstream `HALFDARK` is aliased to `DIM` anyway
(`rendered-effect-source.mjs:583-584`).

**We don't inherit that collapse.** Un-collapsing gives a real two-band darkness source,
so *darkness* has a soft rim instead of a razor edge.

Note `CONFIG.Canvas.lightLevels` holds **mix fractions, not brightness values** —
`halfdark: 0.5` means "half way back from full darkness toward ambient", which is why
it reads larger than `dim: 0.25` despite being darker (`environment.mjs:231-232`).

### 3.4 Derived emitters — diffuse spill

*Poor-man's diffuse lighting.* A wedge of light entering a dark room cuts a hard shadow
line at the wall; stepping one square sideways out of a doorway shouldn't drop you into
pitch black.

**Mechanically real, not a render trick** — these are emitters in the model and flow
through the pipeline like any other, so `evaluate()` sees them.

```
SpillEmitter {
  source     : the emitter whose shadow edge this spills from
  bandWidth  : distance per tier step (config, default 10 ft / 2 squares)
  clip       : polygon the spill may not escape
}
```

- **Bands step down from the tier at the edge**, not to fixed tiers. Bright edge →
  normal → dim → ambient; a *dim* edge goes straight to ambient. Absolute bands would
  produce spill brighter than the light casting it.
- **Max-combine only — spill may raise a light level, never lower it.** This is what
  makes it safe. Dilation ignores occlusion so a band can leak, but leaking can only
  make somewhere too bright. A too-bright corner is cosmetic; a too-dark one hides a
  creature.
- **Occlusion fix:** clip the bands to the aperture's own sweep (§7.1 computes it
  anyway). Anything visible from the doorway gets spill; anything behind the wall
  doesn't.
- **Observer-independent** — depends on geometry and the light, not on who's looking.
  Compute once into the god's-eye field and cache; re-derive on light/wall changes, not
  on token movement. Being an emitter, §4.4 low-light vision extends it like any other.

The fully general case — any wall-cut shadow edge, e.g. a torch behind a pillar — has no
cheap correct form. Options are one sweep per silhouette vertex, or §7.2 multi-sampling.
**Apertures first; general case behind a flag.**

### 3.5 Where sources come from

Split by the nature of the thing, feeding one internal representation.

| Thing | Placement | Why |
| --- | --- | --- |
| Darkness / deeper darkness | **AmbientLight, `negative: true`** + flags | radial, temporary, sometimes mobile |
| Darkness on a carried object | **Token light, `negative: true`** + same flags | same `LightData` schema — moves for free |
| Torches, lanterns, light spells | AmbientLight / token light + flags | native |
| Indoor keepouts, architecture | **RegionBehavior** | arbitrary shape, elevation, static |

Why light documents rather than regions for spells:

- Foundry instantiates them as `PointDarknessSource` automatically — darkness layer,
  purple, correct compositing, free.
- The native `priority` field exists and is wired into darkness-vs-light suppression
  (`common/data/data.mjs:43`, `point-darkness-source.mjs:89`). **Do not treat it as a
  route to making native behaviour match the contest** — see §4.1.1, the two models are
  irreconcilable and native suppression gets disabled. `priority` remains useful for
  darkness-vs-darkness ordering.
- Two radii available for §3.3.1.
- Token light shares the schema, so mobile darkness needs no separate path.

```js
flags["pf1-lighting"] = {
  kind: "magical",
  level: 2,                            // → also mirrored into native `priority`
  transform: { op: "reduce", steps: 1 },
  eligibility: "preset:darkness",
  blocksPath: true,
  targeting: { include: [], exclude: [] }
}
```

Darkness = reduce 1 / level 2. Deeper darkness = reduce 2 / level 3. PF1's "does not
stack with itself; counters light of equal or lower level" is §4.1 exactly, so RAW falls
out without special-casing.

**Implementation note:** `#updateLightSuppression` is genuinely private and can't be
overridden — but it's called from `_createShapes()`, which we override anyway for
polygon injection, so we control whether it runs.

### 3.6 Scope boundary — 2D

**Explicitly planar.** `limits` does full 3D raycasting and v13 puts elevation on every
placeable, so this is a deliberate punt. Sources carry elevation for region containment
tests; the field itself is 2D. Revisit only for multi-level maps.

---

## 4. Resolution rules

### 4.1 Precedence contest

Every emitter and suppressor carries a `level`. In any overlap:

1. Take the highest `level` among interacting effects.
2. That effect determines the result.
3. **Equal levels go to the suppressor** — a level-2 magical light inside a level-2
   *darkness* is blocked like any other eligible source.

No composition, no ordering, no tiebreak.

> **Corrected 2026-08-21.** This rule previously read "equal levels cancel, leaving
> ambient", and the code had a branch for it. That was wrong: darkness blocks magical
> light *of its own level or lower*, so equal level is the ordinary blocked case and needs
> no special handling. The branch is gone — the `darkness` eligibility preset's
> `level <= suppressor.level` already covers it.
>
> Mutual annihilation is real but belongs to exactly one effect, *daylight*, which is
> level 3 against a level-2 *darkness* — unequal. See §4.1.2.

### 4.1.2 *Daylight* — mutual annihilation

Three distinct ways a light can beat a darkness, and they are easy to run together:

| | Effect on the darkness | Effect on the light |
| --- | --- | --- |
| **Blocked** (mundane, or magical ≤ level) | none — darkness prevails | removed entirely |
| **Counters** (magical > level) | overridden in the light's radius | shines normally |
| **Annihilates** (*daylight*) | negated in the overlap | **also** contributes nothing there |

The third is *daylight*'s special case and the only one where the light suppresses
itself. In the overlap **neither spell has any effect**: other sources in that region
light it normally and unsuppressed, exactly as if neither had been cast.

Authored as `cancelsDarkness: true` on the emitter — a checkbox in the light config,
since nothing about a light's own data implies it. It cancels suppressors of its own
level or lower, and is only *spent* if it actually cancelled something: a *daylight* with
no darkness near it is simply a bright light.

Implemented as a **pre-pass**, not a branch. It decides which effects reach the contest
at all, so it runs before precedence is considered.

**Geometry is outstanding.** `contest` handles this per point, so `evaluate()` is
correct. `field()` is not yet: annihilation carves a region out of *both* the suppressor
and the canceller, which the subdivision does not model. Three additions:

1. Subtract the canceller's polygon from each suppressor region it cancels, before
   `carveRegions` runs its precedence pass.
2. Subtract those same suppressor polygons from the canceller's own `clip` cell — the
   *daylight* stops emitting exactly where it cancelled something.
3. Everything else clips against the *reduced* suppressor regions, which falls out of
   step 1 for free.

Cost is a handful of extra Clipper ops per (canceller, suppressor) pair, and §9.6 prices
those at ~0.05 ms each. This is the one place where "the tricky bit" is genuinely tricky:
it is the only rule where a light source's own output is shaped by a suppressor it
defeated.

### 4.1.1 Native darkness suppression must be disabled, not cooperated with

> **Four paths, not one.** Two found 2026-08-21, two more on 2026-08-22 — both by Patrick
> noticing behaviour, neither by reading source.
>
> 1. **Darkness edges** — `PointDarknessSource.requiresEdges` clips light sweeps.
> 2. **Origin containment** — `suppression.darkness` / `suppression.light` zero a source
>    whose *origin* sits inside its opposite.
> 3. **Light priority edges** — `PointLightSource#requiresEdges` is `priority > 0`
>    (`point-light-source.mjs:20-22`), and `initializePriorityLightSources` ranks darkness
>    sources against priority-bearing lights to decide whose edges cut whose sweep
>    (`groups/effects.mjs:186+`).
> 4. **Vision blinding** — `PointVisionSource` sets `blinded.darkness` when its origin is
>    inside an active darkness source (`point-vision-source.mjs:198`). It has **two**
>    consumers: `isBlinded` swaps the vision mode to `blindness`, and
>    `_getPolygonConfiguration` reads the flag *directly* and collapses the sweep radius
>    to `data.externalRadius` (`:289-290`). The second is the one that matters — patching
>    only the first left a source reporting not-blinded, correct vision mode, radius 1250
>    and active, while seeing exactly one square.
>
> **Path 3 corrupts the model.** Foundry truncates the polygon before we ever measure it,
> so a *daylight* outranking a *darkness* left the darkness bitten away and the two shapes
> no longer intersected. Diagnosed as a rules failure for several rounds; it was geometry.
>
> **Path 4 is not a rendering path at all**, which is why four successive rendering fixes
> did nothing to it. It produced pure black discs that blocked darkvision and looked
> identical to unexplored space. Our own mixin made it *worse than native*: the path-2
> override deliberately keeps darkness sources `active`, and `testInsideDarkness` skips
> inactive ones — so disabling native suppression *increased* how often tokens were
> blinded. That inversion is what made it so hard to locate.
>
> **Diagnostic lesson.** These were found by bisecting the module against observed
> behaviour — renderer off, suppression off, token vision off, token selected or not —
> not by reading Foundry's source. Reading produced four plausible mechanisms in a row,
> each real and each not the cause. When a symptom survives a fix, bisect before theorising
> again.

**Measured 2026-08-21.** Probing inside a darkness bubble overlapping a torch returned
`emitters: []` — the torch never reached the model at all, so the contest reduced from
a baseline of zero and produced Supernatural Dark instead of Dim.

Mechanism: `PointDarknessSource.requiresEdges` is `true`, so `_createEdges()`
(`point-effect-source.mjs:199-200`) inserts edges into `canvas.edges` and every light
sweep is clipped at the darkness boundary. By the time we read
`canvas.effects.lightSources`, the geometry is **already suppressed**.

The contest needs the *unsuppressed* baseline — "the area would have been Normal, so
drop it one step to Dim". Foundry has already decided the torch doesn't reach.

**These two models cannot be reconciled.** Foundry's suppression is binary (light
gone); ours is graduated (tier reduced).

**There are two independent native suppression paths and both must be disabled.**
Turning off only the first leaves half the behaviour in place — confirmed 2026-08-21,
where a light reaching *into* darkness correctly read Dim but a light placed *inside*
it still vanished entirely.

| Path | Mechanism | Effect |
| --- | --- | --- |
| **Edges** | `PointDarknessSource.requiresEdges` → `_createEdges()` | Geometric, **partial** — clips light *sweeps* at the darkness boundary |
| **Origin containment** | `PointLightSource#updateDarknessSuppression` (`point-light-source.mjs:31-34`) sets `suppression.darkness` when a light's *origin* is inside darkness | **All-or-nothing** — `_getPolygonConfiguration` sets `radius: 0` |

`PointDarknessSource#updateLightSuppression` (`point-darkness-source.mjs:88-90`) is the
mirror image, annihilating darkness whose origin sits in brighter light.

Origin containment is wrong for PF1 regardless: a torch inside a *darkness* spell does
not stop burning, it drops a tier.

Both writer methods are genuinely private and cannot be overridden. The lever is
`BaseEffectSource#suppressed`, which is
`Object.values(this.suppression).includes(true)` (`base-effect-source.mjs:184-185`) —
override it to ignore the relevant key rather than trying to stop the key being written.

- Darkness subclass: `requiresEdges → false`, and `suppressed` ignores `light`.
- Light subclass: `suppressed` ignores `darkness`.
- We then own suppression entirely and apply it in the renderer (§6.1).
- **Gate behind a setting.** Until our renderer exists, disabling native suppression
  means darkness visibly stops working in a live world.

**This reverses part of §3.5.** Mirroring `level` into `priority` so "Foundry's own
logic agrees with ours" is wrong — it makes Foundry suppress harder, not more
compatibly. `priority` still matters for darkness-vs-darkness ordering, but it is not
a route to making native behaviour match the contest.

### 4.2 Stacking escape hatch

A source may set `stacks: true` to opt out of the contest and compose its transform on
top of the winner instead. Homebrew only; build it, keep it off the default path.

### 4.3 Umbra — path-dependent darkness

Solves §2.3. For each suppressor `D` with `blocksPath`, and each observer `O`:

1. Construct the tangent cone from `O` around `D`'s polygon.
2. Take the region beyond `D`.
3. Clip to `O`'s sight range.

That polygon is the **umbra**. Feed it to the subdivision as cutting geometry and apply
`D`'s **transform** to those cells — not a fixed darkening, so a *clamp to Dim* zone
projects Dim outward and a *reduce 1* zone projects one step down.

- **Observer inside `D`:** no special case. The tangent cone widens until it covers the
  plane, so the umbra becomes 360° — every outbound ray crosses the boundary. This is
  the continuous limit of the construction; **do not branch on it.**
- **Path composition has a natural order** — distance along the ray. The ambiguity that
  killed the transform-pipeline model (Appendix A.2) doesn't arise here.
- **Same work item as the global-illumination rework.** The band in §2.3 is bright
  because global illumination is unconditional; making it a real clippable emitter is
  the fix. `CONFIG.Canvas.globalLightSourceClass` (`config.mjs:593`) is the handle.
- **Not modelled: optical depth.** Crossing 5 ft of darkness and 80 ft of it are the
  same. Binary crossing only.

Costs: observer movement dirties the field (only in scenes containing `blocksPath`
suppressors). 2D binary approximation evaluated at each cell's representative point, so
cells straddling an umbra boundary can be off by a tier — grazing sightlines will look
wrong first.

**Grayscale is free.** Correct tier demotion produces correct colour as a side effect.
PF1's darkvision vision mode carries no `postProcessingModes` on its lighting channels
(unlike `monochromatic`); the grey comes from the vision source's own paint,
`vision.defaults.saturation: -1.0` (`config.mjs:1001`) with
`background.visibility: REQUIRED`. An area reads grey when that desaturated paint is its
only contributor, and coloured when a real light paints over it. So once the umbra
removes global illumination's contribution, the area greys out on its own. *Caveat:* the
canvas-wide vision tint applies only with a single vision source
(`#getSingleVisionSource`, `visibility.mjs:185`), so in the §5.3 union case per-source
desaturation survives but the whole-screen tint doesn't.

### 4.4 Low-light vision — pre-contest, geometric

A per-observer transform on the **emitter set**: multiply each emitter's band radii for
that observer only. Runs **before** the contest, because it only extends how far light
*sources* reach — it has no opinion about the result.

- **Emitters only, never Suppressors.** LLV does not enlarge darkness.
- **Trap:** a darkness source is an AmbientLight with `negative: true` (§3.5) and goes
  through the same `_getLightSourceData()` as a normal light, so any naive "multiply all
  light radii" catches it. **PF1 currently has this bug** —
  `LLVMixin.getRadius()` (`low-light-vision.mjs:47-116`) has no `negative` check. Guard
  explicitly.

### 4.5 Darkvision — post-contest, override

A remap of the **resolved tier**: treat non-magical darkness as Normal within range,
rendered desaturated. Runs **after** the contest because it overrides the outcome rather
than changing what produced it.

### 4.6 Why 4.4 and 4.5 sit at opposite ends

Point inside a darkness sphere, 30 ft from a torch:

- LLV as a *post-contest tier bump*: contest resolves Dark → LLV brightens → **Dim.
  Wrong.**
- LLV as *pre-contest emitter geometry*: torch radii double, darkness still suppresses
  the torch → **Dark. Correct.**

The rules land where the pipeline puts them, which is a good sign the split is right.
Darkvision works inside a *darkness* spell precisely because it overrides the outcome;
low-light vision doesn't, precisely because all it does is extend a light source the
darkness has already suppressed.

### 4.7 Disabling PF1's version

Set PF1's `systemVision` world setting off. That stands down both `_syncSenses`
(`pf1/module/documents/token.mjs:180`) and the LLV multiplier
(`low-light-vision.mjs:71`). These are deliberate off-switches — the system is built to
be replaced here.

---

## 5. Observer resolution

### 5.1 Who the field is computed for

**Selection always narrows to exactly that token**, in every combination.

| User | Selection | Toggle | Field |
| --- | --- | --- | --- |
| GM | none | either | **God's eye** (§5.4) |
| GM | token | ON | that token's observer field |
| GM | token | OFF | **God's eye** |
| Player | none | ON\* | union over owned **or observed** tokens |
| Player | none | OFF\* | union over **owned** tokens |
| Player | token | either | that token's observer field only |

\* GM-controlled world setting. **The GM toggle only changes behaviour when a token is
selected** — with nothing selected the GM always gets god's eye.

The GM toggle is a scene-control button (`getSceneControlButtons`; in v13 `controls` is
a `Record`, not an array — `scene-controls.mjs:335`) plus a keybinding.

### 5.2 Implementation

Reduces to one override of `Token#_isVisionSource()`, because `CanvasVisibility` already
treats *zero active vision sources* as god's eye (`visibility.mjs:497`, `:738`).

**Mix over PF1's override, not core's.** PF1 already replaces this method
(`pf1/module/canvas/token.mjs:43-64`) with different semantics:

- **`guaranteedVision` setting** (line 60-61) replaces core's hardcoded `"OBSERVER"`
  with a configurable permission level. **This is the §5.1 player-side setting, already
  built.** Consume it; don't reimplement.
- **Vision-sharing early return** (line 57) —
  `if (this.actor?.sharesVision === true) return true;` — fires *before* the
  controlled-token guard on line 63, so a vision-shared token stays a vision source even
  when a token is selected. **This breaks the "selection narrows" invariant.** Fix in
  our mixin:
  ```js
  if (this.actor?.sharesVision === true) {
    return !this.layer.controlled.some(t => !t.document.hidden && t.hasSight);
  }
  ```

Remaining work is the GM toggle: OFF suppresses controlled tokens from becoming vision
sources for GMs (leaving the count at zero); ON is PF1 behaviour. Line 63 already
implements "selection narrows" — don't reimplement it.

**Toggling costs no document writes.** `_isVisionSource()` is evaluated client-side
during vision init, so the toggle just calls
`canvas.perception.update({initializeVision: true, refreshVision: true})` locally — no
scene round-trip, and none of the screen-flash that a `tokenVision` flip needs a
blackout tile to hide.

### 5.3 Union semantics

For multiple observers, `B` at a point is the **max** over each observer's field.
Compute per observer, cache per observer, merge. The only case where cost scales with
observer count.

### 5.4 God's eye fast path

No observer ⇒ no observer terms. Skip targeting filters, skip §4.3 path, skip §4.4/4.5
vision. The plain objective field.

- Cacheable **scene-wide**, invalidated only by source/wall/region edits — **not** by
  token movement. The cheapest mode in the system.
- **Targeted sources in god's eye — a toggle, not a decision.** Default: they render, on
  the principle that the GM should see what exists. This means god's eye can be brighter
  than any creature's perception. One predicate either way, so expose it.

---

## 6. Renderer

### 6.1 Principle

**Clip real sources; do not replace them.** Torch flicker, coloration and falloff must
survive. Being cut off by a partially overlapping darkness is expected and acceptable.

1. Resolve the field into **disjoint** polygons. Disjointness is what makes `MAX_COLOR`
   harmless — max over non-overlapping cells is the identity, so the ordering resolved
   in §4.1 survives into the shader.
2. For each real emitter, override `_createShapes()` and Clipper-difference its polygon
   against whatever blocks it. Animation rides along untouched.
3. Add **synthetic** sources only for tiers no real source provides — Dark and
   Supernatural Dark bands, and umbra fills. These should be flat (`attenuation = 0`),
   since they aren't radiating from anything.

### 6.2 Do not subdivide for tier boundaries

**The subdivision resolves which sources apply where — nothing else.** Its cuts come from
suppressor geometry (§4.1) and umbra edges (§4.3): hard, physical, sphere-shaped things
where a sharp edge is correct.

It must **not** cut at tier boundaries. Within a cell, let each real source's own falloff
paint the transition. Cutting there would flatten every cell, discard every gradient, and
leave seams where a gradient was bisected. Two wins: gradients survive for free, and the
cell count drops substantially.

#### 6.2.1 A cell cannot have a hole

**A source shape is a single closed ring.** `PolygonMesher` takes one flat points array
(`polygon-mesher.mjs:23`); the holes in its internal `#polygonNodeTree` are *generated*
by the offsetting passes, never accepted as input.

The subdivision produces annular cells anyway: a suppressor sitting wholly inside an
emitter makes `E \ S` an outer ring plus a hole. And we can't sidestep it by leaving `E`
whole and painting the reduced tier on top, because `MAX_COLOR` (§6.1 step 1) means the
brighter ring wins wherever they overlap. **Annuli must be split into simple polygons.**

Two ways, in preference order:

1. **Half-plane split.** Clipper-intersect the annulus against two rectangles meeting at
   the hole's centre. Two extra ops per annulus, robust, and the resulting seam sits
   inside a region of uniform tier so it is invisible.
2. **Keyhole bridge.** Join outer ring to inner with a zero-width slit, yielding one
   self-touching ring. Cheaper, but a zero-width feature is exactly what the soft-edge
   offsetting passes (§6.4) handle worst.

Take 1 unless it measures badly. Either way this is unbudgeted work that only shows up
once the subdivision is real; the §8.1 subdivision harness counts annuli so we know the
frequency before designing around it.

**Corollary — don't use `PIXI.Polygon#intersectPolygon` anywhere in the subdivision.** It
returns `solution[0]` and discards every other path (`polygon-extension.mjs:196`), so it
silently eats both the holes *and* the disjoint fragments a difference legitimately
produces. Use `intersectClipper`, or `ClipperLib.Clipper` directly with `AddPaths` for
batched unions the way core does for regions (`documents/region.mjs:224-244`).

#### 6.2.2 A reduced cell keeps its gradient — reduction *is* a radius shift

The obvious way to draw "this light, one tier dimmer" is a flat fill at the reduced
value. It would look wrong: a torch inside a *darkness* would become a uniform disc
instead of falling off from the flame.

It is also unnecessary, because **reducing by one tier is exactly shifting the zone radii
inward by one zone**: `(rB, rN, rD)` becomes `(0, rB, rN)`.

The original ramp puts Bright on `[0, rB)`, Normal on `[rB, rN)`, Dim on `[rN, rD)`.
Feeding `(0, rB, rN)` back through the same ramp opens at 0.9 — no Bright zone — and runs
to 0.5 across `[0, rB)`, which is Normal; then 0.5 to 0.1 across `[rB, rN)`, which is Dim;
then nothing. Every tier boundary lands where the quantised model says it should, so

```
tierOf(brightnessAt(d, reduceRadii(r, n))) === tierOf(brightnessAt(d, r)) − n
```

everywhere inside the light, while `B` in between stays continuous instead of stepping.
**Verified numerically 2026-08-21** over 7,700 samples across five radius configurations;
`clampRadii` likewise holds its cap over 5,775.

Clamping works the same way: collapsing every zone above the cap to zero is equivalent to
`min(B, ceiling)`, because the ramp then simply opens at the capped tier's top.

So a `reduced` cell renders as a synthetic source at the emitter's own origin with
transformed radii, clipped to the cell — gradient intact, mechanically exact at tier
granularity. Only `dark` cells are flat fills, which is right, since they aren't
radiating from anything.

#### 6.2.3 The five tiers map 1:1 onto Foundry's lighting levels

**Confirmed 2026-08-21.** `CONST.LIGHTING_LEVELS` has six values and we need five:

| Our tier | Foundry level | Notes |
| --- | --- | --- |
| Bright | `BRIGHTEST` (3) | Rendered from `canvas.colors.ambientBrightest`, set from `CONFIG.Canvas.brightestColor` (`environment.mjs:156`, `rendered-effect-source.mjs:587`). **Nothing in core produces it** — it is ours for the taking. |
| Normal | `BRIGHT` (2) | Foundry's "bright" |
| Dim | `DIM` (1) | |
| Dark | `UNLIT` (0) | |
| Supernatural Dark | `DARKNESS` (−2) | The violet |
| — | `HALFDARK` (−1) | Spare — the same orphan §3.3.1 turned up |

So §3.2.1's added Bright tier needs no invented render path: set `_brightLightingLevel`
on the source and Foundry already has a colour for it. A synthetic fill is a source
covering its cell with `attenuation: 0` and its lighting levels pinned to the target
tier.

**A `dark` fill needs no source at all.** Clipping the light away *is* the render. Only a
fill above Dark — a *darkness* at noon, capped at Normal — or one at Supernatural Dark
requires anything to be drawn.

**How a `dark` cell renders depends entirely on its tier, and only two of three cases are
reachable today.** Established over four wrong attempts on 2026-08-21, all worth recording
because each looked right on paper.

| Target tier | Rendered by | Status |
| --- | --- | --- |
| **Dark** | nothing — removing the light *is* the render | works |
| **Supernatural Dark** | a darkness source at full strength, its designed purpose | works |
| **Above Dark** (a *darkness* at noon capping at Normal) | lowering ambient inside a region | **blocked on §7.1** |

The four attempts, and why each failed:

1. **A light source at the fill tier.** A light can only *add*, and the fill tier is
   always ≤ ambient. A *darkness* on a lit scene rendered as a glow — exactly inverted.
2. **Skip it, wait for §7.1.** Right conclusion, wrong reasoning — see 3.
3. **A darkness source pinned to the tier via `_dimLightingLevel`.** Those read like
   instance properties but are taken off `this.constructor`
   (`base-light-source.mjs:213-214`), so assigning them per source does nothing. Even
   overridden one layer down in `_updateCommonUniforms`, the *darkness layer's* shader
   never consults them — it renders from `color` and `colorationAlpha`
   (`point-darkness-source.mjs:206-213`).
4. **A darkness source scaled by alpha.** Closest, and still wrong for three
   independent reasons:
   - the shader darkens relative to **what is already rendered**, not to ambient, so on
     dim ground any subtraction falls below the ambient floor and the area reads darker
     than surrounding unlit ground;
   - `enableVisionMasking` includes `|| !game.user.isGM`
     (`point-darkness-source.mjs:211`), so the same source renders differently for the GM
     than for a player, and no alpha reconciles that;
   - it carries a padded `_visualShape` with a mesh scaled to the padded radius, all
     built for supernatural darkness specifically.

**A `PointDarknessSource` is not a dimmer.** It is a supernatural-darkness renderer, and
using it as anything else fights three of its design decisions at once.

So §7.1 is a **genuine blocker** for darkness on lit scenes, not the deferred nicety the
plan called it. Everything reports correctly — `evaluate()`, the readout, the field — only
the paint is missing, and only in that one case.

**Two mechanisms worth keeping from the failed attempts**, since both are correct and
will be needed:
- Per-source lighting levels via `_updateCommonUniforms` — the only way to vary a level
  per source, and how `BRIGHTEST` gets used for our Bright tier.
- Clipping a darkness source through `_visualShape` rather than `shape`
  (`point-darkness-source.mjs:165`), which also keeps what is *drawn* separate from what
  is *measured*.

#### 6.2.4 Never clip `shape` — clip the mesh

**`source.shape` has three consumers and only one of them is drawing.** Clipping it looks
like the obvious way to narrow a light and breaks the other two silently.

| Consumer | Reads | Effect of clipping `shape` |
| --- | --- | --- |
| `testPoint` | `base-effect-source.mjs:343-345` | the model forgets where its own lights reach, and shrinks them a little further on every recompute |
| **visibility mask** | `groups/visibility.mjs:562` | **holes in what tokens can see** |
| `_updateGeometry` | `point-effect-source.mjs:173-189` | the intended effect |

The visibility one is the serious one, and it took most of a day to find. Clipping a
light removed it from `vision.light.sources`, so the region became *unseeable* rather
than unlit: pure black discs that blocked darkvision, looked identical to unexplored
space, and vanished wherever fog had already been lifted. It was diagnosed as a
darkness-rendering problem three times over — the discs sat exactly where darkness
sources were — while the darkness sources were provably painting nothing.

**So the clip lives in `RENDER_SHAPE` and is swapped in only around `_updateGeometry`.**
Swapping the field around `super` rather than reimplementing the meshing keeps Foundry's
own maths, including `PointDarknessSource`'s padded `_visualShape` variant, as the single
source of truth.

Darkness sources need the same treatment for a different reason: they draw from
`_visualShape ?? shape` (`point-darkness-source.mjs:165`), so clipping `shape` alone
changes nothing on screen when padding is non-zero.

**A clip cell can be several rings** — the annulus split (§6.2.1) — but a source has
exactly one `shape`. The real source takes the largest piece; the rest become synthetic
clones with the same animation config. Both sit at the same origin and Foundry's
animations are functions of shared ticker time, so they should stay in phase.

**The halves must overlap, not meet.** Found on the renderer's first run, 2026-08-21: a
horizontal line straight through the torch, moving with the darkness and vanishing once
the darkness was no longer wholly inside the light — the signature of the cut line.

Cause is §9.5 meeting §6.2.1. The largest piece goes to the *real* source, which keeps
soft edges, and `PolygonMesher` insets by `EDGE_OFFSET` and ramps depth 0→1 along its
**entire** perimeter, cut edges included. The pooled clone has soft edges off. So one half
fades out along the seam and the other does not.

Fix: overlap the halves by more than that inset. `MAX_COLOR` takes the brighter, and both
halves are the same source at the same origin, so an overlap is invisible where a gap is
not. **The overlap is clamped to a quarter of the hole's height**, which is a correctness
bound rather than a tuning choice — a pad reaching past the hole would leave the whole
hole inside one half, still an annulus, and the recursion would stop making progress.

### 6.3 Visual control surface

Gradients are Foundry's **default**; hard edges are the imposition. One uniform,
`attenuation` (0-1, default `0.5` — `illumination-lighting.mjs:77`), already in
`LightData` and in the light config UI, drives both:

- **Bright→dim sharpness** — `SWITCH_COLOR`, `base-lighting.mjs:312-318`. A `smoothstep`
  band around `ratio`, widened by `attenuation * 0.7`. At `0` the band is 2% wide.
- **Outer falloff** — `FALLOFF`, `base-lighting.mjs:347-349`:
  `depth *= smoothstep(1.0, 1.0 - attenuation, dist)`. At `0`, hard cutoff at radius.

So "continuous visual falloff, discrete mechanical tiers" needs no work — it's the
renderer left alone. **No custom shaders** (see Appendix A.3 for why the piecewise ramp
was dropped).

If the render's two-zone gradient ever needs to line up more closely with the three-zone
model, the fix is **curve-fitting, not a shader**: derive native `bright`/`dim`/
`attenuation` from the three radii so the native curve passes near our thresholds. ~2
hours. The relevant Foundry math is `ratio = clamp(|bright| / radius, 0, 1)`
(`point-light-source.mjs:60`) and the non-linear remap
`a = (cos(π · attenuation^1.5) − 1) / −2` (`base-light-source.mjs:228`).

### 6.4 Softening wall-cut shadow edges

Foundry already has this machinery, tuned very small. `PolygonMesher` insets the polygon
by `offset` and ramps `depth` 0→1 across that band (`polygon-mesher.mjs:38-49`), along
the **entire perimeter including wall-cut straight edges**. `depth` multiplies the final
colour, so that band already is a soft shadow edge.

It reads as hard because `EDGE_OFFSET = -8` px scaled by `canvas.grid.size / 100`
(`rendered-effect-source.mjs:75`) — 8 px on a 100 px grid, ~1/12 of a square.

**Fix: override the static on our source subclass.** One number, on a class we're
already subclassing. Cost is `#nbPass = ceil(|offset| / 3)` extra triangulation passes at
mesh-build time, not per frame. Expose as a slider.

- Gated on `canvas.performance.lightSoftEdges` (`rendered-effect-source.mjs:234`) — **off
  entirely in low performance mode.** Surface or force it.
- `GlobalLightSource` explicitly disables soft edges (`global-light-source.mjs:55`). Once
  §4.3/§7.1 make global illumination a real emitter, enable them there.

**Limit:** a constant-width band, not true penumbra. Handles "not a razor cut", not
"fade through normal and dim over 10 ft". For that see §3.4 (mechanical) and §7.2
(visual).

### 6.5 Verified mechanics

**Run-verified 2026-08-21** by the §8.1 slice, on Foundry 13.351 with `limits` active.
A document-less source renders, and an injected polygon survives into the mesh — not
merely into `testPoint`. The clip is a **hard edge**, because falloff is computed
against the original radius, so clipping mid-gradient truncates it. Predicted and
accepted by §6.2.

| Fact | Citation |
| --- | --- |
| Document-less sources are first-class: `this.object = options.object ?? null` | `base-effect-source.mjs:45-48` |
| `static effectsCollection` names the collection a source inserts itself into | `base-effect-source.mjs:62`, `:142` |
| Lifecycle: `new Src({sourceId}) → initialize(data) → refresh() → destroy()` | `base-effect-source.mjs:206` |
| `_createShapes()` accepts arbitrary polygons — done in production by `limits` | `limits/scripts/canvas/sources/light.mjs:17-31` |
| Source classes swappable and composable via mixin at `canvasInit` | `limits/scripts/_index.mjs:37-42` |
| Swappable class slots | `config.mjs:591-595` |
| Polygon booleans, all four clip types | `polygon-extension.mjs:192-209` |
| `LIGHTING_LEVELS` definition | `constants.mjs:244` |
| `BRIGHTEST` → `canvas.colors.ambientBrightest` | `rendered-effect-source.mjs:587` |
| Shader registry: `lightAnimations` / `darknessAnimations` | `config.mjs:753`, `:884` |

### 6.6 Hazards

- **Synthetic sources land in `canvas.effects.lightSources`** and will be seen by
  anything iterating it. PF1 carries a live comment about that collection causing an
  infinite loop (`low-light-vision.mjs:130-133`). **Tag our sources and make them
  skippable.**
- **`limits` collision.** We both mix `_createShapes` on the same classes — limits
  *constrains* the polygon, we *inject* one. We extend whatever sits in `CONFIG` at
  spawn time, so we land on top of it; semantics still need watching where both narrow
  the same shape.
- **PF1 is *not* on the source classes.** Measured 2026-08-21: `lightSourceClass`,
  `darknessSourceClass` and `visionSourceClass` each carry exactly one anonymous mixin
  layer, and it is `limits`. PF1's `LLVMixin` overrides `_getLightSourceData()`, which
  lives on the **placeable** (`AmbientLight`/`Token` objectClass), not the source. So
  this is a two-way overlap, not the three-way one originally assumed.

---

## 7. Deferred

### 7.1 Interiors on outdoor maps

A house on an outdoor map shouldn't be lit by global illumination, but light should
still enter through a window. A region that disables global illumination is only half
the answer, because global illumination conflates two different things — **sky-fill**
(omnidirectional, no origin, doesn't stream) and **direct sun** (directional, casts,
streams). Foundry models neither. With no origin there's no geometry to sweep through
the gap. (An ordinary light placed outside *does* work today; the failure is specific to
global illumination.)

**Aperture emitters.** Interior regions subtract the sky-fill emitter — which falls out
of §4.3 making global illumination clippable, so it costs nothing extra. Then for each
light-passing boundary segment of an interior region, synthesise an emitter at that
aperture sweeping inward, tier derived from the outdoor tier minus a configurable step.
Tracks time of day with nothing hand-placed; local to interiors; near the window is
brighter than the back of the room.

The lit wedge is **static in shape** — only its tier tracks time of day. Moving sunbeams
explicitly out of scope.

### 7.2 Penumbra via area lights

Penumbra exists because real sources have *area*. Sample the source at N origins, sweep
from each, average. Each sample respects walls by construction, and the penumbra widens
with distance from the occluder — which a constant band cannot fake.

Cost is N× sweeps, the expensive part of lighting, so `samples` is per-source and
defaults to 1. **A window *is* an area light**, so aperture emitters (§7.1) should be
multi-sampled by nature and penumbra falls out on the motivating case for free. Generic
torch-vs-wall soft shadows use the same mechanism as an opt-in flag, later.

### 7.3 Mechanical consumers

Concealment miss chance, Perception/Stealth gating, effect prerequisites. Deliberately
unscheduled until the framework works.

Note when the time comes: `ckl-roll-bonuses` `OVERRIDE`s `ActionUse.handleConditionals`,
so miss chance must be a post-roll interception, not a wrapper there.

---

## 8. Build plan

### 8.1 Vertical slice — start here

Not the model layer. A slice that exercises the three things reading the source can't
settle:

1. Create one **document-less synthetic source** with an injected polygon; confirm it
   renders. (The §9 prototype gate.)
2. One torch emitter, one darkness suppressor, the §4.1 contest between them.
3. `evaluate(point)` as a console readout.
4. Confirm coexistence with `limits` and PF1's mixins (§6.6).
5. **Measure source churn** — create/destroy N synthetic sources repeatedly and watch
   for flicker, GC pressure, or pipeline complaints.

If this works the rest is mostly volume. If it doesn't, we find out before there's
anything to throw away.

### 8.2 Then

1. **Model layer** — emitter/suppressor registry, contest, `evaluate()`, `field()`.
2. **Light-level readout, rebuilt in-mod.** Not a reparenting of
   `pf1-light-level-tooltip`; a fresh implementation against the API, which stays alive
   standalone for anyone using it. First consumer of the public API, and what proves the
   API is usable.
3. **Renderer** — subdivision, clipping, synthetic fills. Most of the effort is
   invalidation, not drawing.

   **Hard requirement from §9.5: the renderer must be pool-based.** Allocate synthetic
   sources to worst-case cell count once and re-`initialize()` them; never
   create/destroy per recompute. Construction — not geometry, not the sweep — is the
   dominant cost, and pooling is worth ~3× on its own and ~12× combined with
   soft-edges-off. This shapes the design from the start rather than being an
   optimisation applied later.

   **Subdivision measured — §9.6.** Build `tight`: per-ring bounds, plus a per-band box
   test before each intersection. 4.4 ms on a worse-than-RAW worst case. Use
   `ClipperLib` directly, never `intersectPolygon` (§6.2.1), and split annuli.
4. **Observer resolution** — §5.2.
5. **Umbra** — §4.3, plus the global-illumination rework.
6. **Interiors, apertures, spill** — §7.1, §7.2, §3.4 land together; spill's free-clip
   trick needs the aperture sweep.

### 8.3 Invalidation

| Trigger | God's eye | Observer field |
| --- | --- | --- |
| Ambient light / token light | dirty | dirty |
| Wall / door | dirty | dirty |
| Region / suppressor | dirty | dirty |
| Observer moves | clean | dirty (if any umbra) |
| Non-observer token moves | clean | clean |
| Selection change | clean | re-select observer |

Debounce aggressively; PF1 models this with `debouncedLightSourceReInit`
(`low-light-vision.mjs:142`).

**This table is not an algorithm.** It says *what* dirties, not what recomputes, at what
granularity, or how partial invalidation works. This is where mods of this shape usually
die — "why is the light wrong until I jiggle a token." It needs real design during step
8.2.3, and it is the weakest part of this document.

**Promoted from advisable to mandatory by §9.6.** A worst-case scene costs ~10.4 ms to
resolve from scratch, most of it building the 119 sources the cells imply. That is
affordable *once*, and unaffordable as the response to every token step. Nothing in the
renderer's cost profile can be tuned around it — the work is real, so the answer is not
doing it again.

**But it is only half the problem it looked like.** §9.7 measured a full registry rebuild
at 0.337 ms — 2% of a frame — so the "is our picture of the scene current" half needs no
cleverness at all, and ships as a lazy dirty flag. Everything hard is **cell caching**:

> **Built 2026-08-21 — precise invalidation, and a trap it uncovered.**
>
> The registry caches only what cannot be read live: resolved config and radii. Position
> is not cached, since `brightnessAt` reads `source.x` and `contains` calls `testPoint`.
> So `updateToken` now only invalidates on `light`, `hidden` or our own flags — not on
> every hit point and step.
>
> **The trap:** a light-bearing token moving does *not* fire `initializeLightSources`.
> Foundry sets `initializeLighting` only when darkness or edges are involved
> (`placeables/token.mjs:792-798`) and otherwise re-initialises the source in place. So
> the registry correctly ignores the move — but the *field* must not, because every cell
> is cut from `source.shape`. Keyed on the registry generation alone, a walking torch
> would have left the field silently stale.
>
> **The fix generalises the `Entry#path` trick.** `field.get()` compares a signature of
> shape *object references* plus ambient brightness. Foundry allocates a new polygon on
> every `_createShapes`, so reference identity catches every move, wall edit and door
> toggle with no bookkeeping. ~50 reference compares against a 4.4 ms recompute, and most
> frames change nothing.
>
> Ambient brightness moved to a live read for the same class of reason: darkness
> transitions *animate*, sliding `darknessLevel` without firing a document update.

- **Dirty by region, not globally.** A suppressor that moved invalidates emitters near
  its old and new bounds; everything else keeps its cells. The `tight` pre-filter already
  computes exactly the bounds overlap this needs.
- **Keep cells, not just sources.** Pooling (§9.5) avoids reconstructing sources but
  still re-runs the boolean algebra. Cached cells keyed on (emitter, suppressor-set)
  identity skip both.
- **Geometry identity is free.** `Entry#path` caches its Clipper path against
  `source.shape` by object identity: Foundry allocates a new polygon whenever it re-runs
  `_createShapes`, so wall changes, door toggles and light movement all invalidate it
  automatically, with nothing to remember. The same trick should key the cell cache.
- **Previews are not part of the scene.** Dragging a placeable creates a *second* live
  source — `sourceId` gains a `.preview` suffix (`placeables/light.mjs:55`) — so the
  original and its ghost are both active for the length of the drag. Including both meant
  the model resolved a scene that did not exist, and it surfaced asymmetrically:
  `initializeLighting` is only requested by a light that creates edges
  (`placeables/light.mjs:328`), so a *darkness* drag re-ran the model every frame against
  the doubled state while a plain light drag deferred everything to drop. The registry
  now excludes previews, and the field reflects committed state only.
- **Not every drop fires a rebuild signal.** For the same reason, dropping a plain light
  requests only `refreshLighting`, never `initializeLightSources`. The renderer, overlay
  and readout all hook `refreshAmbientLight` as well; each is cheap because `field.get()`
  returns the same object when nothing changed.

---

## 9. Risks

| Risk | Notes |
| --- | --- |
| **Source churn** | ~~Biggest unknown.~~ **Retired 2026-08-21.** Pooling + soft-edges-off gets synthetic fills to ~0.05 ms each, ~3 ms for 60. See §9.5. Binds the renderer to a pooled design. |
| **Subdivision cost** | ~~The biggest unknown.~~ **Retired 2026-08-21.** `tight` mode does the worst case in 4.4 ms, 10.4 ms of 16 including construction. See §9.6. The suspected hot spot — the Supernatural Dark fill's union over every emitter — was never it; band intersections were, on op count alone. |
| **Cell count** | The constraint the subdivision work actually surfaced. 119 cells × ~0.05 ms construction ≈ 6 ms, larger than the 4.4 ms that computed them, and **no pre-filter reduces it** because cells are geometry. The only lever is coarser cells (§9.1's fallback). |
| **Clipper GC pressure** | Measured 2026-08-21: a 247.5 ms max against a 6.3 ms median in one mode. Every op allocates an `IntPoint` object per vertex, so a recompute churns thousands of short-lived objects. A quarter-second stall mid-play is worse than a slow median. Mitigations if it bites: reuse `Clipper` instances, cache `toClipperPoints` per source keyed on shape identity, and above all recompute less (§8.3). |
| **Annular cells** | §6.2.1. A cell with a hole cannot be rendered — source shapes are single rings. **Confirmed 2026-08-21**: 7 of 119 cells at a 20-square suppressor radius, 0 at 4 squares. Required work, not contingency. |
| **Vision suppression** | ~~Untouched.~~ **Resolved 2026-08-22.** Native darkness no longer blinds a token or collapses its sweep — §4.1.1 path 4. Two corrections to earlier notes here: `#highPrioritySources` only re-`initialize()`s sources in priority order and feeds nothing else, so it was never a vision path; and `vision.darkness` is vestigial in v13 — declared, cleared, never drawn into. |
| **Vision, unimplemented** | Different thing from the row above, and still open. Nothing converts a light level into *perception*: normal sight sees into unlit ground, darkvision is not bounded by tier, and there is no umbra. §8.2 steps 4-5, unstarted. Everything built so far is the light-level model and its rendering. |
| **`blinded.darkness` stays set** | We suppress its *effect*, not the flag, so Foundry still records the token as blind. Nothing in core reads the record except through the two consumers we patch, but a third-party module inspecting `blinded` would see a token we consider sighted. Compatibility note rather than a bug. |
| **Invalidation correctness** | See §8.3. Least designed, most likely to bite. |
| **Multi-client story** | Nearly absent from this document. Field is client-local, but GM toggles, world settings and flag edits must propagate. Surfaces the first time a player logs in. |
| **`limits` integration** | §6.6. Concrete, not theoretical — we run it. |
| **Version churn** | Least stable corner of Foundry's API. The `limits` in this workspace is v3.0.0 requiring Foundry **14.360** while we run **13.351**; `DetectionMode#_canDetect` gains a `level` param in v14. Budget a re-port every major. |
| **Prototype gate** | §6.5 is read-verified only. §8.1 step 1 gates everything. |
| **Over-scope** | Steps 8.2.5-6 may never be wanted. Steps 1-3 deliver both original complaints. Don't treat the list as obligatory. |

### 9.1 Performance budget

So §8.1 has a pass/fail rather than a vibe.

| Metric | Target |
| --- | --- |
| Reference scene | ~20 light sources, ~200 walls, 1-2 suppressors |
| Field recompute, one observer | < 16 ms (one frame) |
| Field recompute, god's eye | < 8 ms |
| Token move → render settled | < 100 ms perceived |
| `evaluate(point, observer)` single query | < 1 ms (runs on mousemove) |

If the subdivision blows 16 ms, the fallback is coarser cells and accepting tier error at
boundaries — not abandoning the architecture.

### 9.2 Measured — source churn, 2026-08-21

Foundry 13.351, `limits` active, spawn + destroy cycles.

| Batch | Spawn median | Spawn mean | Spawn max | Per source | Clear |
| --- | --- | --- | --- | --- | --- |
| 30 sources, no constraint | 4.5 ms | 4.35 ms | 10.6 ms | 0.145 ms | ~0 ms |
| 60 sources, with Clipper constraint | 6.8 ms | 7.34 ms | 17.5 ms | 0.122 ms | 0.1 ms |

Findings:

- **Comfortably inside the 16 ms budget**, and the concern that Foundry's
  document-bound source lifecycle would thrash under churn did not materialise.
- **Marginal cost is low and sub-linear** — doubling the count *and* adding a Clipper
  intersection per source moved the median only 4.5 → 6.8 ms, and per-source cost went
  *down* (0.145 → 0.122 ms). There is fixed overhead; the incremental source is cheap.
- **Polygon injection is nearly free.** Constraining did not meaningfully change the
  slope, so §6.1's clip-everything approach is affordable.
- **Destruction is free** (~0.1 ms for 60), so teardown is not a bottleneck.

**Superseded by §9.3** — the near-empty scene made these numbers useless. Kept only as
the baseline the real-scene run is measured against.

### 9.3 Measured — source churn on a real scene, 2026-08-21

Same harness, re-run on a populated town scene (many lights, heavy walls).

| Batch | Spawn median | Spawn mean | Spawn max | Per source |
| --- | --- | --- | --- | --- |
| 30 sources, no constraint | **18.6 ms** | 18.74 ms | 28.6 ms | 0.625 ms |
| 60 sources, with constraint | **28.9 ms** | 50.06 ms | **282.1 ms** | 0.834 ms |

Against the empty scene that is ~4.3× on the median and ~5× per source. **Both over the
16 ms budget**, and the 282 ms spike is a visible freeze. Cause is the wall sweep, as
predicted — the sweep is the expensive part of lighting and the empty scene had almost
no walls to sweep against. Destruction remains free (~0.1 ms).

**The harness overstates the real cost in two specific ways, both fixable:**

1. **Synthetic fills should not sweep at all.** Their polygon comes from the
   subdivision, which was derived from already-swept source shapes — wall occlusion is
   *already baked in*. The current `_createShapes()` calls `super._createShapes()` (a
   full sweep) and then discards most of it via `applyConstraint`. Building the shape
   directly should collapse per-source cost back toward the empty-scene figures, since
   the sweep is essentially the entire expense. **Highest-value experiment available.**
2. **30-60 synthetic sources is likely a large overestimate.** §6.1 step 2 *clips
   existing* sources and creates nothing; only step 3 adds synthetics, for tiers no real
   source provides. Real counts are plausibly single digits.

Churn is still not the renderer — the subdivision remains unmeasured.

### 9.4 Measured — skipping the sweep, 2026-08-21

Town scene, 60 sources × 20 iterations. **By median** — the first report of this run
used the mean for per-source cost, and a single 295 ms GC spike inverted the ranking.
Harness fixed to use the median.

| Mode | Median | Per source | vs sweep |
| --- | --- | --- | --- |
| sweep | 35.8 ms | 0.597 ms | — |
| constrain | 31.4 ms | 0.523 ms | 1.14× |
| **direct** (no sweep) | **20.5 ms** | **0.342 ms** | **1.75×** |

**The sweep is only ~40% of the cost.** Skipping it is a real win but not the collapse
§9.3 predicted — a synthetic fill still costs ~0.34 ms, so 60 of them remain over
budget.

The remaining cost is not geometry. Prime suspects, in order:

1. `_updateGeometry` → `PolygonMesher`, which runs `ceil(|EDGE_OFFSET| / 3)` = **3
   Clipper offsetting passes per source** at the default `EDGE_OFFSET = -8`. Testable
   by forcing `canvas.performance.lightSoftEdges = false`.
2. Mesh and shader allocation in `_configure` → `#initializeMeshes`.

**Implied fix: pool and reuse sources rather than create and destroy them.** If
re-`initialize()`ing an existing instance is materially cheaper than `direct`, the cost
is construction rather than work, and the renderer should keep a pool sized to the
worst-case cell count. Harness has a `reuse` mode for this.

Still true: 60 synthetic sources is probably a large overestimate. §6.1 step 2 clips
existing sources and creates nothing; only step 3 adds synthetics.

### 9.5 Measured — pooling and soft edges, 2026-08-21

Town scene, 60 sources × 20 iterations. Ratios are per-source cost against the plain
`sweep` baseline, by median.

| Mode | softEdges on | softEdges off |
| --- | --- | --- |
| constrain | 1.21× | 0.93× |
| direct | 1.97× | 1.42× |
| **reuse** | **2.98×** | **11.69×** |

**Both remaining costs identified, and together they fit the budget.** Reuse plus
soft-edges-off is ~0.05 ms/source — about 3 ms for 60 sources, comfortably inside 16 ms.

1. **Pooling is the largest single win** (2.98× alone). Construction, mesh allocation
   and shader setup dominate — not geometry, and not the sweep. **The renderer must
   pool sources sized to worst-case cell count and re-`initialize()` them, never
   create/destroy per recompute.**
2. **Soft edges dominate once construction is gone** (a further ~3.9×). This is
   `PolygonMesher` running `ceil(|EDGE_OFFSET| / 3)` Clipper offsetting passes per
   source.
3. **`constrain` at 0.93× with soft edges off** — clipping is slightly *worse* than a
   plain sweep once there is no soft-edge cost to hide behind. Clipping real sources is
   not free.

**Resolves the §6.4 tension.** Wanting a larger `EDGE_OFFSET` for softer shadow edges
directly multiplies the Clipper passes. But soft edges only matter on **real light
sources**, where a wall-cut shadow edge is visible; synthetic tier fills have
deliberately hard boundaries (§6.2 — umbra and darkness edges *should* be sharp).

> **Rule: soft edges on for clipped real sources, off for synthetic fills.**

Implemented as `softEdges = false` by default on the synthetic source class.

### 9.6 Measured — the subdivision, 2026-08-21

The last unmeasured piece. Harness: `spike/subdivide.mjs`, run against the scene's **real
swept light polygons** rather than generated circles, since vertex count is what feeds
Clipper.

Worst case deliberately chosen: **2 suppressors at radius 20 squares**, large enough that
44 of 53 emitters overlap one, so the bounds pre-filter has almost nothing to discard. A
*deeper darkness* is 12 squares, so this is beyond anything the rules produce.

53 emitters (1232 verts), 2 bands, 20 iterations + 5 warmup, fresh page.

| Mode | Ops | Subdivision | + construction | Frame total | Verdict |
| --- | --- | --- | --- | --- | --- |
| naive | 162 | 11.6 ms | 6.0 ms | 17.6 ms | OVER |
| filtered | 135 | 6.3 ms | 6.0 ms | 12.3 ms | within |
| **tight** | **120** | **4.4 ms** | **6.0 ms** | **10.4 ms** | **within** |

Geometry is identical in all three: **119 cells, 7 annuli, 6 extra paths, 2430 output
vertices.** Cell counts matching is the correctness check — a pre-filter may remove work,
never geometry.

**Verdict: the subdivision is affordable, and the cell count is the real constraint.**

1. **`tight` is the mode to build.** Per-ring bounds instead of one box round the whole
   union, plus a per-band box test before each intersection. 4.4 ms on the worst case,
   stable across runs. The per-band test is what pays — intersections are two thirds of
   all ops, because they run per emitter *per band*.

2. **Construction outweighs subdivision.** 119 cells × ~0.05 ms (§9.5) ≈ 6 ms against
   4.4 ms of Clipper. **No pre-filter reduces cells** — cells are geometry, not work.
   Cutting the cell count means coarser cells (§9.1's stated fallback), nothing else.

3. **Op count is the lever, not a predictor.** Cost tracks op count in *direction* —
   every optimisation here is an op-count reduction — but `ms/op` ranged 0.037-0.072
   across the three modes, so don't use it to price features precisely. An earlier run
   showing 3% agreement was an artifact: it inherited a warm JIT, so all three modes were
   equally warm.

4. **§6.2.1 is real.** 7 annular cells at radius 20, 0 at radius 4 — a large suppressor
   swallows small torches whole. Annulus splitting is required work, not contingency.

5. **The `intersectPolygon` corollary is real.** 6 results with more than one path;
   `PIXI.Polygon#intersectPolygon` would have discarded every one.

**Method note — warm-up bias.** Without warmup, a second invocation in the same page ran
1.9× faster than the first on byte-identical geometry, a bigger swing than any difference
between modes. Five warm-up iterations per mode is still not enough to reach V8 steady
state for whichever mode runs first, so **`naive`'s 11.6 ms is cold-biased and the
naive→tight ratio is overstated.** Round-robining the modes would fix it; not done,
because `naive` is not a mode we would ship and the number that matters — `tight` — runs
last and fully warm. Compare within one invocation, never across page loads.

**What this changes in the plan.** Nothing about the architecture; §8.3 invalidation goes
from advisable to mandatory. Recomputing 119 cells because anything on the scene moved is
the actual problem, and no amount of filter tuning touches it.

### 9.7 Measured — registry and point query, 2026-08-21

City scene, 53 emitters. The model layer (§8.2 step 1) against its §9.1 budgets.

| Operation | Measured | Budget | Ratio |
| --- | --- | --- | --- |
| `evaluate(point)` | **0.0025 ms** | < 1 ms | 400× under |
| Full registry rebuild | **0.337 ms** | — | ~0.006 ms/source |
| `field.compute()`, 53 emitters, no suppressor | **~0 ms** (mean 0.011) | — | 0 Clipper ops |
| `field.compute()`, 1 emitter, 1 suppressor | **0.2 ms** | — | 5 ops incl. annulus split |

**All of it is free, and that matters more than it looks.**

1. **The readout needs no throttling.** At 0.0025 ms, running `evaluate` on raw
   mousemove costs ~0.15 ms per second of cursor movement. §8.2 step 2 can be naive.

2. **The registry never needs partial invalidation.** A full rebuild on every token step
   costs 2% of a frame. The lazy dirty-flag rebuild it ships with is not a placeholder
   for something smarter — it is the answer. Entries remain individually rebuildable, but
   there is no measured reason to use that.

3. **This narrows §8.3 by half.** Invalidation had two jobs: keep the registry fresh, and
   avoid recomputing cells. The first is now known to be a non-problem. Every remaining
   difficulty is in **cell caching**, which is where §9.6's 10.4 ms lives.

4. **The no-suppressor fast path pays for itself.** Most scenes have no darkness on them
   at all, and that case now touches Clipper zero times and reuses each source's own
   polygon as its cell rather than round-tripping through integer coordinates. It reads
   as free.

**Method warning.** Single-shot readings of the same two calls were 0.9 ms and 3.9 ms —
inflated ~80× and ~20× by warm-up. Use `spike.bench` / `spike.compare`; do not hand-roll
a timing loop and do not trust one call. This is the fourth time the same mistake has
produced a wrong number on this module.

---

## Appendix A — Rejected alternatives

Kept so they don't get relitigated. Each was seriously considered.

**A.1 — Reading light level back out of the renderer.** Appealing because light level is
genuinely observer-relative, so the rendered view already answers the question. But it
answers for **one** observer — this client's POV — and resolving a single stealth check
needs every potential observer at once (the human sees darkness, the elf dim light, the
orc sees plainly). Also `renderer.extract` forces a GPU→CPU stall per query; the pixel is
post-exposure/contrast/saturation/tint so presentation would contaminate mechanics; and a
fogged pixel reads dark whether unlit or merely unseen. Note `pf1-light-level-tooltip`
already works the right way round — it iterates `canvas.effects.lightSources` and
recomputes in JS.

**A.2 — Transform-pipeline overlap resolution.** Each suppressor's operation composing in
sequence. The operations don't commute: Bright under *reduce 2* then *clamp to Dim* gives
Dim, but *clamp* then *reduce* gives Supernatural Dark. Would require inventing a total
order and explaining it at the table. Replaced by §4.1.

**A.3 — Piecewise `TRANSITION` shader ramp.** Overriding `TRANSITION` so the render
matches the three-zone model exactly. Dropped: no functional gain (the mechanical tier
comes from flags, not the shader, and per §3.2.1 nearly every light is genuinely
two-zone, so the native render is *exact* for the common case), and `fragmentShader` is
assembled at class-definition time so **11 classes** bake their own copy (base, torch,
flame, pulse, wave, vortex, fairy-light, ghost-light, siren, smoke-patch,
bewitching-wave). Covering torch and flame is mandatory since we want flicker. ~1.5-2
days plus per-version maintenance. Coloration shaders need nothing either way — they have
no zone concept.

**A.4 — Two stacked sources per light** to fake three zones with native shaders. Doubles
source and mesh count for cosmetics. *Partially rehabilitated:* since Bright zones are
rare (§3.2.1), adding one extra source **only** for the few lights with a bright core is
cheap, and is the path if Bright ever needs to render as a visible step up.

**A.5 — Dilation for visual penumbra.** Polygon dilation, screen-space distance fields
and blur all compute distance *ignoring occlusion*, so light tapers through walls. A
window tapering back outdoors is invisible; an interior door tapering into the dark room
next door is visible and wrong. *Note:* §3.4 uses dilation deliberately, made safe by
max-combine-only semantics plus clipping to the aperture sweep. **Different mechanisms
for different jobs — do not merge them.**

**A.6 — Distant directional sun** for global illumination, so the existing sweep produces
real moving sunbeams. Every building would cast a hard shadow across the outdoor map,
which is wrong — outdoor shade is still bright — and it would require splitting sky-fill
and direct sun into two separately tuned emitters.

**A.7 — Two separate modules** (engine + PF1 rules). Splitting later is easy if the
engine turns out to have an audience; splitting now buys cross-module versioning and a
public contract we'd have to honour before knowing what it should be.

---

## Appendix B — Open questions

1. **`luminosity` is presentation-only** (§3.1) — confirm. If it should be mechanically
   real, that changes what feeds `B`.
2. **Spill vs umbra ordering** (§3.4 vs §4.3). Spill only raises and is
   observer-independent; umbra only lowers and is applied post-contest per observer. So
   umbra wins where they overlap. Asserted, not reasoned through — flag if your reading
   differs.
3. **Further Phase 1 features.** §3 has been reshaped several times and everything hangs
   off it; additions are cheapest before code exists.
4. **What does a two-band darkness source's *rim* mean mechanically?** §3.3.1 argues for
   un-collapsing `PointDarknessSource`'s radii so *darkness* has a soft rim rather than a
   razor edge — but that section frames the benefit as visual, and our transforms are
   whole-tier, so "half a step" has no representation in the model. Three readings, none
   obviously right: the rim applies the same transform and is merely drawn softly; the
   rim applies a *lesser* transform (reduce 0, i.e. no mechanical effect); or tiers gain
   sub-steps, which would be a much larger change. **`field()` ships one band per
   suppressor** — which is also the current reality, since un-collapsing the radii is
   source-class work that hasn't been done — but it carves regions from a generic band
   list, so the second band drops in once this is settled.
