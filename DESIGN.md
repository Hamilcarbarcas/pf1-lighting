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

#### 3.2.2 The band cap is not floored at the emitter's tier — FIXED 2026-08-28

Patrick, 2026-08-28: *"it does not appear to be enforced — max seems to be automatically set to the
brightness level of the inner radius (it should default to that, but max should be able to override
it)."*

`normaliseEmission` read `cap: Math.max(tier, emission?.cap ?? tier)`, so a *Max* set below the
light's own level was silently raised back to it and the control looked ignored — because it was.

The reasoning behind the floor was *a cap below the set tier is meaningless, since a band can only
raise*. The premise is right and the conclusion does not follow: **the cap bounds the band, and the
band raises whatever is already there — the ambient, not this emitter's inner tier.** A bright lamp
with a normal-capped halo is an ordinary thing to author, and the floor made it unauthorable.

Nothing downstream needed it. `contest.stack`, `field.overlapCells` and `light-ramps.zonesFor` all
resolve a band as `max(base, min(step(base, n), cap))` — §3.2.1's rule, which by construction already
refuses to let a low cap *lower* anything. The floor was defending against a case the rule had
covered.

##### The fallback divergence it exposed

Removing it surfaced a second fault. Where `cap` was absent the four consumers disagreed:

| site | fallback |
| --- | --- |
| `contest.mjs` — the **model** | `TIER.NORMAL` |
| `light-ramps.mjs` ×2, `renderer.mjs` — the **picture** | `emission.tier` |

For a Bright lamp that is the overlay reading Normal while the screen reads Bright: two answers to
one question, each individually defensible, and the hardest kind to chase. `normaliseEmission` sets
`cap` for anything built from a real light, so it is a guard on synthetic entries rather than a live
path — aligned anyway to `cap ?? tier ?? NORMAL`, with `ramp.contributionAt` now carrying `tier` on a
band contribution for the purpose. A divergence that only fires on an unusual input is one that
surfaces on an unusual day.

##### The control surface

*Maximum* became *Max* and selects were given a real flex basis (§10.10). A `<select>` in a flex row
shrinks below its own content unless told not to, so the three-control *Increase brightness* row
collapsed the dropdown to an unreadable sliver while the two-control *Brightness* row above it was
fine. *Steps* is sized to its content too — one digit, 0–4, and it had been claiming the same width
as a radius in feet.


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

#### 3.3.1 A light *inside* a darkness is out everywhere — 2026-08-25

Everything above is pointwise, and one rule is not. **If an emitter's own origin lies inside a
suppressor entitled to block it, that emitter contributes nothing anywhere** — not merely
nothing inside the bubble.

Reported by Patrick as a torch carried into a *darkness* that went on lighting the corridor
thirty feet away, because its radius reached past the bubble and every point out there resolved
without a suppressor over it. Pointwise resolution has no way to see the difference: the light
is genuinely present at those points, and the fact that matters is where the *source* is
standing. A torch inside a *darkness* has gone out; it does not shine out of the far side.

`contest.extinguishes(suppressor, emitter)` is `eligibility && !breaks` — the suppressor is
entitled to block it, and the emitter does not counter or annihilate the suppressor first. So a
*daylight*, and any magical light out-levelling the darkness, is unaffected, which is the
exemption Patrick named.

`registry.markOriginSuppression` applies it once per rebuild and marks the entry;
`registry.activeEmitters()` is the list resolution reads, and `emitters()` still returns
everything. Both are needed and for opposite reasons: the renderer has to *reach* an emitter it
has stopped drawing in order to withhold its mesh, and the readouts should be able to say why a
torch is dark rather than simply omitting it.

**Two consumers had to be moved together**, which is the hazard this design keeps
re-encountering: `field()` and `emittersAt()` answer the same question at different
granularities, and letting each derive "which emitters count" separately is exactly the shape
of the 2026-08-22 `tierOf`/`resolveTier` divergence. One list, computed once.

**One second-order case is knowingly wrong.** The test is geometry and eligibility only — the
contest is not re-run — so a *daylight* that annihilates the darkness at the torch's own
position would leave the torch lit, and this still puts it out. Resolving it properly means
running the regional contest to decide which emitters exist, which is that contest's input.
Cheap to revisit if a scene ever produces it.

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

### 3.4 Light spill through apertures — superseded by §3.4.1, 2026-08-28

> **The geometry below is retired.** Read this for the eligibility test, the tier and the
> `AT_LEAST` framing, which are unchanged and still describe the built feature. Everything from
> *The geometry* to *Cost* describes a construction that measured brightness by Euclidean
> distance and masked it by visibility — see §3.4.1 for why that was the wrong quantity, and what
> replaced it. Kept because the two play-testing failures it records are the ones that pointed at
> the real defect.

*Poor-man's diffuse lighting.* A window or an open door in an interior region should let the
outdoor light in, falling off with distance rather than stopping dead at the wall.

**The original framing is retired.** This section used to describe a `SpillEmitter`: a derived
*emitter*, dilated from any wall-cut shadow edge, clipped to an aperture sweep that §7.1 would
compute. Three things about it did not survive contact with the built model.

- **It is not an emitter.** `EmitterEntry` is welded to a Foundry source — `contributionAt` is
  `Math.hypot` from `source.x`, `contains` is `source.shape.contains`, and `usable()` excludes
  synthetic sources outright (§6.6). Spill is a flat-tier polygon with no origin. The one
  originless emitter we have is global illumination, and it is a hard-coded special case in
  three methods; a second would make that a pattern by accident.
- **It is an *ambient area*** — §10.7's mechanism with a computed polygon instead of a drawn
  one. Not a convenience: everything downstream already reads the ambient through
  `ambientTierAt`, so the contest, `evaluate()`, suppressors, umbra, perception, detection and
  the readout see spill with no new plumbing, and §7.0's shader lights it **as global
  illumination**, through the same texture and the same threshold test. Patrick's requirement
  was that spill be treated identically to global light by every other facet of the module;
  this makes it the same mechanism rather than a matching one.
- **§7.1 is not a dependency.** Aperture emitters were the plan's answer to occlusion. The
  answer is one sweep.

#### The geometry

Patrick's diagram, 2026-08-26: an L-shaped interior, one window in the top wall, a bright cone
spreading inward and cut off by walls, then constant-width bands beside and beyond it, each one
tier lower, ending at dim. Two things in that picture settle the construction, and both were
read wrong first.

**The cone's angle is emission, not occlusion.** The band beside the cone is not in shadow — a
point there can see the window perfectly well, it is merely outside an *artistic* angular limit.
So the visibility clip must not use the cone's angle. Clipping the bands to `sweep(origin,
angle)`, which is what this section proposed for years, would delete every band and leave the
cone alone.

**The bands are constant width, not proportional** — measured off the drawing at ~85–90 px on
the near flank and at the far end alike. That is a Minkowski dilation, not a wider cone.

```
wedge  = Minkowski(segment[a,b], cone(angle, R[spillTier]))   — analytic, full window width
vis    = ⋃_i sweep(o_i, R_max, 360°)                          — o_i sampled along the aperture
bend   = vis ∪ ⋃_{c ∈ C} sweep(c, R_max, 360°)                — C = wall corners visible from it
white  = wedge ∩ vis  ∩ region
band_k = ((white ⊕ k·d) ∩ bend ∩ region) \ band_{k-1}
```

`vis` at 360° costs nothing extra — the walls do the work, and `∩ region` stops the sweep
escaping back out through its own window. The dilation is the **only** distance bound on a band;
every clip above it is visibility, which is what lets both sweep sets be taken once at `R_max`
and reused across every tier and every band.

> **Both halves of this were wrong in the first build, and play-testing found them in one pass —
> 2026-08-26.** Kept because each mistake is the obvious one.
>
> **The wedge was a point, not a window.** `white` was a single `angle`-limited sweep from one
> origin, unioned with a thin quad across the opening. A `ClockwiseSweepPolygon` emanates from a
> *point*, so the lit wedge left the wall at zero width and widened from nothing — reported as
> *"it comes almost to a point, when it should have a starting width of the entire length of the
> window"*. Sampling more origins does not fix it: adjacent cones only close their scallops some
> way in, and the window's own width is still never expressed. The shape wanted is the Minkowski
> sum of the aperture segment with the cone, and since a circular sector and a segment are both
> convex, that sum is just their convex hull — `a`, a's outer flank, an arc about `a` round to
> the normal, the straight tangent across to `b`, an arc about `b` out to b's flank, `b`. So the
> wedge is built analytically and the sweeps do occlusion only.
>
> **The bands could not reach a shadow.** `vis` was swept **from the same origin as the cone**,
> so every wall-cut edge of the wedge was also an edge of the clip, and `(white ⊕ k·d) ∩ vis`
> could never cross one. A band could therefore only appear past the wedge's *angular* or
> *radial* limit, and in the direction of a wall-cut edge there was nothing at all — reported as
> *"the dimmer bands aren't offsetting from all sides of the initial cone, it's not counting the
> sides that exist because they were trimmed by walls"*.
>
> Light gets into that shadow by bending round the corner that cast it, so the clip has to admit
> what those corners can see. `bend` is that, and the corner test is *visible from the aperture* —
> a corner no light reaches has nothing to bend. This is the "one sweep per silhouette vertex"
> this section deferred two paragraphs below, arriving as a requirement rather than as an option;
> what it cost was one union per window, not one per band, because the dilation was already
> carrying the distance bound.
>
> **Two follow-ups, both about which corners get admitted — 2026-08-27.**
>
> *Ranking by distance from the window is not relevance.* The corners nearest an aperture are its
> own jambs and the near wall, which cast nothing into the room; the corner that gates a far leg
> is far away by definition. With the cap at 8 the queue filled with the former and culled the
> latter. The honest test is proximity to the **lit wedge** — a band cannot reach a corner it is
> not near, because the dilation says so — taken against the wedge at `R_max` so it stays
> tier-independent and cacheable. Distance from the window survives only as a tiebreak.
>
> *Test the nudged point, never the corner.* A corner that casts a shadow **is a vertex of
> `vis`**, because the sweep turns at exactly that point, and ray-crossing containment at a
> polygon's own vertex answers by floating-point accident. Whether the corner gating a room was
> admitted therefore depended on where the wall happened to sit, and moving a free-standing wall
> one square re-rolled it — reported as spill *"behaving somewhat erratically… edges that just
> aren't getting looked at"*, which was the opposite of what was happening: they were looked at
> and given an arbitrary answer.
>
> Nudging toward the light first makes it exact rather than merely likelier, and the reason is
> structural: each sample's sweep is **star-shaped about its own origin**, so the segment from an
> origin to any point of that sweep lies inside it, and a boundary corner moves strictly *into*
> `vis` for any offset. An occluded corner stays out, because a few pixels do not cross a wall.
> The nudged point is also the sweep origin, so there is one point per corner and no way for the
> tested point and the swept point to disagree.

Every sweep is `type: "light"`, and `_testEdgeInclusion` drops any edge whose `light` is `NONE`
before it can occlude (`geometry/clockwise-sweep.mjs:244`). So a second window, or another open
door, lets the spill straight through — and it must, because that is the *same* predicate that
finds a window in the first place. The two cannot disagree. Nothing else in the construction
consults a wall: the dilation is a Minkowski sum and the region clip is a polygon.

**The wedge is anchored across the window, and that is a correctness requirement.** Its near edge
is pushed ε *outside* the wall so the region clip lands on the wall rather than a rounding error
short of it. That makes the wall carrying the window cut every ring, so each band is a C or a U
opening onto it rather than an annulus — Patrick predicted exactly that from the shape of the
problem (2026-08-26), and it is why `splitAnnuli` is the exception here and not the rule. The
first build got the same property from a separate aperture quad; the analytic wedge supersedes
it, since it already reaches the wall at full width.

#### What still does not bend

Bands bend around **one** corner. A point reachable only by turning twice gets nothing, and that
shadow edge is hard — a real occlusion boundary, which §6.2 wants sharp anyway.

Two things bound how much that costs. `MAX_CORNERS` caps the sweeps per aperture at the eight
nearest, so a wall-dense room degrades by losing its least relevant bends rather than by getting
slow. And the dilation caps reach at `N·d` regardless, so a second bend has at most one band's
width left to travel by the time it would matter.

If it ever needs more, the next step is the same shape again — sweep from the corners of `bend`
rather than of `white` — and it needs no rework, only a second pass.

#### The tier

`spillTier` is the **ambient emitter's** resolved tier just outside the window:

```js
const ambientOnly = emittersAt(out).filter((e) => e.entry.isGlobal);
const { B, applied, winner } = contest(ambientOnly, suppressorsAt(out));
const spillTier = resolveTier(B, { suppressed: applied, floor: winner?.floor });
```

**Not `evaluate()`, and the difference is the whole point.** A candle on the windowsill already
shines through the window — the edge passes light, Foundry sweeps it, and §7.1 says so in its
own parenthesis. Reading the full emitter set would spill forty feet of *bright* from a candle
and double-count light that is already being drawn. Global illumination is the only thing with
no geometry to stream through the gap, so it is the only thing spill exists for.

Running the *contest* rather than reading `ambientTierAt` is what makes a darkness over the
window work: the spell clamps the ambient at that point and the spill starts one or two rungs
lower, with `floor`, eligibility and *daylight* cancellation honoured by the code that already
owns those rules. It also removes any question of spill feeding spill — the ambient emitter is
the only input, so the recursion cannot arise.

Bands step down one rung per `d` and stop at Dim, and not by choice: `globalLightCutoff` is
`darknessTable()[TIER.DIM]` and `darknessFor` returns `erase: level > cutoff`, so Dim is the
last rung at which global illumination still lights and still reveals. Below it there is nothing
to spill.

**No spill when `spillTier <= interiorTier`.** The same comparison as eligibility, so it is one
test rather than two: a Bright scene clamped to Dim indoors, with a *deeper darkness* over the
window, gives Dim against Dim and no window qualifies. Nothing is computed, which is also the
correct answer.

#### Reach

Per-tier caps on the cone radius, every number configurable (§10.10): 40 / 20 / 10 ft for
Bright / Normal / Dim, band width 10 ft, angle 105°.

The cap keys off `spillTier` alone, **never off each band's own tier** — otherwise a Normal
spill's Dim band would be capped at 10 ft with 20 already spent. So Bright reaches 40 + 10 + 10
and Dim reaches 10.

These caps are the only statement in the model that diffuse light through an aperture falls off
with distance. Nothing else expresses it, which is why they survive even though §3.4's original
reason for a distance limit — reining in a disproportionate spill from a small light — is
answered better by taking the ambient alone.

#### Eligibility

A wall is a window if its **edge** passes light and the ambient differs across it.

- `edge.type === "wall"`. Non-negotiable: `Edge.light` defaults to `NONE` for *every* edge type
  (`geometry/edges/edge.mjs:41`), and this module puts its own umbra edges into `canvas.edges`
  with exactly that (`vision/umbra-edges.mjs`). Without the type test, every umbra boundary on
  the scene is a window.
- `edge.light === CONST.WALL_SENSE_TYPES.NONE`.
- **Open doors need no special case.** `Wall##createEdge` zeroes all four restrictions when
  `isOpen` (`placeables/wall.mjs:225`), so a door's edge stays in the collection with its
  geometry intact and reads as a window exactly while it is open — and stops when it shuts.
- `spillTier > ambientTierAt(inward sample)`. **Not a border test.** Collinearity between a
  drawn region outline and a drawn wall is a tolerance exercise with no right answer. The
  differential is the actual semantics; it reuses the fold that already handles overlapping
  regions, modes and holes; it hands back the magnitude the bands need; and it switches the
  whole feature off at nightfall with no special case, because once the sky is darker than the
  room no window qualifies.

#### Invalidation — two clocks

**Geometry** depends on walls and regions only. **Tier** additionally depends on the ambient and
on suppressors, because the contest is in the loop — a darkness carried past a window moves it.
So the expensive half rebuilds on wall and region change, and the cheap half, one contest per
window, re-runs on registry version.

Baking the tier into cached geometry would leave spill stale through a darkness *animation*,
which fires no document update at all. That is the same trap `ambientTier` is read live to
avoid.

**No suppression during wall editing, by decision** (Patrick, 2026-08-26: *"let's disable the
rebuild suppress when editing walls — I want to see what kind of latency this actually
creates"*). It is the worst case by construction: every wall change bumps the geometry epoch,
which drops the sweep cache, so each edit re-sweeps every window on the scene.
`spill.stats().sweeps` is the number that decides whether a brake is needed, and the hook to
apply one is written and idle (`deactivateWallsLayer`).

#### Cost

Per window: up to `MAX_ORIGINS + MAX_CORNERS` = 14 sweeps at ~0.25 ms (§9.4), then `N` offsets
and ~3N boolean ops. The sweeps are the whole cost and they are cached on the geometry epoch, so
a tier change — a darkness drifting past a window — pays only the offsets.

Meshes merge by level before drawing, so four windows in one room produce one ring per tier
rather than four sets of bands. And every spill band is Dim or brighter, so `darknessFor` gives
`erase: false` and none of them carries an `il` mesh or touches the visibility mask — half the
cost of the §10.7 region that darkened the room in the first place.

**Spill bands are the one ambient area drawn with a soft edge.** `ambientDomains` carries a
`derived` flag through the fold purely to decide this, and `field` passes `hardEdge: !derived`.
§10.7's regions stay hard because their boundary follows a wall and blurring it makes a room
bleed through its own walls; a spill band's boundary is a falloff between two light levels and
is the one place in the module where the brightness genuinely *is* continuous. The domains are
therefore keyed on `tier|derived` rather than on tier alone — two parts at one level that
disagree about their edges cannot share a mesh.

All of it is charged at rebuild and none of it per frame. That is the whole difference from the
retired ground feather (§6.4.2), which died because it rebuilt on every repaint of a drag.

### 3.4.1 Geodesic distance — the rewrite. BUILT 2026-08-28

Patrick, 2026-08-27: *"the current implementation of determining the regions to brighten and by how
much are pretty broken right now, so I want to explore alternative means."*

**Everything in §3.4 below `#### The geometry` is retired.** The eligibility test, the tier, the
`AT_LEAST` framing and the invalidation clocks all survive; the *shape* does not.

#### What was actually wrong

```
band_k = ((white ⊕ k·d) ∩ bend ∩ region) \ band_{k-1}
```

`⊕ k·d` is a Minkowski dilation, which measures **Euclidean** distance. `bend` is a union of
visibility sweeps, which measures **reachability**. So a band's brightness was decided by
straight-line distance and then merely *masked* by what could be seen — light that turned a corner
arrived having been charged for the distance **through the wall**.

Every symptom recorded in §3.4's notes follows from that one substitution. Bands bending around
exactly one corner, because a second bend needed a second union. `MAX_CORNERS` and its relevance
filter, which are a hand-rolled shortest-path search with a cap on it. `probeToward`, because
containment at a sweep's own vertex is degenerate. The L-shaped-room slivers, from cutting the union
against the region outline.

The quantity all of it was reaching for is **geodesic distance**: the length of the shortest path
from the aperture through open floor. Given that as a field, `tier = spillTier − steps(d)` is the
whole rule, and corner bending, corner *selection*, multiple bends and the region clip stop being
cases at all.

#### Fast marching, not flood fill

`model/geodesic.mjs` solves the eikonal equation `|∇d| = 1/F` by the fast marching method. Flood
fill and 8-neighbour Dijkstra were both rejected, and measured rather than argued about:

| scheme | on-axis | on-diagonal |
| --- | --- | --- |
| first order | 0.00% | 6.92% |
| first order + 8-cell analytic collar | 0.00% | 1.69% |
| **second order** | 0.00% | **2.47%** |
| second order + collar | 0.00% | 2.23% |

First order is no better than the Dijkstra it was chosen over — the error is the point-source
singularity, not the neighbourhood — and an analytic collar only pushes that singularity outward,
buying accuracy logarithmically for cells linearly. The second-order one-sided difference gets there
in the update, after which the collar is worth 0.24%, so **the seeding stays trivial**: one cell per
sample across the opening. 2.47% of a 70 ft ladder is 1.7 ft, inside a band and inside the blur.

The update is also **4-neighbour and upwind**, which removes the diagonal leak an 8-neighbour
Dijkstra has — a step between two diagonally-adjacent blockers is light through a wall, and this
module cannot ship that.

> **The second-order reach must be link-gated too.** The `t₂` term reads two cells upwind, so it
> checks the link between the first and second neighbour as well as the one it stepped over. Without
> that, a cell against a wall takes its derivative through it and brightens from the far side.

#### A wall is a cut link, not a blocked cell

Patrick, 2026-08-27: *"my only concern for this is the cells marked as walls leaving black strips
where the walls are… is there a way to fill them from their neighbouring cells (and be smart enough
to not pull from the neighbour on the wrong side of the wall)?"*

Founded, and worse than the raw 1.25 ft: §6.4.7 disables the field blur in a band centred on every
light-blocking wall, so the strip would land where nothing smooths it.

**Filling from a neighbour cannot fix it, because a blocked cell straddles the wall.** There is no
correct side — the lit side pushes brightness half a cell into the dark room, the dark side pushes a
shadow half a cell into the lit one. Either way the wall has moved.

So a wall is not a *place*, it is a **barrier between** places, which is a graph edge. Every cell
keeps a value; what a wall removes is the ability to step across it. `h[i]` is the link from cell
`i` to `i+1`, `v[i]` from `i` to `i+cols`.

- **No erosion.** Both sides get their true distance and the discontinuity lands on the wall, which
  is what §6.4.7 wants sharp.
- **No leak, provably.** Any 4-connected path from one side to the other is a continuous polyline
  through cell centres, so it must intersect the wall; the intersection lies on some link; every
  link the wall crosses is cut. Stronger than supercover cells, which rested on the rasteriser not
  skipping one.
- **Narrow openings survive.** Measured at 25 px: a solid wall slid across the lattice at eight
  offsets leaked at none; a sealed diamond rotated through thirty angles contained its fill at every
  one; a gap passes from **two cells** (2.5 ft). Only a 1.25 ft slot closes, which is the
  conservatism in the crossing test biting at the one-cell scale, and is the right way round.

The region outline is cut the same way (`cutRegionBoundary`) rather than blocking the cells outside
it — same reason, and it is where §3.4's sliver failure goes: a fill that cannot step out of the
room produces no sliver, because there is no intersection to produce one.

#### Contouring, and the two things that make it robust

Patrick, 2026-08-28: *"draw polygons out of those coloured fields, add them to the underlying
brightness model, and call it a day."* The lighting decision stays with the levels overlay; spill
supplies geometry and nothing else.

**Vertices are keyed by lattice edge index, not by position.** Chaining contour segments by matching
coordinates is where these come apart — two cells compute one crossing a float apart. Every crossing
lies on a known edge, keyed by that edge's integer index, so two cells sharing an edge produce the
identical key by construction. No tolerance anywhere in the chain.

**The rings are nested, and nothing is differenced.** `AT_LEAST` folds by `max`, so the whole
`d < 40` disc is Bright and the whole `d < 60` disc is Normal, and the fold produces the annulus.
Differencing them would compute the same answer through Clipper, which is where the slivers came
from.

A crossing with no finite neighbour — the far side of a wall, or ground the ladder never reached —
goes at the **midpoint** of the two cell centres, which is the cell boundary and therefore the wall.
Verified: a contour against a wall at `x = 700` lands at `x = 700.0`.

#### One march per room

Patrick, 2026-08-27: *"one march per room sounds like the smart choice."* Correctness before cost:
two windows filling one room from separate grids can disagree by a fraction of a cell along a shared
boundary, and thin disagreeing polygons folding together is the sliver failure again.

It is provably the same answer, not an approximation. Tier is monotone decreasing in distance, so
`max over windows of tier(d_w) = tier(min over windows of d_w)`, and the minimum over seeds is what
a multi-source march computes. The `AT_LEAST` fold that used to combine windows does the same
arithmetic one level down.

**Mixed tiers share the march via a head start.** A Normal window in a room whose ladder starts at
Bright seeds at 40 — the width of the Bright rung — so the ladder reads Normal at its mouth, exactly
as its own march would have. That is exact only because the ladder is cumulative, which is the
second thing per-tier widths bought.

#### Per-tier band widths

Patrick, 2026-08-27: *"rather than a straight band width, the value of each brightness can tell you
how large the band of that brightness is."*

`spillRadius*` keeps its three keys and changes meaning: 40 is now *bright light carries forty feet
before it reads as normal*. Reach is the sum of the rungs below wherever the ladder starts — 70 ft
from Bright, 30 from Normal, 10 from Dim.

The old scheme said two things at once, a per-tier cone radius *and* a separate uniform band width,
which double-counted the falloff and disagreed about which was the distance limit.
**`spillBandWidth` and `spillAngle` are deleted** (Patrick, 2026-08-28: *"Am I correct assuming band
width is an outdated knob?"*). The angle described the wedge the old construction clipped against
and there is no wedge; neither had a consumer left, and a live setting that moves nothing is worse
than none.

#### The cone, kept and switched off

`coneSpeed` expresses an angular falloff as **anisotropy**, not as a boundary: `F = 1` within the
half-angle of the window's normal, falling to `graze` at 90°, so grazing ground is slow to cross and
light along a wall face dims faster than light straight out. It is the `F` term of `|∇d| = 1/F`, so
it charges *travel* — and the marcher's refraction toward fast ground comes free with it.

> **An earlier sketch called this a seed cost, and that was wrong.** Every seed sits in the opening,
> so seeds do not differ from one another by direction and there is no angle to charge them for; and
> a cell beside a window is reachable across open floor whatever the seeds cost, because the march
> takes the minimum. Direction is a property of travel, so it must be charged to travel.

Shipped at `graze = 1`, i.e. off (Patrick, 2026-08-27: *"let's leave graze out this time around"*).
Kept in the file because it is the only lever in the module that can express direction at all, and
because nothing calls it while it is 1 — the speed array is never allocated.

**Known wart if it is ever switched on:** θ is measured geometrically from the aperture with no
knowledge of walls, so a cell lit by bending round a corner is still charged its straight-line
angle. The fix is propagating each path's own direction through the march, and directions average
badly at a merging front.

#### Two eligibility defects, found in play — 2026-08-28

**Sticky brightness.** Patrick: *“some areas are getting sticky brightness readings — when the
scene brightness is turned down from bright, they remain bright until the scene is set to dark.”*

Scene darkness is **animated**. `Scene##onUpdate` hands a `darknessLevel` change to
`canvas.effects.animateDarkness`, which slides `canvas.environment.darknessLevel` over ten seconds
(`CONFIG.Canvas.darknessToDaylightAnimationMS`). `updateScene` fires once, at the *start*, so
`schedule` rebuilt on the next animation frame — when the level had barely moved — read the old
`sceneTier`, matched the cached signature, stamped `lastSignature` with it, and **nothing fired
again when the animation landed**.

Dark cleared it for an unrelated reason: crossing `globalLightCutoff` switches the scene’s global
light source off, which fires `initializeLightSources` and moves a *different* term of the
signature. That is why the failure looked arbitrary — the one brightness that worked was the one
that happened to trip another hook.

The real signal is a **PIXI event on `canvas.environment`, not a Foundry hook**:
`addEventListener(“darknessChange”, …)`, dispatched every step of the animation with
`{darknessLevel, priorDarknessLevel}`. Filtered on the **tier**, not the level — the tier moves at
most three times across a sweep in which the level moves ~600 times. Attached per canvas, since
`canvas.environment` is rebuilt with the scene.

`schedule` now also requests its perception refresh **only when `generation` moved**. `rebuild`
already declined no-op work — that guard is what makes `initializeLightSources` affordable — but
the refresh ran regardless, so each no-op still cost a canvas-wide lighting *and* vision refresh.
Tolerable with document hooks; not with a per-frame signal in the mix.

**A wall near a region reads as a window.** Patrick: *“exterior walls of an interior space that
intersect with a wall outside cause light to leak in… just moving those outer walls away from the
room cleared the brightness bug.”*

§3.4 chose the ambient differential over a border test deliberately, and its reason still holds:
collinearity between a drawn region outline and a drawn wall is a tolerance exercise with no right
answer. What it missed is that a differential says nothing about **what separates the two
samples**. Any light-passing wall within `PROBE_SQUARES` of a region boundary therefore read as a
window into it — a fence, a cliff edge, a bit of scenery parked against a building — however solid
the real wall between them.

The fix is neither the border nor the differential: **can light actually get from one sample to the
other?** One `testCollision(plus, minus, {type: “light”, mode: “any”})`. It is exact rather than
approximate because **the aperture’s own edge cannot answer “no”** — it passes light by definition,
so `_testEdgeInclusion` drops it before it can occlude. A real window sees nothing between its
probes; a wall standing behind a wall sees that wall.

> **Caveat worth knowing.** A wall drawn as two parallel segments — an outer and an inner face —
> now needs the window cut in **both**, since the second face occludes the probe. That is arguably
> the correct reading, and it is diagnosable: `spill.stats().rejected.occluded` counts it.

Both defects were invisible while §3.4’s geometry was broken in larger ways. `stats()` now returns
a `rejected` breakdown — every `return null` in `apertureInfo` is counted by reason — because
§6.4.2’s lesson applies exactly here: a correct no-op and a broken mechanism look identical on
screen.

#### Cost — measured 2026-08-28

Warm, per aperture, 70 ft ladder with obstacles:

| cell size | grid | visited | best |
| --- | --- | --- | --- |
| 50 px (2.5 ft) | 3,596 | 1,623 | 0.25 ms |
| **25 px (1.25 ft)** | 13,908 | 8,269 | **1.70 ms** |
| 12.5 px | 54,692 | 38,818 | 8.90 ms |

Against ~3.5 ms of `ClockwiseSweepPolygon` per window (§9.4) that is a factor of two, **not the
order of magnitude first estimated** — the estimate assumed a cheaper per-cell constant than a
second-order solve with a heap has. It is still cheaper, it is charged at rebuild and never per
frame, and unlike the sweeps it has no term growing with wall count: `MAX_CORNERS` existed because
the old cost did. Per *room* rather than per window is a further division by however many windows a
room has.

`spillCellSize` (default 25 px) is the one knob, on the Light Spill form because too coarse a grid
changes what a creature can see. What it costs is contour precision — half a cell, 0.6 ft — not
floor, since links eat no ground.

#### Deferred: whether the falloff still needs a gradient mesh

§7.0 step 5 gave each window a triangulated mesh carrying a distance per vertex, because flat bands
plus §6.4.4's blur read as banding. `spill.ramps()` now returns empty and that path is dormant.

Not deleted, and not yet rebuilt on the new field: the bands are much wider under per-tier widths —
40 / 20 / 10 rather than 40 + 10 + 10 — so each boundary may read correctly on the blur alone, which
is the treatment every other brightness boundary gets. **If it bands, the fix is small**: ask
`contour` for thresholds at quarter-band spacing instead of tier spacing and hand the rings over
with the distances they already carry. `render/gradient.mjs` stays regardless; three other producers
use it.


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

### 4.3.1 A wall is an umbra — 2026-08-27

Patrick's suggestion, and it is the right shape rather than a workaround: the model already owns
*"this observer cannot perceive here, so clamp it"*, and a wall is the most basic case of not
perceiving. Ground outside an observer's `los` is clamped to Dark exactly as an umbra clamps, so
every unseen part of a scene renders consistently instead of showing whatever the model painted
there.

**It also ends the leak three patches missed**, and the way it does so is the argument for it.
The darkness discs visible through fog were `dark` **regions in the darkness-level texture**, not
meshes — the locator run on 2026-08-27 reported `parent: "none"`, `visible: false` for every
darkness source on the scene, which is §6.4.1's `darkeningStrength` measurement taken to its
limit. §6.2.7 masked a layer that was drawing nothing. §6.2.8 stopped fog *reading* the texture
for its replacement colour and fixed the base, but a residue survived through the partial `mix`
where the vision mask is neither 0 nor 1. Each of those blocked one route out of the texture.
This removes the discs from the texture instead, so there is no route left at any mask value.

**Render-only, and that is deliberate.** It lives in `render/paint.mjs`, not in `umbra.clampAt`,
so `perceivedTier` and every mechanical consumer are untouched. §6.1 keeps the model and the
picture agreeing by construction, and this is a claim about *drawing*: a blindsighted creature
perceives past a wall perfectly well, and a model reporting Dark there would be wrong about the
rules in order to fix something about pixels.

Cost is one Clipper difference per observer, and it composes with the umbra for free — it is
another entry in the same per-observer region list, so §5.3's `max` over observers still falls
out as the intersection, and a point one creature can see is unclamped for everyone.

`hideUnseenGround`, default on. With no observer there is no point of view to be unable to see
from, so god's eye clamps nothing.

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

#### 4.5.1a The blinded *condition* does not take blindsight — 2026-08-26

A rules change Patrick asked for, and it lands in this section because it is the same shape as
everything else here: a sense that should survive something, and a *rendering* path that took it
away anyway.

**PF1 already had the detection half right.** Its `blindSight` mode is type `OTHER` with
`_canDetect() { return true }`, so core's status gate on sight modes
(`perception/detection-mode.mjs:107`) never reaches it — a blinded creature went on detecting
whatever it could hear or feel.

**Terrain was what was lost.** `Token#_getVisionBlindedStates` sets `blinded.blind` from the
status effect (`placeables/token.mjs:911`); `isBlinded` is any-true over that record, and it
swaps the vision mode to `blindness`, after which `refreshVisibility` draws no sight FOV. So the
creature detected every token in range while standing in an unpainted void — precisely the
failure §4.5.1's `darkSightRadius` was written for, arriving down a different path.

Two halves, and both are needed:

1. **`blinded.blind` reports `false` for a creature with blindsight.** The record already
   overrode `darkness` for §4.5.1; `blind` joins it on the same principle — Foundry's *behaviour*
   is right and only its *trigger* is too broad.
2. **The radius is then clamped to the blindsight range**, assigned rather than maximised.
   Without this, `_syncSenses` has already set `sight.range` to
   `max(base, darkvision, blindsight)`, so a blinded creature would see as far as its
   **darkvision** — which is sight, and is exactly what the condition removes.

**A third subset of the same trait data**, which is why `perception.blindsightRange` exists
beside `darkSightRange` and `visualDarkSightRange`. The senses that survive *darkness* are not
the senses that survive *blinding*: *true seeing* and *see in darkness* are still sight, and a
blinded creature gets neither. One function per question rather than one function with a flag —
using the wrong subset is invisible at the call site.

What stays blocked is the part that should: core gates sight-based detection on the **status
effect** rather than on this record, so `basicSight` and `lightPerception` still fail. That
division is what makes the change safe — the creature perceives, and does not see.

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

> **That table is the mapping, with one qualification — restored 2026-08-25.** §7.0 made the
> background whatever our texture put there rather than always Dark, and `levelForTier` was
> rewritten to return the *rung distance* from background to target. That was a step too far.
> The middle levels are relative but they are not **evenly** relative: `deriveWeights` solves
> `weightDim` and `weightBright` against a **Dark** background, so `DIM` only means our Dim when
> the ground is Dark, and a rung of our ladder is not a rung of Foundry's.
>
> Symptom, reported by Patrick: with ambient set to **Dim**, Normal and Dim were nearly
> indistinguishable even with the two set to 0.1 and 0.9 — and *every other ambient behaved*.
> That is the diagnosis stated as a symptom. Dim is the only background on which a one-rung step
> asks for a **middle** level: from Dark you ask for `DIM` (the case the weight is solved for),
> from Normal you ask for `BRIGHTEST` (absolute), from Bright nothing. Only from Dim do you ask
> for a middle level with the wrong weight behind it — a torch's Normal ring came out at
> luminance ≈0.23 on a ground of ≈0.145, where Normal should be ≈0.905.
>
> So `levelForTier` is this table again, floored at `UNLIT` when the target is not brighter than
> the ground — which is the one thing the relative form was needed for (a torch's band capped at
> Normal must add nothing on Normal ground). **Exactly one cell of the matrix changed**: Normal
> on Dim ground, `DIM` → `BRIGHT`.
>
> It is safe because "absolute" only has to hold where each level is reachable. `DIM` is asked
> for only when the target is Dim and the ground darker — so the ground is Dark, its solved
> case. `BRIGHT` is asked for on Dark or Dim ground, and `mix(bg, ambientBrightest,
> weightBright)` barely moves between them because `weightBright` is large. `BRIGHTEST` and
> `UNLIT` do not read the weights at all.
>
> *Lesson, and it is the second time this exact shape has bitten: a quantity being relative does
> not make it linear in the units you happen to be counting.*

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

#### 6.2.7 A darkness source ignores the vision mask too — 2026-08-27

The same finding as §6.2.5 from one layer higher up, and found the same way: by observing that
players could watch darkness bubbles move through rooms they had no vision into.

Three of the four effect layers install a `VisualEffectsMaskingFilter` in `_draw` —
`background-effects.mjs:58`, `illumination-effects.mjs:119`, `coloration-effects.mjs:45`. The
fourth, `darkness-effects.mjs:27`, installs a plain `VoidFilter`. That filter's core is one line
(`effects-masking.mjs:173`):

```glsl
finalColor = mix(getReplacementColor(), finalColor, texture2D(visionTexture, vMaskTextureCoord).r);
```

So light and colour are withheld where the vision mask reads zero, and **darkness is not**.

**Why it read as two separate bugs.** Umbras looked right while darkness circles did not, which
sent the first round of diagnosis at `vision/umbra-mask.mjs` — wrongly, and its own readout
disproved it: with `umbraPerception` off it reported `trimmed: 0, drawn: 0`, meaning that patch
swapped nothing and drew nothing while the symptom persisted. The real split is a rendering one.
With the §7.0 takeover on, `darkeningStrength` withholds the source mesh for every tier **but**
Supernatural Dark, so an ordinary *darkness* is a `dark` region in the illumination texture and
is already masked, while a supernatural one is a source mesh on the unmasked layer.

It also explains, with no second cause, why it only showed at normal or bright scene darkness:
the leak is a *darkened* copy of the map, and that is only distinguishable from its surroundings
when the surroundings are bright.

**Fixed in `render/darkness-mask.mjs`**, a prototype patch on the layer's `_draw` — there is no
CONFIG slot; `groups/effects.mjs:125` constructs the class directly. Mode `BACKGROUND`, whose
replacement colour is `vec4(0.0)` (`effects-masking.mjs:154`): an unseen area gets *nothing* from
the layer rather than a substituted colour, which is what a `NORMAL`-blended layer needs.
Registered in `canvas.effects.visualEffectsMaskingFilters` so core's `toggleMaskingFilters` owns
the `enableVisionMasking` uniform — without that, the darkness layer would stay masked on a scene
with token vision off, which is a worse asymmetry than the one being fixed.

It changes core behaviour for every darkness source, including other modules'. Patrick's call,
2026-08-27, with that stated. It follows observer mode for free, since `canvas.masks.vision` is
whatever the current viewer's mask is.

**And it fixed almost nothing, because the leak was one layer lower.** Kept anyway — Supernatural
Dark genuinely is drawn as a source mesh here and genuinely did draw through walls — but the
report it was aimed at is §6.2.8.

#### 6.2.8 Fog renders the model on purpose — 2026-08-27

The actual cause of "players can see darkness circles in rooms they cannot see into", and the
third wrong guess before it. Core paints unseen ground from `getReplacementColor()`
(`effects-masking.mjs:153-158`):

```glsl
float darknessLevel = texture2D(darknessLevelTexture, vMaskTextureCoord).r;
return vec4(mix(ambientDaylight, ambientDarkness, darknessLevel), 1.0);
```

and `illumination-effects.mjs:120` supplies `darknessLevelTexture:
canvas.effects.illumination.renderTexture`, which is `darknessLevelMeshes.renderTexture` — the
container §7.0 writes the model into.

**Fog is not failing to hide the model. It is rendering it, per fragment, on purpose.** In stock
Foundry that texture holds nothing but static region data, so sampling it for the unseen colour is
free coherence. Once this module writes five tiers of live state into it, the same line publishes
every darkness bubble and every umbra to anyone who cannot see them.

Two facts that never fitted any other story fall out of it. The circles were *texture regions*,
not meshes — §6.4.1 measured one darkness source drawn out of seven with the takeover on — which
is why §6.2.7 had almost nothing to act on. And it only showed at normal or bright scene darkness
because at high darkness both ends of `mix(ambientDaylight, ambientDarkness, …)` are nearly the
same colour and the discs vanish into it.

**Fixed in `render/darkness-mask.mjs`** by swapping `CONFIG.Canvas.visualEffectsMaskingFilter`
(a real config slot, `config.mjs:701`, read fresh by every layer's `_draw`) for a subclass whose
mode-1 replacement reads a `pf1SceneDarkness` uniform instead of the texture. The uniform is set
per `apply`, because Foundry animates darkness transitions without firing a document update — the
same trap `registry.ambientTier` is read live to avoid. A negative value is the sentinel for
core's original behaviour, so the setting toggles live and needs no second shader.

The header is **copied from core with one line changed**, not produced by `replace()` on the
original. String surgery against a shader fails silently the first time upstream reformats a line,
and a shader that has quietly stopped masking is indistinguishable from one that is working.

**Accepted consequence:** §10.7's ambient regions stop showing through fog as well, so an unlit
cellar reads at scene brightness in unexplored area. Patrick's call, 2026-08-27. Separating them
would mean a second darkness-level texture holding only the static half — a great deal of
machinery to reveal architecture the map already shows.

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

> **§7.0 left this half-finished, and the half that remains is the visible one.** Reported by
> Patrick 2026-08-25 as *"blindsight removes animations from darkness sources"*, which it does,
> exactly as written above — withholding the mesh withholds everything the mesh carries, and
> since §6.2.6 that includes the GM's chosen animation.
>
> The report is worth more than the symptom, because it says the reasoning has expired. When
> this was written the darkness **source** was what made the region dark, so withholding it did
> make the bubble indistinguishable from the ground around it. Since §7.0 the *texture* carries
> the ground's tier and the source only carries the violet and the animation — so withholding it
> now removes the overlay and leaves the region **still painted Dark**. A blindsighted creature
> gets a region that is dark, static, and unexplained, which is neither the old behaviour nor the
> intended one.
>
> Three ways out were put to Patrick — leave it; stop withholding; or finish the intent by making
> the texture observer-relative for blindsight as well, which `render/paint.mjs` already has the
> machinery for. **Decided 2026-08-26: leave it**, and darkness animations are shelved as a
> feature besides.
>
> So the section stands as written with one correction to its scope: withholding the mesh no
> longer makes the bubble indistinguishable from the ground, and cannot, while the texture owns
> the tier. What it does today is remove the violet and the animation for a blindsighted
> observer. That is a smaller claim than the one above and it is the true one.
>
> **Do not "fix" the animation in isolation** if this is revisited — the animation is a symptom
> of the withholding, and the withholding is right or wrong as a whole.

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

#### 6.2.9 A tier is a brightness, not a brightening — BUILT AND PLAY-TESTED, 2026-08-27

Patrick, 2026-08-27: *"I don't like that the different brightness levels vary in actual brightness
based on the global illumination of a scene. I want a fixed brightness for each level."*

He is right, and the cause is one line of core's shader rather than anything in the model.

##### Where the scene's illumination was leaking in

The **ground** was already fixed and has been since §7.0. The baseline sampler turns our texture
into colour with `mix(ambientDaylight, ambientDarkness, level)`
(`baseline-illumination.mjs:21`), and those two colours come from the scene's *palette*, not from
its darkness slider — so a region painted Dim is the same pixel value on every scene.

**Light sources were not.** Every light draws its own mesh on top, and computes its zones from the
ground beneath (`base-lighting.mjs:361-366`):

```glsl
computedBackgroundColor = mix(ambientDaylight, ambientDarkness, texture2D(darknessLevelTexture, …).r);
computedBrightColor     = mix(computedBackgroundColor, ambientBrightest, weightBright);
computedDimColor        = mix(computedBackgroundColor, computedBrightColor, weightDim);
```

`deriveWeights` (§6.2.3) solves those weights so a light's bright zone lands exactly on our Normal
**when the background is Dark**. Every other background drifts, and which background a light stands
on is what the scene's global illumination decides. In luminance, with the default palette:

| ground | zone `levelForTier` asks for | rendered | should be |
| --- | --- | --- | --- |
| Dark (0.188) | `BRIGHT` | **0.685** | 0.685 — Normal ✓ |
| Dim (0.436) | `BRIGHT` | **0.781** | 0.685 — Normal ✗ |

A torch's Normal ring in a dim room reads a third of the way from Normal to Bright. §6.2.3 recorded
this as a deliberate bargain — *"lights must stay relative to the background, because the background
is the only channel through which the model can reach them"* — and that reasoning was sound while
the background was the only channel. It stopped being true when §7.0 gave us a tier table the
ground is painted from directly.

##### The fix, and why it is core's own branch

`COMPUTE_ILLUMINATION` has an `else` (`base-lighting.mjs:373-378`) that takes `colorBackground`,
`colorDim` and `colorBright` as **uniforms**. Setting `computeIllumination = false` selects it. So
`render/clip.mjs` hands each source the three colours outright, computed with the *same expression
the ground uses*:

```
tierColor(tier) = mix(ambientDaylight, ambientDarkness, darknessTable()[tier])
```

There is one expression of the ladder, so a light asking for Normal and ground at Normal cannot
drift apart.

Three things make this exact rather than an approximation, and each is a debt §6.1 or §7.0 already
paid:

- **A per-source constant is enough** because every source is clipped to a *cell*, and a cell is a
  region of uniform treatment — the ground tier under a source does not vary across the part of it
  that draws. The relative path needs a per-fragment background precisely because it has no such
  guarantee.
- **`levelForTier` is not used on this path at all.** The `else` branch skips `getCorrectedColor`,
  so there is no translation into one of Foundry's four levels — and translating first is exactly
  what would put the relative step back. The tier is the answer.
- **`UNLIT` falls out rather than being special-cased.** A zone no brighter than its ground is given
  the ground's own colour; `FRAGMENT_END` mixes toward `computedBackgroundColor`, so all three equal
  leaves the ground exactly as the texture painted it. A torch at noon draws nothing, as before.

> **The illumination layer only, and it crashed on the first run for saying so badly.** All three
> layers — background, illumination, coloration — share `_updateCommonUniforms`, and the GLSL
> declares all three colour uniforms for every one of them (`base-lighting.mjs:107-112`). But only
> `AdaptiveIlluminationShader` seeds `colorDim`/`colorBright` in `defaultUniforms`
> (`illumination-lighting.mjs:84-85`), so on the other two they are `undefined` in JS and
> `Color#applyRGB` threw once per frame inside the ticker.
>
> The guard is a test for those two uniforms, which is the fix and is also the correct *selection*
> rather than a defensive one. They are read by exactly one thing — `TRANSITION`
> (`base-lighting.mjs:341`) — which only the illumination fragment program includes. The background
> layer tints the map artwork and the coloration layer paints the light's colour, and neither was
> part of the problem: the background layer already computes `computedBackgroundColor` per fragment
> from our texture, which is absolute. Switching it to a per-source constant would have been a
> change nobody asked for, arrived at by accident.

##### Both paths are kept

`LEVEL`/`BAND_LEVEL` are still set beside `TIERS`, and the level corrections are still uploaded.
The absolute path is gated on **`ambientTakeover`**, not on the renderer, for the reason that ties
`applyLightWeights` to the same switch: with the takeover off, Foundry's own darkness level drives
the ground and the tier table describes nothing that is on screen — pinning lights to it would make
them the one thing ignoring the scene. Off, the relative path is Foundry's behaviour rather than a
fallback we maintain.

##### What this does not fix

Two further places the scene's slider still reaches a pixel, both outside the light sources:

- **Fog colour.** `colors.fogExplored = colors.background × sceneFogColor`, and `colors.background`
  is `mix(darkness, daylight, 1 − sceneDarkness)` (`environment.mjs:226`). Inert at the default fog
  colour of black — black times anything is black — and live the moment a GM sets a coloured fog.
- **Unpainted ground.** The darkness-level container clears to `canvas.environment.darknessLevel`
  (`effects.mjs:240`), so anywhere no mesh covers falls back to the scene's own value. Invisible
  with the default table, where Dark is 1.0 and so *is* that fallback; an inversion with any table
  that puts Dark below 1, since at full scene darkness a *darkness* spell would then paint lighter
  than the night around it.

And one that is stable but not equal: blocked vision is Dark in the texture (§4.3.1) and then has
the fog-of-war overlay composited on top — 50% black where explored, solid black where not. So
"everything blocked reads as one brightness" is two brightnesses, neither of them the Dark tier.
Left alone deliberately: the fog overlay is how a player tells *unseen* from *unvisited*, which is
information the light model has no business removing.

#### 6.2.10 Nothing but the model may set a pixel's brightness — BUILT AND PLAY-TESTED, 2026-08-27

Patrick, 2026-08-27, after §7.0 step 6 and still seeing it: *"Global illumination should have no
impact on any brightness levels within a scene save that it may change the levels of cells. A dark
cell as identified by our model should be the exact same pixel coloration regardless of
illumination settings. The only thing that affects how each cell is painted is the brightness level
provided by the model, whether or not the current view has vision of that cell, and whether or not
it's on the edge of a different light level."*

That is the specification. Three things were still violating it, and **two of them were ours** —
each introduced to fix something real, each reaching for `canvas.environment.darknessLevel` because
at the time it was the nearest available stand-in for "ambient".

**1. The fog replacement colour — the big one, and it is §6.2.8's.** The masking filter replaces
every fragment the viewer cannot see, and §6.2.8 fed it `canvas.environment.darknessLevel` so that
darkness discs would stop showing through fog. It worked, and it made *most of a player's screen*
render at whatever the slider said. It is also no longer needed for its original purpose: §4.3.1
clamps unseen ground to Dark **in the texture**, so there are no discs left in it to bleed through.
The uniform now carries `darknessTable()[TIER.DARK]` — the same answer, arrived at from the other
side, and constant.

**2. Global illumination painting over the finished map — ours, §7.0's.** `ambient.mjs` narrows the
global source's upper threshold so it discards where the model says *darker than Dim*. Correct while
the ground's brightness still came from light sources; wrong afterwards, because it leaves the
source painting everywhere *else*, and what it paints is
`mix(computedBackgroundColor, ambientBrightest, weightBright)` — a wash laid over the tier the
texture just wrote. Worse, the wash appears and disappears as the scene's darkness crosses the
source's own `darkness.min/max` band, which is a brightness change with no model change behind it.

Under step 6 the band is inverted instead, so every fragment discards. **The reveal half is
untouched** — `#refreshDynamicIllumination` reads the source's *shape* into the visibility mask
(`visibility.mjs:637-640`), not this uniform — so global illumination still lights the map for the
purpose of what a creature can see. Only its opinion about brightness is withdrawn, which the
texture now owns outright.

**3. The coloration layer's unseen replacement — core's.** `canvas.effects.coloration` blends
**`ADD`** (`coloration-effects.mjs:47`), and core replaces its unseen fragments with
`canvas.colors.background` (`effects.mjs:239`), which is `mix(darkness, daylight, 1 − sceneDarkness)`.
So a grey scaling with the slider was being *added* to every pixel the viewer could not see. Now
black — not a tuning choice but the identity for an additive layer: no coloured light reaches
ground you cannot see.

##### The rule this leaves behind

> **`canvas.environment.darknessLevel` is not an input to anything this module draws.** It selects
> which *tier* open ground is, through `registry.ambientTier`, and there its involvement ends. Any
> other read of it — in a shader uniform, a replacement colour, a clear colour — is a leak, because
> it lets the scene's slider move a pixel the model did not move.

Three further reads of it survive and are named so they are not rediscovered as bugs. The container
**clear colour** (`effects.mjs:240`) is now unreachable, since §7.0 step 6 made the ground cover the
scene rect unconditionally. **Fog-of-war colours** are `colors.background × sceneFogColor` and inert
at the default fog colour of black. The **renderer background** is what shows outside the scene
rect, where there is no model to disagree with.

#### 6.2.11 Greyscale, taken over — BUILT 2026-08-27

Patrick, 2026-08-27: *"Rather than hacking together a bunch of rules, I want to do more like what we
did with lighting and create one centralized implementation that disables existing routes and
implements its own singular application according to our rules."*

A creature that sees in black and white falls back on that sense **where there is no light**. Where
there is light it uses its eyes, and its eyes see colour. So the boundary between grey and colour is
a brightness boundary, and this module computes, rasterises and blurs exactly one of those. Foundry
instead greys the entire canvas the moment a darkvision token becomes the viewer.

##### The first attempt, and why it produced nothing

Built first as two shader patches — the primary sprite's `ColorAdjustmentsSamplerShader`, whose
per-pixel darkness link core ships and disables, plus the coloration masking filter. Both landed;
`render.greyscale()` reported every switch on; the picture was unchanged inside a darkvision radius.

The cause is one line, which every vision-source layer begins on (`base-lighting.mjs:395`):

```glsl
vec4 baseColor = useSampler ? texture2D(primaryTexture, vSamplerUvs) : vec4(1.0);
```

with `u.primaryTexture = canvas.primary.renderTexture` (`point-vision-source.mjs:428`) — the **raw**
cached terrain, sampled before the primary sprite's shader ever runs. A vision source does precisely
what §6.2.5 found a *darkness* source doing: it takes its own copy of the map and repaints it on its
own terms. `background.visibility: REQUIRED` makes darkvision do that across its whole field of
view, so the sprite's output was overpainted everywhere it would have mattered.

> **The general lesson, and it is the fifth face of §6.2.3's finding.** No shader that samples
> `canvas.primary.renderTexture` can be corrected by changing what the primary sprite does. Three of
> the five routes below sample it independently. This is now twice that a per-source repaint has
> defeated a per-layer correction, and the second time it was the same file that documented the
> first.

##### The five routes greyscale reached the screen by

| # | Route | Applies to | Samples |
| --- | --- | --- | --- |
| 1 | `visionMode.canvas.shader` + `canvas.uniforms.saturation` | the whole canvas | raw primary texture |
| 2 | vision source **background** layer, `vision.defaults.saturation` | inside the FOV | raw primary texture — **overpaints 1** |
| 3 | vision source illumination + coloration layers, same uniform | inside the FOV | — |
| 4 | `lighting.*.postProcessingModes: ["SATURATION"]` via `VisualEffectsMaskingFilter` | whole effects layers | — |
| 5 | §6.2.5's darkness-shader wrap (ours) | inside a darkness disc | raw primary texture |

Five places, four of them core's. Correcting them one at a time is unwinnable, because route 2 wins
wherever a vision source paints.

##### The takeover

Same shape as §7.0's. **Zero every route, then add one pass nothing can repaint over.**

`neutralise()` rebuilds PF1's darkvision `VisionMode` with routes 1–4 at zero, at `setup` because
PF1 assigns the mode during `init` (`pf1.mjs:261`). Route 5 falls silent on its own:
`desaturate.currentSaturation()` reads `visionModeOverrides.saturation`, which route 2 has just set
to 0, so the darkness wrap mixes by nothing without that file being edited. After it runs, nothing
in Foundry's pipeline desaturates anything, on any layer, for any observer.

One pass replaces them, on **`canvas.environment`**. That group is `CanvasGroupMixin(PIXI.Container)`
— an ordinary container, none of `CachedContainer`'s complications — and it holds `primary` (terrain,
tokens, tiles, weather) and `effects` (every lighting layer). `visibility` and `interface` are its
*siblings* under `rendered`, so the fog overlay, the grid, nameplates and the UI are outside it and
stay in colour. The filter runs after all of that has composited: it cannot be overpainted, and it
does not care which source sampled which texture.

Built on `AbstractBaseMaskFilter` for its vertex shader alone. `vMaskTextureCoord` is
`(vTextureCoord × inputSize.xy + outputFrame.xy) / screenDimensions` — the screen UV, correct even
when the filter is handed a sub-rect, which `vTextureCoord` on its own is not.

```
grey = clamp((level - dimLevel) / (darkLevel - dimLevel), 0, 1) x greyness x fogGate
```

At or above Dark, fully grey; at or below Dim, full colour; and **the blurred band between the two
rungs is the gradient**, so the greyscale edge is exactly as soft as the brightness edge beside it
and moves with §6.4.3's width without reading it. Both rungs come from `darknessTable()`, so
retuning the ladder in *Configure Visuals* moves this too.

##### The gold halo was the clamp, not the rule — 2026-08-27

Reported as: *"getting a colour halo around a darkness source when looking out of it. Only appears
where the light beyond the darkness source is brighter than dark."*

**Diagnosed twice, and the first diagnosis was wrong in an instructive way.** The first reading took
the ring as the field being *right* — a light out-reaching the darkness that suppresses it, so the
annulus between the two radii is genuinely lit — and moved `colourLevel` from Dim to Normal so that
dim light no longer reached full colour. Patrick rejected it on both counts: Dim in full colour is
what darkvision should look like, and, decisively:

> *"The umbra does a good job of blocking (360 degree from within the darkness), but it looks like
> the gradient from dark to not-dark is escaping either our umbra or our grey-ification, even though
> it doesn't actually gradient away from dark from the token's perspective."*

Which is exactly right, and names the bug. An observer inside a darkness has **everything** beyond
it clamped to Dark (§4.3). There is no gradient to read. The field had one anyway, and the greyscale
reported it faithfully.

The gradient came from `clampRamps`. Its collar is built as `offsetPaths(paths, -half)` — and a
negative Clipper offset shrinks the *region*, which means it **grows every hole**. The umbra's holes
are the darkness sources that cast it, so the collar wrapped each of those too, fading the clamp to
0 over ground the observer cannot see. `MAX_COLOR` then let whatever was beneath show through, and a
light out-reaching its own darkness came back as a bright ring at the rim.

Fixed by eroding the outer rings only (`splitRings`, then subtracting the untouched holes). Not a
judgement about holes in general — it is that a hole here is a boundary the clamp shares with
something **at least as dark**, so there is no step to soften. The hard edge that leaves is softened
by §6.4.4's field blur along with every other boundary nobody enumerated, and that blur works on the
*composited* field, so it cannot reveal a brighter value from beneath the way the collar could.

> **The rule this leaves behind.** A feature keyed to the brightness field reports that field
> faithfully, including its faults — so **a wrong picture in `render/greyscale.mjs` is usually a
> right reading of a wrong field.** Reach for `render.transect()` and `overlay.levels()` before
> touching the rule. Three rounds now: the sprite was not the terrain's only painter, a tier
> boundary is not always a broad one, and a clamp's collar is not only on its outside. Each was
> refuted by one look at a screenshot, and the third would have been reached faster by taking the
> reporter's geometry at face value the first time.

##### The takeover destroys its own input

`visionModeOverrides.saturation` was how the observer's greyness was read, and after routes 1-4 are
zeroed it reports 0 for everyone — so the filter would correctly compute that nobody sees in black
and white, and do nothing, for ever. The value is captured by vision-mode id at neutralise time and
read back from there. Worth naming because it is a general hazard of this pattern: **a takeover that
zeroes a field cannot also read that field**, and the failure is silent and total.

##### What changes visibly beyond the intent

**Tokens grey too.** They live in `primary`. A creature standing in a dark room should not be in
colour to an observer who can only see it by darkvision, and today it always is — a correction, but
a conspicuous one, and the first thing that will look different.

**Darkvision only.** `monochromatic` and `lightAmplification` keep every route they have.
Monochromatic models an eye that cannot see colour *at all*, which is not a statement about where
the light is; amplification is a different effect wearing the same shader.

##### Blocked vision is a dial

Excluding fog inverts the semantics on screen: ground you *can* see goes grey, ground you *cannot*
returns to colour, with your vision polygon as a moving hard-edged boundary between them. A real
risk of looking worse than the muddiness it fixes, which is why `greyscaleInFog` is a 0..1 slider
defaulting to **0.5** rather than a switch. The argument on the other side is genuine: the tier field
is painted scene-wide and already shows through fog as a documented leak, and colouring the fog
removes one channel of it.

##### What this now closes that the first attempt did not

The coloration gap. §"Colour in an umbra is the coloration layer, never the map" (2026-08-23)
established that a light's tint survives on top of grey terrain because nothing removes a placed
light from an umbra. A pass after compositing greys the tint along with everything else, so a torch
in a Dark region is grey light. It is still *light* — removing it there remains per-observer
clipping and remains the §9.5 cost this design avoids — but the colour half is gone.

That entry also carried the sentence *"It physically cannot be grey in one place and coloured in
another."* True of the code as it stood, false as a general claim, and struck there.

#### 6.4.7 The blur must not cross a wall — BUILT 2026-08-27

Patrick, 2026-08-27: *"I want to be able to turn off blurring on lines created by walls. That way a
lit interior room won't bleed light outside, and a dark room won't have light from around it
bleeding over the walls."*

##### The bleed is §6.4.4 working correctly in the wrong place

A light's mesh already stops exactly at the wall — `source.shape` is a wall-clipped sweep, and that
has always been right. §6.4.4 then blurs the **composited field**, and a convolution does not know
what a wall is: it mixes the lit fragment inside the room with the unlit one outside, in both
directions, across roughly one `transitionWidth`. The room glows through its own walls.

This is the cost §6.4.4 named and accepted in advance — *"Selectivity. It softens boundaries the
model might want hard."* — coming due. Every other boundary in the field wants the blur. A wall is
the one case where the hard edge is also the physically right answer: a wall casts a sharp shadow at
its own surface.

##### The idea that does not work

Put the blur on a **child** container holding the soft meshes and leave the hard ones as siblings:
no extra pass, no new data. It destroys the field. PIXI composites a filtered container's output
with the **filter's** blend mode rather than each mesh's, so everything inside would collapse into
one group under a single blend — and the field is built on per-mesh `MIN_COLOR`/`MAX_COLOR`. Same
finding that bit the erase-blur in §6.2.7's fix earlier the same day.

##### A mask of segments, not per-mesh metadata

The first instinct is per-boundary provenance: `light-ramps` could mark wall-derived vertices
cheaply, since a sweep vertex closer to the origin than `source.radius` is wall-derived by
construction. That is per-mesh work on every repaint, for every light, and it still misses every
boundary produced by anything that is not a light.

`canvas.edges` already holds the answer for the whole scene — `Edge` objects with `a`, `b` and a
per-sense restriction. `render/wall-mask.mjs` draws every light-blocking edge into one screen-sized
`CachedContainer`, which is a single `Graphics` pass, independent of mesh count, rebuilt only when
the edges change. **The walls are scene data, not mesh data**, and asking the meshes was the
expensive way to learn something the scene already knew.

`edge.light`, not `edge.sight`: the field is a *brightness* field, and a window that blocks sight
while passing light should blur normally — §3.4's whole spill feature exists because that case is
real.

##### Blur, then put the walls back

`render/texture-blur.mjs` no longer hands the container a `PIXI.BlurFilter`. It hands it a composite
that runs the blur into a scratch target and then chooses per fragment:

```
final = mix(blurred, sharp, wallMask)
```

**One filter, not two, and that is forced.** PIXI chains filters sequentially, so a second filter
would only ever see the first's output; there is no way for it to reach back for the unblurred
field. Running the blur inside `apply` via `filterManager.getFilterTexture()` is what puts both in
front of the same fragment.

The band is `2 × transitionWidth` wide, centred on the wall, because that is the reach of what it
has to defeat: a Gaussian's visible extent is about twice its strength and the blur runs at
`width() / 2`, so brightness travels about one `width()` past any hard edge. One `width()` on each
side is what makes the suppression complete rather than merely reduced. Round caps and joins, so a
corner between two walls has no gap for brightness to squeeze through.

The inner `PIXI.BlurFilter` is still the object registered with `canvas.addBlurFilter`, not the
composite: that helper re-derives `.blur` from the stage scale on every zoom and needs the object
that actually has a `blur` property.

With `sharpWalls` off the composite is bypassed entirely and the blur is attached directly, so that
path is exactly what it was.

##### What it gives up

Boundaries that merely *run near* a wall are un-blurred too. Mostly they are the same boundary — a
light's cut edge lies along the wall that cut it — and where they are not, the band is
`2 × transitionWidth` and the two fields agree at its edge, so the seam is where sharp and blurred
were converging anyway.

#### 6.4.8 The blur's taps were the banding — FIXED 2026-08-28

Patrick, 2026-08-28: *"rounded blurring/gradients look really good, but straight line ones are much
less so … a shadow along a straight wall does not blur well at all, and looks very discrete"*, and
then, after §6.4.7 was ruled out: *"the sharp wall cutoffs aren't actually showing sharp. They're
removing the smear, but not the gradient the smear acts on. The issue isn't that the smear is bad,
but that there's still a gradient there at all."*

Settled by measuring the field rather than reasoning about it. A transect of the darkness-level
texture across the boundary changed value **every 8 screen pixels**, and its first differences were
a clean bell:

```
0.015 0.028 0.051 0.078 0.106 0.126 0.126 0.109 0.078 0.051 0.028 0.012
```

**The derivative of a blurred step is the kernel**, so that bell is the fifteen taps of the blur
itself, one per terrace. The ramp between them is perfectly smooth and finely quantised — the 8-bit
`RED` texture and the tier ladder were both innocent.

`PIXI.BlurFilter` spaces its taps `blur / quality` apart and nothing else moves them:
`generateBlurVertSource` offsets tap `i` by `(i - 7) * strength`, and `BlurFilterPass#apply` sets
that strength to `blur / passes`. Quality was left at PIXI's default of 4; at Patrick's zoom
`blur ≈ 32`, and `32 / 4 = 8`. The arithmetic and the measurement agree to the pixel.

So it was never a Gaussian — it was a comb, and a step convolved with a comb is a staircase. It
reads as banding on straight boundaries and not on curved ones for the reason any regular sampling
artefact does: along a straight edge the terraces line up into a stripe the eye can follow, and
around a curve the same terraces are staggered and read as texture. *"Rounded ones look really
good"* was the diagnosis, not a compliment.

`quality` is now solved from the running blur to keep the taps within two screen pixels, bounded at
24 passes. PIXI distributes one blur across its passes rather than compounding it, so this holds the
visible width and only makes the profile smoother — nothing needs compensating. It is retuned on
every sync rather than only when the setting changes, because zoom moves `filter.blur` without
moving `strength`.

##### The knob this file had already turned, in the wrong direction

`kernelSize` was raised from PIXI's default 5 to 15 with the note *"the tap count is the one place
§7.0 step 5's finding still applies, and this is the smooth end of what `PIXI.BlurFilter` offers."*
More taps at the same spacing makes the kernel **wider**, not denser — 15 taps spanning
`±7 × spacing` reach three times as far as 5 do, at identical coarseness. So the change widened the
smear and left the banding exactly where it was, which is a fair description of the symptom that
followed. It stays at 15, because a wider kernel per pass is a smoother profile *once the spacing is
fixed*; it was simply never the term that fixed it.

`render.blur()` reports `quality` and `tapSpacing`. `quality` pinned at its cap with the spacing
still high means the transition is wider than the pass budget can sample — lower `transitionWidth`
or raise the cap.

**This smoothed the gradients; it did not make a wall's edge sharp**, which was the actual request
§6.4.7 exists to serve. Those are separate defects that shared one symptom, and only the sampling
half is fixed here. See Appendix C, *a wall's edge is still not sharp*.

**`quality` is the cost term**, since it is the pass count in each direction. Solving for a
two-pixel spacing on a wide transition can reach the 24-pass cap, which is 48 full-screen passes
over the darkness texture per repaint — not per frame, since the container only redraws when it is
dirty, but a visible hitch on a busy repaint would come from here first. `TAP_SPACING` is the knob:
raising it to 3 or 4 cuts the passes proportionally and the banding it buys back is well under what
was measured.

##### What this cost, and the rule it earns

Two wrong answers before the measurement: §6.4.7's wall mask, which was a real hard edge and not
this one; and the tier ladder, on the strength of a note this project had itself written
predicting exactly that risk. Both fit *"straight bad, curved good"* — and so does every regular
sampling artefact, which is what should have been suspected first.

> **A defect that tracks the *orientation* of a boundary rather than its content is a sampling
> artefact.** Nothing in the model knows which way a wall runs. Measure the field before
> theorising about what put it there — one transect settled in a single command what two rounds of
> reading source did not.

#### 6.4.3 One gradient, everywhere — BUILT AND PLAY-TESTED, 2026-08-27

Patrick, 2026-08-27: *"our implementation looks very piecemeal right now. Can we consolidate that
to a single gradient system that covers all transitions between brightnesses?"*

It was, and the reason is that each boundary got a mechanism invented for it at the time, each
with its own units:

| Boundary | Was | Width expressed as |
| --- | --- | --- |
| region edge, darkness rim, umbra | a `PIXI.BlurFilter` per mesh | blur strength in world px |
| §3.4 spill band | per-vertex ramp | a *fraction of a band* |
| §7.0 step 6 light zone | per-vertex ramp | a *fraction of the narrower zone* |
| clamp edge | a blur again | blur strength |

So "half a transition" meant three different distances depending on what it was next to. And one
of the four was not a gradient at all: a blur fades a mesh's **alpha** to reveal what is beneath,
which is why §7.0 step 5 could never make one read as a ramp however wide it went.

##### The rule

> **Every brightness boundary ramps over the same distance, centred on the boundary.**

One number, in grid squares, in `render/transition.mjs`. A two-rung boundary is deliberately *not*
made wider for it — a wider fade reads as *less* of a step, and a two-rung boundary is more of one.

Everything calls one function, `levelAtDistance(d, zones)`, with zones in scene pixels. Only the
distance differs:

| Producer | Distance is |
| --- | --- |
| `render/halo.mjs` | across a ground cell's boundary |
| `render/gradient.mjs` (§3.4) | out from the lit wedge |
| `render/light-ramps.mjs` (§7.0 step 6) | from the light's origin |
| `render/paint.mjs` clamps | in from the shadow's edge |

##### Ground boundaries, and why no cell needs to know its neighbour

A halo is the collar around a cell, half a transition either side of its boundary, inner edge at
the cell's own level and outer edge at whatever cell is found there. Painted **`MIN_COLOR`**, which
is what makes it composable: the *brighter* cell's halo bleeds into the darker one and is the
visible transition, while the darker cell's halo over the brighter one is min'd away because every
value in it is darker than what is already painted. Both cells emit one, no coordination happens,
and the blend picks the correct half of each pair by itself.

That is the same mechanism §7.0 step 6 uses for two overlapping torches, which is the point: one
rule wherever brightness meets brightness.

##### The clamp edge is the `MAX` mirror of it

A clamp region is eroded and its collar ramps from the clamp level down to **zero** — the brightest
value the channel holds, and `max(x, 0) = x`, so the outer end of the collar contributes nothing.
A soft vision boundary out of the same profile, with no filter.

##### What came off

- **The ground blur**, and with it `groundSoftness`'s effect. The setting stays registered so an
  existing world keeps its value; it reads nothing.
- **The seam backstop** (§6.4.2a). It existed for one failure — two blurred meshes fading at a
  shared boundary, neither covering it, letting the container's clear through as a bright ring.
  With no blur the meshes are opaque to their own edges; and §7.0 step 6 made the ground cover the
  scene rect unconditionally, so the clear is unreachable regardless. Kept as a guarded no-op
  rather than deleted, because both of its reasons are worth reading before anyone reintroduces a
  filter here.
- **`spillPlateau`**, with the fractional widths it expressed. A plateau is no longer a thing to
  set: it is whatever is left of a zone once its two transitions are taken out. A zone narrower
  than a transition now simply never reaches its nominal level, which is the honest picture rather
  than a squeezed-in plateau.

##### Four rings, one-sided — corrected 2026-08-27

The first build used two rings, inner and outer, and it did not survive being turned up. Patrick at
three squares: *"the transitions work, but not well, especially along rounded surfaces."*

Two rings put every vertex at one of two distances, so the rasteriser has nothing to interpolate but
a straight line — no S-curve. Worse, and this is the part that showed on curves: the interpolation
runs along the **chords** of a polygonalised circle rather than along its radius, so the band
scallops with the period of the source polygon. Most boundaries in this module are circles.

Four rings make each band a quarter of the width, so the chord error falls with its square, and the
levels carry a real smoothstep.

The rings also run **outward only**, which is a second correction and a simplification. A centred
collar needs each *inner* vertex to know what lies beyond the edge, and a point inside the cell
cannot be asked — `levelAtPoint` answers with the cell itself. Ramping outward removes the question:
every vertex that needs a neighbour is already outside, where the lookup is exact.

It composes correctly for the same reason the whole scheme does. Both cells emit a ramp; the bright
one's runs outward into the dark and is the visible transition, and the dark one's runs outward into
the bright where every value is darker than what is already painted, so `MIN` discards it. **A
transition therefore always sits on the darker side of a boundary** — predictable, and what a light
bleeding past an edge actually looks like.

#### 6.4.4 Blur the field, not the meshes — BUILT AND PLAY-TESTED, 2026-08-27

Patrick, 2026-08-27: *"is this the best way to resolve these gradients? All we really need is a
decent blurring between the two edges of brightness — perhaps there's a simpler way?"*

Probably, and the reason the module was not already doing it is that an earlier finding had been
applied to the wrong object.

**"A blur cannot make a gradient" was true of a *mesh*, not of the *field*.** §7.0 step 5 is
correct as written: a `PIXI.BlurFilter` fades a mesh's **alpha** at its rim, so what appears there
is whatever lies beneath — and beneath a stripe is only the next stripe. Three attempts died on it
and the conclusion hardened into a general one it does not support. Blurring the **composited
scalar field** is a different operation: a hard step from `0.35` to `1.0` convolved with a kernel
*is* a smooth ramp in the value, and the consumer turns it into a smooth colour by the same
`mix(ambientDaylight, ambientDarkness, level)` it applies to any other value. No alpha, nothing
beneath.

§6.4.2's second conclusion — that the container takes no filter — was read off
`cached-container.mjs`'s redirect, which fires only when the container is *already* nested inside a
filtered parent. That is a statement about the nested case. In the plain case `CachedContainer#render`
binds the cached texture and *then* calls `super.render`, which is where PIXI pushes the filter; the
filter's output goes to whatever render texture was bound at push time, which is the cached one.

##### Why it would be better rather than merely shorter

`render/halo.mjs` softens a boundary by **enumerating** it: four polygon offsets, a boolean per
ring, a triangulation and a containment test per vertex, per ground region, per repaint. It has cost
41 ms of a repaint. And every artefact of the last three rounds was a property of that machinery
rather than of the picture — round joins curving a corner, a fixed arc tolerance faceting a circle,
two rings interpolating along a chord. A blur has none of them because it never looks at the
geometry, and it softens **every** boundary at one width including the ones nobody enumerated.

##### What it gives up

- **Shape** — the ramp is the kernel's; no plateau control, and a flat region's corners round.
- **Selectivity** — it softens boundaries the model might want hard. A live concern while a region
  boundary following a wall was meant to stay crisp (§6.4.2a); not one since §6.4.3.
- **Tap count** — §7.0 step 5's limitation is real here too, but bites far less: the input is a
  step rather than a stripe, so the taps land on a ramp, and 8 bits leaves ~85 codes between
  adjacent tiers to absorb it.

##### One risk worth naming before it is measured

A filtered container renders its children into a **temporary** texture cleared to transparent black,
not to the container's own clear colour. The `MIN_COLOR` meshes of §7.0 step 6 blend against
whatever is there, and zero in this channel is the brightest value — so a light or a halo drawn
where no opaque ground had been laid first would come out white. §7.0 step 6 already made the ground
cover the scene rect unconditionally, which is what keeps that from biting; outside the scene rect
it is untested.

Kept **alongside** `render/halo.mjs` and switched by `blurTransitions`, so the two can be compared on
one scene. If the blur wins, the halos and most of the per-vertex machinery come out with it.

#### 6.4.5 What the field blur reaches, and the one thing it does not

Two follow-ups from the same play session, both found by Patrick describing *when* the defect
appears rather than what it looks like.

**The reveal boundary — the last hard edge.** *"It doesn't seem to be applying to borders between a
light and dark source when the darkness is overriding the light"*, then *"only has this effect when
the global illumination is brighter than dim"*. The second clause names the mechanism: `darknessFor`
sets `erase` when a region is darker than `globalLightCutoff()`, which **is** the Dim threshold, and
an erasing region gets a second mesh in `canvas.visibility.vision.light.global.meshes` blended
`ERASE`. That container is not the darkness-level texture, so §6.4.4's blur cannot reach it — and it
only *matters* where global light is actually revealing, which is exactly "brighter than Dim".

§6.4.2a called this permanent, and `create()` refused to blur those meshes on the grounds that
"blurring a mesh whose only content is *yes* produces a soft-edged yes, which is not a softer
boundary but a partially transparent one."

**The objection had the sign backwards.** The quantity that mesh carries *is* coverage: it writes
`vec4(1.0)` and composites `ERASE`, so a blurred rim is a partially transparent erase — a *partial
reveal*, which is a gradient in precisely the variable the boundary is made of. It is the one place
in the module where blurring alpha is the correct operation rather than a substitute for a gradient,
which is why it survives §6.4.3's removal of every other filter. Matched to the field blur's width,
because it is the same edge to look at.

**Big lights faceted.** *"With bigger light sources the polygons start to show."* §7.0 step 6's
radial grid subdivides by `radius / RADIAL_STEPS`, so a band's thickness grows with the light — and
between two rings the level interpolates along the **chords** of a polygonalised circle rather than
along its radius, turning the iso-level contours into a polygon whose facets widen with the light.
The same two-ring failure §6.4.3 hit on halos, scaled by radius.

With the field blur on it does not need fixing, it needs deleting: a light is drawn as **two flat
zones** and the blur finds both boundaries. Flat regions have no interior interpolation, so there is
nothing to facet, and the inner circle is generated at a density we choose rather than inherited
from a wall sweep that was subdivided to answer a different question. The radial grid stays for the
`blurTransitions: false` path.

That is the shape of the whole §6.4.4 bet: **every producer gets simpler, not just cheaper.** If the
blur holds up, the per-vertex ramp machinery has one consumer left — §3.4's spill bands — and
probably none.

#### 6.4.6 Withholding a light is not the same as clamping it — BUILT AND PLAY-TESTED, 2026-08-27

The last hard edge, and it was §7.0 step 6's own. Found by bisection rather than by reasoning:
`render.transect()` showed the brightness field ramping smoothly across the boundary
(`biggestStep: 0.134` over ~60 screen px), which proved the line belonged to a layer the texture
does not contain; `render.isolate("lights")` then named it in one call.

`withheld()` set a light's zones to `{inner: base, band: base, base}` — which reads as *this light
is no brighter than its ground* and is not that statement. §6.2.9's absolute path answers it by
setting `computeIllumination = false` and handing the shader three **constant** colours, so the
mesh painted `tierColor(base)` flat across the light's entire footprint.

The ground under a light is not flat. A *darkness* overlapping it is Dark in the texture,
illumination composites `MAX_COLOR`, and a constant at the ambient level beats a dark one — so the
light was **re-lighting the region the model had just darkened**, cut off hard at its clip
boundary. That boundary is precisely where the line was, which is also why a *daylight* light
rendered perfectly: it cancels the darkness outright, so there is no clip and no edge.

Leaving `tiers` unset keeps `computeIllumination = true`, so `computedBackgroundColor` is sampled
**per fragment** from the texture. `getCorrectedColor(UNLIT)` returns that same per-fragment value
for all three zones and `FRAGMENT_END` mixes it with itself: the mesh paints exactly what the
texture already said, everywhere, and contributes nothing at any brightness.

> **The general shape of this one is worth keeping.** "Contributes nothing" and "contributes a
> constant equal to the ambient" are the same sentence and different shaders, and they diverge
> exactly where the ambient is not constant — which is everywhere this module is interesting. Any
> future *withhold* should be spelled as a per-fragment identity, never as a value.

##### On the two instruments this took

Neither `transect` nor `isolate` existed at the start of the session, and the three rounds before
them were spent guessing at edges from screenshots. They are cheap, they are permanent, and the
division between them is the useful part: `transect` answers *is the field smooth here*, and only
when the answer is yes is `isolate` the right next question. Reach for them in that order.

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

> **Corrected 2026-08-24 — that sentence is true of the *container* and false of a *child
> mesh*.** Core's own `AdjustDarknessLevelRegionBehaviorType` blurs its darkness mesh, at
> `adjust-darkness-level.mjs:70-73`:
>
> ```js
> if ( canvas.performance.mode > CONST.CANVAS_PERFORMANCE_MODES.LOW ) {
>   dlMesh._blurFilter = canvas.createBlurFilter(8, 2);
>   dlMesh.filters = [dlMesh._blurFilter];
> }
> ```
>
> A filtered *child* renders through its own filter into the container in the ordinary way,
> before the container is ever cached — the `CachedContainer` redirect above governs filters
> **on** the cached container, not inside it. `render/darkness-texture.mjs` builds meshes of the
> same class into the same container, so the identical two lines apply to `entry.dl`.
>
> Not a discovery so much as a distinction we never drew: the comment in `create()` already
> named core's blur and declined it, but declined it **for suppressor meshes**, on §6.2's
> grounds that a suppressor edge is the one thing the model asserts a step in. It was never
> weighed for the `ambient`/`dark` ground fills, where the argument does not apply and the cost
> is a fixed per-mesh filter rather than the per-frame geometry that killed the version above.

#### 6.4.2a The blur route — built 2026-08-24

Setting `groundSoftness`, **default 0.1, on** (Patrick, 2026-08-24, after seeing it at 0.2), in
`render/soften.mjs`; the filter itself in `render/darkness-texture.mjs` (`syncFilter`,
`refreshFilters`, `dropFilter`).

The default is small on purpose and the number is the argument: at 0.1 of a square the filter
removes the aliased staircase along a region boundary and leaves the boundary itself legible.
Wider reads as a *gradient*, which is the wrong claim — §6.1 has the model asserting a step
across that line, and a soft ramp says the brightness is continuous there when it is not. This
is anti-aliasing that happens to be adjustable, not a falloff.

Why it should look right, and it is worth stating in advance because the mechanism is
indirect. `invalidateDarknessLevelContainer` sorts the container by darkness level
**descending** (`illumination-effects.mjs:106-110`), so the darkest mesh draws first and the
brightest draws last, on top. A blur fades a mesh's **alpha** at its rim, so the topmost
(brightest) mesh stops fully covering its own boundary and the darker mesh beneath shows
through progressively. The gradient is between the two real levels, not toward an arbitrary
colour, and it needs no interpolation code because the compositor is doing the interpolation.
The container is cleared to `canvas.environment.darknessLevel`, so a region with nothing
beneath it fades toward the scene's own value.

Four things it is deliberately **not**:

- **Not on `entry.il`.** That mesh answers the *binary* reveal question by being in or out of
  the global light's band and writes `vec4(1.0)` without reading a level. Blurring it produces
  a partially transparent *yes*, not a softer boundary. The reveal edge stays hard, which is
  the subject of `eraseDisabled` and a separate question.
- **Not zeroed when off — detached.** A `BlurFilter` at strength 0 still costs a filter texture
  and two blits per mesh per container render. `filters = null` costs nothing.
- **Not in screen pixels.** `Canvas#addBlurFilter` keeps `_configuredStrength` and multiplies by
  `stage.scale.x`, re-applying on zoom (`board.mjs:1657`, `:1670`), so the setting is a distance
  on the map. Authored in grid squares for the reason the 2026-08-23 attempt needed: 16 raw
  pixels on a 100px grid is 0.8 ft, which is indistinguishable from a mechanism that does not
  work.
- **Not per frame.** `DarknessLevelContainer` is a `CachedContainer` with `autoRender` following
  its child count; a filtered child costs its pass when the container re-renders. That is the
  whole difference from the retired version, which rebuilt 41 cells into 166 meshes and 38k
  triangles on every repaint.

#### The halo, and why cells must merge by level — 2026-08-24

First play test produced bright rings around every darkness disc that sat inside an umbra, on
otherwise uniformly dark ground. Patrick asked whether the softening could be suppressed inside
an umbra. It could, and it would have treated a symptom: the umbra is where the artefact is
*visible*, not where it comes from.

**A feather cannot brighten a boundary between two equal values.** Both sides of those rings
were Dark, so whatever was showing through had to be arriving from underneath — and underneath
a `CachedContainer` is its clear colour, `canvas.environment.darknessLevel`, which on a lit map
is far brighter than either neighbour.

How two same-level meshes come to share a boundary is ordinary rather than exotic. §6.1 has the
cells partitioning the scene by **treatment**, not by brightness, and `applyShadows` skips any
cell already at or below the clamp — so inside a shadow a *darkness* disc stays its own `dark`
cell while the ambient around it is cut down to the same Dark. Two meshes, one brightness, an
exact shared edge. Opaque, that is invisible. Blurred, both rims fade, neither covers the seam,
and the clear shows through it.

So `paint()` now unions cells by resolved level before assigning meshes (`mergeByLevel`). The
boundary is removed rather than papered over, which is also the more honest geometry — a region
at one brightness is one region, and the split was an artefact of how the field reached the
answer. **Level, not tier:** Dark and Supernatural Dark share a level deliberately and are told
apart by the darkness source's overlay, so merging them here loses nothing, and `erase` derives
from the level too. Cost is one Clipper union per distinct level, at most five and usually one
or two, with single-cell groups skipping Clipper entirely.

`render.texture()` reports `merged` — cells the union collapsed. Above zero inside an umbra is
the expected state.

**The residual case — fixed the same day with a backstop.** Two *different* levels that are both
darker than the clear still leave a seam showing the clear between them: a Dim region abutting a
Dark one on a Normal-lit map. Merging cannot help, because they really are different
brightnesses.

`backstopFor` adds a scene-rect region at `max(level)`. Sorting is descending by level, so it
draws first, sits under everything, and is covered by every other mesh's opaque interior — the
only thing that changes is what a seam reveals: the darkest level present rather than the
scene's own. That biases every soft boundary slightly dark, which is the right direction, since
one side of any such boundary *is* the darker value and the seam then reads as part of the
feather rather than as a line of its own.

Three properties make it safe, and each of them is a thing that would otherwise break something:

- **Never `erase`.** The illumination half of a mesh pair cuts global light out of a region; a
  scene-wide one would cut it out of the map. The backstop makes no claim about revelation.
- **Never a claimant.** Its `rings` are empty, so `region.document.testPoint` answers false and
  `canvas.effects.getDarknessLevel` never returns its level. Core walks the children backwards
  and returns the first that claims the point (`effects.mjs:391-396`), so the backstop would
  only ever be reached where no cell covers the point at all — and there the honest answer is
  the scene's own darkness, which is exactly what the clear colour already gives.
- **Never blurred, and never present without a reason.** It is what every other mesh's rim fades
  *into*, so blurring it would fade its own edge at the scene rim and cost a full-scene filter
  pass to soften something nothing abuts. It is omitted entirely when the blur is off or when
  one level covers the scene.

`render.texture()` reports `backstopped`.

Open questions for the first play test, in the order they would show up:

1. **Does the filter reach the texture at all?** The container's render texture is
   `PIXI.FORMATS.RED` with `multisample: NONE`, and PIXI's filter system allocates its
   intermediates from its own pool. If the blit into a red-only target misbehaves, the symptom
   is the region vanishing or going flat rather than softening. `render.texture()` reports
   `blurred`, `blurStrength` and `stageScale` so a no-op can be told from a miss.
2. **The ambient mesh is scene-sized**, so its filter pass allocates a scene-rect texture. Core
   only ever does this for region behaviours, which are small. If cost bites, it bites here.
3. **A soft vignette at the scene rim**, where the ambient mesh fades into the clear colour with
   nothing beneath it. Cosmetic, and only visible past the scene rect.

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

- **A wrapper's `finally` is not "the end of the method" if the method publishes mid-call.**
  Cost fog of war entirely, 2026-08-24. `umbra-mask.mjs` swapped each vision source's `light`
  polygon for an empty one, let core run, and drew the trimmed contribution into
  `vision.light.mask` afterwards. But `refreshVisibility` ends with
  `if ( commitFog ) canvas.fog.commit()`, and the commit renders the whole `vision` container
  — masked by that same graphics object (`perception/fog.mjs:330-355`). So the exploration
  texture was snapshotted before our contribution existed.

  The mask is a persistent `LegacyGraphics`, so **the screen was correct from the next frame
  onward and only fog was wrong**, which is why it survived every visual check. Symptoms all
  followed from what was in the mask at commit time: light perception contributed nothing, and
  `vision.sight` — a sibling of `vision.light`, and so not masked — was all fog ever saw. A
  token with no darkvision has `radius === 0`, draws no sight FOV, and explored nothing at all;
  a darkvision token explored its darkvision radius and no further.

  Note what did *not* fail: `commitFog` is set from
  `lightRadius > 0 && !blinded && !isPreview`, never from the polygon's contents, so an empty
  shape still schedules the commit. Fog kept updating — just with less in it. A frozen fog
  texture would have been a far louder failure.

  Fix is core's own seam: `Hooks.callAll("visibilityRefresh", this)` fires immediately before
  the `endFill`s and the commit (`groups/visibility.mjs:588-606`), which is the only window in
  which a contribution to that mask is both inside the fill and visible to fog. **General rule:
  before deferring a write past a wrapped call, find out whether anything reads it *during*
  the call.**
- **A darkness sweep asks each wall for a restriction that does not exist.** Core, not us, but
  this module is what makes it visible. `_testEdgeInclusion` decides whether an edge blocks by
  indexing it with the polygon's own type — `edge[type] === WALL_SENSE_TYPES.NONE`
  (`clockwise-sweep.mjs:244`) — which works for the four `WALL_RESTRICTION_TYPES` that `Edge`
  carries a property for. **`darkness` is not one of them**; it is a *source* type. So
  `edge.darkness` is `undefined`, never equals `NONE`, and every edge blocks every darkness
  source regardless of what the wall allows.

  The **open door** is what makes it unambiguous rather than a matter of taste: `Wall#createEdge`
  zeroes all four restrictions on an open door (`placeables/wall.mjs:225`) and leaves the edge in
  place, blocking nothing. A darkness sweep asks for a fifth restriction that was never zeroed
  because it never existed, and stops at the doorway. `applyThreshold` has the same shape one
  level down (`edges/edge.mjs:213-215`), so proximity and attenuation walls never applied to
  darkness either.

  `clip.patchDarknessWalls` swaps `config.type` to `"light"` around core's own method — after
  `edgeTypes` has been computed from `"darkness"`, which is the part that must not change, since
  that is what makes a darkness sweep respect `light`-type edges at `priority + 1`. Fixes the
  threshold half for free, which a `darkness` accessor on `Edge.prototype` could not have —
  `threshold` is a plain per-instance object. **General shape: one string used as two kinds of
  name, and the type system that would have caught it is absent.** Reported 2026-08-26.
- **Clearing a clip is not hiding a source — it is the opposite.** `clip.assign(source, null)`
  means *unclipped*, so the renderer's "this emitter has no cells, it must be fully suppressed"
  branch was making such a light render its **full circle**. Latent since the branch was
  written, and §3.3.1 would have made it fire constantly. Both halves are needed: clear the clip
  so no stale polygon lingers, then `setHidden` so the mesh is withheld — and set `setHidden`
  *false* on the path that does draw, or a source put out once stays dark for the session.
- **A clone must carry every uniform that shapes the original's curve.** Three were missing from
  the `clip` clones — `level`, `bandLevel` and `attenuation` — and each showed as its own
  artefact: the first two made a cloned piece paint at Foundry's stock lighting levels instead
  of §3.2.1's corrected ones, so it read a rung brighter; the third gave it a different falloff
  function, so the pieces did not meet and the cut showed as a seam. Reported 2026-08-25 as a
  light with a darkness inside it. The `stack` clones below already passed all three, with a
  comment explaining why — the reasoning was written down and never carried back.
- **A pooled source that is "not drawn" is not a no-op — for a darkness it is a black disc.**
  Third instance of the same pooling bug, 2026-08-25, and the one that finally names the rule.
  `pool.fill` assigned `animation` and (after 2026-08-23) `HARD_EDGES` on every fill, but never
  `HIDDEN` — and `HIDDEN` is *the only thing that stops a darkness source drawing*, since
  neither strength nor alpha does (§6.2.3). The renderer hid the real source of a split `dark`
  cell and then cloned the remaining pieces without hiding them, so every piece but the largest
  rendered at full darkness.

  It surfaced as *"a darkness enclosing another darkness goes black below the inner one"*: an
  enclosed darkness makes the outer cell an **annulus**, an annulus is always split (§6.2.1),
  and `splitAnnuli` cuts horizontally through the hole's centre — which is exactly where the
  straight edge in Patrick's screenshot was. Any nesting reproduced it; nothing else did.

  Fixed at both ends: `pool.fill` takes and always assigns `hidden`, and the renderer decides
  the plan *before* filling and skips the clone entirely when nothing would be drawn — which is
  almost always, since only Supernatural Dark and a GM-chosen animation draw at all.

  **Every per-source property a pooled fill can carry must be assigned on every fill.** A
  default of "leave whatever the last tenant set" is never right, and this is the third flag to
  prove it.
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

**Proposed 2026-08-23; steps 1–4 built the same day** — see the *As built* subsections below,
and note that this section stays in §7 because §7.1 and §7.2, which depend on it, do not. §7.1
below assumed this "falls out of §4.3 making global illumination clippable". §4.3 shipped without
it — umbra went via sweeps and edges instead — so it became its own work item, and it was the one
blocking three separate visible defects:

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

> **The same gap shows up as *colour*, and that is the form it gets reported in** — Patrick,
> 2026-08-25: *"darkvision and see in darkness show light sources within a dark umbra in colour
> instead of black and white."*
>
> Not a second bug, and not the §6.2.5 desaturation wrap failing. Darkvision desaturates through
> `visionMode.canvas.uniforms.saturation = -1` (`config.mjs:989-992`), which is a
> `ColorAdjustmentsSamplerShader` on the **primary sprite** — the terrain. Its
> `vision.defaults.saturation` reaches the *vision source's own* layers. Neither touches an
> ambient light source's illumination or coloration layers, and that is correct core behaviour:
> where there is real light, you see real colour, because darkvision is what you fall back on
> when there is not.
>
> So inside a Dark-clamped umbra a darkvision observer gets grey terrain (the texture wrote the
> tier, the vision shader greyed it) with a fully coloured torch on top of it — because the
> torch is still being *drawn* there. `vision.sight` is not gated by `light.mask`, so the region
> is revealed, and the illumination layer is masked by the whole vision texture rather than by
> the light half of it.
>
> The fix is the same fix: the light must not be drawn there **for that observer**, which is
> per-observer clipping. Nothing cheaper reaches it — the desaturation wrap cannot, because there
> is no darkness *source* in an umbra to wrap, only a texture region. Worth stating plainly
> because "the umbra is grey but the torch in it is not" reads like a shader bug and is a
> geometry one.

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
whole canvas** (`primary.mjs:192-205`). So regional colour is never the map image: it is the
**coloration layer** compositing a light's tint on top of an already-grey map. Ambient-lit umbra
reads correctly grey, because
global light is discarded there by `globalLightThresholds`; torch-lit umbra comes back in colour,
because nothing removes a *placed* light from an umbra.

> **A sentence has been struck from the paragraph above — 2026-08-27.** It read *"It physically
> cannot be grey in one place and coloured in another."* That was true of the code as it stood and
> false as a general claim, and §6.5 is built on the difference: the per-pixel path is written into
> `ColorAdjustmentsSamplerShader` (`color-adjustments.mjs:61-64`) and gated behind
> `vision.darkness.adaptive`, which core's darkvision sets to `false`. Everything else this entry
> concludes is unaffected — the diagnosis was correct and the umbra gap it names is still open.
>
> Recorded rather than quietly deleted because the striking is the useful part: *"physically
> cannot"* was reached by reading one call site that a flag was routing around. The measurements
> in this entry were right; only the impossibility was invented.

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

#### Step 5 — the gradient mesh — BUILT AND PLAY-TESTED, 2026-08-27

**Status: built, not yet play-tested.** Written first, because the geometry rule is the part that
is obvious until there is a hole in the ring; the sections below are as designed, and *Built* at
the end records the three places the implementation went somewhere the design had not.

##### Why

The texture takeover made the ground's brightness a **field**, and everything since has drawn that
field as *flat regions plus a blur*. Three separate attempts to make a spill falloff read as a
gradient all failed against the same wall, and the wall is the representation rather than any of
the attempts:

- **Widening the blur** spread each step further and added none. §6.4.2a's mechanism is one mesh's
  rim fading to reveal *the mesh beneath*; there is nothing beneath a stripe but the next stripe.
- **Sub-rings** worked and were declined on looks (§3.4) — a linear ramp across a whole band
  leaves no plateau, so it reads as a smear.
- **The blur's tap count** was the visible banding: `PIXI.BlurFilter` spreads a fixed number of
  taps across its width, so a wide blur samples five points eleven pixels apart.

A blur is an approximation of a gradient by a filter. The rasteriser can just draw one.

##### The mechanism

`AdjustDarknessLevelRegionShader` writes a **constant** — the level is a uniform, so one mesh can
express exactly one brightness. That single fact is why the field has to be chopped into flat
pieces at all. Replace it with a shader carrying the level as a **per-vertex attribute** and the
GPU interpolates it barycentrically across every triangle, for free, at no extra pass.

The consequence that matters is not smoothness, it is **mesh count**: once the level is per-vertex
rather than per-mesh, an entire spill falloff is *one* mesh with one draw and no filter. The
current picture is 69 meshes with 55 filtered render passes.

##### The geometry rule

Rings are kept as **tessellation** and dropped as **levels**. That distinction is the whole design.

1. Generate rings as §3.4 already does — `(white ⊕ t) ∩ domain` at a fine spacing, `d/4` or so.
   These exist only to give the triangulator small, thin polygons; they carry no tier.
2. Triangulate each ring with `earcut`, exactly as `setGeometry` does today.
3. Give every vertex a level from its **distance to `white`**, mapped through the tier ladder —
   not from which ring it came out of.
4. Concatenate every ring's triangles into **one** geometry with one `aLevel` attribute buffer.

Point 3 is the load-bearing one, and it is what makes the rule survive the case that breaks the
obvious version. Assigning a level per *ring boundary* — inner vertices get A, outer get B — works
only while a ring is a clean annulus whose two boundaries are separable by vertex index. A ring
clipped by a wall is not: Clipper returns one snaking ring in which a wall cut runs *across* the
band, joining inner boundary to outer, and there is no index range that identifies either. Distance
to `white` is defined for every vertex however the ring was cut, so the wall-cut edge interpolates
along its own length, which is also the correct answer.

Thin rings are what keep step 3 accurate. Linear interpolation across a triangle approximates the
distance field, and the approximation is good exactly when triangles are narrow relative to how
fast the field changes — which is what a `d/4` ring guarantees and what a single fat polygon
triangulated from its boundary would not.

##### What stays flat

Ordinary ground cells keep the constant-writing mesh. A region boundary follows a wall and is a
genuine step (§6.4.2a, §10.7), a darkness rim wants a soft edge rather than a ramp, and both are
already correct. The two mesh kinds sit in the same container, so this is contained and
reversible: gradient meshes are an addition, not a replacement.

##### Consequences, including one to accept

- **`canvas.effects.getDarknessLevel(point)` becomes approximate over a gradient mesh.** Core walks
  the container's children backwards and reads `shader.uniforms.darknessLevel` off the first mesh
  claiming the point (`effects.mjs:391-396`), and a gradient mesh has no single level to report.
  Harmless for this module — `evaluate()` is the authority and never reads the texture — but any
  other consumer sampling that API inside a spill band gets the band's nominal tier. Report the
  ladder's midpoint and note it; do not try to fake it.
- **The blur comes off spill entirely**, and with it `spillSoftness`, `spillBlurQuality` and
  `spillBlurKernel`. They exist to approximate this.
- **8-bit RED is not a limit here.** The texture quantises to 1/255; the current banding is five
  taps, not 255 levels.
- **Light sources are untouched.** Colour, flicker and attenuation stay Foundry's, per
  *clipped, not replaced*. This owns the ground, which is the half that has been rendering wrong.

##### Cost

One triangulation per ring at rebuild, which is already paid; one attribute buffer; one draw.
Against 55 filtered render passes and their texture allocations, this is a net reduction. The
per-frame cost is a `CachedContainer` re-render of one more mesh, which is not measurable.

##### Built — 2026-08-27

The three plumbing risks the design named all came out clean, and the answers are worth keeping
because each one was a real fork:

- **The container's sort accepts it.** `invalidateDarknessLevelContainer` reads
  `shader.darknessLevel` (`illumination-effects.mjs:106-110`), which on core's shader is a *getter*
  derived from `mode`/`modifier` — so a subclass simply answers it. The fallback of one gradient
  mesh per tier is not needed.
- **`RegionMesh` carries a custom attribute buffer.** `_render` hands the geometry straight to
  `renderer.geometry.bind(geometry, shader)` (`regions/mesh.mjs:180-182`), and PIXI matches
  attributes to the program by name. Adding `aLevel` to the geometry and declaring it in the vertex
  program is the whole of it — no plain `PIXI.Mesh`, no second `regionStub`.
- **`RED` was never a constraint.** The format governs what the texture stores, not what a shader
  may compute; the fragment writes `vec4(vLevel, 0, 0, 1)` exactly where core writes the uniform.

Three things went somewhere the design had not, and they are the parts worth reading before
changing anything here.

**Distances are read off the iso-lines, not measured.** The design said "a level from its distance
to `white`" and left the query open; a nearest-point query per vertex is O(V·E) and would have to
re-run whenever the geometry was re-cut. It is not needed. Ring `k` is generated as
`white ⊕ t_k`, and **every vertex of an offset boundary is at exactly `t_k`** — so the offsets
themselves are the distance field, recorded into a `Map` keyed by the *integer* Clipper coordinate
before the domain clip. Clipper works in integers, so the match is exact rather than approximate.
Vertices the domain clip introduces — a wall corner, a crossing where a wall cuts across the band —
are the only unknowns, they are bounded within one ring width by construction, and they are filled
by arc-length interpolation between the nearest known vertices either way around the loop. That is
exact at both ends of a wall-cut edge and monotone along it, which is what stops a wall reading as
a light level of its own.

**The umbra clamp overpaints the gradient rather than cutting it, and that needed a sort ladder.**
This is the design decision the written version did not reach, and it is what makes the whole thing
affordable. `paint.mjs` clamps ground an observer cannot see by *cutting* the shadow into each cell
— the container sorts brightest-last, so a clamp laid over a cell would be erased by it. Cutting a
gradient mesh means re-triangulating it and re-deriving a distance for every new vertex, on every
step a token takes. Instead the gradient is drawn once over its whole extent, pinned to the
**bottom** of the container's sort, and the clamped pieces are painted flat on top of it by the
ordinary path — so the gradient's geometry does not depend on the point of view at all, and a
repaint driven by an observer walking costs two comparisons.

Pinning it needs the sort key detached from the painted value, which core's shader couples. Both
shader classes now live in `render/darkness-shaders.mjs` and both carry a `sortLevel`:

```
  4      the seam backstop        (bottom — scene-wide, so it must sit under the gradient too)
  2‥3    gradient meshes          (brighter spill sorts later and wins where two windows overlap)
  0‥1    ordinary ground cells    (top — a real darkness level, and ≤ 1 by AlphaField)
```

`darkness-texture.paint` therefore skips exactly the spill cells that were **not** clamped;
`paint.applyShadows` stamps `clamped` on the pieces it took down so that distinction survives.

**Two windows lighting one floor now resolve by draw order rather than by `max`.** The model is
unchanged — the bands are still `AT_LEAST` areas and `evaluate()` still folds them with `max` — but
where two gradient meshes overlap, the one whose *wedge* is brighter is drawn last and wins
outright, rather than the brighter value winning per point. The error is bounded by one window's
ladder and only appears where one window's tail crosses another's head. Left as it is: a
per-fragment `max` would mean a `MIN` blend equation the container does not offer, and the honest
alternative is clipping the two ramps against each other, which reintroduces exactly the
re-triangulation the overpainting scheme exists to avoid.

##### What came off

`spillSoftness`, `spillBlurQuality` and `spillBlurKernel` are gone, and so is `spill` as a merge
key in `darkness-texture.mergeByLevel` — all four existed to approximate this. One setting replaces
them: **`spillPlateau`**, how much of each band holds a steady level before the next transition
begins. Zero is a continuous ramp with no tiers visible in it, which is what the retired sub-ring
experiment amounted to and why it was declined; one is the original hard-stepped ladder. It changes
the ramp itself rather than a filter over it, so unlike everything it replaces it genuinely adds
intermediate values instead of spreading the same few further apart.

#### Step 6 — lights in the map — BUILT AND PLAY-TESTED, 2026-08-27

Patrick, 2026-08-27, after §6.2.9 pinned a light's zone *colours* and it still was not right:
*"generate a map of all the brightness levels in the scene, then paint on the brightness based on
those regions in one go — fixed alphas, and paint everything covered by blocked vision the same
brightness. The entire scene rendered in one of a handful of set brightnesses with gradients
between them."*

##### Why §6.2.9 could not have been enough

The brightness a light renders at is not decided by its zone colours. It is decided one line
further down (`base-lighting.mjs:347`, `illumination-lighting.mjs:13`):

```glsl
if ( attenuation != 0.0 ) depth *= smoothstep(1.0, 1.0 - attenuation, dist);
gl_FragColor = vec4(mix(computedBackgroundColor, finalColor, depth), 1.0);
```

with `SWITCH_COLOR` blending the two zones across 72% of the ratio on top of that. **A Foundry
light is a radial falloff by construction.** Its nominal level exists only at the very centre;
everything else is an interpolation toward the background. So "each level has a fixed brightness"
is not a property a rendered light source can have, however exactly its endpoints are pinned.

The model has always known the answer — a light has two zones, each at a tier. Step 6 draws that,
in the one place the module already expresses brightness as a number.

##### Three passes, and the blend equations are the design

The obstacle §7.0 and §4.3 both worked around was that the darkness-level container resolves
overlap by **sort order**, so anything composited had to be cut in instead. That was true of the
default blend mode and is not true in general: Foundry registers `MAX_COLOR` and `MIN_COLOR` into
`PIXI.BLEND_MODES` at startup (`board.mjs:721-722`), and the channel in question holds a *darkness*
level. So

| Pass | Blend | Means | Draws |
| --- | --- | --- | --- |
| ground | normal | a partition, so no overlap to resolve | `ambient` and `dark` cells, plus §3.4 spill |
| lights | `MIN_COLOR` | **brightest wins**, per fragment | one mesh per light-bearing cell |
| clamps | `MAX_COLOR` | **darkest wins**, per fragment | umbra and unseen ground |

`MIN` is §3.2.1's combine rule for lights, exactly, taken from the blend equation instead of from
draw order — which is what lets two torches overlap without one's tail erasing the other's core.
`MAX` is §4.3's clamp, exactly: *nothing between two points can make the far one brighter*. Order
between the three comes from the sort ladder in `render/darkness-shaders.mjs`.

**The clamp pass is not optional and it is why the order is that way round.** This texture is
deliberately *not* vision-masked (§6.2.7) — that is what lets true seeing and god's eye read real
light levels. Moving a torch's brightness into it therefore makes the torch shine through walls,
which is §4.3.1's bug arriving by a new route. Clamping after the lights removes the possibility
rather than the instance.

##### The geometry is arithmetic

A `ClockwiseSweepPolygon` is star-shaped about its own origin — §3.4 already leans on this. So
scaling every boundary vertex toward the origin stays inside, consecutive rings share an index, and
each band is a quad strip: no Clipper, no triangulator. And the level per vertex is **analytic**,
`levelAtRadius(|v − origin|)`, which is the whole difference from §3.4's ramp. Spill has to recover
distance-to-a-polygon from the iso-lines that produced it; a light's distance field is a closed
form, so any vertex can be asked directly however it was produced.

That last point is what makes the clipped case cheap too. A light with a *darkness* bitten out of
it is no longer star-shaped and the strip has to be intersected with the cell — but the levels
still come from the same closed form. `cell.clipped` selects the path and is false for nearly every
light.

Rebuilds are cached per source on `shape` **identity** (`_createShapes` replaces rather than
mutates, the same trick `field.currentSignature` uses), so an observer walking past a torch does
not rebuild the torch.

##### What the light source still does

Colour, animation, and revealing. Only the *illumination* contribution is withheld, and not by
hiding or patching anything: the zones are set equal to the ground the light stands on, which is
§6.2.9's `UNLIT` case — all three colours equal, `FRAGMENT_END` mixes toward the background, the
mesh paints exactly what the texture already said. The coloration layer is a separate mesh with its
own shader and is untouched. `canvas.visibility` reads a light's **polygon**, not its illumination
mesh, so what a creature can see by is unchanged.

##### Two things this does not do

**`applyShadows` is deliberately still running.** It cuts the same clamp into the ground cells, so
on ground the clamp pass is redundant — `max(Dark, Dark)` — and the two agree by construction
because they read the same regions. Keeping both is what makes step 6 additive: §4.3.1 was hard
won, and removing the cut in the same change that introduced the composite would leave no way to
tell which of them a regression belonged to. The cut should come out once this is proven; it is
most of what a token drag costs.

**Blocked vision is still two brightnesses, not one.** The texture is clamped to Dark, and then
Foundry's fog-of-war overlay composites on top — 50% black where explored, solid black where not.
Left alone on purpose: that overlay is how a player tells *cannot see now* from *never been there*,
and the light model has no business removing it.

##### One thing it fixed on the way

The ground is now painted even on a fully dark scene. It used to be skipped at `ambientB === 0` and
the container's clear colour stood in — invisible only because that clear is the scene's own
darkness and the default table puts Dark at 1.0 as well. `MIN_COLOR` needs an opaque base to blend
down from, and any retuned table would have made a *darkness* spell render lighter than the night
around it.

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

> **Demoted 2026-08-26 — aperture emitters are no longer a dependency of anything.** Two things
> overtook this section. §10.7 shipped the interior half as a position-dependent ambient *tier*
> rather than as a subtracted sky-fill emitter, so there is no clippable global emitter and no
> boundary to synthesise apertures from; and §3.4 now gets its occlusion from a single 360°
> visibility sweep, so it never needed the aperture sweep this section promised it.
>
> What is left here is the **multi-sampled** window of §7.2 — a real area light with a widening
> penumbra, rather than one sweep from a point. That is a refinement of §3.4's picture, not a
> prerequisite for it, and §3.4's single-sample limitation is named in place.

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
7. **Light spill** — §3.4, rewritten 2026-08-26 and **no longer bundled with §7.1/§7.2**. It
   turned out to need nothing from apertures: the occlusion clip is one 360° sweep, and the
   interiors half already shipped as §10.7. Lands as `model/spill.mjs` plus a settings submenu,
   with `model/areas.mjs` growing one branch in each of `areas()`, `pathsFor()` and `covers()`
   so the spill areas fold through `ambientTierAt` beside the drawn ones. `field.mjs` is
   untouched.

   **Spill folds after regions.** `ambientDomains` applies areas in list order, and the two
   modes do not commute: a Bright spill into a room clamped Dark is
   `max(min(Bright, Dark), Bright)` = Bright only if the `AT_LEAST` runs second. Reversed, the
   clamp eats the spill and the feature silently does nothing.

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

Planned 2026-08-23, after umbra painting cleared; revised 2026-08-24 against Patrick's own
list of control points, which reordered it substantially. Everything in §3 through §7 is
driven by fields with no way to set them; this section is the plan for the controls. It
supersedes the §3.5 note, which stated the problem and is now the summary of one part of the
answer.

### 10.1 What actually needs a control

Four kinds of input, and they belong in four different places. Sorting them by *what owns the
value* rather than by what they affect is what keeps this from becoming one giant settings
page.

| Input | Owner | Surface |
| --- | --- | --- |
| `kind`, `level`, `cancelsDarkness`, `emitTier`, `steps`, `cap`, `transform`, `floor` | one light document | **§10.3** — a section inside the light's own Basic tab, and a fieldset on the token's Light tab |
| The tier → darkness-level table, and which tier the scene sits at | one scene | **§10.5** — the Lighting tab of scene config |
| Feature switches, thresholds, debug toggles | the world / the client | **§10.6** — a settings menu, replacing eleven flat checkboxes |
| Per-area ambient override, indoor keepouts | a region | **§10.7** — built 2026-08-26, and *not* satisfied by core's behaviour |

**Three fields stay important but stay out of the UI**, decided 2026-08-24. None of them is
vestigial and none is a candidate for removal — the model reads all three, and they remain
authorable through `flags["pf1-lighting"].config` and the console. What they are not is a
*control*, because in each case the value a GM would pick is the value the rule already gives:

- **`eligibility`** — which emitters a suppressor *extinguishes* rather than merely reduces.
  The distinction is real (`contest()` splits emitters into `blocked`, which contribute
  nothing at all, and `passthrough`, which survive to be reduced by the transform), but the
  `darkness` preset already **is** the rule PF1 states: mundane light always goes out, magical
  light of the suppressor's level or lower goes out, anything above it passes through. There
  is no second rule a GM would want. `total` and `none` stay reachable from the console
  because they are how the contest gets isolated when something is wrong; they are debug
  instruments, not settings.
- **`blocksPath`** — casting an umbra follows from being magical, and for a *suppressor*
  "magical" is exactly `level >= 1` (see below). `castsUmbra` already reads
  `level >= 1 && blocksPath !== false`, so the automatic behaviour is the behaviour, and the
  flag is left as a console escape hatch for a magical darkness that is deliberately meant not
  to blind.
- **`kind` on a suppressor** — never read. `breaks()` and the eligibility preset both test
  `emitter.kind`; nothing tests a suppressor's. Level carries the whole distinction, so a
  darkness gets a **level** control whose zero entry is named *Mundane / unlit area* and no
  "is magical" checkbox. Offering one would be offering a control that does nothing.

On the emitter side `kind` and `level` are genuinely separate axes and both need controls: a
mundane light at level 3 is meaningless, but a *magical* light at level 0 is real (*light*,
*continual flame*) and behaves differently from a torch under a level-0 darkness.

### 10.2 The preset table is the actual feature

The field list is not the deliverable. A GM placing a *deeper darkness* should pick "Deeper
Darkness", not set `level: 3`, `transform: {op: "reduce", steps: 2}` and `floor: -2` correctly
and in agreement with each other. Fields that must be mutually consistent to mean anything are
exactly the shape that produced the bug in §3.5's note.

So `model/presets.mjs` — **model, not UI**, because it is PF1's vocabulary rather than a
widget's convenience, and because `field.explain` and `probe` should eventually be able to
report "this is a *Darkness*" instead of reciting four flags.

#### The preset is stored, and the sync is one-way

**Reversed 2026-08-24.** The plan was to store nothing and re-derive the label on every render
by matching the current config against the table, falling back to "Custom". Patrick's rule is
the opposite and it is the better one:

- **Custom is the first option**, and the default.
- **Selecting a preset pre-fills the fields.** That is the whole of what selecting does — it is
  a shortcut for typing, not a mode the light is subsequently in.
- **Changing any governed field flips the select to Custom**, immediately, in the open sheet.
- **It never flips back.** Setting the fields back to a preset's exact values leaves it Custom.
  Only choosing the preset again restores the name.

That last clause is what makes it storage rather than derivation, and it is deliberate: a
one-way sync means the label answers *"where did these numbers come from"*, which is a fact
about history, and history cannot be recovered by looking at the numbers. Matching-on-render
answers *"what do these numbers currently resemble"*, which is a different and less useful
question — it makes a hand-tuned light silently claim to be a torch, and it makes the label
change under a GM who never touched the select.

So `config.preset` is a stored string, written only by the select and by the field-change
handler that clears it to `"custom"`. **Nothing in the model reads it.** It is provenance for
the sheet and, later, a nicer line in `field.explain` — never an input to resolution, so it
cannot go stale in a way that changes what anything renders. `presetOf(config)` is therefore
not a matcher; `applyPreset(name)` is the only direction that exists.

**The table itself was deferred until the controls existed** (Patrick, 2026-08-24): filling in
PF1's radii and step counts before there was a sheet to type them into is guesswork twice over.
`model/presets.mjs` landed with the mechanism, Custom, and enough entries to exercise both
branches — one light, one darkness.

#### The table is data — 2026-08-26

`BUILT_IN` is what ships; `table()` is what everything reads, and it is a world setting the GM
edits through `ui/preset-editor.mjs` (§10.2.1). So the numbers below stopped being
placeholders-pending-Patrick's-own the moment there was somewhere to type them.

**The setting stores the whole table, not a diff against the built-ins**, and it is empty until
the editor is saved. Both halves matter:

- *Empty until saved* means a world that never opens the editor tracks the module's built-ins as
  they change, and *Restore defaults* puts a world back into that state rather than writing the
  current defaults out as a snapshot.
- *Whole table, not a diff* means that once a world does edit, it owns the lot. A diff would
  merge a later change to *Deeper darkness*'s floor into an entry a GM had already retuned,
  producing a preset with no author. Overriding one field and inheriting the rest reads as
  convenient and behaves as unpredictable — the same argument this section already makes against
  a preset matcher.

The table is validated on the way **out** rather than on the way in, because the stored value is
a plain object a macro or a botched merge can reach as easily as the editor can. A malformed
entry has to cost a missing row in a select, never a light sheet that fails to render.

| Preset | Kind | Level | Sets | Raises | Cap |
| --- | --- | --- | --- | --- | --- |
| Candle | mundane | 0 | — | +1 to 5 ft | Normal |
| Torch | mundane | 0 | Normal to 20 ft | +1 to 40 ft | Normal |
| Lamp, common | mundane | 0 | Normal to 15 ft | +1 to 30 ft | Normal |
| Lantern, bullseye | mundane | 0 | Normal to 60 ft | +1 to 120 ft | Normal |
| Lantern, hooded | mundane | 0 | Normal to 30 ft | +1 to 60 ft | Normal |
| Sunrod | mundane | 0 | Normal to 30 ft | +1 to 60 ft | Normal |
| *Continual flame* | magical | 2 | Normal to 20 ft | +1 to 40 ft | Normal |
| *Light* | magical | 0 | Normal to 20 ft | +1 to 40 ft | Normal |
| *Daylight* | magical | 3 | Bright to 60 ft | +1 to 120 ft | Bright, `cancelsDarkness` |
| *Darkness* | magical | 2 | 20 ft, `reduce 1` | | floor Dark |
| *Deeper darkness* | magical | 3 | 60 ft, `reduce 2` | | floor Supernatural Dark |

**Patrick's numbers, 2026-08-26**, replacing the placeholders. Three of them are worth having
written down rather than merely tabulated:

- **The candle has no inner zone at all** — `bright: 0` — because it sets no light level, it only
  raises whatever is there, so the whole of a candle is its one-step band. `emitTier` therefore
  never applies (`contributionAt` reaches the inner zone only at the origin point itself,
  `ramp.mjs:86`) and is set to match the cap regardless: `normaliseEmission` floors `cap` at
  `tier` (`ramp.mjs:66`), so the two disagreeing would silently raise the ceiling.
- ***Continual flame* split from *light***. They shared one entry labelled "Light / continual
  flame" at level 0, which was wrong in the only way that matters: `level` is what §4.1's contest
  weighs against a darkness, so a *continual flame* was losing to a *darkness* it out-levels.
- **The bullseye lantern's cone is not expressed.** PF1 lights a 60-foot *cone*; the preset
  writes radii only. `applyPreset` copies whatever `light` holds, so `angle` would work with no
  code change — and that is exactly why it is left out. An angle on one preset and not the others
  leaves a light re-presetted from bullseye to torch stuck in a cone. Either every preset carries
  one or none does, and what number a "cone" is worth is a table decision, not a module one.

**The *Unlit area* preset is gone**, dropped with the placeholder table. It was the only entry
exercising the `clamp` branch, so nothing in the shipped table reaches *Set level to* — the
control is still there and the editor still authors it. Its use case is better served by §10.7's
region anyway, which takes an arbitrary shape rather than a disc.

`DEFAULT_SUPPRESSOR` is *Darkness* and `DEFAULT_EMITTER` is a mundane light, so the two most
common cases are already what an unconfigured document does — the presets name the existing
defaults rather than replacing them.

### 10.2.1 The preset editor — built 2026-08-26

A `registerMenu` sub-window off the settings, `ui/preset-editor.mjs`. Four decisions in it.

**One preset at a time, not all of them at once.** A preset has two mutually exclusive halves, so
rendering every entry down one page means rendering both halves of each — twelve fields per row,
most inapplicable. The window edits one preset, chosen from a select, with the same branch
switching and the *same labels* the light sheet uses. Deliberately the same: the editor and the
sheet must not develop two vocabularies for one model.

**What is edited is a working copy.** Nothing reaches the setting until *Save*. Switching between
presets harvests the visible pane into that copy first, so a half-finished edit survives a look
at another entry, and closing without saving discards the lot. Both are what a GM assumes without
being told; the cost is one field of state.

**The key is identity and the label is not.** A document records where its numbers came from, so
renaming keeps the key and the documents stay attached. Deleting leaves those documents holding a
dead key, which reports as Custom and changes nothing — because nothing in the model reads
`preset` at all. `newKey` therefore runs once, at creation, and never on edit.

**Editing a preset does not reach back into lights already placed from it.** That is the one-way
sync seen from the far side: `applyPreset` writes values at the moment it is chosen and nothing
re-reads the table afterwards. The window says so in a hint rather than leaving it to be found.

Two implementation notes:

- **Built by hand, not through `HandlebarsApplicationMixin`.** The module has no `templates/`
  directory and this would be the only thing in it — half of one window's markup in a second
  file and a second language, for a list and a form. §10.6's settings menu is where that trade
  changes.
- **The change listener is a stable bound field, removed before it is added.** `_onRender` fires
  on every render and `this.element` survives them — only the content inside is replaced — so an
  anonymous handler stacks one copy per render, each of which harvests and re-renders. That is
  the shape of bug that reads as the window getting slower the longer it is open.

`FormDataExtended` is not used: `negative` is a select of two words, a darkness's radius is one
field standing for two, and `transform` is a nested object whose shape depends on another
control. Building the entry is exactly the work `#harvest` already does on every change. It also
applies the two consistency rules the sheet applies — `cancelsDarkness && magical` for
`contest.mjs:235`'s sake, and *clamp target is the floor* for §10.4's — so a preset **cannot be
authored inconsistent** in the first place.

### 10.3 Where the controls go — inside the Basic tab, not beside it

**Reversed 2026-08-24.** The plan was a fourth tab on `AmbientLightConfig`. Patrick's
objection is the right one and it is not about taste: our fields and Foundry's own two radii
describe *one* light between them, and the radii mean something different now than their
labels say. "Dim Radius" is §3.2.1's *increase* band and has nothing to do with dim light. A
separate tab leaves that mislabelling in place on Basic and puts the fields that explain it a
click away.

So: **one fieldset injected into the Basic tab, between Placement and Appearance**, carrying
every control including the two radii, and the rows it supersedes are hidden rather than
duplicated.

`templates/scene/parts/light-basic.hbs` is two fieldsets — `AMBIENT_LIGHT.SECTIONS.placement`
and `AMBIENT_LIGHT.SECTIONS.appearance` — so the mount point is `insertAdjacentHTML` before
the second `<fieldset>` in the `basic` section. Hidden:

- the radius `.form-group.slim` (the `config.dim` / `config.bright` pair), because our section
  carries both inputs under names that say what they do
- the `config.negative` group, because "is a darkness source" is the switch our whole section
  branches on and belongs at its head

**The inputs are the real fields, moved — not mirrored.** `config.bright`, `config.dim` and
`config.negative` are genuine `LightData` paths, so an input carrying that `name` anywhere in
the form is bound by `FormDataExtended` exactly as the original was, flows through
`_onChangeForm` → `_previewChanges` → `preview.updateSource`, and previews live. Two live
controls for one value would be a bug factory; one control in a different place is not.

`config.priority` stays where it is on Appearance, with a hint added: Foundry's Priority orders
darkness against darkness and is **not** our spell level (§4.1.1, and §10's earlier note
rejecting mirroring one into the other).

**Injection, not a registered `PARTS` entry.** Adding a real part means mutating
`AmbientLightConfig.PARTS`, rebuilding it so ours lands in order, and wrapping `_prepareContext`
because `_preparePartContext` offers no hook. `renderAmbientLightConfig` fires after `_onRender`
on every render and needs none of that. Two consequences, both now simpler than the tab version
would have been:

- Our section lives inside the `basic` part, so a **partial** re-render leaves it alone —
  and `_onChangeForm` re-renders exactly `["animation", "advanced"]` when `config.negative`
  changes (`ambient-light-config.mjs:169`), which is to say never `basic`. The injector must
  therefore guard against double-injection (a marker class) and must handle the light↔darkness
  swap itself.
- It handles it by **toggling visibility, not by rebuilding**. Both field groups render; one
  is hidden. Cheaper, keeps the preview stable, and has a real benefit: a light toggled to
  darkness and back still has its emission settings, because hidden inputs still submit and
  the model reads `emitTier`/`steps`/`cap` only for emitters and `transform`/`floor` only for
  suppressors. Stale irrelevant flags are inert by construction.
- `#onReset` calls a full `this.render()`, which wipes the section; the hook re-injects.

**Token light gets the same fieldset, one mount point over.** `templates/scene/token/light.hbs`
has the identical shape — a `TOKEN.SECTIONS.basic` fieldset holding the radius pair and
`light.negative` — so the same builder runs with a field-name prefix of `light.` instead of
`config.`, hiding the same two rows and appending our fieldset after that one. One
`renderTokenApplication` listener covers both `TokenConfig` and `PrototypeTokenConfig`, since
`#callHooks` walks the inheritance chain and the mixin's own class name fires for both
(`api/application.mjs:1226-1232`). The registry reads
`source.object.document.getFlag(MODULE_ID, "config")`, which resolves to `TokenDocument` for a
token light, so no model change is needed.

**Our flag fields do not preview, deliberately.** `registry.usable()` excludes previews
(`model/registry.mjs:190`) because a drag creates a second live source and counting both made
the model resolve a scene that did not exist; the config sheet's preview is the same kind of
clone. The native fields in our section preview normally — they are Foundry's own — and the
asymmetry needs a hint saying so. On close the injector calls `registry.invalidate()` plus a
forced `renderer.rebuild()` rather than trusting `refreshAmbientLight` to fire for a flag-only
change. `affectsRegistry` already tests `flags.pf1-lighting` (`model/registry.mjs:346`), so the
update hooks are correct as they stand.

**`brightRadius` is retired, not relocated.** It was read as a *top-level* flag while everything
else lived under `.config`, and §3.2.1's rewrite removes the concept it named: a Bright light is
now `emitTier = Bright` against its ordinary inner radius. Nothing needs migrating — a light
with the old flag simply stops having a third zone, which is the correct new reading of it.

### 10.4 What the section shows, and when

Branching on `config.negative`, because that is what decides whether the document becomes a
`PointLightSource` or a `PointDarknessSource`, which is what decides whether the model reads it
against `DEFAULT_EMITTER` or `DEFAULT_SUPPRESSOR`.

The fieldset's legend is **Lighting Configuration**. Head of the section, always: the
**preset** select (Custom first, per §10.2), then **is a darkness source**
(`config.negative`).

**Light:**

| Group | Controls |
| --- | --- |
| Source | is magical (`kind`) · spell level (`level`, disabled unless magical) · counts as *daylight* (`cancelsDarkness`) |
| Brightness | level (`emitTier` — Dim / Normal / Bright) · radius (`config.bright`) |
| Increase brightness | radius (`config.dim`) · steps (`steps`) · maximum level (`cap`) |

The second and third groups are §3.2.1 read straight off: *this light provides `<level>` out to
`<radius>`, and raises whatever else is there by `<steps>` out to `<radius>`, never past
`<maximum>`.* `cap` defaults to the set level and `steps` to 1, so the ordinary case is one
dropdown and two radii, with the last two fields left alone. `cap` was missing from both the
original plan and Patrick's list and is the only field either of us dropped that the model
already implements — it is §3.2.1's second lever, the one that keeps three overlapping torches
at Normal.

No "none" entry on the brightness level: a light with no set zone is `config.bright = 0`, which
is how Foundry already expresses it.

**Darkness:**

| Group | Controls |
| --- | --- |
| Source | spell level (`level`, with 0 named *Mundane / unlit area*) |
| Effect | set or decrease · **set** → target level (`transform.op = "clamp"`) · **decrease** → steps (`reduce`) and floor (Dark / Supernatural Dark) |

*Set* and *decrease* are `clamp` and `reduce`, and the labelling has to be honest about what
`clamp` does: it never brightens. Setting a darkness to Dim over ground that is already Dark
leaves it Dark. That is the correct behaviour for a darkness and the wrong reading of the word
"set", so the hint says it.

`floor` appears only under *decrease*. Under *set* the target level **is** the floor, and
offering both would be offering a contradiction — **but the code does not currently make that
true, so the UI has to.** `applyTransform` ignores `floor` on the `clamp` branch (correctly:
clamping toward a named tier needs no lower bound), while `resolveTier(B, {suppressed, floor})`
applies `floor` separately at the point of thresholding. So a darkness *set* to Supernatural
Dark yields `B = 0`, which then resolves through the default floor of Dark and comes out
**Dark**. The fix is one line in the writer, not the model: when *set* is chosen the section
writes `floor` equal to the clamp target, so the two cannot disagree.

#### 10.4.1 The activation range is a tier range — built 2026-08-28

Patrick, 2026-08-28: *"I want to update the darkness activation range in light settings — rather
than a numerical value, I want them to be dropdowns of our light levels."*

`config.darkness.min`/`max` gate the source on `canvas.darknessLevel`
(`canvas/placeables/light.mjs:148-159`), a raw `[0,1]` number, against a model that quantises the
ambient to four rungs. §10.5's argument about the scene slider applies unchanged: a continuous
control offers precision that does not exist. Both inputs are **moved** into hidden slots and
driven by a pair of tier dropdowns, the same relocation §10.3 uses for the radii and for the same
reason — two fields sharing a `name` make `FormDataExtended` return an array.

| Group | Controls |
| --- | --- |
| Active when scene is | brightest (`activeFrom`) · **down to** · darkest (`activeTo`) |

Outside both branches of §10.4's table, because Foundry gates a *darkness* source on the same
field — `_isLightSourceDisabled` runs before the source is built.

##### Two ways to map it wrong

**The range is bands, not points.** `darknessTable()[tier]` is the level a tier *paints* at; the
set of levels that *read back* as that tier is a band around it. They are not the same set and
only coincide on scenes configured through §10.5's dropdown. Writing the point levels would leave
a light set to *Normal* switched off on a scene at darkness 0.30 — which the module itself calls
Normal, and says so in its own readout. `tiers.darknessBand(tier)` is the inverse as a range:
midpoints to the neighbouring rungs, `[from, to)`, neighbours found by **sorting on level** rather
than by position, because the table is four editable settings and nothing stops a GM from making
Dim brighter than Normal.

The half-open interval matters. `Number#between` is inclusive at both ends
(`primitives/number.mjs:83`, and `light.mjs:159` calls it with two arguments), so the dark end is
closed by hand with a 1e-6 nudge. That is not defensive rounding: the Normal/Dim edge under the
default table is exactly **0.5**, which is where a hand-dragged darkness slider likes to sit, and
without the nudge *Bright→Normal* and *Dim→Dark* would both claim it. With it, the four tiers
partition `[0,1]` exactly — verified against `matched`, `even`, `bands` and a retuned table.

**The two ends invert.** Low darkness is bright light, so the *brightest* tier drives `min` and
the *darkest* drives `max`. Nothing in the control says min or max; both dropdowns are in tiers
and the joining word carries the direction. The ordering is also enforced in the sheet rather
than left to the schema — `LightData` refuses `darkness.max < darkness.min` outright
(`common/data/data.mjs:68`), which as a failure mode is a validation error on save rather than
anything the GM could see coming. Whichever select was just moved keeps its value.

##### What it does not do

The test is `canvas.darknessLevel` — the **scene's** number, not `areas.ambientTierAt` at the
light's own position. A lamp set to come on in the dark does not notice that it is standing in an
unlit building on a bright scene. Reaching the per-region ambient would mean overriding
`_isLightSourceDisabled`, which is a §6.2.10 question and not this change; the hint says plainly
which level is being tested rather than letting the tier vocabulary imply the other one.

##### Storing the tier, and the restraint around it

§10.5.1's argument applies verbatim — the tier a GM chose is a fact about history and cannot be
recovered from the number once the table is editable — so `activeFrom`/`activeTo` are the source
of truth and the numbers are derived output, resynced from the same `tierTableChanged` broadcast
and `canvasReady` net, behind the same `activeGM` writer guard. `render.lights()` reports which
lights carry a range and whether their numbers still match; `render.resyncLights()` forces it.

The restraint is the part that took a decision. Unlike the scene control, this sheet submits its
whole form on save, so a light merely *opened* would have had its hand-set range snapped onto the
nearest band edge. §10.5.1 says leave it alone, and that wins here too: the flag carriers ship
`disabled` until a dropdown moves, and `FormDataExtended` omits disabled fields, so a light that
has never been through this control writes no flag and keeps its numbers exactly. The cost is
that the dropdowns can then disagree with the stored numbers, so the hint says when they do
rather than the control quietly pretending otherwise.

##### Not governed by presets

`activeFrom`/`activeTo` are deliberately absent from `GOVERNED` (§10.2), on the same footing as
the radii: they say where this particular light is placed and when the GM wants it burning, not
what kind of thing it is. A torch that only burns after dark is still a torch.

##### The token sheet has no such field

`templates/scene/token/light.hbs` omits the activation range entirely, though `LightData` carries
it. There is nothing to relocate, so the row is left out rather than rendered with nothing behind
it. Adding it for tokens would mean authoring the inputs ourselves, which is a feature rather
than this change.

##### A tie rule that was not holding

Found while checking that a band round-trips its own lower edge. `tierFromDarkness` resolves an
exact tie to the darker rung by visiting darkest-first with a strict `<` — but a midpoint
computed as `(a + b) / 2` is not reliably equidistant in binary. `(2/3 + 1) / 2` sits one ulp
nearer ⅔ than 1, so the Dim/Dark boundary resolved to **Dim** while the Normal/Dim boundary at
0.5 resolved to Dim as intended: the rule held or broke depending on which rungs it fell between.
The comparison now carries a 1e-9 tolerance. Everything it changes was decided by float noise
before it, and it was invisible until something asked the inverse question.

### 10.5 The scene — one control, not two

The tier → darkness-level table is the one number §7.0 says can only be settled by looking at a
map, and different maps want different answers — which is why `matched`, `even` and `bands` all
exist. It needs a world default and, eventually, a per-scene override in a fieldset on
`SceneConfig`'s `lighting` part.

**The world half is built (2026-08-25), and as four plain settings rather than a preset
picker** (Patrick's call). `tierLevelBright` / `Normal` / `Dim` / `Dark`, each the darkness
level that tier paints at, defaulting to `TIER_TO_DARKNESS` so nothing moves on upgrade.
`levels.applyTierTable()` builds the table from them and installs it.

Three things it has to get right, and each is a dependency that is easy to miss:

- **The light weights must be re-solved.** `deriveWeights` reads the table — it asks where a
  light's zones land on unlit ground and solves for the weight that puts them on the matching
  ambient tier — so a table change that did not re-solve would leave every *light* painting
  against the old ladder while the *ground* painted against the new one. That is precisely the
  §6.2.3 mismatch the derivation exists to prevent.
- **Only when we are already driving them.** With the global-illumination takeover off,
  `CONFIG.Canvas.lightLevels` holds Foundry's own values, and replacing them would be applying
  a feature the GM switched off. `savedWeights` records which state we are in, and reading it
  locally is also what keeps this out of a cycle — `render/ambient.mjs`, which owns the takeover
  setting, already imports `levels.mjs`.
- **`initializeLighting`, not just `refreshLighting`.** The table is a *model* input: it is the
  base of every additive sum in §3.2.1, through `ambientTier`. So the field has to recompute,
  not merely repaint.

**Four settings, not five.** Supernatural Dark tracks Dark, because `TIER_TO_DARKNESS`
deliberately gives them the same level — Dark means no light and `ambientDarkness` is what no
light looks like, so there is nothing below it to reserve, and the darkness source's own overlay
is the better distinction. The `even` preset, which does separate them, stays reachable from the
console.

`render.levels(preset)` remains the *transient* lever for trying a table against a live map,
persisting nothing; `render.levels(null)` now reloads the four settings rather than resetting to
the hardcoded default, so an experiment is always one call from being undone.

Separately, and more visibly: **the scene's own light level** — built 2026-08-25,
`ui/scene-config.mjs`.

**A dropdown, replacing core's slider outright.** Not a latched range over a label row, which
was the earlier plan here, and not a second control beside the slider: the model quantises to
five tiers, so a continuous control offers precision that does not exist. Core's
`environmentFields.darknessLevel` input is **moved** into a hidden slot and driven, because two
fields sharing a name make `FormDataExtended` return an array — the same constraint §10.9 is
built around.

Four options, not five. Supernatural Dark is not somewhere ambient light can *be*, only
somewhere a suppressor with the right floor can put you.

#### 10.5.1 The scene stores a tier

`flags.pf1-lighting.tier` is the source of truth and `environment.darknessLevel` is derived
output. That reverses this section's original claim that the control needed no stored field
because `tierFromDarkness()` could recover the tier from the number.

It cannot, once the table is editable. Patrick's requirement is that moving Dim from 0.67 to
0.80 carries every scene set to Dim along with it — and re-deriving from the stored 0.67 under
the *new* table may not answer Dim any more, so a scene would change tier because the GM retuned
an unrelated one. **The tier a GM chose is a fact about history, and history cannot be recovered
from the numbers** — the same argument §10.2 makes about presets, load-bearing here rather than
merely tidy. Storing it makes the update deterministic: the scene is Dim, Dim is now 0.80,
write 0.80.

Three properties of the sync, each of which is something that would otherwise go wrong:

- **A scene with no flag is left alone.** It has never been set through this control, so the
  dropdown shows its nearest rung and nothing is written until a GM picks one. Snapping every
  existing scene on install would be the module deciding something it was not asked to.
- **Exactly one client writes.** A world setting's `onChange` fires on every connected client
  and a scene is a world document, so the guard is `game.users.activeGM?.isSelf` — without it
  players attempt a write they are refused and every GM issues the same one.
- **Locked scenes are skipped, not attempted.** `Scene#_preUpdate` silently *deletes*
  `environment.darknessLevel` from an update when `environment.darknessLock` is set
  (`documents/scene.mjs:416-419`). No error and no effect, so issuing the write anyway would
  produce a readout claiming scenes it had not changed. They are counted and reported instead.

Two triggers: the table changing (every flagged scene, via the `pf1-lighting.tierTableChanged`
hook) and `canvasReady` (the one scene being drawn, as a safety net for a scene created or
imported while a different table was in force, or by a client that was not the active GM).

**A hook rather than a fourth injected callback.** `ui/scene-config.mjs` reads the table from
`render/levels.mjs`, so levels cannot import it back — which is the shape the `set…Refresh`
seams exist for. But this is a genuine broadcast: one producer, any number of listeners, none of
which levels should have to know about, and observable from a macro besides.

**Assigning `.value` on a Foundry custom form element dispatches `change`**
(`applications/elements/form-element.mjs:89-92`), so driving core's darkness input from the
dropdown re-enters the same delegated listener. Guarded with a flag rather than by reaching for
the protected `_setValue`, which would only exist on the custom elements — a plain
`<input type="range">` would need the guard anyway.

`render.scenes()` reports which scenes carry a tier and whether their stored level still matches
it; `render.resyncScenes()` forces the pass.

#### 10.5.2 The lighting palette — four buttons, no transition — built 2026-08-28

Patrick, 2026-08-28: *"vanilla, there's transition to daylight and transition to darkness buttons
in the lighting controls. They transition over 10 seconds, which looks stilted and slightly
glitchy with our new discrete light settings system."*

Core's `day` and `night` tools are **deleted** from the palette and replaced by one button per
tier — sun, cloud-sun, cloud-moon, moon, brightest first, keeping core's two icons at the ends so
the buttons a GM already knows keep their meaning. Two independent reasons, either of which would
be enough:

- **The animation crosses states the model does not have.** They slide `darknessLevel` over
  `CONFIG.Canvas.darknessToDaylightAnimationMS` — ten seconds — and every frame of that slide is a
  darkness the four-rung ladder has to quantise. What the GM sees is not a fade but the ambient
  stepping through Dim and Normal on its way somewhere else, with the model recomputing at each
  rung crossing. The same objection §10.5 makes to the slider, in time rather than in value.
- **They write the number without the tier.** §10.5.1 makes `flags.pf1-lighting.tier` the source
  of truth, so a scene set by core's button is a scene this module has to fall back to guessing
  about, and the next tier-table change moves it somewhere the GM did not put it.

`setSceneTier(tier)` writes both fields in one update and **omits `animateDarkness`**, which is
what makes it instant: `Scene##onUpdate` only reaches for the animator when the option is present
(`documents/scene.mjs:606`), so leaving it out is a different code path rather than a zero
duration. `canvas.environment.initialize()` still dispatches one `darknessChange`
(`groups/environment.mjs:193-200`), so `spill.watchDarkness` and everything downstream of it fire
exactly once instead of six hundred times.

**No current-tier marker on the buttons.** `SceneControlTool#active` is documented as not
applicable to buttons and is overwritten at prepare time anyway
(`ui/scene-controls.mjs:265`), and `cssClass` is rebuilt on the same line — so marking the
current tier would take a `renderSceneControls` DOM pass *plus* a controls re-render on every
darkness change, including ones this module did not cause. Core's day/night carried no state
marker either. Left out; the scene config and the map both already say where the scene is.

The lock is handled the way core handles it: `visible` is evaluated inside `#prepareControls`,
which core re-runs on `canvasReady` and whenever `darknessLock` changes
(`documents/scene.mjs:625-627`) — the two moments it could go stale — so honouring the lock needs
nothing of its own. `setSceneTier` refuses and says so regardless, because it is also a public
call.

`render.setSceneTier(tier)` is the same entry point from a macro.

### 10.6 Settings

**Superseded by the 2026-08-26 pass below.** The plan was one `registerMenu` application grouping
twenty-one flat settings into Model / Render / Vision / Client / Debug, on the argument that a
fresh install did nothing until the right four boxes were found and ticked in a list that gave no
indication `renderEnabled` gated `modelGlobalIllumination`. That argument was sound and the
answer turned out to be a better one: **if a list is unnavigable because it is full of switches
nobody should be touching, take the switches out.**

#### As built — 2026-08-26

Patrick went through the list setting by setting. What came out is six rows and two buttons:

| | |
| --- | --- |
| **Visuals** | menu → §10.6.1 |
| **Lighting Presets** | menu → §10.2.1 |
| Show light level | client |
| Light level is GM only | world |
| Explain the light level | world |
| Animate ordinary darkness | world |
| Darkness shadows what lies beyond it | world |
| GM sees through the selected token | client, GM-only by `setSettingVisibility` |

Menus sort ahead of settings in Foundry's panel (`applications/settings/config.mjs:55-62`
pushes every menu before the settings loop), so the two windows head the list whatever order
they are registered in.

**Eight settings lost their row and kept their behaviour.** *Disable native darkness
suppression*, *Render the lighting model*, *Model global illumination*, *Perceive by light level*,
*Darkness respects grey vision*, *Draw overlapping light bands brighter*, *Show field cell
overlay*, *Low-light vision does not enlarge darkness*. Every one was a development bisection aid
— a switch whose value is *"the module works"* is not a preference — and this project has kept
them long past the point of paying for them, which is what §10.6 was originally complaining about
from the other end.

**Four of them had their defaults flipped from `false` to `true`, and that is not cosmetic.**
`disableNativeSuppression`, `renderEnabled`, `ambientTakeover` and `perceptionEnabled` were the
master switches. A hidden switch that defaults off is a module that does nothing on a fresh
world, so removing the row *requires* flipping the default — the two changes are one change.

> **A world that stored `false` keeps `false`.** A stored value beats a default, so an existing
> world that ever explicitly turned one of these off has it off with no row to turn it back on.
> That is what `game.pf1Lighting.settings()` is for, and it is why it exists at all rather than
> being a convenience: *removed the row, not the switch*, and a switch reachable only by
> remembering its exact key is a switch that is gone in practice. The readout marks
> `hidden: true` on precisely the settings it is the only route to.

**The readout gained a GM gate, and the scope does most of the work.** Foundry hides a
world-scoped setting from non-GM clients outright (`applications/settings/config.mjs:67`), so
*Light level is GM only* and *Explain the light level* are GM-only in the menu for free.

- *Light level is GM only* defaults **on**. The light level is information — a player reading the
  exact tier under their token knows something their character has to work out — so the GM opting
  players in is the right direction for the default to point. It also delivers Patrick's *"default
  off for non-dm users"* without a per-user default, which a client setting registered at `init`
  could not express anyway: `game.user` does not exist yet.
- *Light level is GM only* also has to **take the client row with it**, which the first pass
  missed. `SETTING_ENABLED` is client-scoped — it is a personal preference and has to be — so
  Foundry's world-scope filter does not reach it, and a player under the switch was left with a
  control that did nothing. `constants.setSettingVisibility` flips `config` on the stored entry
  in `game.settings.settings`, which is where `SettingsConfig` reads it at render time, and
  re-renders an open settings window because this can change while a player is looking at it.
- *Explain the light level* is gated **in the feature as well as in the menu**. The world scope
  hides the control; `detailed()` returning `false` for a non-GM makes it impossible for an
  explanation to reach a player even when the readout has been shared. The *why* — "reduced from
  normal", "darkness cancelled by daylight" — is a statement about causes the character has no
  way to know, which is a different thing from the level itself.

##### A toggle must read the thing it writes — 2026-08-26

The first pass folded both questions into one `enabled()`:

```js
const enabled = () => {
  if (gmOnly() && !game.user?.isGM) return false;
  return game.settings.get(MODULE_ID, SETTING_ENABLED) === true;
};
```

Correct for every *render* path and wrong for the one *writer*. Reported by Patrick as *"the
hotkey just keeps toggling it on and never toggles off"*: for a player under the GM-only switch
`enabled()` is permanently `false`, so `!enabled()` is permanently `true` and Alt+L wrote `true`
on every press. Split into `available()` (may this user have it) and `showing()` (their own
stored preference), with `enabled()` the conjunction. The keybinding toggles `showing()` and
returns `false` when unavailable, so the press falls through to any lower-precedence binding —
`pf1-light-level-tooltip` binds the same chord, which is a better answer than a notification
saying no.

*General shape: a control that toggles a value must read **that value**, never an effective
answer with a second term folded into it. The two coincide until the second term exists, which
is why this ships looking correct.*

##### Token names go through `pf1-token-randomizer` when it is there — 2026-08-26

The chip is **the module's only player-facing surface that prints a token's name**, which makes
it the only place a name can leak from: the probes and the cell overlay are console tools, and
the canvas nameplate is already substituted by the randomizer itself.

`pf1-token-randomizer` lets a DM author a replacement name on a token and shows it to anyone
below Observer. A feature printing `token.name` hands back the real one, so `tokenLabel()` asks
that module's own `shouldObscure` / `getObscuredName` rather than re-reading its flags — the
policy stays in one place, which its own source explicitly asks for.

A second layer applies with or without it: **Foundry's native nameplate visibility**. A token
whose plate is hidden from a player is not a token whose name belongs in a tooltip six inches
away, so anything below LIMITED ownership on a token not set to `HOVER`/`ALWAYS` reads `???`.

**A soft tie-in and nothing more**, per Patrick: no manifest relationship, no notification, no
startup check. The module is looked up per call and its absence is the first layer not applying.
`tr?.active` is tested as well as `tr?.api`, because an installed-but-disabled module keeps its
entry in `game.modules` — and since the API is assigned at that module's own `setup`, a disabled
one has no `api` to call in any case.

##### The chip belongs to the scene — 2026-08-26

It followed the cursor across sheets, dialogs and the sidebar, reporting the light level at
whatever canvas position happened to lie underneath. The `mousemove` listener is on `window`,
which is right for tracking, and the gate is the event **target**: it is by definition the
topmost element under the pointer, so testing it against `canvas.app.view` gives *"over the
scene, with nothing in the way"* in one comparison and needs no hit-testing of window rectangles.
A `mouseleave` on the document covers leaving the browser entirely, which fires no further
`mousemove`. A hovered token is exempt from the test — a token can only be hovered while the
pointer is on the board, and `hoverToken(false)` fires before it can be anywhere else.

**`ui/settings.mjs` is cancelled.** Six rows do not need grouping, and a menu that grouped six
rows into five categories would be the same over-architecture the flat list was accused of. §10.8
step 5 closes unbuilt — and `lang/en.json`, which was going to arrive with it, arrived on its own
for §10.7's reasons.

### 10.6.1 Configure visuals

`ui/visuals.mjs`. Eight numbers, one window, and one line separating them from everything else:
**they answer *how does this look*, never *what is true*.** Change any of them and the light level
under a token is the number it was; the readout, perception, the umbra and every mechanical
consumer read the model, and the model does not read this window. That is why these eight came
out of the flat list together rather than one at a time.

Four of them are one setting with four values. *Brightness of Bright / Normal / Dim / Dark* is a
**ladder**: the rule that matters is that the numbers ascend as the tiers darken and that the
gaps stay wide enough to read, which is a fact about the four together and cannot be stated in
any one of their hints. As four rows they carried four near-identical paragraphs saying so;
Patrick's instruction was *"do away with individual hints — just one hint telling 0 (full
daylight) to 1 (unlit)"*, and under one heading they need exactly that. The tiers are listed
brightest-first so a wrong entry shows up as a value out of order rather than as a number to
reason about.

The other four are the three softening distances and the see-in-darkness offset — the rest of the
same question, and nowhere better to be.

**The window does not own the settings.** Each key stays registered in the module that reads it,
with its own `onChange`; this reads and writes them by key. Same reason the original §10.6 gave:
a menu that owns its settings is a second dependency graph to keep in step with the first. And
the `onChange` work here is real — the tier table re-solves the light weights and pushes every
scene stored at a tier to its new darkness (§10.5) — which is why the submit handler writes
**only keys whose value actually moved**. Writing every key unconditionally would run that four
times over for one edited number, which is
`setting_onchange_fires_on_create` seen from the other direction.

### 10.7 Regions — why core's behaviour cannot work here

Patrick's fourth control point is a region that excludes global illumination, and reported
2026-08-24 that core's `AdjustDarknessLevelRegionBehaviorType` "doesn't seem to work currently
under our system". It cannot, and the reason is in our own code.

That behaviour builds a `RegionMesh` with `AdjustDarknessLevelRegionShader` and adds it to
`canvas.effects.illumination.darknessLevelMeshes` (`adjust-darkness-level.mjs:66-88`).
`render/darkness-texture.mjs` builds meshes of **the same class, with the same shader, in
`MODE_OVERRIDE`, into the same container** — and `addChild` appends, so ours draw last. Our
ground fill covers the whole scene rect. Last override wins, so the region's value is
overwritten everywhere it could matter. It is not that the behaviour is broken; it is that we
are painting over it.

Cooperating with it is possible in principle — read the region's mode and modifier, fold it
into the fill — but it is the wrong shape for the same reason §4.1.1 gives about native
darkness suppression: it makes the picture the arbiter of a value the model is supposed to own,
and it composes by draw order rather than by the contest.

**The right shape is our own behaviour, and it is model work, not UI work.** Patrick's
requirement names it exactly: *not overriding other lights, just the global illumination value.*
That is a per-area **ambient tier** — the base `A` that §3.2.1's bands add to — so the behaviour
registers an area with a tier, `ambientTier()` becomes position-dependent instead of scalar, and
everything downstream composes as it already does. Lights inside it still light; the darkness
contest still runs; the region only moves the floor.

#### As built — 2026-08-26

`model/areas.mjs`, one behaviour type, `pf1-lighting.globalIllumination`, named **Restrict Global
Illumination**. Two fields plus Foundry's own `disabled`: a **tier** and a **mode**. "Exclude
global illumination" is *at most Dark*, which is the default the schema opens on.

**The name is the scope, and it was worth renaming for** (Patrick, 2026-08-26). The first pass
called it *Ambient Light Level*, which is what the mechanism does and not what the feature is
for. A GM reading *Ambient Light Level* on a behaviour list has no way to know it will not dim
the torch they put in the room; reading *Restrict Global Illumination*, they do. The narrower
name is also the true one — see the light-source correction below, which is the same confusion
having actually happened.

**The mode exists because of time of day, and it is the one design decision here.** *Set* looks
like the obvious semantics until the scene's darkness slider moves: a cellar configured *set
Dark* on a Bright outdoor map is correct at noon and, at midnight, exactly as bright as the field
outside it — and a cellar configured *set Dim* is **brighter** than the night around it. A room
that is unlit is unlit *relative to whatever the sky is doing*, which is a clamp and not an
assignment. So `AT_MOST` is the default and the case Patrick asked for; `SET` is kept for the
magically lit vault, which a clamp genuinely cannot express, and `AT_LEAST` is that case's other
half for one line.

Four claims the implementation has to keep, and each is one branch:

- **Lights inside still light**, and still add their bands, from the lower base.
- **A darkness inside still suppresses, from the lower base.** This is the one that does real
  work: without it a *darkness* in an unlit cellar transforms down from the Bright *street*, and
  renders **brighter than the room around it** — the failure backwards. `field.compute` splits
  each `dark` cell by domain for exactly this.
- **No umbra, ever.** An area is not a suppressor and never reaches `castsUmbra`. It is an unlit
  room, not magical darkness, and `level` is not a field it has.
- **Nothing about it is observer-relative.**
- **Its boundary is never feathered.** The ground blur (§6.4.2a) exists for the edge between a
  *darkness* and open ground, which has no architecture on it and reads as a stencilled disc
  without a feather. A region is drawn along a **wall** — the one edge in a scene that should be
  hard — and blurring it makes the room bleed through its own walls. Cells carry `hardEdge`,
  which is part of `mergeByLevel`'s group key (a feathered and a hard-edged cell at one level are
  two treatments, not one region) and is assigned unconditionally in `apply` for the reason every
  other per-entry flag is: this project's recurring pooling bug, now on its fourth instance after
  `animation`, `HARD_EDGES` and `HIDDEN`.

**It draws nothing of its own.** The area is emitted as an ordinary `kind: "ambient"` cell at its
tier, `render/paint.mjs` puts it in the darkness-level texture with every other ground cell, and
§7.0's shader threshold discards global illumination per fragment wherever that texture reads
darker than `globalLightCutoff()`. That is the whole "exclude global illumination" feature, and
it costs no polygon on the global light source and no second mechanism — which is worth stating
plainly, because the first sketch of this section assumed `customPolygon` and that route is the
one §7.0 spent a day proving wrong.

Three consequences of riding on that mechanism, all of them reported by `areas.status()` rather
than left to be discovered:

1. **It needs *Model global illumination* on.** With the takeover off the model answers
   correctly — readout, perception and detection all move — and the map does not change, because
   the texture is the only channel through which anything darkens below global light.
2. **It needs the scene's global illumination *enabled*.** These regions move the ambient, and
   with global light off there is no ambient entry in the registry at all — so a *set Bright*
   area is exactly as inert as a *set Dark* one. Place a light instead.
3. **An area at Dim on a globally-lit scene is under-darkened**, for the reason any Dim-floored
   darkness is: `globalLightCutoff()` is the single threshold `darknessTable()[TIER.DIM]` and
   `darknessFor` erases only where `level > cutoff`, so Dim itself sits exactly on the boundary
   and global light survives it. Not new, not specific to regions, and not fixable without a
   second threshold.

##### Reported as "it blocks light sources" — it never did, 2026-08-26

Patrick's second note on the first build. The region was darkening the ground *and* the torches
in it were dark, so it read as the region suppressing them. It was not suppressing anything, and
the model had never thought it was: `evaluate()` reads `ambientTier(point)` through the global
emitter's contribution, so a torch in the cellar always resolved to Normal. The picture was
alone in being wrong, which is the shape this project keeps producing and the reason a model
readout is checked before a screenshot.

The renderer converts a light's tier into one of Foundry's lighting levels through
`levelForTier(target, background)`, which returns **`UNLIT` whenever `target <= background`** —
a torch adds nothing at noon, correctly. And `background` was **one scalar for the whole scene**:

```js
const sceneTier = tierOf(current.stats.ambientB ?? 0);   // renderer.mjs
```

So on a Bright map every ordinary light was *already* being drawn unlit, and had been since
§6.2.3. That was right while the ground really was Bright everywhere, and it stopped being right
the moment a region made one room Dark — but nothing about the light changed, so the region got
the blame. **The lights were not blocked; they were unlit for a reason that had expired in that
room.**

Two things follow, and the second is the general one:

- **`base` is now a per-cell field.** `field.stampDomains` splits `clip` and `reduced` cells
  where they cross a domain boundary and stamps each piece with the ambient it stands on;
  `emitStacks` stamps its own, since it is already told its base. `ambient` and `dark` cells need
  nothing — the first is a mesh and the second is drawn by a darkness source, and neither goes
  through `levelForTier`. The renderer reads `cell.base ?? sceneTier` at all four sites, so a
  scene with no regions is unchanged expression by expression.
- **The split is skipped by a bounding-box test against the extent of the *areas*, not of the
  domains.** The base domain's extent is the whole scene rect and would reject nothing, so
  testing the domains would have made every light on the map pay Clipper. Areas are small; most
  lights are nowhere near one.

*General lesson, and it is §7.0's blindsight lesson again in a third costume: a correct
special-case — "a light no brighter than the ground is drawn unlit" — is stated relative to a
quantity, and stays in the code unchanged when that quantity stops being global.*

**The cost, and the case that stays free.** `field.ambientDomains` returns `null` when the scene
has no areas, and every consumer branches on that rather than treating "one domain covering
everything" as the general case — the same discipline as the no-suppressor fast path, and for
the same reason: the ambient cell is on the hot path of every scene and most scenes will never
carry a region. With areas, the split folds one area at a time over the domains so far, cutting
each into `D ∩ A` and `D \ A`, which is exponential in *overlapping* areas — so the result is
**collapsed by tier** before it leaves. `emitStacks` is the expensive consumer and after the
collapse it runs at most five times however many regions are drawn.

Folding in document order also makes the polygon split agree with `ambientTierAt`'s point query
by construction rather than by a rule written down in two places, which is why `foldTier` is
exported rather than duplicated.

Two smaller things worth having recorded:

- **`documentTypes` in `module.json`.** A data model registered into
  `CONFIG.RegionBehavior.dataModels` without the manifest entry is never offered in the *Add
  Behavior* list, and the failure is silent. So the type name is authored in two places that
  must agree, and this feature needs a **full Foundry reload** rather than an F5.
  `areas.status().declared` is the manifest half, separately from `registered`.
- **The type label had to become a real translation key** — `lang/en.json` exists from
  2026-08-26 for this one string, and the first build's attempt to avoid it was wrong.

  Assigning a plain English string into `CONFIG.RegionBehavior.typeLabels` at `init` does
  survive `Localization#initialize` (`helpers/localization.mjs:72-73` skips a slot we have
  filled), and it renders correctly in `RegionConfig`'s behaviour list, which calls plain
  `localize` (`sheets/region-config.mjs:114`). It fails in the *Create Region Behavior*
  dropdown, which is where a GM meets the behaviour first:

  ```js
  let label = CONFIG[this.documentName]?.typeLabels?.[type];
  label = label && game.i18n.has(label) ? game.i18n.localize(label) : type;
  ```

  `ClientDocument.createDialog` (`abstract/client-document.mjs:822-823`) demands a **key that
  exists**, not a string that localises, and falls back to the bare type name. Reported by
  Patrick 2026-08-26 as *"maybe labeling it in the wrong place? Rest seems to be working"* — and
  the "rest" working **is** the diagnosis, since the two call sites differ by exactly that
  `has()`.

  So nothing is assigned in `registerBehavior` at all; the label lives under the key core writes
  by default, and `areas.status().label` reports whether it resolved — a type that is registered,
  working, and listed under its raw key looks healthy from every other angle. This is the one
  user-facing string in the module that cannot stay in the source it describes; §10.6 moves the
  rest to join it.

  *General shape, and not the first time here: a value that is right in two of the three places
  it is consumed.*
- **Elevation is ignored**, per §3.6. A region carries `elevation.bottom`/`top` and
  `RegionDocument#testPoint` tests them, but the model has no elevation anywhere else — every
  emitter is a disc on the floor — so consulting it here would make ambient the one quantity
  with a third dimension, and a cellar authored at its real depth would then apply to nothing.

#### 10.7.1 No global light source meant no ground at all — FIXED 2026-08-28

Patrick, 2026-08-28: *"it's definitely global illumination getting turned off — if I manually
uncheck it at any light level the brightness inside the light look the same as they do when the
scene is set to dark … it only happens when inside a region with our restrict global illumination
setting enabled. If I move the light outside it they look as they should."*

`registry.buildEmitters` drops a source that is not `active` (`registry.mjs:259`), the global light
source included — and **every ground-emitting branch in `field.mjs` was gated on that entry
existing.** So whenever global illumination was off, the field emitted no `ambient` cells at all,
and the darkness-level texture had nothing in it.

What stands in is core's clear colour, and core keeps it at `canvas.environment.darknessLevel`
(`groups/effects.mjs:240-241`) — **the scene's own number, flat across the whole map**. Every
ambient area silently lost its tier, and a light inside one was then drawn against the scene's
background rather than the room's. The model was never involved and never wrong, which is why the
overlay stayed right throughout.

Three routes to one condition, which is why it looked like three separate bugs:

| Route | Why the source goes inactive |
| --- | --- |
| The scene's *Global Illumination* checkbox | `globalLight.enabled` is false |
| The scene set to Dark | darkness leaves the source's own `darkness.min/max` band |
| A *Restrict Global Illumination* region | the behaviour's whole purpose |

**The ground's tier was never the source's to give.** `registry.ambientBrightness` is
`tierCeiling(ambientTier(point))`, and `ambientTier` reads the scene's darkness and its areas —
neither consults the global light source. So `groundBrightness(ambient)` falls back to it, the
branches lose their `ambient &&` gates, and on a scene with no areas this reproduces the clear
exactly and nothing moves. What it adds is the area tiers, which had no other way into the texture.

`ambientB` and `domainBases` keep their `ambient` gates deliberately. Those are *contest* inputs —
what a suppressor transforms down from — and 0 is the right answer there when nothing is lighting
the scene. That leaves a known inconsistency: a *darkness* cast inside an ambient area on a scene
with global illumination off transforms from 0 rather than from the area's tier. Not this report,
and fixing it changes model output rather than the picture, so it is recorded rather than bundled.

##### The wrong turn before it

The first fix attempt was `cell.base` — read in `light-ramps.rampsFrom` as `cell.base ?? sceneTier`
and, it turned out, **never assigned anywhere.** That is a real defect and the fix for it is kept:
`baseFor(emitter)` stamps `areas.ambientTierAt` at the emitter's origin onto every cell it
produces, so `levels.levelForTier` gets the ambient the light is standing on instead of the
scene's. `stack` cells already knew — `emitStacks` is called once per domain and takes `base` as an
argument — and simply never carried it onto the cell.

It was not, however, *this* bug, and the reason is worth keeping: **it fit the region clue, and the
region clue had two mechanisms behind it.** Ambient areas are both the thing `cell.base` was wrong
about and the thing that turns the global light source off, and the first was a defect visible in
the source while the second needed core's clear-colour behaviour to see. Patrick's own reading —
*"it's definitely global illumination getting turned off"* — was the discriminator, and it was
available a round earlier than it was used.

*General shape, and the second time this section has produced it: a value that is right in two of
the three places it is consumed. Here the ground's tier was right in the model, right in the
overlay, and absent from the picture.*

### 10.8 Build order

1. ~~`model/presets.mjs`~~ — **built 2026-08-24.**
2. ~~`ui/light-config.mjs`~~ — **built 2026-08-24.**
3. ~~The token Light fieldset~~ — **built 2026-08-24**, and it cost one extra hook and one
   string. Both sheets have the same shape: a fieldset holding the radius pair and the
   `negative` checkbox, so the mount is *"the fieldset containing the `dim` input, insert
   after"* and the only difference is a `config.` / `light.` prefix.
4. ~~Scene: the tier control, plus the table~~ — **built 2026-08-25.** The table half landed as
   four flat world settings rather than a preset picker, and the scene control **stores** its
   tier rather than deriving it (§10.5.1). The per-scene table *override* is not built and may
   not be wanted: with the levels editable per world and the scene storing a tier, the case for
   a second layer is much weaker than it was when the table was a hardcoded preset.
5. ~~`ui/settings.mjs` — the menu, and `lang/en.json` with it.~~ **Closed unbuilt, 2026-08-26.**
   The list was unnavigable because it was full of switches nobody should be touching; taking
   eight of them out left six rows, which do not need grouping. What landed instead is
   `ui/visuals.mjs` (§10.6.1) for the appearance numbers, and `lang/en.json` arrived
   separately for §10.7's reasons. **§10 is complete.**
6. ~~`ui/preset-editor.mjs` and the preset table as data~~ — **built 2026-08-26** (§10.2.1).
   Not in the original order at all; it arrived as a request, and it turned the placeholder
   numbers in `model/presets.mjs` from an outstanding item into a thing a GM does.
7. ~~The region behaviour~~ — **built 2026-08-26** (§10.7). Also out of order, and it landed as
   model work exactly as that section predicted: the schema is two fields, and everything that
   took effort was `ambientTier()` becoming position-dependent.

### 10.9 As built — steps 1–3, 2026-08-24

Four things came out differently from the plan, and three of them are the same discovery from
different angles: **a control the GM sees is not always a field the form submits.**

**Same-named inputs return an array, so the natives had to be *moved*.** §10.3 said "moved, not
mirrored" as a design preference; it is a hard requirement.
`FormDataExtended#getFieldValue` collects same-named fields into a `RadioNodeList` and maps over
it (`form-data-extended.mjs:176-183`), so two inputs named `config.bright` would hand the
document `[20, 20]`. `relocate()` moves the DOM node — value, binding and core's delegated
listeners intact — and hides the row it came from rather than deleting it, so a re-render finds
the structure core built.

**Three values are carried by hidden inputs that visible controls drive.** `kind` is a *string*
in the model and a *checkbox* in the sheet; `level` is one number with two different sets of
labels depending on the branch, so it has two visible selects; and `cancelsDarkness` is the one
flag `breaks()` reads **without** first checking `kind` (`model/contest.mjs:235`).

That last one was a real leak rather than a tidiness question. Disabling the checkbox on a
mundane light does not clear the flag — `FormDataExtended` omits disabled fields by default, so
a light that used to be a *daylight* would keep annihilating darkness after being made mundane.
The hidden field always submits, and `sync()` writes `magical && checked` into it. Fixed in the
writer rather than in `breaks()`, since a *daylight* is magical by definition and the model has
no reason to carry the guard.

**Built as a string, not a Handlebars template**, reversing §10.7's last line.
`renderTemplate` is async and hook callbacks are not awaited, so a templated injection would
leave a window in which the sheet is visible without the fieldset — and would race the
de-duplication guard against a second render. Synchronous construction removes the whole class
of problem for markup this simple. `templates/` and the `renderTemplate` note stand for step 5,
where the settings menu is its own application and the asynchrony is not in a hook.

**`presetOf` does not exist**, per §10.2's one-way rule. `applyPreset(name)` returns a flat
dotted update for macros (`game.pf1Lighting.presets.apply`); the sheet writes the same values
straight into the inputs so that they preview.

**A darkness gets a Radius row of its own** (added 2026-08-25, after the first pass shipped
without one). It is the *same input* moved between the branches, not a second field — two
fields sharing a name yield an array, which is the constraint the whole section is built around.

And it carries a correction the first pass would have got wrong.
`PointDarknessSource#_initialize` collapses the pair on every initialise
(`point-darkness-source.mjs:117`):

```js
this.data.radius = this.data.bright = this.data.dim = Math.max(this.data.dim ?? 0, this.data.bright ?? 0);
```

So a suppressor's two radii are meaningless except through their **maximum**, and a control
bound to `dim` alone lies whenever `bright` exceeds it. `{bright: 60, dim: 0}` is the natural
way to author *bright out to here* (see `ramp.normaliseEmission`), so a light written that way
and flipped to a darkness would be 60 feet across with a Radius field reading 0. `syncRadii`
clamps `bright` down to `dim` **only when it exceeds** — the one case that needs correcting —
so an ordinary light, which has `bright <= dim`, survives the round trip untouched.

Two smaller decisions worth having written down:

- **A clamp target stops at Dim.** `clamp` only lowers, so offering Normal or Bright would offer
  a darkness whose most likely setting does nothing.
- **`sync()` runs after every change**, not only after the ones that matter. Working out which
  control affects which other one would be a second dependency graph to keep in step with the
  first, and the function is a handful of DOM reads.

New files: `scripts/model/presets.mjs`, `scripts/ui/light-config.mjs`,
`scripts/ui/scene-config.mjs`, `scripts/ui/settings.mjs`, `templates/*.hbs`, `lang/en.json`,
`styles/config.css`. `module.json` gains `languages` and the extra stylesheet — a **full
Foundry reload**, not an F5, for step 1 and step 5.

> **`lang/en.json` arrived early, 2026-08-26**, carrying exactly one string: the region
> behaviour's type name, which §10.7 explains cannot be anything but a translation key. Step 5
> inherits the file rather than creating it.



Templates go through `foundry.applications.handlebars.renderTemplate`; the global
`renderTemplate` still resolves in v13 but is deprecated.

### 10.10 Light Spill — the submenu

`ui/spill-config.mjs`, an `ApplicationV2` registered with `game.settings.registerMenu` and
`restricted: true`, modelled on `ui/visuals.mjs` (§10.6.1). §10 was declared complete at step 5
on the argument that the remaining rows did not need grouping; this is six new numbers for one
feature, which is the case that argument was making room for.

| Control | Default | Why it is a control |
| --- | --- | --- |
| Enable light spill | on | Patrick asked for the model behaviour to be separable from the rest of the module. Off is a genuine configuration, not a bisection aid. |
| Spill cone angle | 105° | Emission, not occlusion (§3.4). Purely how wide the bright wedge reads. |
| Max spill radius — Bright | 40 ft | Cone radius when `spillTier` is Bright. |
| Max spill radius — Normal | 20 ft | |
| Max spill radius — Dim | 10 ft | |
| Band width | 10 ft | How fast the bands step down. Without it the radii say where the cone ends and nothing says how far the falloff runs. |

#### Sub-rings — built, then removed — 2026-08-27

Play-testing said the ladder read as *"4 lines of decreasing brightness"* rather than a gradient.
Two attempts, both retired. The section is kept because what it found is a **ceiling**, not a bug,
and anyone reaching for either lever again should know it was already pulled.

**A wider blur cannot help, and that is structural.** `spillSoftness` multiplied `groundSoftness`
on spill meshes. It spread each step over more distance and added no steps — *"ground edge
softening has a similar effect, doesn't change the number of steps, but condenses/expands them"*
(Patrick). §6.4.2a's mechanism is one mesh's rim fading to reveal *the mesh beneath*; between two
levels that is a ramp, but there is nothing beneath a stripe except the next stripe. **A blur
softens a boundary between two levels; it cannot invent one between them.**

**Sub-rings worked, and were declined on looks.** `spillSteps` subdivided each band into rings
carrying the band's whole tier plus a `blend` the painter interpolated the level along, with a
picture-only tail band at the interior's tier to cover the Dim→Dark step the ladder structurally
could not reach. It demonstrably worked: the texture readout ramped `0 → 0.044 → 0.088 → … → 0.8`
across seventeen meshes where it had stepped `0 → 0.35 → 0.8`. Patrick declined it — *"I don't
really like the looks of it any higher"* — and the likely reason is that a linear ramp across the
*whole* band leaves no plateau, so the result reads as one smear rather than as bright, then
normal, then dim.

Both are gone, and with them the `blend` plumbing through `field.ambientDomains` and the painter.
`spillSoftness` survives at **0.5** — narrower than ordinary ground, keeping each transition
tight — and the ladder is three tiers again.

**The banding was the blur's tap count — 2026-08-27.** Both retirements above were correct about
their own mechanisms and wrong about the diagnosis. The gradient was not short of *levels*; the
blur drawing it was short of *samples*.

`PIXI.BlurFilter(strength, quality, resolution, kernelSize)` defaults to a **5-tap** kernel, and a
wider blur is achieved by spreading those taps further apart rather than by adding more. At the
measured ~44 px strength across `BLUR_QUALITY` 2, each pass sampled five points about eleven
pixels apart — five discrete contributions stretched over the band, which is a staircase however
smooth the underlying levels are. It also explains why both softening sliders only ever
*condensed or expanded the same steps*: they change the spread, and the tap count stays five.

Fixed by giving spill meshes their own `quality` and `kernelSize` — 4 and 15 by default, against
core's own quality default of 4 (`config.mjs:567`), which we had been below. Confined to spill,
because the cost is per filtered mesh — passes times taps, about six times the sampling — and a
darkness rim wants a soft edge rather than a ramp, so it keeps the cheap blur. Both are settings
(`spillBlurQuality`, `spillBlurKernel`) with no control surface, reachable through
`game.pf1Lighting.settings`, and reported by `render.texture().spillBlur`.

`Canvas#createBlurFilter` does not expose `kernelSize` (`board.mjs:1641`), so the filter is built
directly and registered with `addBlurFilter` by hand — that registration is what keeps the
strength in world units and re-derived on zoom.

**Superseded 2026-08-27 — see §7.0 step 5.** Everything above is the same finding reached three
times from different angles: the ground's brightness is a *field*, and drawing a field as flat
regions plus a blur cannot produce a gradient however the blur is tuned. The answer is a mesh whose
level is a per-vertex attribute rather than a uniform, which the rasteriser interpolates for free.
The two blur settings and the ring subdivision are all approximations of that, and all three come
out when it lands.

A new submenu and new `.mjs` files need only an F5 — `esmodules` names `scripts/module.mjs`
alone and `languages` is already declared. A relaunch is required only if this grows a
stylesheet or a `documentTypes` entry, and it needs neither.

---

## 11. The public API — BUILT 2026-08-28

Patrick, 2026-08-28: *"API time. I want functions to give other mods access to the data we're
creating here."* Two named consumers — an automated **stealth** pass and a **time-of-day** driver —
and a standing rule from the same message: *"if the data is readily available without this mod, we
shouldn't need an API for it unless it really adds to the convenience of getting all the data at
once."*

That rule decides most of the surface, so it is worth stating as the test this section applies:

> **Expose a question only this module can answer, or an answer only this module can assemble
> cheaply.** Everything else stays core's.

By that test `canvas.grid.measurePath`, token distance, wall collisions, ownership and the raw
`scene.environment.darknessLevel` are all out. What is in is the **tier ladder**, the
**observer-relative** answer, and the **assembly** — the one call that returns what a stealth check
needs instead of nine.

### 11.1 The three questions the module actually owns

| Question | Owned because |
| --- | --- |
| *How bright is it here?* | §3.1's tiers exist nowhere else. Foundry has a `[0,1]` darkness scalar and four lighting levels that mean something different. |
| *How bright is it here **to you**?* | §4.3's umbra and §4.8's perception model. Core has no notion that brightness differs per observer. |
| *What light level is this scene, as a rung?* | §10.5 — the scene stores a tier and the number is derived output. Reading `darknessLevel` back gets you the number, not the decision. |

Everything proposed below is one of those three, or an assembly of them.

### 11.2 Shape

Versioned, and deliberately **separate from the existing `game.pf1Lighting.*` console surface**.
Those are debug readouts — they log to `console.error`, change signature whenever a diagnosis needs
a new field, and several return live internal objects. A consumer that binds to them will break,
and should. `api` is the half that promises not to.

#### 11.2.1 Two addresses, one object

```js
game.modules.get("pf1-lighting").api   // what another module uses
game.pf1Lighting.api                   // console alias — same frozen object
```

**`game.modules.get(id).api` is the address**, and it is not a style preference. It is Foundry's
own convention, it is what this project's other modules already publish (`astora-mod`) and consume
(`ckl-roll-bonuses`), and a module author looking for our API will try it first and find nothing
else. `Module` declares no `api` property in the v13 schema — it is an assignment onto an ordinary
object — but it is universal, and being reachable only through a convention we invented is the
same as not being reachable.

**`game.pf1Lighting` is ours and exists for one reason**: `pf1-lighting.api` is not typeable. The
hyphen is a minus sign, so it parses as `pf1 - lighting.api`, and the only bare-global form would
be `globalThis["pf1-lighting"].api`. A camelCase alias under `game.` is typeable, tab-completes,
and keeps a module-shaped name out of the true global namespace.

**Published at `init`, not at `ready`, and that is substance rather than tidiness.**
`game.pf1Lighting` is assigned in `ready`; an API assigned there races every consumer's own `ready`
on module load order, so whether it exists at the moment someone reaches for it would depend on
alphabetical luck. Nothing in the built object touches the canvas or reads a setting — it is
function references and frozen constants — so there is nothing for `init` to be too early for.

```js
const api = game.modules.get("pf1-lighting")?.api;
api.version            // integer, incremented on breaking change
api.TIER               // { SUPERNATURAL_DARK: 0, DARK: 1, DIM: 2, NORMAL: 3, BRIGHT: 4 }
api.tierName(tier)     // "Dim"
```

Tiers cross the boundary as **numbers**, and the numbers are ordered, so `>=` is meaningful and a
consumer can compare without importing anything.

### 11.3 Brightness

```js
api.brightnessAt(point, {observer} = {})         // -> tier
api.brightnessOf(token, {observer, sample} = {}) // -> tier
api.brightnessInSquare(point, {observer, sample} = {})
api.brightnessAtMany(points, {observer} = {})    // -> tier[]
```

Three things this has to settle that the one-line request does not.

**`observer` is the whole feature.** Omitted, the answer is god's eye — the model's own tier, which
is what a GM sees and what the readout reports. Passed a token, the answer is
`perception.perceivedTier`: the same point, clamped by any umbra between that token and it. The two
genuinely differ, and a consumer that does not know which one it asked for will produce a rules
bug — so this is not an optional parameter with a harmless default, it is two different questions
sharing a function.

**The batch form is not sugar.** `evaluate` reads the field, and the field rebuilds when the
registry version moves. Ten separate calls in a stealth pass can pay that ten times; one call with
ten points pays it once. Use case 1 is exactly N observers by M points, so this is the shape that
makes it affordable.

**Sampling is undefined today and has to be chosen.** `probe.tokens()` samples the token's
**centre and nothing else** — there is no averaging anywhere in this module, which contradicts the
premise of the request (*"average it the same way we average token lighting"*). A Large creature
straddling a light boundary has no single tier, and the defensible answers are different rules for
different purposes:

| `sample` | Rule | Fits |
| --- | --- | --- |
| `"center"` | the centre point | matches today's readout; cheapest |
| `"min"` | darkest tier over the footprint | **hiding** — you take cover in the dark part |
| `"max"` | brightest tier over the footprint | **being seen** — an observer needs only one lit part |
| `"average"` | area-weighted mean, re-thresholded | one "how lit is this" number; matches no rule |

Recommendation: **`"center"` as the default** — it is what exists and what the tooltip agrees with —
with `min` and `max` available, because the stealth case genuinely wants `min` for the hider and
`max` for a target being shot at. `average` is offered last and named as the one with no rules
meaning.

Footprint sampling walks the token's occupied grid spaces, so cost is `O(spaces)`: a Gargantuan
creature is 16 samples. That is the other reason the default is not `average`.

### 11.4 The observer/observed pair

```js
api.perceive(observer, observed) -> {
  visible,            // boolean — would core show it
  reason,             // "basicSight" | "lightPerception" | "seeInvisibility" | "feelTremor"
                      //   | "visionLight" | null
  reasons,            // every mode that answers true, not just the first
  tier,               // the tier the observer perceives the target's space at
  lightIndependent,   // does `reason` consult light at all
  blinded,            // the observer's own vision is blocked
  distance,           // scene units — bundled because every consumer recomputes it
  losBlocked,         // sight collision between them
}
```

**Core will not tell you which mode won, and that is the interesting part of this section.**
`CanvasVisibility#testVisibility` short-circuits on the first `true`
(`groups/visibility.mjs:735-792`) and returns a boolean. It does, however, run every mode through a
**public per-mode entry point** — `CONFIG.Canvas.detectionModes[id].testVisibility(visionSource,
modeConfig, config)` — and builds its argument with
`canvas.visibility._createVisibilityTestConfig(point, {tolerance, object})`.

So the answer is to run core's own loop, in core's own order, **without the short circuit**, and
record every mode that says yes. That is not a reimplementation: the rules stay inside core's mode
instances, which is also what makes it compose with PF1's replaced `seeInvisibility` and with
`limits`' wrap of `_testPoint`. Three details that are easy to get wrong:

- **A vision-granting light is a fourth route**, tested before any mode
  (`visibility.mjs:745-749`): `lightSource.data.vision` with `lightSource.testVisibility(config)`.
  It has no mode id, hence `"visionLight"`.
- **`visionSource.isBlinded` gates `basicSight` and `lightPerception` but not the special modes** —
  a blinded creature still feels tremors. Reproducing that gate is required for a correct answer.
- **`testVisibility` mutates the target.** Winning a special mode assigns `object.detectionFilter`
  (`visibility.mjs:788`), so a probe has to save and restore the field around the call or it leaves
  a rendering artefact behind.

`lightIndependent` is derived, not detected: `basicSight` (where PF1 puts darkvision), `feelTremor`
and blindsight do not consult light; `lightPerception` and `seeInvisibility` do. It is the field
use case 1 actually branches on, so the module should own the mapping rather than have every
consumer re-derive it from mode ids.

#### 11.4.1 The problem this surface has to solve first

**A token that is not a vision source has no `vision` object at all.**
`Token#initializeVisionSource` calls `#destroyVisionSource()` whenever `_isVisionSource()` is false
(`placeables/token.mjs:868-880`), and that is false for every token the current user does not own or
control. For a stealth check the interesting observers are exactly those — the NPCs.

Three ways out, and only one is honest:

1. **Build an ephemeral source.** `new CONFIG.Canvas.visionSourceClass({object: token})`, initialise
   it from `token._getVisionSourceData()`, query it, destroy it. One polygon sweep per observer.
2. Require the GM to control everything first. Not viable.
3. Answer without a source — distance, a wall collision and `evaluate`. Cheap, and it silently
   drops umbra and every detection mode, which is most of the value.

**(1), with the cost stated.** A sweep is the expensive operation in this module (§9.6), so a
20-NPC pass is 20 sweeps — entirely affordable **once**, and unaffordable per frame. The API should
therefore make the batch form the obvious one, and say plainly that this is a question to ask on a
die roll, not on a hook that fires during movement.

```js
api.perceivedBy(observed, {observers, sample} = {}) -> PerceiveResult[]
```

One call, one field build, one sweep per candidate observer, sorted by whether they see it.
`observers` defaults to every token on the scene that has sight; the caller narrows it.

### 11.5 The scene's light level

Mostly built already — §10.5.2 landed `setSceneTier` this session. What the API adds is the read
side and a change signal.

```js
api.sceneTier(scene?)              // -> tier, from the flag, falling back to the nearest rung
api.setSceneTier(tier, scene?)     // -> Promise<tier|null>; GM only, refuses a locked scene
Hooks.on("pf1-lighting.sceneTierChanged", (scene, tier, previous) => {})
```

**A per-scene opt-out is the part use case 2 needs and did not ask for.** *"Automatically change
scene brightness based on time of day"* is correct for a street and wrong for a dungeon, a cave and
every interior, and a driver that cannot tell them apart will darken a sealed crypt at dusk.

**Core's darkness lock is that control and no new flag was built** (Patrick, 2026-08-28 — see
§11.8). `setSceneTier` already refuses on it, so a driver that skips locked scenes is safe by
construction and needs to read nothing of ours. The proposal this paragraph originally made — a
`flags.pf1-lighting.tracksTimeOfDay` checkbox beside the light-level dropdown — is **not
implemented**, and the difference it would have made is the one thing to know before relying on
the lock: the lock means *frozen*, so a locked dungeon is also beyond the GM's own dropdown, where
a `tracksTimeOfDay` flag would have left it hand-settable and merely ignored by the clock. Worth
building only if that distinction turns out to matter in play.

The hook exists because the alternative is polling. `updateScene` fires for the underlying number,
but a consumer would then have to re-derive the tier and filter out its own writes.

### 11.6 What is deliberately absent

- **Anything that sets a light's configuration.** `light.document.update()` is core, and
  `presets.apply(name)` already returns the flat update object. Nothing to add.
- **Wall, distance, ownership and token-shape queries.** Core, per the rule at the top.
- **A "can this token hide" verdict.** The API reports light and detection; whether *hidden* is
  legal is a PF1 rules question involving cover, concealment, size and feats, and it belongs to the
  consumer. `tier <= TIER.DIM && !lightIndependent` is the light half of it, and that is what the
  API should say before stopping.
- **Anything on the render side.** Meshes, filters and the texture are implementation.

### 11.7 The two use cases, walked

**Stealth.** One call to `api.perceivedBy(hider, {sample: "min"})`, then partition:

| Bucket | Test |
| --- | --- |
| cannot see at all | `!visible` |
| automatic — no check | `visible && tier >= TIER.NORMAL && !lightIndependent`, plus the caller's own rules |
| rolls Perception | everything else, with `distance` for the DC and `reason` for the flavour |

The middle row is the one the API cannot finish and should not: whether bright light makes
detection automatic is a table ruling, and a `lightIndependent` observer bypasses the light
question entirely.

**Time of day.** A driver reads the calendar, maps an hour to a tier, and calls `api.setSceneTier`
on each outdoor scene. It does not have to filter: a locked scene returns `null` and is left alone,
so **locking the dungeons is the whole configuration step**. Simple Calendar Reborn is already in
the workspace and already has one consumer in `tension-pool-tab`, so the integration target is
known. The hour-to-tier mapping is the driver's, not ours.

### 11.8 Decisions, and what is left open

Settled by Patrick, 2026-08-28:

- **Sampling.** *"Average was the wrong term — we should determine a grid cell's light the same way
  we determine a token's light."* So one rule, and it is the centre point — what `probe.tokens()`
  has always used and what the readout agrees with. A token and the square it stands in cannot now
  disagree, because they are the same query. `min` and `max` ship as opt-in for the stealth
  asymmetry; `average` is not offered at all.
- **Ephemeral vision sources.** *"These calls would be intended as a one-off when someone makes a
  roll."* Confirmed, and the sweep cost is documented at the function rather than hidden behind a
  cache that would go stale on the first wall.
- **Batching by argument.** *"Can we have the api call take arrays to allow for this?"* Every query
  takes a subject or an array of them and returns the matching shape. `perceive` is the one
  exception and says so — a matrix has no scalar shape, so it returns one record per pair with both
  ends named.
- **The darkness lock is the write guard, and nothing new was built.** *"There's already a darkness
  level lock in scene config. Can we use this for preventing the api from changing scene
  brightness?"* It already does: `setSceneTier` has refused on it since §10.5.2, because
  `Scene#_preUpdate` silently deletes `environment.darknessLevel` from a locked update, so writing
  anyway would report a success that did not happen. The consequence to know is that the lock means
  *frozen*, not *not clock-driven* — a locked dungeon cannot be changed from the dropdown either. A
  scene that should stay hand-settable while a clock ignores it would need a second flag, and does
  not have one. The `tracksTimeOfDay` proposal above is therefore **not built**.
- **The change hook.** `pf1-lighting.sceneTierChanged`, fired from `updateScene` rather than from
  the writers: every route converges there, including a write from another client, and firing per
  writer would miss that one and double-fire on a preview. It fires only when the *rung* moves, so
  a slider nudge inside a rung stays quiet.

Still open:

1. **`lightIndependent` for modes we do not ship.** The mapping is by mode id and answers `null` for
   an unknown one, so a consumer can tell *"this sense ignores light"* from *"we have never heard of
   this sense"*. `api.registerLightIndependentMode(id)` adds one.
2. **Ephemeral sources and `limits`.** Building a vision source outside `initializeVisionSource`
   skips whatever another module does on that hook. `limits` wraps `_testPoint` on the *mode*, which
   still applies; anything decorating the *source* would not. Untested.
3. **Elevation.** Carried through every signature and then ignored by the model (§3.6), so the
   signatures do not have to change on the day §3.6 does.
4. **Footprint sampling off square grids.** v13 has no `getOccupiedGridSpaceOffsets`, so `min`/`max`
   walk the token bounds at grid pitch — correct on square grids, approximate elsewhere. Only
   reached when a caller opts out of `center`.

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
next door is visible and wrong.

*The exception, and its exact terms — 2026-08-26.* §3.4 dilates deliberately, and what makes it
safe is not the max-combine rule but the composition `(white ⊕ k·d) ∩ vis ∩ region`, where
`vis` is a 360° wall-occluded sweep from the window. The dilation supplies distance; the sweep
supplies occlusion; neither is asked to do the other's job. A bare dilation, or one clipped only
to the region, is still the rejected thing — the interior door tapering into the room next door
is precisely what `∩ vis` removes. **Do not read this as a general licence to dilate.**

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
2. ~~**Spill vs umbra ordering** (§3.4 vs §4.3).~~ **Closed 2026-08-26 — resolved by
   construction.** Spill is an ambient area, so it lands in `field()`'s cells; umbra is applied
   over those cells as a clamp in `render/paint.mjs` and post-contest in `perceivedTier`. Umbra
   wins where they overlap because it runs strictly later on strictly the same data. Nothing
   asserts the ordering any more; nothing can express the other one.
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

## Appendix B.5 — What a change needs to take effect

Recorded because it was answered inconsistently across four rounds of 2026-08-27, twice by
overstating it, and it is not a judgement call — it follows from one line of the manifest.

`module.json` declares exactly **one** esmodule, `scripts/module.mjs`. Every other script is reached
through its import graph.

| Changed | Needs |
| --- | --- |
| any `.mjs`, **edited or new** | **F5** |
| `styles/*.css` or `lang/en.json` **contents** | **F5** |
| `module.json` **itself** — a new `esmodules`/`styles`/`languages`/`packs` entry, version, compatibility | **restart** — Return to Setup and relaunch, or restart the server |
| compendium packs | **restart** |

F5 reloads the page, which re-fetches and re-evaluates the whole module graph and re-runs `init`,
`setup` and `ready`. **A new file is not a special case** — it is one more import, and the question
is whether anything imports it, not whether it is new. A new `.mjs` nothing imports loads not at all
and reports no error.

A restart is only ever about the **manifest**, which Foundry reads server-side at world launch and
caches. Leave `module.json` alone and a restart is never required.

Two things need less than F5, and knowing which saves a reload:

- **Settings read live** — `transitionWidth`, `unseenDimming`, `greyscaleInFog`, the tier table —
  take effect on change. `regionalGreyscale` is a half-case worth knowing: switching it **off**
  detaches the pass immediately, but cannot un-zero the five routes `neutralise` disabled at
  `setup`, so the picture goes to *no* greyscale rather than back to Foundry's. Switching it **on**
  in a world that loaded with it off needs F5, because `neutralise` was skipped.
- **Everything else needs F5 rather than `canvas.draw()`.** The CONFIG class swaps and prototype
  patches (`visibilityFilter`, `visualEffectsMaskingFilter`, `globalLightSourceClass`, the darkness
  layer's `_draw`) are install-once-per-page-load and guarded by flags, so redrawing the canvas will
  not reinstall a changed one. That guard is deliberate — see `render/ambient.applyMixin` on why the
  global light source in particular cannot be re-patched after `init` — and it is also why a stale
  patch looks exactly like a patch that is working.

## Appendix C — Built but unverified in play

Things asserted correct from reading and construction, but **not yet confirmed on a live
scene**. This list exists because on this project the two have diverged repeatedly — §4.1.1's
five suppression paths were each read, each plausible, and each wrong about the cause until
observed behaviour settled it.

Clear an entry only after seeing it work, and delete it rather than annotating it.

### Awaiting the next play session

#### §3.4.1 light spill — the geodesic rewrite, 2026-08-28

Play-tested through five rounds and signed off: *“ok, that fixed it.”* The bands, the contours, the
one-march-per-room grouping, the per-tier ladder, and both eligibility fixes were each provoked and
confirmed on a live scene. Not carried here as unverified.

**Three things are worth a second look when convenient, none blocking:**

- **Does the falloff band?** §7.0 step 5’s gradient mesh is dormant — `spill.ramps()` returns empty
  — on the bet that 40/20/10 ft bands are wide enough to read on §6.4.4’s blur alone. If the steps
  are visible, ask `geodesic.contour` for quarter-band thresholds instead of tier thresholds and
  hand the rings over with the distances they already carry. §3.4.1 has the detail.
- **A double-drawn wall now needs the window cut in both faces.** The occlusion probe (§3.4.1) is
  exact about what separates two samples, so an inner face standing behind an outer one blocks it.
  Believed correct rather than regressive; `spill.stats().rejected.occluded` counts it if not.
- **A 1.25 ft gap no longer passes light** at the default 25 px resolution, where 2.5 ft does. Almost
  certainly the right answer for a slot that narrow, but it is a behaviour change from the old
  construction and nobody has met one in play yet.

#### The intermittent brightness fault, 2026-08-28 — closed

Four rounds of wrong diagnoses before §6.2.13 found it: a pooled source keeping the previous
occupant’s `color`. Worth recording what the wrong turns cost, because the shape recurs.

The fault was **intermittent, cleared on reload, and left the overlay correct**. Each of those
pointed away from the model and at reused state, and each was individually explained away instead —
as a stale cache, as a threshold, as a cap. The colour cast was the decisive clue and it arrived
last: an *orange tint matching a light that was switched off* can only be a copy held somewhere no
live source owns.

> **Intermittent + clears on F5 + model is right = something is being reused, not something is being
> computed wrong.** Reach for the pool before the model. Three of the four faults this shape has
> produced in this module were pooled-source state; none was ever arithmetic.


#### Cleared 2026-08-27 — the rendering rewrite

Patrick, at the end of the session: *"I think we're looking good on the lighting rendering side of
things."* That clears, as a group, everything built between §6.2.9 and §6.4.6 — absolute light
zones, lights as brightness regions, the one-width transition, the field blur, the softened reveal
boundary, and the withholding fix. Each was play-tested as it landed and the picture was signed off
as a whole rather than entry by entry, which is why they come out together.

Two follow-ups worth checking on the next session rather than blocking on:

- **`render.paint().ms`** was 41 ms with the geometric halos. With `blurTransitions` on they do not
  run at all, so it should have fallen sharply. If it has not, the cost is `applyShadows`' successor
  or the light ramps, not the halos.
- **`blurTransitions: false`** is still a working path and is the only way back to per-region
  gradients. It has not been looked at since §6.4.5 and §6.4.6 changed what sits either side of it.

#### 6.2.12 Band overlaps belong in the field — BUILT 2026-08-27

Reported as: *"overlapping lights can create an area of brighter light... they provide +1 to the
light level, to the maximum of normal, so 2 dim overlaps should be rendered to normal"* — with the
tooltip reading the lens correctly and the picture not.

That is `contest.stack`'s `Σn` half of §3.2.1: set levels contend, relative bands **sum**, capped at
`max(cap)`.

##### Nothing was missing, and two diagnoses were wrong before that was noticed

`model/field.mjs:1091` already emitted a `stack` cell for every band overlap, and
`render/renderer.mjs` already drew it — one clone per participating emitter, at that emitter's own
origin, radii and attenuation, band raised to the resolved tier. A complete implementation, gated
behind `showStackedOverlaps`, which **defaulted to `false`**.

> **Both first answers blamed a mechanism for being incapable of something it was never asked to
> do.** `light-ramps`' `MIN_COLOR` genuinely cannot sum; `cell-overlay`'s `resolvedPartition`
> genuinely resolves brightest-wins. Both true, neither the cause. The readout that settled it was
> in the first console line of the session — `overlay.draw()` reported **`5 stack`**, which is the
> field saying it had already done the work.
>
> **The rule: before concluding a rule is unimplemented, grep for its name.** `kind: "stack"`
> appeared in three files and one of them was a 55-line implementation with its own design note.

##### The flat fill was wrong, and stopped being wrong

`renderer.mjs`'s note says a flat fill was tried first and rejected: a Foundry light is very nearly
all gradient — `SWITCH_COLOR` blends the two zones across 72% of the ratio, `FALLOFF` ramps the
outer half on top — so *"a plateau butted against that reads as a step however accurate its value"*.
Correct at the time, and **the premise died with §7.0 step 6**. A light is no longer a falloff; with
the field blur on it is `emitFlat`'s two flat zones. A flat overlap butted against flat zones is the
same kind of thing as its neighbours, and one blur finds every one of those boundaries.

So `light-ramps.stackRampFor` draws the overlap as a region in the brightness field, `MIN_COLOR`, at
the resolved level — brighter than either band beneath it, so it wins where it lands. Patrick,
2026-08-27: *"I want those areas to be incorporated into `render.texture` and rendered that way
rather than illuminated individually."*

Three things follow for free: `getDarknessLevel` inside an overlap now reports the model's tier
rather than the brighter of the two lights; `ui/cell-overlay.levels()` shows it, because it reads
the ramps; and the overlap fades over the same `transitionWidth` as everything else.

With the blur **off** the region gets a collar of its own — interior at the resolved level, a
`transition.width()` band fading to **1.0** at the rim. One is the darkest value the channel holds
and `min(x, 1)` is `x`, so the collar's outer end contributes nothing and the light beneath comes
back through: the `MIN` mirror of the `MAX` trick `clampRamps` plays. Skipped when the blur is on,
or the boundary would be softened twice at two widths — the state §6.4.3 exists to end.

The illumination clones are **kept for `lightsInTexture: false`**, where the flat-fill objection is
still true, and switched off otherwise: running both would paint the overlap twice by two mechanisms
that disagree about shape, and the clones still use the constant-tier-colour path §6.4.6 found
re-lights a region and cuts off hard at its clip boundary.

`showStackedOverlaps` now defaults to **`true`**.

##### Two tool faults it exposed, both fixed

- **`ui/cell-overlay.draw()` never drew the `stack` kind.** `STYLE.stack` was defined with a comment
  calling it *"drawn last and hottest… the one kind whose existence is the interesting fact, since
  the shader cannot show it unaided"*, and the kind was then omitted from the `order` array directly
  beneath it. Computed, counted in `byKind`, never drawn — which made the overlap look absent from
  the model as well as from the picture.
- **`overlay.draw()` returned `undefined` and drew nothing** when the `cellOverlay` setting was off,
  silently. It now enables the setting through `show()` — so the token-refresh hook path keeps its
  gate — and returns the stats it logs.

> **Still missing, and it is the third instrument.** `overlay.draw()` shows the field's cells and
> `overlay.levels()` shows what the renderer painted; both are downstream of the decomposition.
> Nothing displays `evaluate()`'s answer across a scene — it reaches the screen only through the
> per-point tooltip. Had the field lost the summation too, all three views would have agreed and all
> three would have been wrong. A grid sampler painting `evaluate()` per square is the companion to
> `transect` (is this edge smooth) and `isolate` (which layer owns it).

#### 6.2.13 A pooled source keeps what the payload does not mention — FIXED 2026-08-28

Patrick, 2026-08-28, after four rounds on an intermittent brightness fault: *"this time it's adding
an orange tint to the incorrect lighting that seems to match the tint of another light on the scene
(the one I turned off in the screenshot, seeing if disabling it would clear the bug — it did not)…
I really feel like we aren't holding to the paradigm of the overlay model being the only thing that
affects lighting in the scene."*

Correct, and the violation was §9.5's pool rather than anything in the model.

##### The mechanism

`BaseEffectSource#initialize` writes only the keys the payload **mentions**, and `reset` defaults to
`false` (`base-effect-source.mjs:126160-126174`):

```js
for ( const key in data ) {
  if ( !(key in this.data) ) continue;
  this.data[key] = data[key] ?? this.constructor.defaultData[key];
}
```

On a fresh source that is harmless — everything is at its default already. On a **pooled** source it
means an omitted key silently inherits the previous occupant's value. The `??` inside that loop is
the escape hatch: an explicit `null` resolves to the class default, which is the reset a fresh
source would have had.

`pool.fill` spread two keys in conditionally:

```js
...(color !== undefined ? { color } : {}),
...(seed  !== undefined ? { seed  } : {}),
```

directly beneath a comment explaining why that shape is wrong for a third:

> *Pooled, so these are assigned unconditionally rather than only when present — a source reused
> from an animated clone into a still one would otherwise keep flickering.*

`animation` had been fixed for exactly this failure and the neighbouring keys were left alone.

The call sites made it certain rather than merely possible. All three in `render/renderer.mjs`
passed `source.data?.color ?? undefined`, and an **uncoloured light's `data.color` is `null`** — so
`null ?? undefined` is `undefined`, and the key vanished at precisely the moment the payload most
needed to say *no colour*.

##### Why every symptom followed

- **The tint belonged to the pool slot, not to a source.** Switching the orange lamp off changed
  nothing; the slot had its own copy.
- **Moving the lamp to dim changed the colour** rather than clearing it — a different partition, a
  different slot, a different previous occupant.
- **It needed pool reuse to appear**, so it was intermittent, and churning global illumination and
  doors provoked it: that churns the cell partition, which is what reshuffles the pool.
- **F5 always cleared it**, because `dispose()` destroys the pool.
- **The overlay stayed right throughout**, because the model has no colour axis at all. Brightness
  came from the texture exactly as §7.0 step 6 intends; a stale *source* was painting coloration
  over the top.

##### Where the paradigm line actually sits

§6.2.10 reads as though the model owns everything. It owns **brightness**, and has since §7.0
step 6. It does not own **colour** — §6.2.9 keeps a light's colour, flicker and animation coming
from the real source on purpose, because the model has no colour axis to express them with.

So the rule this leaves is narrower than §6.2.10's and still absolute:

> **No source may paint colour on ground no live light reaches.** Brightness is the model's alone;
> colour belongs to whichever source is actually there, and to no other.

##### The general lesson

**Anything reused across frames must state its whole payload, every time.** A conditional spread is
correct for a freshly constructed object and a latent bug for a pooled one, and the two read
identically at the call site. §9.5 exists because construction dominates the renderer's cost, so the
pool is not optional — which makes "assign unconditionally" a standing rule for everything that goes
through `pool.fill`, not a fix for two keys.

The three earlier faults this resembles are all the same shape: four bugs from cloning
`GlobalLightSource` property by property (§7.0), a split cell's clones never carrying their
animation (§7.0), and a pooled *darkness* clone that nothing ever wrote `HIDDEN` to (2026-08-25).
Four occurrences is a pattern, and the pattern is the pool.


#### 10.6.2 Settings audit — 2026-08-27

A second pass over every registered key, prompted by *"are there any settings that no longer make
sense to have for the mod?"* after a session that added three and retired none. Thirty-two keys,
audited by matching each `register` against its reads. **No key came out dead**, which is itself
the finding: the 2026-08-26 pass removed the ones that were, and everything since has been load
bearing. Four things did change.

**A duplicate came out.** *Transition width* appeared in both *Configure Visuals* and the *Light
Spill* window, editing the same setting. Patrick: *"transition width in light spill can go too —
it's a duplicate to brightness transition width."* Repeating it there was defended on the grounds
that a spill falloff is where the width shows most — true, and it still cost more than it bought:
one setting on two forms means two *Restore defaults* buttons that disagree about what they reset,
and a number that reads as a spill property when it governs every boundary in the module.

**A switch had outlived its name.** `desaturateDarkness` gated two unrelated things — the darkness
shader's desaturation and blindsight *withholding* — because they arrived together. §6.2.11 made
the first inert by default, leaving a switch whose only remaining effect was to silently disable a
rule it does not name. The withholding is no longer gated: it is a correctness rule, not a
preference, and there is nothing for a setting to be on either side of. The key stays as the
documented fallback for worlds that turn the takeover off, relabelled to say so.

**A hint had gone stale.** `edgeSoftness` is still live, but §7.0 step 6 changed what it does. It
insets the source's mesh geometry, and the *illumination* mesh is now withheld — so what it
actually governs is the **coloration** mesh: a light's colour edge, not its brightness edge, which
fades over `transitionWidth` instead. Both its hint and its row in *Configure Visuals* said
otherwise.

**Two more rows came out, and the count is the smaller half of why.** *Light edge softening* and
*Darkness edge softening* keep their settings and their console access; they lose their rows
(Patrick, 2026-08-27: *"too niche to take up settings space"*). The real argument is that both tune
a **source's mesh edge**, which is a different and much rarer thing than the boundaries between
brightness levels that the rest of the window is about — and since §7.0 step 6 the light one governs
only a colour wash. A GM reaching for "make the edges softer" wants *Brightness transition width*
essentially always, and two neighbouring rows that sound like they mean the same thing are how they
reach for the wrong one.

`edgeSoftness` drops from `0.3` to `0.05` with them. The larger value existed because §6.4 found a
clipped light abutting one of our regions read as a hard step — a *brightness* complaint, and
brightness has not come from that mesh since §7.0 step 6. `darknessSoftness` was already at
Foundry's own `0.5`.

> **Changing a `default` moves nothing in an existing world.** A default applies only where no
> `Setting` document exists, and saving Foundry's settings form persists every registered key — so
> any world that has ever saved it keeps `0.3`. The same trap as `showStackedOverlaps` earlier the
> same day, and it is now twice in one session:
> `game.pf1Lighting.settings("edgeSoftness", 0.05)` is the only thing that actually moves it.

**The window needed a scroll.** Ten controls put *Save* off the bottom of a 1080p screen; it is
eight now, and the scroll stays for small screens and for the next row. It is on a wrapper inside
the form with the footer outside it, capped at `calc(100vh - 260px)` rather than a pixel height, and
inline rather than in `styles/` — the module's CSS is unlayered and outranks core's, so a stray
`overflow` rule is the leak `feedback_css_scope_every_selector` records, and one attribute cannot
leak.

> **The audit script was wrong twice and both false positives are worth knowing.** It reported
> `edgeSoftness` and `darknessSoftness` at zero reads — they are read through a local `read()`
> helper, not `game.settings.get` directly — and reported `spillEnabled` registered twice, having
> resolved a same-named `SETTING_ENABLED` const in `ui/readout.mjs` against the wrong literal.
> **A grep for `settings.get` under-counts any module that wraps its own reads**, which is most of
> them here.

#### Awaiting a look — §6.4.7, walls held sharp

Built 2026-08-27, unverified. `game.pf1Lighting.render.blur()` reports it, and
`game.pf1Lighting.render.walls()` on its own. In the order things would go wrong:

- **`wall.segments: 0` on a walled scene** is the interesting failure: every edge reported
  `light === NONE`, either because the scene's walls genuinely pass light or because the property
  moved. Compare against `wall.edges`, which is `canvas.edges.size`.
- **`composited: false` with `sharpWalls: true`** means the container is still carrying the plain
  blur, so the picture is unchanged from before.
- **Bleed still visible** with both of those healthy means the band is too narrow — it is
  `2 × transitionWidth` and that constant is `BAND` in `render/wall-mask.mjs`.
- **Too much held sharp** is the opposite complaint and the same constant. Watch for it around
  lights that sit close to a wall without being cut by it.
- **Doors.** Opening one changes `edge.light` without moving anything; the mask hooks
  `canvasEdgesRefresh` as well as the wall CRUD hooks for exactly that, and a door that opens
  without the bleed changing is the sign that hook is not firing in this Foundry build.

#### Cleared 2026-08-27 — the greyscale takeover

Patrick, after the clamp-collar fix: *"looking like it's all behaving well so far as I can tell
now."* That clears §6.2.11 — the five routes neutralised, the single pass on `canvas.environment`,
tokens greying with the ground, and `clampRamps` no longer collaring its own holes.

Two things it changed that nobody has had a reason to look at yet, and neither is a suspicion:

- **`greyscaleInFog`** sits at 0.5 and has only been seen there. 0 is the literal ask (remembered
  terrain in full colour) and 1 is what Foundry did. The concern that made it a dial rather than a
  switch is in §6.2.11 and still stands: the boundary is the vision polygon, and it moves.
- **`regionalGreyscale: false`** is now a *third* state rather than "off". It detaches the pass but
  cannot un-zero the vision mode, so the picture goes to no greyscale at all rather than back to
  Foundry's. Only an F5 restores core's behaviour. Fine, and written down because a world that
  turns it off mid-session will see something neither of us intended.

#### Open, and named by Patrick as the next work

**§3.4 spill geometry — the only one left.** Not a transition fault, and untouched by the rendering
rewrite, the greyscale takeover or §6.4.7. With the brightness map on, a spill inside a region
resolves into **long thin slivers** alternating between the band tier and the room's own, rather
than into coherent bands. The shape is characteristic of the `vis`/`bend` sweep union being cut
against the region outline — many narrow wedges from the corner sweeps surviving the intersection —
rather than of anything in the ramp that draws them.

##### Where to start, in order

1. **`game.pf1Lighting.settings("<key>")` before anything else.** On 2026-08-27 two rounds were
   spent proving a rule was unimplementable when the implementation existed and its switch
   defaulted to `false`. §3.4 owns six numbers and a window (§10.10); read them first, and read
   `render.gradient().rejected`, which names every reason a ramp was not built including
   "the setting is off".
2. **`game.pf1Lighting.overlay.draw()`** — the field's own cells, in kind colours. This is the
   **model's** answer. `spill` bands appear here as their own cells.
3. **`game.pf1Lighting.overlay.levels()`** — what the renderer painted, resolved brightest-wins.
   Both take `(false)` to turn off, or bare to toggle.

**A sliver in (2) is `model/spill.mjs`. A sliver only in (3) is the renderer.** That separation is
the whole point of having both, and it is what settled the band-overlap question in one call. If
they disagree, note that both are downstream of the cell decomposition — nothing yet displays
`evaluate()`'s analytic answer across a scene, so a fault in the decomposition itself would show in
neither. Building that grid sampler is the standing companion task and is the honest first move if
(2) and (3) agree and both look wrong.

`spill.spillAreas()` is the model's own list, `spill.stats()` its counters, and `spill.rebuild()`
forces a recompute.

##### Two lessons from 2026-08-27 that apply directly

- **Before concluding a rule is unimplemented, grep for its name.** `kind: "stack"` appeared in
  three files and one of them was a 55-line implementation with its own design note.
- **A wrong picture downstream of the field is usually a right reading of a wrong field.** Reach for
  `render.transect()` and the overlays before touching the rule that draws it. Three separate
  diagnoses that day blamed the consumer and the fault was upstream every time.

#### The two instruments, and the order to use them

Neither existed before 2026-08-27, and the three rounds before them were spent guessing at edges
from screenshots. The division between them is the useful part:

1. `game.pf1Lighting.render.transect()` — hover an edge. **Is the brightness field smooth here?** A
   ramp means yes and the hard edge belongs to a layer this texture does not contain; a step means
   the blur is not reaching.
2. `game.pf1Lighting.render.isolate("coloration" | "darkness" | "lights" | "visibility")` — **which
   layer owns it?** Only worth asking once (1) has answered *yes*. Each candidate has a different
   softening mechanism, which is why they are indistinguishable by eye and immediate by bisection.

`game.pf1Lighting.overlay.levels()` answers the third question — *is the model even claiming what I
think it is* — as a resolved partition, so any overlap left on screen is a real fault.

**Untested: the two vision-masking corrections, §6.2.7 and §6.2.8, 2026-08-27.**
`game.pf1Lighting.render.darknessMask()` first. `fogFilter: false` with `fogIgnoresModel: true`
means the CONFIG swap did not take, which on a live world means another module replaced the class
after `init`. `sceneDarkness: null` means the illumination layer has no filter, which is a much
larger problem than this one. `applied: false` is the §6.2.7 half not installed, and
`enableVisionMasking: false` with `tokenVision: false` is the scene disabling every mask including
core's own three — correct rather than broken.

Then, in order. A *darkness* in an unseen room should be gone from the fog entirely, and stay gone
while it moves. Walking a token into line of sight should reveal it. A bubble half in view should
be clipped at the vision boundary exactly as a light already is. An **umbra** in an unseen area
should likewise no longer show.

Two things to check because they are the accepted costs rather than bugs: a §10.7 region should
now read at scene brightness in unexplored area rather than dark, and *daylight*-lit or
region-brightened ground should be equally invisible in fog — the change is symmetric and cannot
single out darkness.

And one to check because it is where a mistake would hide: with **Token Vision off**, the whole
map should look exactly as it did before either patch existed. Core turns `enableVisionMasking`
off across every registered filter there, and the fog branch is only reached through it.

**Untested: light spill, §3.4 / §10.10, 2026-08-26.** `model/spill.mjs`, `ui/spill-config.mjs`,
three branches in `model/areas.mjs`, and `field.mjs` untouched. Start with
`game.pf1Lighting.spill.stats()` before looking at the map, because four of the ways this does
nothing are invisible and two of them look identical:

`candidates` counts light-passing wall edges and `windows` counts the ones that qualified. **Both
zero** means no wall on the scene has its *Light* restriction set to none — the feature has
nothing to work with. **`candidates` above zero with `windows` at zero** is the ambiguous one: it
is the ordinary night-time state, *and* it is what a region drawn past its own walls looks like,
since the probe then finds the same ambient on both sides of every window. Move the scene's
darkness slider and watch `windows` come and go to tell them apart. `visible: false` means *Model
global illumination* is off and only the model will move. And `bands` above zero with nothing on
screen points at the texture, not at this file.

Then, in the order things would go wrong: a window in a Dark region on a Bright map throws a
bright wedge cut off by the walls either side of it, with two bands beside and beyond it. Open a
door in the same wall and a second wedge appears; close it and the wedge goes. Cast *darkness*
over the window and the wedge should shorten to a tenth of its length rather than change colour
— the radius is chosen from the tier, so this is the one place a wrong reading is obvious by eye.
Put a candle on the windowsill and confirm **nothing** changes about the spill, only that the
candle lights the room the way it always did.

Two constructions to watch specifically, both named in §3.4 because they were reasoned to rather
than observed. `droppedHoles` in `field.stats()` should stay at zero — the aperture quad is what
keeps the bands C-shaped rather than annular, and a non-zero count means it is not doing that.
And a second window in an interior wall must let the first window's spill pass through it: both
are `light: NONE`, so the sweep should ignore both, and a wedge that stops dead at an untinted
interior window means the sweep type is wrong somewhere.

**Untested: the *Restrict Global Illumination* region behaviour, §10.7, 2026-08-26.** Start with
`game.pf1Lighting.areas.status()` before looking at anything on screen — it answers the three
ways this does nothing, and they are indistinguishable by eye. `declared: false` means the world
has not been relaunched since `module.json` gained `documentTypes` and the behaviour is not on
offer at all; `visible: false` means *Model global illumination* is off and only the model will
move; `globalLight: false` means the scene has no ambient to override and *set Bright* is as
inert as *set Dark*; and `label` reading `UNLOCALISED` means `lang/en.json` did not load, which
changes nothing about behaviour and everything about whether the create dropdown is readable.

Then, in the order things would go wrong: an *at most Dark* region on a Bright map darkens inside
its outline and nowhere else; a torch inside it still lights, and lights **further** in tier
terms than the same torch outside, because it is raising from a lower base; a *darkness* placed
inside it renders **darker than the room**, not brighter — that is the one real branch, and
getting it backwards is the failure the per-domain `dark` split exists to prevent. Then move the
scene's darkness slider and confirm an *at most* region stops mattering once the sky is darker
than it, which is the whole argument for that being the default mode.

`probe.at()` reports `ambient: {scene, here, areas}`; `scene === here` with `areas > 0` is a
behaviour that is disabled, mis-scoped, or on a region whose shape does not cover the cursor.
`field.stats().domains` counts the distinct tiers the map was split into — `0` means the
pre-§10.7 path ran, which on a scene with a region is itself the bug.

Then the two corrections from the first build, which have their own failure modes. **A torch
inside the region must light it**, and light it *more* than the same torch outside — that is
`cell.base` reaching `levelForTier`, and the check that it is per-cell rather than per-emitter is
a light straddling the region's edge: it should light the inside half and do nothing to the
outside half, in one continuous source. `field.stats().domains` counts the tiers the map split
into. And **the region's boundary must be hard** with ground softening on: no feather, no bleed
past the wall, while an ordinary *darkness* elsewhere on the same scene still fades.

Two things expected to look wrong and not be: a region set to **Dim** on a globally-lit scene is
under-darkened (single-threshold `globalLightCutoff`, §10.7 consequence 3), and region elevation
is ignored entirely (§3.6).

**Untested: token-name obfuscation in the readout, §10.6, 2026-08-26.** Needs a player client
and the GM-only switch off. Hover an NPC the randomizer has an obscured name for and confirm the
chip shows the obscured name to the player and the real one to the GM. Then a token with no
obscured name whose nameplate is hidden from players: `???` for the player, real name for the
GM. Then confirm nothing changed with `pf1-token-randomizer` disabled — the second layer alone
still applies.

**Untested: the settings pass, §10.6, 2026-08-26.** The first check is not in the menu at all:
`game.pf1Lighting.settings()` and confirm the four master switches read `true` — a world that
ever explicitly turned one off keeps `false` with no row to fix it, and the symptom is the module
appearing to do nothing at all. Then the menu itself: six rows and two buttons, and *Light level
is GM only* / *Explain the light level* **absent** from a player's client rather than present and
inert. With a player connected and the GM-only switch off, confirm the player gets a chip and
does **not** get an explanation on it.

*Configure visuals*: move one brightness level and confirm the ground and the lights move
together (the weight re-solve, §10.5) and that scenes stored at that tier follow; then confirm
saving without touching anything fires nothing — the handler writes only what moved, and the
tell is that no scene repaints. *Restore defaults* puts every number in the window back.

> **Counted nowhere on purpose.** This section said "eight" in three places and the file said it in
> four; the count has moved twice since. `SLIDERS` plus `LADDER` in `ui/visuals.mjs` is the census.

**Untested: the preset editor, §10.2.1, 2026-08-26.** The model cannot be wrong here — a bad
value is a bad *preset*, and presets only ever write into a sheet. So the checks are about the
working copy and about identity. Edit a preset, switch to another, switch back: the edit is still
there. Close without saving: nothing changed. Rename a preset and confirm a light already placed
from it still shows the new name rather than dropping to Custom — that is the key-is-identity
rule holding. Delete one and confirm a light placed from it reads Custom and *renders exactly as
before*, since nothing in the model reads `preset`.

Then the branch switch, which is where the DOM work is: flip Source between Light and Darkness
and confirm the right half shows, that *Decrease by* and *Set level to* swap their operand, and
that saving a *Set level to* preset writes a floor equal to its target (§10.4 — the editor
applies the rule so a preset cannot be authored inconsistent).

`game.pf1Lighting.presets.status()` reports `customised`, which is `false` until the editor is
first saved and is what says whether this world still tracks the module's built-ins.
`game.pf1Lighting.presets.reset()` puts it back without going through the dialog.

**§3.2.1's rewrite — cleared 2026-08-23.** All ten items verified in play: the control case
(one torch unchanged), two and three torches overlapping, a torch on Normal-lit and on Bright
ground, two torches inside a *darkness*, an overlap seen through one, `stacks` at zero on a
scene with no overlapping bands, the darkness slider stepping between tiers, and an existing
`brightRadius` flag losing its third zone. The two-zone additive model is live.

**Soft transitions — settled 2026-08-24**, over six rounds, recorded in §6.4.1 through §6.4.4.
What stayed: the light edge feather, including clipped cuts (§6.4.3). What was built and then
**retired** by choice: the *geometric* ground feather (§6.4.2) — too expensive for what it
bought. What never works: a filter on the darkness-level **container** (§6.4.2).

**The blur ground feather — §6.4.2a, landed and accepted 2026-08-24.** It takes the route
§6.4.2 ruled out, on the distinction that a filter on a **child mesh** is not a filter on the
cached container — which is what core's own darkness-level region behaviour does. Seen working
at 0.2 and **defaulted on at 0.1**. So the container's `FORMATS.RED` texture composites a
filtered child correctly, which was the open risk.

**Untested: blindsight survives the blinded condition, §4.5.1a, 2026-08-26.** Blind a token that
has blindsight and confirm it renders terrain out to its **blindsight** range and no further —
the "no further" is the half most likely to be wrong, since the token's `sight.range` already
includes darkvision. Then confirm it still detects by blindsight only (PF1's blue outline, not a
basicSight hit), that a blinded token *without* blindsight is unchanged, and that a blindsighted
token that is **not** blinded is also unchanged. `probe.vision()` reports `blindRaw` beside
`blinded.blind` and `blindsight` beside `radius`; `blindRaw: true` with `blinded.blind: false`
and `radius === blindsight` is the healthy state. Requires **Perceive by light level**, which is
what gates the senses layer.

**Untested: darkness sources now read wall restrictions, 2026-08-26.** `clip.patchDarknessWalls`
makes a darkness sweep consult each wall's **light** restriction, where core asked for a
`darkness` restriction that does not exist and so let every wall block. Check that a *darkness*
spreads through an **open door** and through a window configured to pass light, and that it still
stops at an ordinary wall. `render.soften().darknessWallsPatched` says whether the patch took.
Proximity and attenuation walls are in scope too and are the least-tested part.

**Resolved 2026-08-25 — it was blindsight, and it is working as designed.** Reported first as
see-in-darkness; Patrick corrected it to blindsight, which changes it from a defect into a design
question. `observerIgnoresDarkness` withholds the darkness mesh for blindsight observers by
intent (§6.2.5), and the mesh is what carries the animation. What the report exposes is that
§7.0 made that adjustment half-effective: the texture now keeps the region dark, so withholding
the source removes the overlay without achieving the "indistinguishable from the ground" it was
written for. **Three options, undecided, written up under §6.2.5** — and the animation must not
be fixed in isolation, since it is a symptom of the withholding rather than a thing of its own.

*The diagnostic round trip is worth keeping:* `probe.darknessGates()` reports `selected`,
`visionSources` and `observerIsSelected` because the first capture came back describing a
different creature than the one under test — `canvas.visibility.visionModeData.source` is
Foundry's **primary** vision source, not the selected token, and every observer-dependent value
in `render/` keys off it. Check those three before reading anything else.

**Untested: `levelForTier` back to an absolute lookup, §6.2.3, 2026-08-25.** Exactly one cell of
the matrix moved — a Normal zone on **Dim** ambient, `DIM` → `BRIGHT` — so the check is a torch
on a Dim scene reading clearly as Normal, and every other ambient looking exactly as it did
before. A Bright light on Bright ground also switched from `BRIGHTEST` to `UNLIT`, which should
be invisible: both paint `ambientBrightest`, and the ground is already there.

**Untested: the scene light-level dropdown and its sync, §10.5.1, built 2026-08-25.** Set a
scene to Dim, then change *Brightness of Dim* in the settings and confirm the scene's stored
darkness follows. Then the cases that are easy to get wrong: a scene never set through the
control should be left alone entirely; a darkness-locked scene should be skipped with a warning
rather than silently unchanged; and with a player connected, only the active GM should be
writing. `render.scenes()` reports all of that, and `render.resyncScenes()` forces the pass.

**Untested: the four tier-brightness settings, §10.5, built 2026-08-25.** Defaults match the
previous hardcoded table, so the first check is that **nothing looks different** before anything
is changed. Then move one — Dim is the most informative, since `globalLightCutoff()` is derived
from it and global illumination discards wherever the model paints darker — and confirm that
lights and ground move together rather than one against the other, which is what the weight
re-solve is there for. `render.levels(null)` reloads the settings if an experiment needs undoing.

**Untested, 2026-08-25.** *A light inside a darkness is out everywhere* (§3.3.1) — carry a torch
into a *darkness* and confirm it lights nothing beyond the bubble, then confirm a *daylight* in
the same spot is unaffected. `registry.stats().extinguished` counts them and `probe.at()` lists
them separately from `silent`, which is the distinction to keep an eye on: silent means a light
reaches and contributes nothing (usually a bug), extinguished means §3.3.1 working. Also *a
darkness enclosed by a light* — the annulus should have no seam and no bright far side.

**Untested: the config UI, §10.9, built 2026-08-24.** Nothing in the model changed, so a wrong
value here is a wrong *flag*, not a wrong renderer. What to exercise, in the order things would
go wrong:

- **The radii still work.** They are core's own inputs relocated into our fieldset, so the check
  is that editing one still previews live and still saves. If they ever came through as an array
  instead of a number, two inputs share a name somewhere.
- **The preset selector is one-way.** Pick *Torch*, change the steps, confirm it reads Custom;
  set steps back to 1 and confirm it *stays* Custom.
- **The light↔darkness swap keeps its other half.** Configure a light, flip *Darkness source*,
  flip back, confirm the emission fields survived — hidden inputs still submit, which is the
  design rather than an accident.
- **The `cancelsDarkness` leak is closed.** Make a *Daylight*, save, untick *Magical*, save, and
  confirm the flag reads false rather than a stale true.
- **Both token sheets**, since `renderTokenApplication` is meant to cover `TokenConfig` and
  `PrototypeTokenConfig` through the inheritance chain rather than by two listeners.

**Untested: the halo fix, both halves.** The first play test showed bright rings around darkness
discs inside an umbra — meshes sharing a boundary, both blurred, the container's clear colour
showing through the seam. `paint()` now unions cells by level (`merged`), and adds a scene-wide
backstop at the darkest level under any remaining seam (`backstopped`); both report through
`render.texture()`. Check that the rings are gone, that `merged` is above zero on a scene with
an umbra, and that a *darkness* on a lit map still reads dark — the backstop is the piece with
the potential to go wrong at scale, and its failure mode would be the whole scene darkening.

**Untested: fog of war**, after §6.6's ordering fix. All three reported symptoms should clear
together, since they share one cause: non-darkvision tokens exploring nothing, darkvision tokens
exploring only their darkvision radius, and explored-but-unseen ground reading monochrome. The
third is the one I am least sure of — it may simply have been standard explored-area tinting,
made conspicuous because the only explored ground was darkvision-explored. `umbra.mask()` now
reports `drawn`, which **must equal `trimmed`**; a gap between them is this bug returning.

Two residuals, neither looked at: the scene-sized ambient mesh's filter pass has **not been
cost-measured on a drag** (§9's standing rule is that cost arguments on this module have been
wrong every time), and a possible soft vignette where the ambient mesh fades into the clear at
the scene rim, visible only past the scene rect. The reveal boundary stays hard by design, so a
darkness on a globally lit map keeps a crisp fog outline whatever this is set to.

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


### Dropped 2026-08-28 — a wall's edge is still not sharp

Patrick, 2026-08-28, after §6.4.8: *"The gradients are now buttery smooth, but the goal here was
not to smooth the gradients, but rather keep a sharp edge along walls. That said, this issue
doesn't really seem to show anything for players, and it's really just a DM side visual
discrepancy, so I'm willing to drop it."*

Recorded rather than fixed, because the diagnosis is worth more than the state it describes and
the next person to look will otherwise start where the last two rounds started.

**§6.4.7 cannot make a wall's edge sharp, and never could.** It chooses per fragment between the
blurred field and the **unblurred** one — and the unblurred field is not hard at a wall either.
`render/transition.levelAtDistance` bakes a Hermite ramp into the field itself, and every producer
calls it; `render/light-ramps.mjs` evaluates it as *distance from the light's origin*. So a light's
falloff is a genuine gradient written into the darkness-level texture, which runs up to the wall
and is clipped by it. Suppressing the blur reveals that ramp, not a step.

Patrick had this exactly right a round before it was acted on — *"they're removing the smear, but
not the gradient the smear acts on"* — and it was read as a description of the blur instead of of
the field.

**Where a fix would go, if it is ever wanted.** Not in the mask and not in the blur: the field
would have to carry the hardness. `emitAmbient` already has the vocabulary — its `hardEdge` flag
marks a boundary that must not be feathered — but it is a property of a *cell*, and what needs
marking here is one *edge* of a light's zone: the arc that came from a wall clip rather than from
the light's own radius. `light-ramps` can tell them apart cheaply (a sweep vertex nearer the origin
than `source.radius` is wall-derived by construction), which is the observation §6.4.7 rejected for
the mask and which is the right one for this. `levelAtDistance` would then need a per-boundary
hardness rather than one profile for the whole ramp.

**What it costs to leave.** A GM-side discrepancy only: light bleeds about one transition width
past a wall in the *picture*. The model is untouched, so nothing a player is told, nothing a
creature can see by, and nothing in the readout moves.
