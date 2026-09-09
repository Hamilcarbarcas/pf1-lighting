# Changelog

<!--
  Release process: before tagging v<x.y.z>, rename the "Unreleased" heading
  below to "## [<x.y.z>] - <YYYY-MM-DD>". The release workflow extracts the
  section whose heading matches the pushed tag and uses it as the GitHub
  release body. If no matching section exists, the release fails.
-->

## Unreleased

### Added
- **Sightless — a creature with no eyes at all.** A new checkbox at the top of the actor's Senses
  window, for a grimlock, an ooze, or an oracle with the blind curse. It perceives by blindsight,
  blindsense, tremorsense, scent and lifesense, and by nothing else. It is not the *blinded*
  condition and carries none of its penalties — it removes senses and nothing more, so a Sightless
  creature with blindsight still sees out to its blindsight range and one with no other sense sees
  nothing at all. Pathfinder defines darkvision as "otherwise like normal sight", so Sightless takes
  that too, along with low-light vision, see in darkness, true seeing and see invisibility; when the
  box is checked beside a sense it overrides, the window says which, and the values stay on the sheet
  rather than being hidden or cleared. Everything a Sightless creature perceives is drawn in black
  and white — it makes out a lit floor and an unlit one identically, so its view is not shaded by
  light level. The same now applies to a blinded creature perceiving by blindsight. Sightless shows
  as a tag in the Senses row on the actor's Attributes tab, ahead of the senses it governs.
- **Light effects — a light that follows what it is attached to.** Cast *light* on a thrown rock,
  hand a lantern to a guard, or drop a *darkness* on a trap, and the light travels with it. The
  target's own light configuration is never touched, so several effects can be in force at once and
  each ends without disturbing the others. Works on tokens, tiles and templates alike, which covers
  the actor types that have no sheet to hang a buff on — a vehicle, a trap or a haunt is lit the same
  way a wizard is.
- **A light button on the token HUD.** Click to put a light out, right-click to swap it. The picker
  lists the light sources on that actor with their remaining fuel, showing what you are out of rather
  than hiding it. A GM gets *Any light source…* above it, which offers every preset and ignores
  inventory entirely — select a trap, choose *Darkness*, done.
- **Fuel, in game time.** Advancing the clock six hours costs six hours of oil, and partial use is
  carried across: a lantern lit for half an hour and put out picks up where it left off. Foundry's
  own light sources are known by name and need no setting up. The new **Fuel use** setting decides
  whether fuel is actually removed, only announced, or both; *announce only* is the default, so no
  table loses equipment to bookkeeping it did not ask for.
- **A light section on the item sheet's Advanced tab.** Describe what a homebrew lantern or a magic
  item gives off, and what it burns. On a **buff** the same section means *while this is active, its
  actor glows* — so *light*, *daylight* and *darkness* are ordinary buffs with a duration and a
  preset, with no scripting anywhere. The section collapses to its header, showing the preset it
  holds, so it costs a line on the items that do not use it.
- **Edit Light Sources**, a new settings window listing which items give off light when lit and what
  they burn. It ships with Pathfinder's own kit and is where a differently named lantern, a
  house-ruled burn time, or a table playing in another language goes in.
- **A light-effect list on the lighting controls**, showing everything lit on the current scene —
  what it is on, what it emits, what put it there, what it is burning and when it ends — with
  click-to-pan, a per-entry *put it out*, and **Clear orphans** for effects whose source has been
  deleted. That housekeeping also runs by itself on world load and scene change, across every scene.
- Lighting presets now carry an **appearance**: colour, strength, falloff and animation, editable in
  *Edit Presets* alongside everything else. The built-in presets are tinted and animated to suit —
  a torch flickers orange, a sunrod glows cold and steady.

### Changed
- **Low-light vision now reads ambient dim light as normal light.** A moonlit night or a dusk scene
  looks like day to a creature with low-light vision, which is what the rules say it should:
  *"characters with low-light vision can see outdoors on a moonlit night as well as they can during
  the day."* Only the ambient level is lifted — a torch's own dim ring is untouched, its radius
  having already been doubled for the same creature, so on a moonlit night a torch correctly stops
  adding anything. Magical darkness is unaffected: a *darkness* over a moonlit night is still dark.
  The lift follows Pathfinder's own rule for who counts as a low-light observer, so it turns on and
  off exactly when the doubled light radii do. Note that if a scene or region uses dim ambient light
  to stand in for fog or smoke rather than for genuine low light, a low-light creature will see
  through it.
- **Edit Presets now opens Foundry's own light configuration sheet.** The preset window is a list, a
  name and an *Edit light* button; everything else is the real sheet, so a preset can hold any
  setting a placed light can — angle, rotation, coloration technique, luminosity, shadows and the
  rest — instead of only the fields the old form reproduced. Position fields are hidden, since a
  preset is not anywhere.
- **Applying a preset now sets a light's colour and animation as well as its radii and levels.**
  Every preset states a full appearance, so switching a light from *Torch* to *Sunrod* replaces the
  orange rather than leaving it behind. Lights already placed are untouched until you re-apply a
  preset to them.

### Fixed
- **The light level tooltip no longer sticks on a token's name and level.** Deselecting a token while
  the pointer was resting on it ended the hover without Foundry announcing it, so the tooltip went on
  reporting that token wherever the cursor went, and hovering the token again was the only way to
  clear it. The tooltip now reads Foundry's own hover state rather than trusting the announcement, so
  it corrects itself the moment the hover ends. Switching the tooltip off and on also re-reads what is
  under the pointer, so a reading that has stuck always has a way out.
- **Blindsight no longer replaces a creature's ordinary vision.** Pathfinder 1e treats blindsight as
  a kind of darkvision, which put a blindsighted creature into the black-and-white vision mode and
  cut its sight range down to its blindsight range — so a scout with normal eyes and blindsight 30
  saw a thirty-foot grey circle and nothing else. Blindsight is now additive: the creature sees
  everything it saw before, in colour, and its blindsight fills in what light cannot reach. Ground it
  makes out by blindsight alone still reads grey, since that is not sight. A creature that also has
  darkvision is unaffected.
- **A low-light multiplier below 1 no longer puts out every light on the scene.** Pathfinder 1e takes
  the multiplier straight from the sheet, so an actor with low-light vision enabled and a multiplier
  of 0 — the system's own default is 2 — extinguished every light source while that token was
  selected, for everyone standing with them. The map went genuinely black and the creature looked
  blinded. Low-light vision can now only ever extend a light.
- **A darkness across a lit room stays visible to a blindsighted creature.** Darkness that a creature
  can map by echo is drawn as ordinary floor to it, which was being applied to every darkness on the
  scene rather than to the ones actually within its blindsight.
- **Light spill now comes through proximity windows.** A wall set to *Proximity* or *Reverse
  proximity* for light is the usual way to draw a window that a passing torch does not shine
  through, and spill ignored every one of them — only *None* counted as an opening. Such a wall is
  now an opening for spill, and light passes it everywhere else in the module for the same reason.
  A proximity wall left at a threshold of 0 blocks light for everything in Foundry, and still blocks
  here.
- The light level tooltip no longer reports the light level of ground the viewer cannot see. Area
  behind a wall is drawn dark but was still read at its own level — a lit room past a corner
  reported *Bright* while the screen showed it dark. It now reads *Dark*, with "out of sight behind
  a wall" as the explanation. A GM with no token selected keeps the god's-eye view and is unaffected.

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