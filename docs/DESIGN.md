# The panel's design — what is settled

Everything the **Devices** screen established, written down so the next screen inherits it instead
of rediscovering it. The Devices screen is the reference: where this document and a screen
disagree, this document is what the screen should have been.

`DESIGN_INITIAL_PROMPT.md` is the brief the first four screens were generated from and explains
*why* the product looks the way it does. `WEB_PANEL.md` is what the panel eventually needs to do.
`ai/RULES.md` §8 is how to reach the designs at all — read it first.

**This is a living document, and keeping it current is part of doing design work — not a follow-up.**
Whenever a screen settles something, whenever a correction is made and the reason for it is worth
keeping, whenever a Stitch screen is added or superseded, or whenever something moves out of §10's
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
| Devices — Host View Stale | `46f3a297fee047028f29c8958a926995` | Settled, **list variant only** — the empty variant has no Stitch screen and is settled in §7 |
| Devices — Force Release Confirmation | `d86e794af4de4639979bc65104e2ec57` | Settled, **the asking only** |
| Archive — Project Selection Refined | `b91c300db2d445b8a195a0bafd1aac76` | **Settled** — see §9 |
| Archive — Test Runs Refined (login-flow) | `8dcd4330b9b94105a7ba289620dc84aa` | **Settled** — see §9 |
| Archive — A run selected (Refined) | `d24d2c84e84041b28dfed67e92551d28` | **Settled** — see §9, all three cards built |
| Archive — Artifact Preview (Shell Corrected) | `a843d32b7a414ac3a84fd7e80aa8a8bf` | **Settled** — see §9, built with two recorded deviations; #143 restored the third |
| Archive — Browsing (V2) | `f2de4344f7e347aa894b3054d9cf4098` | **Superseded** by the three rows above; must not be built from |
| Run Detail — Artifacts (V2) | `36b54fbe032449d8a300ea0825bbf1c8` | **Retired by #133** — must not be built from; see §9 |
| Compare — Visual Diff (V2) | `897632dcadce44de9bdee74a94da14f5` | Not yet corrected — see §10 |
| Sign In — Rover OS | `5035330b2c12401080263625ff564369` | Settled, **default state only** — see §8 |

Earlier versions of each still exist and **must not be built from**. There is no way to delete a
screen through the API — only `delete_project`, which takes everything — so every iteration
accumulates.

**In the code, the tokens live in `panel/src/tokens.css`** (#111) — one `@theme static` block,
harvested from `designMd` and captured verbatim beside it as
`tests/fixtures/design/analog-horizon-tokens.json`. It is the only file in the panel allowed to
write a colour value, and `tests/unit/panel/tokens-are-the-source-of-truth.test.ts` enforces both
halves of that: every value in the fixture reached the file, and nothing under `panel/src` writes a
colour anywhere else.

Two things about the mapping, because neither is guessable from either end:

- **Tailwind v4 shifted its radius scale one step.** Analog Horizon's five radii are exactly v4's
  `xs`…`xl`, so the design's `sm` is `rounded-xs`, its `DEFAULT` (4px — the base radius for buttons
  and inputs) is **`rounded-sm`**, and its `lg` (8px — cards and layout sections) is `rounded-lg`.
  A rename, not a re-valuing. The design's `full` has no v4 theme key; `rounded-full` is built in.
- **The design's spacing `unit` is v4's whole spacing scale.** `--spacing: 4px` makes `p-4` 16px and
  `gap-5` the design's own 20px gutter. The four named measures (`gutter`, `margin-mobile`,
  `margin-desktop`, `container-max`) stay plain custom properties read as `p-(--margin-desktop)`:
  `--container-max` inside `@theme` lands in v4's `--container-*` namespace and emits a `max-w-max`
  that shadows the built-in `max-width: max-content`.

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
force-releasing a stuck lease is the first such action, and as of #122 it is built: one recessive
control on each held card, the confirmation §7 settles, and the outcomes §7 settles beside it. It
deliberately does **not** acquire devices: a lease carries the caller's own `owner` string (D22), an agent signs its own work, and a
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

**The nav icons — settled (#141).** `Devices` is a **phone**, `Archive` a box, `System` a prompt
and `Profile` a person: `Smartphone`, `Archive`, `Terminal` and `CircleUser` from `lucide-react`.
The three main items are drawn at `size={20} strokeWidth={2}`; `Profile` is 18, matching the
smaller label it sits beside at the foot.

**`Devices` deliberately supersedes the screen here.** `Home — Devices (V3)` emits
`data-icon="developer_board"` for that item, and `CircuitBoard` was a faithful translation of it —
but a circuit board reads as "hardware in the abstract", or as a dev board, and Rover leases
phones. The same markup already uses `smartphone` in four places, every one of them on a device
card, and §5 settles the phone for the card header, the free panel and the stale-list body; the one
place that *names* the destination was the only one using a different metaphor for it. The screen
is not regenerated for a single glyph — per §0 this document is what it should have been, so an
agent rebuilding the shell from that markup takes the phone from here, not `developer_board` from
there. `Archive`, `System` and `Profile` are unchanged from the screen (`inventory_2`, `terminal`,
`account_circle`).

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
  it. In code that 12px comes from Tailwind's own `--text-xs` rather than from `text-label-caps`,
  which would drag 700 weight and 0.1em tracking along with the size (#111).

**The header row** below it holds one line describing the screen on the left and the held/free
counter on the right, above a rule. On Devices that line is *"Monitoring attached physical and
virtual devices."* All three Devices states share this row's shape — they are three states of one
screen, and a header that differs between them is the thing most of this document exists to
correct.

**Destinations that lead nowhere yet — settled** (#111). `Archive`, `System` and `Profile` have
routes and say plainly that they are not built yet, rather than 404ing; so does any unknown
address, through the router's own not-found component. One shared component says it, in the
language of the empty states (§7): a heading, one sentence naming what is missing, and one closing
line. No error or warning colour, no icon of alarm, no spinner, no progress-shaped ornament, no
`role="alert"`, and **no control** — there is nothing here to do yet, and a button would be the
first thing to lie about that. `Profile` gets one for the same reason the other two do: a nav item
pinned in the chrome that does nothing when clicked is worse than one that says where it stands.

**The closing line differs between the two cases, on purpose.** A screen that is not built yet gets
*"It will be. Nothing is wrong here."*; an unknown address gets *"Check the address, or pick a
destination from the navigation."* A single reassurance for both would be false in one of them —
that address is not going to be built.

**One height.** The sidebar and the content area share it. With short content the page ends at the
foot of the viewport and `Profile` sits on that line; with long content the sidebar stretches to
the full page height. Neither column ever paints background below where the other ends.

*As built* (#111): one flex row, `min-h-screen`, sidebar first. A flex row stretches its children
to the row's height and the row is `max(100vh, content)`, so both halves of the rule fall out of
one declaration. **The sidebar carries no `fixed`, `sticky` or `absolute`, and `<main>` carries no
`ml-*` to compensate** — see §4. The accepted cost is that the navigation scrolls away on a long
page; Swarm's dashboard pins its sidebar with `md:sticky md:h-screen` instead, and this rule wins
here.

---

## 4. Layout

- **One positioning model for the sidebar, never two.** The single worst bug of the first four
  iterations was a `<nav>` carrying both `fixed` and `relative` while `<main>` still carried
  `ml-64` to compensate for a sidebar that was no longer fixed. Two offsets for one sidebar left a
  256 px dead band — and, because it starved the content box below the width two grid tracks
  needed, collapsed a three-column grid to one. Both symptoms, one cause.
- **Grid columns follow the width available to the content, not a viewport breakpoint.**
  `repeat(auto-fill, minmax(300px, 1fr))` is what the Devices grid uses; 300 rather than 350 because
  three cards plus their gutters have to fit the content width at the design's own size. A
  breakpoint would read the *viewport*, which includes the sidebar — the bug above in a second form.
- **The track has a floor and a ceiling: at most three columns, and a card is never full-width**
  (#126). The floor alone broke the layout at both ends. With one device attached, `auto-fit`
  collapsed the empty tracks and stretched the single card across the whole content width, where a
  card carrying a serial, a model, a state and a lease block reads as a banner rather than as one
  of a set; and because `<main>` carries no maximum, a 2560 px monitor produced seven columns of a
  screen this document only ever described at three. Both are the same missing constraint. The
  grid therefore carries `auto-fill` — which keeps the tracks a width can hold whether or not
  there is a card for them — and a maximum of `calc(3 × 380px + 2 × gutter)`, 1180 px. **The
  ceiling is arithmetic, not a breakpoint**: a fourth 300 px track needs 1260 px with its gutters,
  so it is unreachable at any window width, while below 1180 px the count still steps 3 → 2 → 1 on
  the content box exactly as the rule above says. 380 px as the implied card maximum leaves the
  design untouched at the size it was drawn for — the content box is about 1104 px there and three
  cards already come out near 354 px — and only bites above it.
  - `--container-max` (1280 px) is *not* this number and must not be repurposed as it: 1260 fits
    inside 1280, so it permits the fourth column — and it is an Analog Horizon token whose value is
    gated against the design fixture, so it is not a free parameter either.
  - `minmax(300px, 380px)` was considered and set aside. It bounds the track directly but never
    shares out the leftover space, leaving a ragged right edge at every width.
  - **This is the grid only.** *No devices attached*, the `stale` banner and *No view* keep the
    widths §7 gives them.
- **Equal margins.** The gap between the sidebar's border and the content equals the gap between
  the content and the page edge. The breadcrumb, the page title and the first card share one left
  edge.
- Cards must survive a realistic host. Three devices look fine; **eight phones attached is an
  ordinary machine**, and tall cards scroll badly at that count.

*As built* (#111): `<main>` carries `p-(--margin-desktop)`, which is the equal-margins rule in one
declaration — the gap from the sidebar's border to the content is the same token as the gap from
the content to the page edge. It also carries `min-w-0`, which is the *other* half of the bug
above: without it a flex item cannot shrink below its contents' intrinsic width, and a grid inside
it loses tracks for reasons that look nothing like the sidebar. `app-shell.test.tsx` asserts both —
that the sidebar's class list contains none of `fixed`, `sticky`, `absolute`, and that `<main>`
carries no horizontal margin.

The grid itself is one class list on the Devices screen (#126):
`grid-cols-[repeat(auto-fill,minmax(300px,1fr))] max-w-[calc(3*380px+2*var(--gutter))]`, and
`devices.test.tsx` reads the three numbers back out of it to assert that a fourth track cannot
fit inside that maximum. jsdom lays nothing out, so the ceiling is pinned as arithmetic rather
than as a measured width. Eight phones attached — the realistic host above — therefore lay out as
three columns of bounded cards rather than as one very wide row.

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

*As built* (#113): the countdown is that only motion, and it needs **nothing added** for
`prefers-reduced-motion`. It changes text, with no transition and no animation on it, so the global
block in `index.css` has nothing to reach. Recorded here so the next reader does not go looking for
a branch that is missing on purpose.

**The scanline texture stays, but only on chrome.** It carries the CRT character and costs nothing
to read against because it does not move. It must never be a fixed full-viewport layer in a blend
mode: two of the four screens are mostly screenshots of mobile apps, and an overlay tints the exact
thing the user opened the screen to look at. Any region rendering a screenshot, an extracted frame
or a log dump is clean.

*As built* (#111): a `.scanline` class on the sidebar and nothing else, as an `absolute inset-0`
child of that one element. The emitted design markup applied it **twice** — once per-element on
chrome, and once as `fixed inset-0 … mix-blend-overlay`, a full-viewport blended layer, which is
the exact thing this rule forbids. The fixed layer is deleted and the blend mode with it.
`app-shell.test.tsx` asserts that `<main>` contains no `.scanline` and that no scanline element is
`fixed` or in a blend mode. The Devices screen's own markup offered two more of them — one
inside the held/free counter badge and one in every card header, both blended — and neither is
reproduced (#113), for the same reason and by the same test: both live inside `<main>`.

**The chromatic text-shadow is for the wordmark only.** Never on data — serials, UTC timestamps,
short hashes and file names stay crisp and are never truncated or ellipsised.

*As built* (#111): a `.wordmark-chroma` class, asserted by
`tests/unit/panel/tokens-are-the-source-of-truth.test.ts` to be referenced from exactly one
component. The reference screen wrote its two colours inline at 0.5 alpha; the class reads them
from `--color-primary` and `--color-secondary-container` through `color-mix`, so the alpha is
carried and no colour literal reaches it. The active nav item's `2px 2px` offset is
`.nav-item-active-tactile` for the same reason — the screen had it as `rgba(0,226,157,1)`, which is
the tertiary token spelled out.

**Status LEDs are one component.** Same fill, same border, everywhere they appear; only the size
changes with context (3 on a card header, 2.5 in the counter badge). None of them glows.

| State | Treatment |
| --- | --- |
| Held | `bg-primary-container` + `border-primary` — neutral blue |
| Free | `bg-tertiary` + `border-tertiary` — green |
| Not ready | `bg-outline` + `border-outline` — grey |

*As built* (#113): `panel/src/components/devices/status-led.tsx`, one component with a tone and a
size and nothing else. It is `aria-hidden` everywhere it appears, because the card body already says
`ACTIVE LEASE`, `free` or what the host reports, and the counter's own text says "2 held" — it is a
second channel for something already written, which makes it decoration to a screen reader rather
than information withheld from one.

The **third tone arrived with #123** and the row above is the whole of it. A device the host reports
as `unauthorized` or `offline` is listed, holds no lease, and would be refused a lease
(`not-ready`), so it may not carry the free green — and the rule two paragraphs down says it may not
carry a warning colour either. Grey is what is left and it is the honest one: nothing has failed,
there is simply nothing here to take.

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
   screen wants the first before the second.
2. **`DESCRIPTION`**, full width, directly under it — **and only when the lease carries one**
   (#148). See below: it is a deviation from the approved markup.
3. `OWNER` and `PROJECT`, side by side.
4. `GRANTED`, last.

The countdown sits in the panel header. **It goes back up**: the TTL is renewed by activity, not by
a heartbeat (D8), so a countdown that only ever descends is wrong, and the screen must show the
renewal without a reload. It is not coloured green — green and red carry verdict meaning everywhere
else in software and this product has no verdicts.

**There is no `STATE` field.** It was tried and removed: the card already said the device was held
three times over — the panel header reads `ACTIVE LEASE`, the LED is the held colour, and the
counter above the grid says so.

Free — a dark inset panel in the same place the lease panel occupies, carrying a phone icon and
`free` in green. The icon was originally a plug pulled from its socket, which means "disconnected",
the opposite of what the card says: this phone is attached and ready.

**Not ready — settled (#123), and it is what closes the note this section used to leave open.** The
*device* state adb reports — `ready`, `unauthorized`, `offline` — is a different fact from being
held, and the card had nowhere to say it, so a phone sitting on its RSA prompt was drawn as *free*.
It is not: `src/daemon/lease-handlers.ts` refuses a lease on any device whose state is not `ready`,
so that card made a positive availability claim the host would not honour, which is the one class of
answer `ai/RULES.md` §2 singles out. It is still **not a `STATE` row** — the reason above holds. It
is the **third body in the free panel's slot**: the same dashed inset, a grey phone icon, the
state printed verbatim (`unauthorized`, not "Not authorized" — §6's rule about `platform`, and the
words `rover list`'s `STATE` column already prints), and one line that is the same whatever the
state, *Attached, but not available to lease.* No green, no tertiary token, and no warning colour.
A **held** device is unaffected: its lease panel renders whatever the hardware state is, because a
lease is the daemon's own bookkeeping and is still the answer to "who do I ask".

**The counter badge** above the grid reads `● 2 held  ● 1 free`, using those very LEDs — the held
one before the held count, the free one in place of the separator. No `·`, no glow, and it must
agree with the cards below it. *As built* (#123) it grows a third term, `● 1 not ready`, **only when
that count is non-zero** — the three buckets sum to the grid, so the badge still agrees with the
cards structurally, and on the ordinary screen it is exactly the two terms above.

*As built* (#113): `panel/src/components/devices/device-card.tsx`, and five things the design's mock
data never had to answer, settled here.

- **`grantedAt` is rendered exactly as the host sent it** — the whole ISO-8601 instant with its `Z`,
  never truncated to the mock's `14:02 UTC`, and never differenced against this machine's clock. It
  is the *host's* clock (`LeaseHolderSchema`, D17), so the only honest relative number on the card
  is the countdown, which is driven by `expiresInMs` — a duration — plus the moment the answer
  arrived. `src/cli/_shared/output.ts` holds the same line for the CLI.
- **`model: null` falls back to the serial** in the header. The header's job is to identify the
  device, and the serial always can.
- **`osVersion: null` renders `unknown`.** It is a real answer for a device waiting on its
  authorization prompt, and this field is one of the card's two fixed columns — dropping it would
  leave the row lopsided, so the gap is named rather than closed up.
- **`platform` is rendered verbatim, so it reads `android` and not the mock's `Android`.** A display
  table mapping one to the other would be a platform branch in shared code, which is the thing
  `ai/RULES.md` §2 exists to prevent; the wire value is what the host said.
- **The countdown carries no colour that changes with the time left.** The design's demo script
  turns it orange under a minute; expiry is normal and renewable (D8), orange is this palette's
  warning colour, and §7 already says this number is not dressed as urgent. It has no `aria-live`
  either — a region announcing once a second is a screen-reader firehose, and the digits are
  ordinary text.

**`DESCRIPTION` is not in the approved markup, and that is a deliberate deviation** (#148,
`636633385461686529`'s screens have no such field). It is recorded here rather than silently added,
the way §9 records its own two.

- **Why it is there at all.** `TEST NAME` is first because it is the only field that says what is
  happening on the phone right now — and it is also the archive's directory name, so it goes through
  `pathSegment`, is truncated at 64 characters and has every character outside `[A-Za-z0-9._-]`
  replaced. Agents therefore keep it identifier-shaped: `app-bar-top-space`, `mvp_walkthrough`. That
  names the check and does not say what the run is about, which is exactly what an operator deciding
  whether to force-release needs to read. So a lease may carry one or two sentences beside it (D22,
  as amended #148), and this is where they go.
- **Directly under `TEST NAME`, not under `OWNER`.** It answers the same question that field
  answers, in the words that field is too short for; owner and project answer a different one.
- **A lease without one draws no field and no placeholder row.** The description is *optional on the
  wire* — absent is an absent key, never `null` and never `""` — so there is nothing to name. This is
  the opposite of `OS VERSION`, which says `unknown` because it is one of the card's two fixed
  columns and dropping it would leave the row lopsided; a full-width conditional field leaves nothing
  lopsided, and an empty `DESCRIPTION` label would be the panel inventing the one thing the host
  declined to send.
- **It is not `TEST DESCRIPTION`.** The label sits directly under `TEST NAME` and repeating the word
  would read as a second name for the same field. `escapeControlCharacters`-style escaping is not the
  panel's problem — React escapes what it renders — but the string is caller-supplied prose, so it
  wraps like every other value on this card and nothing truncates it (§6's rule, unchanged).

**The held card carries one control** (#122), and only the held card: one recessive button at the
foot of the lease panel, below `GRANTED`, so what it would end is read before it is reached. The
design's markup puts a full-width solid orange `FORCE RELEASE` on it; **that treatment is still
deliberately not reproduced** (§5, *Destructive actions are recessive*) — it warms to
`secondary-fixed-dim` on hover like `Profile`'s sign-out, because a control that ends something is
not the loudest thing on its screen. What it asks before it acts, and what each answer says
afterwards, are settled in §7.

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
- **And `DESCRIPTION` under `TEST NAME`, when the lease carries one** (#148) — **a deviation from
  the approved markup**, recorded here as §6 records the same field on the card behind this dialog.
  The reason is this dialog's own: it exists so an operator can read what they are about to end, and
  `TEST NAME` is an identifier-shaped directory name (§6), which turned out not to be enough to make
  that judgement on. Same rules as on the card — full width, directly under `TEST NAME`, and **no
  field and no placeholder row** for a lease that supplied none, because absent is absent on the
  wire and there is nothing to name at the one moment it would matter most.
- An earlier revision carried an **"Outcome Snippets Reference"** strip — the same scaffolding
  mistake as the sign-in screen's `DEBUG // UI STATES`. Removed. The three outcomes it sketched are
  settled below, built from this document rather than from a screen.

### What a force-release settles — settled (#122)

The asking is above; this is what happens after it. **Three outcomes that must not collapse into
one**, plus a fourth case that is not an outcome at all. Each is ordinary text, `aria-live="polite"`,
with no colour of alarm and no icon of alarm — nothing here has gone wrong, and §5's no-red rule
holds through the panel's one destructive action.

- **The lease ended.** The card changing *is* the outcome, and it happens without a reload: the
  dialog closes and the screen asks the poll again rather than waiting up to `POLL_MS` for it. One
  line names the lease that ended, because the card stops showing it the moment the lease is gone.
- **The lease had already ended on its own**, between the page loading and the click (`not-held`).
  **News, not a failure**: *"That lease had already ended on its own, so there was nothing to
  release on …"* The poll is asked again here too — the card was already out of date.
- **Neither line calls a device free unless the host would honour that.** Both add *"The device is
  free."* / *"The device is free either way."* only when the listing says `state: ready`. Ending a
  lease says nothing about the hardware — the daemon releases a held lease before it looks at the
  device at all — so a phone that went `unauthorized` or `offline` mid-lease gets an ordinary
  `released` answer while the host would still refuse the next `acquire` on it `not-ready`. §6's
  rule for the card is the same rule, and the counter above the grid already puts that device in
  *not ready*: the line stops at what settled, and the card says what the hardware is.
- **The device is not on this host any more** (`gone`, `not-attached`). There is nothing left to
  release *or to show*: *"… is no longer attached to this host, so there was nothing to release. It
  is no longer listed."* Two host-side facts — one device it cannot see at all (D6) and one it can
  see but does not own (D18) — and exactly one fact for the person reading it, so they share a line.
  The device is simply not listed; nothing marks its absence (§5).
- **The fourth case, and it is not an outcome: the request that reached nothing.** No answer, an
  `error` envelope, or a result the panel cannot read — all three released nothing, so the dialog
  **stays open** with the control usable again and says exactly that. §8's rule applies unchanged:
  the panel never reports an ending it did not get. It does not say "try again" and stop there,
  because if the host is really gone the poll replaces this whole page within one interval. A
  session the host refused is not this case: the bounce to *access ended* is already happening, and
  the panel says nothing over it.

**All three settled outcomes are said above the grid, not on the card.** The `gone` line has to be —
its card has left the grid by the time the line is read. The other two are there for a reason of the
same kind: the control lives inside the lease panel, so the lease ending unmounts the only place a
card could have said so, and §6's card anatomy has no row for a fact that has already stopped being
true of it. One region, one wording per outcome, and it outlives the card it was about.

**The line stays until it is dismissed**, rather than until the next poll. A line the poll clears is
a line the operator may never have read, and this is the only place the panel explains why a
confirmed action changed nothing.

The **actor** on the wire is the signed-in user's `identifier`, and there is no field for it on the
dialog. D28 forbids *the host* deriving attribution from whoever authenticated; a client saying who
it is, is the opposite of that, and it is what makes the daemon's audit line name a person rather
than a browser. Never a constant like `panel`.

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

### Host view not current, with an *empty* list — settled (#113)

The dangerous half, and the one state here designed from this document rather than commissioned as
a Stitch screen (§9). `list_devices` answering an empty array with `stale` set means **no view**,
not *no devices* — it is visually identical to *nothing attached* and means the opposite, so a
person reading "nothing is attached" walks to the machine and finds a phone sitting in the socket.
That is not a visual preference; it is the reason the state exists (D6).

Both halves were reproduced against a running daemon before this was written: with an emulator
attached, interrupting the host's view of the hardware gives `stale: true` with the device and its
lease still listed; doing the same with nothing attached gives `stale: true` with an empty list,
which is this state and is one poll away from the one above it.

- **It is one block, not a banner over a block.** The banner exists to caveat a list, and with no
  list there is nothing to caveat — so the whole content area is the message, said once.
- **It takes the banner's grey treatment** (`surface-variant`, `border-outline-variant`, the icon in
  `text-outline`), *not* the *nothing attached* panel's `surface-container-lowest` card with corner
  accents. Different surface, different heading, different words: the two must not be mistakable,
  and that is the whole point of the state.
- Heading `HOST VIEW NOT CURRENT`, the same one clause the list variant carries. Then, in §7's
  language and with no error colour, no warning icon and no spinner: *Rover cannot say what is
  attached to this machine. Its view of the hardware was interrupted, has not arrived yet, or is not
  running.* — and, on its own line, *This is not the same as nothing being attached — a phone may
  well be plugged in.*
- **The counter is absent**, for *nothing attached*'s reason and more sharply: `0 held · 0 free`
  would describe an empty pool, which is the precise claim this state exists to refuse.
- **No retry control.** This is host state that resolves itself, and the poll is already asking.

`devices.test.tsx` names both empty states in one test and asserts that neither one's copy appears
in the other, because "these two must not render the same" is the criterion on this screen most
worth pinning.

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

*As built* (#113). Two things worth recording, because neither is guessable from the screen.

**Where it is mounted is what makes "gone, not dimmed" true.** `panel/src/app.tsx` renders it *in
place of* `RouterProvider`, above the router, exactly as the sign-in screen is rendered in place of
it. A route component cannot remove the shell its parent route renders, and a cover inside `<main>`
would leave every nav link in the DOM and in the tab order behind an opaque layer. That in turn is
why the device poll lives above the router too (`panel/src/devices/device-list-provider.tsx`), and
**the accepted cost is stated rather than hidden**: the poll runs while `Profile` is open, and an
unreachable host takes `Profile` down with everything else. The panel has exactly one live data
source and this is it. Only the reachability failure does this — a first poll still in flight leaves
the router where it is, and the Devices screen says it is reading.

**One consequence of that is sharper than the general cost, and it is `Profile`'s** (#123). A
sign-out the host never answered leaves the user signed in and says so on `Profile` (§8) — and it
fails on the very `fetch` that makes the device poll report unreachable, so the two always fail
together, at most `POLL_MS` apart. Whatever that line says, it is on screen for about five seconds
before this page replaces the router it renders in. So it may not instruct an action there will be
no control left to perform: it reports what happened and says where the panel is going instead, and
the wording in §8 is written to that. `RETRY CONNECTION` here retries the **device poll**, not the
sign-out; when the host comes back, the router returns and the sign-out is pressed again.

**This is the one place in the panel that uses the `error` tokens**, and it is worth saying why that
is consistent rather than an exception creeping in: §5 leaves red unused so it stays meaningful, and
§7 calls a stale view "an uncertainty, not a fault" — a host that cannot be reached at all is the
fault the reserve was kept for. It stays on the border, the mark and the headline. The design's
`shadow-[0_0_40px_rgba(…)]` glow and its radial-dot background are dropped, both being ornament and
colour literals at once.

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

### The four other states — settled

Only the default form was ever designed. These four are **states of that one screen, not screens of
their own**: the card, the wordmark, the vertical padding and the form are the default state's, and
only what is said above or below the input changes. The implementation is
`panel/src/screens/sign-in.tsx`, and the machine behind it is
`panel/src/session/session-provider.tsx`.

An earlier Stitch revision faked all four with a `DEBUG // UI STATES` switcher whose buttons did
nothing and whose states existed only as HTML comments. That was scaffolding rather than a design and
has been removed; it is recorded here because it is the shape a "state gallery" comes back in.

**The screen is not a route, and that is what keeps the token out of every URL.** While there is no
live session the panel renders it in place of the router (`panel/src/app.tsx`), so there is no
address a credential could be attached to, no `?next=` to record and nothing to redirect back to.
The form is `method="post"` with an unnamed field, so even a native submit with the script broken
cannot put the token in a query string.

**Checking — two faces, and neither is a spinner.**

- **On boot**, with a session id the browser was holding: the same shell-less page, the wordmark, and
  one quiet line — *Checking the session this browser was holding.* No form, because whether a form
  is needed is exactly what the probe is deciding, and a form that appeared and then vanished would
  invite a paste into a field about to be replaced.
- **On submit**, with a token in flight: the form stays exactly where it is, its control disabled and
  its label changed from `Sign in` to `Checking…`. **The form must not be unmounted** — the field
  keeps what was pasted, which is the whole reason a refusal is recoverable in place.

**Refused — one message, for every reason.** Below the input, in ordinary text, `aria-live="polite"`
and never `role="alert"`: a refused attempt is not an emergency. It carries **no colour of alarm** —
the same rule §7 applies to an empty state — and it must not hint which of a token nobody holds, a
revoked user's token or a malformed one it was, because the host answers all three identically on
purpose. It also covers a host that never answered at all, so the wording claims **neither the token
nor the host** as the cause: *That did not sign you in. Check that the whole token was pasted, and
that the host is running.* The field keeps its content **and its focus** — disabling the control is
what takes focus away, so it is given back.

**Signed out — the same card with one line.** After a deliberate sign-out: a small block above the
form, `Signed out`, saying that the session ended on the host. **A cold arrival carries no line at
all, and that is the only difference between the two.** The sign-out control itself is on `Profile`
and nowhere else — the sidebar carries no action (§3), and the design's own early revision promoting
`Log Out` into the navigation is one of the mistakes §7 records.

That line says the session **ended on the host**, which means this state may only be reached once
the host has answered. **A sign-out the host never answered does not arrive here.** It stays on
`Profile`, still signed in, with the control re-enabled and one `aria-live="polite"` line below it —
*Nothing answered on the host, so the session is still open and you are still signed in. If the host
stays unreachable the panel says so in place of this page — sign out again once it is back.* — in
ordinary text with no colour of alarm, because nothing has gone wrong with the session. `Profile`'s
own paragraph says the same thing before the fact rather than only after it.

**It said "Try again." until #123, and that was the one thing it could not say.** The device poll
fails on the same `fetch`, so within `POLL_MS` the unreachable page replaces the router and takes
this screen and its control with it — the instruction outlived the control that could follow it by
about five seconds. §7 records the mechanism. A `401`
does arrive here: a host that will not take the id has already forgotten it, so that sign-out is
finished. The reason it cannot be the other way is the whole reason the browser holds a session id
rather than the token — announcing an ending nobody performed would clear the one id that could
still perform it, leaving a live credential on the host for the rest of its idle window with nothing
able to reach it.

**Access ended — the deliberate exception, and it still does not claim why.** A session that was
live and stopped being accepted says so plainly: `Access ended`, *This host stopped accepting the
session. Sign in again — and if that does not work, ask whoever runs the host.* Telling this person
costs nothing, because they authenticated a moment ago. What it may not do is name a cause: a
revoke, a rotate and a daemon restart are indistinguishable from a browser, and §7's "the headline
must not claim to know which" applies here too. It is not red, not a warning colour and not an
alert; it is news. The stored session id is cleared on the way into this state, so a reload does not
land here twice.

**The edges those four have to answer between them**, and they are answered by what the *evidence*
supports rather than by what is convenient. **One rule covers all of them: the panel never discards
a session id without the host's answer, and never reports an ending it did not get.**

- **A stored id the host refuses on boot is *access ended*, not a cold arrival.** The id in storage
  is the evidence that somebody was signed in with it; a bare form with no explanation would be the
  panel knowing something and not saying it.
- **A boot probe that reaches nothing is a cold arrival, and the id is kept.** An unreachable host
  has said nothing about whether the session is good, so signing someone out over a daemon that was
  restarting would be inventing bad news. There is no `HOST UNREACHABLE` page here (§7's is a state
  of the Devices screen): the sign-in card is already the shell-less page, and the one refusal above
  is worded to cover this.
- **A sign-out that reaches nothing is not a sign-out.** It stays on `Profile`, signed in, and says
  the host did not answer — the *Signed out* paragraph above has the wording and the reason.
- **A sign-in that replaces a kept id ends that id first, and does not wait to hear how it went.**
  The bullet above leaves an id behind on an unreachable host, and the next successful sign-in is
  what would otherwise strand it: the host would then hold two live sessions for one person, one of
  them unreachable by any browser. So the replaced id goes to `DELETE /session` on the way out, and
  the answer is ignored — a host that has come back reclaims it, a host still down changes nothing,
  and the sign-in that just succeeded is not made to depend on either.

**Where the session is kept, and what it costs.** The browser stores the **session id only**, under
one `localStorage` key (`rover.panel.session`), and never the token — the token reaches the host once
in a request body and is dropped. `localStorage` rather than `sessionStorage` because a per-tab
credential would ask for the token again in a second tab and always after a browser restart, which
is the whole thing the session exists to avoid. The cost is stated rather than hidden, exactly as
`PROJECT.md` D30 states it: whatever the panel keeps the id in is readable by script, so an XSS in
the panel reads it — but what it reads is a credential that expires on its own, that a sign-out
ends, and that is not the token `rover users` issued. A cookie would swap that for a credential the
browser attaches to cross-site requests whether the page meant to or not, which is why the host sets
none and this reads none.

---

## 9. The Archive screen, as settled

The panel's second screen against host data (#132) after Devices, and the first with any depth to
it: **a file explorer over the artifact archive**, a lazily expanding directory tree beside the contents of whatever is
selected. Everything below was settled while building it and is written down here for the same
reason the Devices screen's rules are — the alternative is the next agent re-deriving it and getting
some of it the other way round.

The one host method behind it is `list_archive` (#130, `src/daemon/list-archive.ts`), which answers
**one directory level** at a time. Every rule here is downstream of that: a screen that could ask
for a subtree would have been drawn differently. The two things a level cannot answer both read a
file's *contents* off #131's byte route — the run's device card (#136) and the artifact preview
(#133) — and that is the whole of the screen's second data path. Both are settled below.

### The four approved screens

| Screen | ID | What it settles |
| --- | --- | --- |
| Archive — Project Selection Refined | `b91c300db2d445b8a195a0bafd1aac76` | The shell, the header, the two-card content area, the tree |
| Archive — Test Runs Refined (login-flow) | `8dcd4330b9b94105a7ba289620dc84aa` | The run list, `OWNER` / `GRANTED` |
| Archive — A run selected (Refined) | `d24d2c84e84041b28dfed67e92551d28` | The run column: the identity card, the device card, `CONTENTS` |
| Archive — Artifact Preview (Shell Corrected) | `a843d32b7a414ac3a84fd7e80aa8a8bf` | The preview beside the run's column (#133) |

There is deliberately **no design for the root level** (a list of projects). It is the same component
with one fewer column, and the issue's own instruction — *the three levels are one component with
different rows* — is what makes that safe rather than a gap.

**Three defects in the emitted markup are not reproduced**, and are recorded so nobody "fixes" the
code back towards them. (The fourth screen's own deviations are a different thing — decisions the
acceptance criteria reversed rather than defects — and the two that stand are recorded with the
preview below, together with the third, which #143 handed back to the markup.)

1. `8dcd4330…` uses **`break-all`** on tree rows and run names. It is **`break-words`** everywhere in
   the built screen: `break-all` splits `issue-112` across two lines, which makes an owner string
   unreadable at exactly the width the tree is narrowest. `d24d2c84…` already had it right.
2. `8dcd4330…`'s describing line reads *"Every test filed under this project, alphabetically."* over
   a badge reading `42 runs archived`. That line is the project level's, left behind by an edit.
3. `8dcd4330…` hid its fifth run row with an inline `opacity: 0`. **The file served on 2026-09-01 no
   longer carried it** — either it was edited or an earlier reader saw a different render (§11: the
   file id is what changes when a render catches up). Recorded anyway, because a row hidden by an
   inline style is the kind of thing a later reader copies without noticing.

And one thing about all four that is portability rather than a defect: they carry Material Symbols
and a raw Tailwind CDN config. The panel uses `lucide-react` and `panel/src/tokens.css`, and the
design's `rounded` is Tailwind v4's `rounded-sm` (§1's radius rename).

### The shell and the two cards

The header is `PageHeader`'s two rows unchanged (§3): the breadcrumb, then the describing line on the
left and **one badge** on the right over the `border-b-2` rule. The content area is
`max-w-(--container-max)`, a `lg:w-[320px] shrink-0` tree `<aside>` beside a `flex-1` contents
`<section>`, both `bg-surface-container border-2 border-outline-variant rounded-lg` with a
`bg-surface-container-high` header strip.

**Every state below is a state of this one screen**, exactly as §7 requires of the Devices screen.
The breadcrumb, the describing line and the header row's shape are the same in all of them; the
badge is the only thing in the header that comes and goes, and it **goes rather than reading `0`**.

### The tree — expansion is derived from the URL

**A node is expanded exactly when it is a prefix of the selected path**, and the selected node is
expanded too. Nothing else is, and there is no stored expansion state anywhere.

Three of the issue's requirements fall out of that single rule rather than being implemented
separately:

- *the tree expands lazily, one `readdir` at a time* — the levels read are precisely the prefixes of
  the selection, at most four requests at the deepest point, each one a level actually drawn. A
  pre-walk is not avoided so much as unrepresentable;
- *a reload lands where you were and a link is shareable* — the whole of the screen's state is the
  address;
- the tree and the URL cannot disagree, because there is only one of them.

**The accepted cost**: a folder cannot be peeked at without selecting it. That is ordinary
file-explorer behaviour, it buys the removal of a whole class of *the tree says one thing and the
address says another* bugs, and a separate collapse control is a later change if anybody wants one.

**What a tree row may carry, and nothing else:**

- **A folder icon on every row, and a triangle only on an expandable one.** A run is a **leaf**: its
  `<serial>` is a fact about the run rather than a level (below), so there is nothing under it to
  open. `FolderOpen`/`Folder` and `ChevronDown`/`ChevronRight`, both `aria-hidden` — the triangle is
  decoration meaning *this opens*, not a second control inside a link.
- **No count.** `childCount` is on the wire and is deliberately not drawn here. The header badge
  carries the one number for whatever is selected, which is what keeps the tree a tree rather than a
  report. `directory-tree.test.tsx` asserts the tree's exact text, so a number cannot creep back in.
- **No status icon of any kind** — no tick, no cross, no dot, no play glyph, no colour that means an
  outcome. Rover has no verdicts to report (§2), and green ticks beside runs in the tree are exactly
  what the superseded `Archive — Browsing (V2)` got wrong.
- **The name, verbatim and `break-words`.** Nothing is truncated, ellipsised or lower-cased.

**Every row is a `<Link>`**, and only a `directory` entry becomes one: the tree is the navigable
structure, and the complete listing — including a file or a `kind: 'other'` entry the archive is not
supposed to have at that level — is the contents card's job, which does name it rather than dropping
it.

**A level with nothing in it draws nothing under its node** — no `0`, no placeholder row, no icon. A
directory that does not exist is not listed, and one the host cannot see into is said in the contents
card, where there is room to say it properly.

### The three levels, and the fourth thing a run is

The depth decides what a row is; **no name is ever parsed to decide what a level *is*** (D22).

| depth | the level | a row is | it carries | expandable |
| --- | --- | --- | --- | --- |
| 0 | the root | a project | its name | yes |
| 1 | a project | a test name | its name, and `RUNS` from `childCount` | yes |
| 2 | a test name | a run | its name, `OWNER`, `GRANTED` | **no — a leaf** |
| 3 | a run | not a tree level | — | — |

- **`RUNS` reads `childCount`, and `null` is `unknown` — never `0`.** A `0` would say *no runs* about
  a directory the host could not read into, which is the exact distinction `childCount: null` exists
  on the wire to carry.
- **Runs are listed most recent first — in the tree and in the contents card alike**, which is the
  host's own fixed order reversed. Reversing is not parsing: a lease directory leads with a UTC
  basic-format timestamp precisely so that it sorts chronologically as text
  (`src/daemon/archive-path.ts`), and the daemon sorts in code-unit order for that reason. The
  describing line says *most recent first* so the order is claimed rather than left to be inferred.
  **One helper decides it for both panes** (`panel/src/archive/level-order.ts`): they list the same
  run directories side by side, and a pane that kept the host's order beside one that reversed read
  as two different lists.
- **A legacy `unlabeled/` directory lists like any other folder.** It was the fallback for a lease
  taken without a `test_name` before #129 required one (D22); nothing on this screen knows the word,
  and a run filed under it browses like any other.
- **A run's identity is its directory name decomposed at the *first* and the *last* hyphen.**
  `indexOf('-')` and `lastIndexOf('-')`, never `split('-')`: an owner string is free text and
  `pr-127-review` is **one** owner, which a naive split turns into `pr`. A name that does not have
  the shape gives `unknown` for both fields with the name itself still shown in full.
- **`OWNER` is the directory's own text and is never presented as the caller's string.** It went
  through `pathSegment` on the way in and that is not reversible, so what the screen can honestly say
  is what the directory is called (D20, D22).
- **`GRANTED` is reformatted textually**, `20260830T170501Z` → `2026-08-30 17:05:01 UTC`. No `Date`
  and no `Intl`: the string is the host's own UTC instant and nothing may re-express it in the
  reader's zone, which is §6's rule for `grantedAt` on a device card applied to a directory name.
- **`DESCRIPTION` is the run's own `test_description.json`, read off #131's byte route** (#148) —
  full width, under the three-column `OWNER` / `GRANTED` / `SERIAL` grid, because it is a sentence
  rather than a measured value. It is **not in the approved markup**: a third deliberate deviation,
  recorded here with the two below. The reason is the one §6 gives for the same field on a live
  device card — a run's identity is an owner and an instant decomposed out of a directory name, and
  `app-bar-top-space` under `tb-rover-test-app` is otherwise all there is to say why anyone took the
  phone. See *The run's description* below for its states.
- **A run filed before #148, or by a lease that described nothing, reads `none filed`** — and that
  is the common case rather than a gap. Nothing is invented for it and no row disappears.
- **`SERIAL` is the parent listing's `onlyChild`, and the serial is not a tree level.** One lease is
  one device, so a run directory holds exactly one child; the host publishes that name as a fact
  about the run rather than as a level worth a round trip. A selected run therefore costs **four**
  listings, not five — the run's own level is never listed. **That a run directory holds exactly one
  entry is load-bearing**, which is why the archive files a lease's description *inside* the
  `<serial>` directory rather than beside it: a second entry at the run level would make `onlyChild`
  `null` and blank this field, the device card and `CONTENTS` for every run that had one
  (`PROJECT.md` §10).
- **A `null` `onlyChild` is stated, not worked around.** `SERIAL` reads `unknown` and `CONTENTS` says
  there is nothing to list. There is no second request to go looking: a run directory that is not
  one-device shaped is a fact, and an invented `0` would be a claim.
- **And *no serial yet* is a third thing again, never that one.** The serial is read off the level
  *above* the run, and that level has its own three answers: while it is in flight `SERIAL` reads
  `reading` and `CONTENTS` says it is reading, and when the host cannot read it `SERIAL` reads
  `not readable` and `CONTENTS` carries the banner. Only a level that answered and named no single
  child gets *there is nothing to list for this run* — a definite negative about what a lease wrote
  is exactly what must not be rendered out of an answer nobody has given (D6, and the state table
  below). This matters because the levels are four independent round trips: the root usually answers
  first, so a link straight to a run renders the run panel before the level above it has come back.
- **`CONTENTS`** lists the `<serial>` directory: a directory as `<name>/` with its count (`1 file`
  singular), a file with `formatBytes(sizeBytes)`, and a `kind: 'other'` entry by name with no
  measure. The design's footnote is kept — *A directory that is not listed does not exist — a verb
  that produced no bytes wrote nothing* — because it is the sentence that stops a short listing
  reading as a truncated one.
- **A size the host could not `stat` is `unknown`**, for `childCount: null`'s reason.

### The three states with nothing to browse

| Where | The answer | What renders |
| --- | --- | --- |
| the root | empty, or not there | `QuietPanel` — **Nothing in the archive**. No badge, **no tree card**, no control. |
| the root | unreadable | `QuietBanner` — **`ARCHIVE NOT READABLE`**. No badge, **no tree card**, no retry, no error code. |
| deeper | empty, or not there | one plain line inside the contents card, tree still beside it. |
| deeper | unreadable | the same banner inside the contents card, tree still beside it. |
| anywhere | nothing yet | one quiet line, `aria-live="polite"`, **no spinner** (§5). |

- *Nothing in the archive* takes §7's ***nothing attached*** treatment, because it is the same kind of
  fact: normal, common and *finished*. It says what would change it — a run is filed the first time a
  verb on a lease writes a screenshot, a recording or a log on this host — and **the counter is
  absent** rather than reading `0 projects archived`, which would describe a set.
- *`ARCHIVE NOT READABLE`* takes §7's **grey banner**, one clause, and carries on its own line
  ***This is not the same as the archive being empty — runs may well be filed here.*** That sentence
  is the whole point of the state, exactly as *a phone may well be plugged in* is for *no view*: the
  pair must never render alike (D6). **No retry control** — this is host state the panel is not the
  fixer of — and **no error code**, because the reason and the path stay on the host by design
  (D19), so a code would dress a refusal up as a diagnosis.
- The two deeper states keep the tree, because there **is** still an archive to browse. The two root
  states take the whole content area, because **an empty tree beside a message is furniture**.
- `panel/src/routes/archive.test.tsx` asserts that neither of the deeper two's copy ever appears in
  the other, the way `devices.test.tsx` already does for *nothing attached* and *no view*.

**Everything unusable folds into *not readable*.** An `error` envelope, a result the panel cannot
parse and a request nothing answered all land there — the fold `device-list-provider.tsx` already
makes and documents, for the same reason: what the screen has to decide is narrower than why, and
*runs may well be filed here* is true either way. A **`refused`** sets nothing at all, because
`Session.call` has already fired `onRefusal` and the router is coming down.

### Routing, and no polling

Two routes, `/archive` and `/archive/$`, one component, `useParams({ strict: false })`. Two rather
than one optional splat because the splat route does not match `/archive`, which is the address the
navigation points at. The components are joined with `/` and the router does the encoding — a
directory name may legally carry a space, a `%` or a `#`, and `archive-path.test.tsx` proves the
round trip against a **real** router rather than the mocked `Link` the screen tests use.

**There is no polling and no refresh control.** The archive is finished data: a run directory is
written while a lease is live and nothing is added once it ends, and this screen makes no claim to
show a run appearing. A level is fetched on navigation and cached for the life of the screen. This is
the one place the panel's data differs from the Devices screen's, which polls because *what is
attached* changes under the reader.

**A path deeper than a run is reachable only by typing it**, since a run is a leaf. It renders that
level's listing rather than nothing at all — names, addressable, no invented measures.

### Three deviations from the approved markup, made deliberately

- **The identity card carries a `DESCRIPTION` field** (#148). The approved screens have no such
  field, because the string it draws did not exist when they were drawn. Its reason, its states and
  why it is always drawn are above, under *The run's description*; §6 records the same field on the
  live device card and the force-release dialog.
- **A contents row is a `<Link>`.** The approved screens have `cursor-default` on these rows, which
  would leave the tree as the only way to move and make the larger half of a file explorer inert.
  Nothing else about a row changes: it gains no control, no count the tree refuses to show, and no
  status of any kind.
- **A `kind: 'other'` entry gets `FileQuestionMark`.** The designs have no glyph for one, because
  they never showed one. It says *the host could not classify this*, which is what the wire says; it
  is not an alarm and there is no colour on it.

### Deliberately absent, and why

- **The `Filter this tree...` input** in `b91c300d…`. It appears on one of the three approved screens
  and on neither of the other two, no acceptance criterion asks for it, and D24 spends a paragraph
  refusing search. Dropped, and recorded here rather than silently omitted.
- **The `LATEST` column** in `b91c300d…`'s contents table. One `readdir` per test row is exactly the
  walk D24 refuses; `list_archive` cannot answer it and must not grow a parameter that can.
- **No aggregate of any kind** — no total size, no run count across projects, no retention figure.
- **Nothing invented**: no duration, no trigger, no author, no environment panel, no network figure
  and no file name that was not in a listing. `run-panel.test.tsx` asserts the absence of each. The
  device card is held to the same rule from the other side — it may only say what its file says.

### The device card — settled (#136)

**`DEVICE — FROM device_info.json`** (`d24d2c84…`'s second card) is card 2 of three, between the
run's identity card and `CONTENTS`, and it is **the one thing on this screen that is a file's
contents rather than a listing**. `list_archive` answers directory levels; the bytes come from
#131's byte route (`GET /artifact/<component>/…`, `PROJECT.md` R37), through
`Session.readArtifactText`, which exists for `Session.call`'s reason — so a screen that needs a
file's contents gets a method rather than the session id.

The file is the archive's own static snapshot of the device the lease held, written once per
lease-device pair beside the first artifact that pair produced and never rewritten (D14,
`src/daemon/archive.ts`). That is what lets this card answer for a run that ended weeks ago: it says
what the device *was*, not what it is.

- **Six fields, in the design's own order** — `MODEL`, `PLATFORM`, `OS VERSION`, `API LEVEL`,
  `SCREEN`, `DENSITY` — in its `grid-cols-2 sm:grid-cols-3` grid, reusing the same `Field` the
  identity card uses. Every value comes out of that run's own file and **nothing is invented**: no
  duration, no trigger, no author, no environment panel, no network figure.
- **§6's three fallbacks hold, and they are the same three the device card implements.** `model:
  null` falls back to **the serial** (the `<serial>` directory's own name, which the identity card
  is already showing); `osVersion: null` renders **`unknown`**; `platform` is rendered **verbatim**,
  so it reads **`android` and not `Android`** — a display table mapping one onto the other would be
  a platform branch in shared code, which `ai/RULES.md` §2 exists to prevent. `API LEVEL` follows
  `osVersion`'s rule for `osVersion`'s reason.
- **A field the file does not carry is named as unknown**, not dropped and not a reason to call a
  readable file unreadable. The panel's mirror is non-`.strict()` **and every field is optional**,
  which is one step looser than the other two mirrors and is the criterion rather than laziness.
- **`SCREEN` and `DENSITY` are composed**, `1080 x 2400 px` and `2.625x — 411 x 914 dp`, and **a
  composition never invents a missing half**: without both pixel dimensions, or without all three of
  scale and the two dp values, the field reads `unknown`. **The dp values are rounded here and
  nowhere earlier** — the host stores exact quotients on purpose (`ScreenInfoSchema`) and rounding
  is a presentation decision.
- **`DENSITY` does not print the dpi.** The file carries `density` (420 on the capture); the
  design's field is the scale and the dp size, and a number nothing draws is not a field the panel's
  mirror pins.
- **Three states, and the pair among them must never render alike.** *Rover filed none for this
  run*, and *something is filed there and this host will not read it* — the same distinction the
  archive's empty and unreadable levels draw one directory up (D6). Both are one plain sentence
  where the rows would be: **no alarm colour, no warning icon, no error code and no retry control**
  (§7). A `404` is the first; a `400`, a `500`, a body that is not JSON, one the mirror cannot parse
  and a request nothing answered all fold into the second, which is the fold `archive-levels.tsx`
  already makes. A **`refused`** sets nothing, because the router is already coming down.
- **The level above is ordered before the file's own answer**, exactly as `CONTENTS` orders it and
  for the same reason: the file lives inside the run's `<serial>` directory, whose name is that
  level's `onlyChild`. With no serial there is no address, so nothing is fetched — a level in
  flight is *reading*, one the host cannot read is *not readable*, and a run naming no single child
  has no directory for a file to be in. None of the three may borrow another's sentence.
- **One request per run, on navigation, cached for the life of the screen.** No interval, no
  prefetch for a run nobody selected, and no caching across runs. Since #148 a run has **two** such
  files — this one and `test_description.json` — so a selected run costs **four listings and two
  files**, and both go through the one hook that owns the address and the read-once rule
  (`panel/src/archive/archived-file.ts`).

### The run's description — settled (#148)

**`DESCRIPTION` on the identity card is the second thing on this screen that is a file's *contents*
rather than a listing**, and it is read exactly as the device card above is: one `readArtifactText`
per run, on navigation, cached for the life of the screen. **A selected run therefore costs four
listings and two files.**

The file is `test_description.json` in the run's `<serial>` directory, written once by the archive
beside the first artifact the lease produced and never rewritten (`src/daemon/archive.ts`, D22 as
amended #148). That is what lets this field answer for a run that ended weeks ago: it says what the
lease said, not what anyone remembers.

- **Four answers, and no two of them share a phrase.** The sentence itself; `reading`; `none filed`;
  `not readable`. The pair that must never render alike is the last two — *no description was
  written* is ordinary and common, and *the host cannot read the file* is the host saying nothing
  about the lease at all (D6, and the same distinction the empty and unreadable levels draw).
- **The level above is ordered before the file's own answer**, exactly as the device card orders it
  and for the same reason: the file lives inside the `<serial>` directory, whose name is that level's
  `onlyChild`, so with no serial there is no address and nothing is fetched. A level in flight reads
  `reading`, one the host cannot read reads `not readable`, and a run naming no single child has no
  directory for a file to be in, which is `none filed`.
- **The field is always drawn, which the live device card's is not**, and the asymmetry is the point.
  On a device card absence is a fact the answer carries — no key, so nothing to draw. Here absence is
  a *file that is not there*, and *reading* and *not readable* have to be tellable from it; there is
  nowhere else on the card to say those, so the field says all four.
- **A readable file with no description in it reads `none filed`, not `not readable`.** The states
  are about the *description*, not about the file: the host read what is there and it says nothing
  about this run. Rover never writes such a file, so the case is not one it can produce — and calling
  it unreadable would claim the host failed at something it did.
- **Lower case, like `SERIAL`'s own three.** These are the screen saying what it does not have, not
  values the host sent.

### The artifact preview — settled (#133, narrowed by #143)

Opening a file from a run's `CONTENTS` **replaces the directory tree with a preview beside the run's
own column**, so the artifact is read where it was found. This is a state of the Archive screen and
not a second screen: the breadcrumb, the describing line and the header row's shape are the same in
it as in every other.

**Opening a *folder* from that same `CONTENTS` does not** (#143). A folder is a level of the run's
own subtree rather than a second artifact, so it expands under the row it was clicked from and the
screen stays in the browsing layout — the tree on the left, the run's column on the right, which is
what a selected run already renders. Everything below is about an open **file**, except where it
says otherwise; the two places this reverses #133 say so where the reversed rule was written.

**`Run Detail — Artifacts (V2)` (`36b54fbe032449d8a300ea0825bbf1c8`) is retired by this, not
deferred.** The first draft of §10 drew a boundary — *Archive lists; Run Detail opens* — and the
boundary was the weaker half: sending a reader to a second address for the thing they are already
pointing at is not an explorer. That screen has nothing left this does not do, and it is marked
accordingly in §1.

**Two columns, equal halves.** Both are `flex-1 min-w-0` inside `max-w-(--container-max)`, with **no
fixed width, no percentage and no `basis-*` on either**. The approved markup pins the preview to
`lg:w-[580px] shrink-0`; that was tried and **reversed**, because a pinned preview makes the *split*
depend on the window, so the same screen shows different proportions on different monitors. The tree
is **not shown while a file is open** — the run's column takes its place. A folder keeps it (#143).

**The run's column is the run screen's own second column, unchanged** — in less space beside a
preview, and in exactly the same space beside the tree. The identity card and the device card do not
change at all (`run-panel.test.tsx` asserts they are byte-identical in both states). Two things do,
and both follow from `CONTENTS` having become how another address inside the run is chosen:

- **The card is headed by the back arrow and a left-aligned `Run Details`** — the markup's own
  header, which #143 restored. It was built as *the arrow alone, and centred*; every other header on
  this screen is left-aligned, so that put the one control on the card off the axis of everything
  under it, and a heading that stays put means the arrow **appearing** is the whole of what changes
  when a preview opens. Pressing it closes the preview and returns the screen to two columns with
  the tree back on the left. One control, one outcome — nothing else in that strip navigates — and
  it is a `<Link>` to the run's own address rather than a `<button>`, because the whole of this
  screen's state is its address: the tree returns *because* the address is three components deep
  again. **A folder open in `CONTENTS` has no back control at all**: the tree is beside it, and the
  tree is the way back.
- **The folder being browsed expands to its file names, and the open one carries the selected
  treatment.** Every other folder stays summarised. That is the tree's own rule — *expansion is
  derived from the URL* — applied to the run's subtree: a folder is expanded exactly when the open
  address is **inside** it, **or is it** (#143). The addressed folder itself used **not** to be
  expanded, and the reason was sound while it held: when a folder was what is open, its listing was
  the card beside this column, and drawing it here as well would have been the same listing in two
  places. #143 took that column away — a folder is a level of this subtree, not a second artifact —
  so there is no second place left to draw it in, and the one folder a reader actually pointed at
  was the last thing this card should have refused to open where it was clicked. A nested row
  carries the name only and an expanded top-level row keeps its count: the measures stay on the
  top-level rows, where the card's job is to say what the run wrote.

**The path bar grows one segment for the open address, and the `<serial>` is in no segment of it.**
That address is where you are, file or folder alike: last, `text-tertiary`, not a link, shown in
full and wrapping rather than shortening. The serial is not a tree level, so there is no address to
link it to.

**The header row's counter slot is empty, and that is the rule rather than an exception.** The badge
is a counter and one file has nothing to count — exactly as §7 leaves the held/free counter absent
rather than showing `0 held · 0 free`.

**The preview region is clean, and this is the rule that must not be traded away.** Nothing is laid
over or around the artifact: no scanline, no dotted pattern, no gradient, no tint, no
`mix-blend-mode`, no vignette, no glow, no phone frame or device bezel, no drop shadow, no coloured
frame, no watermark. **A hairline border is the most that is permitted**, and it is on the image
alone. §5 wrote that rule before there was a screen to apply it to — *an overlay tints the exact
thing the user opened the screen to look at* — and this is where it is cashed in;
`artifact-preview.test.tsx` asserts the region's class list carries none of them, in all four bodies.

**Three bodies share one frame** (`ContentsCard`), and only what sits inside it differs:

- **An image** — a screenshot or an extracted frame — `max-h-full max-w-full object-contain`, centred
  in the region. Contained, at its natural aspect ratio, never stretched and never cropped, and
  **never scaled up past its own pixels**, which `max-*` gives for free.
- **A recording** — a plain `<video controls>`, the browser's own controls, and **no `autoPlay`, no
  `loop`, no `muted`**. §5 forbids anything that loops on its own; a video a person pressed play on is
  a response to something real, exactly as the lease countdown is.
- **A text file** — `logs/*_read_logs.txt` or `device_info.json` — monospace, in the card body's own
  scrolling region, with a line-number gutter, **because those are the file's real lines**
  (`artifact-body.ts`, `linesOf`: one trailing newline is dropped because `renderLogs` writes one; a
  blank line inside the file is kept and numbered). **The level is rendered as plain text with no
  colour.** `W` and `E` are the device's words about its own logs, not Rover's verdict on anything;
  colouring them imports the pass/fail vocabulary §2 has already had to remove several times, on the
  one region of the panel where a fabricated `PASS` line lived longest.

**And an honest fourth: `opaque`.** The route serves bytes it cannot name as
`application/octet-stream` rather than refusing them, so the panel says in one plain sentence that it
has no way to show the file — `NothingFiledHere`'s language and weight, no alarm colour, no icon, no
error code, no control. **No object URL is created for it either**, because an address for something a
browser will not display is only ever an offer to download.

**Which body a file gets comes from the host's own content type, and there is not a second extension
table in the panel.** `src/daemon/archive-file.ts` owns that vocabulary; `panel/src/archive/artifact-body.ts`
maps its answer onto a body, and `tests/unit/panel/artifact-bodies.test.ts` holds the two ends
together across the trees — a host that learns `.webm` cannot leave the panel quietly unable to draw
it. The glyph in `CONTENTS` is deliberately **not** per media type for the same reason.

**One control in the preview header: `Open in a new window`**, recessive, and **it is a view rather
than a transfer.** No download button, no `download` attribute, and it is absent for `opaque`. No
zoom, pan, rotate, filmstrip or next/previous arrows over the image — `CONTENTS` is how another file
is chosen. No annotation, measurement or comparison tooling; comparison is `Compare — Visual Diff`'s
question and a different screen.

**Routing — the open address is part of the path**, so a reload lands on it and the link is
shareable. Above the `<serial>` the layout is a function of the **depth alone**; below it, it is the
depth **and what the parent listing says the address is** — a dependency #133 did not have and #143
reintroduced knowingly, because a folder and a file are not the same kind of thing to open. The
bullets under the table are what that costs and how it is paid:

| `selected.length` | State | Tree | Second column |
| --- | --- | --- | --- |
| 0–2 | a level | yes | that level's `LevelContents` |
| 3 | a run | yes | `RunPanel`, headed `Run Details` |
| 4 | the `<serial>` level, typed | yes | that level's `LevelContents` |
| **≥ 5, an artifact** | **inside the run** | **no** | **the preview** |
| **≥ 5, a folder** | inside the run | **yes** | **`RunPanel`**, with the folder expanded in its `CONTENTS` |
| **≥ 5, nobody has said which** | inside the run | no | **nothing — the run's column alone** |

The `≥ 5, a folder` row is #143's reversal of the single `≥ 5` row it replaces, which read *the
preview, **or that folder's `LevelContents`***. A folder no longer takes a column of its own: it is
a level of the run's own subtree, the card already draws a little tree for every ancestor folder on
the open path, and sending the one folder a reader pointed at to the other side of the screen was
the one thing that subtree would not open in place.

- **The levels read below the `<serial>` are the `<serial>` down, exclusive of the address itself**
  — each one drawn, the first as `CONTENTS` and the rest as its expansions. The root, the project
  and the test level are **not fetched for an artifact**, because the tree is not there to need
  them; a **folder** brings the tree back, so it needs those three again and asks for them **only
  once the parent listing has said it is a folder** (#143). Wanting them from the depth instead
  would put three requests on the way to every preview, which is exactly the cost #133 removed. So
  the three root states above gate the browsing layout **above a run only**: no column of an address
  inside a run may wait on the archive root, and the tree fills its own levels in as they arrive.
- **The `<serial>` comes from the URL there** (`selected[3]`), not from the level above the run's
  `onlyChild`. The address was built from a listing, so that component *is* the directory's name; it
  removes a dependency, means neither column waits on the level above the run, and collapses
  `RunSerial` to `answered` — correctly, since *reading* and *not readable* cannot apply to a serial
  the address already carries.
- **What the address names is read off its parent's listing, never off its own name** (D22). Until
  that listing answers, nothing is fetched for the address and neither layout is drawn (last
  bullet). **An artifact is deliberately not fetched on a guess**: asking the byte route for a
  directory would put *not a regular file* in the host's log on every folder a reader opens. An
  address the listing does not name at all *is* asked for, because *nothing is filed at this
  address* is the byte route's answer to give rather than the screen's to invent.
- One artifact at depth 6 therefore costs **four requests**: two listings, the run's
  `device_info.json`, and the artifact. A **folder** at depth 5 costs **six**: its parent listing,
  its own, the run's `device_info.json`, and the tree's three, which are asked for after the answer
  that wants them. **And the artifact's four are four however you arrive**, which took a second pass
  to be true (#140 review): the `<serial>` level and the open folder's listing are addressed by
  paths *derived from* an answer, and holding those in a second cache meant the run's `<serial>` was
  read once for the run and again for a file under it. One cache, asked as a function of what it
  already holds (`archive-levels.ts`).
- **Nothing is claimed about the address until its parent has answered — and no layout is drawn that
  would then have to be flipped.** Until then the header carries the run's own line, not *One
  artifact from this run* and not *Reading this artifact*, which are claims the screen has not been
  given (#140 review): a deep link into a folder read both of those about a directory for as long as
  the listing took. And what the content area draws is **the run's column alone** (#143) — the one
  card both layouts have, and nothing that would have to be taken away again. Each answer then
  *adds* a card, the preview on the right or the tree on the left, so a shared link never moves what
  the reader is already looking at, which is the guarantee #140's review bought when the layout was
  the depth alone. *Reading this address.* is retired with the second column it filled: the level in
  flight is the parent listing, which the run's column already draws as `CONTENTS`, so the wait is
  now shown where the answer lands rather than in a card beside it.

**The artifact's height bound is `max-h-[70vh]`, and it is viewport-relative because a percentage
one does not resolve here.** `max-h-full` was the first attempt and it is inert: nothing above the
artifact has a definite height — the card's `<section>` is `min-h-[400px]` at `height: auto`, its body
is a `flex-1` item that stretches to its content — so `max-height: 100%` computes to `none` while
`max-width: 100%` resolves normally, and the artifact came out **bounded by width alone**. Measured in
headless Chrome at 1400x900 on the built chain (#140 review): a 1080x2400 screenshot was **576x1278**
with the card 1372 px tall, the whole screen page-scrolling and the run column stretched blank beside
it; under `70vh` it is **257x569** with the card 663 px. The same class bounds the `<video>` and, with
`overflow-y-auto`, the text body — where a 5 000-line log (`MAX_LOG_ENTRIES`) grew the card to tens of
thousands of pixels instead of scrolling in it, because the card's own `overflow-y-auto` has no
definite height to overflow. So *contained, scaled down to fit* above and *in the card body's own
scrolling region* below are both this bound rather than the card's, and **`max-*` is not what keeps a
small screenshot at its own pixels** — no dimension being set at all is.

**`Open in a new window` opens a document in the panel's own origin, and `nosniff` does not reach
it.** The address is a `blob:` URL of bytes this tab fetched, so a top-level navigation to it is a
same-origin document; `x-content-type-options: nosniff` is a header on the *host's* response
(`src/daemon/http-listen.ts`) and does not travel with the blob, which is the one thing R37's safety
argument was written for a direct fetch and does not cover here (#140 review). Nothing is exploitable
today — `CONTENT_TYPES` serves only `image/png`, `video/mp4`, `text/plain` and `application/json`, all
inert when navigated to, and `opaque` creates no URL at all. What holds it that way is an **allowlist
of media types the panel will open**, in `tests/unit/panel/artifact-bodies.test.ts` beside the
draw-it-at-all check: `.svg` or `.html` added to the host's table would pass *can the panel draw it*
as `image` and `text`, and both are scriptable as a document, so that gate is what turns red instead.

**The two deviations from the approved markup**, recorded rather than made silently: the preview is
`flex-1 min-w-0` and not `lg:w-[580px] shrink-0` (above); and the arrow is a `<Link>` rather than a
`<button>`, with `CONTENTS` keeping this screen's existing `FileText` glyph instead of the markup's
per-media `image` one.

**There was a third, and #143 gave it back to the markup**: the run column's header was the back
arrow *alone and centred*, where the markup has `arrow_back` plus a left-aligned `Run Details`
heading. What that was for survives — the strip holds one control and nothing else navigates — but
the centring did not: every other header on this screen is left-aligned, so the card's one control
sat off the axis of everything under it, and with the heading always there the arrow can appear
without the strip's contents changing.

**Two costs, stated rather than hidden.** **An authenticated byte route cannot be an `<img src>` or a
`<video src>`** — a subresource fetch is the browser's own request and carries no `Authorization`
header, so it gets the uniform `401`, and a credential in a URL is what D20 forbids. So the panel
fetches with the session header and renders the object URL, which means **the whole artifact is
buffered in the tab before it is shown**, and the host's `Range` support is not what makes a
`<video>` seek here — a blob URL answers ranges in the browser, and the range stays useful for a bare
`curl`. And **closing the preview revokes the URL**, so a tab opened from it that is still streaming a
long recording will stop. The artifact is deliberately **not cached**, unlike every level and the
device card: a recording is megabytes and its object URL is a live handle on them, so the URL's
lifetime is the state that holds it. There is no cap on a text file's lines; `MAX_LOG_ENTRIES` bounds
the ones Rover writes at about 5 000.

---

## 10. What is not designed yet

Two lists, and the difference between them matters. The first must exist as a Stitch design before
anyone builds it, because getting it wrong is expensive and the mistakes are not obvious. The
second is left to whoever implements it, working from this document — a design round would cost
more than it would settle.

### Design these first

Nothing, at present. Everything the Devices screen needs has a design; what is left is below.


### Open, and not blocking anything

- **The three font families are loaded from Google Fonts over the network** (#111). On a host with
  no internet the panel falls back to system faces — legible, and wrong. Self-hosting them through
  `@fontsource` is the fix and has not been done; it is worth doing in the change that first serves
  the panel from the daemon, since that is when a Rover host stops being assumed to be online.

### Leave these to whoever implements them

Build them in keeping with everything above — the palette and tokens, no looping animation, the
uniform refusal, the vocabulary — and **write what you settled back into this document** (see the
top of this file). Do not commission a Stitch screen for them.

- **The "no view" state with an *empty* list — done** (#113). It was built from this document rather
  than from a Stitch screen, exactly as this list intends, and what it settled is written into §7
  above. Left named here so the next reader can see that the method worked once.
- **The force-release action's three outcomes — done** (#122). Built from this document, and what
  they settled is written into §7 above, together with the fourth case the issue did not name: the
  request that reached nothing, which released nothing and says so.
- **The Archive screen's root level, and its three states with nothing to browse — done** (#132).
  The three levels had approved screens; the root level and the empty-ish states did not, and were
  built from this document as this list intends. What they settled is written into §9 above.
- **The Archive preview's rules, and what it deliberately does not offer — done** (#133). They were
  settled here by #131, before there was a screen, and settling them at that point was deliberate:
  #131 is what made them decisions about the *host's answer* rather than about one panel's markup.
  The screen was then built from them, and **what it settled is written into §9 above** — the
  equal-halves layout and why a pinned preview was reversed, the tree's absence while a **file** is
  open (a folder keeps it, #143), the back arrow, the clean region, the honest fourth body, and the
  two costs of an authenticated byte route. The five rules below stand as written and are what §9
  implements.

  - **An image is shown at its natural aspect ratio**, scaled down to fit the panel and never up
    past its own pixels: a screenshot enlarged past 1:1 is a blurrier version of the evidence
    somebody opened it to read.
  - **A video carries the browser's own controls, and it does not autoplay and does not loop.** Not
    a styled player: the browser's controls already have a scrub bar, a keyboard and a volume, and
    reimplementing them would be a second video UI to maintain for no gain. Autoplay and looping
    are both forbidden for the reason §5 forbids a looping animation — a recording that starts
    itself, or restarts forever, is motion nobody asked for beside data somebody is reading.
  - **A text file is printed verbatim** in the monospace face, wrapped rather than truncated, with
    nothing parsed out of it and nothing colourised. A log line is evidence; a renderer that
    highlighted `ERROR` would be the pass/fail semantics this panel does not have (§2).
  - **There is no download control anywhere in the panel. This is a view, not a transfer** — a
    choice, and not a limitation of the route, which serves the bytes a `download` attribute would
    save. Rover is the machine holding the artifact and the archive is browsable on that machine
    already (`rover archive`, `PROJECT.md` D4); a download button in the panel invites copies of
    somebody else's run onto laptops, and the one thing the preview genuinely needs — a full-size
    look — is what **Open in a new window** is for. The choice stands until someone asks otherwise.
  - **Open in a new window** opens the artifact's own address in a new tab, and it is the panel's
    fetch that carries the credential: the address is a plain `GET` URL, but a top-level navigation
    sends no `Authorization` header and a credential in a URL is what D20 forbids, so the control
    fetches the URL with the session header and opens the object URL it gets back. The consequence
    to design around rather than hide: the address pasted into a bare tab gets the host's uniform
    refusal, exactly as every other unauthenticated request to it does.

**The one remaining uncorrected screen is `Compare — Visual Diff (V2)`
(`897632dcadce44de9bdee74a94da14f5`).** The Archive screens were corrected and are settled in §9;
this one was not. `Run Detail — Artifacts (V2)` (`36b54fbe032449d8a300ea0825bbf1c8`) was the other,
and it is **retired by #133** rather than waiting for a correction: the preview beside the run does
everything it was for (§9). Known problems with the remaining one, from a first pass: pass/fail
semantics are back (a `SUCCESS` chip, `PASS` in a log, green ticks and red crosses beside runs in the
tree, the words "Visual Regression"); it carries a **second navigation** — a top bar duplicating the
sidebar — with a global `FORCE_RELEASE` button that has nothing to act on outside Devices; `Profile`
sits mid-sidebar instead of pinned at the foot; and the breadcrumb is used as a label rather than as
a path.

---

## 11. Working with Stitch — what actually happens

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
- **The emitted Tailwind config's `borderRadius` block is wrong, and nothing in the markup says
  so.** It reads `DEFAULT: 0.125rem, lg: 0.25rem, xl: 0.5rem, full: 0.75rem` — shifted one step
  down from `designMd`'s own `rounded` map, with a `full` that cannot be a pill. Its colour, type
  and spacing blocks *do* agree with `designMd`, which is what makes the radii dangerous. **Harvest
  every token from `designMd`, never from the emitted config.**
- **The screen carries `class="dark"` and a `dark:` variant on most colour utilities.** The design
  is dark-only, so the `dark:` half is the effective one — usually the same value twice, but not
  always: the reference's inactive nav hover is `hover:bg-surface-container-high
  dark:hover:bg-surface-container-highest`, and it is the second that renders. Read the effective
  value, do not assume the pair is redundant.
- **The `md:hidden` mobile header is not portable.** Its content is a global `FORCE RELEASE`
  button, a `settings` icon, an `account_circle` icon and a second copy of the sidebar's wordmark —
  an action the shell may not carry (§7), plus a duplicate. It was dropped in #111 rather than
  reproduced; below `md` the sidebar stacks full-width above the content.
