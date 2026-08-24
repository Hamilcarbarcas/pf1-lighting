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

> **Amended 2026-08-23, with §3.2.1's rewrite.** `B` remains the wire format, but it is no
> longer the only place arithmetic happens: a light's outer band raises the level by *rungs*,
> and rungs only exist on the tier scale. Stacking is therefore computed in tier space and
> converted back through `tierCeiling`, at the one boundary where it occurs.
>
> One consequence reaches the scene: **the ambient tier is now read off the §7.0 darkness
> table, not off `tierOf(1 − darknessLevel)`.** Two quantisations of the same quantity cannot
> both be the base of an additive ladder, and the table is the one the renderer already paints
> from — so the model and the picture agree by construction rather than by coincidence. The
> rule is *nearest rung, ties to the darker*, which leaves the default table's behaviour at
> `darkness = 0.5` where it was (Dim) and makes the slider step visibly between tiers.

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
  emission   : { tier, inner, outer, steps, cap }   see §3.2.1
  kind       : "ambient" | "mundane" | "magical"
  level      : integer                        spell level for magical; else 0
  targeting  : { include: [tokenId], exclude: [tokenId] } | null
  samples    : integer = 1                    >1 = area light (§7.2)
}
```

- `ambient` — sun, moon, stars, global illumination
- `mundane` — torches, candles, lanterns, sunrods
- `magical` — spell effects; `level` drives the §4.1 contest

#### 3.2.1 Two zones — a set level, and a relative band

**Rewritten 2026-08-23. The three-zone ramp this replaces was wrong about what a PF1 light
does**, and the correction is described in full at the end of this section because the shape
of the mistake is worth keeping.

A light has **one set light level and two radii**:

```
Emission {
  tier   : the light level it provides            default Normal
  inner  : radius at that level                   Foundry's native `bright`
  outer  : radius of the relative band            Foundry's native `dim`
  steps  : rungs the band raises the level by     default 1
  cap    : ceiling the band may not exceed        default = tier
}
```

At distance `d` from the origin, the light contributes:

| Range | Contribution |
| --- | --- |
| `d ≤ inner` | the set `tier`, **absolutely** |
| `inner < d ≤ outer` | `+steps` rungs on whatever else is there, ceiling `cap` |
| `d > outer` | nothing |

A PF1 torch is `{tier: Normal, inner: 20 ft, outer: 40 ft}` — Normal light to 20, and one
step up from 20 to 40, never above Normal. That is the rules text, and Foundry's two native
radii carry it with nothing added.

##### Resolution — one `max`, one sum

The two zones resolve at different times, because they are different operations. Set levels
**contend**; bands **stack**.

```
A      = max(ambient, every covering inner zone)      absolute layer — light does not stack
Σn     = sum of `steps` over every covering band      bands do
ceil   = max of `cap` over those same bands
result = max(A, min(A + Σn, ceil))
```

On a dark map with two torches: alone, each band gives `Dark + 1` = Dim. Where they overlap,
`Dark + 2` = Normal. A third torch makes it `Dark + 3`, which the shared `cap` of Normal cuts
back to Normal. Adding torches never exceeds what one torch provides at its core, which is the
property the cap exists for.

Three parts of that formula are load-bearing:

- **`ceil` is the `max` of the caps, not the `min`.** A *daylight* (`cap: Bright`) whose band
  falls across a torch's should not be dragged down to the torch's ceiling. A cap says what
  *that source* can do on its own, so the most capable covering source sets the ceiling.
- **The outer `max(A, …)`** stops a low `cap` from *darkening* ground that is already brighter.
  Without it a torch would dim a sunlit field to Normal. The shader applies exactly this guard
  at `base-lighting.mjs:380`, which is a good sign the shape is right.
- **Bands read only the absolute layer**, never each other. That is what makes this two passes
  rather than a fixed point: there is no ordering, no convergence, and no way for two bands to
  amplify one another.

Inner zones are deliberately *not* excluded from the sum's base. Standing in torch A's Normal
core with torch B's band on you gives `Normal + 1` capped at B's Normal, so the answer is
Normal either way — the cap makes the exclusion unnecessary, and carving one out would be code
earning nothing.

##### Where it sits in the order — bands lose to darkness, always

Stacking resolves **inside** the contest, on the emitter side, before any suppressor is
applied and long before an umbra is consulted:

```
absolute layer  →  bands  →  suppressor transform  →  tier  →  umbra clamp (per observer)
```

So two torches whose bands overlap into Normal, seen through a *magical darkness*, still read
as darkness. The umbra clamps the resolved tier and does not care how the tier was arrived at
(§4.3). Likewise a *darkness* over the overlap blocks both torches outright — an eligible
emitter contributes **nothing**, neither zone — so the region falls to the transformed ambient.
This ordering is not incidental; it is the reason band stacking can be added without touching
`vision/` at all.

##### The overlap cannot be rendered by lights — §7.0's texture renders it

`base-light-source.mjs:72` blends the illumination layer with **`MAX_COLOR`**. Two overlapping
dim bands composite as one dim band. The renderer structurally cannot express a sum, so a model
that says Normal over a picture that shows Dim would be a display players must be told how to
read.

The fix needs no new mechanism. The shader floors both zones at the background —

```glsl
computedDimColor = max(computedDimColor, computedBackgroundColor);
```

— so a brighter background wins over a light drawn on top of it, and **that was the first
implementation**: paint the overlap into the darkness-level texture at the summed tier. It is
superseded, and how it failed is the useful part — see below.

The cost is geometric and lands in `field()`. It is **coverage counting, not a full
arrangement**: the region covered by ≥2 bands is the union of pairwise intersections, ≥3 the
union of triples, and the count needed is bounded by `ceil − A` — usually 2, because the usual
cap is Normal and the usual ambient is Dark. Pairs are `O(n²)` before the existing `touchesAny`
bounding-box filter, and **zero when no two bands overlap**, which is the same fast-path shape
as `if (!suppressors.length)`.

###### A flat fill cannot sit next to a light — 2026-08-23, two passes to see it

Play-test one: the overlaps rendered **brighter than the light sources' own normal light**.
That much was arithmetic. A stack cell raises the *background*, and the bands that made it are
still drawn on top of that raised value, each adding its own rung — so painting the background
at the resolved tier double-counts. The fix was one subtraction: the bands composite by
`MAX_COLOR`, so what they add is the **largest single band's** rung count, not the sum, and
laying the background at `tier − that` let the bands complete the last step. Exact, and it
worked.

Play-test two: still a visible break, and Patrick's read of it was the right one — *the light
source feathers off to a dimmer value, so its feather creates a discrepancy with our flat
fill*.

The numbers say he was not describing a small mismatch. At the default `attenuation` of 0.5:

```glsl
// SWITCH_COLOR, base-lighting.mjs:312-318
float attenuationStrength = attenuation * 0.7;               // 0.35
smoothstep(ratio * 0.64, ratio * 1.36, dist)                 // 72% of ratio, blended

// FALLOFF, base-lighting.mjs:347-349
depth *= smoothstep(1.0, 1.0 - attenuation, dist);           // outer 50% of the radius
```

**A Foundry light is very nearly all gradient.** There is barely a plateau in it to match. So a
flat region is not a slightly-wrong version of the right thing, it is a different kind of
object, and no value assigned to it can make its boundary read correctly. Nor can a blur: the
mismatch spans a large fraction of a light's radius, and a blur wide enough to hide it would
smear every darkness boundary on the map.

**So the overlap is drawn with the same curve it has to meet.** One pooled clone per
participating emitter, at that emitter's own origin, radii **and attenuation**, clipped to the
region, with its *band* level raised to the resolved tier. `MAX_COLOR` across the clones yields
`max(falloff_i)` with the rung added — the same function as `max(falloff_i)` immediately
outside — so the two sides of the boundary differ by a level and not by a shape, and the clip's
soft edge has something it can actually blend. This is the `reduced` cell's pattern (§6.2.2), a
second time.

One clone per emitter, not one per region: a single clone would only match wherever that
particular light happened to be the strongest of them.

Two things this gives up, both deliberate.

**The umbra clamp on overlaps.** A stack region is a light now, and a light in an umbra dims
without clamping (§7.0's partial answer). Accepted (Patrick, 2026-08-23) on the grounds that
the torches which *made* the overlap already behave exactly that way — the clamped stack cell
was the one thing in the region that did not, which was its own inconsistency.

**Source construction, which §9.5 calls the dominant cost.** Pooled, so no allocation, but one
`initialize()` per clone per rebuild. `render.stats().stacked` counts them.

###### Why a per-mesh feather is not available for the texture generally

Worth recording, because it nearly works and the reason it does not is non-obvious.
`PIXI.BLEND_MODES.MIN_COLOR` exists (`blend-modes.mjs:20`). Dilate each cell by a feather
width, ramp its level outward toward fully dark, composite with `MIN`, and adjacent cells blend
into one another correctly with no knowledge of their neighbours — the two ramps cross and the
brighter plateau takes over exactly at the boundary.

It fails on the clear colour. The container is cleared to `canvas.environment.darknessLevel`
and `MIN` can only ever *brighten* from the clear, so any cell darker than the scene's own
slider — every `dark` cell on a lit map — could never paint at all. Core resets that clear
every frame (`groups/effects.mjs:240-242`), so it is not ours to own.

That leaves a blur as the only order-independent option for cell-to-cell edges, which is fine
for those: an `ambient`/`dark` or umbra boundary is a step between two flat regions, where a
modest feather reads correctly. It is only the cell-against-light-gradient case a blur cannot
serve, and that case now has its own answer above.

##### What this replaces, and the lesson in it

The previous model gave every light three zones — a Bright radius in flags, then Foundry's
`bright` as our Normal and `dim` as our Dim — each an absolute band on a continuous `B` ramp
from 1.0 down to 0.1.

It was wrong in one specific way: **the outer zone was absolute when the rules make it
relative.** A torch in a dim-lit room read as Dim at its rim, which is what the ramp said and
not what a torch does; the rules say it raises the level rather than setting it. The error only
shows up on a map that is *already lit*, which is why it survived every dark-dungeon test.

Three things fall out of the correction, all of them simplifications:

- **The Bright radius flag is gone.** A Bright light is `tier: Bright` with its inner radius —
  an enum where there was a third radius, and one fewer thing to author.
- **`reduceRadii` is gone**, and with it the §6.2.2 identity that reduction is a radius shift.
  Reducing a light now lowers its set tier and leaves the geometry alone, which is both simpler
  and closer to what `clip.mjs` already does — Foundry exposes `dimLevelCorrection` and
  `brightLevelCorrection` as **separate** uniforms, so the two zones can carry two different
  levels natively. We were faking with geometry what the shader hands over directly.
- **`normaliseRadii` shrinks to `outer >= inner`.** The three-way ordering it enforced was
  guarding a nesting that no longer exists.

`B` stays the model's wire format — 69 references across 11 files, including the readout,
`umbra` and `probe`. The stacking arithmetic happens in tier space at the single boundary where
it occurs and re-enters as `tierCeiling(tier)`. Making tiers the currency outright is a bigger,
later question and this does not foreclose it.

##### Foundry does not order `dim` and `bright` — found 2026-08-23

Kept because the *diagnostic* lesson outlived the ramp it was found in.

The old ramp nested its zones, and the two radii it nested are **independent `NumberField`s**
(`common/data/data.mjs:45-49`). Nothing validates their order. The only place they meet is
`PointEffectSourceMixin`, which sweeps `shape` at `max(dim, bright)` — so a light authored
`{bright: 60 ft, dim: 0}`, the natural way to write *bright out to here* and how a *daylight*
gets entered, is ordinary, valid, and inverted the nesting.

Untreated, that light's outer radius was 0, `brightnessAt` returned 0 at **every** distance, and
`emittersAt` dropped it on `B <= 0`. The source disappeared from every point query in the
module — the contest, the readout, perception, blinding — while `field()` carried on as if
nothing were wrong, because the renderer works from `shape` and the *rules* and never asks how
bright anything is.

That split is what made it expensive: the reported symptom was **a *daylight* that cancelled a
darkness correctly on screen and was simultaneously absent from `evaluate()`'s emitter list at
the same point.** Both halves were behaving exactly as written, and every readout agreed with
itself.

The normalisation survives in reduced form (`outer >= inner`) and still runs at the boundary
where Foundry's data enters. `max` rather than a warning, because there is nothing ambiguous: a
light whose `bright` reaches past its `dim` has no band, which is what Foundry renders too.

**The general lesson is about absence.** A source dropped from a list leaves no trace in any
readout, so the diagnostic has to name what it *excluded*. `probe.at()` reports `silent` —
emitters whose polygon covers the point and whose contribution came out 0 — with their resolved
emission.

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

> **The config UI is now the top practical gap — 2026-08-23.** `level` is readable only from
> `flags["pf1-lighting"].config`, set by hand, while the light config sheet shows a `priority`
> field that looks like it does the same job and does not. That cost a bug report ("priority 0
> darkness should not cast an umbra" — it was `level: 2`, the `DEFAULT_SUPPRESSOR`). Everything
> in §4 and §7 is now driven by fields with no way to set them.
>
> **Do not fix it by mapping `priority` onto `level`.** It is the obvious shortcut and it
> inverts the default: Foundry's `priority` is `0` on every light, so every unconfigured
> darkness would become *mundane* — no umbra, no sight blocking — where today it is a level-2
> magical darkness. An unconfigured *darkness* should behave like the spell, not like an unlit
> room. The two fields also mean different things (§4.1.1), and `priority` still has its own
> job in darkness-vs-darkness ordering.
>
> What is needed is an explicit `level` control on the light config sheet, defaulting to 2,
> alongside `kind`, `floor`, `transform` and `blocksPath`.
>
> **Planned in §10** — as a tab on the light config sheet, driven by a preset table, with the
> `priority` confusion answered by a label rather than by mirroring the two fields.
- Token light shares the schema, so mobile darkness needs no separate path.

```js
// A darkness (negative: true)
flags["pf1-lighting"].config = {
  kind: "magical",
  level: 2,
  transform: { op: "reduce", steps: 1 },
  eligibility: "preset:darkness",
  blocksPath: true,
  floor: TIER.DARK,
  targeting: { include: [], exclude: [] }
}

// A light. `bright` / `dim` stay on the native schema — these are only what it cannot hold.
flags["pf1-lighting"].config = {
  kind: "mundane",
  level: 0,
  emitTier: TIER.NORMAL,   // §3.2.1 — the set level inside the inner radius
  steps: 1,                // rungs the outer band raises by
  cap: TIER.NORMAL,        // ceiling on that band; defaults to `emitTier`
  cancelsDarkness: false
}
```

`emitTier` / `steps` / `cap` are §3.2.1's emission, and all three default to the ordinary case,
so an unconfigured light is a torch: Normal inside `bright`, one step up to `dim`, never
brighter than Normal. The three-radius `brightRadius` flag they replace is **retired** — a
light still carrying it simply has no third zone, which is the correct new reading.

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

> **Five paths, not one.** Two found 2026-08-21, two more on 2026-08-22 — both by Patrick
> noticing behaviour, neither by reading source — and a fifth while building §4.8.
>
> 1. **Darkness edges** — `PointDarknessSource.requiresEdges` clips light sweeps.
>
>    > **Correction, 2026-08-22.** Those edges are created with **both** `light: NORMAL`
>    > *and* `sight: NORMAL` (`point-effect-source.mjs:216-222`), so they were clipping
>    > **vision** sweeps too — which is exactly how stock Foundry stops an outside observer
>    > seeing terrain inside magical darkness. Disabling `requiresEdges` removed both jobs
>    > and only one of them was the problem. See §4.5.2.
> 2. **Origin containment** — `suppression.darkness` / `suppression.light` zero a source
>    whose *origin* sits inside its opposite.
> 3. **Light priority edges** — `PointLightSource#requiresEdges` is `priority > 0`
>    (`point-light-source.mjs:20-22`), and `initializePriorityLightSources` ranks darkness
>    sources against priority-bearing lights to decide whose edges cut whose sweep
>    (`groups/effects.mjs:186+`).
> 4. **Vision blinding, the canvas** — `PointVisionSource` sets `blinded.darkness` when its
>    origin is inside an active darkness source (`point-vision-source.mjs:198`). Two
>    consumers: `isBlinded` swaps the vision mode to `blindness`, and
>    `_getPolygonConfiguration` reads the flag *directly* and collapses the sweep radius
>    to `data.externalRadius` (`:289-290`). The second is the one that matters — patching
>    only the first left a source reporting not-blinded, correct vision mode, radius 1250
>    and active, while seeing exactly one square.
> 5. **Vision blinding, detection** — the *same flag*, read from outside the class by
>    `DetectionMode#_testLOS` (`detection-mode.mjs:157`), failing every sight-based
>    detection independently of path 4. No subclass override can reach this one.
>
> **Path 5 moved the lever from the consumers to the record.** Three wrappers in two files,
> with a fourth reader arriving in v14, is a losing position. `blinded` is a plain instance
> field, and a subclass field initialiser replaces the parent's — so we hand Foundry a
> record whose `darkness` key is an *accessor* reading `false` while we own suppression.
> `#updateBlindedState` still writes to it, `Object.values` still enumerates it, and every
> reader is covered without having to know they exist. The written value is preserved
> behind a non-enumerable symbol so `probe.vision()` can still tell "Foundry blinded this
> and we overrode it" from "Foundry never blinded it" — two states that are otherwise
> indistinguishable and mean opposite things.
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

> ## Construction: difference of two sweeps, not tangent cones
>
> **Superseded 2026-08-22** (Patrick's suggestion, from watching §4.5.2's sight edges work).
> The numbered construction below is kept for the *definition* of an umbra; the way to
> obtain the polygon is much simpler now that darkness sources emit sight-blocking edges.
>
> ```
> umbra  =  LOS swept ignoring darkness edges  −  LOS swept with them
> ```
>
> Foundry's edges cannot *clamp* — `WALL_SENSE_TYPES` is binary occlusion, and `LIMITED`
> only means "blocked by two rather than one". But a sweep that stops at the darkness
> boundary is precisely the complement of the region beyond it, so differencing two sweeps
> at different priorities yields the umbra directly.
>
> Better than the tangent-cone construction on four counts, each of which was real work:
>
> - **Non-convex darkness polygons** need no tangent-line maths. A wall-truncated darkness
>   is an arbitrary polygon and cones around one are fiddly.
> - **Multiple suppressors** resolve in a single pass, with no union step.
> - **Walls** are handled correctly and identically in both sweeps, for free. The cone
>   construction would have had to intersect with wall geometry separately.
> - **Observer inside `D`** falls out with no branch: the truncated sweep is just the
>   bubble, so the difference is everything else. Step 1 below already insisted this must
>   not be special-cased; here it cannot be.
>
> Step 3 (clip to sight range) is also free — both sweeps are already the observer's LOS.
>
> Cost is one extra sweep per observer per distinct clamp tier, against constructing and
> unioning cones. §9.4 measured sweeps as the expensive half of source construction, so this
> is not free — but observers are few, and god's eye (§5.4) has none at all.
>
> ### The priority ladder this needs
>
> Ordinary darkness must contribute umbra geometry **without** blocking sight outright, and
> §4.5.2 currently emits edges only for Supernatural Dark for exactly that reason. Since an
> edge is skipped when `edge.priority < edgeType.priority` (`clockwise-sweep.mjs:236`), the
> two behaviours separate cleanly by rank:
>
> | | Priority | Effect |
> | --- | --- | --- |
> | Ordinary darkness edges (`castsUmbra`) | 0 | umbra only |
> | Supernatural darkness edges (`blocksSight`) | 1 | umbra **and** block sight |
> | Normal vision sweep | 1 | ignores ordinary, blocked by supernatural |
> | *See in darkness* vision sweep | 2 | ignores both |
> | Umbra probe sweep | −∞ | sees every darkness edge |
>
> Walls stay immune throughout — they are registered at `-Infinity`
> (`clockwise-sweep.mjs:101`), so no rung of this ladder can unblock one.
>
> **Migration note:** §4.5.2 as built emits edges at the source's authored priority and only
> for `blocksSight` suppressors. Moving to this ladder means emitting for all `castsUmbra`
> suppressors at rank 0/1, and raising the ordinary vision sweep to rank 1 — which is a
> change to `_getPolygonConfiguration`, not just to the edges. *(Done 2026-08-22.)*
>
> ### Edges come from **cells**, not from source shapes — built 2026-08-22
>
> **Identified by Patrick**, from a screenshot: a slice of darkness cancelled by a
> *daylight* was still casting an umbra. Stage A emits edges inside
> `PointDarknessSource#_createEdges`, so they trace `this.shape` — the suppressor's **raw**
> polygon. The model knows that slice is annihilated (§4.1.2); the edges do not.
>
> The same gap has two more faces, and together they say the geometry source is simply wrong:
>
> - **Cancellation** — an annihilated or countered region must cast nothing.
> - **Two-band suppressors (§3.3.1)** — a *darkness* with a partially-dark rim should cast a
>   *weaker* umbra from the rim than from the core. One source, two tiers.
> - **Per-region tiers generally** — "one darkness orb, one umbra strength" is not a rule
>   anywhere; it is an artefact of tracing the source's own circle.
>
> `field()` already computes exactly the right geometry: effective regions with breakers
> subtracted, each carrying a resolved tier. **So umbra edges should be emitted from field
> cells**, ranked by the cell's tier, and `PointDarknessSource#_createEdges` should stop being
> the mechanism. Nested ranks then give per-tier umbra for free — sweep at each tier present,
> and the darkest region containing a point is its clamp. This subsumes the "strongest clamp
> on the scene" approximation rather than refining it.
>
> **The obstacle is ordering, and it is the real cost.** Edges are created during *source
> initialisation*; cells require the whole scene to be resolved, which requires every source
> to be initialised. So this cannot live in `_createEdges` at all. It has to become a
> post-field synchronisation — compute the field, sync a set of standalone `Edge` objects into
> `canvas.edges` ranked by tier, then request a vision refresh — which introduces a **second
> perception pass**, and this project has already been bitten once by an
> `initializeLighting` → hook → rebuild loop (§8.3).
>
> Second cost: cell boundaries are more numerous and more complex than a source's circle, so
> every sight sweep on the scene gets slower. Needs measuring, not assuming —
> `game.pf1Lighting.umbra.edges()` reports the edge count for exactly this.
>
> #### As built — `vision/umbra-edges.mjs`
>
> `PointDarknessSource#requiresEdges` is back to a flat `false`; path 1 is disabled in full
> again, and sight edges are a **post-field pass** instead.
>
> - **Cells are unioned per rank before emitting.** `reduced` and `dark` cells tile a
>   suppressor's effective region between them, so emitting each cell's outline would put
>   edges on the boundaries *between* them and block sight *inside* a single darkness. Only
>   the union outline is a real boundary. Holes in the union are real boundaries too, and are
>   emitted.
> - **Rank comes from the cell's own tier**, and `umbra.mjs` reads the tiers to sweep from
>   the same cells — so the ranks emitted and the ranks swept cannot drift apart.
> - **Edges are reconciled, not cleared and rebuilt**, under a `pf1-lighting.umbra.*` id
>   prefix. Nothing else in `canvas.edges` is ever touched.
> - **The loop is closed by the field's own identity check.** `sync()` requests
>   `initializeVision` — never `initializeLighting`, which is what would close the cycle §8.3
>   warns about. The vision refresh does re-fire `refreshToken`, but `field.get()` returns the
>   same object, `sync()` early-outs, and no second perception update is issued.
>
> Light sweeps are unaffected throughout: every emitted edge carries `light: NONE`, so the
> contest still measures an unsuppressed baseline.

Solves §2.3. For each suppressor `D` that **casts an umbra**, and each observer `O`:

> **Only magical darkness casts an umbra — added 2026-08-22.** `castsUmbra(D)` is
> `D.level >= 1 && D.blocksPath !== false`, and the level half is the rule rather than a
> default. **Level 0 means mundane, for suppressors exactly as it already does for
> emitters.**
>
> An unlit cellar and a *darkness* spell both make an area dark; only one of them stops you
> seeing the lit courtyard through the doorway. Without the level gate, standing on ordinary
> unlit ground would project darkness across everything you looked at — so a creature with
> no darkvision, on a dark hillside, could not see a lit window thirty feet away. That is
> wrong, and it is the common case rather than the exotic one.
>
> `blocksPath` survives as an opt-out for magical darkness that is deliberately see-through.
> Both conditions live in one predicate in `model/contest.mjs` because §4.5.1 consumes it
> too, and the two must not drift apart.


1. Construct the tangent cone from `O` around `D`'s polygon.
2. Take the region beyond `D`.
3. Clip to `O`'s sight range.

That polygon is the **umbra**. Feed it to the subdivision as cutting geometry and **clamp**
those cells to the tier `D` itself produces.

> **Amended 2026-08-22 — clamp, not re-apply.** This section previously said to apply `D`'s
> *transform* to the umbra, so a `reduce 1` suppressor reduced the region beyond by one
> step as well. That is wrong, and wrong in the case the whole feature exists for.
>
> The rule is that **you cannot see anything through a darkness more clearly than the
> darkness itself allows**. Looking through a bubble whose interior is Dark, a torchlit area
> beyond reads Dark — not one step down from bright. Looking through a *deeper darkness*
> whose interior is Supernatural Dark, the region beyond is Supernatural Dark too, and
> darkvision is defeated there exactly as it is inside.
>
> The two formulations agree whenever the region beyond is no brighter than the bubble's
> interior, which is why the difference is easy to miss. They diverge precisely when it is
> brighter — the case that decides whether a creature in darkness can see a lit target.
>
> **The clamp value is `transform(ambient)` honouring `floor`** — what the suppressor does
> to ground carrying no other light. One scalar per suppressor, and notably **independent
> of the observer**: only the umbra *geometry* is observer-dependent. That splits the
> caching cleanly, the value computed once per suppressor and the tangent cone per observer.
>
> This is also the first live exercise of the `clamp` transform, which is implemented and
> numerically verified but has never run on a scene.

- **Observer inside `D`:** no special case. The tangent cone widens until it covers the
  plane, so the umbra becomes 360° — every outbound ray crosses the boundary. This is
  the continuous limit of the construction; **do not branch on it.**
- **Consequence: the bubble is opaque from the inside, but only when it is dark enough.**
  The 360° umbra clamps everything the occupant looks at to the interior tier. A *darkness*
  at night resolves to Dark, so they see nothing outside either — correct. The *same spell
  in daylight* resolves to Normal, so they see out fine, merely dimmed. That is the rule
  working, not failing, and it will be reported as a bug eventually.
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

#### As built, stage B — the clamp is consumed — 2026-08-22

Stage A produced the geometry and drew it. Stage B is the four lines that make it *mean*
something, and they are four lines only because the observer was threaded through
`perceivedTier` months before there was anything to put in it.

```
perceivedTier(point, obs)  =  min( evaluate(point).tier , umbra.clampAt(point, obs) )
```

Every detection mode already routes through `perceivedTier`, so ordinary sight, darkvision
and the piercing senses all became observer-relative in one edit. Nothing needed a per-mode
change.

**The clamp only ever darkens.** Guarded on `<` rather than assigned, so a Dim umbra falling
across ground that is already Dark leaves it alone. Nothing *between* two points can make the
far one brighter.

**Where the clamp value comes from — superseding the amendment above.** That paragraph said
the clamp is `transform(ambient)` per suppressor, "one scalar, independent of the observer".
As built it is the **cell's own resolved tier**, carried on the edge's rank and recovered by
which sweep produced the region. That is strictly better and it is what makes the
cancelled-slice and two-band cases work: a suppressor no longer *has* one clamp value.

**Caching, and why it is identity-based rather than per frame.** A sweep per tier present, per
observer, is affordable once and ruinous every frame during a token drag. Both dependencies
announce themselves by becoming a different object — `field.get()` returns the same object
until the scene changes, and `source.los` is *replaced* by `_createShapes` rather than mutated
— so the cache key is two reference comparisons and can be checked on every point query. That
is what lets the clamp live inside `perceivedTier` without a second cache above it. A
bounding-box reject sits in front of the even-odd containment test.

**Failing open.** `clampAt` catches, returns `null`, and logs. A geometry fault must not be
able to stop tokens being tested for visibility; the degraded behaviour is pre-umbra
behaviour, which is wrong but not broken.

**Rendering is untouched, and that is not an oversight.** A lit room seen through a *darkness*
stops revealing the tokens in it while still *looking* lit. Detection and painting are
separate pipelines here — perception drives detection modes, terrain comes from the vision
source's own polygon and mode — and painting an umbra per observer is §7.1's problem, not a
subset of this one.

**Its own setting.** `umbraPerception`, default on, gated behind `perceptionEnabled`. The two
fail with the same symptom — "that token should not be visible" — and differ in whether the
model is wrong *at a point* or wrong *about the path*. One switch each is what makes that a
one-minute bisection instead of a session.

#### As built, stage C — painting the umbra — 2026-08-23

**Per-scene facts belong in sources; per-observer facts belong in masks.** That principle came
out of Patrick asking why wall line-of-sight is smooth during motion when the proposed umbra
rendering would not be, and it settled the design.

The obvious construction — inject umbra into `field()` as a suppressor region and let the
renderer cut lights and fill at the clamp tier — is accurate and is the wrong layer. Moving a
token re-runs that token's own sweep and redraws a mask; it never touches a light source. §9.5
measured source *construction* as this module's dominant cost, so a field-based umbra would put
the most expensive operation in the system behind the most frequent event: a field recompute
(4.4 ms) plus a renderer restage (~10 ms) on every step of a drag, untunable because the work
is real.

##### The mask composition, and why one polygon is the whole fix

`vision.light.mask` is assigned to the **`mask` property** of the `vision.light` container
(`visibility.mjs:404` — added as a child *and* set as the mask in a single line, easy to read
straight past). So:

```
visible  =  (light.sources ∪ light.global ∪ light.cached)  ∩  light.mask   ∪   sight
```

`light.sources` is the union of every light on the scene and is **not** observer-relative,
which looked fatal — a lit room beyond a darkness is drawn there by its own torch. It is not,
because that union is *intersected* with `light.mask`, which is drawn per vision source from
`visionSource.light`, the light-perception polygon (`visibility.mjs:586`). Trim the umbra out
of that one polygon and the room stops being revealed to that observer however brightly its own
torch burns.

**Darkvision falls out with no branch.** `vision.sight` is a separate union drawn from
`visionSource.shape`, and `light.mask` does not gate it. Trimming only light perception blinds
ordinary sight to a Dark umbra and leaves darkvision seeing through — §4.3's rule, obtained
from Foundry's structure rather than from testing senses.

##### Two mechanisms tried and rejected

**An `ERASE`-blended child of the mask.** The obvious way to subtract, and it does not
subtract — it *adds*. `vision.light.mask` is the `mask` **property** of `vision.light`, and
PIXI renders a Graphics mask through the **stencil buffer**, which ignores blend modes. The
umbra went into the stencil as ordinary coverage, so the region it was meant to hide became the
one region reliably revealed. Core's `vision.darkness` uses `ERASE` legitimately, but it is a
child of `vision`, which composites to a texture — same technique, one layer down, opposite
result.

**Swapping a trimmed polygon in and letting core draw it.** Nearly right, and it fails in
exactly one case. `light − umbra` yields a ring **with a hole** whenever the umbra is fully
surrounded, `drawShape` takes a single contour, and keeping the largest ring fills the hole
back in. So a dark umbra vanished while wholly enclosed and reappeared the moment any part of
it reached the rim of the light polygon.

**Patrick reported that signature exactly and I set it aside**, because the first version's
comment called a dropped ring "the conservative error" — which is backwards. **A dropped hole
over-reveals.** The mislabel is why an accurate bug report read as a contradiction. Two lessons
worth more than the fix: a mistaken safety claim in a comment is worse than none, because it
launders a bug into an accepted limitation; and a user describing *when* a symptom appears and
disappears is describing the geometry, which is stronger evidence than any counter.

So core is handed an empty polygon and the mask contribution is drawn by hand with
`beginHole`/`endHole`. That is the only version that survives a fully enclosed umbra, and it
removes the single-contour limit outright.

##### What it does not do

**It hides; it does not dim.** A mask is binary, so an umbra clamped to Dim gets no visual
treatment. Knowingly accepted: full blockage is the common case and the one with mechanical
consequences, dimming is cosmetic. A darkening pass over the lighting layer is where it goes.

**A vision-providing light defeats it where it reaches.** `refreshVisibility` draws the full,
untrimmed polygon of any light with `data.vision` into `light.mask`
(`visibility.mjs:542-546`), and it is not observer-relative. Drawing our own contribution does
not remove theirs. `umbra.mask().visionProvidingLights` counts them; a non-zero count is the
remaining known hole in this approach.

**`los` is never touched**, and that is load-bearing: the umbra is computed from `los` and
cached on its identity, so modifying it would invalidate the cache that produced the
modification.

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

  > **Confirmed live 2026-08-22** — darkness bubbles render at double their authored radius
  > whenever an observer has low-light vision. **Pull this fix forward, ahead of the rest of
  > §4.4.** The argument is not correctness but instrumentation: every darkness on the scene
  > is currently a different size from the one configured, so every geometry observation is
  > being made against a scene that does not match its own data. Same category as the
  > light-priority-edges bug (§4.1.1 path 3) — it corrupts the test bed, not just the
  > picture, and that is the expensive kind.

### 4.5 Darkvision — post-contest, override

A remap of the **resolved tier**: treat non-magical darkness as Normal within range,
rendered desaturated. Runs **after** the contest because it overrides the outcome rather
than changing what produced it.

### 4.5.1 Observer-side blindness — when your own square defeats your senses

**Found by testing 2026-08-22, and not previously written down.** A darkvision token standing
in Supernatural Dark still renders black-and-white terrain around itself. §4.8's perception
layer does not touch this and cannot: terrain comes from the vision source's polygon and
vision mode, while perception governs detection modes.

This is a third question, distinct from the two the document already answers:

| Question | Where |
| --- | --- |
| How bright is this point? | §3, §4.1 |
| Can I make out something *at* that point? | §4.8 |
| **Does my vision function at all, where I am standing?** | **here** |

Foundry answers the third one natively and answers it *correctly* for supernatural darkness
— native suppression path 4 blinds a vision source whose origin is inside a darkness. We
disabled it because it is indiscriminate: it fires for ordinary *darkness* too, where
darkvision is supposed to work perfectly.

So the work is to **re-apply blinding selectively**: suppress the vision source when the
tier at the observer's own origin is below what every sense it has can handle. Cheap — it
is `perceivedTier` evaluated at one point, the observer's own — and it reuses machinery
already proven rather than adding any.

**Two conditions, not one.** The tier must be Supernatural Dark **and** the winning
suppressor must cast an umbra (§4.3) — `level >= 1`. Blinding is the degenerate case of a
360° umbra, so it is only correct where an umbra would exist. Level-0 mundane darkness never
blinds however dark it is configured, which is what keeps a creature on an unlit hillside
able to see a lit window.

**`sid` (see in darkness) is the exemption, and PF1 leaves it stranded.** The sense exists
as a trait and a change flag (`pf1/module/documents/actor/actor-pf.mjs:1639`,
`config.mjs:2021`), appears on the sheet, and `_syncSenses` **never reads it** — no
detection mode, no vision behaviour. It has always been inert in Foundry. It becomes
meaningful here for the first time, because Supernatural Dark is the first thing in this
model it is supposed to counter. Read it off
`actor.system.traits.senses.sid` directly; there is no Foundry-side representation to
consume.

**It is "perfect vision in all darkness", which is three mechanisms, not one.** Getting only
the first two produces a creature that detects every token in line of sight while standing
in a black void:

| Piece | Where |
| --- | --- |
| Detect tokens regardless of tier | `perceives` and `darkvisionSees` short-circuit |
| Never blinded | this section |
| **See the terrain** | `data.radius` raised in `_initialize` |

The third is the substantive one. Terrain is revealed by the vision source's own
`data.radius` painting the vision mask (`groups/visibility.mjs:575-590`), and a creature
with see-in-darkness but no darkvision has a radius of zero. Filling its whole LOS keeps
walls blocking, since the LOS polygon is what is being filled, and its vision mode stays
`basic`, so lit and unlit ground still read as brighter and darker rather than flattening to
grey. GM vision without the god's-eye. **A maximum, never an assignment** — darkvision or
`sight.range` may already reach further.

#### It is a range, not a flag — *true seeing* shares the faculty

Two PF1 senses grant light-independence and differ only in reach, so the model carries a
**distance** rather than a boolean:

| Sense | Reach | Rules text |
| --- | --- | --- |
| *See in darkness* (`sid`) | unbounded | "perfect vision in all darkness" |
| *True seeing* (`tr`) | its own range, 120 ft | "sees through normal and magical darkness" |

Neither is a wider darkvision — darkvision is defeated by supernatural darkness and these
are not — so neither can be expressed by extending a radius. They are an exemption from
light level *as a constraint*, bounded by distance.

PF1 handles *true seeing* halfway already: `_syncSenses` bumps `basicSight.range` and
`sight.range` to the spell's range and drops the vision mode back to `basic`
(`pf1/module/documents/token.mjs:225-232`), so detection and terrain both reach. What it has
no way to express is that the reach **survives magical darkness** — which is precisely what
§4.8's darkvision gate would otherwise take away from it. So true seeing needs the exemption
even though it needs nothing else.

**Not implemented for see invisibility, deliberately.** It interacts only with the invisible
condition and grants nothing about darkness. §4.8's narrowing of PF1's out-of-range lit
branch is what keeps it that way — without it the sense would quietly confer
darkness-piercing it does not have.

#### Blindsight sits here too, and the split it forces

**Added 2026-08-22, after testing.** Detection through supernatural darkness already worked —
`NonSightMixin` (§4.8) fixed that. What did not was **terrain**: Foundry paints it from
`data.radius ∩ los`, and `los` is truncated at a supernatural boundary, so a blindsighted
creature detected every token in range while standing in an unpainted void.

Blindsight is exactly what `darkSightRange` models — perception that light cannot constrain,
bounded by a range — so it belongs there. But it must **not** feed the §4.8 detection
short-circuits, hence two functions:

| | Includes | Drives |
| --- | --- | --- |
| `darkSightRange` | see-in-darkness, true seeing, **blindsight** | terrain radius, blinding, sweep rank |
| `visualDarkSightRange` | see-in-darkness, true seeing | `perceives` / `darkvisionSees` |

The reason is Foundry plumbing, not rules: `testVisibility` runs `basicSight` and
`lightPerception` **before** the special modes, and only a special mode sets
`object.detectionFilter` (`groups/visibility.mjs:759-790`). Let `lightPerception` start
succeeding for a blindsighted creature and the target is still detected — by the wrong mode,
with PF1's blue blindsight outline silently gone. The rules agree anyway: blindsight
perceives, it does not *see*, and should not let you read a scroll in the dark.

> **Known leak, accepted.** Raising the source to `PIERCING` untruncates `los`
> **everywhere**, not only within blindsight range. So a blindsighted creature can see *lit*
> terrain beyond a supernatural darkness that lies further off than its blindsight reaches.
>
> The exact fix is to sweep `shape` at piercing rank constrained to `darkSightRange`, and
> union that into the normal shape — terrain within range revealed regardless of darkness,
> ordinary sight beyond. It is not taken because `shape` is the single most load-bearing
> property on a source (§6.2.4 cost several rounds to learn that), and the leak is narrow:
> lit ground, beyond a supernatural darkness, beyond the creature's blindsight. Over-blocking
> a sense the creature definitely has is the worse error of the two.

### 4.5.2 Seeing *into* darkness — sight-blocking edges

**Found by testing 2026-08-22.** A darkvision token outside a Supernatural Dark bubble still
saw the terrain inside it in black and white; a token with ordinary sight saw it too, merely
very dark. Neither should.

A `PointDarknessSource` **darkens what is drawn; it does not remove it from perception**
(§6.2.3 reached the same conclusion from the rendering side). So no amount of getting the
darkness render right will fix this — the terrain is being *perceived*, and perception of
terrain is the vision mask.

**The mechanism already existed and we switched it off.** Path 1's edges carry
`light: NORMAL` **and** `sight: NORMAL` (`point-effect-source.mjs:216-222`). The sight half
is how stock Foundry hides terrain inside magical darkness. Path 1 disabled `requiresEdges`
because the *light* half corrupted the model's baseline (§4.1.1), and took the sight half
with it without anyone noticing.

**Fix: re-emit the edges with the two restrictions split.**

```js
light: CONST.WALL_SENSE_TYPES.NONE,     // model sees the unsuppressed baseline
sight: CONST.WALL_SENSE_TYPES.NORMAL,   // vision truncates at the boundary
```

`Edge` takes them separately, so this is Foundry's own machinery rather than new geometry.
It also disposes of the obstacle that made the alternative unattractive: subtracting a bubble
from a field of view leaves an **annulus**, and the vision mask is drawn with a single
`drawShape(visionSource.shape)` call (`groups/visibility.mjs:575-590`). Sweeping against
edges never forms one.

#### Which suppressors — narrower than `castsUmbra`

**Edges are global; senses are not.** So sight edges may only be emitted where the answer is
the same for every observer, which makes the trigger `blocksSight()` — `castsUmbra()` **and**
the floor reaching Supernatural Dark:

- **Supernatural Dark** — nobody sees in. Global is correct.
- **Ordinary *darkness*** — emits **nothing**, and that is not a compromise. A
  normal-sighted creature has `basicSight.range` 0 and gets terrain from light perception
  alone, so unlit ground is already unpainted for it; a darkvision creature's `data.radius`
  correctly does paint it. Both cases were already right, and edges would break the second
  to fix a first that was never broken.

#### The per-observer exception, via priority

*See in darkness* has to see in regardless, and a global edge cannot carry an exception —
except that Foundry already built one. An edge is skipped when
`edge.priority < edgeType.priority` (`clockwise-sweep.mjs:236`), so a vision source whose
priority outranks every darkness source sweeps straight through their edges.

**This cannot overreach into walls, by construction.** `_determineEdgeTypes` registers wall
edges at `-Infinity` (`clockwise-sweep.mjs:101`) while darkness edges take the sweep's own
priority (`:127`). No priority value can make a wall stop occluding — which is what makes
this safe to use rather than merely clever.

The priority is computed live as `max(darkness priorities) + 1` rather than fixed at a large
constant, because a darkness edge inherits its source's authored `priority` and a GM may set
that to anything. A constant would be a silent ceiling that fails only on the one scene where
somebody used a big number.

#### Splitting the restrictions without reimplementing edge construction

`super._createEdges()` builds them, then the light restriction is relaxed to `NONE`
afterwards. Rewriting the construction to change one flag would mean tracking core's edge
bookkeeping — ids, the `canvas.edges` registration, direction — forever. The sweep reads
`edge.light` when it runs, long after the override returns.

Worth noting what this does *not* disturb: darkness sweeps include only wall and light edges
(`clockwise-sweep.mjs:131`), so darkness sources still do not cut each other; and light
sources keep `requiresEdges: false` from path 3, so nothing cuts the darkness either.

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

### 4.8 Vision as perception — where the tier becomes *seeing*

**Built 2026-08-22.** §3 and §4.1 say how bright a point is. This says what that means for
whether a creature can see something there. They are separate questions, and keeping them
separate is what lets the renderer and the perception layer disagree productively — the
screen shows the GM what exists, perception decides what each creature makes of it.

The gap was visible: with lighting fully correct, a token standing in a *darkness* was
still plainly visible. Foundry's light-perception test is
`canvas.effects.testInsideLight(point)` — is this point inside some light source's polygon
— and §6.2.4 forbids clipping `source.shape`. The raw torch polygon still covers the
darkness, so the answer stayed *yes* regardless of what the renderer drew. Nothing about
the renderer could have fixed it.

#### The mapping

| Foundry mode | PF1 sense | Rule here |
| --- | --- | --- |
| `lightPerception` | ordinary sight | tier ≥ **Dim** |
| `basicSight` | darkvision (PF1 folds blindsight in) | in range, and tier **above Supernatural Dark** |
| `seeInvisibility` | *see invisibility* / *true seeing* | in range, **or** tier ≥ Dim |

The thresholds are the whole ruleset, and they are the reason §3.1 has five tiers rather
than four. Ordinary sight works down to dim light and stops at Dark. Darkvision ignores
light level entirely — that is the faculty — but is defeated by *supernatural* darkness.
Without a tier that distinguishes "unlit" from "magically unlit", darkvision has nothing to
fail against and *deeper darkness* is indistinguishable from a moonless field.

#### Two levers, and why not one

**`testInsideLight` is overridden**, so core's light perception is corrected at the source.
Only the call with no `condition` is intercepted, and that is a precise discriminator
rather than caution: core has exactly two callers, and the other is
`PointDarknessSource#updateSuppression` (path 2 in mirror image), whose answer we already
discard. Re-deciding *that* one from the model would feed the contest's output back into
its input.

**The detection modes are also mixed into**, for two things the override cannot do:

- **Supply an observer.** `testInsideLight(point)` has no parameter for one, and §4.3 makes
  the answer observer-dependent. The mixin wraps `_testPoint` and sets the observer as an
  ambient the override reads. Threading it now costs nothing; retrofitting it through
  three modes after umbra lands costs a rewrite.
- **Darkvision.** It has no light test to correct — core gates it on range and LOS alone,
  which is right — so its Supernatural Dark exception has to be added, not fixed.

**Sight modes only, and blindsight is the reason it matters.** Tremorsense, lifesense and
blindsense do not consult light and must not start to. Blindsight looks like a
counter-example, because PF1 inflates `basicSight.range` to
`max(baseRange, darkvision, blindsight)` for the black-and-white rendering
(`pf1/module/documents/token.mjs:205-213`) — so our darkvision gate does fire on a
blindsighted creature. But PF1 *also* pushes a separate `blindSight` mode at
`DETECTION_TYPES.OTHER` whose `_canDetect` returns `true` unconditionally
(`pf1/module/canvas/detection-modes.mjs:73-87`), and detection is a disjunction over modes.
So the creature fails the sight test — correctly, if it has no darkvision — and still
detects through the mode we never touched. Gating every mode would have blinded blindsight
for real.

`seeInvisibility` needs a third shape again. PF1 replaces the mode with one that detects
**in range, or anywhere lit**, and its light half reads `lightSource.shape.contains()`
directly, so overriding `testInsideLight` does not reach it. It does not need
reimplementing, only narrowing: beyond `mode.range` the only way the chain can have
returned true is the lit branch, so re-deciding *that* case from the model is correct
without knowing how the branch is written.

#### Composition and hook order

Mixins re-parent the live instance onto a subclass of its own constructor
(`Object.setPrototypeOf`), which is `limits`' pattern and composes with PF1's replacements
in either order. **This must run exactly once, at `setup`.** The window is narrow and both
edges are real:

- **After PF1**, which constructs its replacement modes during `init` (`pf1/pf1.mjs:251-258`)
  and assigns fresh instances over `CONFIG.Canvas.detectionModes`.
- **Before `limits`, once only.** `limits` mixes at every `canvasInit` and its `applyMixin`
  is idempotent by *class identity* — it caches what it produced. Re-parenting the instance
  underneath it after it has cached defeats that: the next `canvasInit` sees an unfamiliar
  constructor and adds a **second** copy of its `_testPoint`, one more per scene change,
  indefinitely.

Settled chain: `Limits < Ours < PF1-or-core`, which is also the order we want.

#### Cost

`evaluate()` is 0.0025 ms (§9.7), which is cheap until visibility multiplies it by tokens ×
test points × modes. A one-frame memo keyed on the point removes most of it — the same
point is asked about repeatedly within a pass, since `lightPerception` and
`seeInvisibility` test identical points. Cleared on the next animation frame rather than on
an invalidation signal: within one frame the scene cannot change, which makes the cache
correct without enumerating what would dirty it.

The key includes the observer id even though the answer is currently observer-independent.
The day umbra lands, a key that silently shares entries between observers is a cache bug
that presents as a rules bug.

#### Verified 2026-08-22

On a live scene, two tokens inside one *darkness*:

- Plain sight: sees neither the area nor the other token. ✓
- Darkvision: sees the area in black and white, and sees the other token. ✓
- Detection-mode chain confirmed `Limits < Ours < core-or-PF1` on all three sight modes,
  single `limits` layer on the six non-sight modes.
- **No stutter dragging several tokens.** The one-frame memo holds; the cost risk on
  `testInsideLight` becoming `evaluate()`-backed did not materialise.

**One case is unimplemented rather than broken.** A plain-sight token *inside* the bubble
can still see lit areas outside it, and tokens standing in them. That is umbra (§4.3), and
raising it here is what caught the error in how §4.3 was specified — see the amendment
there. Under the corrected rule the umbra clamps to the bubble's own tier, so on a scene
dark enough for the interior to read Dark the occupant is blind to the outside too.

#### Known limitations

- **Still god's eye.** Every observer gets the same tier until §4.3, §4.4 and §4.5 exist.
  The plumbing is in place; the rules are not. Most visibly, a *darkness* casts no shadow:
  the area beyond it, from an observer's point of view, is unaffected. That is umbra.
- **No concealment.** Dim light grants 20% miss chance in PF1. That is §7.3, and it is a
  mechanical consumer, not a visibility question.

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

> **Built 2026-08-22** — `vision/observer.mjs`. Both jobs, and nothing else: the GM toggle,
> and the vision-sharing narrowing. Four of §5.1's six rows were already correct in PF1 and
> were left alone.
>
> - **Toggle is client-scoped.** It asks what *this* GM is currently looking at, not how the
>   world behaves. Two GMs must be able to disagree, and neither should write to the scene to
>   change their own view. Default **on**, matching PF1's existing behaviour.
> - Exposed as a token-controls toggle, `Alt+O`, and a settings entry. The scene-control hook
>   passes a **Record keyed by control name** in v13 (`scene-controls.mjs:326-336`); the v12
>   `controls.find(...)` idiom silently does nothing rather than erroring.
> - **`observer.status()`** exists because "zero vision sources means god's eye" is an
>   *implicit* contract — nothing declares it, and one token wrongly returning `true` turns
>   the whole GM view into that token's with no error anywhere. It prints the count, the
>   resolved mode, and each token's verdict.
>
> Not done here: §5.3's union semantics (`B` as the max over observers) has no consumer until
> the field itself becomes observer-relative, which is umbra.

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

> **Superseded 2026-08-23 by §3.2.1's rewrite. The conclusion holds; the mechanism is gone.**
> A reduced light still keeps its gradient, but reduction is now *lower the set tier and leave
> the radii alone*, rendered through `dimLevelCorrection` / `brightLevelCorrection` — which
> `clip.mjs` already drives per source. The radius-shift identity below was a way to express a
> tier change as geometry back when a source could not carry its own lighting level. It can,
> so the identity is retired along with `reduceRadii`. Kept because the *failure* it rules out
> — a flat fill — is still the thing to avoid, and because the argument is the clearest
> statement of why.

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

#### 6.2.5 A darkness source ignores the vision mode's colour

**Found by testing 2026-08-22.** A creature seeing in black and white gets **full-colour**
terrain inside a darkness bubble, and grey everywhere else.

It is not the vision mode, and no amount of swapping modes fixes it. A vision mode's colour
adjustment is applied to the **primary sprite**: `refreshPrimarySpriteMesh` puts
`visionMode.canvas.shader` on `canvas.primary.sprite` with its sampler pointed at
`this.renderTexture` (`groups/primary.mjs:192-205`), so the desaturation happens *as the
sprite is drawn*.

A darkness source never uses that sprite. It takes
`u.primaryTexture = canvas.primary.renderTexture` (`point-darkness-source.mjs:217`) — the
**raw** texture — and composites its own darkened copy, bypassing the vision mode entirely.

> This is the **fifth** face of §6.2.3's finding. A `PointDarknessSource` is not a
> well-behaved participant in the lighting pipeline: it ignores lighting levels, it cannot be
> dimmed by alpha, it renders differently for GM and player, it carries a padded visual
> shape, and it redraws the map on its own terms. Every one of those cost a round to learn.
> **Assume nothing about it that is true of a light source.**

**Fix: wrap the shader, don't replace it** — `render/desaturate.mjs`, behind the world
setting `desaturateDarkness` (default on).

- Every darkness shader, default and all four animated, ends on the same `FRAGMENT_END`
  (`gl_FragColor = vec4(finalColor, 1.0) * depth;`), so one textual substitution covers all
  of them. Subclassing `AdaptiveDarknessShader` would have missed the animated ones, since an
  animation's `darknessShader` supersedes the layer default
  (`rendered-effect-source.mjs:278`). The wrap is applied in `_configureShaders`, to whatever
  class was chosen.
- **No new uniform.** `saturation` is already declared for every lighting shader
  (`base-lighting.mjs:92`) and no darkness shader reads it, so reusing it avoids touching the
  uniform block — the fragile part of shader surgery. `_updateCommonUniforms` does write it
  (`base-light-source.mjs:220`) from the light's authored value, which is dead data for a
  darkness source; our `_updateDarknessUniforms` runs after and wins.
- Luminance is computed inline rather than via `perceivedBrightness`, because only the
  default shader is guaranteed to include that helper.
- **Fails safe.** If a future Foundry rewrites `FRAGMENT_END`, the substitution finds nothing,
  logs, and leaves the class untouched — degrading to "colour inside darkness" rather than to
  a shader that will not compile.

The saturation value comes from the **single vision source** Foundry itself picks for
canvas-wide tinting (`visibility.mjs:196`). With two vision sources active the canvas tint
already comes from one of them, so matching that choice keeps the inside of a darkness
consistent with the outside rather than inventing a third answer.

##### Withholding — the second adjustment, and two dead ends

Fixing the colour left the bubble still reading **darker** than the ground around it. That is
wrong for **blindsight only** — a creature that maps a room by echo does not experience a
*deeper darkness* over it as anything at all, so the bubble should be *indistinguishable*.
*See in darkness* and *true seeing* are **not** the same case: they see the darkness perfectly
well **as darkness** and see through it, which piercing rank already gives them. They need no
adjustment, and giving them one was wrong.

> **Two shader attempts, both wrong, and wrong for the same reason.** Mixing `finalColor` back
> toward `baseColor` gave the raw map at full brightness — *brighter* than the night around
> it. Mixing toward `baseColor * computedBackgroundColor` gave the **ambient background** term,
> which on a night scene is nearly black — a black disc, and worse than the original bug.
>
> The mistake in both was the assumption that the surroundings are expressible in that shader.
> They are not: the grey around the bubble is painted by the **vision source**, and a darkness
> shader has no access to that term. There is no correct value to mix toward.

**So the mesh is withheld instead** and the ordinary pipeline draws the ground, vision paint
included. That is not a workaround — it is the only way to get *the same answer as the ground
next to it* rather than an approximation of it. `_drawMesh` already has the path (§6.2.3's
`HIDDEN`), and it is the one lever measured to work, since alpha does not stop a darkness
source drawing.

**It needs a lighting refresh on observer change.** `_drawMesh` runs on a *lighting* refresh,
but changing the selected token triggers only a *vision* one — so without a hook the bubble
keeps the previous observer's appearance until something else dirties lighting, which reads as
the feature working intermittently. Guarded on the answer actually changing, and it requests
lighting only, so it cannot feed back into the hook that drives it.

##### Superseded: unveiling in the shader

Fixing the colour left the bubble still reading **darker** than the ground around it. For a
creature that does not perceive by light at all — blindsight, *see in darkness*, *true
seeing* — that is wrong in the same way the colour was: to such a creature the area is simply
floor, and drawing it darker states something false about what it knows.

`pf1Unveil` mixes `finalColor` toward the colour that ground would take with **no darkness
source present**. Alpha is not an option: §6.2.3 measured `colorationAlpha: 0` still leaving
visible darkening, so the shader darkens through more than that uniform.

> **The obvious target is wrong.** Mixing toward `baseColor` — the sampled map before
> darkening — makes the bubble *brighter* than the night around it, because `baseColor` is
> the raw texture at full brightness while the surrounding ground has ambient darkness applied.
> Tried, and wrong in the opposite direction.
>
> The right target is `baseColor.rgb * computedBackgroundColor`, where
> `computedBackgroundColor` is `mix(ambientDaylight, ambientDarkness, darknessLevel)` from
> `COMPUTE_ILLUMINATION` (`base-lighting.mjs:363`) — the same term the ordinary lighting path
> uses for unlit background. It reproduces the surroundings rather than approximating them.
> Available because `_updateCommonUniforms` sets `computeIllumination = true`
> (`base-light-source.mjs:204`), which `PointDarknessSource` inherits.

This one **does** need a new uniform, declared by substituting on `void main()` — an anchor
every fragment shader has. It is emitted only when the base shader actually defines
`baseColor`, since an animated shader may not, and a shader that fails to compile is a black
canvas rather than a slightly-too-dark bubble.

**Unbounded by the sense's range, deliberately.** Fading it out past reach would need the
observer's position and radius in the shader plus a world-space conversion from
`vSamplerUvs`, and buys little: Foundry already clips what that observer sees to
`data.radius`, so ground beyond the sense is not drawn as perceived anyway.

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

#### 6.2.6 An ordinary darkness has no mesh, so it cannot animate

**Reported 2026-08-22** as "animations are broken — they show in the preview but disappear as
soon as you update". They are not broken, and the desaturation wrap (§6.2.5) is not involved.
It follows directly from §6.2.3, and it is the first *user-visible* cost that finding has.

`darkeningStrength` returns 1 only for Supernatural Dark. Everything else gets 0, which sets
`HIDDEN`, which makes `_drawMesh` withhold the mesh. An ordinary *darkness* is rendered by
**removing light**, not by drawing anything — and an animation is a fragment shader on a mesh.
No mesh, nothing to animate. A GM can pick *Roiling Darkness* from a dropdown that visibly
does nothing.

The preview detail is diagnostic rather than incidental: preview sources are excluded from the
registry (§6.6), so the renderer never touches them and the config preview animates correctly.
The animation dies at the exact moment the real source is registered. Anything that looks like
"it worked until I saved it" on this project should be checked against that boundary first.

Two consequences worth recording:

- **Only a supernatural darkness can test the shader wrap.** Appendix C's row said to set an
  animation and watch it; on an ordinary darkness that test cannot fail *or* pass.
- **§7.1 gains a third motivation.** It was already the blocker for drawing a *darkness* on a
  lit map, and then for painting the umbra. It is also the only thing that would give an
  ordinary darkness something to animate, because it is what puts a drawn surface there at
  all. Three separate visible defects, one cause.

Not worth a workaround in the meantime. Synthesising a mesh purely to carry an animation would
mean a second source fighting the first over the same ground, which §6.1 rejects for light and
should reject here for the same reason.

> **Revisited and reversed — 2026-08-24.** The objection above expired when §7.0 landed, and it
> took three months to notice. There is no second source and no fight: the **texture** owns the
> ground's brightness now, so the darkness source is not being asked to darken, only to draw.
>
> And the shader has the dial. An animation modifies `finalColor` *before* the intensity scale
> (`darkness-lighting.mjs:119`):
>
> ```glsl
> finalColor *= (mix(color, color * 0.33, darknessLevel) * colorationAlpha);
> ```
>
> **And `colorationAlpha` is not an opacity, which cost a round.** The first attempt drew the
> mesh at a "faint" `STRENGTH` of 0.2 and produced a near-black disc whatever tier the model
> said — because that uniform *multiplies the output colour*. Lowering it drives `finalColor`
> toward zero, so 0.2 is not a fifth of a darkness, it is very nearly the darkest a darkness
> source can be. The measured note behind `HIDDEN` said as much in 2026-08-22 — *"zeroing
> `colorationAlpha` does not stop a darkness source drawing"* — and reads, in hindsight, as
> exactly this fact from the other side.
>
> **The identity is white at alpha 1.** There, `finalColor` leaves the shader as the scene it
> sampled, and the animation is the only thing that moved it. So the source is drawn with its
> colour interpolated toward white rather than its alpha reduced — `DARK_ANIMATION` marks it,
> and the tint is 0, meaning the ground stays exactly at the tier the texture set.
>
> `animateDarkness` is a plain boolean, default on, and it applies **only to a darkness that has
> an animation configured**. One without is untouched: no mesh, no cost, no tint.
>
> **Darkvision had to be told too.** §6.2.5's desaturation wrap puts the vision mode's colour
> adjustment back on the darkness shader, so a darkvision observer saw an animated *darkness*
> reducing Bright to Normal in grey — desaturating is what darkvision does to *a darkness*, and
> an animation-only source is not one. `saturation` is forced to 0 on that branch.
>
> Two things worth keeping. *A limitation derived from an architecture outlives the architecture
> unless something re-derives it* — nothing about §6.2.6's reasoning was wrong when written. And
> *a uniform named like an opacity is not necessarily one*; the correct reading was available in
> one line of shader source and I inferred it from the name instead.

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

### 6.4.2 The ground feather — built, then retired — 2026-08-23/24

A gradient on the `ambient`/`dark` regions in the darkness-level texture. **Removed at Patrick's
call on 2026-08-24**: it cost 55 ms of a 74 ms repaint on a drag, turning 41 cells into 166
meshes and 38k triangles, and *"they're magical darkness, so a sharpness is fine at the end of
the day"*. The section is kept for the two findings, both of which would otherwise be
rediscovered the hard way.

#### A filter cannot reach `illumination.darknessLevelMeshes`

Three rounds went into a `PIXI.BlurFilter` on that container. It installs, registers, and
**runs** — measured `attached: true`, `registered: true`, `renderable: true`, `worldAlpha: 1`,
`frame: 5200×5200`, `strength: 228`, `applies: 662` — and the map was unchanged.

```js
// cached-container.mjs:278-281
const fs = renderer.filter.defaultFilterStack;
if ( fs.length > 1 ) fs[fs.length - 1].renderTexture = tex;
```

`CachedContainer` only redirects filter output onto its cached texture when the container is
**already nested inside another filtered container**. `canvas.masks` is not, so `fs.length === 1`,
the redirect never fires, and the result goes to PIXI's root state. Proved rather than deduced:
a filter writing a constant to every pixel left the map untouched, and the map demonstrably
renders *from* this texture.

`PIXI.BLEND_MODES.MIN_COLOR` (`blend-modes.mjs:20`) fails for a different reason and is worth
noting beside it: the container is cleared to `canvas.environment.darknessLevel` and `MIN` can
only *brighten* from the clear, so every `dark` cell on a lit map would vanish. Core resets that
clear every frame (`groups/effects.mjs:240-242`).

**So the darkness-level texture takes no post-processing at all.** Anything that must vary
within it has to be geometry.

#### A correct no-op is indistinguishable from a broken mechanism

Three rounds of "still seeing nothing" ended at this readout:

```
outside: 1,  ramped: 0,  skippedFlat: 7,  sceneDarkness: 1
levels: [1, 1, 1, 1, 1, 1, 1, 1]
```

At scene darkness 1 the ambient tier is Dark, and a *darkness* cast on already-dark ground is
also Dark. Every cell and its surroundings were at the same level, so there was no brightness
edge to ramp and the feather declined to invent one — correct, and visually identical to a
broken feather. Only a readout naming what it **skipped** separated the two. Same lesson as
§3.2.1's closing note about absence, arrived at from the other end.

### 6.4.1 As built — the light-edge levers — 2026-08-23

`render/soften.mjs`. The module draws two different sorts of thing and they fail differently at
their boundaries, so there are two settings rather than one.

**Light edge softening** (`edgeSoftness`, default 0.3 grid squares, Foundry's own is 0.08). A live static getter
for `EDGE_OFFSET` on the patched source classes, so real lights, `reduced` fills and `stack`
clones all feather at the same rate — which matters, because a `stack` clone has to blend into
the very light it is standing in for. A getter rather than a value because `_updateGeometry`
re-reads `this.constructor.EDGE_OFFSET` on every mesh, so the setting takes effect on the next
source rebuild with nothing to invalidate.

Its cost is **linear in the offset**: `PolygonMesher` runs `ceil(|offset| / 3)` ClipperOffset
passes (`polygon-mesher.mjs:20`), so the default triples Foundry's three passes to eight, on
every soft-edged source. §9.5 already measured soft edges at ~3.9× hard ones at `-8`. Two of
Foundry's own gates also apply and are the likely explanation if it appears to do nothing:
`canvas.performance.lightSoftEdges` is off below **Medium** performance mode
(`board.mjs:876-884`), and soft edges are disabled outright for unobstructed circular sources,
which take their falloff from `attenuation` instead (`point-effect-source.mjs:118`).

**Darkness edge softening** (`darknessSoftness`, default 1.5 grid squares, core's is 0.5).
**Reaches supernatural darkness only**, and that is not obvious: with the takeover on,
`darkeningStrength` withholds the mesh for every tier but Supernatural Dark, so an ordinary
*darkness* draws no source at all and its disc is a `dark` region in the texture. Measured on a
live scene, one darkness source drawn out of seven. Softening an ordinary darkness circle is
the blur's job and only the blur's. A third mechanism even so, because a darkness source that
*is* drawn softens its rim a third way again — a padding band,
not the polygon inset and not the blur:

```glsl
depth *= (1.0 - smoothstep(borderDistance, 1.0, dist));   // darkness-lighting.mjs:94
borderDistance = radius / (radius + _padding)             // point-darkness-source.mjs:118
```

`_padding` is a **fixed number of pixels**, so the fade gets proportionally tighter the bigger
the darkness is: core's `0.5 × grid` is a fifth of a 20 ft disc's radius and reads soft, and a
twenty-fourth of a 60 ft disc's and reads as a hard circle. Reported 2026-08-23 as *the umbras
smoothed out but the darkness discs stayed sharp*, which is that ratio exactly.

Raising it widens only the picture. `_createShapes` sweeps the padded radius into `_visualShape`
for rendering and builds `this.shape` from the **true** radius
(`point-darkness-source.mjs:131-140`), and `shape` is what `testPoint` and the whole model read
— so the spell still covers what it should. Applied in `_initialize` rather than the
constructor, which is what makes the setting live, and **not** applied to our own pooled fills:
their `_createShapes` returns early on `directPolygon` and never builds the padded shape the
fade band needs, so widening it there would eat into the fill instead of sitting outside it.

`game.pf1Lighting.render.soften()` reports both, including `softEdgesAvailable` — the two things that would explain a half of this silently doing nothing.

###### The units were an order of magnitude out — 2026-08-23

Three levers changed and the screen did not move. The diagnostic then said
`blur: {attached: true, strength: 9.31}` — installed, registered, running, and invisible.

**Both edge settings were exposed in raw pixels, and pixels are the wrong unit here.** 16px of
blur on a 100px grid is four fifths of a foot; 24px of polygon inset is a quarter of a square.
They were doing precisely what they were told, at a scale nothing could see, and a slider whose
whole range tops out below the useful minimum gives no hint of that.

Both are in **grid squares** now, matching `darknessSoftness`, which had been written that way
from the start and was the only one of the three with a sane magnitude. The lesson is narrow
and worth keeping: *a setting whose unit the author has to convert in their head is a setting
whose default will be wrong.*

The polygon inset does have a real ceiling, which is why its range stops at one square rather
than four. `PolygonMesher` runs `ceil(|offset| / 3)` offsetting passes — about ten at the
default and thirty-three at the maximum — and, more sharply, the inset **shrinks** the polygon
before ramping across the band, so a feather wider than half a narrow region's width consumes
it entirely. A thin crescent of band overlap is exactly such a region.

###### Two pooled-source bugs found while chasing this — 2026-08-23

Hard arcs survived turning soft edges on, and the cause was not the softening at all.

**`HARD_EDGES` was sticky.** Nothing ever cleared it, so a pool slot once used for a split
cell's clone kept the flag for the rest of the session and every later fill in that slot
rendered hard whatever it asked for. `pool.fill`'s own comment already stated the principle for
`animation` — *"pooled, so these are assigned unconditionally rather than only when present"* —
and this flag was simply missed. It is a parameter now, always assigned.

**And it was applied a rebuild late.** The renderer set it with `clip.setHardEdges(clone, true)`
*after* `pool.fill` returned, but `_initializeSoftEdges` runs inside `initialize()` from
`_configure` (`rendered-effect-source.mjs:243`). So the flag never described the geometry it was
meshed with — on a fresh source it did nothing at all, and on a pooled one it applied whatever
the slot's previous tenant had left. Both halves of §6.2.1's seam machinery were therefore
unreliable, which is worth knowing independently of edge softening.

The general lesson is the pooling one, and it now has two instances: **every per-source property
a pooled fill can carry has to be assigned on every fill, not only when it is wanted.**

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

> **Wanted 2026-08-22:** darkness rings currently read as hard rims and should be
> gradiented. Two separate causes, and only the first is this section's `EDGE_OFFSET`
> knob:
>
> 1. `EDGE_OFFSET` is small, as above — affects every source.
> 2. **A clip is a hard edge by construction** (§8.1). Wherever the renderer narrows a
>    source to a cell, that boundary has no ramp at all, and split cells force
>    `HARD_EDGES` deliberately to stop the two halves fading against each other into a
>    visible bright seam (`constants.mjs`, `HARD_EDGES`).
>
> So the fix is not one slider. An unclipped darkness gets softer for free; a clipped one
> needs the ramp reintroduced on the *original* rim while the cut edges stay hard — which
> means distinguishing the two edge classes within a single polygon, and `PolygonMesher`
> ramps the whole perimeter uniformly. Not hard, but not one number either. Do it after
> §7.1, since global illumination changes what a darkness is drawn *against*.

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

### 7.0 Global illumination as a real emitter — the prerequisite

**Proposed 2026-08-23, not built.** §7.1 below assumed this "falls out of §4.3 making global
illumination clippable". §4.3 shipped without it — umbra went via sweeps and edges instead — so
it is now its own work item, and it is the one blocking three separate visible defects:

1. A *darkness* on a lit map is computed correctly and **drawn not at all** (§6.2.3).
2. An umbra shadows what lies beyond it but **does not paint it** (§4.3 stage B).
3. An ordinary darkness has no mesh, so its **animation dropdown does nothing** (§6.2.6).

One cause: global illumination is unconditional. Nothing can be darkened below it, because it
is re-added everywhere after anything we do.

#### What the source actually looks like

Two findings from reading `global-light-source.mjs`, both better than assumed.

**`GlobalLightSource` has a `customPolygon` field** — a documented, first-class hook, used by
`_createShapes()` as `this.shape = this.customPolygon ?? canvas.dimensions.sceneRect.toPolygon()`.
No subclass is needed to reshape it. Its other differences from an ordinary light are all
data: `dim`/`bright` at `maxR`, `attenuation: 0`, soft edges off, `walls: false`,
`elevation: Infinity`, `priority: -Infinity`.

**An ordinary light source already paints with the scene's ambience.**
`BaseLightSource#_updateCommonUniforms` sets `computeIllumination = true` and uploads
`ambientDaylight` / `ambientDarkness` / `ambientBrightest` and the four weights for *every*
light source (`base-light-source.mjs:199-215`). So a synthetic fill standing in for global
light is not a lookalike — it runs the identical colour pipeline. Only two uniforms are
peculiar to the global source:

| Uniform | Effect | Reproducible? |
| --- | --- | --- |
| `globalLight` | `depth = … * (globalLight ? 1.0 : elevation depth test)` — bypasses elevation occlusion (`base-lighting.mjs:394`) | Yes, one line in `_updateCommonUniforms` |
| `globalLightThresholds` | the darkness-level band the source is active in | Yes, or gate creation on it |

That matters because it means the fidelity risk of standing in for global illumination is
low, which is the thing that would otherwise sink the approach below.

#### The obstacle: one ring, no holes

`customPolygon` cannot express "scene minus a darkness in the middle". Both consumers take a
single closed ring:

- `PolygonMesher` reads `poly.points` as one flat array (`polygon-mesher.mjs:22-26`);
- the visibility mask does `drawShape(globalLightSource.shape)` (`visibility.mjs:639`).

A darkness orb away from the scene edge makes exactly that hole, which is the common case
rather than the exotic one. Clipping the singleton in place is therefore not available.

Nor is layering: illumination composites with `MAX_COLOR`, so a dimmer fill painted over
global light loses to it. The global contribution has to be *absent* from the region, not
outvoted.

> **Extra `GlobalLightSource` instances do not work either**, and the reason is worth
> recording because it looks like it should. Both `EffectsCanvasGroup#testInsideLight`
> (`effects.mjs:342`) and the visibility mask loop (`visibility.mjs:540`) skip anything
> `instanceof GlobalLightSource`, handling `canvas.environment.globalLightSource` as a
> special case instead. Additional instances would render but be invisible to the mask, so
> the region would go unrevealed. Any stand-in must **not** be an instance of that class —
> which is fine, since none of what it does requires being one.

#### Proposed: take over the ambient fill

Global illumination becomes an emitter like any other, and the renderer paints it from cells.

1. **Give the ambient emitter a polygon.** It is already in the registry as `isGlobal` and
   `field.compute` sets it aside precisely because it has none (`field.mjs:380-385`). Hand it
   `canvas.dimensions.sceneRect.toPolygon()` and it becomes cuttable by the existing
   subdivision, with no new geometry code.
2. **`field()` emits ambient cells** for the unsuppressed remainder. This is the new work:
   cells today are per-emitter (`clip`, `reduced`, `dark`) and bare ground lit only by ambience
   has no cell at all. Hole-free splitting already exists for annuli (§6.2.1) and applies
   unchanged.
3. **Paint each cell with a pooled synthetic light** at the cell's resolved tier, via
   `clip.setLevel` — the same per-source `dimLevelCorrection` dial the renderer already uses
   for `reduced` cells. A *darkness* over Bright ground becomes a Normal-tier fill, which is
   exact rather than approximate.
4. **Stand the singleton down** while this is active, so the two do not both paint.

What this buys, beyond the three defects: an ordinary darkness gets a real drawn surface, so
§6.2.6's animation problem dissolves rather than being worked around, and the umbra becomes
paintable by the same mechanism that paints everything else.

#### The decision this needs

**Scope.** Step 4 means the whole map renders through this module whenever the renderer is on
and the scene has global light — not just the parts near a darkness. The fidelity argument
above says that should look identical, and the `computeIllumination` finding is strong
evidence for it. But the failure mode moves: today a bug shows up as "the darkness looks
wrong", and after this it could show up as "the whole map looks slightly wrong".

Mitigation is a separate setting, defaulting off, so the ambient takeover can be switched
independently of the renderer and bisected against — the same split that made
`umbraPerception` separable from `perceptionEnabled`, and for the same reason.

**Cost.** Synthetic source count rises from "suppressed cells" to "every cell". §9.6 measured
119 sources at 10.4 ms on a worst case, already pool-bound. Needs measuring before it is
trusted, not assumed — the ambient remainder on a wall-heavy scene could decompose into many
more pieces than the suppressor regions do.

#### As built, step 1 — the cells — 2026-08-23

Deliberately **model only**. `field()` emits the cells; nothing paints them yet, and Foundry's
singleton still owns the picture. The point of stopping here is the cost question above: the
piece count is the thing that decides whether the takeover is affordable, and it is knowable
before a line of rendering is written.

**Step 1 of the plan was already done.** The ambient entry wraps
`canvas.environment.globalLightSource`, whose `_createShapes` sets `shape` to the scene rect —
so `ambient.path()` has always worked. `compute()` was not lacking geometry, it was filtering
the emitter out. The comment claiming global illumination "has no polygon" was wrong, and had
been since the registry was written.

**Ambient is the complement of the *regions*, not of the `dark` cells.** A slice of a
suppressor cancelled by a *daylight* is absent from `effective`, and ambient applies there
normally — so subtracting `effective` is exactly what keeps that slice lit. Subtracting the
`dark` fills instead would also punch out wherever a `reducing` emitter lit the ground, which
is a different question and would have shown up as unlit patches under torches.

**The emitter loop is untouched.** Ambient stays out of it: it has no origin and no radii, so
clipping and radius-shifting are both meaningless for it, and `reduced` cells in particular
would have produced a radius-shifted ramp from a source that has no ramp. It gets one pass of
its own after the fills.

**The no-suppressor branch stays Clipper-free.** It emits the scene rect as one cell directly,
so the common case does not pay two ops for a feature it is not using. With suppressors it
costs a union and a difference, against §9.6's budget of many.

Cells are inert to every existing consumer — the renderer's three loops, `umbra.mjs` and
`umbra-edges.mjs` all filter by kind — so this changes no behaviour. The debug overlay draws
them faintly, first, underneath everything else.

**Measured:** `byKind.ambient` = **5** on the populated test scene. Comfortably affordable, and
it settles the cost question the step existed to answer.

#### As built, step 2 — the takeover — 2026-08-23

Behind `ambientTakeover`, default **off**, requiring the renderer. `render/ambient.mjs`.

**The singleton keeps the largest piece.** `customPolygon` holds one closed ring, so the
biggest ambient cell goes to Foundry's own global source and only the fragments become pooled
fills. Most of the scene therefore still renders through the real thing, and the visibility
mask's global contribution — `drawShape(globalLightSource.shape)`, also one ring — covers as
much as it can.

**`customPolygon` is assigned inside `_createShapes`, immediately before `super` reads it**,
rather than written onto the source from outside. The global source is not ours; Foundry
rewrites its data on every environment change, so it is the wrong place to keep state, and
assigning at the point of use leaves no window where the two can disagree.

**Two corrections forced by the takeover, both about reading back our own output:**

1. **The ambient domain is `canvas.dimensions.sceneRect`, not `ambient.shape`.** They are the
   same thing right up until we start writing `customPolygon` — at which point `shape` is this
   module's output, and cutting the next field from it would shrink the cells a little further
   on every pass (§6.6).
2. **The global entry is excluded from the field signature.** `_createShapes` reallocates
   `shape`, so including it would make the signature differ from itself every pass:
   recompute → repaint → new shape → recompute, forever. It contributes nothing anyway, its
   domain being fixed per scene. This is the §8.3 loop hazard in a new place, and the only
   reason it did not bite is that it was looked for.

**Ambient fills carry no lighting level, deliberately.** Passing `TIER_TO_LEVEL[cell.tier]`
is the obvious move and is wrong: full daylight is `B = 1`, our Bright tier, so `BRIGHTEST` —
while Foundry's global light paints at `BRIGHT` (§3.2.1). The stand-in would have been one
level brighter than the primary piece it abuts, showing as a bright seam exactly where a
darkness split the ambient, and reading as an artefact of the *darkness* rather than of the
fill. Stand-ins target the thing they stand in for, not what the tier system would say.

They do set **`globalLight = true`** (via `GLOBAL_FILL`), whose only effect is bypassing the
elevation depth test (`base-lighting.mjs:394`). Without it an elevated tile would occlude the
stand-in and not the original — a seam that appears only on scenes with roofs.

**The mixin must be applied at `init`, not `canvasInit`** — found the same day, from the
takeover computing a correct 38-point ring while the source stayed on its 4-point scene rect.
`EnvironmentCanvasGroup` builds the global source in its constructor as a **non-writable value
property** (`environment.mjs:29-30`), and the canvas groups are created in
`Canvas#initialize()` (`board.mjs:582`) — long before `canvasInit` fires (`board.mjs:1024`).
Patching the CONFIG slot later changes the slot and nothing else: the live singleton stays an
instance of the stock class and can never be replaced.

Two lessons, both general:

- **A CONFIG class slot and the live instance are different questions.** Every other mixin in
  this module goes on at `canvasInit` because the sources it patches are rebuilt per scene.
  This one is built once per page load, so the same timing is wrong. Anything held in a
  group's constructor needs `init`.
- **The failure is silent and reports healthy.** `patched: true`, ring computed, no error —
  only `shapePoints` staying at 4 gave it away. `status()` now reports the CONFIG slot and
  `instancePatched` separately, because those disagreeing is the entire bug.

#### §6.2.4's third consumer comes due — 2026-08-23

**Symptom:** with the takeover on, a bright crescent exactly where a light overlaps a darkness.
The model said Dark there, the cell overlay showed the violet `dark` cell covering it, and
`probe.paintersAt()` reported **nothing painting** — the overlapping light correctly clipped
out. Two unpainted regions rendering differently.

**Cause:** `CanvasVisibility#refreshVisibility` draws `lightSource.shape` — the *unclipped*
polygon — into `vision.light.sources`, `vision.light.mask` and the light cache
(`visibility.mjs:542-562`). A clipped torch still marks its full raw circle as **directly
seen**, and directly-seen unlit ground renders brighter than unrevealed unlit ground.

This is the third row of §6.2.4's own table, which named this exact call site and has been
sitting there since the renderer was written. It was harmless for as long as global
illumination covered everything — "revealed" and "not revealed" look identical on a lit map.
§7.0 is the first thing that makes unrevealed ground *visible*, and it turned a documented
trade-off into a bug overnight.

**Fix:** swap `shape` for `RENDER_SHAPE` around that one method and restore in a `finally`.
Not the mistake §6.2.4 warns against — that is clipping `shape` *as a property*, which also
narrows `testPoint` and the model's view of each light. Here `testPoint` never runs inside the
call, and **darkvision still reveals the region**, because it comes from the vision-source loop
further down the same method, which reads a vision source's polygon and not a light's. A hole
in a *light's* mask contribution is the correct answer: inside a darkness, that light genuinely
does not let you see.

**Four hypotheses died first**, and the pattern in them is worth keeping: dropped annulus holes
(`droppedHoles: 0`), a failing clip (`paints: false`), `effective` excluding the crescent
(mundane lights cannot `break`), and a gap in region coverage (7 regions for 7 suppressors).
Every one was checked against the *model*, and the model was right the whole time. The
measurement that broke it open was the first one that asked about a **different pipeline** —
"what is painting here" returning *nothing* while the screen showed light.

**The `dark` cell above Dark is finally renderable.** With ambient cut out of the region there
is nothing underneath for a fill to lose to under `MAX_COLOR`, so a *darkness* at noon is drawn
by a plain light fill at the resolved tier — exact, not approximate. Dark still needs no fill
(the absence of light is now genuinely the render), and Supernatural Dark is still the darkness
source's job. `render.stats().darkFills` above zero is the observable proof.

#### The darkness-level texture — the mechanism this should have used — 2026-08-23

**Requirement, from Patrick:** brightness is *information*. God's eye, true seeing and
see-in-darkness must show terrain and tokens **and** still render each area at its true tier —
a DM needs to read the map's light levels, not merely see through them.

Light fills cannot do that, and the reason is structural rather than a bug. A region rendered
as *absence of light* stops reading as dark the moment something reveals it: `vision.sight` is
not gated by `light.mask`, so a true-seeing radius paints its whole area at the vision mode's
brightness (§4.5.1's "revealing and brightening are the same act"), and in god's eye
`CanvasVisibility#visible` is `false` outright (`visibility.mjs:496`) so the mask does no work
at all. Confirmed by `probe.paintersAt()` returning empty inside a circle that still looked lit.

**Foundry already has the right mechanism, and it is spatial.**
`canvas.effects.illumination.darknessLevelMeshes` is a cached container rendered to a texture,
handed to every lighting *and* vision shader as `darknessLevelTexture` (`environment.mjs:317`,
`primary.mjs:206`, `background-effects.mjs:57`, `coloration-effects.mjs:44`). `COMPUTE_ILLUMINATION`
then does, per fragment:

```glsl
computedDarknessLevel = texture2D(darknessLevelTexture, vSamplerUvs).r;
computedBackgroundColor = mix(ambientDaylight, ambientDarkness, computedDarknessLevel);
```

So **darkness level is already per-fragment, not a scene scalar** — it is what the core
"Adjust Darkness Level" region behaviour writes into. `BackgroundVisionShader` derives its
colour from the same terms, which is why a region written there keeps its brightness *through*
a vision source's paint. That is the property nothing else has.

This is very likely the correct home for the whole tier model, and it would subsume much of §6:
instead of synthesising light sources to express "this area is Dim", write the tier's darkness
level into the texture and let every shader arrive at it independently.

**SPIKE VALIDATED 2026-08-23** — `game.pf1Lighting.spike.darknessBands()`, five stripes at
darkness 0/0.25/0.5/0.75/1 across a live scene. All five stay **distinguishable in god's eye,
under normal vision, and under darkvision**. They shift in absolute brightness with the vision
mode — darkvision remaps levels — but the ordering and separation survive, which is exactly the
requirement: a DM can always read relative light levels regardless of who is selected.

That is the property light fills structurally cannot have, so the mechanism is settled.

**What it costs to adopt, and what it deletes.** Cells stay, the model stays, the umbra mask
stays, clipping real sources stays (that is what preserves flicker and colour). What gets
replaced is the pair of cell kinds whose only job was faking a per-region brightness:

| Cell | Today | Under the texture |
| --- | --- | --- |
| `ambient` | pooled stand-in light sources (§7.0) | one mesh, holes native |
| `dark` above Dark | pooled light fill at a tier | one mesh |
| `clip` | real source, clipped | unchanged |
| `reduced` | synthetic source, radii shifted | unchanged |

**Annulus splitting disappears for both**, because a mesh is triangles and
`PIXI.utils.earcut(vertices, holeIndices, 2)` takes holes natively. The ambient complement —
scene rect with one hole per darkness, whose full-width cuts caused every seam bug of
2026-08-23 — becomes a single mesh with N holes. `SEAM_OVERLAP` becomes unnecessary rather
than tuned. Splitting survives only for `clip` and `reduced`, where the pieces are local to one
emitter and were measured invisible (§6.2.1).

Also deleted: the `GlobalLightSource` stand-in property cloning (`level`, `dim`/`bright`,
`darkness` band, the `globalLight` uniform contract) — four separate bugs, all of them
instances of expressing a *number* as an *object*.

**Duck-typing a Region.** `RegionMesh` and its shaders read five things, and a missing one
throws **inside PIXI's render loop** — once per frame, blacking out the canvas rather than
producing an attributable error. Enumerate them, do not discover them: `geometry` (with
`refCount` and `_updateBuffers`), `bounds`, `document.elevation`, `document.polygonTree`,
`document.testPoint`. Table and line references are in `spike/darkness-level.mjs`.

**It also dissolves the umbra-dimming impasse.** The texture is scene-wide, which looks like it
rules out observer-relative use — but so is `vision.light.mask`, and the umbra already uses
that. **The screen only ever renders one point of view**, so a scene-wide buffer rebuilt per
refresh carries observer-relative data perfectly well.

So umbra stops being a special case: instead of "hide this region from this observer", it is
"write the clamped tier into the texture over this region" — the same mechanism as the
god's-eye field with observer-dependent input geometry. Consequences:

- **A Dim-clamped umbra renders**, which a binary mask structurally cannot do. That was written
  off as an accepted gap two hours before this finding.
- **Darkvision through a Dark umbra falls out correct** — it remaps levels, so it sees the
  region but darker, obtained from the shader rather than from branching on senses.
- **Cost stays in the mask's class**: triangulation plus a texture re-render, *no source
  construction*. That was the constraint that ruled out injecting umbra into `field()`.

Carried forward: `canvas.effects.getDarknessLevel` becomes observer-relative, which core and
other modules may not expect; multiple simultaneous observers keep the §5.3
intersection-of-shadows approximation; and whether the mask is still wanted for hard blocking
and fog — "not seen" is not the same as "seen but dark" — is a decision, not an assumption.

**Superseded open questions:**

- `EffectsCanvasGroup#getDarknessLevel` iterates the meshes calling
  `mesh.region.document.testPoint` (`effects.mjs:391-396`), so a mesh of ours needs either a
  region-shaped stub or a patch there.
- Whether it composes with, or replaces, the ambient stand-in fills of §7.0.

#### As built, step 3 — the texture takes over — 2026-08-23

`render/darkness-texture.mjs`, and the deletions promised above were all taken. `ambient` and
`dark` cells now go to the texture; `clip` and `reduced` are unchanged.

**The rule turned out to be one sentence per half.**

*Brightness:* one `AdjustDarknessLevelRegionShader` mesh per cell, at `TIER_TO_DARKNESS[tier]`.
Cells partition space by treatment (§6.1), so the set is disjoint — which is **required**, not
merely tidy: `invalidateDarknessLevelContainer` sorts both containers by darkness level
*descending*, so where meshes overlap the **lowest** level wins
(`illumination-effects.mjs:106-110`). A scene-wide ambient layer with darker regions painted on
top would be erased by the layer beneath it, which is the opposite of the intuition.

*Global illumination:* narrow the `globalLightThresholds` **uniform** on the global source to
`GLOBAL_LIGHT_CUTOFF`, the Dim/Dark boundary. The shader already tests
`computedDarknessLevel > globalLightThresholds[1] → discard` per fragment
(`base-lighting.mjs:383`), so every region the model calls Dark or below discards global light
by itself — holes, islands and all, with no geometry in the mechanism. That is the whole of
what `customPolygon` and the pooled stand-ins were for.

The **uniform**, not `data.darkness`, and the distinction is load-bearing:
`#refreshDynamicIllumination` tests the *scene's* darkness level against that same band to
decide whether to draw the global source into the visibility mask at all
(`visibility.mjs:637-640`). Narrowing it there would stop global light *revealing* the map
whenever the scene slider sat above the cutoff — a different question, answered wrongly.

*Revealing:* the visibility half is per region, via the second mesh of core's pair.
`IlluminationDarknessLevelRegionShader` meshes go into `visibility.vision.light.global.meshes`
**only for cells the cutoff excludes**, with `modifier = -1` so
`#refreshDynamicIllumination` sees them as outside every possible band and flips them to
`ERASE` (`visibility.mjs:646`). `-1` because `darkness.min` is an `AlphaField` and so never
negative; the upper bound is unusable, its default being 1. Going through core's own test is
what also sets `#needsContainment`, a private field enabling the fence filter that keeps an
`ERASE` blend inside its container — setting `blendMode` by hand would skip it. So a *darkness*
stops global illumination revealing its area to ordinary sight, while darkvision, which comes
from `vision.sight`, is untouched.

**Annulus splitting is gone for `ambient`, and only for `ambient` — corrected 2026-08-23 after
the bands survived the first pass.** Step 3 initially kept `splitAnnuli` and argued the strips
would abut invisibly now that they were meshes. They did not; the bands looked exactly as they
had. That argument was the wrong shape anyway — it proposed making the cuts *meet better*,
where the whole point of the mechanism is that **a mesh does not need cuts at all**.
`PIXI.utils.earcut(vertices, holeIndices, 2)` takes holes natively, so the complement — scene
rect with one hole per darkness, the shape whose full-width cuts caused every seam bug of the
day — is now **one mesh**, and `Cell` grew an `ambient`-only `holes` field to carry it.

`clip`, `reduced` and `dark` keep splitting, because all three still feed a *light or darkness
source*, and a source shape is one closed ring (§6.2.1). Their cuts are local to one emitter's
disc and were measured invisible. The rule is now legible: **cells rendered by a source are
hole-free; cells rendered by a mesh are not.**

**Deleted, as promised:** `customPolygon` and the ring, the ambient stand-in fills, the
above-Dark `dark` fills, `SEAM_OVERLAP` and `splitAnnuli`'s `pad`, the `GLOBAL_FILL` constant
and its `globalLight`/`globalLightThresholds` block in `clip`, and `pool.fill`'s
`global`/`dim`/`bright`/`darkness`/`appearance` parameters. Four bugs lived in that last group,
each one a `GlobalLightSource` property a stand-in had failed to clone.

**Every `dark` cell is painted, not only those above Dark.** The step-2 build fill-painted only
the above-Dark ones, reasoning that Dark needs no fill because the absence of light *is* the
render. True of the illumination, false of everything else: the region still has to cut global
light out of itself, and it still has to read as Dark under god's eye and *true seeing* —
neither of which is achieved by not painting.

**The mapping — chosen, and retunable.** `TIER_TO_DARKNESS` defaults to the evenly spaced
`0 / 0.25 / 0.5 / 0.75 / 1`, which is exactly what the spike measured as distinguishable in all
three viewing modes. The alternative, `1 - tierCeiling(tier)` = `0 / 0.1 / 0.5 / 0.9 / 1`, is
derivable rather than measured, and each has a real cost:

| | Even (default) | Bands (`1 - tierCeiling`) |
| --- | --- | --- |
| Tier separation | uniform | Bright/Normal and Dark/Supernatural sit 0.1 apart |
| Night scenes | **brighter than stock** — darkness 0.85 is Dim in the model, and Dim is 0.5 | each tier renders at the top of its own `B` band, so ambient never lifts past it |

Both are `game.pf1Lighting.render.levels("even" \| "bands" \| null)`, which retunes and rebuilds
live. This is a looking question, not an arguing one; whichever survives a session becomes the
default and the knob goes.

##### Can a light's own zones be moved onto the same ladder? — 2026-08-23

Patrick's constraint, which the table above cannot satisfy on its own: *a light's Normal zone
must be the same brightness as ambient Normal, and its Dim zone the same as ambient Dim.*
Otherwise the ladder is unreadable — the same tier looks like two different things depending on
whether it came from the sky or from a torch.

**The two are on different axes, and that is the whole difficulty.**

| | Formula | Anchored on |
| --- | --- | --- |
| Ambient | `mix(ambientDaylight, ambientDarkness, L)` | daylight ↔ darkness, `L` from our texture |
| Light BRIGHT zone | `mix(bg, ambientBrightest, weights.bright)` | **local background** ↔ brightest |
| Light DIM zone | `mix(bg, brightColor, weights.dim)` | local background ↔ that light's bright |

A light's zones are *relative to the ground it stands on*. Two identical torches, one on unlit
ground and one on Dim ground, paint their dim zones at different absolute brightness. No choice
of `L` fixes that, because there is no single `L` to match against.

**Three levers exist.**

1. `CONFIG.Canvas.lightLevels` — `{dark, halfdark, dim, bright}`, copied to
   `canvas.environment.weights` on every environment initialise and uploaded as the `weights`
   uniform to every light shader (`base-light-source.mjs:206-209`). Global, supported, and
   exactly "where dim and normal fall".
2. `dimLevelCorrection` / `brightLevelCorrection` — per source, already overridden by
   `clip.setLevel`. Chooses *which* computed colour a zone uses, not what that colour is.
3. `computeIllumination = false` plus explicit `colorBackground` / `colorDim` / `colorBright`
   (`base-lighting.mjs:373-378`). **This is the one that makes a light's zones absolute.**

**Finding worth stating flatly: with the stock weights, our Bright and Normal are the same
pixels.** `weights.bright` is `1.0`, so `computedBrightColor = mix(bg, ambientBrightest, 1.0)`
*is* `ambientBrightest` — which is also what `getCorrectedColor(BRIGHTEST)` returns. §6.2.3's
claim that `BRIGHTEST` is a distinct level core never uses is only half true: it is unused, and
under default weights it is also indistinguishable. Separating them requires `weights.bright < 1`
or lever 3.

##### Resolved: derive the weights, do **not** make lights absolute — 2026-08-23

The first answer here proposed `computeIllumination = false` with explicit `colorDim` /
`colorBright`, so every Normal-tier pixel would be the same RGB whatever produced it. **That is
the wrong direction and was recorded as the recommendation for about an hour.** Play testing
killed it: with umbra painting live, a *darkness* between an observer and a torch-lit patch
dimmed the ambient around the torch and left the torch untouched.

The reason is the same line either way:

```glsl
computedBrightColor = mix(computedBackgroundColor, ambientBrightest, weights.bright);
```

At `weights.bright = 1` the background term **cancels**, and a light's bright zone becomes an
absolute colour that nothing can influence — not the scene's darkness, not the tier field, not
an umbra. Making lights absolute *by design* would have made that permanent and called it a
feature. Lights must stay **relative to the background**, because the background is the only
channel through which the model can reach them.

So the fix is not to disconnect them; it is to stop the weight cancelling the connection. Lower
`weights.bright` below 1, and *derive* both weights from the tier table rather than choosing
them — solve for the values that put a light's zones, on unlit ground, exactly on the matching
ambient tiers:

```
bright zone = mix(bgDark, ambientBrightest, wB)  ==  bg(NORMAL)
dim zone    = mix(bgDark, brightZone,       wD)  ==  bg(DIM)
```

Rec. 709 luminance, not a single channel — `ambientDarkness` is blue-tinted by default and a
red-channel solve puts the tiers visibly off. `levels.deriveWeights()`, installed and restored
with the takeover setting because `CONFIG.Canvas.lightLevels` is global and other modules see it.

This also settles the Bright/Normal collapse noted above: with `weights.bright < 1`,
`computedBrightColor` is no longer `ambientBrightest`, so `BRIGHTEST` becomes a distinct level
and the five tiers stop rendering as four.

**It is partial and should be read as one.** A light inside a Dim umbra now *dims*, because its
colour is anchored on a background the umbra darkened — but it does not *clamp* to Dim, because
the shader has no path from the darkness texture to a light's lighting level. Exact clamping
needs the light's geometry clipped per observer, which is the §9.5 cost this design exists to
avoid.

The table settles with Patrick's fixed points: **Dark at 1.0** (no light, and `ambientDarkness`
is what no light looks like), **Supernatural Dark sharing it** and distinguished by the darkness
source's own overlay, Bright at 0 since full daylight is `B = 1` and therefore our Bright tier
(§3.2.1), and Normal and Dim dividing the middle evenly: **0 / ⅓ / ⅔ / 1 / 1**.

Note the consequence either way: **ambient is quantised**. A region at the scene's own tier is
painted at the table's value, not at `1 - canvas.environment.darknessLevel`, so the scene's
darkness slider moves in five steps rather than continuously. That is deliberate — the step
between two tiers is only readable if every region is on the same ladder — and it is the single
most visible change in this step.

#### Where the three defects actually stand — 2026-08-23

Confirmed working: a *darkness* on a lit map is drawn. That is **defect 1 only**. The other two
were unblocked rather than fixed, and it is worth being exact about the difference.

| Defect | Status |
| --- | --- |
| 1. *Darkness* invisible on a lit map | **Fixed.** Verified in play under the texture, 2026-08-23. |
| 2. Umbra shadows without painting | **Built** as step 4, below. Unverified in play. |
| 3. Ordinary darkness cannot animate (§6.2.6) | **Still open**, and permanently. |

#### As built, step 4 — painting the umbra — 2026-08-23

`render/paint.mjs`. The field's `ambient` and `dark` cells no longer go to the texture straight
from the renderer; they go through an observer-scoped pass that clamps them where the selected
creature is looking through a darkness, and *that* result is painted.

**It runs on a different clock, and that is the whole reason it is a separate module.** The
renderer is driven by field staleness and ends by re-initialising every source whose clip
changed — §9.5's dominant cost. Umbra changes whenever an observer *moves*. Chaining one to the
other would pay ~10 ms of source construction per frame of a drag to express something that
costs a triangulation. So sources rebuild when the scene changes, and the texture repaints when
the scene **or the point of view** changes. Nothing in the new pass constructs a source.

**The shadow is cut in, not laid on.** The obvious implementation is extra meshes over the
ambient, and it cannot work: the container sorts by darkness level *descending*, so where meshes
overlap the **lowest level wins** — the brightest (`illumination-effects.mjs:106-110`). An umbra
over the ambient would be erased *by* the ambient. So each base cell is split against the
shadow: the inside piece takes the clamped tier, the outside keeps its own, and the set stays
disjoint.

Two things keep that cheap enough to sit behind `refreshToken`. A cell already at or below the
clamp is skipped whole — the clamp only ever darkens (§4.3) — which on a typical scene leaves
only the ambient cell to cut, so two Clipper ops. And the pass is skipped entirely unless
`field.get()` or some observer's `los` has become a different object, the same identity trick
the umbra cache uses.

**Several observers turned out to be exact rather than approximate.** §5.3's rule is `max` over
observers of the resolved brightness — a point shadowed for one creature and lit for another is
lit — and

```
{ p : max_o clamp_o(p) <= C }  ==  ∩_o { p : clamp_o(p) <= C }
```

so the region clamped to `C` or darker is the *intersection* of the observers' own such regions.
No compromise needed, and an observer with no umbra at all short-circuits the whole pass to "no
clamp anywhere" — which is both correct and the common case the moment anyone has *see in
darkness*. The "intersection-of-shadows approximation" this section carried as an open item was
never necessary; it is the exact answer.

**It composes with `vision/umbra-mask.mjs` — corrected within the hour.** The first version
stood the mask down whenever the texture was active, reasoning that hiding beats dimming so the
two cannot coexist. True of one region and irrelevant here, because **the clamp tier picks the
mechanism**:

| Clamp | Mechanism | Why |
| --- | --- | --- |
| below `SIGHT_TIER` | the **mask** hides | Dark means the observer perceives nothing there; withholding the reveal is the honest render |
| `SIGHT_TIER` and above | the **texture** dims | Dim means they *can* see, so hiding overstates the rule |

Where they do overlap — a Dark clamp — the result is better than either alone: the mask removes
the region from light perception while the texture still writes the tier, so a **darkvision**
observer, whose `vision.sight` is not gated by `light.mask`, gets it revealed *and* rendered
dark.

**What neither does is dim ground lit by a light source.** The texture governs the background,
and a light's mesh composites over it with `MAX_COLOR`; worse, `computedBrightColor` is
`mix(bg, ambientBrightest, weights.bright)` with `weights.bright = 1`, so a light's bright zone
ignores the background *entirely*. Dark-clamped torchlight is fine — the mask removes the light's
contribution outright, since the illumination layer is masked by the vision texture — but
**Dim-clamped torchlight is unexpressed** and needs either per-observer clipping of the light
(the §9.5 cost this design exists to avoid) or the absolute-palette change above.

That also sets expectations for testing: umbra painting acts on ground lit by **global
illumination**, so a scene at darkness 1 has no `ambient` cell for it to cut and correctly shows
nothing. `render.paint()` reports `quiet` saying which of those two it is.

Carried forward unchanged: `canvas.effects.getDarknessLevel` is now **observer-relative**, which
core and other modules may not expect.

**The tier field is painted scene-wide, so it shows through fog — 2026-08-23.** Not a bug in the
painting, but a consequence of it worth stating: the darkness-level texture feeds the primary
sprite's ambience as well as the lighting layer, so a region's tier tints the map image whether
or not the observer can currently see it. On a uniform ambient nothing showed; now every
darkness bubble is faintly legible in explored fog. Core's own Adjust Darkness Level regions
behave the same way, and for a *scene* feature that is fine — but ours are per-observer, so the
leak carries information. Mitigated in the common case by the Supernatural umbra below, which
covers the fog with its own clamp; not solved in general.

#### Supernatural Dark needed a rung after all — 2026-08-23

Reported as: standing inside a *deeper darkness* you can faintly make out every darkness bubble
on the map, ground behind one is *darker but not dark*, and it interferes with other umbrae.

`umbraTiersPresent` excluded Supernatural Dark, on the argument that `VISION_RANK.NORMAL`
already blocks at that rank, so the region beyond is absent from `los` and there is nothing to
clamp. **That confused "not reachable by sight" with "not drawn".** The region still carried the
god's-eye tier, the texture painted it scene-wide, and the fog showed it. Excluding it also
broke the peeling — with no Supernatural rung, ground beyond a supernatural bubble fell through
to whatever the next rank down claimed, which is the interference.

Fixed by ranking it like every other tier, which needs one supporting change: **the base sweep
moves to `VISION_RANK.PIERCING`.** The difference is only meaningful against a reach every rank
can be subtracted from, and at `NORMAL` the base is stopped by the very edges the darkest rung
exists to measure — `los − los` is empty. At `PIERCING` the base is the observer's unobstructed
reach: sight radius and angle, nothing else.

Everything else follows without further work. The clamp is Supernatural Dark, so the texture
paints 1.0 and `erase` removes the global-light reveal; and because the clamp is below
`SIGHT_TIER`, `umbra-mask` picks it up and withholds light perception there — the hard blocking
this case needs, from the division already in place rather than a special case for it.

**And then the 360° case still failed, for a reason worth recording.** From *outside* a
supernatural bubble the umbra was correct; from *inside* it there was none at all, and the map
stayed faintly readable through fog.

```js
// PointVisionSource#_getPolygonConfiguration, point-vision-source.mjs:289
radius: this.data.disabled || this.suppressed ? 0 : (this.blinded.darkness
  ? this.data.externalRadius : canvas.dimensions.maxR),
```

A blinded vision source sweeps at `externalRadius` — the token's own footprint. §4.5.1 blinds a
creature **because** it is standing in supernatural darkness, so `umbraFor` inheriting that
config collapsed the base sweep to a few pixels, and the umbra of the very bubble the observer
was inside came out empty. The 360° case §4.3 insists must not be special-cased was being
deleted by a special case somewhere else.

`umbraFor` now sets `radius` to `maxR` explicitly. Not a widening — it is what the same method
returns for an unblinded source — and it changes nothing about what the creature can *see*,
which is still bounded by `los` and the detection modes.

The general shape of this is worth keeping: **`_getPolygonConfiguration()` already encodes
conclusions about vision, and the umbra is an input to those conclusions.** Reusing it wholesale
keeps angle, threshold and externalRadius from drifting, which is why it is reused — but every
field it derives from a *verdict* (blindness here) has to be overridden, or the model ends up
reasoning from its own output.

#### "A range, not a flag" applies to the umbra exemption too — 2026-08-23

Reported as: *true seeing* with a limited range, and no umbra drawn anywhere.

`subjectToUmbra` exempted any observer with light-independent sight, full stop. That is right
for *see in darkness*, which is unbounded and sweeps above every darkness rank, so the
difference would come out empty anyway. It is wrong for **true seeing**, which §4.5.1 already
established shares the faculty and not the reach — its own heading there is *"it is a range, not
a flag"*. A creature with 60 ft of true seeing was exempt from every umbra on the map, including
ones a thousand feet away.

Two changes, and the second is the one that matters. `subjectToUmbra` now exempts only
`Infinity`; and a **finite** range is cut out of the base sweep as a disc, so the exemption is a
hole in the umbra rather than an absence of one. Doing it on the base makes every rank inherit
it for free, since all of them are derived from that path.

Distance is measured observer-to-*point*, matching `withinDarkSight` in `perception.mjs`, so the
picture and the detection verdict cannot disagree about where the faculty reaches.

This is the third bug in two days from the same root — a sense treated as a boolean when the
model defines it as a range — after blindsight exempting itself from umbra entirely and
`darkSightRange` standing in for `visualDarkSightRange`. **§4.5.1 names four ranges and two
functions; any new consumer needs to say which, and whether `Infinity` is special to it.**

#### Colour in an umbra is the coloration layer, never the map — 2026-08-23

Reported as: a blindsight observer sees colour in the umbra beyond a *supernatural* darkness,
but black and white beyond an ordinary one. Every per-point measurement matched — same reveal
path, same vision mode, same `saturation`, same rasterised darkness level of 1.0 — which is this
project's own signal that the diagnostics were aimed a layer too high.

They were. **A vision mode's desaturation is applied to the primary sprite, uniformly across the
whole canvas** (`primary.mjs:192-205`). It physically cannot be grey in one place and coloured in
another. So regional colour is never the map image: it is the **coloration layer** compositing a
light's tint on top of an already-grey map. Ambient-lit umbra reads correctly grey, because
global light is discarded there by `globalLightThresholds`; torch-lit umbra comes back in colour,
because nothing removes a *placed* light from an umbra.

Worth being explicit about why nothing did. The texture governs the background, and a light's
mesh composites over it. `umbra-mask` removes the region from `light.mask`, and `vision.sight`
bypasses that — deliberately, since the bypass is exactly what lets darkvision see into a shadow
at all. Clipping the lights is the precise fix and costs a source rebuild per observer step,
which is the §9.5 cost this design exists to avoid.

**Left unfixed, deliberately — a known cosmetic limitation as of 2026-08-23.** Masking
`canvas.effects.coloration` with scene-minus-umbra was tried and did not change the picture, and
was **reverted rather than left installed**: an unverified mask on a core layer is worse than a
documented gap.

What the attempt established is worth keeping, because it narrows the next try to one question.

**The light's colour lives only in the coloration layer.** With `computeIllumination = true` —
which `BaseLightSource#_updateCommonUniforms` sets unconditionally for every light source —
`computedDimColor` and `computedBrightColor` are derived from the ambient terms alone
(`base-lighting.mjs:361-372`), so the illumination layer carries brightness and no tint. Masking
coloration *is* therefore the right lever, and the open question is why the mask did not apply,
not whether it was aimed correctly.

Prime suspect: `canvas.effects.coloration` carries a `VisualEffectsMaskingFilter` with
`filterArea` set to the whole screen. A PIXI mask on a filtered container is applied through the
filter stage, and a mask that is also a *child* of that container — core's idiom for
`vision.light.mask`, which has no filter — may not survive it. Parenting the mask elsewhere is
the first thing to try. Two lifecycle notes either way: a mask still needs a place in the display
list for its transform to resolve, and it must be **re-parented on canvas draw**, because the
layer is rebuilt and a mask pointing at the old one silently stops applying.

Scope of the defect, for whoever weighs it: a light *tints* ground the observer can only perceive
by a light-independent sense. No verdict is affected — detection, blinding and the reported tier
are all correct there — and the ground already sits at the clamped darkness level, so it is wrong
in hue rather than in brightness.

#### A split cell's clones never carried their animation — 2026-08-23

§6.2.1 argues the annulus split is invisible, and §6.2.4 says clones carry the emitter's
animation config so a split torch still flickers as one torch. The first is true, the second was
a comment describing code that did not exist: `pool.fill` never took an `animation`, so the
clone pieces of a split cell were always still. An animated light therefore stopped animating at
the cut — which is not a seam, it is two different lights meeting, and the one case where the
split is plainly visible.

Fixed by passing `animation` and `seed` through. The seed matters: without it each clone starts
its own cycle and the cut reads as a beat rather than a line.

**Two follow-ons from the first play test, both reported as "nearly complete".**

*The readout was asking god's eye.* `ui/readout.mjs` called `evaluate()`, which has no observer,
so the chip went on calling a shadowed room bright while the screen correctly showed it dark.
The model was never wrong — `perceivedTier` had the clamp all along, which is why detection
behaved — the readout was asking the wrong one of the model's two questions. `perceivedTier`
needs an observer and `currentObserver` is only set while a detection mode is on the stack, so
*anything* querying outside a visibility pass had the same silent problem. Fixed with
`perception.viewerTier(point)`: `max` over active vision sources per §5.3, and `null` in god's
eye so "no observer" stays distinguishable from "no clamp found".

*The rank ladder stopped at Dim.* Reported as a Normal region casting no shadow onto a Bright
backdrop, and that is exactly what it was: `UMBRA_RANK` had no rung for Normal, on an unstated
assumption that a Normal-lit region is transparent. §4.3 says no such thing — you cannot see
*through* a region more clearly than that region allows — so a *darkness* cast at noon, whose
interior resolves to Normal, must clamp directly sunlit ground beyond it. Ranks are now Normal 1,
Dim 2, Dark 3, Supernatural 4, with `VISION_RANK.NORMAL` at 4 and `PIERCING` at 5. Bright keeps
no rung and needs none: nothing is brighter, so a clamp to Bright can never be a reduction.

**Animation is not coming back this way.** An ordinary darkness now has a painted surface, but
it is a *texture mesh* writing one scalar — even less of a home for a shader animation than the
pooled light fill was. Making it work would mean routing the region through the real darkness
source after all, which §6.2.3 measured as a dead end. §6.2.6 stands.

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
4. **Perception** — §4.8. Detection modes decide from the tier instead of from raw light
   polygons. Splits off the front of what was one "vision" step, because it turned out to
   be independent of the rest: it needs no observer terms and no global-illumination
   rework, and it closes the gap that made the finished renderer still look wrong.
5. **Observer resolution** — §5.2. Which creature the field is computed *for*.
6. **Umbra** — §4.3. Stage A (geometry, cell-derived edges, overlay) and stage B (the
   clamp consumed by `perceivedTier`) are both done as of 2026-08-22.

   **§7.1 turned out not to be a dependency of this step at all**, only of how it *looks*.
   The detection half needs nothing from global illumination — a token beyond a *darkness*
   goes correctly unseen on a lit map today. What cannot be painted without owning global
   illumination is the *picture*: the shadowed room still renders lit. So §7.1 moved from
   "hard dependency of umbra" to "the other half of the same feature", which is the same
   split that made step 4 separable.
7. **Interiors, apertures, spill** — §7.1, §7.2, §3.4 land together; spill's free-clip
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
| **Vision suppression** | ~~Untouched.~~ **Resolved 2026-08-22.** Native darkness no longer blinds a token, collapses its sweep, or fails its detection tests — §4.1.1 paths 4 and 5. Two corrections to earlier notes here: `#highPrioritySources` only re-`initialize()`s sources in priority order and feeds nothing else, so it was never a vision path; and `vision.darkness` is vestigial in v13 — declared, cleared, never drawn into. |
| **Perception** | ~~Nothing converts a light level into perception.~~ **Built 2026-08-22 — §4.8.** Detection modes now decide from the tier: ordinary sight needs Dim, darkvision fails only in Supernatural Dark. Behind its own world setting, and requires native suppression disabled. |
| **Vision, still unimplemented** | Perception is god's-eye. No observer resolution (§5.2), no umbra (§4.3), no low-light vision (§4.4), no darkvision-as-tier-remap (§4.5) — so grayscale rendering and sight *through* magical darkness are both absent, and §2.3's motivating failure case is still live. §8.2 steps 5-6. |
| **`blinded.darkness` stays set** | We report `false` through an accessor rather than stopping Foundry writing it, so the underlying record still says the token is blind. That covers every reader inside and outside the class, which patching consumers did not — but a third-party module that reaches past the accessor, or replaces the `blinded` object wholesale, would disagree with us. Compatibility note rather than a bug; `probe.vision()` reports both values. |
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

## 10. Configuration surfaces

Planned 2026-08-23, after umbra painting cleared. Everything in §3 through §7 is driven by
fields with no way to set them; this section is the plan for the controls. It supersedes the
§3.5 note, which stated the problem and is now the summary of one part of the answer.

### 10.1 What actually needs a control

Four kinds of input, and they belong in four different places. Sorting them by *what owns the
value* rather than by what they affect is what keeps this from becoming one giant settings
page.

| Input | Owner | Surface |
| --- | --- | --- |
| `kind`, `level`, `transform`, `floor`, `blocksPath`, `eligibility`, `cancelsDarkness`, `brightRadius` | one light document | **§10.3** — a tab on the light config sheet, a fieldset on the token's Light tab |
| The tier → darkness-level table | one scene | **§10.5** — a fieldset on the scene config's Lighting tab, over a world default |
| Feature switches, thresholds, debug toggles | the world / the client | **§10.6** — a settings menu, replacing eleven flat checkboxes |
| Indoor keepouts, architecture | a region | **not now** — §3.5's fourth row, blocked behind §7.1 |

### 10.2 The preset table is the actual feature

The field list is not the deliverable. A GM placing a *deeper darkness* should pick "Deeper
Darkness", not set `level: 3`, `transform: {op: "reduce", steps: 2}`, `floor: -2` and
`blocksPath: true` correctly and in agreement with each other. Five fields that must be
mutually consistent to mean anything is exactly the shape that produced the bug in §3.5's
note.

So `model/presets.mjs` — **model, not UI**, because it is PF1's vocabulary rather than a
widget's convenience, and because `field.explain` and `probe` should eventually be able to
report "this is a *Darkness*" instead of reciting four flags.

| Preset | `kind` | `level` | Other |
| --- | --- | --- | --- |
| *Light* / *continual flame* | magical | 0 | — |
| Magical light, by level | magical | 1–9 | — |
| Torch, lantern, fire | mundane | 0 | — |
| *Darkness* | magical | 2 | `reduce 1`, floor Dark, casts umbra |
| *Deeper darkness* | magical | 3 | `reduce 2`, floor Supernatural Dark, casts umbra |
| *Daylight* | magical | 3 | `cancelsDarkness` |
| Unlit area | mundane | 0 | `clamp` to Dark, **no** umbra |

`DEFAULT_SUPPRESSOR` is *Darkness* and `DEFAULT_EMITTER` is a mundane light, so the two most
common cases are already what an unconfigured document does. That is a property worth
keeping: the presets name the existing defaults rather than replacing them.

**The preset is not stored.** It is derived on render by matching the current config against
the table, falling back to "Custom". Storing it creates a second source of truth that goes
stale the moment someone nudges one field, and there is no useful behaviour that reads it.

### 10.3 The light config sheet

`AmbientLightConfig` is `HandlebarsApplicationMixin(DocumentSheetV2)` with parts
`tabs / basic / animation / advanced / footer` and a `sheet` tab group.

**A tab, injected — not a registered `PARTS` entry.** Adding a real part means mutating
`AmbientLightConfig.PARTS` (and rebuilding the object so ours lands before `footer`), pushing
into `TABS.sheet.tabs`, and wrapping `_prepareContext` to supply the part's data, because
`_preparePartContext` offers no hook. Injecting from `renderAmbientLightConfig` needs none of
that and buys the same result, because V2 tab switching is entirely DOM-driven: `changeTab`
queries `.tabs [data-group][data-tab]` and `.tab[data-group]` live
(`api/application.mjs:1113-1125`), and `data-action="tab"` is a core delegated action. An
`<a data-action="tab" data-group="sheet" data-tab="pf1-lighting">` in the nav and a matching
`<section class="tab">` in the content are a fully working tab with no core statics touched.

Two consequences to handle:

- `_prepareTabs` builds from the static `TABS`, so on any re-render our tab is absent from the
  computed set and **no** section gets `active` if ours was the open one. The injector reads
  `app.tabGroups.sheet` after inserting and restores the active state itself.
- `_onChangeForm` re-renders `["animation", "advanced"]` when `config.negative` changes
  (`ambient-light-config.mjs:169`). Our field set differs entirely between a light and a
  darkness, so the injector must rebuild on every render, including partial ones — which it
  does, since `renderAmbientLightConfig` fires after `_onRender` on every render.

**Token light gets a fieldset, not a tab.** `TokenApplication` (the mixin behind both
`TokenConfig` and `PrototypeTokenConfig`) already has five tabs, and its Light tab is a single
scrollable column of three fieldsets. A fourth fieldset is the consistent shape, and one
`renderTokenApplication` listener covers both sheets — `#callHooks` walks the inheritance
chain, so the mixin's own class name fires for both (`api/application.mjs:1226-1232`).

Same context builder, same template, two mount points and two field-name prefixes
(`flags.pf1-lighting.…` against the light document, versus the same path on the token
document — the registry reads `source.object.document.getFlag`, which resolves to
`TokenDocument` for a token light, so no model change is needed).

**Field names go straight into `FormDataExtended`.** `flags.pf1-lighting.config.level`
expands to the right nested object, `_previewChanges` hands it to `preview.updateSource`, and
submit puts it through `document.update`. Flags are a free-form `ObjectField`, so nothing
validates against us.

**`brightRadius` is retired, not relocated.** It was read as a *top-level* flag while
everything else lived under `.config`, and §3.2.1's rewrite removes the concept it named: a
Bright light is now `emission.tier = Bright` against its ordinary inner radius. Nothing needs
migrating — a light with the old flag simply stops having a third zone, which is the correct
new reading of it.

**Do not mirror `level` into native `priority`.** §3.5 floated it. The two fields mean
different things (§4.1.1), `priority` still has its own job in darkness-vs-darkness ordering,
and silently overwriting a value the user set on the Basic tab is worse than the confusion it
would fix. The confusion is a *labelling* problem, so fix it with a label: a hint under our
Level field saying Foundry's Priority is separate and orders darkness against darkness only.

**No live preview of our fields, deliberately.** `registry.usable()` excludes previews
(`model/registry.mjs:190`) because a drag creates a second live source and counting both made
the model resolve a scene that did not exist. The config sheet's preview is the same kind of
clone. So our fields apply on submit, and the injector calls `registry.invalidate()` plus a
forced `renderer.rebuild` on close rather than trusting `refreshAmbientLight` to fire for a
flag-only change. `affectsRegistry` already tests `flags.pf1-lighting`
(`model/registry.mjs:346`), so the update hooks are correct as they stand.

### 10.4 What the sheet shows, and when

Driven by `config.negative`, because that is what decides whether the document becomes a
`PointLightSource` or a `PointDarknessSource`, which is what decides whether the model reads
it against `DEFAULT_EMITTER` or `DEFAULT_SUPPRESSOR`.

**Light:** preset · kind · level · **set light level** · **steps** · **clamp** · counts as
*daylight*.

The last three are §3.2.1's emission fields, and they sit beside Foundry's own two radius
inputs rather than replacing them: *this light provides `<set level>` out to `bright`, and
raises the level `<steps>` from there to `dim`, never above `<clamp>`.* Clamp defaults to the
set level and steps to 1, so the ordinary case is one dropdown and two fields nobody touches.
This is what the old `brightRadius` flag becomes — an enum instead of a third radius, and no
longer at an inconsistent top-level flag path.

**Darkness:** preset · kind · level · effect (`reduce n` / `clamp to tier`) · floor · casts an
umbra · what it blocks (`eligibility`).

`kind: mundane` on a darkness is meaningful and needs to read as such — `castsUmbra` keys off
`level >= 1`, not off `kind` (`model/contest.mjs:104-106`), so a level-0 darkness is an unlit
cellar: dark, but you can see out of it. The "Unlit area" preset is how that gets named.

### 10.5 The scene, and the tier table

`render/levels.mjs` holds the tier → darkness-level table as a module variable, settable only
from the console via `render.levels(preset)` and persisted nowhere. It is also the one number
§7.0 says can only be settled by looking at a map — and different maps want different answers,
which is precisely why `matched`, `even` and `bands` all exist.

So: **a world setting for the default preset, and a per-scene override.** Mechanically free —
`ambient.registerHooks` already re-solves the light weights at every `canvasReady`, so reading
the scene's flag there instead of a module variable is a substitution, not a new pathway.

`SceneConfig` is `PARTS.lighting → templates/scene/config/lighting.hbs`, `data-tab="lighting"`;
a fieldset appended there via `renderSceneConfig`, same injection technique as §10.3 minus the
tab. Controls: preset select with a "use world default" blank, plus five number inputs revealed
for "Custom".

### 10.6 Settings

Eleven settings, all `config: true`, all flat, all hardcoded English, and four of them master
switches defaulting to `false` — so a fresh install does nothing until the right four boxes are
found and ticked, in a list that gives no indication that `renderEnabled` gates
`modelGlobalIllumination` which together gate the umbra painting (`render/paint.mjs:active`).

Replace the flat list with one `registerMenu` application and flip the existing settings to
`config: false`. The keys and their `registerSettings` functions **stay where they are** — each
in the module that owns it — because that is what keeps the settings from becoming a second
dependency graph. The menu reads and writes them by key; it does not own them.

Grouping, which is the whole point:

- **Model** — disable native suppression, model global illumination
- **Render** — render the model, tier brightness table, darkness respects grey vision
- **Vision** — perceive by light level, darkness shadows what lies beyond it,
  see-in-darkness brightness, low-light guard
- **Client** — readout, readout detail, GM sees through selected token
- **Debug** — cell overlay

Dependent controls are disabled with the reason shown, rather than hidden — "requires *Render
the lighting model*" is information; a control that vanishes is a bug report.

`lang/en.json` lands with this, and the existing eleven `name`/`hint` strings move into it at
the same time. Not because the module needs translating, but because the menu template would
otherwise be the only place in the module where user-facing text is not in the source it
describes, and splitting the difference is worse than either end.

### 10.7 Build order

1. `model/presets.mjs` — the table and `presetOf(config)`.
2. `ui/light-config.mjs` — the AmbientLight tab. Biggest single win; unblocks authoring.
3. The token Light fieldset — same builder, same template, one more mount point.
4. Scene tier table: persist it, read it per scene, inject the fieldset.
5. `ui/settings.mjs` — the menu, and `lang/en.json` with it.

New files: `scripts/model/presets.mjs`, `scripts/ui/light-config.mjs`,
`scripts/ui/scene-config.mjs`, `scripts/ui/settings.mjs`, `templates/*.hbs`, `lang/en.json`,
`styles/config.css`. `module.json` gains `languages` and the extra stylesheet — a **full
Foundry reload**, not an F5, for step 1 and step 5.

Templates go through `foundry.applications.handlebars.renderTemplate`; the global
`renderTemplate` still resolves in v13 but is deprecated.

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

---

## Appendix C — Built but unverified in play

Things asserted correct from reading and construction, but **not yet confirmed on a live
scene**. This list exists because on this project the two have diverged repeatedly — §4.1.1's
five suppression paths were each read, each plausible, and each wrong about the cause until
observed behaviour settled it.

Clear an entry only after seeing it work, and delete it rather than annotating it.

### Awaiting the next play session

**§3.2.1's rewrite — cleared 2026-08-23.** All ten items verified in play: the control case
(one torch unchanged), two and three torches overlapping, a torch on Normal-lit and on Bright
ground, two torches inside a *darkness*, an overlap seen through one, `stacks` at zero on a
scene with no overlapping bands, the darkness slider stepping between tiers, and an existing
`brightRadius` flag losing its third zone. The two-zone additive model is live.

**Soft transitions — settled 2026-08-24**, over six rounds, recorded in §6.4.1 through §6.4.4.
What stayed: the light edge feather, including clipped cuts (§6.4.3). What was built and then
**retired** by choice: the ground feather (§6.4.2) — too expensive for what it bought, and a
magical darkness reading as a hard-edged circle is fine. What never works: a filter on the
darkness-level container (§6.4.2).

**Untested, both landed 2026-08-24.** *Band overlaps are modelled but no longer drawn* — the
setting defaults off, and the check is that `probe.at()` still reports the summed tier in an
overlap while the screen shows plain `MAX_COLOR`. *An animated ordinary darkness draws for its animation
alone* (§6.2.6 revisited), **accepted in play 2026-08-24** at the light level the readout
reports. Two residuals accepted with it: the animation is clipped to the cell, so its pattern
stops at the region's edge rather than fading — `edgeSoftness` is the only lever — and the
darkvision grey-out on such a source was fixed by forcing `saturation` to 0, which is untested.

**Still open, and accepted as livable (Patrick, 2026-08-23):** *overlapping lights are looking a
bit odd*. Not diagnosed. The `stack` clones are confirmed feathering — `meshedOffset: -30`,
`renderSoftEdges: true` — so it is not the edge treatment. The likely candidates, in order:
`MAX_COLOR` compositing between a clone and the real light it stands in for, where both are
drawn and the brighter wins per pixel rather than the two blending; the clone's `attenuation`
matching but its `ratio` differing because `bright/radius` is computed from the clone's own
data; and the one-rung step at the overlap boundary simply being large. Worth a look when the
rendering is otherwise settled, not before.

**Verified and cleared 2026-08-23:** §7.0 under the darkness-level texture — a *darkness* darkens
a lit map, the ambient complement's full-width bands are gone with the annulus splitting, and
`bright`-past-`dim` lights reach the model again (§3.2.1). Still to pick: `even` against `bands`
for the tier → darkness-level table.

**Verified and cleared 2026-08-22:** see-in-darkness brightness dial; vision-sharing narrowing
(confirmed on a second client); true seeing, including its range bound; darkness desaturation,
consistent for darkvision and for blindsight in supernatural darkness; **umbra per-tier
regions**, two suppressors at Dim and Dark drawn disjoint and simultaneously.
`sightPiercingPriority`
was removed when the tier ladder landed — vision rank is now fixed at 3/4 and deliberately does
**not** track a darkness source's authored priority, so the entry was testing something that no
longer exists.

**Fixed by that pass:** the GM observer toggle did nothing.
`canvas.perception.update({initializeVision: true})` re-initialises existing vision sources but
never re-decides *membership* (`groups/visibility.mjs:173-177`), so a setting `_isVisionSource()`
reads was never asked again. `refreshVision()` now rebuilds membership first, using core's own
idiom from `placeables/token.mjs:4160`.

**Umbra cache verified 2026-08-22.** `game.pf1Lighting.umbra.cache()`, two observers on the
test scene: cold rebuild 0.6–0.7 ms, warm **0.004 ms**, speedup ~175, `hitting: true`. The
identity keys (`field.get()`, `source.los`) hold.

A warm lookup is not free, and 4 µs is worth remembering rather than rounding to zero: it is
almost entirely `field.get()` rebuilding its signature array plus a `game.settings.get`, not
the geometry. `perceivedTier` memoises per point, so a vision refresh costs one lookup per
*distinct* test point — order 200 on a busy scene, so ~0.8 ms. Affordable, and the obvious
lever if it ever isn't is hoisting those two reads to once per frame rather than caching
harder.

That measurement also caught a readout bug worth keeping: **`stats().rebuildMs` cannot measure
the cache**, because `all()` goes through `umbraFor` directly — deliberately, since the overlay
has to keep drawing with `umbraPerception` switched off, when `regionsFor` correctly returns
nothing. So it is cold on every call, and Appendix C briefly instructed reading it as if it
were not. `cacheProbe` exercises `regionsFor` instead, and self-scales its iteration count in
both directions: a hit is faster than `performance.now()` resolves, and a miss is a sweep that
a fixed high count would turn into a one-second freeze.

**Measured:** 242 sight edges across 6 rings on a populated test scene. Comfortable — ordinary
scenes carry hundreds of wall edges — but it scales with cell complexity rather than with
suppressor count, so it is the number to re-check if a scene ever has many overlapping
suppressors.

**Stage B cleared 2026-08-22**, all in one pass: the clamp hides a target behind a *darkness*
(`tier: Dark`, `litEnough: false`, `visible: false`, with `losPiercing: true` proving it was
the clamp and not a wall); darkvision still sees through an ordinary darkness, so the rank
separation holds and `los` truncation is not double-firing; the GM observer toggle works after
the membership fix.

One instrumentation gap found in the same pass and fixed: `probe.perception()` builds its
report by naming fields, so extending `explainPoint` did not reach it. `rawTier`, `umbraClamp`
and `umbraApplied` are surfaced now. **Extending a model function does not extend a readout
that destructures it** — worth checking whenever a new field is added for diagnosis.

**Cleared 2026-08-23, second pass.** Umbra painting dims instead of hiding; a **Dim-clamped
umbra** renders — the case a binary mask structurally could not express; supernatural darkness
hard-blocks, including the 360° observer-inside case; walls no longer cut wall-shaped notches out
of a shadow; blindsight is subject to umbra; the readout reports the clamped tier
("seen through darkness"); the ambient complement's full-width bands are gone; and lights with
`bright` past `dim` reach the model again.

Add to this list whenever something is built without being seen.

| What | How to check | Why it might not hold |
| --- | --- | --- |
| **Derived light weights** (§7.0) | Compare a torch's bright core against open ground at the same tier — they should read as the *same brightness*. And put a Bright-tier area next to a Normal one: they must now differ, where before they were identical pixels. | This is the largest global change of the session and the least looked at. `CONFIG.Canvas.lightLevels` is solved from the tier table and installed for every light on the canvas; if lights read washed out or muddy, `render.ambient().lightLevels` shows the solved numbers. |
| **The default table** `0 / ⅓ / ⅔ / 1 / 1` | Drag the scene darkness slider through its range. Ambient should move in **four** visible steps, Dark and Supernatural Dark sharing the darkest. | Changed after the even five-step table; Patrick's fixed points, but never seen. `render.levels("even")` restores the previous spacing for comparison. |
| **True seeing with a limited range** | A token with bounded *true seeing* near a darkness. Inside its range: no umbra. Beyond: umbra as normal, with a clean circular boundary. | Fixed last, unretested. The exemption is a disc cut out of the base sweep, so a wrong radius shows as the circle being the wrong size rather than as no umbra at all. |
| **A split cell's animation** | An animated light whose cell an annulus split — *Roiling Darkness* on a light with a darkness fully inside it. All pieces should flicker together. | `animation` and `seed` are now passed to clones; previously they were silently dropped. In phase is the part to watch — a beat rather than a line means the seed is not carrying. |
| **Two observers with umbra painting** (§5.3) | Two vision-shared tokens on opposite sides of a darkness. A point shadowed for one and lit for the other must render **lit**. | The multi-observer intersection was rewritten as an exact identity rather than the approximation §5.3 assumed. Verified with two observers before umbra was *painted*; the painting path has only ever run with one. |
| **Cost during a drag** (§9.5) | Drag a token across a scene with a darkness on it. Motion should stay smooth. | The pass is deliberately outside `renderer.rebuild()` so movement never re-initialises a source, but it now runs two sweeps per observer rather than one. `render.paint().ops` says how many Clipper calls a frame is paying; `split` says how many cells the clamp guard did not skip. |

