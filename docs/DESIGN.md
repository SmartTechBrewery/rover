# The panel's design — what is settled

Everything the **Devices** screen established, written down so the next screen inherits it instead
of rediscovering it. The Devices screen is the reference: where this document and a screen
disagree, this document is what the screen should have been.

`DESIGN_INITIAL_PROMPT.md` is the brief the first four screens were generated from and explains
*why* the product looks the way it does. `WEB_PANEL.md` is what the panel eventually needs to do.
`ai/RULES.md` §8 is how to reach the designs at all — read it first.

---

## 1. Where the designs are

Stitch, project **`Rover`**, ID **`636633385461686529`**, reached through the **Stitch MCP server**.
The design system is **`Analog Horizon`** (`assets/0ceb612ce88e4adb9c88f8e4ff21e3d8`), returned by
`get_project` as `designTheme.designMd`: the full token set plus the written rationale for the
palette, the three-tier type system and the border-as-depth elevation model. **Tokens come from
there.** A hex code typed into a component, or a colour eyeballed off a screenshot, is the failure
this sentence exists to prevent.

| Screen | ID | State |
| --- | --- | --- |
| Home — Devices (V3) | `3458d89bda5e442d894ea54208230d4c` | **The reference.** Settled. |
| Archive — Browsing (V2) | `f2de4344f7e347aa894b3054d9cf4098` | Not yet corrected — see §7 |
| Run Detail — Artifacts (V2) | `36b54fbe032449d8a300ea0825bbf1c8` | Not yet corrected — see §7 |
| Compare — Visual Diff (V2) | `897632dcadce44de9bdee74a94da14f5` | Not yet corrected — see §7 |

Earlier versions of each still exist and **must not be built from**. There is no way to delete a
screen through the API — only `delete_project`, which takes everything — so every iteration
accumulates.

---

## 2. What the panel is

**Rover is not a test framework.** Nothing asserts, nothing passes or fails, nothing goes red on
its own. This is the single constraint most likely to be reintroduced by accident, because every
component library and every generated design reaches for pass/fail semantics unprompted. It has
already come back twice. So, nowhere in this UI:

- no pass/fail badge, no `SUCCESS` / `COMPLETE` chip, no green tick or red cross beside a run;
- no green/red status column and no success rate;
- no "test result" object — there is no such thing.

`test name` appears because that is the field's real name (D22). It does not mean a test, and it
must never be shortened to `TEST`, which reads as a category rather than as a label.

**The panel is not read-only** (D27). It carries *authority over the shared device pool* —
force-releasing a stuck lease is the first such action. It deliberately does **not** acquire
devices: a lease carries the caller's own `owner` string (D22), an agent signs its own work, and a
person clicking a button has nothing to sign one with. So: no "new lease", no "request device", no
create/edit/delete anywhere.

---

## 3. The shell

**Sidebar**, in this order: the `ROVER_OS` wordmark, a divider, then the nav items `Devices`,
`Archive`, `System` — and `Profile` **pinned at the foot, below its own divider**, separated from
the main nav.

- **`Archive`, not `History`.** It is a browsable tree of project → test name → run, not a
  chronological event log.
- **`System` stands in for settings** and suits the aesthetic.
- **There is no `Analytics` item and there will not be one.** Rover aggregates nothing and scores
  nothing; a nav entry with a trend-chart icon promises a reporting product that does not exist.
- **No `Documentation` or `Support`.** Not part of this panel.
- **No host/daemon status block in the sidebar.** One was tried and removed: when the panel cannot
  reach Rover there is nothing to display anywhere, so "is the daemon reachable" is a state of the
  whole page, not a widget beside the navigation.
- The active item carries the green accent (`tertiary`, `#00e29d`).

**Breadcrumb**, above the page title. It states **depth in the current hierarchy and nothing else**.

- At the root it is the screen's own name — `Devices`.
- Deeper: `Archive > checkout-app > login-flow`, with **`>` arrows**, never slashes.
- The last segment is where you are: it carries the same green accent as the active nav item, and
  is not a link. Earlier segments are muted and navigate back up.
- **Nothing but path segments.** No status chips, no counts. The Archive screen currently opens its
  path with a `SUCCESS` chip; that is wrong twice over.

**One height.** The sidebar and the content area share it. With short content the page ends at the
foot of the viewport and `Profile` sits on that line; with long content the sidebar stretches to
the full page height. Neither column ever paints background below where the other ends.

---

## 4. Layout

- **One positioning model for the sidebar, never two.** The single worst bug of the first four
  iterations was a `<nav>` carrying both `fixed` and `relative` while `<main>` still carried
  `ml-64` to compensate for a sidebar that was no longer fixed. Two offsets for one sidebar left a
  256 px dead band — and, because it starved the content box below the width two grid tracks
  needed, collapsed a three-column grid to one. Both symptoms, one cause.
- **Grid columns follow the width available to the content, not a viewport breakpoint.**
  `repeat(auto-fit, minmax(300px, 1fr))` is what the Devices grid uses; 300 rather than 350 because
  three cards plus their gutters have to fit the content width at the design's own size.
- **Equal margins.** The gap between the sidebar's border and the content equals the gap between
  the content and the page edge. The breadcrumb, the page title and the first card share one left
  edge.
- Cards must survive a realistic host. Three devices look fine; **eight phones attached is an
  ordinary machine**, and tall cards scroll badly at that count.

---

## 5. The visual language

The direction is a dark CRT/terminal reading of the Analog Horizon system. It is not the
"colourful retro" the original brief asked for, and that is a deliberate, accepted departure.

**No looping animation, anywhere.** Nothing pulses, blinks, flickers, glows in and out or breathes.
The first design shipped a `crt-flicker` animating the whole document's opacity on a 0.15 s loop —
roughly seven flickers a second, inside the frequency band that matters for photosensitivity, and a
full-page repaint every frame. The only motion in the interface is the lease countdown changing its
digits once a second and ordinary hover/press feedback: both are responses to something real.
Whatever remains is suppressed under `prefers-reduced-motion`.

**The scanline texture stays, but only on chrome.** It carries the CRT character and costs nothing
to read against because it does not move. It must never be a fixed full-viewport layer in a blend
mode: two of the four screens are mostly screenshots of mobile apps, and an overlay tints the exact
thing the user opened the screen to look at. Any region rendering a screenshot, an extracted frame
or a log dump is clean.

**The chromatic text-shadow is for the wordmark only.** Never on data — serials, UTC timestamps,
short hashes and file names stay crisp and are never truncated or ellipsised.

**Status LEDs are one component.** Same fill, same border, everywhere they appear; only the size
changes with context (3 on a card header, 2.5 in the counter badge). None of them glows.

| State | Treatment |
| --- | --- |
| Held | `bg-primary-container` + `border-primary` — neutral blue |
| Free | `bg-tertiary` + `border-tertiary` — green |

**There is no red or orange device state, and there will not be one.** A device that disappears
from the host is simply not listed. Orange in this palette (`secondary-container`, `#ff5e07`) is the
warning colour and must not land on a free device.

**Emphasis follows the question the screen answers.** Devices answers "what can I use right now", so
the free device is the most legible thing on it — not the greyed-out one. An early version dimmed
the free device's serial almost into the background, which is exactly backwards.

**Destructive actions are recessive.** Force Release sits below the data it acts on and does not
outrank it; it needs a confirmation step. It was originally a full-width solid orange button
repeated on every held card, louder than the data it was there to act on.

---

## 6. The device card, as settled

Header bar — **identical on every card**, held or free (`bg-surface-container-high` /
`text-on-surface-variant`): a phone icon, the model name, and the status LED. Free is signalled by
the LED and by the card's body, not by a different header. A pale header was tried on the free card
and lost: the green LED had almost no contrast on it.

Body:

- `SERIAL` on its own line — it is the device's identity and the longest string on the card. Never
  truncated, never crowded. An early two-column layout with no minimum gutter ran the serial
  straight into the platform value.
- `PLATFORM` and `OS VERSION` as **two separate fields**. `Android` is the platform; `14` is the
  version. Never concatenated under one label.

Held — the lease panel, in this order and for this reason:

1. **`TEST NAME`**, full width, first. It is the only field that says *what is happening on the
   phone right now*; owner and project say who to go and ask about it, and the person scanning the
   screen wants the first before the second. It is optional and often absent — when it is, the
   panel simply starts with `OWNER`, with no gap, no empty label and no `—` placeholder.
2. `OWNER` and `PROJECT`, side by side.
3. `GRANTED`, last.

The countdown sits in the panel header. **It goes back up**: the TTL is renewed by activity, not by
a heartbeat (D8), so a countdown that only ever descends is wrong, and the screen must show the
renewal without a reload. It is not coloured green — green and red carry verdict meaning everywhere
else in software and this product has no verdicts.

**There is no `STATE` field.** It was tried and removed: the card already said the device was held
three times over — the panel header reads `ACTIVE LEASE`, the LED is the held colour, and the
counter above the grid says so. (Note that the *device* state adb reports — `device`,
`unauthorized`, `offline` — is a different thing that this card does not currently show. A phone
that is attached but waiting on its RSA prompt has nowhere to say so. Open.)

Free — a dark inset panel in the same place the lease panel occupies, carrying a phone icon and
`free` in green. The icon was originally a plug pulled from its socket, which means "disconnected",
the opposite of what the card says: this phone is attached and ready.

**The counter badge** above the grid reads `● 2 held  ● 1 free`, using those very LEDs — the held
one before the held count, the free one in place of the separator. No `·`, no glow, and it must
agree with the cards below it.

---

## 7. What is not designed yet

- **The empty state — "nothing is attached to this machine".** The single most important thing
  still missing. A host with no devices is normal and common: Rover never starts an emulator or
  plugs in a phone, a person does (D21). It must read as intentional, not as an error and not as a
  spinner that never resolves. The current markup carries a `hidden` div with one line of plain
  text, which is a placeholder, not a design.
- **The "no view" state.** `list_devices` returns `stale: true` when the host's view was
  interrupted, has not arrived, or is not running — and its own schema says an empty list with that
  flag means *no view*, not *no devices* (D6). It must not render like the empty state, or the
  screen will confidently report an empty machine when it has gone blind.
- **The "host unreachable" state**, which belongs to the whole page.
- **The login screen** (R34). Left out of the first batch deliberately.

**Screens 2–4 have not been brought in line with any of this.** Known problems, from a first pass:
pass/fail semantics are back (a `SUCCESS` chip, `PASS` in a log, green ticks and red crosses beside
runs in the tree, the words "Visual Regression"); they carry a **second navigation** — a top bar
duplicating the sidebar — with a global `FORCE_RELEASE` button that has nothing to act on outside
Devices; `Profile` sits mid-sidebar instead of pinned at the foot; and the breadcrumb is used as a
label rather than as a path.

---

## 8. Working with Stitch — what actually happens

- **Verify the markup; do not trust the report.** `edit_screens` returns a confident summary of
  what it changed, and it is sometimes wrong. Two edits to the free device card were reported as
  applied, twice, with the file untouched both times.
- **Operations targeting an element by position fail silently.** The ones that landed used simple
  selectors (`main > div.mb-4 > span`, `nav.md\:flex`); the ones that did not used
  `article:nth-child(3) …`. Naming the target by content in the prompt was not enough to stop the
  planner resolving to an ordinal. **Give the literal markup to replace.**
- **An add-class and a remove-class on the same element cancel out.** Both carried the same
  pre-edit snapshot, so the second overwrote the first and the element ended with no colour class at
  all. Ask for the final class list in one operation.
- **`get_screen` serves a stale file for minutes after an edit** — around four, once. The `file id`
  in the response is what changes when the render catches up; an unchanged id means you are reading
  the version from before your edit.
- **The screenshot URL is a thumbnail** until you append `=s2560`.
- Emitted HTML is Tailwind-CDN markup: useful for harvesting tokens, poor as an application
  starting point. It carries dead classes (`flat no shadows`), a duplicated stylesheet link and
  three font families. Harvest the tokens; rewrite the markup.
