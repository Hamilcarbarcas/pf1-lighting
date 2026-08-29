# PF1 Lighting

Observer-relative light levels for Pathfinder 1e on Foundry VTT.

**Status: model, renderer, perception and umbra, all on by default.** Light levels are
genuinely observer-relative — what a creature can see depends on the darkness *between* it and
the target, not only on the darkness *at* the target — which was the point of the whole thing.

The settings list is short on purpose: seven switches and three windows. The rest of what the module
does used to be behind a toggle so it could be bisected during development, and those toggles are
gone rather than the behaviour. See **Settings** at the end if you need one back.

A *darkness* on a bright map now both computes and draws correctly, and so does the shadow it
casts. The gap that remains is narrower: an area dimmed by looking *through* a darkness is
dimmed only where global illumination lit it, because ground lit by an actual light source is
not dimmed. See [DESIGN.md](DESIGN.md) §7.0 and §7.1.

## What it does today

### Light level readout

A chip beside the pointer showing the light level under the cursor, or of a hovered
token. **Alt+L** toggles it.

**GM only by default.** The light level is information — a player reading the exact tier under
their token knows something their character would have to work out — so **Light level is GM
only** starts on and you turn it off to share. Each player then still chooses whether to show
their own chip; while the switch is on they get neither the chip, the setting, nor the keybinding.

The chip only appears over the scene itself. Move the pointer onto a sheet, a dialog or the
sidebar and it goes away.

Hovering a token shows its name beside the level, and that name respects who is looking. If
[`pf1-token-randomizer`](https://github.com/Hamilcarbarcas/pf1-token-randomizer) is installed,
its DM-authored obscured names are used for anyone below Observer; with or without it, a token
whose nameplate a player cannot see reads `???`. Nothing is required — the tie-in is used if the
module is there and skipped silently if not.

With explanations on it says *why*, not just what — "Dim · reduced from normal", "Normal ·
darkness present, no effect", "Bright · darkness cancelled by daylight". That comes
straight out of `evaluate()`, which tracks the pre-suppression baseline and the deciding
suppressor.

Token readouts sample the centre plus four quarter-offset points and report the
**brightest**, so a large token straddling a light's edge reads as lit.

This is a fresh implementation, not a reparenting of `pf1-light-level-tooltip` — that
module is untouched and still works standalone. Note both bind Alt+L by default.

### Renderer

The scene is drawn from the model instead of from Foundry's own lighting: light clipped at
darkness boundaries, five brightness tiers, darkness-spell semantics.

```js
game.pf1Lighting.render.rebuild()   // force a rebuild
game.pf1Lighting.render.stats()     // timings and cell counts from the last one
game.pf1Lighting.render.reset()     // drop all clips, restore stock rendering
```

If the canvas feels heavy while tokens move, two readouts say where the time goes.
`render.paint()` reports a `stage` breakdown per pass and `fieldStable`, which is `true`
whenever a repaint was triggered by an observer moving rather than by the scene changing —
everything but `shadows` and `clamps` should then be near zero. `settingsCache()` reports the
read-through cache over `game.settings.get`, which Foundry implements as a linear scan of every
Setting document in the world; a `hitRate` well below 1 means something is bypassing it.

```js
game.pf1Lighting.render.paint()     // per-stage cost of the last repaint
game.pf1Lighting.settingsCache()    // hit rate, keys held, invalidations
```

Real light sources are **clipped, not replaced** — flicker, colour and falloff survive,
with a bite taken out where a darkness overlaps. Synthetic sources are pooled and reused,
never created per frame (§9.5). How dark an area *is*, as opposed to what lights reach it, is
painted separately — see **Global illumination** below.

An ordinary *darkness* is rendered by removing light rather than by drawing anything, which
used to mean a shader animation had no mesh to run on. See **Animated darkness** below for the
setting that gives it one.

### Global illumination

The model's five brightness tiers are painted into Foundry's darkness-level texture, so every
area of the map renders at the tier the model says it is.

Without this, a *darkness* cast on a brightly lit map would be computed correctly and drawn not
at all: Foundry's global light is unconditional, illumination composites by taking the brightest
contributor, so anything painted on top loses to the ambient beneath it. With it, a *darkness* at
noon visibly drops the area a step.

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

Two console settings, for the two kinds of *source* edge on the map. The boundary between two
brightness levels is a separate thing and has its own section below.

These tune a **source's** own mesh edge, which is a smaller and rarer thing than the boundaries
between brightness levels — that is *Transitions between brightnesses* below, and it is what you
almost certainly want. Neither has a settings row; both are reachable from the console.

**Light edge softening** widens the fade on a light whose shape has been clipped, cut by a wall, or
drawn for a band overlap. Since lights became brightness regions it governs the light's **colour**
edge — how far the coloured wash feathers — not its brightness edge. Defaults to 0.05. Two Foundry
behaviours can make it look inert: soft edges are off entirely below **Medium** performance mode,
and they never apply to an unobstructed circular light, which fades by its own attenuation instead.

**Darkness edge softening** widens the fade at the rim of a *supernatural* darkness disc — the only
kind that draws a darkness source of its own. Defaults to 0.5, matching Foundry; because that is a
fixed distance rather than a proportion, a large darkness looks harder-edged than a small one, and
raising it widens only the picture.

```js
game.pf1Lighting.settings("edgeSoftness", 0.2)
game.pf1Lighting.settings("darknessSoftness", 1.5)
```

*Ground edge softening* and *Band softening* used to sit here and are **gone**. Both blurred an
individual mesh, which fades that mesh's transparency to reveal whatever is beneath it — that can
soften a boundary between two brightness levels but cannot add one between them. One width now
covers every brightness boundary in the module; see *Transitions between brightnesses* below.

Neither of the remaining two affects where a light or a darkness *reaches*, only how its edge is
drawn.

One edge stays hard whatever these are set to: whether global illumination *reveals* a region
is a yes-or-no question rather than a level, so on a globally-lit map a darkness keeps a crisp
outline in the fog. That is deliberate — a magical darkness with a crisp boundary is a
reasonable thing for a magical darkness to look like.

### Animated darkness

An ordinary darkness has no surface, so an animation chosen in its config has nothing to run on
and does nothing. This module draws one faintly so the animation shows. It tints the area
slightly darker than the rules say, which is the price.

There is no setting, because choosing an animation on the darkness *is* the setting: a darkness
with none is untouched — no mesh, no cost, no tint — and a *deeper darkness* already draws
either way. The one reason to want it off globally is cost, since each animated darkness carries
an extra mesh per lit area it crosses:

```js
game.pf1Lighting.settings("darknessAnimationStrength", false)
```

(The key still says *strength* because it was a 0–1 dial before it became a switch; renaming it
would orphan the value in worlds that have set it.)

One known limit: a creature with **blindsight** sees no animation on a darkness. Its darkness
overlay is withheld entirely, on the grounds that a creature mapping a room by echo does not
experience a darkness spell over it as anything at all.

### Darkness is hidden where a creature cannot see

A darkness bubble used to be drawn through walls — visible, and visibly *moving*, in rooms a
player had no vision into. Two separate gaps in Foundry caused it, both fixed here.

Foundry masks its light and colour layers to what the viewer can see, and does not mask darkness,
so a darkness source drew everywhere it reached. And it paints unseen ground by reading the
darkness-level texture — which holds nothing but static region data in a stock world, and holds
this module's entire light model here. Fog was not failing to hide darkness; it was faithfully
reproducing it.

Both are corrected, so a darkness source is withheld outside vision the way a light already is,
and unseen ground reads at one fixed brightness — the model's Dark, the same on every scene. It
follows the observer, so with **GM sees through the selected token** on, the GM stops seeing
darkness outside that token's vision too.

On top of those, **a wall is treated the way a darkness already is**: ground you cannot see is
drawn dark, rather than showing whatever the light model says is there. That is what actually
stops a darkness spell or an umbra being visible — and visibly moving — through fog. It affects
drawing only; what a creature can see is unchanged.

One consequence worth knowing: an area with its own light level no longer shows through fog
either, so an unlit cellar reads at scene brightness in unexplored area rather than dark. Static
architecture is not secret, and the map already shows it.

```js
game.pf1Lighting.render.darknessMask()   // whether both are in force, and why they might not be
```

`applied: true` with `enableVisionMasking: false` is a scene with **Token Vision** switched off —
Foundry disables every such mask there, and this one goes with them.

### Walls and darkness

A darkness spreads the way light does. A wall that lets light through — a window, an open
doorway — lets a darkness through as well, and a wall that blocks light blocks it. Foundry on
its own treats every wall as blocking darkness regardless of what the wall allows, including
open doors; this module corrects that.

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

Three controls tune this, all defaulting to the ordinary case and all in **Lighting
Configuration** on the light's own sheet: the set level, how many steps the band raises, and the
ceiling on that increase. Most lights need none of them; a rare effect that brightens by two
steps sets steps to 2.

**When a light is lit** is set the same way. Foundry's *Darkness Activation Range* — two numbers
between 0 and 1 — is replaced by **Active when scene is**, a pair of tier dropdowns: *Dim down to
Dark* for a street lamp that comes on at dusk, *Bright down to Dark* (the default) for one that
is always burning. It reads the **scene's own** light level, not the level where the light
stands, so a lamp set to come on in the dark will not notice that it is indoors.

Like the scene control below, a light remembers the tiers you picked rather than the numbers
behind them, so retuning how bright a tier is drawn carries every light along with it. Lights you
have never set through these dropdowns are left alone — they show their nearest tiers, and
nothing is written until you choose one. Token lights do not have this control, because Foundry
does not offer the field on a token sheet.

```js
game.pf1Lighting.render.lights()        // which lights carry a range, and whether they match
game.pf1Lighting.render.resyncLights()  // force the pass
```

A light **standing inside** a darkness that could block it is out entirely — it does not shine
out of the far side just because its radius reaches past the edge. Magical light that out-levels
the darkness, and anything marked as *daylight*, is unaffected.

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

game.pf1Lighting.render.levels("bands")  // try a whole alternative table, unsaved
game.pf1Lighting.render.levels(null)     // reload the four saved settings
```

### A scene's own light level

The scene config's **Lighting** tab has a **Light level** dropdown — Bright, Normal, Dim or
Dark — in place of Foundry's darkness slider. The model works in five tiers, so a slider offered
precision that does not exist.

The scene remembers the tier you picked, not just the number behind it. That means changing how
bright a tier is drawn (below) carries every scene set to that tier along with it: set a scene
to Dim, later decide Dim should be darker, and the scene follows without being reopened.

Scenes you have never set through this dropdown are left alone — the dropdown shows their
nearest tier so it reads sensibly, but nothing is written until you choose one. A scene with
**darkness locked** is skipped and reported, because Foundry refuses darkness changes on it.

The **lighting controls** carry the same four levels as buttons — *Set ambient light to Bright /
Normal / Dim / Dark*, in place of Foundry's *Transition to Daylight* and *Transition to Darkness*.
They change the scene at once rather than fading over ten seconds, which against four discrete
levels was a slow step through the two in between. They set the tier, not just the number, so a
scene set by a button behaves exactly like one set from the dropdown. A scene with **darkness
locked** shows no buttons, the same as in vanilla.

```js
game.pf1Lighting.render.scenes()        // which scenes carry a tier, and whether they match
game.pf1Lighting.render.resyncScenes()  // force the pass
game.pf1Lighting.render.setSceneTier(2) // what the buttons do; 4 Bright … 1 Dark
```

### An area with its own light level

A room that stays dark on a sunlit map, without hand-placing anything.

Draw a **region**, add the behaviour **Restrict Global Illumination**, and give it a light level
and a mode. *At most* is the default and the one you want for an interior: it says *no brighter than
this*, so the cellar stays dark at noon and does not turn into a light source at midnight when
the sky outside drops below it. *Set to* overrides the scene outright, and *At least* is its
other half.

The region changes global illumination and nothing else. **Lights inside still light it** — in
fact a torch works *better* in a room the region has darkened, because it has more to add — a
*darkness* inside still suppresses it from the lower base, and the area itself casts no umbra.
It is an unlit room, not magical darkness.

Its edge is drawn hard, not feathered, since a region boundary follows a wall.

Two things it needs to be visible at all:

- **Model global illumination** must be on. It is the setting that lets anything paint darker
  than global light; with it off the model still answers correctly and the map does not change.
- The **scene's global illumination** must be enabled. These regions override the ambient, and
  with global light off there is no ambient to override.

```js
game.pf1Lighting.areas.status()   // every area, and the three reasons one might do nothing
game.pf1Lighting.probe.at()       // reports the ambient here next to the scene's
```

A region set to **Dim** on a brightly lit scene will look under-darkened. That is the same
single-threshold limit that affects any darkness whose floor is Dim, not something specific to
regions. Region elevation is ignored — the model is flat.

Core's own *Adjust Darkness Level* behaviour does not work while this module is rendering; this
replaces it.

### Light spill through windows and open doors

A room darkened by *Restrict Global Illumination* should still catch the daylight coming through
its window. It does, with nothing to place: any wall on the border of such a region that **does
not block light** becomes an aperture, and the outdoor light comes in through it.

A window is simply a wall whose *Light* restriction is set to none. **An open door counts while
it is open** — Foundry drops every restriction on a door's wall as it swings, so opening one lets
the light in and closing it takes it away, with no configuration at all.

What you get is light spreading in from the gap and stepping down one level at a time — bright,
normal, dim — until it runs out. **The distance is measured along the floor, not through the air**,
so light that has to turn a corner spends its reach getting there and arrives dimmer. Standing one
square to the side of a doorway is not the same as standing in front of it, and a room reached
through two turns of a corridor is darker than one reached through a single doorway at the same
range. Walls stop it exactly where they stand.

Three things follow from the light being the *sky*, rather than anything you placed:

- **A darkness over the window dims what comes through it.** Cast *darkness* on a window and the
  spill starts at dim instead of bright, so it throws a tenth as far. *Deeper darkness* shuts it
  off entirely, and a *daylight* cancelling that darkness restores it.
- **At nightfall it stops on its own.** Once the sky is darker than the room, no window on the
  scene qualifies and nothing is computed.
- **A candle on the windowsill does not flood the room.** It already shines through the window on
  its own, the way any light does, and spill deliberately ignores it.

Spill is treated as global illumination by everything else in the module — the readout, what a
creature can see, perception, and any darkness cast over it — because it *is* global
illumination, reaching ground it otherwise could not.

**Settings → PF1 Lighting → Light Spill → Configure Light Spill** holds the numbers: an on/off
switch, **how far each brightness carries** before it drops to the next one down (40 / 20 / 10 feet
for bright, normal and dim), and the grid resolution the falloff is worked out at. So bright
daylight holds for forty feet, reads as normal for the next twenty and dim for the last ten —
seventy feet in total — while a window that is only dim outside reaches ten.

The reach is the sum of the rungs below wherever it starts, so lowering one number shortens every
ladder that passes through it. The window shows you the total as you edit.

How softly one band fades into the next is **Transition width**, in *Configure Visuals* — it is the
one distance every brightness boundary in the module fades over, not a spill setting. See
*Transitions between brightnesses* below.

Like the region itself, it needs **Model global illumination** on to be visible.

```js
game.pf1Lighting.spill.stats()   // windows found, rooms marched, bands drawn, and why there might be none
game.pf1Lighting.spill.at({ x: 1000, y: 1200 })   // which bands cover a point
game.pf1Lighting.spill.config()  // open the settings window
game.pf1Lighting.geodesic.draw() // paint the distance field the bands were cut from
game.pf1Lighting.geodesic.clear()
```

`geodesic.draw()` is the one to reach for when a spill looks wrong, because it shows the working
rather than the answer. Red marks where light was told it may not pass: a continuous red hatch
along a wall is that wall sealed, and a break in the hatch is somewhere light gets through —
a doorway when you meant one, and a mis-drawn wall when you did not.

**Windows in the same room are worked out together**, in one pass rather than one each, so two
windows lighting the same floor give the brighter of the two with no seam between them. Where they
differ in brightness — one under a *darkness*, say — the dimmer one simply starts further down the
same ladder.

Every wall edit recomputes the spill for the whole scene, so heavy wall work on a map with several
windows may feel slightly slower than it used to.

### How bright each tier is drawn

**Settings → PF1 Lighting → Visuals → Configure Visuals** holds four sliders — **Bright**,
**Normal**, **Dim**, **Dark** — setting how dark the ground at each tier is painted, from 0 (full
daylight) to 1 (unlit). They default to evenly spaced
values, and they should descend in brightness: Bright lowest, Dark highest. The gaps between
them are what makes one tier readable against the next, so this is the dial to reach for if the
map looks flat or if night scenes read too bright.

Supernatural Dark is drawn at the same level as Dark. Dark already means *no light*, so there is
nothing below it to reserve; the two are told apart by the darkness effect's own overlay
instead.

Changing any of them re-solves how light sources paint as well, so lights and ground stay on the
same ladder.

**These are absolute, and they apply to lights as well as to ground.** A tier is a brightness, not
a brightening: a torch's Normal ring is the same colour as ground at Normal, in a dark cellar and
in a dim room alike, whatever the scene's global illumination is set to.

That takes two changes to how Foundry draws a light, because Foundry gets it wrong in two separate
ways. It brightens each light *relative to whatever it is standing on*, so the same ring reads
about a third of the way toward Bright when it lands on dim ground. And it draws every light as a
**radial falloff**, so the nominal level only ever exists at the very centre and everything else is
a fade toward the background — which means no amount of pinning the endpoints gives you a light
level you can actually see.

So the whole scene is drawn from one brightness map instead: ground, light and shadow all painted
as regions at fixed levels, with controlled transitions between them. A light contributes its two
zones to that map; where lights overlap, the brighter wins; ground the viewer cannot see is put
back to Dark last, so a torch behind a wall cannot shine through. Lights keep their colour, their
flicker, and what they let a creature see by — only the brightness moves.

### Transitions between brightnesses

**Every brightness boundary fades over the same distance**, set once by *Transition width* in
**Configure Visuals**. A room's edge, a darkness rim, a
light's two zones, a window's falloff and the edge of what you can see all use it. A boundary two
steps apart — bright straight to dark — is not made wider for it, because a wider fade would read
as *less* of a step.

Set it to 0 and every brightness boundary becomes a hard edge, all at once.

**Except at walls.** Light stops at a wall, but softening does not — left alone it spreads
brightness about one transition width past every hard edge, so a lit room glows through its own
walls and a dark one picks up the corridor outside. The field is held sharp along any wall that
blocks light, and softened as normal everywhere else. Walls that block sight but pass light (a
window) are not affected, which is what keeps light spill working.

It lives in **Configure Visuals** alongside the other appearance numbers. It used to be repeated in
the Light Spill window, which was one setting on two forms with two *Restore defaults* buttons that
disagreed about what they reset — and it read as a spill property when it governs every boundary in
the module.

**Unseen ground dimming**, in Configure Visuals, is the companion: how far explored ground outside
your current vision is taken toward black, on top of already being drawn at Dark. Foundry hard-codes
that at 0.5, which stacks heavily on dark terrain; this defaults to 0.2. Ground you have never
visited stays solid black either way.

**Where two lights' outer bands overlap they brighten each other** — each band raises the level a
step, to that light's own cap, so two overlapping dim bands read as Normal. The overlap is drawn as a
region in the same brightness map as everything else, so it fades over the same transition width and
the readout inside it reports the level the model says is there.

```js
game.pf1Lighting.render.gradient()   // ground, light and clamp meshes, and the per-light cache
game.pf1Lighting.render.zones()      // every light's zones in luminance, against the ladder
game.pf1Lighting.overlay.draw()      // the model's own cells — band overlaps in hot yellow
game.pf1Lighting.overlay.levels()    // what the renderer painted
```

Both take the same argument: call one bare to toggle it, or pass `false` to turn it off.

```js
game.pf1Lighting.overlay.draw(false)
game.pf1Lighting.overlay.levels(false)
```

To go back to Foundry's own rendering, in increasing order of how much it puts back:

```js
game.pf1Lighting.settings("lightsInTexture", false)      // radial falloff again, levels still fixed
game.pf1Lighting.settings("absoluteLightLevels", false)  // relative brightening as well
```

Two whole alternatives are also available from the console for trying against a live map:
`"even"` gives Supernatural Dark a level of its own, and `"bands"` renders each tier at the top
of its own brightness range, so a dark scene stays dark at the cost of squashing Bright against
Normal. Neither is saved — the four settings are the stored answer, and `render.levels(null)`
puts them back.

This is the largest single lever on how a scene looks, which is why it sits at the top of the
Configure Visuals window with the softening sliders under it.

### Darkvision sees grey where it is dark, and colour where it is not

A creature that sees in black and white falls back on that sense **where there is no light**. Where
there is light it uses its eyes, and its eyes see colour. So the module greys the parts of the map
its own brightness model calls dark, and leaves everything at Dim and above in full colour.

Foundry instead greys the whole canvas the moment a darkvision token becomes the viewer, so a
torchlit room and the pitch-dark corridor behind it look equally colourless.

The boundary between grey and colour is the *same* boundary as the one between brightnesses — it is
read from the same map, so it fades over the same transition width and moves when you retune the
tier ladder.

Foundry desaturates in five different places, three of which take their own copy of the map and
repaint it, so correcting them one at a time does not work. All five are switched off and a single
pass replaces them, applied after the scene has finished compositing. Everything the observer looks
at goes through it together — terrain, tokens, tiles, and the tint a light casts — so a torch
burning inside a magical darkness is grey light rather than a coloured wash on a grey floor, and a
creature standing in a dark room is not in full colour.

None of it reaches ground you have explored but cannot currently see: **remembered terrain keeps
its colour.** Memory is not a sense with a light level, and the boundary the greyscale would have
to fade across is your own vision polygon, which moves with you.

If you would rather fog read as unlit, it is a dial rather than a switch — 1 treats remembered
ground exactly like ground in view, and anything between fades:

```js
game.pf1Lighting.settings("greyscaleInFog", 0.5)
```

```js
game.pf1Lighting.render.greyscale()   // is it running, and what the ramp resolved to
```

To go back to Foundry's whole-canvas version:

```js
game.pf1Lighting.settings("regionalGreyscale", false)
```

### Perception

What a creature can see is decided from the lighting model rather than from Foundry's raw light
polygons.

| Sense | Rule |
| --- | --- |
| Ordinary sight | needs **Dim** light or better |
| Darkvision | works at any tier **except Supernatural Dark**, within its range |
| *See in darkness* | works everywhere, at any range, and reveals terrain across its whole line of sight |
| *True seeing* | the same, bounded to the spell's range |
| *See invisibility* | in range, or wherever ordinary sight would work |
| Blindsight | unaffected by the **blinded** condition — see below |

A creature in **magical** Supernatural Dark is blinded outright, unless it has *see in
darkness*. Mundane darkness — a source at level 0 — never blinds and never blocks sight
through it, however dark it is: standing on an unlit hillside you can still see a lit window
thirty feet away.

**The blinded condition does not take away blindsight.** Blindsight is not sight, so a blinded
creature that has it keeps perceiving — terrain and tokens both — out to its blindsight range,
and no further. Its darkvision and *true seeing* are gone, because those are sight, and it
detects only through blindsight rather than by seeing. Foundry on its own blanks such a
creature's view entirely.

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

On by default. **Darkness shadows what lies beyond it** (world setting) makes light levels
*observer-relative*: looking through a magical darkness lowers everything past it to the
darkness's own level.

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

### Brightness map (debug)

**The tool to reach for when the map does not look the way you expect.** It draws what the
renderer is actually drawing from — every brightness region, coloured and labelled by tier, plus
each light's two zones, each spill band, and the count of clamps.

```js
game.pf1Lighting.overlay.levels()
```

It follows a repaint, so it stays correct while you drag a token or a light.

The one thing it is best at: **if a transition on screen is not sitting on a line in this overlay,
the renderer invented it.** That distinction — model or render — is not answerable any other way,
and it is the first question worth asking about anything that looks wrong.

The console line beside it reports counts by tier plus `lights`, `halos`, `clamps` and
`spillBands`. Zero lights with torches on the map means lights are not being drawn as brightness
regions, so Foundry is drawing them its own way and this overlay is describing a different picture
from the one on screen.

### Field cell overlay (debug)

An older, narrower view: the model's cells coloured by **kind** rather than by brightness — blue
for unsuppressed light, orange for reduced, violet for darkness fill. It answers "how did the field
get subdivided", where the brightness map above answers "what is being painted".

```js
game.pf1Lighting.overlay.toggle()
```

## For module authors

```js
const api = game.modules.get("pf1-lighting")?.api;
```

That is the address, published at `init` so it is there for your `setup` and `ready` alike.
`game.pf1Lighting.api` is the same object under a shorter name for console use — it exists only
because `pf1-lighting.api` can't be typed in JavaScript, the hyphen being a minus sign.

It is the supported surface. Everything else on `game.pf1Lighting` is a debug readout — it logs,
its fields change whenever a diagnosis needs them, and some of it hands back live internals. Bind
to `api` and check `api.version`, which only moves on a breaking change.

Tiers cross the boundary as ordered numbers, so `>=` means what it looks like:

```js
api.TIER            // { SUPERNATURAL_DARK: 0, DARK: 1, DIM: 2, NORMAL: 3, BRIGHT: 4 }
api.tierName(2)     // "Dim"
```

**Every query takes one subject or an array of them**, and the return shape follows the argument.
That is not just convenience — the model rebuilds its field when the scene changes, so ten separate
calls can pay for that ten times where one call with ten subjects pays once.

```js
api.brightnessAt(point)                        // the tier there, as the GM sees it
api.brightnessAt(point, { observer: token })   // as that token sees it — darkness between them counts
api.brightnessOf([a, b, c])                    // a tier each
api.brightnessInSquare(point)                  // the grid square, by the same rule a token uses
```

Passing `observer` is a different question, not a refinement: without it you get the map's own
light level, and with it you get what that creature can actually see by, which a *darkness* in the
way will lower.

`brightnessOf` takes `sample` — `"center"` (the default, and the same rule a grid square gets),
`"min"` for the darkest square a token occupies, or `"max"` for the brightest. A Large creature
straddling a boundary genuinely has no single answer; `min` is the hider's and `max` is the
target's.

### Who can see whom

```js
api.perceivedBy(token, { sample: "min" })   // every token on the scene that might see it
api.perceive(observer, target)              // one pair
```

Each result says whether the target is visible, **which sense did it** (`reason` — `basicSight`,
`lightPerception`, `feelTremor`, and so on), whether that sense cares about light at all
(`lightIndependent`), the tier the observer perceives them at, the distance in scene units, and
whether a wall is in the way. Foundry itself will only tell you yes or no, so the *why* is the part
this adds.

**This costs a wall sweep per observer that isn't currently a vision source** — which is most NPCs,
since Foundry only builds vision for tokens you control. Fine on a die roll, far too slow on a
movement hook.

### The scene's light level

```js
api.sceneTier()                       // Bright / Normal / Dim / Dark, as a tier
api.setSceneTier(api.TIER.DIM)        // instant; GM only
Hooks.on("pf1-lighting.sceneTierChanged", (scene, tier, previous) => {})
```

`setSceneTier` refuses on a scene with **darkness locked** and returns `null`, so that checkbox is
how you keep a dungeon out of an automated day/night cycle. Note that it locks the scene against
*everything*, including the dropdown — it means frozen, not merely "ignore the clock".

The hook fires only when the level actually changes rung, from any source, so you don't have to
watch `updateScene` and work the tier out yourself.

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

## Configuring a light or a darkness

Open any **ambient light**, or a token's **Light** tab, and look for **Lighting Configuration**
on the same page as the placement fields. Everything the model reads is there.

Foundry's own two radius fields have moved into that section, next to the levels they belong
to, and the *Darkness source* checkbox has moved to the head of it. They are the same fields in
a new place, not copies — the originals are hidden rather than duplicated, so nothing can end
up with two conflicting values.

### Presets

The first control fills in everything else. Eleven ship with the module:

| | |
| --- | --- |
| Candle | +1 step to 5 ft, no further than normal |
| Torch | normal to 20 ft, +1 to 40 |
| Lamp, common | normal to 15 ft, +1 to 30 |
| Lantern, bullseye | normal to 60 ft, +1 to 120 |
| Lantern, hooded | normal to 30 ft, +1 to 60 |
| Sunrod | normal to 30 ft, +1 to 60 |
| *Continual flame* | magical, spell level 2 — normal to 20 ft, +1 to 40 |
| *Light* | magical, cantrip — normal to 20 ft, +1 to 40 |
| *Daylight* | magical, level 3 — bright to 60 ft, +1 to 120, counts as daylight |
| *Darkness* | magical, level 2 — one step down for 20 ft, no darker than dark |
| *Deeper darkness* | magical, level 3 — two steps down for 60 ft, down to supernatural dark |

The **bullseye lantern lights a cone** in the rules, and the preset sets radii only — set the
Angle field by hand after applying it. Presets deliberately leave the angle alone so that
switching between them never traps a light in a cone it did not ask for.

A preset is a starting point, not a mode. Changing any field it governs sets the selector back
to **Custom**, and it stays there — setting the values back by hand does not restore the name.
The label records where the numbers came from, which is not something that can be worked out by
looking at them afterwards.

Radii are the exception: a preset fills them in, but widening a torch's radius to light a
bigger room does not stop it being a torch.

#### Editing the presets

**Settings → PF1 Lighting → Lighting Presets → Edit Presets** opens a window that edits the
table itself: retune the shipped entries to your table's numbers, or add your own.

The window edits one preset at a time and holds everything in a working copy — switching between
presets keeps your edits, and closing without saving discards them. **Restore defaults** puts the
world back on the module's own table, and back to tracking it as the module changes.

Two things worth knowing:

- **A darkness has no *Magical* checkbox, and does not need one.** Its **Spell Level** carries the
  whole distinction: level 0 is mundane — an unlit cellar, dark but see-through — and level 1 or
  above is a magical darkness, which casts an umbra and can be out-levelled by magical light. The
  checkbox exists only for light sources, where being magical and having a level are genuinely
  separate questions.
- **A preset can carry an activation range, and by default does not.** Leave *Active when scene
  is* spanning **Bright** to **Dark** and the preset says nothing about it — applying the preset
  will not disturb a range you set by hand on that light. Narrow either end and it starts being
  part of what the preset fills in.
- **Editing a preset does not change lights already placed from it.** A preset fills fields in at
  the moment you choose it and is never read again afterwards.
- **Deleting one is harmless.** A light placed from a preset that no longer exists reads as
  Custom and renders exactly as before — the name is a record of where the numbers came from,
  and nothing depends on it.

Renaming keeps a preset's identity, so lights placed from it follow the new name.

### A light

| Control | What it does |
| --- | --- |
| **Magical** | Magical light out-levels a darkness of its own level or lower and keeps shining |
| **Spell level** | Only meaningful on magical light, and greyed out otherwise |
| **Counts as *daylight*** | Annihilates with a darkness of its level or lower — both effects vanish in the overlap |
| **Brightness — level, radius** | The level this light provides outright, out to that radius |
| **Increase brightness — radius, steps, maximum** | Beyond the inner radius it raises whatever level is already there by that many steps, never past the maximum |

The last row is what a torch actually does: *normal light to 20 feet, one step up to 40*. Steps
defaults to 1 and the maximum defaults to the set level, so an ordinary light needs neither
touched.

### A darkness

| Control | What it does |
| --- | --- |
| **Radius** | How far it reaches. A darkness has one radius, not two |
| **Spell level** | Level 0 is *Mundane / unlit area* — dark, but you can still see out of it. Level 1 and up cast an umbra |
| **Effect** | *Decrease by* n steps, with a floor; or *Set level to* a named tier |

*Set level to* never brightens. Over ground that is already darker than the target, it leaves
it alone.

### From a macro

The same table is reachable in code, and returns the flat update a document wants:

```js
light.document.update(game.pf1Lighting.presets.apply("deeperDarkness"));
game.pf1Lighting.presets.table()        // every preset and its values, as currently configured
game.pf1Lighting.presets.builtIn        // the module's own table, whatever this world has done
game.pf1Lighting.presets.edit()         // open the editor
game.pf1Lighting.presets.reset()        // back to the built-ins
```

Two settings the model reads have no control and are not meant to: which lights a darkness
*extinguishes* rather than merely dims (the rule is already Pathfinder's), and whether a
magical darkness casts an umbra (it follows from being magical). Both remain settable through
the `pf1-lighting.config` flag if a scene ever needs an exception.

## Settings

Five switches and three windows.

| | |
| --- | --- |
| **Visuals** | Brightness of each tier, the brightness transition width, unseen-ground dimming, see-in-darkness brightness |
| **Lighting Presets** | The named light and darkness configurations offered on a light's sheet |
| **Light Spill** | Whether windows let the daylight in, and how far each brightness carries indoors |
| Show light level | Your own readout chip |
| Light level is GM only | Whether players get one at all — on by default |
| Explain the light level | The *why* line. GM only, whoever the readout is shown to |
| Darkness shadows what lies beyond it | Observer-relative light levels — the umbra |
| GM sees through the selected token | GM only. Also **Alt+O** and a token-control toggle |

Everything else the module does is simply on. The switches that used to gate the renderer, the
global-illumination model and the perception layer were there to bisect problems during
development, and they are gone from the menu rather than from the code — a switch whose value is
*"the module works"* is not a preference.

They are all still reachable, and a world that explicitly turned one off before this change keeps
it off, so this is the first place to look if the module appears to do nothing:

```js
game.pf1Lighting.settings()                        // every setting, with hidden: true marked
game.pf1Lighting.settings("renderEnabled")         // read one
game.pf1Lighting.settings("renderEnabled", true)   // write one
```

## Translating

Every string the module shows a user lives in `lang/en.json`. Copy it, translate the values, and
add your file to `languages` in `module.json`:

```json
{ "lang": "de", "name": "Deutsch", "path": "lang/de.json" }
```

Two entries are not free-form. `TYPES.RegionBehavior.pf1-lighting.globalIllumination` is the name
Foundry shows in the *Create Region Behavior* dropdown and the key is fixed by Foundry, not by
this module — translate the value, never the key. And `PF1LIGHTING.Tier.*` are the five brightness
levels; they appear in dropdowns, on the readout chip and in half the hints, so whatever you pick
should read the same in all three.

Strings carrying `{something}` in braces are substitutions — leave the braces and the name inside
them alone. Some hints contain `<strong>` and `<em>`; those render as markup.

Console output is deliberately not translated, and that is why the file is shorter than the
settings list implies. `game.pf1Lighting.*` readouts and the tier names the public API hands to
other modules stay English, so a script that keys off them keeps working whatever language the
table plays in — and the thirty-odd settings with no menu row are console-only, so their names
stay in the source rather than asking you to translate text nobody can reach.

## Not implemented yet

Low-light vision, dim-light concealment.

One rendering gap remains, and it is narrow: a region dimmed by an umbra is drawn dimmer only
where global illumination lit it. Ground lit by a *light source* is not dimmed, because a
light's own mesh composites over the background rather than being darkened by it. A darkness
strong enough to remove the light entirely is unaffected — that case works.

## Requirements

Foundry VTT v13, Pathfinder 1e v11+.
