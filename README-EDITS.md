# Documentation edits pending review

Changes made to published documentation, for a human pass before release.
**Delete an entry once you have reviewed it** — what is left is the queue.

---

## 2026-08-30 — `API.md` — §12 light effects (build step 4)

Prompted by: the `api.lights` surface going onto the frozen API object.

### 1. ADDED — new section `# Light effects`

Inserted **between `# The scene's light level` and `# Hooks`**. Also added
`- [Light effects](#light-effects)` to the `# Contents` list, between *The scene's light level* and
*Hooks*.

New text:

> A *light* or *darkness* that follows what it was cast on, and a lantern that follows its bearer.
> Nothing on the target's own light is ever written — the effect is a separate, invisible light
> source pinned to it — so several effects can be in force at once and each one ends without
> disturbing the others.
>
> | Function | |
> | --- | --- |
> | `await api.lights.apply(anchor, effect)` | Attach an effect. Returns its **id**, or `null` if nothing was applied |
> | `await api.lights.clear(anchor, ref)` | Remove one. `ref` is an id **or** `{ source: uuid }`. Returns how many came off |
> | `await api.lights.clearAll(anchor)` | Remove every effect. Returns how many |
> | `api.lights.list(anchor)` | The effect records currently on an anchor |
> | `await api.lights.place(point, options)` | Create a real `AmbientLight`. **Not an effect** — see below |
>
> `anchor` takes a `Token`, `TokenDocument`, token id, `Tile`, `MeasuredTemplate`, or an array of any
> of them — plus an **`Actor`**, meaning every one of its tokens on the canvas, which is what a buff
> script has to hand. Bare points are not anchors; use `place`.

…followed by four subsections: **The effect** (a field table), **`source` is what makes a toggle two
lines** (the two-line buff-toggle example plus the auto-sweep note), **Who may apply one**
(ownership, GM-side check, no-GM behaviour), and **`place` is a different verb**.

### 2. CHANGED — `# Versioning`

**Before:**

```
Feature-detect on this rather than on the module's own version.
```

**After:**

```
Feature-detect on this rather than on the module's own version. Added functions do not move it, so
feature-detect a *newer* addition on the thing itself — `if (api.lights)` — rather than on a number
that deliberately stayed still.
```

### Not changed

`README.md` — untouched. The feature has no user-facing surface yet (GM console and API only); the
HUD button, item sheet section and management window are build steps 6–9, and the README entry goes
in with them.

---

## 2026-08-30 — `README.md` + `CHANGELOG.md` — preset appearance (build step 5)

Prompted by: presets gaining colour, strength, falloff and animation, and the preset editor gaining
rows for them.

**Note for review:** the *Changed* half of the changelog entry is a **behaviour change to an existing
feature** — applying a preset now overwrites a light's colour and animation. Worth reading with that
in mind; the wording is trying to make it sound intentional rather than surprising, because it is.

### 1. ADDED — `README.md`, under `## Presets`

Inserted **between the `![Presets Configuration]` image and the "Emission angles" paragraph**:

> Each preset also carries an **appearance** - colour, strength, falloff and animation - so a torch
> flickers orange and a sunrod glows cold and steady without any further setup.
>
> Every preset states a full appearance, including the ones that are plainly lit. That is deliberate:
> it means choosing a preset always *replaces* the previous one's colour and animation instead of
> leaving them behind, so a light changed from *Torch* to *Sunrod* does not stay orange.

Nothing else in that section changed. The eleven-row preset table was **not** updated — it lists what
each preset *does*, and colour is not that. Say if you would rather it carried a colour column.

`## Edit Presets` was also left alone: it says the editor "has all the same control surfaces as the
**Light Configuration** section of a light source", which is now *less* true, since the editor has
appearance rows the light config sheet does not. Flagging rather than fixing — the sheet may want the
same rows later, which would make the sentence true again.

### 2. ADDED — `CHANGELOG.md`, new `## Unreleased` section

Inserted **above `## [0.1.2] - 2026-08-29`**:

```
## Unreleased

### Added
- Lighting presets now carry an **appearance**: colour, strength, falloff and animation, editable in
  *Edit Presets* alongside everything else. The built-in presets are tinted and animated to suit —
  a torch flickers orange, a sunrod glows cold and steady.

### Changed
- **Applying a preset now sets a light's colour and animation as well as its radii and levels.**
  Every preset states a full appearance, so switching a light from *Torch* to *Sunrod* replaces the
  orange rather than leaving it behind. Lights already placed are untouched until you re-apply a
  preset to them.
```

Rename `## Unreleased` to the version heading before tagging, per the release process comment at the
top of that file.

---

## 2026-08-30 — `README.md` — preset editor now opens Foundry's light sheet (§10.2.2)

Prompted by: the preset editor being reduced to a preset list, a name and an *Edit light* button,
with everything else moved into the real `AmbientLightConfig` opened on an unsaved document.

**This supersedes part of the previous entry.** The appearance passage added under `## Presets`
earlier today is still accurate, but the editor screenshot and the `## Edit Presets` wording below
are now stale. Review the two entries together.

### 1. CHANGED — `## Edit Presets`

**Before:**

```
You can add, duplicate, delete, and edit presets here. It has all the same control surfaces as the
**Light Configuration** section of a light source.
```

**After:**

```
You can add, duplicate, delete, and rename presets here. **Edit light** opens Foundry's own light
configuration sheet for the selected preset, so a preset can hold everything a placed light can -
radii, angle, rotation, colour, animation, and every advanced option - alongside this module's own
**Lighting Configuration** section.

Position fields are hidden, since a preset is not anywhere: coordinates and elevation, and the
elevation row Wall Height adds when it is installed.

Changes made in that sheet are held in the preset window and are only written when you press
**Save** there.
```

### Screenshots needing replacement

- `assets/config-presets.png` — shows the old full-form editor. Now shows a preset list, a name
  field and an *Edit light* button.
- The same image is used twice: `## Presets` and `## Edit Presets`. A second shot of the light sheet
  opened on a preset would be worth adding beside the second one.

**Not changed:** the eleven-row preset table under `## Presets`, and the "Emission angles" paragraph
below it — which is now arguably wrong, since angle *is* settable per preset through the light
sheet. Left for you to judge: it may still be the right advice for items, since the item table
(planned) attaches a preset rather than an angle.

### 2. ADDED — `CHANGELOG.md`, first bullet of the existing `### Changed` block

Inserted **above** the "Applying a preset now sets a light's colour…" bullet:

```
- **Edit Presets now opens Foundry's own light configuration sheet.** The preset window is a list, a
  name and an *Edit light* button; everything else is the real sheet, so a preset can hold any
  setting a placed light can — angle, rotation, coloration technique, luminosity, shadows and the
  rest — instead of only the fields the old form reproduced. Position fields are hidden, since a
  preset is not anywhere.
```

> **Revised the same day**, before review: `Would` gained the "remove them by hand" sentence and
> `RanDry` was reworded to name the fuel. The block above is the current text, not the first draft.

---

## 2026-08-30 — `README.md` + `CHANGELOG.md` + `lang/en.json` — tooltip respects walls

Prompted by: the light level tooltip reporting a light level over ground that is drawn dark because
a wall blocks the view of it.

### 1. CHANGED — `README.md`, `## Light level tooltip`

**Before:**

```
The tooltip can also provide context for the cause of a light level, such as "Dim · reduced from 
normal", "Bright · darkness cancelled by daylight", or "seen through darkness".
```

**After:**

```
The tooltip can also provide context for the cause of a light level, such as "Dim · reduced from 
normal", "Bright · darkness cancelled by daylight", "seen through darkness", or "out of sight behind 
a wall".
```

### 2. ADDED — `README.md`, same section

Inserted **after the `![Light Level Tooltip With Explainer]` image**, before the "Hovering a token
also shows its name" paragraph:

> The tooltip reports what the view shows rather than what the scene holds, so ground the viewer
> cannot see reads **Dark** — a wall between the viewer and a point hides its light level the same way
> a magical darkness lowers it. A GM with no token selected has a god's-eye view, where nothing is out
> of sight and every light level is reported as it is.

### 3. ADDED — `lang/en.json`, tooltip prose

New key `PF1LIGHTING.Readout.Unseen`, alongside the existing `SeenThroughDarkness` ("viewed through
darkness"):

```
"Unseen": "out of sight behind a wall"
```

Shown as the tooltip's explanatory half, so it reads **Dark · out of sight behind a wall**. Same
GM-only gate as the other explanations (*Light level details*). Wording alternatives if you prefer:
"out of sight", "not in view", "hidden by a wall". It covers anything outside the viewer's line of
sight, which in practice is always a wall.

### 4. ADDED — `CHANGELOG.md`, new `### Fixed` block under `## Unreleased`

```
### Fixed
- The light level tooltip no longer reports the light level of ground the viewer cannot see. Area
  behind a wall is drawn dark but was still read at its own level — a lit room past a corner
  reported *Bright* while the screen showed it dark. It now reads *Dark*, with "out of sight behind
  a wall" as the explanation. A GM with no token selected keeps the god's-eye view and is unaffected.
```

### Screenshot possibly stale

`assets/tooltip.png` / `assets/tooltip-explain.png` — only if either was captured over ground that is
out of the selected token's sight, which would now read *Dark*. Worth a glance, not a reshoot on
principle.

---

## 2026-08-30 — `README.md` + `CHANGELOG.md` + `lang/en.json` — light effects (build steps 6–8)

Prompted by: the item descriptor landing, which completes the user-facing half of §12. The HUD
button and the fuel clock shipped earlier today with **no README coverage at all** — the step 4
entry above says the README entry "goes in with them", and this is it. So this covers three build
steps, not one.

### 1. ADDED — `README.md`, new `## Light effects` section

Inserted **between `## Presets` and `## Overlapping increases`**, with three subsections. Also added
to the `# Contents` list, between *Presets* and *Overlapping increases*:

```
  - [Light effects](#light-effects)
    - [The token light button](#the-token-light-button)
    - [Fuel](#fuel)
    - [Light on an item](#light-on-an-item)
```

Opening text:

> A light that **follows what it is attached to**. Cast *light* on a thrown rock, hand a lantern to a
> guard, or drop a *darkness* on a trap, and the light travels with it.
>
> Nothing about the target's own light configuration is touched. The effect is a separate, invisible
> light source pinned to the token, so several can be in force at once, each one ends without
> disturbing the others, and a token's own light is still yours to set by hand.
>
> Effects attach to **anything on the canvas** - tokens, tiles, and measured templates - which
> includes the actor types that have no character sheet to hang a buff on. A vehicle, a trap or a
> haunt is lit the same way a wizard is.

…then **The token light button** (click / right-click, what the picker lists, the greyed-out
exhausted row, the GM's *Any light source…* override, no button for a player with nothing),
**Fuel** (game-time burn, carried partial use, the three-option *Fuel use* table, stacks zeroed not
deleted, core sources known by name), and **Light on an item** (a three-row control table, the
blank-name / name-itself fuel rule, and the buff paragraph).

### 2. ADDED — `README.md`, `# Configuration` settings table

One row, inserted **above** *Show light level*:

```
| **Fuel use** | Whether lit sources consume fuel, announce it, or both |
```

### 3. ADDED — `CHANGELOG.md`, four bullets at the top of the existing `### Added` block

Above the "Lighting presets now carry an appearance" bullet: *Light effects*, *A light button on the
token HUD*, *Fuel, in game time*, and *A light section on the item sheet's Advanced tab*.

### 4. ADDED — `lang/en.json`, hint prose under a new `PF1LIGHTING.Emits` block

The three explanatory lines under the item-sheet controls. These are the hint texts you asked to
review:

```
"ActiveHint": "While this buff is active, its actor's tokens give off the light chosen below. The
light goes out when the buff is switched off, deleted, or its duration expires."

"LitHint": "Offers this item in the token light picker. This overrides whatever the light source
table says about an item of this name."

"PresetHint": "The lighting preset this gives off. Edit the presets themselves under Configure
Settings."

"FuelHint": "The item consumed while this burns, and how many hours one of them lasts. Name this
item itself for something that consumes itself, such as a torch. Leave the name blank to burn
indefinitely."
```

Plus three labels and a placeholder, not prose: `Header` "Light", `Enabled` "Emits light", `Preset`
"Light preset", `Fuel` "Fuel", `FuelNone` "Burns indefinitely" (the fuel field's placeholder),
`FuelHours` "Hours".

**One to judge:** *LitHint* names "the light source table", which has no user-facing name yet and no
editor (the table editor is the outstanding half of build step 7). If you would rather it not refer
to something a GM cannot see, "This overrides the built-in behaviour for an item of this name" says
the same thing without pointing at a window that is not there.

### Screenshots wanted

Two, both referenced by the new section but **not linked in the file** — no broken image tags were
added:

- The token HUD with the light button and the picker open. Would go under *The token light button*.
  A GM shot showing the *Any light source…* row plus a couple of carried items would cover both
  audiences at once.
- The item sheet's Advanced tab showing the light section, on a lantern (fuel row visible). Would go
  under *Light on an item*, above the control table. A second shot on a buff would show the
  fuel-less form, if you think it is worth two.

---

## 2026-08-30 — `README.md` + `CHANGELOG.md` + `lang/en.json` — light source editor + collapsible section

Prompted by: the light-source table editor landing, and the item-sheet section being reshaped to the
house standard (collapsible by its header, icon paired with the title, badge on the right).

**Read this together with the entry above it** — it amends the section that entry added.

### 1. ADDED — `README.md`, new `## Edit Light Sources` under `# Configuration`

Inserted **between `## Edit Presets` and `## Light Spill`**, and added to `# Contents` between the
same two:

> Which items give off light when they are lit, what they give off, and what they burn. The list
> ships with Pathfinder's own kit - torches, candles, lamps, both lanterns, sunrods and everburning
> torches - and an untouched world tracks that list as the mod changes it.

…then a four-row field table (**Item name**, **Also called**, **Light preset**, **Fuel**), the
blank-name / name-itself fuel rule, and a closing paragraph on name matching that links to
*Light on an item*.

### 2. ADDED — `README.md`, `# Configuration` settings table

One row, directly under *Lighting Presets*:

```
| **Light Sources** | Which items give off light when lit, and what they burn |
```

### 3. CHANGED — `README.md`, `## Light effects` → `### Fuel`, last paragraph

**Before:**

```
Foundry's own light sources are known by name and need no setting up - torches, candles, lamps,
hooded and bullseye lanterns, sunrods, and everburning torches all light correctly the moment they
are dragged onto a sheet.
```

**After:**

```
Pathfinder's own light sources are known by name and need no setting up - torches, candles, lamps,
hooded and bullseye lanterns, sunrods, and everburning torches all light correctly the moment they
are dragged onto a sheet. **Edit Light Sources** in the mod's settings is where that list lives, if
your table's kit is named differently or burns for longer.
```

(*Foundry's* → *Pathfinder's* is the substantive half — the list is PF1 equipment, not Foundry's.)

### 4. CHANGED + ADDED — `CHANGELOG.md`, `### Added`

The *A light section on the item sheet's Advanced tab* bullet gained a closing sentence:

```
The section collapses to its header, showing the preset it holds, so it costs a line on the items
that do not use it.
```

And one new bullet after it:

```
- **Edit Light Sources**, a new settings window listing which items give off light when lit and what
  they burn. It ships with Pathfinder's own kit and is where a differently named lantern, a
  house-ruled burn time, or a table playing in another language goes in.
```

### 5. ADDED — `lang/en.json`, hint prose in the new `PF1LIGHTING.Items` block

The hint texts under the editor's controls — the ones needing review:

```
"Which.Hint": "Items matched by name. An item that carries its own light settings on its Advanced
tab ignores this list."

"Name.Hint": "Matched against the item's name, ignoring capitalisation."

"Aliases.Hint": "Other names for the same thing, separated by commas."
```

Two confirmation-dialog bodies, also prose:

```
"Remove.Body": "<p>Delete <strong>{label}</strong>?</p><p>Items of that name stop being offered in
the token light picker unless they carry their own light settings.</p>"

"Reset.Body": "<p>Discard this world's light source list and go back to the module's own?</p><p>The
world will then track the built-in list as the module changes it.</p>"
```

And the settings-menu row itself:

```
"Menu.lightItemEditor": {
  "Name": "Light Sources",
  "Label": "Edit Light Sources",
  "Hint": "Which items give off light when lit, what they give off, and what they burn. Ships with
           Pathfinder's own torches, lanterns and sunrods."
}
```

Plus labels and a notification, not prose: `Title`/`Which` "Light source", `New`/`Create` "New light
source", `Name` "Item name", `Aliases` "Also called", `Unnamed` "(unnamed)", `MissingPreset`
"{key} (missing)", `Saved` "{count} light sources saved.", and the duplicate-name refusal
`Duplicate`: *"Two light sources are both called "{name}". Rename one before saving."*

**One to judge:** the previous entry flagged `Emits.LitHint` for naming "the light source table",
which had no editor at the time. It now has one, named **Edit Light Sources** — so the hint should
probably use that exact name rather than "the light source table". Not changed, since it is your
call which way the two should agree.

### Screenshot wanted

`assets/config-light-items.png` — the new editor, with a lantern selected so the fuel row is filled
in. Would go directly under the `## Edit Light Sources` heading, matching `## Edit Presets`. **Not
linked in the file**, so nothing is broken meanwhile.

> **Correction to the entry above, before review (2026-08-30).** Three of the hint keys were first
> written as literal dotted keys — `Items.Which.Hint`, `Items.Name.Hint`, `Items.Aliases.Hint` —
> beside plain strings at `Items.Which`, `Items.Name` and `Items.Aliases`. That **broke the entire
> language file**: Foundry expands dotted keys when merging translations, and writing `.Hint` under
> a key already holding a string kills the load, so every `PF1LIGHTING.*` string in the module
> rendered as its own key. Reported by Hamilcarbarcas from the settings window. They are now
> `Items.WhichHint`, `Items.NameHint` and `Items.AliasesHint`, matching the `Emits` block's style.
> **The prose quoted above is unchanged** — only the key names moved, so there is nothing extra to
> review here.

> **Second correction to the same entry (2026-08-30).** *Also called* separates aliases with
> **semicolons**, not commas — reported by Hamilcarbarcas, and the shipped table is the proof:
> `Lamp` is also called *Lamp, common*, which a comma split turns into two useless aliases. PF1
> names its equipment that way throughout (*Lantern, hooded*; *Lantern, bullseye*).
>
> - `README.md`, the `## Edit Light Sources` field table: *"Other names for the same thing,
>   separated by commas"* → *"…separated by semicolons"*.
> - `lang/en.json`, `Items.AliasesHint`: *"Other names for the same thing, separated by commas."* →
>   *"Other names for the same thing, separated by semicolons — item names often contain commas."*
>   **This one is prose and wants your eye.**
>
> Field grammar only; the table stores an array, so no saved world is affected.

---

## 2026-08-30 — `README.md` + `CHANGELOG.md` + `lang/en.json` — the light-effect window (build step 9)

Prompted by: §12.10's management window landing on the lighting scene controls.

### 1. ADDED — `README.md`, new `### What is lit on this scene` under `## Light effects`

Inserted **after `### Light on an item`**, as the section's fourth subsection, and added to
`# Contents` beneath *Light on an item*:

> The **lighting controls** have a bulb that opens a list of every light effect on the current scene -
> what it is on, what it emits, what put it there, what it is burning and when it ends. Clicking an
> entry's name pans to it; the **×** puts that one light out.
>
> An effect whose source has gone - a deleted buff, an item that no longer exists - is marked rather
> than dropped, and **Clear orphans** sweeps them. That housekeeping also runs on its own whenever a
> world loads or a scene is opened, across every scene, so the button is a convenience rather than
> something that needs pressing.

### 2. ADDED — `CHANGELOG.md`, one bullet at the end of `### Added`

```
- **A light-effect list on the lighting controls**, showing everything lit on the current scene —
  what it is on, what it emits, what put it there, what it is burning and when it ends — with
  click-to-pan, a per-entry *put it out*, and **Clear orphans** for effects whose source has been
  deleted. That housekeeping also runs by itself on world load and scene change, across every scene.
```

### 3. ADDED — `lang/en.json`, new `PF1LIGHTING.Effects` block

Mostly column headings and button labels. The ones that are prose, and want your eye:

```
"Control": "Light effects on this scene"          (the scene-control button's tooltip)
"Empty": "Nothing on this scene is carrying a light effect."
"NoExpiryTip": "Lasts until something puts it out."
"FuelTip": "One unit lasts {hours}h. Burning for {burnt}."
"Reaped": "PF1 Lighting | {count} orphaned light effects cleared."
```

Labels, not prose: `Title` "Light Effects"; the column headings `Anchor` **On**, `Label` **Light**,
`Source` **From**, `Expires` **Ends**; the cell values `NoSource` "nothing", `Orphaned` "source
gone", `Due` "overdue"; the controls `PanTo` "Show me", `Clear` "Put this out", `Refresh`
"Refresh", `ClearOrphans` "Clear orphans ({count})"; and four duration units `{n}s`, `{n} min`,
`{n}h`, `{n}d`.

**Two to judge.** The column headings are deliberately one word each — **On / Light / Preset / From
/ Fuel / Ends** — to keep the table narrow; say if you would rather have *Anchor*, *Source* and
*Expires* spelled out. And `PanTo` "Show me" is first-person where nothing else in the module is;
"Go to this" or "Find it" are the alternatives.

### Screenshot wanted

The window with a few effects on the scene, ideally including one orphan so the marked row shows.
Would go under the new `### What is lit on this scene` heading. **Not linked**, so nothing is broken
meanwhile.

---

## 2026-08-30 — `README.md` + `CHANGELOG.md` + `lang/en.json` — on-use targeting (build step 10)

Prompted by: §12.7's *use* trigger and §12.5.1's GM-approval flow landing together. **§12 is now
complete**, so this is the last of the light-effect doc entries.

### 1. ADDED — `README.md`, new `### Casting light on something` under `## Light effects`

Inserted **between `### Light on an item` and `### What is lit on this scene`**, and added to
`# Contents` in the same position:

> Spells, consumables and anything else with an action can place a light on **what they were used on**.
> Set *Gives light* to **When it is used** and *Lights* to **The targets**, and the light lands on
> whatever the action caught - a template's area, or the tokens you had targeted - for as long as the
> action's own duration says.
>
> This is the case that has no other answer. A trap, a vehicle or a haunt has no character sheet to
> hang a buff on, so *darkness* cast on one cannot work through a buff however the buff is written. It
> works here because the light attaches to the token, and everything on the canvas is a token.
>
> Players can do this too, within the usual limits. A light on their own token is theirs to place; a
> light on **anything they do not own** - an enemy, a trap, a chest - becomes a request on the chat
> card that a GM approves:
>
> - Everyone at the table sees the request, so a player can see their spell waiting on a ruling.
> - Only a GM sees the buttons.
> - The card keeps the answer either way, so the log says what was decided rather than going quiet.

### 2. CHANGED — `README.md`, the `### Light on an item` control table

One row added, between *Emits light* and *Light preset*:

```
| **Gives light** | What makes it light up - only shown when an item could be more than one thing |
```

### 3. ADDED — `CHANGELOG.md`, one bullet with a sub-bullet, above the light-effect list entry

*"Spells and consumables can place a light on what they were used on."* plus the nested bullet on
the GM-approval flow.

### 4. ADDED — `lang/en.json`, hint prose under `PF1LIGHTING.Emits` and a new `PF1LIGHTING.Use` block

The prose wanting review:

```
"Emits.UseHint": "Using this item places the light on whatever it was used on. How long it lasts
comes from the action's own duration."

"Emits.TargetHint": "Targets are whatever the action caught — a template's area, or the tokens you
had targeted. A target you do not own becomes a request on the chat card for a GM to approve."

"Use.NoTargets": "{item} would have placed a light, but nothing was targeted."
"Use.Pending":   "{light} is waiting on a GM for {targets}."
"Use.Granted":   "{light} placed on {targets}."
"Use.Declined":  "{light} was not placed."
```

Labels, not prose: `Emits.Trigger.Label` **Gives light** with options *While the buff is active* /
*While it is lit* / *When it is used*; `Emits.Target.Label` **Lights** with *The user* / *The
targets*; `Use.Apply` "Place the light"; `Use.DeclineTip` "Refuse this".

**Two to judge.**

- `Use.Declined` is deliberately neutral — *"was not placed"* rather than *"refused"* or *"denied"*,
  since a GM skipping something is not usually a refusal of the player. Say if you would rather it
  read as a decision.
- **`Use.Granted` names the targets rather than counting them.** *"Darkness placed on Goblin, Chest"*
  reads better a week later than *"placed on 2 targets"*, but a long template can make a long line.
  The count is still recorded on the message flag if you would rather have the number.

### Screenshot wanted

A chat card carrying a pending request, ideally the GM view so the buttons show. Would go under the
new `### Casting light on something` heading. **Not linked**, so nothing is broken meanwhile.

---

## 2026-08-31 — `API.md` — tone pass on the light-effects section (lines 194–230)

Prompted by: Hamilcarbarcas — *"way too descriptive, verbose, and feels like it's trying to sell
people on the features… Just explain what it does."* Requested and reviewed live, so this entry is
a record rather than a queue item; delete it.

**No behaviour or fact changed** — the same rules are stated, shorter. Three headings renamed away
from editorialising, and the rhetorical clauses cut:

| Before | After |
| --- | --- |
| `## `source` is what makes a toggle two lines` | `## `source`` |
| `## Who may apply one` | `## Ownership` |
| `## `place` is a different verb` | `## `place`` |

Cut: *"It earns a second thing…"*, *"which is what omitting it opts into"*, *"is a GM's decision
rather than an API call"*, *"This is not only about permission…"*, *"That is the right answer for a
light that stays at a spot, and the reason a bare point is not an anchor."*

Added, as facts a caller needs rather than justification: the sweep runs **on world load and on
scene change** (it only said "on load"); `place` output **has no anchor, carries no `source`, and
does not appear in `list`**; and the on-use descriptor is named as the existing route for lighting
something you do not own.

> **Same-day additions to the entry above (2026-08-31), all requested.**
>
> - `# Contents`: `[Who can see whom](#who-can-see-whom)` → `[Who can see who](#who-can-see-who)`,
>   matching the heading. `- [Not in the API](#not-in-the-api)` **removed** — no such section exists.
>   Every in-page anchor now resolves.
> - `# Versioning`: the paragraph beginning *"Feature-detect on this rather than…"* was deleted by
>   Hamilcarbarcas as superfluous. Replaced with the command, not prose:
>
>   > What this build actually exposes:
>   >
>   > ```js
>   > console.log(game.modules.get("pf1-lighting")?.api);
>   > ```

---

## 2026-08-31 — `README.md` + `CHANGELOG.md` + `lang/en.json` — on-use targeting WITHDRAWN

Prompted by: Hamilcarbarcas — *"the light category should only be present in 2 areas - items (where
it overrides the light sources database), and buffs (where it emits light when active). The settings
on spells and the like that lights targets/user should not be there."*

**This reverses the entry immediately above it.** Both can be deleted together; nothing from that
entry survives in the docs.

> **Followed through the same day:** `model/use-driver.mjs` and `ui/light-request.mjs` were deleted
> outright rather than left unwired, along with their CSS, `descriptor.triggersFor`, `TRIGGER.USE`
> and `TARGET`. No further doc change — the docs already say nothing about any of it.

### 1. REMOVED — `README.md`, the whole `### Casting light on something` section

Added yesterday under `## Light effects`; gone, along with its `# Contents` line.

### 2. REMOVED — `README.md`, one row from the `### Light on an item` control table

```
| **Gives light** | What makes it light up - only shown when an item could be more than one thing |
```

### 3. REMOVED — `CHANGELOG.md`, the *"Spells and consumables can place a light on what they were
used on"* bullet and its nested GM-approval sub-bullet.

### 4. REMOVED — `lang/en.json`

`Emits.UseHint`, the whole `Emits.Trigger` block, the whole `Emits.Target` block, `Emits.TargetHint`,
and the whole `PF1LIGHTING.Use` block. **No new prose was added**, so there is nothing here to
review — only deletions.

### 5. FIXED while in there — `README.md` section order

`### What is lit on this scene` had been inserted in the wrong place yesterday: it landed between
*The token light button* and *Fuel*, while the `# Contents` list said it came last. Moved to the end
of `## Light effects`, which is where the contents list already claimed it was. Every in-page anchor
re-checked and resolving.
