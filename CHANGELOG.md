# Changelog

<!--
  Release process: before tagging v<x.y.z>, rename the "Unreleased" heading
  below to "## [<x.y.z>] - <YYYY-MM-DD>". The release workflow extracts the
  section whose heading matches the pushed tag and uses it as the GitHub
  release body. If no matching section exists, the release fails.
-->

## Unreleased

### Added
- **Skylights.** A new **Openings** checkbox on the *Restrict Global Illumination* region behavior
  lets light spill across that region's own outline wherever no wall stands on it. Cut a hole in the
  region with Foundry's hole tool and the sky reaches the floor there, falling off into the room from
  the hole's edge the same way it does through a window. Because a hole is simply ground the region
  does not cover, a skylight brightens at dawn and goes dark at dusk on its own. The same tick also
  softens a region edge that runs across open floor, such as a gap in a wall line or a cave mouth
  drawn as a region rather than walled. Off by default on every region, and walls still block whether
  it is ticked or not.

### Fixed
- **A scene with no tokens on it stopped updating.** Changing global illumination, the darkness
  level or the ambient colours left the picture as it was until a token was placed. The module now
  listens for the scene's own ambience changing rather than relying on a signal that only travels
  through tokens.
- **Deleting the last token left its point of view on screen.** The lighting stayed as that token had
  seen it, and nothing shifted it until another token was placed or the scene was reloaded. Deleting
  a token now redraws, which it never did - a token being removed is the one change that cannot
  announce itself the way every other token change does.

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