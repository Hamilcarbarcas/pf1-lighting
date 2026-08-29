# PF1 Lighting

Reworked Foundry lighting to match Pathfinder 1e lighting rules.

- Light levels are now defined as discrete values (supernatural dark, dark, dim, normal, bright)
- Light sources can increase light levels in addition to static light values
- Darkness sources reduce light levels
- Magical darkness reduces brightness of areas viewed through it
- Mundane lights have no effect in magical darkness sources
- Magical daylight cancels darkness effects in its area
- Indoor spaces can be defined in scenes that ignore ambient lighting
- Low-light vision, Darkvision, See in Darkness, True Seeing and Blindsight all tooled to work RAW

**Requires** Foundry VTT v13 and the Pathfinder 1e system v11.

---

## Core features

### New lighting model

The lighting model has been reworked. The scene's lighting is now set by an underlying model that
measures the light level across the scene (from the perspective of selected tokens if eligible) based
on ambient lighting and light/darkness sources, accounting for any special vision modes the observer(s)
may have. This model is then rendered, giving each light level its configured brightness and blending
transitions between light levels. Light source colors and animations are preserved and rendered as well.

Token vision is also applied by the model, hiding any tokens that cannot be seen based on observed
lighting conditions and vision modes. This is a subtractive process, and does not affect Foundry
hiding tokens based on line of sight or invisibility.

#### Discrete levels

| Light Level | Examples |
| --- | --- |
| **Bright** | Full daylight, daylight spell |
| **Normal** | Torchlight, light spells |
| **Dim** | Shadowy illumination, darkness spells |
| **Dark** | dark rooms, darkness spells |
| **Supernatural Dark** | *Deeper darkness* |

**Supernatural Dark** acts like normal darkness, but also prevents vision granted by *Darkvision*

All lighting is built on these levels. Light sources can set or increase levels, darkness sources can
set or reduce levels.

Light levels are absolute brightness, not a brightening effect. In core foundry, lights become brighter
or dimmer based on global illumination levels. Now each level has a set brightness, and global
illumination instead sets the baseline level for the scene.

#### Umbras

Looking **through** a magical darkness lowers the light level of everything past it to the darkness's
own level. A lit room seen through a *darkness* is as dark as the spell area, and a creature with
ordinary sight cannot see tokens or scene areas beyond an area reduced to dark by a magical darkness.
Standing **inside** an area of magical darkness shadows every direction - the umbra is 360°.

Non-magical darkness sources have no umbra, and only affect the area within their radius.

#### Vision mode reworks

- **Darkvision** reveals all areas of non-magical darkness within its radius and renders them in
greyscale
- **Low-Light Vision** multiplies the radius of all light sources. It no longer multiplies the radius 
of darkness sources.
- **Blindsight** reveals all areas of magical or non-magical darkness within its radius and renders
them in greyscale. Blindsight is not suppressed by the blinded condition.
- **True Seeing** reveals all areas regardless of light level within its radius, rendering them normally.
- **See in Darkness** reveals all areas in view regardless of light level, rendering them normally.
- **Normal Vision** hides all areas in darkness or magical darkness, as well as all tokens within those
areas.

### Light sources
Light sources now have a **Lighting Configuration** section. Some existing controls have been moved 
into this section.

| Control | What it does |
| --- | --- |
| **Preset** | Apply a preset configuration |
| **Type** | Sets the source as a light source or darkness source|
| **Magical** | Magical light overrides darkness sources of lower levels |
| **Spell Level** | Set the spell level of the light effect, if magical |
| **Counts as *Daylight*** | use *daylight's* magical darkness cancelling rules for this light source |
| **Brightness** | The level this light provides outright, and the radius it provides it to |
| **Increase Brightness** | Raises the ambient light level within a given radius |
| **Active when scene is**| Set the ambient lighting window in which the source is active |

Lights can set a static light level within a certain radius, and modify the light level within an
additional radius. This allows for pathfinder's rules for most light sources (e.g. Torches provide
normal light in a 20 foot radius and increase the light level by 1 step in a 40 foot radius, to a
maximum of normal light).

Light sources only increase light levels, and never decrease them. A light source set to provide normal
light in an area of bright light has no visible effect.

*Active when scene is* is the replacement for Foundry's *Darkness Activation Range*. It keys strictly
off the scene's configured light level, not the localized light level where the source is.

Selecting a preset is an instantaneous change to the light source. The source does not remain fixed
to the preset values, and changing said preset has no effect on any lights already configured by it.

#### Darkness sources

| Control | What it does |
| --- | --- |
| **Preset** | Apply a preset configuration |
| **Type** | Sets the source as a light source or darkness source|
| **Spell Level** | Set the spell level of the darkness effect. *Mundane* is non-magical darkness |
| **Effect** | *Decrease by* n steps, or *Set level to* a specified level, along with the darkness 
floor and effect radius |
| **Active when scene is**| Set the ambient lighting window in which the source is active |

Darkness suppresses all light sources of an equal or lower level. A light source whose center is 
contained within a suppressing darkness source emits no light.

**Decrease by** reduces the light level in the area by the given number of steps. Light sources
are suppressed prior to this reduction, so if the area includes normal light from a torch lighting
a dim room, the light level is reduced from dim rather than normal. **Set level to** overrides the
current light level and sets it to the given value.

Darkness sources do not have multi-tiered effects, so only use one radius.

A darkness **spreads the way light does**. A wall that lets light through — a window, an open doorway — lets
a darkness through as well, and a wall that blocks light blocks it. Foundry on its own treats every wall as
blocking darkness regardless of what the wall allows, including open doors; this corrects that.

A darkness is also **hidden where a creature cannot see**. Foundry masks its light and colour layers to
what the viewer can see and does not mask darkness, so a darkness bubble used to be drawn — and visibly
moving — through walls, in rooms a player had no vision into. It is now withheld outside vision the way a
light already is.

An ordinary darkness is rendered by **removing light** rather than by drawing anything, which means an
animation chosen in its config has no surface to run on. The module draws one faintly so the animation
shows, tinting the area slightly darker than the rules say. There is no setting for this, because choosing
an animation on the darkness *is* the setting: a darkness with none is untouched — no mesh, no cost, no
tint — and a *deeper darkness* already draws either way.

---

### Presets

The first control on the Lighting Configuration section fills in everything else. Eleven ship with the
module:

| Preset | Values |
| --- | --- |
| Candle | +1 step to 5 ft |
| Torch | normal to 20 ft, +1 to 40 |
| Lamp, common | normal to 15 ft, +1 to 30 |
| Lantern, bullseye | normal to 60 ft, +1 to 120 |
| Lantern, hooded | normal to 30 ft, +1 to 60 |
| Sunrod | normal to 30 ft, +1 to 60 |
| *Continual flame* | magical, level 2 — normal to 20 ft, +1 to 40 |
| *Light* | magical, cantrip — normal to 20 ft, +1 to 40 |
| *Daylight* | magical, level 3 — bright to 60 ft, +1 to 120, counts as daylight |
| *Darkness* | magical, level 2 — one step down for 20 ft, floor of Dark |
| *Deeper darkness* | magical, level 3 — two steps down for 60 ft, floor of Supernatural Dark |

The **bullseye lantern lights a cone** in the rules, and the preset sets radii only — set the Angle field
by hand afterwards. Presets deliberately leave the angle alone so switching between them never traps a
light in a cone it did not ask for.

A preset is a starting point, not a mode. Changing any field it governs sets the selector back to
**Custom**, and it stays there — the label records where the numbers came from, which is not something you
can work out by looking at them later. Radii are the exception: widening a torch to light a bigger room
does not stop it being a torch.

**Settings → PF1 Lighting → Lighting Presets → Edit Presets** edits the table itself: retune the shipped
entries to your table's numbers, or add your own. It edits one preset at a time and holds everything in a
working copy, so switching between presets keeps your edits and closing without saving discards them.
**Restore defaults** puts the world back on the module's own table, and back to tracking it as the module
changes.

- **Editing a preset does not change lights already placed from it.** A preset fills fields in at the
  moment you choose it and is never read again afterwards.
- **Deleting one is harmless.** A light placed from a preset that no longer exists reads as Custom and
  renders exactly as before. Renaming keeps a preset's identity, so lights placed from it follow the new
  name.
- **A preset can carry an activation range, and by default does not.** Leave *Active when scene is*
  spanning Bright to Dark and applying the preset will not disturb a range you set by hand.

---

### Overlapping increases

**Where two lights' outer bands overlap they brighten each other.** Each band raises the level a step, to
that light's own cap, so two overlapping dim bands read as Normal — darkness to normal for two torches. A
third light adds nothing, because each caps the increase at its own level.

This is **computed always and drawn optionally**. The overlap really is one step brighter as far as every
rule is concerned — the readout says so, and it is what creatures can see by — but the renderer leaves it
looking like plain overlapping light unless *Draw overlapping light bands brighter* is switched on. When it
is, the overlap is drawn as a region in the same brightness map as everything else, so it fades over the
same transition width as every other boundary.

---

### Ambient lighting changes

The scene config's **Lighting** tab has a **Light level** dropdown — Bright, Normal, Dim or Dark — in place
of Foundry's darkness slider. The model works in discrete levels, so a slider offered precision that does
not exist.

The **lighting controls** carry the same four as buttons — *Set ambient light to Bright / Normal / Dim /
Dark* — replacing Foundry's *Transition to Daylight* and *Transition to Darkness*. They change the scene at
once rather than fading over ten seconds, which against four discrete levels was a slow step through the two
in between.

The scene remembers the **level** you picked, not just the number behind it. So if you later decide Dim
should be darker, every scene set to Dim follows without being reopened. Scenes you have never set through
the dropdown are left alone — it shows their nearest level so it reads sensibly, but nothing is written
until you choose one.

A scene with **darkness locked** is skipped and reported, and shows no buttons, because Foundry refuses
darkness changes on it. That makes the lock the natural way to keep a dungeon out of an automated day/night
cycle — but note it means *frozen*, not merely *ignore the clock*: a locked scene cannot be changed from the
dropdown either.

#### Interior regions

A room that stays dark on a sunlit map, without hand-placing anything.

Draw a **region**, add the behaviour **Restrict Global Illumination**, and give it a **Light level** and a
**Mode**:

- **Maximum** (the default, and the one you want for an interior) — *no brighter than this*. The cellar
  stays dark at noon and does not turn into a light source at midnight when the sky outside drops below it.
- **Minimum** — the other half.
- **Set to** — overrides the scene outright.

The region changes ambient light and nothing else. **Lights inside still light it** — in fact a torch works
*better* in a room the region has darkened, because it has more to add — a *darkness* inside still suppresses
it from the lower base, and the area itself casts no umbra. It is an unlit room, not magical darkness.

Its edge is drawn hard, not feathered, since a region boundary follows a wall. Region elevation is ignored;
the model is flat.

Core's own *Adjust Darkness Level* behaviour does not work while this module is rendering; this replaces it.

##### Light spill

A room darkened by a region should still catch the daylight coming through its window. It does, with nothing
to place: **any wall on the border of such a region that does not block light becomes an aperture**, and the
outdoor light comes in through it.

A window is simply a wall whose *Light* restriction is set to none. **An open door counts while it is open** —
Foundry drops every restriction on a door's wall as it swings, so opening one lets the light in and closing it
takes it away, with no configuration at all.

Light spreads in from the gap and steps down one level at a time — bright, normal, dim — until it runs out.
**The distance is measured along the floor, not through the air**, so light that has to turn a corner spends
its reach getting there and arrives dimmer. Standing one square to the side of a doorway is not the same as
standing in front of it, and a room reached through two turns of a corridor is darker than one reached through
a single doorway at the same range. Walls stop it exactly where they stand.

Three things follow from the light being the *sky* rather than anything you placed:

- **A darkness over the window dims what comes through it.** Cast *darkness* on a window and the spill starts
  at dim instead of bright, so it throws a tenth as far. *Deeper darkness* shuts it off entirely, and a
  *daylight* cancelling that darkness restores it.
- **At nightfall it stops on its own.** Once the sky is darker than the room, no window on the scene qualifies
  and nothing is computed.
- **A candle on the windowsill does not flood the room.** It already shines through the window on its own, the
  way any light does, and spill deliberately ignores it.

**Windows in the same room are worked out together**, in one pass rather than one each, so two windows lighting
the same floor give the brighter of the two with no seam between them. Where they differ in brightness — one
under a *darkness*, say — the dimmer one simply starts further down the same ladder.

Spill is treated as global illumination by everything else in the module — the readout, what a creature can see,
perception, and any darkness cast over it — because it *is* global illumination, reaching ground it otherwise
could not.

**Settings → PF1 Lighting → Light Spill → Configure Light Spill** holds the numbers: an on/off switch, **how
far each brightness carries** before it drops to the next one down (40 / 20 / 10 feet for bright, normal and
dim), and the grid resolution the falloff is worked out at. So bright daylight holds for forty feet, reads as
normal for the next twenty and dim for the last ten — seventy feet in total — while a window that is only dim
outside reaches ten. The reach is the sum of the rungs below wherever it starts, so lowering one number
shortens every ladder that passes through it. The window shows you the total as you edit.

---

### Light level tooltip

A chip beside the pointer showing the light level under the cursor, or of a hovered token. **Alt+L** toggles it.
It only appears over the scene itself — move the pointer onto a sheet, a dialog or the sidebar and it goes away.

**GM only by default.** The light level is information — a player reading the exact level under their token
knows something their character would have to work out — so **Light level is GM only** starts on and you turn it
off to share. Each player then still chooses whether to show their own chip.

With **Light level details** on it says *why*, not just what: "Dim · reduced from normal", "Normal · darkness
present, no effect", "Bright · darkness cancelled by daylight", "seen through darkness".

Hovering a token shows its name, and that name respects who is looking: a token whose nameplate a player cannot
see reads `???`, and if
[`pf1-token-randomizer`](https://github.com/Hamilcarbarcas/pf1-token-randomizer) is installed its DM-authored
obscured names are used for anyone below Observer. Nothing is required — the tie-in is used if the module is
there and skipped silently if not.

Token readouts sample the centre plus four quarter-offset points and report the **brightest**, so a large token
straddling a light's edge reads as lit.

---

### GM token view

Whose point of view the lighting is resolved for. **Alt+O**, the **Token Vision** button in the token controls,
or the **GM sees token vision** setting.

- **On** (default) — selecting a token as GM shows you what that token perceives.
- **Off** — you keep the god's-eye view even with a token selected, which is what you want while moving tokens
  rather than adjudicating what one can see.

Players are unaffected by the toggle: selection always narrows to the selected token, and with nothing selected
they get the union of the tokens they own or observe (PF1's **Guaranteed Vision** setting decides which). One fix
rides along here — PF1 lets a vision-shared token stay a vision source even when a player has selected something
else, so selecting one token did not actually narrow their view. It does now.

---

## Configuration

Five switches and three windows, under **Settings → Configure Settings → PF1 Lighting**.

| | |
| --- | --- |
| **Visuals** → *Configure Visuals* | How bright each level is drawn, the transition width, unseen-ground dimming, see-in-darkness brightness |
| **Lighting Presets** → *Edit Presets* | The named light and darkness configurations offered on a light's sheet |
| **Light Spill** → *Configure Light Spill* | Whether windows let the daylight in, and how far each brightness carries indoors |
| **Show light level** | Your own readout chip. Also **Alt+L** |
| **Light level is GM only** | Whether players get one at all — on by default |
| **Light level details** | The *why* line. GM only |
| **Magical darkness casts shadows** | Observer-relative light levels — the umbra |
| **GM sees token vision** | GM only. Also **Alt+O** and a token-control toggle |

Everything else the module does is simply on. Around thirty further settings exist with no menu row — they were
development bisection aids rather than play features, and a switch whose value is *"the module works"* is not a
preference. They are all still reachable from the console; see [DEBUGGING.md](DEBUGGING.md).

### Configure Visuals

Four **Darkness levels** — Bright, Normal, Dim, Dark — set how dark the ground at each level is painted, from 0
(full daylight) to 1 (unlit). The gaps between them are what makes one level readable against the next, so this
is what to reach for if the map looks flat or if night scenes read too bright. They should descend in brightness:
Bright lowest, Dark highest. Supernatural Dark is drawn at the same level as Dark and told apart by the darkness
effect's own overlay. Changing any of them re-solves how light sources paint as well, so lights and ground stay on
the same ladder.

**Brightness transition width** is the one distance every brightness boundary in the module fades over — a room's
edge, a darkness rim, a light's two zones, a window's falloff, the edge of what you can see. Set it to 0 and every
boundary becomes a hard edge at once. A boundary two steps apart is not made wider for it, because a wider fade
would read as *less* of a step. Light stops at a wall and the softening is held back there too, so a lit room does
not glow through its own walls.

**Unseen ground dimming** is how far explored ground outside your current vision is taken toward black, on top of
already being drawn at Dark. Foundry hard-codes this at 0.5, which stacks heavily on dark terrain; this defaults to
0.2. Ground you have never visited stays solid black either way.

**See-in-darkness brightness** adjusts how bright terrain looks to a creature with *see in darkness* or *true
seeing*. Foundry lightens this vision type by default; negative values dim it back toward normal vision.

---

## Compatibility

This module **overrides Foundry's underlying lighting and vision systems** rather than sitting on top of them. It
replaces how the scene is lit, how darkness is swept, how detection modes answer, how the darkness-level texture is
painted, and how desaturation is applied.

**Anything else that touches Foundry's vision system is likely to conflict.** That includes modules that patch
detection modes, replace vision or light source classes, draw their own lighting layer, or manipulate the darkness
level directly.

Two known interactions, both handled:

- **`limits`** — its wrap of the per-mode `_testPoint` composes correctly, because this module runs core's own
  detection loop rather than reimplementing the tests. Its source-class mixins are applied first, and this module
  sits on top.
- **`pf1-light-level-tooltip`** — untouched and still works standalone. This is a fresh implementation, not a
  reparenting of it. Note **both bind Alt+L by default**, so rebind one if you run both.

`pf1-token-randomizer` is an optional tie-in, not a requirement.

One rendering gap remains: **an area dimmed by an umbra is drawn dimmer only where global illumination lit it.**
Ground lit by an actual light source is not visibly dimmed, because a light's own mesh composites over the background
rather than being darkened by it. What creatures can *detect* is correct either way, and a darkness strong enough to
remove the light entirely is unaffected.

---

## Performance

**Light spill is the expensive feature.** It floods a distance field across an interior region's floor, and the cost
rises with the region's area and with the number of doors and windows on its border.

It is recomputed only when the lighting actually changes — a door opening or closing, a wall edited, the scene's
ambient level moving, a darkness crossing a window. It does **not** run per frame or per token move. Heavy wall
editing on a map with several windows is where you will feel it.

If a scene is slow:

- **Break large interiors into smaller regions.** One region per room costs far less than one region wrapping a whole
  floor plan.
- **Raise the Grid resolution number** in *Configure Light Spill*. It is the size of the flood-fill cell in pixels
  (default 25), so a **larger** number means fewer cells and less work. Lowering it increases cost sharply. An even
  divisor of the scene's grid size aligns best with walls; too large and small windows can be missed.
- **Turn light spill off** entirely if the scene has no interiors that need it.

**Dragging many tokens at once with GM token vision on** is the other bottleneck. Each move re-resolves the observer's
view, and doing that for a large selection mid-drag costs. Turning **Token Vision** off (**Alt+O**) removes it — which
is what that toggle is for while you are arranging a map rather than adjudicating what a creature can see.

---

## More

- **[DEBUGGING.md](DEBUGGING.md)** — the console surface: overlays, probes, benchmarks, and the settings with no menu
  row. Start here if the map does not look the way you expect.
- **[API.md](API.md)** — the supported surface for other modules and macros.
- **DESIGN.md** — the full design record.
