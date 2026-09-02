# Changelog

<!--
  Release process: before tagging v<x.y.z>, rename the "Unreleased" heading
  below to "## [<x.y.z>] - <YYYY-MM-DD>". The release workflow extracts the
  section whose heading matches the pushed tag and uses it as the GitHub
  release body. If no matching section exists, the release fails.
-->

## Unreleased

### Added
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