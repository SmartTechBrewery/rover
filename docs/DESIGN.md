# The panel's design — what is settled

Everything the **Devices** screen established, written down so the next screen inherits it instead
of rediscovering it. The Devices screen is the reference: where this document and a screen
disagree, this document is what the screen should have been.

`DESIGN_INITIAL_PROMPT.md` is the brief the first four screens were generated from and explains
*why* the product looks the way it does. `WEB_PANEL.md` is what the panel eventually needs to do.
`ai/RULES.md` §8 is how to reach the designs at all — read it first.

**This is a living document, and keeping it current is part of doing design work — not a follow-up.**
Whenever a screen settles something, whenever a correction is made and the reason for it is worth
keeping, whenever a Stitch screen is added or superseded, or whenever something moves out of §9's
"not designed yet" list, it is written down **here, in the same change**, exactly as `PROJECT.md`
and `README.md` must stay current (`ai/RULES.md` §1). A design decision that lives only in a chat
log will be re-litigated by the next agent, and usually decided the other way: pass/fail semantics
have already crept back into this product twice. If you find this document disagreeing with a
screen, one of the two is a bug — say which, rather than working around it.

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
| Devices (Home) | `3458d89bda5e442d894ea54208230d4c` | **The reference.** Settled. |
| Devices — Nothing Attached | `ccdef7834ab9470f9a653a47321998c9` | Settled |
| Devices — Host Unreachable | `c60c5830d23e4a328e9d77b83c98f9fc` | Settled |
| Devices — Host View Stale | `46f3a297fee047028f29c8958a926995` | Settled, **list variant only** |
| Devices — Force Release Confirmation | `d86e794af4de4639979bc65104e2ec57` | Settled, **the asking only** |
| Archive — Browsing (V2) | `f2de4344f7e347aa894b3054d9cf4098` | Not yet corrected — see §9 |
| Run Detail — Artifacts (V2) | `36b54fbe032449d8a300ea0825bbf1c8` | Not yet corrected — see §9 |
| Compare — Visual Diff (V2) | `897632dcadce44de9bdee74a94da14f5` | Not yet corrected — see §9 |
| Sign In — Rover OS | `5035330b2c12401080263625ff564369` | Settled, **default state only** — see §8 |

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

**Breadcrumb, and no page title.** There is no `<h1>`: the breadcrumb *is* the page's identity.
Both said `Devices`, one line apart, and the breadcrumb already says it in the colour that means
"you are here" — the heading repeated it and earned nothing. It states **depth in the current
hierarchy and nothing else**.

- At the root it is the screen's own name — `Devices`.
- Deeper: `Archive > checkout-app > login-flow`, with **`>` arrows**, never slashes.
- The last segment is where you are: it carries the same green accent as the active nav item, and
  is not a link. Earlier segments are muted and navigate back up.
- **Nothing but path segments.** No status chips, no counts. The Archive screen currently opens its
  path with a `SUCCESS` chip; that is wrong twice over.
- It stayed at its original size after the heading went. That was checked rather than assumed: it
  is small, and it is enough, because the active nav item is carrying the same information beside
  it.

**The header row** below it holds one line describing the screen on the left and the held/free
counter on the right, above a rule. On Devices that line is *"Monitoring attached physical and
virtual devices."* All three Devices states share this row's shape — they are three states of one
screen, and a header that differs between them is the thing most of this document exists to
correct.

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

## 7. The Devices screen's other states

Each of these is **one state of the Devices screen, not a screen of its own.** The shell — sidebar,
nav, `Profile` at the foot, breadcrumb, page title, margins — is copied verbatim from
`Devices (Home)` and is not restyled, re-iconed or rebuilt per state. Every one of the first four
attempts regenerated it and every one got it wrong the same way: a `v4.2.0-STABLE` version string
under the wordmark, a `DEPLOY UPDATE` button for an action the product does not have, `Diagnostics`
(which is `Analytics` under another name), `Log Out` promoted into the nav with `Profile` replaced
by an avatar, and a top bar the reference screen does not have. **Say "reuse the shell from
`3458d89bda5e442d894ea54208230d4c`, change only the content area" explicitly, every time.**

**Titles drift**: Stitch appends `(Corrected)`, `(V2)`, `(Full Page)` as it goes, so the id is the identity and the title is not. A correction also sometimes lands as a **new screen with a new id** rather than in place — the empty
state moved from `13e46314b3a249cb805fffe8557355d4` to `ccdef7834ab9470f9a653a47321998c9` that way,
while `get_screen` was still serving the old file. Re-read the id from the project after every
round; do not carry one forward on the assumption it was edited in place.

### Nothing attached — settled

No devices are plugged into the machine. It reads as normal, common and *finished*: no error
colour, no warning icon, no spinner, nothing that suggests loading. Rover never starts an emulator
and never plugs in a phone — a person does (D21) — so until they do, an empty machine is the
correct state rather than a fault.

- It says what would change it: attach a phone with USB debugging enabled, or start an emulator, on
  the host machine.
- **Not "standby".** That word was removed from the product's vocabulary once already: it describes
  a machine waiting to do something, and this one is not waiting, it simply has nothing plugged in.
- **No progress-shaped ornament.** A dot-and-lines rule under the message reads as a progress track
  or a carousel indicator, which is the one impression this state must not give.
- The `2 held · 1 free` counter is **absent**, not showing `0 held · 0 free` as though describing a
  pool.

### The force-release confirmation — settled, for the asking

The only destructive action in the product, and it asks before it fires. It is a **modal over the
working panel** — the rest of the panel still works, so by §7's rule it keeps the shell.

- **`TIME TO AUTO RELEASE`, not "remaining time".** "Remaining" does not say remaining until what,
  and the number's whole job here is to answer the comparison the operator is actually making: am I
  shortcutting twelve minutes, or four seconds? The field exists on the wire (`expiresInMs` on
  `LeaseHolder`, the same value that drives the card's countdown) — an earlier revision showed
  `00:00`, which says the lease has already ended and there is nothing to release.
  It is **not a fixed deadline**: expiry is pushed forward by activity rather than by a heartbeat
  (D8), so this is the time until it would expire *if nothing else happens*. Not dressed as urgent.
- **The header bar is `secondary-container` (#ff5e07), not red.** Analog Horizon defines that
  colour for critical alerts and physical "power" metaphors, which is exactly the weight this
  needs. A destructive action is the closest thing to an exception to §5's no-red rule and it still
  is not one — leaving red unused keeps it meaningful if something ever genuinely needs it.
- **`TEST NAME`, not `TEST`.** Third recurrence. Bare `TEST` reads as a category and makes the
  panel look like a test runner.
- **Cancel is the filled, prominent control; Force Release is the recessive one.** Deliberate, and
  recorded here so it is not "fixed" later by promoting the destructive action to primary: the safe
  exit is the easier target.
- It identifies what is about to end — device, serial, owner, project, test name — so the operator
  recognises the run without going back to look. And it says in plain words what happens: the lease
  ends immediately, the device is restored to a clean state, and the agent holding it fails on its
  next request. That is not softened.
- An earlier revision carried an **"Outcome Snippets Reference"** strip — the same scaffolding
  mistake as the sign-in screen's `DEBUG // UI STATES`. Removed. The three outcomes it sketched are
  real and still need designing as states (§9).

### Host view not current — settled, for the variant that has a list

`list_devices` answers with `stale: true` when the host's view of the hardware is **not known to be
current**. It keeps the shell, because unlike the unreachable state the rest of the panel still
works — this is the other side of §7's rule.

**What is uncertain here, and what is not, is the whole substance of this state**, and the first
attempt got it backwards. `stale` is about the host's view of *the hardware*: which phones are
plugged in and what adb says about their state. **It says nothing about leases.** A lease is the
daemon's own bookkeeping and has no view that could go stale — `src/daemon/list-devices.ts` says so
where it passes the flag through untouched. So:

- **The lease fields stay exact and the countdown keeps ticking.** The first attempt blanked the
  lease time to `--:--`, which discards the one part of the screen still worth trusting and tells
  the operator the opposite of the truth.
- **No `Status: UNCERTAIN` per card.** The uncertainty is about the list as a whole — whether these
  are still the attached devices — and it is said once, in the banner. Per-card it asserts
  something the flag does not mean.
- **The banner says that the lease details below are still accurate.** Without that sentence it
  casts doubt over the entire grid, and the operator stops trusting the part that was fine.
- The grid may be quieted *as a set* to read as the last thing seen. That is a treatment of the
  whole grid, never a rewriting of the data in it.

Two more things this state fixed, both of which will recur:

- **`Load --%`, `NODE-Alpha`, `SRV-Beta`, `DB-Gamma`.** Generated designs reach for
  server-monitoring vocabulary whenever a screen looks like infrastructure. Rover lends **phones**:
  there is no load, no node, and no server here.
- **A headline is one clause.** `HOST VIEW NOT CURRENT // DATA STALE` became
  `HOST VIEW NOT CURRENT`, the same trim `HOST UNREACHABLE // CONNECTION REFUSED` got. The `//`
  second clause is either a restatement or a claim the panel cannot support.

**This is an uncertainty, not a fault.** Nothing failed. Grey, not a warning colour, and nowhere
near red.

### Host unreachable — settled

The panel cannot reach the daemon at all.

**This one is a full-page state, not a dialog over the application** — and the rule generalises:
*a state that leaves the navigation nothing to reach is the whole page; a state where the rest of
the panel still works keeps the shell.* Here there is no inventory, no archive and no lease to
show, so a card floating over a dimmed sidebar would be furniture behind a message, with every nav
item leading nowhere. The sidebar, the navigation, the top bar and the breadcrumb are **gone, not
dimmed**. Structurally it follows the sign-in screen — wordmark, one centred block, vertical
padding — because that is already this system's shell-less page.

That also disposes of the shell problem by construction: there is no shell left to regenerate
wrongly.

- **The title is exactly `HOST UNREACHABLE`.** Not "// CONNECTION REFUSED": a refused connection, a
  timeout, a powered-off machine and a daemon that is not running are indistinguishable from here,
  and the headline must not claim to know which.
- **No error code.** An earlier revision printed `ERR_CODE: 0x80004005` — an unmodified Windows
  `E_FAIL` HRESULT, from an operating system this product does not run on. A fabricated identifier
  is worse than none, because somebody will search for it or quote it in a bug report. If a code
  ever appears here it is one Rover actually produces.
- **No `OFFLINE` badge** restating the headline.
- `RETRY CONNECTION` stays. Retrying a read is harmless and it is the one useful thing to do from
  here — and it is not a spinner while it runs.

## 8. The sign-in screen, as settled

It is the one screen a person sees before they are authenticated, so it shares the design system
and nothing else.

**It is provisional, and should be treated as such.** Entering a token by hand is a placeholder for
an email-and-password sign-in that will replace it. Everything below is what keeps it consistent
with the rest of the panel — it is not an invitation to perfect a screen with a known expiry date,
and effort spent polishing it beyond this list is spent twice.

- **No sidebar, no navigation, no breadcrumb, no profile.** None of them mean anything yet. The
  wordmark carries the product's identity alone, centred, with vertical padding so the card never
  touches an edge — and the card stays fully visible and scrollable at short viewport heights
  rather than being clipped from the top by a flex-centred container.
- **One input: the access token.** An operator issues it on the host with `rover users add`; the
  person pastes it. Set in the monospace face used for technical strings, sized for a 32-character
  machine-generated string rather than for a word, masked with a reveal — somebody who pasted the
  wrong thing has no other way to find out. The screen says where a token comes from.
- **No host or address field.** The panel is served by the machine it talks to, so it already knows
  where it is. This is worth stating because it is the obvious field to add and it would be wrong.
- **No host name either.** A `HOST // NODE_01` line was tried and removed: `NODE_01` names a
  concept Rover does not have, and it is the second time that invented identifier had to be taken
  out. If the line ever returns it carries the machine's **real** hostname or it does not exist.
- **One refusal, for every reason.** The host answers every failed attempt identically on purpose —
  a token nobody holds, a token a revoked user still holds, and a malformed one are indistinguishable
  from outside (`src/daemon/network-listen.ts` holds that line deliberately). The design must not
  undo it by offering "unknown user" and "wrong token" as separate states.
- **No account creation, no password reset, no "forgot", no email, no social sign-in.** Users are
  issued on the host by an operator. The panel authenticates and never administers.
- **No spinner.** The pending state is a disabled control whose label changes — a spinner is a
  looping animation and §5's rule has no exception for progress.
- **`rover users revoke` takes effect on the revoked user's next request**, not at their next
  login, so the panel bounces them here mid-session. That arrival says so plainly: unlike a
  stranger's failed attempt, this person was authenticated a moment ago, and telling them costs
  nothing. **This is a deliberate exception to the uniform-refusal rule above** — recorded here so
  it is not mistaken for an oversight and quietly "fixed".

## 9. What is not designed yet

Two lists, and the difference between them matters. The first must exist as a Stitch design before
anyone builds it, because getting it wrong is expensive and the mistakes are not obvious. The
second is left to whoever implements it, working from this document — a design round would cost
more than it would settle.

### Design these first

- **The "no view" state with an *empty* list.** The variant with devices in it is settled (§7). The
  empty one is the dangerous half and is still undesigned: it is visually identical to "nothing
  attached" and means the opposite, so a person reading "nothing is attached" walks to the machine
  and finds a phone sitting in the socket. `list_devices`'s own schema says it outright — an empty
  list with `stale` set means *no view*, not *no devices* (D6).
- **The force-release action's three outcomes.** The asking is settled (§7); what happens after it
  is not. They are three different things and must not collapse into one: the card becoming free
  without a reload; the lease having already ended on its own between the page loading and the
  click, which is news rather than a failure; and the device having since vanished from the host,
  so there is nothing left to release *or to show*.

### Leave these to whoever implements them

Build them in keeping with everything above — the palette and tokens, no looping animation, the
uniform refusal, the vocabulary — and **write what you settled back into this document** (see the
top of this file). Do not commission a Stitch screen for them.

- **The sign-in screen's four other states** (R34): refused, checking, signed out, and access
  ended. Only the default form is designed, and §8 says why polishing this screen is a poor
  investment: it is a placeholder for email-and-password sign-in. An earlier revision faked these
  states with a `DEBUG // UI STATES` switcher whose buttons did nothing and whose states existed
  only as HTML comments — scaffolding, not a design, and it has been removed. Keep the single
  uniform refusal and the deliberate exception for a revoked session; those two are decisions, not
  visual choices.
- **Placeholders for `Archive` and `System`** while they lead nowhere (R33). They must say so
  rather than 404 — calmly, in the language of the empty states, not as an error.

**Screens 2–4 have not been brought in line with any of this.** Known problems, from a first pass:
pass/fail semantics are back (a `SUCCESS` chip, `PASS` in a log, green ticks and red crosses beside
runs in the tree, the words "Visual Regression"); they carry a **second navigation** — a top bar
duplicating the sidebar — with a global `FORCE_RELEASE` button that has nothing to act on outside
Devices; `Profile` sits mid-sidebar instead of pinned at the foot; and the breadcrumb is used as a
label rather than as a path.

---

## 10. Working with Stitch — what actually happens

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
