# Changelog

<!--
  Release process: before tagging v<x.y.z>, rename the "Unreleased" heading
  below to "## [<x.y.z>] - <YYYY-MM-DD>". The release workflow extracts the
  section whose heading matches the pushed tag and uses it as the GitHub
  release body. If no matching section exists, the release fails.
-->

## Unreleased

### Added
- **Other modules can keep part of a view out of fog of war** (`api.unexplored`, documented in API.md):
  the area shows normally but is never recorded as explored.
- **Revealed areas can be raised** (`polygon.elevation`, in API.md): a revealed rooftop is lit only by
  light that reaches its height, so lamps inside a building no longer show through its roof.
- **Other modules can reveal areas to an observer** (`api.revealed`, documented in API.md): the
  opposite of withheld regions. A revealed area shows lit by whatever light reaches it, or within
  darkvision, and is never recorded in fog of war.

### Fixed
- **A token carrying a light moves more smoothly on large scenes.** Moving one light no longer redoes
  the work for every other light on the scene.
- **Light spill no longer leaks out of a room around its corners.** A window or door ending exactly on
  a wall corner could start the spill just outside the room, so the light band curved around the
  outside of the building.
- **Selecting a token no longer stalls the canvas for a second on large lit scenes.** Lights were
  rebuilt three times over for every selection; the repeats are now recognized as no change. Animated
  lights and light spill through windows no longer force a full rebuild when nothing changed either.
- **Areas hidden behind walls no longer flash into view as a token moves.** When another module
  hides ground in a ring around an area, such as everything just outside a walled town seen from
  above, the hidden ground could briefly show (grayed, for a token with darkvision) as the token
  moved.
- **Revealed areas that overlap a token's view are no longer drawn dark.** Depending on how the
  outlines were drawn, the overlap could cancel out and be shaded as unseen ground.
- **The light level tooltip reads Dark over a roof nobody can see.** It used to report the roof's
  light even where the roof was hidden in fog.
- **The light level tooltip no longer calls a token Dark just because it stands where you cannot
  see the ground.** A token you can see (over a wall, for example) now shows the light it stands in.
- **The light level tooltip no longer calls ground enclosed by hidden ground "unseen".** When another
  module hides an area with a gap in its middle (the ground inside a ring of low walls seen from
  above, say), the tooltip treated the visible gap as hidden too. The picture was already right;
  only the tooltip was wrong.
- **Dark areas no longer get explored on scenes with global illumination.** Ground the module shows
  as dark, such as inside a darkness or a room cut off from global illumination, was recorded in fog
  of war whenever a token had line of sight to it, even though nothing there could be seen. Only
  lit ground, and ground within a token's darkvision, is explored now. Fog already explored this way
  stays explored until fog is reset on that scene.
- **A light put out by darkness no longer explores fog.** A torch carried into a *darkness*, or a
  light entirely covered by magical darkness, went dark on screen but still recorded its whole
  radius as explored for anyone with line of sight to it. It now reveals nothing while it is out.
- **Deselecting a token with low-light vision no longer explores extra fog.** With vision sharing
  on, releasing a token that has low-light vision briefly showed every shared token's view with
  lights at low-light size, and fog recorded it. Lights now resize before the view changes.
- **Roofs no longer show the rooms beneath them.** An overhead tile set to **Restricts Light** showed
  the light level of everything under it: a dark interior, a lantern in a room, light through a
  window. It now shows the scene's outdoor light level, and only a light placed higher than the roof
  lights it, matching how Foundry treats a roof. When the roof fades for a token underneath, the
  rooms show through as before. The light level tooltip now reports the roof's level over a roof,
  instead of the room's.

### Changed
- **Overlapping lights no longer stack their color.** Where two lights overlapped, their tints added
  together, making the overlap look brighter than either light. The strongest tint now wins. Lights
  of different colors still mix where they overlap, but less strongly than before.
- **With Wall Height installed, a light effect on a token shines from the token's height.** Walls
  lower than the token no longer block it, and walls taller than it still do, the same as a light
  set on the token itself. Before, it was judged from the height of whichever token you had
  selected, so the same lantern could cast different shadows for different viewers.
- **The light section keeps its place on the Advanced tab.** Sections added by modules sharing the same sheet kit now sort alphabetically below Script Calls, instead of in whichever order their render hooks finished — which could change every time the sheet redrew.
- **Show light level** is saved per user instead of per browser, so a player's choice follows them to
  any device. A choice saved under the old per-browser setting is not carried over and starts from
  the default (off).

### Added
- **Light badge on tokens.** A token with a light effect on it shows a small flame on its right
  edge, in the light's color, or a violet moon for darkness. Each user can turn it off with **Show
  light badge on tokens**.
- **API: withheld regions.** Another module can hide areas of the map from a particular observer:
  they stay fogged and unexplored, for ordinary sight and darkvision alike, as if a wall stood in the
  way. See `API.md`.
- **API: `sceneTierUpdate(tier)`** returns the scene update that `setSceneTier` would write, so
  another module can include a light level in an update of its own. See `API.md`.
- **Skylights.** A new **Openings** checkbox on the *Restrict Global Illumination* region behavior
  lets light spill across that region's own outline wherever no wall stands on it. Cut a hole in the
  region with Foundry's hole tool and the sky reaches the floor there, falling off into the room from
  the hole's edge the same way it does through a window. Because a hole is simply ground the region
  does not cover, a skylight brightens at dawn and goes dark at dusk on its own. The same tick also
  softens a region edge that runs across open floor, such as a gap in a wall line or a cave mouth
  drawn as a region rather than walled. Off by default on every region, and walls still block whether
  it is ticked or not.

### Fixed
- **No more hard-edged blocks in light gradients near walls.** Where the edge of a light ran up to a
  wall, the softening stopped short of the wall in a straight line, leaving a sharp rectangular
  step. The softening now runs right up to the wall without crossing it, so light still does not
  bleed through walls.
- **Low walls that a light shines over no longer sharpen its edges.** With Wall Height, a wall
  lower than a light was still treated as blocking it for softening. A low wall now keeps edges
  sharp only while it actually blocks some light.
- **Module settings take effect on the first change.** Changing a setting from the console or a
  macro sometimes applied the previous value, so a switch could take two presses to change anything.
- **A token's preview no longer explores fog through magical darkness.** With drag vision on, the
  ground seen from a drag's destination past a magical darkness stayed explored after the drag was
  cancelled, even though the token never went there. The same applied to a blinded token. Their
  view now shows without being recorded, as Foundry intends.
- **Areas hidden by magical darkness are drawn correctly when the visible area is in several
  pieces.** Only the last piece had its hidden areas cut out. No current scene can produce this, but
  upcoming features will.
- **Adding or changing an entry in a sheet section no longer jumps the sheet back to the top of
  the tab.** Sections from the shared sheet kit now restore the scroll position once they have
  drawn.
- **Light spill stayed bright after the scene was darkened.** Turning the scene down from Bright
  could leave windows spilling Bright light, sometimes outward into the yard and on into other
  buildings, until the scene was set to Dark or the region was toggled. Spill now judges the light
  outside a window without counting its own earlier output.
- **A scene with no tokens on it stopped updating.** Changing global illumination, the darkness
  level or the ambient colours left the picture as it was until a token was placed. The module now
  listens for the scene's own ambience changing rather than relying on a signal that only travels
  through tokens.
- **Deleting the last token left its point of view on screen.** The lighting stayed as that token had
  seen it, and nothing shifted it until another token was placed or the scene was reloaded. Deleting
  a token now redraws, which it never did - a token being removed is the one change that cannot
  announce itself the way every other token change does.
- **A light effect stopped following its token after the token was selected.** Once you had
  selected or deselected a token, a light given to a token from the HUD (or by an item or buff) was
  drawn one move behind as the token walked, until you clicked off it again. Only the client doing
  the selecting was affected. The light now follows on every move.

## [0.2.0] - 2026-09-09

### Added
- **Sightless**, a checkbox on the actor's Senses window that removes all sight-based sense — normal 
  sight, darkvision, low-light vision, see in darkness, true seeing, and see invisibility.
- **Light effects** — a light that travels with the token it is attached to, without touching that 
  object's own light configuration.
- **A light button on the token HUD.** Click to put a light out, right-click to swap it. The picker
  lists that actor's light sources with their remaining fuel; a GM also gets *Any light source…*,
  which offers every preset and ignores inventory.
- **Fuel, in game time**, with partial use carried across. The new **Fuel use** setting decides
  whether fuel is removed, only announced, both, or ignored.
- **A light section on the item sheet's Advanced tab**, describing what an item gives off and what it
  burns. On a **buff** it means *while this is active, its actor glows*, so *light*, *daylight* and
  *darkness* are ordinary buffs with no scripting.
- **Edit Light Sources**, a settings window listing which items give off light and what they burn —
  where a renamed lantern, a house-ruled burn time or another language goes in.
- **A light-effect list on the lighting controls**, showing everything lit on the scene, with
  click-to-pan, a per-entry *put it out*, and **Clear orphans**. That housekeeping also runs on world
  load and scene change, across every scene.
- Lighting presets now carry an **appearance** — color, strength, falloff and animation — editable in
  *Edit Presets*.

### Changed
- **Fuel is now ignored by default, and every light burns indefinitely.**
- **Light Sources now sits above Lighting Presets** in the module settings.
- **Low-light vision now reads ambient dim light as normal light**, per *"characters with low-light
  vision can see outdoors on a moonlit night as well as they can during the day."* Only the ambient
  level is lifted.
- **Edit Presets now opens Foundry's own light configuration sheet**, so a preset can hold any
  setting a placed light can — angle, coloration technique, luminosity, shadows — instead of only the
  fields the old form reproduced. Position fields are hidden.
- **Applying a preset now sets a light's color and animation** as well as its radii and levels.
  Already-placed lights are untouched until a preset is re-applied to them.

### Fixed
- **The light level tooltip no longer sticks on a token's name and level.** Deselecting a token while
  hovering it ended the hover without Foundry announcing it. The tooltip now reads Foundry's own
  hover state, and switching it off and on re-reads what is under the pointer.
- **Blindsight no longer replaces a creature's ordinary vision.** Blindsight is now additive; ground 
  made out by blindsight alone still reads gray, but ground seen by other means maintains color vision.
- **A low-light multiplier below 1 no longer puts out every light on the scene.** Low-light vision
  can now only ever extend a light.
- **A darkness across a lit room stays visible to a blindsighted creature.** Darkness drawn as
  ordinary floor was being applied to every darkness on the scene rather than to those within
  blindsight range.
- **Light spill now comes through proximity windows.** A wall set to *Proximity* or *Reverse
  proximity* for light is now an opening for spill.
- The light level tooltip no longer reports the level of ground the viewer cannot see. Area behind a
  wall now reads *Dark*, explained as "out of sight behind a wall".

## [0.1.2] - 2026-08-29

### Fixed
- Low-light vision no longer widens the area in which a *daylight*-style light cancels a
  darkness. Cancellation now uses the light's configured radius directly.
- A light **inside** a darkness/*daylight* cancellation overlap is no longer incorrectly suppressed.
- The cancelled segment of *daylight* no longer adds its step increase to another light's in the overlap.
- Removed the "ready — vertical slice" console error printed on startup.

## [0.1.1] - 2026-08-29

### Added
- Beta release.