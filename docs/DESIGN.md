# The panel's design — what is settled

Everything the **Devices** screen established, written down so the next screen inherits it instead
of rediscovering it. The Devices screen is the reference: where this document and a screen
disagree, this document is what the screen should have been.

`DESIGN_INITIAL_PROMPT.md` is the brief the first four screens were generated from and explains
*why* the product looks the way it does. `WEB_PANEL.md` is what the panel eventually needs to do.
`ai/RULES.md` §8 is how to reach the designs at all — read it first.

**This is a living document, and keeping it current is part of doing design work — not a follow-up.**
Whenever a screen settles something, whenever a correction is made and the reason for it is worth
keeping, whenever a Stitch screen is added or superseded, or whenever something moves out of §11's
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
| Archive — A run selected (Refined) | `d24d2c84e84041b28dfed67e92551d28` | **Settled** — see §9, built as **two** cards: its third, `CONTENTS`, is deliberately not built (#161) |
| Archive — Artifact Preview (Shell Corrected) | `a843d32b7a414ac3a84fd7e80aa8a8bf` | **Settled** — see §9, built with three recorded deviations, the **arrangement itself** among them: #160 stands the preview beside the tree rather than beside the run's column |
| Archive — Browsing (V2) | `f2de4344f7e347aa894b3054d9cf4098` | **Superseded** by the three rows above; must not be built from |
| Run Detail — Artifacts (V2) | `36b54fbe032449d8a300ea0825bbf1c8` | **Retired by #133** — must not be built from; see §9 |
| Compare — Visual Diff (V2) | `897632dcadce44de9bdee74a94da14f5` | Not yet corrected — see §11 |
| Sign In — Rover OS | `5035330b2c12401080263625ff564369` | Settled, **default state only** — see §8 |
| Projects | `74633a3b3d39445a8dedd0de97c2cc2b` | **Superseded** by the row below, and must not be built from — its shell was rebuilt from scratch and wrong in eight places (§12) |
| Projects — Final Alignment | `89097f87f206419d91751655d67d5f2a` | **Settled** — see §10, built with three recorded deviations (#157) |

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

**The panel is not read-only** (D27). It carries *authority over a shared resource* —
force-releasing a stuck lease is the first such action, and as of #122 it is built: one recessive
control on each held card, the confirmation §7 settles, and the outcomes §7 settles beside it.

**The `Keep` tick is the second** (D33, #234 and #237, §9): the operator says which tests a sweep
must spare, and the host records it in a document of its own. What makes it one of these rather than
a step in one agent's work is D27's own test — it is authority over something *shared*, not over
one caller's own lease. An archive holds every agent's runs, so the exemption is the operator's
call, one agent could otherwise clear another's, and there is nothing about the decision that
belongs to the run that produced the files. That is also why neither of the two is an MCP tool.

The panel deliberately does **not** acquire devices: a lease carries the caller's own `owner` string
(D22), an agent signs its own work, and a person clicking a button has nothing to sign one with. So:
no "new lease", no "request device", no create/edit/delete anywhere — every action it has is one the
operator takes over something the host holds for everybody.

---

## 3. The shell

**The shell's one source is `Devices (Home)`, screen `3458d89bda5e442d894ea54208230d4c`.** Every
screen in this panel is the same shell with a different content area, so a new screen does not get
a shell of its own — it takes that one, markup and class lists included, and changes only what sits
inside `<main>`. §7 says to state that by id in every prompt about a *state* of the Devices screen;
it applies just as literally to a **new destination**, and the Projects screen is what proved it
(§12): asked for without the id in front of it, Stitch rebuilt the shell and got it wrong in eight
places at once. The three deliberate departures from that screen's own markup are recorded rather
than left to be re-argued — the `Devices` glyph (below), the `md:hidden` mobile header (§12), and
the radius rename (§1).

**Sidebar**, in this order: the `ROVER_OS` wordmark, a divider, then the nav items `Devices`,
`Archive`, `Projects`, `System` — and `Profile` **pinned at the foot, below its own divider**,
separated from the main nav.

- **`Archive`, not `History`.** It is a browsable tree of project → test name → run, not a
  chronological event log.
- **`Projects` sits between `Archive` and `System`** (its screen is settled in §10). The placement
  is not arbitrary: `Devices` and `Archive` are what the host
  *has* right now and what it *kept*, `System` and `Profile` are settings. A registered project is
  the third thing the host holds, so it belongs with the first two rather than filed under
  settings. It is **read-only when it arrives** — what is registered and what each project
  declares, never an edit and never a delete (`PROJECT.md` D31), so nothing about this item
  promises a control the screen does not have.
- **`System` stands in for settings** and suits the aesthetic. **Its screen is settled in §13** and built (2026-09-08, on the operator's own request rather than from an issue): the first two settings on it are what the archive is allowed to keep. It stays one destination rather than growing a `Settings` sibling — two doors to one room is the one thing this arrangement cannot survive.
- **There is no `Analytics` item and there will not be one.** Rover aggregates nothing and scores
  nothing; a nav entry with a trend-chart icon promises a reporting product that does not exist.
- **No `Documentation` or `Support`.** Not part of this panel.
- **No host/daemon status block in the sidebar.** One was tried and removed: when the panel cannot
  reach Rover there is nothing to display anywhere, so "is the daemon reachable" is a state of the
  whole page, not a widget beside the navigation.
- The active item carries the green accent (`tertiary`, `#00e29d`).

**The nav icons — settled (#141).** `Devices` is a **phone**, `Archive` a box, `System` a prompt
and `Profile` a person: `Smartphone`, `Archive`, `Terminal` and `CircleUser` from `lucide-react`.
The main items are drawn at `size={20} strokeWidth={2}`; `Profile` is 18, matching the
smaller label it sits beside at the foot.

**`Projects` is `Boxes` — settled (#157).** It is drawn like the other three main items and not
like `Profile`. The Stitch screen emits Material's `account_tree`, and its faithful translations
(`FolderTree`, `Network`) are both wrong here: §10 settles that this screen has no tree, no
expansion and nowhere to navigate to, and a tree glyph would collide with the `Archive`, which *is*
one. A cog (`FolderCog`, `Settings`) is wrong for a different reason — it promises the write D31
refuses, and settings are `System`'s and `Profile`'s — and `Package` names a field on the card
(`apps`) rather than the destination. `Boxes`, a set of named things the host holds, is this
section's own logic for the placement, and its three-cube silhouette is distinct from `Archive`'s
lidded box.

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
    gated against the design fixture, so it is not a free parameter either. **Since #240 it is
    applied to no content row at all.** It was the cap on the Archive's tree-plus-card row and on
    the Projects list, and taking it off both is what gave those screens the right edge below. It
    stays declared in `tokens.css` at its fixture value because the token file is where every
    Analog Horizon value has to reach — `tokens-are-the-source-of-truth.test.ts` fails on a token
    that never got there, and on a re-valued one. **A token the panel defines and no longer applies
    is the correct end state, not something for a later cleanup to tidy away**, and re-applying it
    to a row is what the gate named below fails on.
  - `minmax(300px, 380px)` was considered and set aside. It bounds the track directly but never
    shares out the leftover space, leaving a ragged right edge at every width.
  - **This is the grid only.** *No devices attached*, the `stale` banner and *No view* keep the
    widths §7 gives them.
- **Equal margins.** The gap between the sidebar's border and the content equals the gap between
  the content and the page edge. The breadcrumb, the page title and the first card share one left
  edge.
- **One right edge, and it is the shell's** (#240). A screen's content row takes the width `<main>`
  gives it — the `--margin-desktop` a side above and nothing else — so the header's right edge and
  the content's are the same line at every window width. Until #240 they were not, and could not
  have agreed by construction: `PageHeader` has no measure of its own and fills the content box,
  while the cap lived on each screen's own row, so the two widths were never written in one place.
  The arithmetic of the mismatch, from the tokens: a 1920 px window gives a content box of
  `1920 − 256 − 2 × 40 = 1584 px` and the Archive's row stopped at `--container-max`, 1280 px,
  leaving a **304 px** strip the header used and the content did not; on a 2560 px monitor it was
  **944 px**. What noticed it was the `All` / `Testing groups` toggle sitting in the header at the
  edge of that strip, over content that stopped well short of it. **The Devices grid is the one
  deliberate exception and stays narrower than its own header**, because
  `calc(3 × 380px + 2 × gutter)` is the *at most three columns, and a card is never full-width*
  decision two bullets above and nothing in #240 reverses it. If a measure is wanted anywhere else
  it belongs on **prose** — `max-w-prose`, which the Profile screen's paragraphs carry — and never
  on a row holding a tree, a grid or a table.
- Cards must survive a realistic host. Three devices look fine; **eight phones attached is an
  ordinary machine**, and tall cards scroll badly at that count.

*As built* (#111): `<main>` carries `p-(--margin-desktop)`, which is the equal-margins rule in one
declaration — the gap from the sidebar's border to the content is the same token as the gap from
the content to the page edge. It also carries `min-w-0`, which is the *other* half of the bug
above: without it a flex item cannot shrink below its contents' intrinsic width, and a grid inside
it loses tracks for reasons that look nothing like the sidebar. `app-shell.test.tsx` asserts both —
that the sidebar's class list contains none of `fixed`, `sticky`, `absolute`, and that `<main>`
carries no horizontal margin.

*As built* (#240): `app-shell.test.tsx` asserts `<main>` carries **no maximum** either, and that the
header inside it carries none — the two halves of the right-edge rule in the one place they meet.
Over the screens it is
`tests/unit/panel/content-ends-where-the-header-does.test.ts`, which fails on any `max-w-*` in
`panel/src/routes/` outside exactly two exceptions — `max-w-prose`, and the Devices grid's column
ceiling in `devices.tsx` alone — and asserts each of the two is still reached by something, so a
stale exception cannot sit there green. Its second half is `--container-max`: still declared in
`tokens.css`, applied nowhere in `panel/src`. Its limit is the family's (`panel-source-scan.ts`) —
a content row moved into a component outside `panel/src/routes/` would escape the first half.

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

**A pointer on what can be pressed, and nothing on what cannot.** The affordance has to match the
behaviour: a control that presses says so under the cursor, and anything that does not press stays
silent. Tailwind v4's preflight, unlike v3's, carries no `cursor: pointer` for `button` — so until
#180 every control in the panel hovered as the user agent's arrow and nothing in the interface read
as clickable at all. The Archive's `All` / `Testing groups` toggle is where that was noticed, not
where it lived; all ten buttons the panel drew had it.

*As built* (#180): one rule in `index.css`'s `@layer base`, `button:not(:disabled) { cursor:
pointer }`, and no `cursor-*` utility in any component. A base rule on the element rather than a
class per control, because the rule is about **every** button including the next one somebody
writes — a utility sprinkled across eight files is the one the ninth component forgets. It also
adds no class, so it is invisible to the tests that assert over rendered markup, and an element
selector cannot reach anything that is not a button: the archive's contents rows are `<div>`s,
read and not followed (§9), and keep exactly the nothing they had.

`:not(:disabled)` is the whole of the exception, and its reason is `.control-tactile`'s: a disabled
control promises a press that does nothing, so it drops the affordance rather than keeping a
weakened one. The three that exist — the sign-in submit, `Profile`'s sign-out and the force-release
confirmation, each while its ask is in flight — keep their `cursor-not-allowed`, which promises
nothing.

**Links needed nothing.** Every user agent already points at an `a[href]` and preflight leaves that
alone, so the `<Link>`s in the sidebar, the breadcrumb and the archive tree, and the `<a>` behind
`Open in a new window`, were never part of this. `tests/unit/panel/pointer-on-what-can-be-pressed.test.ts`
is the gate: it puts the panel's own base rules through a real cascade and reads the cursor back off
a button, a disabled button, an archive row and a link, so the rule is asserted by what it reaches
rather than by the string it is written as.

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

*As built* (#113, its first row rewritten in place by #223):
`panel/src/components/devices/device-card.tsx`, and five things the design's mock data never had to
answer, settled here.

- **`grantedAt` reads `2026-08-31 16:02`: the reader's own zone, to the minute, no zone marker** —
  and it is **the format every timestamp in this panel uses**, decided in
  `panel/src/time/instant.ts` and nowhere else (#223). It was *rendered exactly as the host sent
  it* until then — the whole ISO-8601 instant with its `Z`, never truncated to the mock's
  `14:02 UTC` — and that rule is **reversed here in half, in place, with its reason rewritten**
  (`ai/RULES.md` §1).
  - **The half that stands, unchanged.** Nothing differences a host instant against this machine's
    clock and nothing relative is derived from one — no *5 minutes ago*, no elapsed figure. It is
    the *host's* clock (`LeaseHolderSchema`, D17, R29), so the only relative number on the card is
    the countdown, driven by `expiresInMs` — a duration — plus the moment the answer arrived
    (`panel/src/devices/countdown.ts`).
  - **The half that was wrong.** Rendering an absolute instant in the reader's zone is not the same
    mistake as differencing it. `grantedAt` is an unambiguous instant (`z.string().datetime()`,
    UTC), so re-expressing it in another zone is *exact* and needs no agreement between the two
    clocks — skew only costs something when you **subtract**. The old rule collapsed *do not
    difference* and *do not localise* into one prohibition, and the second half of it is what left a
    screen built for a person printing `2026-08-31T14:02:41.219Z` beside the Archive screen's
    `2026-08-30 17:05:01 UTC` — two formats for one kind of fact, disagreeing about the precision
    and the zone marker as well.
  - **The zone comes from the reader; the format does not.** No `toLocaleString()`, which renders
    `8/31/2026, 4:02 PM` on an `en-US` machine and something else again on the next one — that is a
    second format, which is the thing this rule exists to prevent. The fields come out of
    `Intl.DateTimeFormat` and the string is assembled in a fixed order with fixed separators; the
    pinned locale supplies the calendar and the digits and never the pattern, and **no formatter is
    held at module scope**, because one built once would freeze the zone at first use and a reader
    who changes their system zone mid-session would keep the old one for the life of the tab.
  - **Two costs of minute precision, both accepted.** The value on screen no longer round-trips to
    the host's exact instant, so it cannot be pasted into a host-side UTC log search; and two
    instants a second apart read alike. The second is answered on the Archive screen, where the run
    directory's own name carries the full `…T170501Z` instant and is always drawn beside the field
    (§9). Nothing on the device card needs the equivalent — a lease is one grant, and there is no
    second one beside it to tell apart. The full instant on a `title` was considered and is
    deliberately not added: a hover is not a second format, but it is a second place a rule about
    this field would have to be kept.
  - **The CLI is not on this rule**, and #113's claim that `src/cli/_shared/output.ts` "holds the
    same line" goes with the half that was reversed. It prints the host's instant verbatim and
    stays that way: `rover list`'s output gets piped, diffed and pasted into a host-side log
    search, so the exact instant is the useful value there. This rule is about the screen a person
    reads.
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

### …and the half of it that will never clear — settled (#168)

`list_devices` now answers a `staleReason` beside `stale`, and it is `null` for every transient
interruption — which is the state above, unchanged in every particular. It is **not** `null` in one
case: `tooling-missing`, meaning the host could not run the program it watches devices with at all.
A machine with no `adb` anywhere the host looks (`PROJECT.md` D32) retries forever and fails
identically every time, so the wording above — the last thing seen, check back — is advice that
never comes good.

This is a **variant of both stale states, not a fifth state**, and the distinction is what keeps the
screen from growing a state per cause:

- **The heading does not move.** `HOST VIEW NOT CURRENT` is still true and is still one clause. A
  second heading would be the `//` clause §7 already trimmed twice, in a different shape.
- **The treatment does not move either.** Still grey, still `QuietBanner`, still nothing near red.
  Nothing failed here in the sense that would earn a warning colour — a program is not installed.
- **One clause changes**, and it is the one that implies a wait. Over a list: *…and it will not
  correct itself: this host could not run adb, so it cannot see its android devices at all until
  somebody installs it there or points that host at a copy it already has.* Over an empty list, the
  same clause replaces *interrupted, has not arrived yet, or is not running*.
- **The sentence that keeps the empty case apart from *nothing attached* stays**, word for word.
  That is the state's whole reason to exist and no cause makes it less true.
- **The panel knows nothing about adb.** The program's name and the platform arrive on the wire and
  are rendered as they came (`ai/RULES.md` §2). A `cause` this screen does not recognise — a newer
  daemon naming a second permanent one — falls back to the ordinary wording rather than inventing a
  sentence for it.
- **Still no retry control**, and now for a second reason: retrying is precisely what will not help.

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

The host method behind **browsing** it is `list_archive` (#130, `src/daemon/list-archive.ts`), which
answers **one directory level** at a time. Every rule about the tree is downstream of that: a screen
that could ask for a subtree would have been drawn differently. The two things a level cannot answer
both read a file's *contents* off #131's byte route — the run's device card (#136) and the artifact
preview (#133) — and that is the whole of the screen's second data path. Both are settled below.

**And the tree card searches, over a second method** (#146): `search_archive` (R38) answers matching
entries of the *whole* archive in one call, so the searched tree is one answer rather than a walk.
Browsing still reads one level at a time, and nothing about the levels changed to make room for it —
it is a new method beside `list_archive`, never a parameter on it.

### The four approved screens

| Screen | ID | What it settles |
| --- | --- | --- |
| Archive — Project Selection Refined | `b91c300db2d445b8a195a0bafd1aac76` | The shell, the header, the two-card content area, the tree |
| Archive — Test Runs Refined (login-flow) | `8dcd4330b9b94105a7ba289620dc84aa` | The run list, `OWNER` / `GRANTED`, and the tree card's search field (#146) |
| Archive — A run selected (Refined) | `d24d2c84e84041b28dfed67e92551d28` | The run column: the identity card and the device card — its third card, `CONTENTS`, is deliberately not built (#161) |
| Archive — Artifact Preview (Shell Corrected) | `a843d32b7a414ac3a84fd7e80aa8a8bf` | The preview's own frame, region and control (#133) — it stands beside the **tree**, not beside the run's column (#160) |

There is deliberately **no design for the root level** (a list of projects). It is the same component
with one fewer column, and the issue's own instruction — *the three levels are one component with
different rows* — is what makes that safe rather than a gap.

**Three defects in the emitted markup are not reproduced**, and are recorded so nobody "fixes" the
code back towards them. (The fourth screen's own deviations are a different thing — decisions the
acceptance criteria reversed rather than defects — and the three that stand are recorded with the
preview below, together with the two that no longer do.)

1. `8dcd4330…` uses **`break-all`** on tree rows and run names. It is **`break-words`** everywhere in
   the built screen: `break-all` splits `issue-112` across two lines, which makes an owner string
   unreadable at exactly the width the tree is narrowest. `d24d2c84…` already had it right.
2. `8dcd4330…`'s describing line reads *"Every test filed under this project, alphabetically."* over
   a badge reading `42 runs archived`. That line is the project level's, left behind by an edit.
3. `8dcd4330…` hid its fifth run row with an inline `opacity: 0`. **The file served on 2026-09-01 no
   longer carried it** — either it was edited or an earlier reader saw a different render (§12: the
   file id is what changes when a render catches up). Recorded anyway, because a row hidden by an
   inline style is the kind of thing a later reader copies without noticing.

And one thing about all four that is portability rather than a defect: they carry Material Symbols
and a raw Tailwind CDN config. The panel uses `lucide-react` and `panel/src/tokens.css`, and the
design's `rounded` is Tailwind v4's `rounded-sm` (§1's radius rename).

### The shell and the two cards

The header is `PageHeader`'s two rows unchanged (§3): the breadcrumb, then the describing line on the
left and **two badges** on the right over the `border-b-2` rule — the **size** badge leading, then
the count, then the view toggle (amended in place, #165 put the toggle beside one badge, #261 put
the size badge in front of it; both are below). The content area is
**the content box's full width** — it carried `max-w-(--container-max)` until #240, and takes the
width `<main>` gives it since (§4) — holding a tree `<aside>` beside a contents `<section>` that
**share the row 0.4 / 0.6** (#172, below), both
`bg-surface-container border-2 border-outline-variant rounded-lg` with a `bg-surface-container-high`
header strip.

**Every state below is a state of this one screen**, exactly as §7 requires of the Devices screen.
The breadcrumb, the describing line and the header row's shape are the same in all of them; **the
two badges are the only things in the header that come and go, and each goes for its own reason**
(corrected in place, #261 — it was *the badge is the only thing*, said while there was one). The
count badge **goes rather than reading `0`**, because a level that is empty or unreadable is not a
set of none. The size badge goes while the answer is still out and where there is nothing at the
address to have a size, on the same terms and for the same reason: an invented `0 B` is a claim
about an empty directory. The toggle is the one thing in that row that is always there, and it sits
**last** so a badge appearing moves neither it nor the count a reader is reading — which is why the
size badge, the later arrival, leads on the left.

### The size badge — settled here, not designed (#259, #261, #262)

**The second badge says how much disk the selection takes, as a full capitalised sentence naming its
own scope**: `All tests take 7.7 MB on disk` at the root, down to `This file takes 411 KB on disk`.
A sentence rather than a labelled figure, because it sits beside a badge that already reads
`N tests archived` and a bare `7.7 MB` in that row would be a measure of *something* — the level,
the selection, the whole archive — with nothing on the screen saying which. The scope is the whole
point of the number, so it is in the words.

**It is the header's fact about the whole selection, and the only measure on the screen.** #161 took
the `CONTENTS` card out, which was where a size and a child count were said, and the tree that
replaced it has never drawn either — a tree row carries a name and nothing else (below). So this is
not that measure coming back into a row: it is one fact about one address, in the row where a fact
about the whole selection belongs.

**Nine rows, and they are the whole of what it says** — for the `All` view. The groups view's own
three scopes are the table below it, added in place by #262; every depth of that view at a group and
below reuses a row of *this* table, because the address there is the archive's own once the group id
is dropped.

| the context | the badge |
| --- | --- |
| the root | `All tests take 7.7 MB on disk` |
| a project | `This project takes 7.7 MB on disk` |
| a test name | `This test takes 7.7 MB on disk` |
| a run | `This run takes 7.7 MB on disk` |
| a directory inside a run — the `<serial>`, and every folder below it | `This directory takes 7.7 MB on disk` |
| an artifact | `This file takes 411 KB on disk` |
| any of those six, from a walk that was cut short | `… takes **at least** 7.7 MB on disk` |
| any of those six, where the host could not take the size | `The host could not measure what this test takes on disk` |
| any of those six, while the answer is still out, or where nothing is at the address | **no badge** |

**And three rows for the groups view's own depths** (#262). Each describes the runs that named a
`group_id` and therefore a **subset** of the archive, which is why none of the three may say *all*:

| the context, in the groups view | the badge |
| --- | --- |
| the root | `Grouped tests take 7.7 MB on disk` |
| a project | `Grouped tests in this project take 7.7 MB on disk` |
| a group | `Tests in this group take 7.7 MB on disk` |
| a test name, a run, the `<serial>`, a folder, an artifact | the table above, unchanged |

**The first two wordings are decided here and are open to correction.** They are the two cells the
operator did not specify. *Grouped tests* and *Grouped tests in this project* say what they say
because this view lists only the runs that named a `group_id`: `All tests` would be a claim about
the whole archive made over a subset of it, and *This project* would be the `All` view's own
sentence about a figure that is not the `All` view's number. The three sentence *forms* are the
table above's, so the truncated and unmeasurable variants of all three come for free.

**The truncation rule: a bounded walk renders a lower bound or nothing, and never a plain figure.**
`truncated` on the host's answer means at least one directory that exists was not fully examined, so
the number is short — the depth bound does it, and so does a level the host could not read mid-walk
(`PROJECT.md` R49). *At least* is the only honest way to draw it, and it is the same rule the tree
keeps one line above a set of rows a bounded walk was short of.

**An unmeasurable size gets a sentence of its own, and never the word `unknown`.** `unknown` is what
a *field* says where the host has no fact — `SIZE` reading it beside a label that already says what
is missing. This badge has no label, so `unknown` in the value slot would be a sentence with a hole
in it. `file-size.ts`'s `UNKNOWN` is deliberately unused here, which `size-sentence.ts`'s own header
records.

**A measured `0 B` is drawn and *nothing there* is not**, which is the pair D6 forbids rendering
alike, over the other kind of number. A readable directory holding nothing took no disk and the host
said so; an address with nothing at it has no size to state. That is why the host answers three
outcomes rather than a nullable number, and why the badge renders all three differently.

**Two of the states with nothing to browse now carry it, and the table below is amended in place for
that** (#261). The size answer and the listing are two independent host answers about one address:
an archive root the host cannot read is `ARCHIVE NOT READABLE` in the content area **and** *the host
could not measure what all tests take on disk* in the header, which is one fact stated in each
row's own words rather than a contradiction. Where nothing is filed at all there is nothing to
measure, so that state stays bare.

**The decimal separator is a dot on every machine.** `formatBytes` is the only formatter and nothing
in the badge calls `toLocaleString` — the fixed-format rule #223 settled, kept by importing the one
function that already obeys it. The lower-case subject in the *could not measure* sentence is
carried in the table rather than folded at render, for the same reason: a `toLowerCase()` follows
the viewer's locale, and nine words are cheaper to write out than one more fold to reason about.

**One pill, drawn by three badges** (amended in place, #260 — it was *by both badges*, said while
the two in this row were all of them). `header-badge.tsx` owns the treatment — `rounded-sm border-2
border-outline-variant bg-surface-container`, `px-3 py-1`, twelve pixels in the code face — and the
view toggle composes its own frame from the same exported constant, since it needs the frame without
the padding. No new colour and no new measure: every value was already in `archive.tsx` before this
badge existed, which is what a second badge in a row no approved screen shows is allowed to cost
(§1, §11's third list).

**And the `archive` row of the table above is drawn on a second screen** (#260). The System screen's
`ARCHIVE SETTINGS` card says what the whole archive takes in its own header strip, which is this
badge's root scope over the same walk of the same directory — so it takes `sizeSentence`'s words
rather than writing a second sentence for one number (§13). That is also why the root's `All` is
not shortened away: it is what holds this table's first row apart from the groups view's
`Grouped tests take …` below it, and the shorter `Tests take …` proposed for that card lost to it
on exactly that ground.

**One request per scope, nothing summed in the browser, and the deepest context is free.** The host
walks the address once and the answer is cached for the life of the screen (*Routing, and no
polling*, below). Adding the levels the tree happens to have listed would produce a figure that grew
as a reader browsed and was wrong at every point before the last — and an **artifact** costs no
request at all, because `list_archive` already carries a `sizeBytes` for every file it lists and the
parent level is the thing that classified the address in the first place.

**That holds for a group too, and it is the same rule rather than an exception** (#262). A group's
runs are on the grouping answer and summing them would be one `reduce` away — and it is exactly the
pre-walk *lazily, one `readdir` at a time* exists to prevent, with no sizes on that answer to reduce
in any case. So a group's badge is **one** call to a second host method, `measure_archive_groups`,
which walks the runs that named a `group_id` at one of three scopes; the panel keeps one cache
across both methods, so navigating from a group down to a run and back again re-asks for neither.

### The two views — settled here, not designed (#165, #181)

The screen has **two views**, and everything else in §9 describes the first of them:

| Segment | What it draws |
| --- | --- |
| `All` | the file explorer — the tree beside one card, at every depth. Unchanged in every particular |
| `Testing groups` | the same archive arranged by the `group_id` a lease named (`PROJECT.md` R41): project, then the group id, then the standard arrangement under it. **Built** (#181), on the host's `list_archive_groups` (#178), with the label badges inside it built too (#182, the alphabet #197, the per-cycle steps #200) |

**No approved Stitch screen shows this control**, and none was commissioned for it (§1, §11's third
list). So nothing about it is invented: the frame is the header badge's own — `rounded-sm border-2
border-outline-variant bg-surface-container`, with the padding moved onto each segment so the two
divide one block rather than sitting as two chips — the current segment carries the breadcrumb's
*you are here* green over the card header strip's `bg-surface-container-high`, and the other carries
the breadcrumb's inactive link treatment. Twelve pixels in the code face, matching the badge.
Deliberately **not** the active nav item's filled `bg-tertiary-container`: this is furniture in a
header row, and §5 keeps the emphasis on the data. That is what keeps the deviation small enough to
reconcile in one edit once a design for it exists.

**It is text and nothing else.** No glyph on either segment — neither arrangement has a symbol that
says more than its name — and the two sit in a `<fieldset>` named *Archive view*.

**They are links, and that reverses #165's own sentence in place** (#181). They were `<button>`s
carrying `aria-pressed`, *because the toggle changes what the screen draws and never where you are*
— which was true exactly as long as the second arrangement had no addresses. It has them now, so the
view **is** where you are: each segment is a `<Link>` to its view's root and `aria-current` says
which one you are on, the same word the breadcrumb and the nav item already use. Each links to the
**root** of its view and never to the address you are standing on translated into the other one: the
two arrangements share no vocabulary below the project — one has a group id where the other has a
test name — so *the same place in the other view* is a claim neither can make honestly.

**The count badge still comes and goes beside it, and is absent throughout the groups view** — the
same rule that makes it absent at a run, with its reason rewritten now that the view lists something
(#181; *the badge* became *the count badge* in place when a second one landed, #261). That view is
one **bounded** walk of the archive, so what it holds at any level is what the host could examine
rather than what is filed; a badge over it would read as a count of a set and
could be short without saying so. Where the shortfall matters it is said where the reader is
looking at the rows it is short of — one line above them in the tree — and not as a number in the
header that would need the same caveat beside it. **The size badge *is* drawn there, at every
depth** (corrected in place, #262 — this said *absent there too, and that is a deferral rather than
a rule*, and the deferral has been settled). The two are not inconsistent, and the difference is
the whole reason one can be drawn where the other cannot: a bounded walk **cannot** be honestly
rendered as a count of a set, and it **can** be rendered as a lower bound, which is exactly what
`truncated` is for. A grouped total whose walk hit a bound says *at least*; a count that was short
would have nothing to say it with. The toggle itself is always there, so the header row's shape is
still the same in every state.

**And the choice is in the URL, which is the question #165 deliberately left open.** It recorded
that the groups arrangement had *no addresses of its own yet … Whoever builds the arrangement
settles that question with content in front of them*, and this is that. Two things follow, and both
are the point:

- **The selection is an address in either view**, which is what §9 asks of the `All` view's: a
  reload lands where you were and a shared link lands on it. So the `viewChosenAt` / `setView`
  machinery goes, and with it the rule that any navigation ended the second view — a reset that was
  standing in for an address, and that a real one does not need.
- **Switching views is a navigation, so it is no longer a return.** #165 recorded that every hook
  stayed mounted and `All` therefore cost no request; the two views are two route families now, so
  moving between them remounts the screen and its levels are read again. That is the price of the
  address and it was worth paying: a view you cannot link to or reload onto is not a place.

### The group-first arrangement — settled here, not designed (#181)

**Settled in this document rather than by a Stitch round**, and which of the two was chosen is said
out loud because §1 requires it: this is §11's third-list test. The row anatomy, the card, the
shell, the split and the empty states are all already settled above, so a design round would
re-derive what §9 fixes and would settle only the level vocabulary — which is a table, not a screen.
The alternative was a commissioned screen; if anyone would still rather have one, the deliverable is
a ready-to-paste prompt and never a generated screen (`ai/RULES.md` §8).

The host method behind it is **`list_archive_groups`** (#178), the archive's third read: it takes no
parameter and answers, from **one** bounded walk, which `(project, groupId)` pairs exist, which runs
are in each as the components `list_archive` would name them, and which of a grouped run's artifacts
carry a label. So the whole arrangement above a run is **one request**, and no level of it is
listed.

| depth | the level | a row is |
| --- | --- | --- |
| 0 | the root | a project that has at least one grouped run |
| 1 | a project | a `groupId` a lease under it named |
| 2 | a group | a test name a run in that group was filed under |
| 3 | a test name in a group | a run, most recent first |
| 4 | a run | not a tree level — hopped, never descended into, exactly as in the `All` view |
| 5 and below | inside the run | **any entry**, whatever its `kind` — the `All` view's own levels |

- **It is one tree component, one row anatomy and one card** (#160). `directory-tree.tsx` reads its
  rows from a **source** (`panel/src/archive/tree-source.ts`) rather than from `ArchiveLevels`
  directly: a source answers *the rows at this node*, *the level a row opens* and *the route a row's
  address is on*, and nothing else about a tree is a view's to choose. Every rule above — what a row
  may never carry, an open set over the selection's own ancestors, a click on an open row closing it
  (#175, #198), `aria-expanded`, the glyphs, `break-words` — is shared and unconditional, so
  branches accumulate open in the groups view because they accumulate in *the* tree and not because
  that view chose it. **A second tree implementation is the failure mode**, and the source is what
  makes it unrepresentable rather than merely avoided.
- **Below the group the arrangement is the standard one and unchanged.** At and below a run's
  `<serial>` the groups source delegates to the `All` source, so those rows are the same rows listed
  by the same method at the same address; only the splat they link to differs.
- **A run's `<serial>` comes off the answer rather than off a listing's `onlyChild`.** It is still
  not a level of the tree and it is still in every address below the run; what differs is that this
  view does not have to read the level above a run to learn it.
- **The runs are most recent first, and one helper decides that for all four panes.**
  `panel/src/archive/level-order.ts` reverses at the run level for the tree and for the card in
  both views; `group-tree.ts` answers in the host's own order and holds no opinion about the
  direction.
- **The card beside the tree is the same card.** At the group-only depths it is `LevelContents` fed
  from the answer, given the **archive's** depth rather than the address's, so a group's test names
  carry `RUNS` exactly as a project's do and a group's runs carry `OWNER` / `GRANTED` exactly as a
  test name's do. At the run and below it is exactly what it is in the `All` view.
- **`RUNS` here counts the runs the answer holds** for that row. It is the one measure this view has
  that costs no second request, and it is the same `childCount` column the `All` view draws.
- **The tree card's search field is here too, over this arrangement's own runs** (#207, reversed in
  place). It was absent, and the reason was: *`search_archive` answers addresses of the archive,
  which this arrangement does not own, so a hit found from here would have nowhere in it to land.
  **Searching is the file explorer's question.*** That argument was about **addresses**, and an
  address composes: `archiveAddressOf` drops the group id on the way down and `groupsAddressOf`
  (`panel/src/archive/archive-path.ts`) puts it back on the way up, so a match under a grouped run
  has an address here after all. And this is the view where the work happens — the comparison card
  and the label badges are drawn in it and nowhere else — so finding one screen in a group filing
  nine labels across two arms was browsing, every time, while the `All` view beside it could find it
  by typing. What the old reason was right about is what this keeps: **only what this arrangement can
  address is drawn.**
  - **The same field, in the same place, behaving the same way**: between the header strip and the
    scrolling tree, the same 300 ms debounce, one request per settled text, superseded answers
    dropped, empty text asking nothing and returning the tree to the address's own levels. The only
    difference is the population it searches and the addresses it lands on.
  - **The population is the runs that carry a group id.** A match at or below such a run is a hit; a
    match on a run that named no group is not, and a match shallower than a run is not addressable
    here at all — a test name lives under any number of groups, so *which group* has no honest answer
    for it. A project with no grouped run is therefore never drawn, which is what this view already
    does when browsing. The levels above a hit are the grouping's, and they come free: the searched
    tree is built from the matches themselves, so re-addressing them first is the whole of it.
  - **It is composed panel-side out of the two answers the view already holds**
    (`panel/src/archive/group-search.ts`), because the groups view already fetches
    `list_archive_groups` for the tree it draws. No `groupsOnly` key on `search_archive` — a
    caller-settable bound is precisely the parameter D24 refused — no second method, nothing on the
    wire, and no index (D23/D24's untouched half).
  - **`truncated` is the OR of the two bounded walks.** It keeps its one meaning — at least one
    directory that exists was not fully examined — now across both answers this is assembled from, so
    either being short sets it. That is what stops the definitive negative being said about a search
    either walk cut short, and it is why a hit whose run fell out of a truncated grouping answer does
    not vanish silently. One flag rather than two: both causes lead to the same claim, *this answer is
    short*, and what differs is the sentence.
  - **The sentences that claim a population are this view's**, and they narrow rather than inventing a
    fourth state — the precedent this section already sets one level up, where a truncated grouping
    answer narrows *No testing groups*'s claim clause. *No name under a testing group contains that
    text.* becomes *Nothing in the part of the testing groups that could be examined contains that
    text.*, and a cut-short **hit list** says the arrangement's own *More is filed here than the host
    could examine. A group or a run may be missing.* — the sentence the browsing rows already use,
    defined once — rather than *Narrow the text*, which is advice that would not help when the
    grouping walk is what was short. *Searching this host's archive.* and *The host could not search
    the archive.* are unchanged in both views: the first says what the panel is doing, and the second
    is true of every one of its causes, an unreadable grouping walk included.
  - **The stated cost.** `search_archive` walks the whole archive and caps matches at 200, so some of
    that cap is spent here on matches under ungrouped runs that are then dropped: a host with many
    ungrouped runs reaches `truncated` sooner in this view than in the `All` view. A host-side method
    answering one bounded walk with the group already in the address is the recorded alternative, at
    the cost of a method and the doc round with it; it was considered and is deliberately not built.
  - **The `All` view is untouched** — same field, same population, same addresses — and the field is
    still absent in every state that draws no tree, because it is part of the card and the two
    empty-handed states draw none.
- **A truncated answer says so, above the rows**, exactly as the searched tree says it: *More is
  filed here than the host could examine. A group or a run may be missing.* `truncated` means one
  thing — at least one directory that exists was not fully examined — and a partial arrangement must
  not read like a complete one.
- **The label badges are drawn here and nowhere else** (#182, and the section below). An artifact a
  run filed under a label carries a small numbered pill beside its name; a badge number is defined
  only inside a group, so no row of the `All` view has one and no row above a run has one in either
  view.

**The addresses.** Two more routes, `/groups` and `/groups/$`, served by the same screen component
with `view` as a prop — so nothing here is a second screen. The splat is
`<project>/<groupId>/<testName>/<run>/<serial>/<…>`, and every read below the group composes the
archive's own path from it by **dropping the component at index 1**: the group id is not a
directory. One helper knows that, `archiveAddressOf` in `panel/src/archive/archive-path.ts`, beside
`componentsFromSplat` — so the `list_archive` levels inside a run, the run's two files and an open
artifact's bytes all take the archive's one path vocabulary and no call site filters a group id out
for itself.

Two shapes were checked and rejected:

- **`/archive/groups/$`** — a project literally named `groups` would be shadowed by it in the `All`
  view. A component is opaque (D22), so that is a silent bug rather than an unlikely one.
- **`?view=groups&group=<id>`** — two carriers of one piece of state, and the breadcrumb would have
  to thread both.

The sidebar's `Archive` item is current on `/groups` as well as on `/archive`, widened in place
rather than by adding a nav item: the panel has **one** Archive destination and two arrangements of
it, and the screen's own toggle is already the way between them.

**The breadcrumb is the same trail with the group id in it**, on this view's own routes:
`Archive > checkout-app > app-bar-top-space > home_a_variant > …`. Its first segment is still
*Archive* and goes to the root of the view you are in, so a breadcrumb never moves a reader between
the two arrangements — that is the toggle's job and it is the one control that does it.

**What is deliberately absent, and why.**

- **A run that named no group is not drawn**, and **a project with no grouped runs is not drawn
  either.** This view answers *what groups exist*; the `All` view still lists every run, so nothing
  becomes unreachable by being absent here. The root's describing line says *grouped* out loud —
  *Projects with runs filed under a testing group on this host.* — because that is the one thing
  about this view a reader could otherwise get wrong.
- **There is no *ungrouped* bucket.** Inventing one would file a run under a name no lease chose,
  which is exactly the claim D22 and #129 refuse.
- **Nothing compares, diffs or scores anything** (`ai/RULES.md` §1). A group is a set of runs a
  caller said belong together; what to make of them is the agent's judgement and not Rover's.

**The three empty-handed answers stay three** (D6), and no two render alike:

| The grouping walk's answer | What renders |
| --- | --- |
| nothing yet | one quiet line — *Reading the testing groups on this host's archive.* — `aria-live="polite"`, **no spinner** (§5) |
| no group on this host, or nothing archived at all | `QuietPanel` — **No testing groups**, saying what would change it — `rover acquire --group-id`, in the monospace face §10's *no projects registered* already puts a command in — and that every run is still listed in the `All` view. No badge, **no tree card** |
| the host could not read the archive | the same `ARCHIVE NOT READABLE` banner the `All` view draws, because it is the same fact about the same archive |

*Nothing has ever been archived here* folds into *no testing groups*, which is `archive-levels.ts`'s
own fold one level up: to a reader standing in this view there is no group either way, and what
would change it is the same thing. `archive.test.tsx` asserts that no two of the three share a
phrase, the way it already does for the `All` view's pair.

**A walk that was cut short does not get the definitive sentence** (corrected in place, #189
review). The middle row is one state with two claims in it, not two states: the host sets
`truncated` when a directory that exists was not fully examined — a `group_id.json` that is not
JSON, a subtree it could not read, a bound reached — and it can do that having recorded no group at
all. *Nothing filed on this host has named a group* would then be a definitive negative about a
walk that never finished, so the flag is carried on the empty answer (`archive-groups.ts`) and the
panel changes the claim clause instead: **more is filed here than the host could examine, no group
was named in the part it could, and a grouped run may be missing from this view.** The heading, the
`rover acquire --group-id` instruction and the pointer at the `All` view are the same in both,
because they are true in both; only the claim narrows. This is `Searched`'s rule in
`directory-tree.tsx` applied one level up — the same screen already refuses to say *no name in the
archive contains that text* about a search that was cut short — and it is why a truncated grouping
answer is not a fourth empty-handed state.

### The label badges — settled here, not designed (#182, amended in place by #197, #200 and #206)

**Settled in this document rather than by a Stitch round**, and which of the two was chosen is said
out loud because §1 requires it — the same call the arrangement above it is: the row anatomy and the
card are already fixed, so a design round would have settled a four-colour palette out of a system
this document can read directly, and `ai/RULES.md` §8 is explicit that an agent's deliverable there
is a prompt rather than a generated screen.

A run's artifacts may carry a **label**, filed with the artifact by the lease that produced it
(R41). A group is where that matters: the same label on an artifact of two runs is the caller
saying *these two are the same thing at two moments*. What the tree draws for it is a short number.

**The badge.** A small filled pill — `rounded-full`, **18px tall and as wide as its digits need**,
the design's own `label-caps` step in the monospace face — sitting **between the row's glyph and its
name**. That is the whole of the row's change: nothing else about a row moves, and a row without a
badge is the row it was.

**The height is fixed and the width is not** (#206). 18px against the row's 14px monospace line is
what keeps a badged row the height of an unbadged one, so a level of the tree does not jump where a
label starts — the property `size-4.5` was chosen for. What `size-4.5` *also* fixed was the width,
and `#12` does not fit an 18px circle; so the pill grows horizontally on the design's own spacing
step (`px-1.5`) and `rounded-full` keeps it a pill at every width rather than becoming a rectangle.
The height and the smallest type step are what hold.

**The numbers are per group.** Every distinct filed label in one group takes the next integer
starting at **1** — `1`, `2`, `3`, … — in the order the host answered them, and **the same label
carries the same number everywhere it appears in that group**. Nothing about a number is stable
across groups: the same string in a second group takes whatever that group's own order gives it, and
a reader who carries a number from one group to another has read something the badge never said.
Inside one group it is completely determined, which is a different claim and a load-bearing one — a
number that moved between two loads of the same group would be a bug. The order is the **answer's**,
never the drawn one: the tree and the card reverse at the run level (`level-order.ts`), so an
assignment that followed what is drawn would give one group two numberings.

**There is no overflow value, because there is no ceiling** (#206). `@` is gone and nothing stands
in for it. An integer has no last value, so no group can file a label the badge leaves
undistinguished, and the fallback is not kept for a case that can no longer arise. What is
unbounded is the **glyph**; the palette keeps a ceiling of its own, below.

**Why per group, now that nothing runs out.** #182 and #197 both justified the locality with *the
alphabet ends at `Z`* — a stable-everywhere letter would run out globally instead of per group. That
argument is gone with the alphabet, and the honest one that remains is about the answer rather than
the glyph: a number stable across the whole archive would have to come from a registry over every
label anywhere, and the only answer there is is **one bounded walk that says when it was cut short**
(`list_archive_groups`, `truncated`). A global number would therefore change under a reader when
the walk stopped a directory earlier. A number that never claimed to travel is the smaller promise
and the one that can be kept.

**A badge must not read as the artifact's own sequence number** (#206). Archived artifacts lead with
a zero-padded ordinal inside their file names — `002_remaining-deliveries_screenshot.png`,
`009_transferred-to-courier_screenshot.png` — so a bare `2` beside a row named `007_…` invites
exactly the wrong reading. Three things separate them and the first is decisive: **the badge carries
a leading `#`**, which a file's ordinal never does; it is a filled pill rather than text inside the
row's name; and it is never zero-padded. `#` is the number sign — *this is label number two* — and
was chosen over the bare digit for precisely that: it reads as a code and costs one glyph in a pill
that had to grow anyway. It is **not** an ordinal or a place. Nothing here is compared, so no number
can be a rank, a score or an order of merit (§2, `ai/RULES.md` §1); `1` is a code for a label, not a
first place. The number is also deliberately absent from what a screen reader says, which is where
`#1` and `001_…` would otherwise be confusable by ear.

**The number carries the meaning, never the colour alone.** Every badge says which label it is in
text, so the fill is a second channel for something already written — the rule §5's status LED keeps
from the other side, where the colour is the only channel and the LED is therefore `aria-hidden`.
This one is not: a number is a code local to one group, so the **filed** label travels with it in an
accessible name and in a `title`. It is the label as the archive filed it and never the caller's own
string, which `pathSegment` truncated and rewrote and which is genuinely unrecoverable — the rule
this section already states for `OWNER`.

**An artifact with no label carries no badge**, so the tree of an archive that never used labels is
the tree it is today. And the badge is **not a control**: the row is one `<Link>` and stays one
target (#175), so this is an element inside it and never a second thing to click.

**The palette — four colours, cycled, and a step off each on every cycle.** A badge's fill is its
number's position modulo four, so the four families take the numbers family-first:

| numbers | family | cycle 1's fill | cycle 1's text | reads as |
| --- | --- | --- | --- | --- |
| `1`, `5`, `9`, `13`, `17`, `21`, `25` | primary | `bg-primary-fixed` | `text-on-primary-fixed` | pale lavender |
| `2`, `6`, `10`, `14`, `18`, `22`, `26` | secondary | `bg-secondary-fixed` | `text-on-secondary-fixed` | pale peach |
| `3`, `7`, `11`, `15`, `19`, `23`, `27` | tertiary | `bg-tertiary-fixed` | `text-on-tertiary-fixed` | mint |
| `4`, `8`, `12`, `16`, `20`, `24`, `28` | neutral | `bg-inverse-surface` | `text-inverse-on-surface` | neutral |

That table is **cycle 1**, which is `#1`…`#4` and is byte-identical to what #182 shipped. Every
later cycle is the *same four families a step deeper into each family's own dark step* (#200), so
`#5` is `#1`'s lavender at another level rather than a repeat of it. A step is
`color-mix(in srgb, var(--color-<family>-fixed) <n>%, var(--color-on-<family>-fixed-variant))` in
`panel/src/index.css` — the same file's `.scanline` and `.wordmark-chroma` are the precedent — and
the component writes only a family and a cycle: `label-badge-step label-badge-<family>
label-badge-cycle-<n>`.

**`bg-surface-container-highest` was `@`'s row in that table and is now unspent.** It was the one
fill that inverted — a dark fill a shade off the card, carrying the light text the tree's quiet
lines use — and that was deliberate: it distinguished nothing and should not have asked to be
looked at. There is nothing left that distinguishes nothing, so the row is removed rather than kept
for a fifth case.

**The colour ramp keeps its own ceiling, and the number is what disambiguates past it** (#206). The
numbers are unbounded; four families across seven honest steps is **twenty-eight** fills and no
more. Beyond the last cycle the colour therefore **repeats** rather than a new step being invented:
`#29` draws `#1`'s fill, `#30` draws `#2`'s, and so on. Two badges far apart may share a fill; their
digits differ, and the digit is the identity. No new colour is invented at the keyboard and no
`error` step is reached (`ai/RULES.md` §8). `PALETTE_CYCLES` in `label-badge.tsx` is that ceiling
written down as a constant rather than left implicit in a modulo, and
`tests/unit/panel/label-badge-palette.test.ts` reads it back out of the component and fails if
`index.css` stops defining exactly that many cycles. **A cycle 8 is not a number to raise there**
but four new steps somebody has to measure against the colours below.

**The numbers are the design decision, so here they are.** Each column is the mix percentage of the
family's own light token and the byte-rounded result; each ramp's dark end is in the header:

| cycle | numbers | primary → `#0035be` | secondary → `#802a00` | tertiary → `#005236` | neutral → `#2f3034` |
| --- | --- | --- | --- | --- | --- |
| 1 | `#1`…`#4` | 100% `#dde1ff` | 100% `#ffdbce` | 100% `#47ffb8` | 100% `#e2e2e6` |
| 2 | `#5`…`#8` | 91% `#c9d2f9` | 91% `#f4cbbb` | 72% `#33cf94` | 94% `#d7d7db` |
| 3 | `#9`…`#12` | 82% `#b5c2f3` | 82% `#e8bba9` | 66% `#2fc48c` | 88% `#cdcdd1` |
| 4 | `#13`…`#16` | 73% `#a1b3ed` | 73% `#ddab96` | 60% `#2bba84` | 82% `#c2c2c6` |
| 5 | `#17`…`#20` | 64% `#8da3e8` | 64% `#d19b84` | 54% `#26af7c` | 76% `#b7b7bb` |
| 6 | `#21`…`#24` | 55% `#7a94e2` | 55% `#c68b71` | 48% `#22a574` | 70% `#acadb1` |
| 7 | `#25`…`#28` | 46% `#6684dc` | 46% `#ba7b5f` | 42% `#1e9b6d` | 64% `#a2a2a6` |

Mixing at 100% is the identity, which is what makes "cycle 1 is unchanged" a computation rather
than a claim: the first stop of every ramp *is* the token the utility class above draws. **The
sequence now ends on a whole cycle**, which the alphabet never did — `Z` was the secondary's
seventh step and the tertiary and neutral families stopped at six — so twenty-eight fills is four
families times seven steps exactly, and that is also the period the colour repeats on. Every hex in
that table is the mix rounded to the nearest byte, and each was cross-checked against lightningcss
(the engine the panel's own build runs) evaluating the same `color-mix()` call — so they are what a
colour picker on a rendered badge reports, not what an agent's own arithmetic hoped for.

**The four ramps do not reach equally far, because their constraints do not.** Primary and
secondary step an even 9% a cycle and the neutral an even 6%, but the neutral stops at 64% rather
than going as deep — that is where it is still ΔE 10.3 clear of `--color-outline`, §5's not-ready
grey, which sits *inside* a neutral lightness ramp and is what bounds it. And the tertiary's first
step is a jump to 72%, because `--color-tertiary` — §5's *free device* green — sits between
`--color-tertiary-fixed` and its own dark step: a 90% step lands ΔE 5.5 from it, so cycle 2 clears
it in one move and the rest step 6% a cycle. The neutral runs to
`--color-inverse-on-surface` rather than the `--color-outline-variant` that looks like its natural
dark end, and that too is the grey: *that* ramp passes within ΔE 4.4 of `--color-outline` at its own
midpoint, because both are blue-tinted greys on nearly one line.

**The text step never flips.** A fill dark enough for the family's light `-fixed` step to carry a
12px bold digit at 4.5:1 needs a relative luminance ≤ 0.131, and a fill that still reads as a
badge against the card's `surface-container` at 3:1 needs ≥ 0.143 — the two windows do not overlap,
so no ramp crosses into the dark half and every cycle of a family carries the one dark text step
cycle 1 pairs with it. That was computed rather than assumed; the achieved minima across all
twenty-eight fills are 4.81:1 for the digits and 4.59:1 against the card.

**Every colour comes from `panel/src/tokens.css`** (§1, `ai/RULES.md` §8), and
`tests/unit/panel/tokens-are-the-source-of-truth.test.ts` fails loudly on a hex written in a
component. All four are light fills carrying dark text, which is what makes them read at badge size
against `surface-container`.

**`-fixed-dim` looks like a free second cycle and is rejected, with the numbers**, because it is the
shortcut the next reader will reach for. `--color-tertiary-fixed-dim` is byte-identical to
`--color-tertiary`, §5's free-device green; `--color-primary-fixed-dim` is byte-identical to
`--color-primary`, the wordmark's own chroma step; and `--color-secondary-fixed-dim` (`#ffb59a`) is
ΔE 9.3 from `--color-error` (`#ffb4ab`), near enough to read as the error colour. Worse, the badge
test asserts the *class name* is not `bg-tertiary`, so `bg-tertiary-fixed-dim` would have passed
that gate while painting the free-device green onto a badge.

**Consecutive numbers never carry one colour**, and cycling family-first is what makes that true by
construction rather than by inspection: two numbers next to each other are always two different
accent families, and two steps of one family always sit exactly four numbers apart. **The cycle
boundary used to be the exception and no longer is.** `#4`'s `bg-inverse-surface` (`#e2e2e6`) beside
`#5`'s fill was ΔE 13.6 while `#5` was a plain repeat of `#1` — the one weak pair #197 had to
record, and every weak adjacency was one of these boundaries. `#5` is now a step off `#1`, which
puts that pair at ΔE 19.7 and makes it no longer the closest thing in the set to a collision. The
weakest adjacency anywhere is now 19.7, and **that now includes the wrap**: `#28`'s deepest neutral
beside `#29`'s cycle 1 lavender is the same kind of boundary and is measured as one.

**And all of that is checked rather than eyeballed.**
`tests/unit/panel/label-badge-palette.test.ts` reads the tokens and the percentages out of the two
CSS files, recomputes all twenty-eight fills by the byte arithmetic `in srgb` performs, and fails
on a contrast below either floor, on any derived fill within ΔE 10 of a colour that already means
something, on any pair of consecutive fills within ΔE 15, or on a cycle 1 that is no longer its own
token. Because the fills are periodic in twenty-eight, it walks `#1`…`#29` — one period plus one —
which is *every* consecutive pair an unbounded numbering can produce rather than every pair up to
some number somebody chose. Both thresholds are calibrated against colours already in the repository
rather than picked off a table: 10 is the margin cycle 1 already lives with (`tertiary-fixed` is 9.9
from the free green), and 15 is above the 13.6 a plain repeat gives.

**No badge colour may read as an outcome, and no number may read as a rank.** §5 already spends
`bg-tertiary` green on *a free device*, `bg-primary-container` blue on *held* and
`secondary-container` orange on *warning*, and `error` is not available at all — so every fill above
is a `-fixed` step, a neutral, or a derived step of one of those, none is one of the three §5 gives a
meaning to, and **no two of them can pair into a red/green verdict**. A green `#1` beside a red `#2`
is precisely the pass/fail semantics Rover does not have (§2, `ai/RULES.md` §1), and this palette is
chosen to make it unavailable rather than discouraged. The same rule reaches the digits now that
they are digits: nothing about a badge is sorted, scored or compared, `1` is *the first label this
group's walk met*, and the `#` is what says so.

**Why four colours, and why the glyphs are not counted at all** (reversed in place twice — #197
took the alphabet to `Z`, #206 dropped the alphabet; the original conclusions are kept because the
record of what was considered is most of this document's value).

*What #182 concluded.* Analog Horizon has three accent families plus `error`, and three of its steps
already mean something — so there is no honest fifth hue in it, four letters is what the palette can
honestly carry, and the arithmetic is the reason for `@` rather than an excuse for it. A longer
alphabet would be a **commissioned categorical ramp** for Analog Horizon, through the operator's own
Stitch round (§1, `ai/RULES.md` §8): swatches equal in weight, meaning *different* and never *better*
or *worse*.

*Why that was wrong.* The conclusion was about **colour** and was applied to **letters**. Nothing
makes those the same count: a letter is drawn in text and is the channel this section already says
carries the meaning, so a fifth letter costs the palette nothing at all. R41 enforces no arity on
labels either, and real use went straight past four — one label per screen, nine distinct labels in
one group (`statistics-deliveries`, a before/after of a Compose migration), so five of nine badges
read `@` and for most of that group the badge distinguished nothing. Four was an assumption about
arity the archive never made.

*What #197 replaced it with, and why that was still a ceiling.* The letters ran `A`…`Z` with the
same four colours cycled under them, family-first, and `@` moved to past the twenty-sixth distinct
label keeping its meaning exactly — *this one is not being distinguished*. No new colour, token or
CSS was needed. But the fix was the same shape as the flaw: twenty-six is a larger arbitrary number,
not a different kind of answer. The ceiling existed only because **an alphabet has a last letter**,
and nothing about the archive, the host's answer or the palette ever asked for one.

*What replaces both.* **The badges are numbers** (#206) — `1`, `2`, `3`, … in the host's answer
order, with no ceiling and no overflow value. An integer has no last value, so `@` is not moved
further out but deleted, and nothing a group can file is ever left undistinguished. The palette
keeps its ceiling because the palette's ceiling was always the real one: four families across seven
honest steps, and past the twenty-eighth the fill repeats while the digit distinguishes. Counting
the glyphs is the mistake this section made twice; there is now nothing to count.

*Why a bare digit was not enough, and what `#` buys.* Archived artifacts already lead with a
zero-padded ordinal in their file names, so `2` beside a row named `007_…` reads as a second copy of
the row's own number. The leading `#` is the one channel the file's ordinal never has, and in a pill
that already had to grow for `#12` it costs one glyph. `#1` was considered against exactly one
objection — that it could read as *first place* — and it does not: the frame is a set nothing
compares, the accessible name says *Filed under the label …* and never the number, and §2's rule
that Rover reports no verdicts is what the whole badge is built under.

*What survives all three, unchanged.* **No badge colour may read as an outcome.** `error` stays
excluded outright, §5's three device-state steps (tertiary green, primary-container blue,
secondary-container orange) stay unavailable, and no two badges can pair into a red/green verdict.
The commissioned-ramp rule also survives for what it was actually about: a **new hue** is the
operator's Stitch round and never a swatch picked at the keyboard — which is exactly why the numbers
wrap at cycle 7 instead of reaching for a twenty-ninth step. A *derived* step of a token is a
different thing — `panel/src/index.css` already derives from `--color-surface-container-lowest`,
`--color-primary` and `--color-secondary-container` through `color-mix` — which is why the per-cycle
modulation was a follow-up rather than a thing this section forbids. **That follow-up is built**
(#200): the four ramps and their twenty-eight stops are in the table above, every one of them a
`color-mix` over two tokens of one family, and no new hue was commissioned to do it.

**What is deliberately absent, and why.**

- **No badge in the `All` view.** A number is defined only inside a group and the `All` view has no
  group context, so a badge there would be a code with no key. It is said here rather than left to
  be discovered.
- **No legend.** A number and a hover that names it is the whole vocabulary; a legend would be a
  second, staler copy of what every badge already says.
- **No zero-padding on a badge, and no alignment to the widest one.** Padding `#1` to `#01` would
  make it look like the file ordinals it must not be confused with, and reserving the width of the
  group's largest number would put a variable indent on every row for a set most groups never
  reach.
- **No filter by label, no compare-these-two control, and nothing that ranks or scores an artifact**
  (`ai/RULES.md` §1). A label is a caller's claim that two artifacts are the same thing at two
  moments; what to make of them is the agent's judgement and not Rover's.

### The comparison card — settled here, not designed (#199)

**Settled in this document rather than by a Stitch round**, and which of the two was chosen is said
out loud because §1 requires it — but the call is a different one from the two above it, because
this card *has* a screen. `Compare — Visual Diff (V2)` (`897632dcadce44de9bdee74a94da14f5`) is the
one remaining uncorrected screen in the project (§11), and the operator decided **not** to run a
correction round for this work. So it is used as a **layout reference only**: the layout comes from
it and everything else from this section and the corrected Archive screens.

**What is taken from it**: a horizontal split of panes, each pane headed by a strip naming the arm it
is. Its per-pane run identity was taken and has since been given back — see *A pane's anatomy* below
for what stood there and why it does not any more.

**What is not, and none of it is reproduced**: the `SUCCESS` chip, the `PASS` log line, `COMPLETE`,
the green ticks and red crosses, the words *Visual Regression*, the `RUN A (BASELINE)` /
`RUN B (CURRENT)` vocabulary, the `HASH` and `BRANCH` rows, `SWAP`, `RESYNC SCROLL`, the second
navigation bar and its global `FORCE_RELEASE`, the mid-sidebar `Profile`, the per-arm orange/green
pane borders, the simulated phone status bar and the `object-cover` crop. §11 already lists most of
them; the last two are this section's own rules — the clean region, and *never stretched and never
cropped*.

**When it is drawn.** The groups view, an address inside a run that the parent listing says is a
file, a label the answer filed it under, and **two or more artifacts under that label in the same
`(project, groupId)`**. Everything else is the single preview, unchanged:

| the selection | the card |
| --- | --- |
| a labelled artifact, ≥ 2 artifacts under that label in the group | the comparison card |
| a labelled artifact, only one run in the group filed it | the preview — **one pane is not a comparison** |
| an artifact the answer filed under no label | the preview |
| any artifact in the **`All` view**, at any depth | the preview — that view's rows carry no label by construction |

So **an archive that never used labels sees no change at all**, and the `All` view is untouched.
`panel/src/archive/label-comparison.ts` is the whole of that decision — a pure function over the
same `list_archive_groups` answer the arrangement and the badges already come out of, unit-tested on
its own, with no second request, no second cache and no host change.

**One pane per labelled artifact, not per run** — which in the common case, one artifact per label
per run, is the same thing. Nothing enforces arity (R41), so an arm may file one label three times;
all three are panes, in the answer's own order and adjacent, because drawing the first of them would
drop evidence and invent a selection the archive never made (D22). Two panes of one run read as two
artifacts of that run — from the tree, which stands on the artifact, rather than from the pane heads,
which name the arm and not the run (*A pane's anatomy*). Two panes of one run therefore carry the
same arm's name, which is what they are: the same arm, twice.

**Oldest on the left, newest on the right — and this is the one exception to *most recent first* on
this screen.** The panes read left to right chronologically, so a before/after reads as a
before/after. The tree and every level listing keep most-recent-first, unchanged, and **both
directions live in `panel/src/archive/level-order.ts`** (`mostRecentFirst`, `oldestFirst`) so no
pane holds a second opinion about either.

**It is a sort rather than a reversal, and that is not a detail.** `list_archive_groups` walks a
group's test names in name order and each test name's runs chronologically inside it, and a group's
whole point is that its arms are *sibling test names* (`statistics-deliveries_variantA`,
`…_variantB`) — so the answer's order is not chronological across a group, and `mostRecentFirst`
reversed would have ordered the arms by name and only then by time. **Sorting is still not parsing**
(D22): the key is the run directory's own name in **code-unit** order, which is chronological by
construction for the reason this section already gives — a lease directory leads with a UTC
basic-format timestamp precisely so that it sorts chronologically as text
(`src/daemon/archive-path.ts`). No component is decomposed, no `Date` is constructed, and never
`localeCompare`, whose answer would depend on the reader's locale. The sort is stable, so two names
that compare equal keep the answer's order.

**Two is the common case and nothing caps N.** A group may hold seven runs (R41), so the row takes
however many panes the answer gives it. Each pane is `basis-0 grow` with a floor of `min-w-[240px]`;
past that the **row** scrolls inside the card, which is the other half of `ContentsCard`'s `min-w-0
overflow-hidden` and of the row beside the tree being two fractions that shrink into the gutter
(#172). **The page body must never scroll horizontally**, and does not.

**The floor was settled in a browser rather than derived**, as #172's fractions were. At 1280 the
card is 554px, 550px inside its border and 518px inside the row's own `p-4`, so two panes and one
`--gutter` have to come to that — and 260px did not: it overflowed by 22px and scrolled the common
case. Measured in headless Chrome on the built card at 900px tall, with a 1080x2400 portrait
screenshot in every pane:

| window | tree / card | 2 panes | 3, 7 and 9 panes |
| --- | --- | --- | --- |
| 1280 | 369.56 / 554.44 | 249.22px each, no scroll | 240px each, the row scrolls |
| 1440 | 433.58 / 650.42 | 297.20px each, no scroll | 240px each, the row scrolls |
| 1728 | 503.97 / 756.03 | 350.02px each, no scroll | 240px each, the row scrolls |

No horizontal page scroll at any of them, with two panes or with nine. The screenshot came out 415px
tall in a 240px pane and 569px in a 350px one, so inside a pane it is `max-w-full` that bounds it and
`max-h-[70vh]` only takes over once a pane is wide — the same 569px #140 measured for the single
preview.

**The label is what names the card**, in the card's own `CardHeading` under a `LABEL` caption in the
`Field` label's treatment. It is the label **as the archive filed it** and never the caller's own
string, which `pathSegment` truncated and rewrote irreversibly — the rule this section already states
for `OWNER`, and the one `group-labels.ts` states for the badge. Nothing else is in that strip: no
count, no glyph, no control.

**The badge is in that strip, in front of the name it belongs to, and it is drawn exactly once.** It
is the **tree's** badge — the same number on the same fill as the row that opened the card, its
number and its fill `numbersOfGroup`'s assignment carried down on `LabelComparison` so the card holds
no second opinion about which number a label takes. That is what ties the row a reader clicked to the
artifacts that came back. **In front of the label rather than instead of it**: the number is a code
local to one group and the words beside it are the thing that has a meaning. **Once rather than per
pane**: one label heads the whole card, so a badge on every pane would draw the same number N times
to say the one thing every pane already has in common. There is no legend, for the reason the badges
have none.

**A pane's anatomy**, top to bottom — **and its head is the arm's name and the control, nothing
else.** That is a reversal of what #199 shipped, made in place. The head carried the run directory's
own name as an `<h3>` and `TEST NAME`, `OWNER` and `GRANTED` as three stacked `Field`s, on the
reasoning that a pane has to say which run it is. Standing four text fields over every artifact is
what that cost: at the 240px floor the head was taller than the screenshot under it, the evidence the
card exists for was pushed below the fold, and the fields repeated down the row the parts a reader
was **not** comparing. The evidence is what the card is for, so the head gets out of its way.

Nothing that was removed is off the screen: the tree beside the card stands on the artifact, and the
run, its owner and its grant time are what `LevelContents` and `RunPanel` say at the depths that are
about a run. *Oldest on the left* is the card's own rule, decided by `level-order.ts` and stated
below — it was never something a reader was meant to verify by reading `GRANTED` off each pane in
turn, which is the one job `GRANTED` had here.

- the **arm's own name, as a phrase** — the `<h3>` the run name used to be, carrying what
  `TEST NAME` was on the pane for. Two panes of one comparison differ by exactly one thing, their
  test name, and a whole test name is the group's name and the arm's together:
  `statistics-deliveries_variantA` in `statistics-deliveries`. The group's half is the address the
  reader is already standing on, so the pane says the arm's half alone — **`Variant A`**, four of
  them across a row 240px wide, instead of the same prefix repeated four times. `break-words` and
  **never** a truncation: an ellipsis would hide the character two arms differ by, which is the one
  character the row exists to show.

  **A test name is the caller's own string and Rover never wrote it** (D22), so
  `panel/src/archive/variant-name.ts` is careful twice over and its two halves are separate for that
  reason. `run-identity.ts` stays the only place that decomposes a name **Rover wrote**.

  **`variantOf` reads as little of the name as will answer the question.** The group's own id comes
  off the front when the name starts with it and an underscore — and, failing that, the id's **name
  half**, the part in front of the `.` the host reserves for its minted suffix. Both are strings
  Rover holds, so the match is a fact rather than an assumed convention, and a group id with an
  underscore of its own comes off whole. **Amended for #205** (2026-09-07): the name half is the
  rule that carries this now, because the id filed is `<name>.<suffix>` and a test name is still the
  caller's own `<name>_variantA` — a whole minted id is never the front of one, so matching only the
  whole id would have left the investigation's own name on the head of every pane. The whole id is
  still tried first, because no archive written before #205 was rewritten and its group ids carry no
  suffix to split off. Nothing reads the suffix; the panel splits at the separator this repository
  owns and stops. Failing both, everything after the **first** underscore, never the last, because a
  variant may contain one. Failing that, the test name in full: a name with no separator
  names no arm, and the caller's own word is a better answer than an empty strip. Nothing is
  trimmed, lower-cased or normalised — what comes back is a slice of the caller's string, and that
  slice is what `ComparisonPane.variant` carries.

  **`variantPhrase` re-spaces and re-cases it for the head, and does nothing else.** `variantA`
  reads `Variant A`, `variant_b` reads `Variant B`, `login-flow` reads `Login Flow`. A head is read
  at a glance, and `variantA` beside `variantB` differs by one character in the least-looked-at
  position on the card — that is the whole of what the transform buys. What it may not do is the
  longer list: **every word that goes in comes out**, in order, spelled as the caller spelled it
  apart from its first character, which is only ever *raised* (`toUpperCase`, never
  `toLocaleUpperCase` — the answer must not depend on the reader's locale, the rule this screen
  already keeps for sorting). No word is translated, expanded from an abbreviation, abbreviated,
  reordered or dropped, and **nothing is appended**: an arm called `A` reads `A` and does not become
  `Variant A`, because the word *variant* would be this panel's and not the caller's. Word breaks
  are the caller's own separators and the transitions camel case is written in, so an initialism
  keeps its shape (`HTTPServer` → `HTTP Server`) and a numbered arm splits (`variant2` →
  `Variant 2`). A string with no word in it comes back exactly as it went in. **The raw string is on
  the `title`**, the same channel the label badge puts the filed label on and for the same reason:
  this is a re-rendering of the caller's text, and what was filed is a hover away.

  It stands where the artifact's own file name did, which the reference screen put in a bordered
  chip: within one comparison every pane is the same file of a different run, so the name was the
  same string N times across the row. The name is still on the tree row, in the body's `alt`, and
  one click away in the window the control opens;
- **`Open in a new window`**, the existing recessive control — **the glyph alone on a pane, and the
  glyph and its four words in the single preview.** A pane is floored at 240px and there are N of
  them in one row, so the words were the widest thing in a head that now holds only the arm's name
  beside them; the preview beside the tree has a whole card's width for its strip and keeps them. The name
  does not change with the shape: it moves out of the text and into `aria-label` and `title`, so it
  is the same control to a screen reader and to a pointer resting on it. Everything else about it is
  unchanged — absent for `opaque`, no `download` attribute, a view rather than a transfer (§10). It
  is on the pane because selecting a labelled artifact in this view no longer draws the single
  preview, and a full-size look is the one thing §11 says the preview genuinely needs;
- then the **body**, which is whatever the host's own content type says the file is
  (`panel/src/archive/artifact-body.ts`), so a labelled recording and a labelled `read_logs` compare
  the way a screenshot does and `opaque` still creates no object URL and still says its one sentence.

**One body view, shared** (`panel/src/components/archive/artifact-body-view.tsx`, extracted out of
`artifact-preview.tsx` by this change with the DOM unchanged). *Three bodies share one frame* and
*there is not a second extension table in the panel* are exactly the rules a second copy of that
switch would break: a labelled recording drawn differently from an unlabelled one is the failure, and
it would not look like one until somebody labelled a recording.

**What this card must not do**, and every one of these is asserted:

- **no diff, no score, no verdict, no highlight of what changed.** The comparison is visual and
  human-judged (`docs/DESIGN_INITIAL_PROMPT.md` §4): Rover puts the artifacts next to each other and
  the person decides, because judging is the agent's job (`ai/RULES.md` §1);
- **nothing that reads as an outcome** — no `PASS`/`SUCCESS`/`COMPLETE` chip, no tick, no cross, no
  red/green pairing, and not the words *Visual Regression* (§2, §5);
- **no `BASELINE` / `CURRENT` framing.** Neither arm is authoritative; Rover has no baseline. The
  panes are one treatment, so no arm is framed in a colour the other is not — which is also why the
  reference screen's orange/green pane borders are not reproduced;
- **no fact Rover does not have** — no commit hash and no git branch. What the archive knows is the
  project, the test name, the run's own directory name, the device serial, `device_info.json` and the
  run's own `test_description.json`;
- **no second navigation, no global `FORCE_RELEASE`**, and the breadcrumb stays a path rather than a
  label, with the `<serial>` in no segment of it (§11's list);
- **no zoom, pan, rotate, filmstrip or next/previous, and no picker.** The tree is how another
  artifact is chosen (#160) and this card does not become a second explorer.

**No sync scroll, and no control for one** — decided explicitly rather than by default, because the
reference screen has a `RESYNC SCROLL` button and a control is a thing this card would otherwise not
have. An artifact contained at `70vh` has nothing to scroll, and a control that does nothing is worse
than none (§3). A text pane scrolls inside its own body, independently, exactly as the single
preview's does.

**Every colour is a token** (§1, `ai/RULES.md` §8) and there is no `@keyframes` and no `animate-*`
anywhere on it; `tests/unit/panel/tokens-are-the-source-of-truth.test.ts` and
`no-looping-animation.test.ts` stay green.

**The address is unchanged**, so a reload and a shared link land on this same card. There is no new
route, no new query parameter and no second navigation to reach it: it is one more thing the one card
beside the tree draws at an address the screen already had.

**Panel-only, and no host change.** `list_archive_groups` already answers, for each group, its runs
and each grouped run's labelled artifacts together with the filed label (`src/ipc/methods.ts`,
`panel/src/archive/archive-groups.ts`). No new method, no new sidecar, no archive-path change, and
nothing about what the archive writes moves — the property #178 and #182 both kept.

**Three costs, stated rather than hidden.**

- **N panes is N buffered artifacts.** An authenticated byte route cannot be an `<img src>` (below),
  so the whole of each artifact is buffered in the tab. Each pane is a component owning its own
  `useArchivedArtifact`, because that hook is one address per instance and hooks cannot be called in
  a variable-length loop — which is also what carries the object-URL lifecycle over verbatim rather
  than re-deriving it. Each pane is keyed on its artifact's own address, so a pane whose address
  changes is a new component and the URL it held is revoked by the unmount.
- **A deep link that outruns the grouping walk reads one artifact twice.** An address below the
  `<serial>` does not wait on the walk — this screen's own rule (`routes/archive.tsx`, `Content`) —
  so the single preview is drawn and reads the selected file, and the comparison replaces it when the
  walk answers, reading the panes. The ordinary path, a reader who opened the view and clicked down,
  has the answer long before an artifact is selected.
- **The selected artifact is read once when the comparison *is* drawn**, because the screen's own
  hook is gated on it. Without that gate the file would be read by the screen and again by its own
  pane.

### The tree — expansion is an open set, over the selection's own ancestors

**A node is expanded when it is in the *open set*, or when it is a strict ancestor of the selected
path.** The open set is what the reader has opened; the second clause is a floor under it, and
between them they are the whole of what the tree draws.

**This reverses #175's rule in place, and the reversal is #198's** (`ai/RULES.md` §1). Expansion was
derived *entirely* from the selection — *a node is expanded exactly when it is a prefix of the
selected path, and the selected node too*, with no stored state anywhere. One selection is one path,
so **only one branch could be open at a time**: opening a second top-level row closed the first, not
as a defect in the implementation but as that rule's exact consequence. A reader comparing two
projects, or two groups, lost the tree they had every time they crossed to the other one, and the
deeper the two branches the more of the gesture went on rebuilding what had been on screen a moment
earlier. **What the reversal did not surrender is the guarantee that rule was protecting**, which is
the third bullet below and the one thing here that must not regress.

**And a row's address is its own — shut or open, in both trees** (amended in place, #198). The
one-level-up destination that was the whole of collapsing in #175 is gone. A click on a row does two
things, at every depth: it **selects** that row, and it **toggles that row's branch**. So a click on
a shut row selects it and opens it, exactly as it always did; a second click on it selects it again
and closes it. Landing *on* the row is what makes the closing half work — the row stops being a
strict ancestor of the selection, the floor stops holding it open, and the open set's answer is what
the tree then draws. Nothing else changed: **a row that opens nothing gains nothing**, so a file, and
a run whose parent named no single child, still carry no triangle, no `aria-expanded` and no toggle.

**No depth is special-cased, in either direction.** A run's children are its `<serial>`'s entries
(the depth table below), and the open set is keyed by the **row's** address, so the hop the tree makes
on the way down needs no matching hop on the way up: an open directory inside a run closes onto
itself like every other row. `directory-tree.tsx` still takes *the level this row opens* as a value
off the row rather than as arithmetic on a depth, and the recursion descends into that node — which
is what keeps every depth the same, and what #175 needed a second value for (*the node this level is
drawn under*, now gone with the destination it existed for). Closing a project therefore no longer
lands on `/archive`, the one address #175 had made the splat contract build
(`archive-path.test.tsx` still pins it, as the contract for the bare address).

Four requirements hold of this tree, and each of them is now a property of something rather than a
consequence of one rule — which is the price of the reversal and is why they are written out:

- *the tree expands lazily, one `readdir` at a time* — the levels read are the levels **drawn**,
  walked from the root through expanded rows only and stopping at the first level nothing has
  answered for yet (`panel/src/archive/tree-source.ts`, `drawnLevels`). **The open set grows only by
  a click, or by an address the reader navigated to**, so the number of levels read is bounded by the
  reader's gestures and never by what is in the archive: a newly opened row costs exactly one
  `list_archive`, a shut branch costs none, and a pre-walk is still unrepresentable. **What the set
  absorbs from the floor reads nothing either** — every level it takes over is one the floor was
  already drawing, so it has already been asked for. **Closing a node reads nothing.** The
  selection's own prefixes
  are named from the address as well, which is not a second source of truth — every one of them is an
  ancestor the floor draws — but it is what keeps a deep link one parallel batch of requests instead
  of one round trip per level;
- *a reload lands where you were and a link is shareable* — **where you are is the address, and this
  screen now has two pieces of state that are deliberately not in it**: the tree card's search text
  (#146) and **the open set itself** (#198, and this is the decision that issue asked to be recorded
  rather than left implicit). **The open set does not survive a reload.** It is component state, like
  the search text and on the same terms: a shared link lands on the *address*, without somebody
  else's search and without somebody else's browsing. What stands in for it is the **seed** — a fresh
  mount opens every prefix of the address it landed on, including the selection, so a reload and a
  shared link draw exactly the tree the derived rule drew, and the reader's own accumulation starts
  from there. Putting it in the URL was refused for the reason the search text was: the address
  carries *where you are*, and a second reader's list of open folders is not that;
- **the selection is always drawn in the tree** — this is the one the reversal had to be careful
  with, and it is a property of the **floor**. Every strict ancestor of the selection is expanded
  whatever the open set holds, so *the selected node is hidden beneath a collapsed ancestor while the
  card beside it still draws that node's contents* is unreachable rather than merely avoided. It
  cannot be reached by a click, because a click's destination is the row it toggles and that row is
  drawn; nor by a deep link, a breadcrumb, the back button or a search hit, because those move the
  selection and the floor follows it. That state is what the tree stands beside an open file to
  prevent (#160), and it is the whole reason the table below refused this change once;
- the tree and the address cannot disagree about *where you are*, because only the address says it.
  What the open set adds is *what else is on screen beside it* — which the address never claimed to
  carry, and the searched tree does not carry either, since every row in it is an address the host
  answered with.

**And the set absorbs the floor as the selection moves**, because *accumulating* is not the same as
*never resetting* (`open-branches.ts`, `absorbing`; #202 review). The floor is evaluated against
whatever the selection is **now**, so a branch standing on it alone — one reached by a search hit, a
breadcrumb, the back button or a link out of the card, rather than by clicking a row — would fall the
moment the selection left it, and the next click anywhere else would rebuild the tree the reader was
just reading. So every **strict** ancestor of a selection is written into the set the moment that
selection arrives: the floor is only ever *lifted* off levels the set has already taken over, and it
costs no request, because a level the floor was drawing has already been read. *Strict* does the same
work here as in the drawing rule, in both directions — it is all the floor was holding, and it is what
keeps closing working, since a close-click lands *on* the row it removed and no node is a strict
ancestor of itself.

**The seed is deliberately not that function.** A mount knows nothing but the address, so the derived
rule's whole answer for it — every prefix *including the selection* — is the honest seed; a selection
that moves is a different question, and by then the set holds the reader's own gestures. The one
visible consequence, stated here rather than left to be found: a directory reached **mid-session** by
a hit or a breadcrumb draws shut — its ancestors open, its own level left to a click, like any node
nobody opened — where the same address after a reload draws open. The card beside the tree draws that
directory's contents either way, so what differs is a triangle and not what is on screen.

**Collapsing is the row's, and what it collapses is tree state after all — the table #175 settled
against is rewritten rather than deleted.**

| | what it buys | what it costs |
| --- | --- | --- |
| **collapse by navigation** — an open row goes to the node above it (#175, superseded) | nothing is stored, so the tree is a pure function of the address | one branch open at a time: opening a node closes every other one, because one selection is one path. And collapsing **moves the selection to the parent**, so closing a project lands on the archive root |
| **collapse as tree state, unguarded** — a set of deliberately-closed nodes laid over the derived rule (refused, both times) | a node closes without the selection moving at all | it makes *the selection is drawn nowhere in the tree* reachable in one click, with the card still drawing the file underneath the closed ancestor — the inversion of what the tree is there for (#160) |
| **an open set with the selection's ancestors as a floor** (#198, built) | branches accumulate open at any depth, in both views, and nothing is rebuilt when the reader crosses between two of them — including a branch reached without clicking a row, because the set absorbs the floor as the selection moves | the open set is state, so it is a second thing that can be true of the screen — and it is not in the address, so it does not survive a reload |

**Why the third answer is not the second one.** The middle row's cost is a *closed set laid over a
derived rule*: closing is then something that can be true of an ancestor of the selection while the
selection stays where it is, and that is exactly the state #160 forbids. An **open** set with a floor
cannot express it — a node that is an ancestor of the selection is expanded by the floor, whatever
the set says, and the only way to close it is to land on it. The state that was refused is still
refused; what was added is the state above the selection's own branch, which #160 has no objection to.

**And its cost is paid in one place rather than everywhere.** The open set is not in the URL, so the
one thing it can disagree with is a *reload*, which resets it to the address's own branch — a
smaller, once-per-load surface than the class of bugs #175 was avoiding, and the same trade the
search text has been making since #146.

**The accepted cost that stands**: a folder cannot be peeked at without selecting it. The row is one
target and selecting is what it does, so opening one moves the card beside the tree — ordinary
file-explorer behaviour, and the alternative is the second control the row is not (#175, and the
`aria-expanded` note below). **The separate collapse control this section once parked as *a later
change if anybody wants one* is still not a control**: it was the row in #175's shape and it is the
row in this one.

#### And the card searches the whole archive — settled (#146)

The field is the design's own, in `8dcd4330…`'s and `b91c300d…`'s `DIRECTORY` aside, **between the
header strip and the scrolling tree**. The one host method behind it is `search_archive` (R38,
`src/daemon/search-archive.ts`), which answers matching entries of the *whole* archive as component
arrays — so the searched tree is derived from **one** answer, and re-deriving it with a
`list_archive` call per level would be the walk that method exists to replace, paid for again in the
browser.

- **Every hit is visible, its ancestors are expanded, and a branch that holds no match is not
  drawn.** All three fall out of building the tree from the matches themselves
  (`panel/src/archive/search-tree.ts`): a node exists exactly when a match's path runs through it, so
  there is nothing to filter out. A node with children is a directory by construction; a leaf takes
  its match's own `kind`, which is the host's answer and never an inference from a name (D22).
- **There is no depth bound in either tree** (amended in place, #159). This was the contrast that
  made a hit below a run visible at all while the browsing tree stopped at one; the browsing tree
  reaches those addresses too now, and what stays true of this one is the reason rather than the
  contrast — it draws exactly the addresses the host answered, so there is no depth at which to
  stop. The `<serial>` *is* a row here, because the host answered with it.
- **A hit row is the same row.** The same `<Link>`, the same classes, and every extra a browsing row
  is forbidden: no count, no status glyph, no colour that means an outcome, the name verbatim and
  `break-words`. The glyphs differ, and they say what the entry *is* — `FolderOpen`/`Folder`,
  `FileText`, and `FileQuestionMark` for the host's own *unclassified*.
- **And the searched tree does not collapse** (amended in place, #175, and unchanged by #198). A hit
  goes to its own address whatever it is drawing beneath it — which every browsing row does now too
  — and it carries **no toggle**: every node here **is** an address the host answered with rather
  than a level of anything, so there is nothing under it to open and nothing to close. It is not in
  the open set and is not drawn from it. It still carries `aria-expanded`, because it is still open —
  by construction, and now said rather than only drawn.
- **Three states, and none borrows another's sentence** — nor one from *Nothing in the archive*,
  `ARCHIVE NOT READABLE` or the tree's own *Reading this level.*: in flight is
  ***Searching this host's archive.***, one quiet line with `aria-live="polite"` and **no spinner**
  (§5); nothing matched is ***No name in the archive contains that text.***; and a search that could
  not be run is ***The host could not search the archive.*** Everything unusable folds into that last
  one — an `error` envelope, an unparsable result, a request nothing answered, and the host's own
  `unreadable` — while a host that has archived nothing folds into *nothing matched*, because nothing
  filed is nothing matched. A `refused` sets nothing at all (`archive-levels.ts`'s fold, again).
- **A truncated answer says so**, ***More names match than are shown. Narrow the text.***, and it is
  drawn **above** the hits: a line under a long list is one a reader reaches only by scrolling to the
  end of it, and until then a partial list reads exactly like a complete one.
- **And truncation is orthogonal to the three states, not a fourth one** (amended in place, #146).
  The host's flag means *a directory that exists was not fully examined*, which it sets without
  recording a match whenever an unreadable subtree or one of its three bounds stops a descent before
  any name matches — so `matches: []` with `truncated: true` is reachable, and it is the answer a
  reader is most likely to act on by giving up. *Nothing matched* therefore has two sentences rather
  than one: ***No name in the archive contains that text.*** when the whole archive was examined, and
  ***Nothing in the part of the archive that could be examined contains that text.*** when it was
  not. The definitive negative is never said about a search that was cut short — which is what the
  flag exists for, and the operator with a permissions problem is the one who would otherwise get it.
- **No request per keystroke.** The text is debounced (300 ms), one request is in flight at a time,
  and an answer to text that is no longer in the field is dropped rather than rendered
  (`panel/src/archive/archive-search.ts`). There is no polling and no refresh, for the same reason a
  level has none: the archive is finished data.
- **The accepted cost, checked against a real answer**: the searched tree reuses the browsing tree's
  own indent (`pl-5 ml-2.5 border-l-2` per level), and a hit six levels down therefore has little of
  the column left for its name, which wraps. That is `break-words` doing what it is there for
  rather than `break-all` — and a *shorter* indent for the searched tree would be a second tree
  idiom, invented at the keyboard, for a column the approved markup already settled. **#172 bought
  this room rather than removing the cost**: the column is 0.4 of the row instead of 320px, so it is
  370px at `xl` — and it keeps growing with the window, because since #240 the row has no
  cap to stop at (§4): on a 1920px window the row is the whole 1584px content box and the tree is
  **≈626px** (`0.4 × 1584 − 8`). Below `xl` the tree has the whole width.
- **The field is absent in every state that draws no tree** — and that needs saying nowhere in the
  code: it is part of the tree card, so it goes wherever the card goes. It is **present with an artifact open** since #160, because the
  tree is. The *state* lives above the card (`panel/src/routes/archive.tsx`), where it outlives the
  address changing under it. **And it is in both views since #207** (amended in place), over two
  populations: the whole archive here, the runs that carry a group id in the groups view, with the
  three sentences that claim a population being the view's and everything else — the position, the
  markup, the debounce, the four states, the row anatomy — one implementation. The groups half is
  above, under *The tree card's search field is here too*.

**What a tree row may carry, and nothing else:**

- **A glyph on every row saying what the entry is, and a triangle on every row there is a level
  under.** **A run is no longer a leaf** (#159, reversed in place). It was one because the card
  beside the tree was a second explorer that named what the run wrote; that card is going, so the
  tree has to reach the file itself, and a run expands into the entries of its `<serial>` — which is
  still not a level of the tree and still in every address below the run. The glyph is
  `FolderOpen`/`Folder`, `FileText`, or `FileQuestionMark` for the host's own *unclassified*, taken
  from the entry's `kind` and never from its name (D22); the triangle is `ChevronDown`/`ChevronRight`.
  Both are `aria-hidden` — **the triangle stayed decoration meaning *this opens*, and did not become
  a second control inside the link** (#175, rewritten in place; #198 kept it there). Collapsing
  landed on the row, which already goes somewhere: hanging the closing half of one gesture on a
  `<button>` nested inside the `<Link>` would split it across two targets, make a row two things, and
  be a markup change larger than it looks for no behaviour the row cannot carry itself. **The row is
  still one `<Link>` and one target**, and what an open set added is a handler on that link rather
  than anything a reader can hit. **What the row does say out loud is `aria-expanded`**, on every row
  there is a level under and on no other, **reporting the state it is drawn in** — the triangle draws
  openness and cannot say it, the tree told assistive technology nothing about it until #175, and the
  row is a toggle, so this is the change that had to notice. **A run whose parent named no single
  child gets none of the three — no open folder, no triangle, and no `aria-expanded`**: there is no
  level to open, and drawing one over nothing is the same class of claim as an invented `0`.
- **No count, and no measure either.** `childCount` is on the wire and is deliberately not drawn
  here, and neither is a file's `sizeBytes`. **The header's two badges carry the numbers for
  whatever is selected** — corrected in place (#261: it read *the header badge carries the one
  number*, said while there was one; there are two now, a count and a size, and the correction is
  that there are two rather than that the tree gained either). What keeps the tree a tree rather
  than a report is that **no number of any kind is in a row**, which is the half of this bullet that
  did not move. `directory-tree.test.tsx` asserts the tree's exact text, so one cannot creep back in.
- **No status icon of any kind** — no tick, no cross, no dot, no play glyph, no colour that means an
  outcome. Rover has no verdicts to report (§2), and green ticks beside runs in the tree are exactly
  what the superseded `Archive — Browsing (V2)` got wrong.
- **The name, verbatim and `break-words`.** Nothing is truncated, ellipsised or lower-cased.
- **One thing was added to that list, and it is a name rather than a measure** (#182): the label
  badge, between the glyph and the name, on an artifact the **groups** view has a filed label for
  and on no other row anywhere. It is not a verdict and nothing is ranked by it — the section above
  is its whole vocabulary.

**Every row is a `<Link>`**, and **below a run every entry becomes one** (#159, amended in place).
Above a run only a `directory` does: a stray file at a project or a test-name level is not something
the tree can take you into, so naming it stays the contents card's job. Inside a run a file is
precisely what a reader selects — in order to preview it — and the old rule was true only while a
second card was there to name the rest.

**A level with nothing in it draws nothing under its node** — no `0`, no placeholder row, no icon. A
directory that does not exist is not listed, and one the host cannot see into is said in the contents
card, where there is room to say it properly.

**Except the run's own `<serial>` level, which says which of the two it is, here** (amended in place,
#161). Every other node has a card beside it that **is** that level's listing, so *empty* and
*unreadable* are already drawn apart there; a run's card is its identity and its device and lists
nothing at all since `CONTENTS` went, which left the pair with nowhere to be told apart — and they
may never render alike (D6). So that one level draws ***This run wrote nothing.*** or
***This run's contents are not readable.***, in the quiet line the tree already uses for *Reading
this level.* and in **nothing that is a row**: no glyph, no triangle, no link, no count. The two
share no phrase with each other, nor with *Nothing is filed under this directory* or
`ARCHIVE NOT READABLE`, which the card beside the tree still says about whichever level it is
showing — including this one, when it is what the address names.

### The three levels, and the fourth thing a run is

Above a run the depth decides what a row is; below one the entry's own `kind` does. **No name is
ever parsed to decide either** (D22).

| depth | the level | a row is | it carries | expandable |
| --- | --- | --- | --- | --- |
| 0 | the root | a project | its name | yes |
| 1 | a project | a test name | its name, and `RUNS` from `childCount` | yes |
| 2 | a test name | a run | its name, `OWNER`, `GRANTED` | **yes — its children are its `<serial>`'s entries** |
| 3 | a run | not a tree level — hopped, never descended into | — | — |
| 4 and below | inside the run | **any entry**, whatever its `kind` | its name | a directory is, a file is not |

- **`RUNS` reads `childCount`, and `null` is `unknown` — never `0`.** A `0` would say *no runs* about
  a directory the host could not read into, which is the exact distinction `childCount: null` exists
  on the wire to carry. It is **the only measure left on this screen** since `CONTENTS` went (#161),
  and it is the rule a size the host could not `stat` followed on the way out.
- **Runs are listed most recent first — in the tree and in the contents card alike**, which is the
  host's own fixed order reversed. Reversing is not parsing: a lease directory leads with a UTC
  basic-format timestamp precisely so that it sorts chronologically as text
  (`src/daemon/archive-path.ts`), and the daemon sorts in code-unit order for that reason. The
  describing line says *most recent first* so the order is claimed rather than left to be inferred.
  **One helper decides it for both panes** (`panel/src/archive/level-order.ts`): they list the same
  run directories side by side, and a pane that kept the host's order beside one that reversed read
  as two different lists.
  **The comparison card is the one exception to *most recent first*, and it is the only one**
  (#199): its panes read oldest → newest, left to right, so a before/after reads as a before/after.
  The tree and every level listing are unchanged, and `level-order.ts` decides that direction too —
  `mostRecentFirst` for these levels and `oldestFirst` for that card — so the exception is named in
  one place rather than being a rule some pane quietly reversed. See *The comparison card* below for
  why it is a sort there and a reversal here.
- **A run's own contents lead with every directory in them** (#208, its mechanism replaced in place
  by #235), and everything else in that level keeps the host's order below them, exactly as it
  arrives. The host sorts in code-unit order, which put `device_info.json` and `group_id.json` above
  the directories — two files whose contents the card beside the tree is already drawing, sitting
  over the only rows that reach an artifact at all. **`logs/` leads the level too**, which is what
  the first version of this rule got wrong: it lifted the two names `screenshots` and `recordings`,
  so a run whose lease pulled logs drew all three sidecar files above `logs/` — the exact complaint
  #208 was filed about, surviving for one of the three kinds the archive writes. It is decided in
  `level-order.ts` with the other two directions, which is what makes it the **second** named
  departure from *the host's order stands* rather than a rule a pane invented — and what makes the
  tree and the card agree about a level they both list. The two halves are taken in the level's own
  order, so *directories first, everything else unchanged* needs no tie-break, and a level holding
  no directory at all draws exactly what it draws today. **A `kind: 'other'` entry is not a
  directory** and lands with the files: the host names a symlink or a socket rather than dropping
  it, and promoting one would be this screen deciding what the host declined to.
- **That this screen knew two of the archive's words is reversed — the ordering it bought is not**
  (#235, rewritten in place rather than deleted, `ai/RULES.md` §1). #208 put a deviation on the
  record here: it wrote *the two kinds a reader opens a run to look at* as the list
  `['screenshots', 'recordings']`, private to `level-order.ts` but a name this screen reads all the
  same — against the bullet below, which says nothing on this screen knows the word `unlabeled`, and
  against D22, which puts `kind` on the wire precisely so that no reader guesses from a name whether
  an address is a directory. Expressing a statement about *kinds of thing* as one about *two
  particular names* is also what left `logs/` behind, and what would have meant an edit for a fourth
  kind the archive files later. The key is now `kind === 'directory'` and **no name is read at all**,
  so the deviation is gone rather than narrowed and the bullet below is again literally true. What
  it costs is written down: `screenshots` was drawn before `recordings` because the list said so,
  and by kind alone the host's own code-unit order stands — `logs`, `recordings`, `screenshots`.
  That is one fewer departure rather than a new one, and if a fixed order among the artifact
  directories is ever worth having, the honest version is `list_archive` answering it, since the
  host is the one that knows what it wrote.
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
- **`GRANTED` reads the reader's own zone, to the minute** — `20260830T170501Z` → `2026-08-30
  19:05` for a reader in Warsaw, through the one module that decides that for every timestamp in
  the panel (`panel/src/time/instant.ts`, §6). It was reformatted **textually** to
  `2026-08-30 17:05:01 UTC` until #223, with no `Date` and no `Intl`, on §6's rule that nothing may
  re-express a host instant in the reader's zone; **that rule is reversed in half, in place, in §6**
  — re-expressing an instant is exact where differencing it against this machine's clock would not
  be — and this field followed it out, because it was the same rule applied to a directory name.
  Nothing here differences anything, and the half of §6 that forbids that is untouched.
- **The parse is unchanged, and it is still what decides `unknown`.** The name is matched against
  the anchored basic-format shape, so a name that merely starts with digits still reads `unknown`
  and the directory's own name is still shown in full either way — nothing is inferred from a name
  that does not have the shape (above, and `panel/src/archive/run-identity.ts`). What changed is
  the rendering of a prefix that *did* match.
- **Minute precision is why the run's own name is always beside it.** Two runs a second apart draw
  the same `GRANTED`, which §6 accepts as a cost and defers to here: this field is never the only
  thing on the row, because the directory name carrying the full `…T170501Z` instant is drawn with
  it in the tree, in the level listing and as the run panel's own heading. That is also where a
  reader gets the exact instant a host-side log search wants.
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
  about the run rather than as a level worth a round trip. **The tree makes the same hop through the
  same helper** (`runContentsLevel`, `panel/src/archive/archive-levels.ts`), so exactly one place
  knows a run holds one child and the two halves of the screen cannot disagree about where a run's
  contents are — and it is guarded on the run's own depth at every call site, because a project with
  one test name carries an `onlyChild` too. A selected run therefore costs **four**
  listings, not five — the run's own level is never listed. **That a run directory holds exactly one
  entry is load-bearing**, which is why the archive files a lease's description *inside* the
  `<serial>` directory rather than beside it: a second entry at the run level would make `onlyChild`
  `null` and blank this field and the device card for every run that had one, and leave the tree
  with no level to open under the run (`PROJECT.md` §10).
- **A `null` `onlyChild` is stated, not worked around.** `SERIAL` reads `unknown`, and the tree draws
  the run no triangle and nothing under its node. There is no second request to go looking: a run
  directory that is not one-device shaped is a fact, and an invented `0` would be a claim.
- **And *no serial yet* is a third thing again, never that one.** The serial is read off the level
  *above* the run, and that level has its own three answers: while it is in flight `SERIAL` reads
  `reading`, and when the host cannot read it `SERIAL` reads `not readable` — with `DESCRIPTION` and
  the device card ordering that same state before their own, because both files live at an address
  the serial is half of. Only a level that answered and named no single child gets `unknown`, which
  is a definite claim about a run and exactly what must not be rendered out of an answer nobody has
  given (D6, and the state table below). This matters because the levels are four independent round
  trips: the root usually answers first, so a link straight to a run renders the run panel before the
  level above it has come back.
- **`CONTENTS` is removed, and its reason is reversed with it** (#161, rewritten in place). It was
  ***how another address inside the run is chosen***, which was the answer to the tree stopping at a
  run — the run's own entries were reachable from this card and from nowhere else. The tree does not
  stop at a run any more (#159) and stands beside this card at every depth (#160), so `CONTENTS` was
  a second explorer of the addresses the tree had just been given, and **a selected run's preview is
  the identity card and the device card and nothing else**. Three things go with it:
  - **the design's footnote goes with the card that carried it** — *A directory that is not listed
    does not exist — a verb that produced no bytes wrote nothing*. It is recorded here rather than
    left to be noticed: a tree of rows has nowhere to put a sentence, and a tree row may carry
    nothing but a name;
  - **whether a run's `<serial>` level is empty or unreadable moves into the tree**, because the pair
    may never render alike (D6) and this card was where it was said (above, under the tree);
  - **no measure is drawn anywhere on this screen any more.** The tree has never drawn a count or a
    size, and the levels' own listings draw `RUNS` and nothing else, so a directory's `1 file` and a
    file's `formatBytes(sizeBytes)` left with the card that showed them.

### The three states with nothing to browse

| Where | The answer | What renders |
| --- | --- | --- |
| the root | empty, or not there | `QuietPanel` — **Nothing in the archive**. No count badge, **no tree card**, no control. |
| the root | unreadable | `QuietBanner` — **`ARCHIVE NOT READABLE`**. No count badge, **no tree card**, no retry, no error code. |
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

**Four routes, two families, one component** (amended in place, #181): `/archive` and `/archive/$`
for the file explorer, `/groups` and `/groups/$` for the group-first arrangement, all four
`useParams({ strict: false })` and all four the same component with `view` as a prop. **Two per
family because `to` is typed off the route tree** (corrected in place, #189 review): the splat route
does match the bare address — against @tanstack/react-router 1.170.32, `/archive`, `/archive/`,
`/groups` and `/groups/` all resolve to the `$` route with `_splat: ''`, and the bare route is never
in `router.state.matches`, which `archive-path.test.tsx` now pins — but without the bare routes
declared, `/archive` and `/groups` are not link targets the router's types admit, and `sidebar.tsx`
and `view-toggle.tsx` cannot name the root of a family without a trailing `$` in a shared address.
The bare routes are declarations for the type; the splat route is what renders. The components are
joined with `/` and the router does the encoding — a
directory name may legally carry a space, a `%` or a `#`, and `archive-path.test.tsx` proves the
round trip for **both** splats against a **real** router rather than the mocked `Link` the screen
tests use.

**There is no polling and no refresh control.** The archive is finished data: a run directory is
written while a lease is live and nothing is added once it ends, and this screen makes no claim to
show a run appearing. A level is fetched when a navigation or a click first draws it and cached for
the life of the screen, the grouping walk is fetched **once**, only in the view that reads it, and
**the size answer is fetched once per scope on exactly those terms** (#261, #262) — one
`measure_archive` for an address, or one `measure_archive_groups` for one of the groups view's three
shallow scopes, when a navigation first draws that badge, kept for the life of the screen, so
navigating back to a scope costs nothing and nothing re-measures behind the reader. This
is the one place the panel's data differs from the Devices screen's, which polls because *what is
attached* changes under the reader.

**The `Keep` set is not polled either, and its reason is a different one** (#237). It is not
finished data — a press changes it, and it is the host's, so another operator's press changes it too
— but this screen is told the **whole** set by every answer it gets, so one read on mount plus one
answer per press is every state it can draw. What that costs is stated rather than hidden: a tick
made in another browser appears here on the next mount and not before, which is a reload rather than
a refresh control, and there is nothing on this screen a stale tick could damage.

**A path deeper than a run is no longer reachable only by typing it or by following a search hit**
(amended in place, #146 and #159): **the tree draws it**, to any depth the archive holds, so a file
is selectable by clicking alone. Typing one still works and still renders that level's listing rather
than nothing at all — names, addressable, no invented measures — and a search hit still lands where
it lands. What stays true through all three is the rule underneath them (amended in place, #198):
browsing draws only a level somebody asked for — an ancestor of the address, or a row the reader
clicked open — so the tree can never draw more of the archive than has been read one level at a
time, and no gesture reads a level it does not draw.

### Deviations from the approved markup, made deliberately

The count is deliberately out of this heading: the list is what matters, and #159 lands in three
phases that would otherwise each renumber it.

- **The search field's placeholder says what the field does.** The design's *Filter this tree...*
  describes a client-side filter over rows already drawn, and this is not that: typing asks the host
  to search the *whole* archive, including levels this tree has never read. It reads
  ***Search the whole archive...*** instead (#146) — and in the **groups** view
  ***Search the grouped runs...*** (#207), because the whole-archive sentence stops being true where
  the population is the runs that carry a group id. Nothing else about the field's markup deviates
  except the clear action below — the wrapper, the classes and the leading glyph's position are the
  approved markup's, and `lucide-react`'s `Search` in place of the Material Symbols glyph and
  `rounded-sm` for the design's `rounded` are the standing portability note above rather than
  deviations of their own. It carries two attributes that draw nothing and that no design would have
  shown: an `aria-label`, because a placeholder is not a name, and a `maxLength` mirroring the host's
  own text bound, so a long paste stops at the field instead of spending a request to be refused.
- **The leading glyph becomes a clear action while the field holds a query** (#154). The approved
  screens draw the magnifying glass and nothing else, and no acceptance criterion asks for a way to
  empty the field — but they only ever draw that field *empty*, so what its glyph position does with
  a query in it was never designed. Empty, it is the approved glyph, unchanged. With text in it, the
  same corner and the same 18px is a `lucide-react` `X` button whose `aria-label` names the action,
  because the glyph draws it and cannot say it. Clicking it calls the field's own `setText('')` — the
  setter a keystroke already uses — so clearing is the ordinary empty-text path (`idle`, nothing
  asked of the host, straight back to the URL's levels) rather than a second one, and it puts the
  caret back in the field, since the control it was on stops existing the instant the text is empty.
- **The identity card carries a `DESCRIPTION` field** (#148). The approved screens have no such
  field, because the string it draws did not exist when they were drawn. Its reason, its states and
  why it is always drawn are above, under *The run's description*; §6 records the same field on the
  live device card and the force-release dialog.
- ***A contents row is a `<Link>`* is reversed** (#161, rewritten in place rather than deleted). The
  approved screens have `cursor-default` on these rows, and the deviation's objection was that it
  *would leave the tree as the only way to move and make the larger half of a file explorer inert*.
  The tree **is** the only way to move now, deliberately: it reaches every address in the archive
  (#159) and stands beside the card at every depth (#160), so what was the objection is the
  arrangement, and the approved markup was right. The rows keep every field they carried as links —
  the name, `RUNS`, `OWNER` / `GRANTED`, a `kind: 'other'` entry named with no measure — with **no
  link affordance and no hover treatment that promises one**, which is the `transition-colors
  hover:bg-surface-container-highest` pair gone and no `cursor-*` in its place.
- **The run column's third card is deliberately not built.** `d24d2c84…` draws `CONTENTS` under the
  identity and device cards; the built screen has two cards, for the reason recorded under the three
  levels above, and §1's row for that screen says so. **The preview card therefore carries no
  clickable element at all while it is showing a level**, and `Open in a new window` on an artifact
  is the only interactive control it may carry.
- **A `kind: 'other'` entry gets `FileQuestionMark`.** The designs have no glyph for one, because
  they never showed one. It says *the host could not classify this*, which is what the wire says; it
  is not an alarm and there is no colour on it.
- **The tree draws file rows** (#159). No approved screen shows one — the tree stops at a run in all
  four of them, because the card beside it was where what a run wrote was named. The tree is the only
  way to reach a file (#161), so it has to be able to draw one. A file row is the row every other
  row is: the name, one glyph saying what the entry is, no triangle, and no count, status glyph or
  outcome colour.

### Deliberately absent, and why

- **The `Filter this tree...` input is no longer absent** (#146), and this entry is amended in place
  rather than deleted, because what it refused is worth keeping. It said: the input appears on one of
  the approved screens and on neither of the others, no acceptance criterion asks for it, and D24
  spends a paragraph refusing search. **Both halves of that are now corrected.** The claim was
  factually wrong — the input is in `8dcd4330…` as well as in `b91c300d…`, verified against the file
  the server returned on 2026-09-01, whose `DIRECTORY` aside carries it between the header strip and
  the tree — and **D24's refusal of search is reversed at the operator's instruction** (`PROJECT.md`
  D24, R38). What survives of that refusal is the load-bearing half: there is still no index, no
  catalogue and no cache, so the answer is a bounded walk of the filesystem at request time, which is
  why a truncated one says so. The field is built, and it is *the card searches the whole archive*
  above.
- **The `LATEST` column** in `b91c300d…`'s contents table. One `readdir` per test row is exactly the
  walk D24 refuses; `list_archive` cannot answer it and must not grow a parameter that can.
- **No aggregate in a *row*, and the total is no longer absent** (reversed in place, #261). It read
  **no aggregate of any kind — no total size, no run count across projects, no retention figure**,
  and the half of that which still stands is the half about rows: the tree has never drawn a count
  or a measure, #161 took the `CONTENTS` card that did, and nothing per-row has come back. What is
  reversed is the **total**. Retention is built — the sweeper runs on the budget after every lease
  and on both bounds at midnight (D37, D38) — and the budget itself is typed on the System screen
  (§13), so *how close am I to it* became a question an operator has every reason to ask and this
  screen could not answer. It answers it now, in the header, as one sentence about whatever is
  selected (*The size badge*, above). The run count across projects stays absent: a count of runs
  spanning projects is not a fact about any address, and there is nowhere on this screen it would be
  a fact *about* anything.
- **Nothing invented**: no duration, no trigger, no author, no environment panel, no network figure
  and no file name that was not in a listing. `run-panel.test.tsx` asserts the absence of each. The
  device card is held to the same rule from the other side — it may only say what its file says.

### The device card — settled (#136)

**`DEVICE — FROM device_info.json`** (`d24d2c84…`'s second card) is the second of the run column's
**two** cards, under the run's identity card, and it is **the one thing on this screen that is a
file's contents rather than a listing**. `list_archive` answers directory levels; the bytes come from
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
- **The level above is ordered before the file's own answer**, exactly as `DESCRIPTION` orders it and
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

### The artifact preview — settled (#133, narrowed by #143, one arrangement since #160)

Opening a file **draws the preview in the one card beside the tree**, so the artifact is read where
it was found. This is a state of the Archive screen and not a second screen: the breadcrumb, the
describing line and the header row's shape are the same in it as in every other.

**There is one arrangement at every depth — the tree, then one card** (#160). What the parent
listing says the selection is decides what that card *draws* and nothing at all about whether the
tree is beside it, so the screen has one navigation surface instead of four layouts to be in. This
is the whole of the `All` view; the second view (#165, above) draws no tree and no card and nothing
about it reaches here.
Three of #133's and #143's rules are reversed by that and are rewritten in place below rather than
deleted, each where it was written: *the tree is not shown while a file is open*, *the back arrow*,
and *the wait is its own arrangement*. Opening a **folder** was already not a preview (#143); it now
draws that folder's own listing, which is what depth 4 and every level above a run already draw.

**`Run Detail — Artifacts (V2)` (`36b54fbe032449d8a300ea0825bbf1c8`) is retired by this, not
deferred.** The first draft of §11 drew a boundary — *Archive lists; Run Detail opens* — and the
boundary was the weaker half: sending a reader to a second address for the thing they are already
pointing at is not an explorer. That screen has nothing left this does not do, and it is marked
accordingly in §1.

**The tree and the card share the row 0.4 / 0.6, and neither of them carries a width** (#172). The
approved markup pins the preview to `lg:w-[580px] shrink-0`; that was tried and **reversed**,
because a pinned child makes the *split* depend on the window, so the same screen shows different
proportions on different monitors. That reasoning stands and is the whole of this rule; what has
been rewritten is the answer that followed from it.

***The tree is the one sized child of the row — `lg:w-[320px] shrink-0`* is reversed** (#160's
arrangement, edited in place). A 320px tree is a fixed child too, so it had the very property the
pinned preview was reversed for: measured in Chrome, that tree was **48% of the row at `lg` and 25%
of it at a 1728px window** — the same screen, different proportions, one monitor to the next. The
split is now written as two fractions on the row itself
(`panel/src/routes/archive.tsx`, `Columns`): `basis-2/5` on the `<aside>` and `basis-3/5` on the
`<section>`, through `xl:[&>aside]:` / `xl:[&>section]:` child selectors so that **both halves of
the arrangement are in one place** and each card describes only itself. The card keeps `flex-1
min-w-0` — `min-w-0` is what stops a long path widening the row, and `flex-1` is what the card is in
the stacked arrangement; the `0%` basis its shorthand carries is outranked by the row's own
`> section` rule.

**`basis-*` rather than a width, because it is what makes `--gutter` free.** The two bases come to
exactly the row, so the gap is the row's one overflow and the default `flex-shrink: 1` takes it back
in proportion to them — 40% of the gutter off the tree, 60% off the card — which leaves each on its
exact fraction of what is actually there to share, with no `calc()` and nothing pushed past the
window. `w-2/5` and `w-3/5` are the same two numbers and overflow the row by 20px.

**The row goes horizontal at `xl`, not `lg`, and that is the same decision as the fraction** (#172,
settled in a browser rather than derived). 320px was a constant the row could afford from `lg` up; a
fraction cannot be. At `lg` the 256px sidebar and the 40px desktop margins leave a 688px row, of
which 40% is **267px** — *less* than the tree had — and the fraction does not reach 320px until a
1156px window. Looked at in Chrome, that band is where a six-deep artifact name stops breaking at
its separators and starts breaking mid-word, one syllable to a line, which is the opposite of what
this change is for. So the **stacked** arrangement — where the tree has the whole content width and
every name fits on one line — runs one breakpoint further up, and the horizontal row begins at `xl`
(1280px), where the tree is 370px and every window above it is wider than the 320px this replaces.

A **floor under the fraction** was the alternative and was rejected: a `min-w-[320px]` on the tree
would hold between `lg` and 1156px and the split in that band would once again be whatever the
window happened to make it — the property this section exists to forbid, reintroduced in the one
place it would be least expected. Measured after the change: 40.00% / 60.00% at 1280, 1440, 1600,
1728 and 2560, with no horizontal overflow at any of them. The 504px / 756px measured beside them
was the row at `--container-max`, **a width it no longer stops at** (§4, #240, edited in place): the
fractions are unchanged and the row they are fractions of is now the whole content box, so the same
percentages fall on a larger number at every window above 1280px.

***The tree is not shown while a file is open* is reversed** (#160, edited in place). The rule was
the answer to a real constraint rather than a preference: the run's column stood beside the preview,
and a 320px tree plus two cards left neither of the two enough width to be read at, so the tree gave
up its place to the column that had to be there. **The run's column is not beside a preview any
more**, so there is nothing left to make room for — and the tree is what keeps a reader placed while
a file is open, which is the job the run's column was standing in for.

**The preview column holds one thing at a time.** The run's identity and device cards are what a
*selected run* is; they are **not** drawn beside an artifact, and the two files behind them are not
read for one (below).

**The run's column is drawn for a selected run and nowhere else** (#160). It stood beside a preview,
beside the tree with a folder of the run open, and alone while nobody had answered — three
arrangements, and two things on it existed only inside them:

- **The back arrow is removed**, and the reason it existed is what no longer happens. It was there
  because the preview took the tree's place, which left this column as the only way back; the tree
  is beside the preview now and is the way back from everything, so a second control would be one
  with nothing of its own to do (§3). The strip is the markup's left-aligned `Run Details` heading
  and nothing else — one fewer thing in it than #143 left, and nothing in it that comes and goes.
- **`CONTENTS` is gone** (#161, and this is the last of #159's three phases). It expanded down to and
  including the open address — the tree's own expansion rule as it then was, applied to the run's
  subtree —
  because a file below the run was reachable from this card and from nowhere else; #160 flattened it
  back to one listing of the `<serial>` level, and there is nothing left for even that to be for. The
  tree draws those entries under the run's node, so the card said the same names twice and only one
  of the two could be followed. What the run wrote is the tree's, and this column is the run's
  identity and its device.

**The path bar grows one segment for the open address, and the `<serial>` is in no segment of it.**
That address is where you are, file or folder alike: last, `text-tertiary`, not a link, shown in
full and wrapping rather than shortening. The serial is not a tree level, so there is no address to
link it to.

**The header row's counter slot is empty, and that is the rule rather than an exception.** The count
badge is a counter and one file has nothing to count — exactly as §7 leaves the held/free counter
absent rather than showing `0 held · 0 free`. **The size badge is drawn here** (#261), and it is the
one context that costs no request: `This file takes 411 KB on disk`, out of the `sizeBytes` the
folder's own listing already carried.

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
it. The tree's glyph is deliberately **not** per media type for the same reason.

**One control in the preview header: `Open in a new window`**, recessive, and **it is a view rather
than a transfer.** No download button, no `download` attribute, and it is absent for `opaque`. **The
words are here**, glyph and all four of them: the strip has a whole card's width, and it is only the
comparison card's 240px pane that takes the glyph alone (*The comparison card*). No
zoom, pan, rotate, filmstrip or next/previous arrows over the image — **the tree** is how another
file is chosen (#160; it was `CONTENTS` while the tree was not there). No annotation, measurement or
comparison tooling; comparison is `Compare — Visual Diff`'s question and a different screen.

**Routing — the open address is part of the path**, so a reload lands on it and the link is
shareable. **The layout is no longer a function of anything** (#160): there is one row at every
depth. What the parent listing says the address is still decides what is drawn — it may not be
guessed at from a name (D22) — but it decides the **contents** of the card rather than the presence
of the tree, which is why the table below has one column fewer than the state table it replaces:

| `selected.length` | The selection is | The tree | The card |
| --- | --- | --- | --- |
| 0–2 | a level | yes | that level's `LevelContents` |
| 3 | a run | yes | `RunPanel`, headed `Run Details` |
| 4 | the `<serial>` level, typed | yes | that level's `LevelContents` |
| ≥ 5, a directory | a level of the run's subtree | yes | that level's `LevelContents` |
| ≥ 5, an artifact | a file | yes | the preview, **alone** |
| ≥ 5, nobody has said which | not yet known | yes | one quiet line — ***Reading this address.*** |

The last three rows are #160's collapse of #143's three, which had the tree absent in two of them
and the run's column in all three. The `≥ 5, a directory` row reverses #143 in place: a folder had
no column of its own then, because `CONTENTS` was the only thing that could draw one, and it takes
the one card now — the same `LevelContents` depth 4 already drew, at a deeper address.

**And the two states with nothing to browse are the only two without a tree.** They gate the
browsing layout **at and above the `<serial>`** — so the `yes` in the first three rows above is the
root's answer being a listing, and only the `≥ 5` rows draw their tree unconditionally. No address
*below* the `<serial>` waits on the archive root, and the tree fills its own levels in as they
arrive (`directory-tree.tsx`).

- **The levels read are the prefixes of the selection with the run's `<serial>` substituted at that
  one depth — and, since #198, whatever else the reader has opened** (`levelsWanted`,
  `panel/src/routes/archive.tsx`; `drawnLevels`, `tree-source.ts`). Every one of them is still a
  level the tree draws, which is the rule that did not change: the second half is a walk of the drawn
  tree rather than a wider guess at the address. The run's own level is never among them — a run's
  contents are its `<serial>`'s — and the selection's own listing is added only once its parent has
  said it is a directory, never on the strength of its name (D22).
- **The `<serial>` comes from the URL there** (`selected[3]`), not from the level above the run's
  `onlyChild`. The address was built from a listing, so that component *is* the directory's name; it
  removes a dependency, means the card never waits on the level above the run, and collapses
  `RunSerial` to `answered` — correctly, since *reading* and *not readable* cannot apply to a serial
  the address already carries.
- **What the address names is read off its parent's listing, never off its own name** (D22). Until
  that listing answers, nothing is fetched for the address and the card claims neither of the two
  things it might be (last bullet). **An artifact is deliberately not fetched on a guess**: asking the byte route for a
  directory would put *not a regular file* in the host's log on every folder a reader opens. An
  address the listing does not name at all *is* asked for, because *nothing is filed at this
  address* is the byte route's answer to give rather than the screen's to invent.
- **The counts, all of them levels the tree actually draws**: a run **4** listings; the `<serial>`
  level **4**, one fewer than before #160 because the run's own level is no longer listed under it;
  a folder at depth 5 **5**; an artifact at depth 6 **5** listings and the artifact, so **6**
  requests. **These are the counts for arriving at an address** — a fresh mount opens that address's
  own branch and nothing else (#198) — and each row the reader then opens adds **exactly one**,
  because the level it is drawn in has already answered by the time there is a row in it to click.
- **#133's request saving is knowingly given up** (#160). The root, the project and the test level
  used not to be fetched for an artifact, because the tree was not there to need them, and a folder
  asked for them only after the answer that wanted them; the tree is drawn at every depth now, so a
  deep artifact address reads its ancestor levels **because they are drawn**. Against it, **the
  run's two files are read only for a selected run** — `device_info.json` and
  `test_description.json` are on the run's own column, and nothing below the `<serial>` draws either
  of them any more — so what a deep address gained in listings it gave back in file reads.
- **And the counts are the counts however you arrive**, which took a second pass to be true (#140
  review): the `<serial>` level and the open folder's listing are addressed by paths *derived from*
  an answer, and holding those in a second cache meant the run's `<serial>` was read once for the
  run and again for a file under it. One cache, asked as a function of what it already holds
  (`archive-levels.ts`).
- **Nothing is claimed about the address until its parent has answered.** Until then the header
  carries the run's own line, not *One artifact from this run* and not *Reading this artifact*,
  which are claims the screen has not been given (#140 review): a deep link into a folder read both
  of those about a directory for as long as the listing took.
- ***The wait is its own arrangement* is reversed** (#143's rule, #160, recorded rather than
  deleted). What it bought is worth restating, because it is the reason it existed: a shared link
  may not render one layout and then flip into the other, because that moves everything the reader
  is already looking at. **One layout buys that for free**, so the rule has nothing left to do —
  there is no second arrangement to be caught in the wrong half of, and the tree is drawn from the
  first frame at every depth. What survives is the half that was never about layout: the **card**
  may claim nothing until the parent listing answers. So it says ***Reading this address.*** — one
  `aria-live="polite"` line under the address's own last component, **no spinner** (§5), and
  neither the word *level* nor the word *artifact*, which is the whole point. `ReadingThisAddress`
  is back, and it is back as a card rather than as an arrangement.

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

**The three deviations from the approved markup**, recorded rather than made silently:

- the preview is **0.6 of the row and the tree 0.4 of it** (`basis-3/5` / `basis-2/5`, from `xl`),
  and not the markup's `lg:w-[580px] shrink-0` (above). This is the widest of the three departures
  and #172 widened it further: the markup pins one child, #160 pinned the *other* one at 320px, and
  neither is a ratio — a pinned child of either kind makes the split a function of the window, which
  is the one thing this row must not be. Recorded here rather than only in the code because
  `ai/RULES.md` §8 makes a departure from approved markup a thing to write down;
- one `FileText` glyph for every file instead of the markup's per-media `image` one — `CONTENTS`
  kept it while it existed, and the tree keeps it now (#161);
- and **the arrangement itself is departed from** (#160). `a843d32b7a414ac3a84fd7e80aa8a8bf` draws
  the preview beside the **run's column**; it stands beside the **tree**. That markup is where *the
  tree is not shown while a file is open* came from, and the screen is one explorer with one
  navigation surface — a file explorer that hides its tree at the moment a file is opened makes the
  reader's place the one thing they lose by looking at something.

**Two earlier ones no longer stand.** #143 handed back the run column's centred, arrow-only header,
because every other header on this screen is left-aligned and the card's one control sat off the
axis of everything under it. #160 then removed the arrow itself, which takes the last of that
strip's difference with it: it is the markup's `Run Details` heading and nothing else.

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

### The `Keep` checkbox — settled here, not designed, and the operator's half of a sweep that runs unattended

A test the reader wants **kept** when Rover sweeps the archive. **The decision and the sweep are
both real, and this section is corrected in place rather than rewritten** (`ai/RULES.md` §1): the
host records which tests the operator keeps, *and* it deletes old runs on its own — the **disk
budget** after every lease ends with nobody asking (`PROJECT.md` D37, #245), and **both** bounds at
local midnight and again at daemon start (D38, #246), with `rover sweep` and `sweep_archive` the
operator's way to ask for the same pass on demand. So the tick is an exemption **in force within a
day of being set** rather than an instruction waiting for the thing it instructs, and it is the
only thing standing between one test's artifacts and a host that has run out of room — or a test
that has simply got old.

**Both halves of *remembering* the decision have landed** — the host's in #234 (D33) and the tick's
in #237. `list_kept_tests` and `set_kept_tests` sit on the panel's own transport over
`~/.rover/kept-tests.json`; the Archive screen reads the whole set once per mount and every press is
one call whose answer it draws (`pinned-tests.ts`), so a tick is there after a reload, in a
different browser, and after a daemon restart, and `rover keep list` shows the same test. So there is
a host method and a wired control: do not design a second of either. What is still absent is the
**number** in the sentence below, and it is absent for a reason that has nothing to do with any
trigger: `sweep_archive` deliberately carries neither of the host's two retention settings, so no
answer this panel can make carries the window and digits written here would be the panel inventing
data (`archive-checkbox.tsx`'s own comment on the sentence, and this screen's *nothing is invented*
rule). The sentence changes when a host **answer** carries the window. #246 is the proof of that
distinction rather than the exception to it: the trigger landed, the sentence had to change because
*once Rover starts sweeping* had become false, and it changed into the two **bounds** as a
condition — still with no digits in it, because nothing about a clock made the window sayable.

**It is `Keep` and not `Archive`, and the sentence is what forced the rename.** The control read
`Archive` first — on a screen called Archive, whose one job is browsing the archive — and the
sentence explaining it then had to say *…sweeping the archive, unless you archive it*: one word for
two different things, eight words apart. `Keep` is the verb a reader would use for what the tick
does, and it leaves *archive* meaning the place. `Store`, `Save` and `Preserve` were the other
candidates; the first two are what a form does with edits, and the third is heavier than a
checkbox.

**A popover on hover says why it is there** — *Traces of this test will be removed when the archive
runs out of room, or when the test gets old enough, unless you keep it. The host remembers this
tick, not the browser.* — in the panel's own card treatment
(`rounded-lg border-2 border-outline-variant bg-surface`), 288px wide, opening down from the strip's
right edge and over the card's body. A checkbox alone does not say what happens if you leave it
alone; this sentence does. It is the input's `aria-describedby` as well as visible text, so there is
one sentence rather than a tooltip and an accessible copy of it that drift apart.

**Three shapes were tried and rejected before it, each for its own reason**, and they are recorded
because the fourth looks arbitrary without them: a **`title`** (a tooltip nobody reads, in the
browser's styling rather than the panel's); the same sentence **printed in the strip** (it did not
fit — a 40-character run name lost its own header to it); and a **green `?` opening it on a press**
(one sentence given its own control, and a `<button>` on a card whose whole claim is that it moves
nobody anywhere). What survives keeps the words and spends no room and no affordance on them.

**`group-hover` and `group-has-[:focus-visible]`, and no state at all** — no `useState`, no
listener, no Escape key. The second half is not decoration: hover is unreachable from a keyboard,
so a keyboard reader would otherwise never see the sentence. And it is `:focus-visible` rather than
`:focus-within`, which was the first attempt at that half and was wrong in a way only using it
shows — **a mouse click on a checkbox focuses it**, so the popover stayed up after the tick until
the reader clicked somewhere else. `:has()` rather than a `group-focus-visible` variant, because
what takes focus is the input inside the group, not the group. The popover stays **in the DOM**
either way, hidden by the `hidden` utility rather than unmounted, because it is the tick's
`aria-describedby` target: a reference resolves to hidden content, so the description holds for a
reader who never brings a pointer near it.

**There is no number of days in it, and that is deliberate — and it survived the trigger
landing.** The sentence a reader eventually wants is *…will be removed in 14 days…*; the panel does
not have the 14. No host answer carries a retention window — `sweep_archive` deliberately carries
neither of the host's two settings (§13), and it is not on `PANEL_METHODS` in any case — and a
figure written in here would be the panel inventing data the host never sent, which §9's *nothing
is invented* rule and `ai/RULES.md` §2 both refuse, and which `archive-checkbox.test.tsx` asserts
against so that a later edit cannot fill in a plausible one. **Why it still holds now that the host
sweeps on a clock** (#246) is worth saying, because that is exactly the landing that looks like it
should have changed it: the host has the number, and the panel's access to it is unchanged — no
method takes it, no answer carries it, and *when* the host acts on a figure has nothing to do with
whether it tells anybody what the figure is. So naming the **condition** rather than a deadline is
still what the sentence does, and the day the host answers a window it is one string that changes.

**Nothing enforces the tick, and it is the host that remembers it.** The set is the host's own
document — `~/.rover/kept-tests.json`, beside `users.json` and deliberately outside the artifact
tree, because every sidecar in that tree is written once and never rewritten while this toggles
(D33, `PROJECT.md` §10). The Archive screen holds a cache of the host's answer for the life of the
mount and nothing else (`pinned-tests.ts`): deliberately **not** `localStorage` and deliberately not
in the URL, because retention is a fact about the *host's* disk and a tick kept per browser would
survive a reload while remaining invisible to the sweep it claims to prevent. *I ticked it on my
laptop and the run was deleted anyway* is the failure that arrangement has and this one cannot.
**And what enforces it is the sweep, which is the clause that stopped being true here.** This
paragraph used to end *nothing enforces it — no sweep reads the file yet, so what the flag buys
today is that the decision is recorded*. It reads the file now, on every pass and cached nowhere
(D6): the operator's exemption shipped ahead of the sweep on purpose (D33), and the sweep it was
waiting for arrived in three parts (R48). So the flag buys the exemption itself — absolutely, and
not even yielding to bring the archive under budget (D35, D36) — on top of the decision being
recorded, attributed and readable from every client (`rover keep list`, D28).

**No tick is drawn until the set has answered, and none when it cannot be read.** `list_kept_tests`
still out, an `unreadable` store, and nothing coming back at all are one state on this screen and it
draws **no checkbox at all** — the rule a group whose tests are not listed already obeys, applied to
the set itself. An empty box for a test the panel cannot ask about says *this is not kept*, which is
a claim about the operator's own decision that nothing has established.

**A failed write leaves the tick exactly where it was.** Nothing is written optimistically: the
press is one call and the panel draws the set the host answered with (R29), so a press the host
refused, could not write, or never received changes nothing on the screen and leaves nothing to
unwind. The host's cap being reached and a store it could not write are one outcome here, because
both mean the same thing about the tick and this screen has nowhere to say either.

**Where it is drawn, and the three levels are the whole list.** At the right end of the card's
header strip, opposite the name — on a **test name's** card, on a **run's** `Run Details`, and on a
**group's** card in the groups view. Nowhere else: the level card also draws the root, a project,
and every directory below the `<serial>`, and those addresses pass *through* a test without being
about one, so they carry no checkbox. `ContentsCard`'s header being a slot rather than a title
(#133) is what makes this an argument to that slot instead of a fourth card component.

**A group's tick is the same flag over all of its tests, and part-kept is a real state.** Pressing
it keeps every test in that group — in **one** request carrying every one of them, never one per
test, which is the shape `set_kept_tests` takes an array for; pressing it again, from kept, stops
keeping them. It does **not** lock the tests underneath it — a reader may untick one afterwards, which is deliberately not
prevented — and the group's own tick then says *some* through the platform's own third state,
`indeterminate`, drawn as a dash in a filled box. Neither of the two roundings was acceptable: *off*
would say nothing in the group is kept, *on* would say all of it is. There is no *group is kept*
flag anywhere; the truth is which tests are kept, and the group's tick both reads and writes exactly
that. A group whose tests are not listed — the walk still out, an unreadable answer, or no runs at
all — carries **no** tick, because there is nothing to keep and a tick there would be a promise
about runs nobody has been shown.

**Its sentence is the group's, not the test's with a word changed** — *Traces of every test in this
group will be removed when the archive runs out of room, or when a test gets old enough, unless you
keep them all. The host remembers these ticks, not the browser.* A reader
who saw the test's wording over a group's tick would take it for a control over the group as a
thing, and press it expecting one flag rather than several.

**One flag per test, shown on two cards.** The tick on a run's card is the *same* flag as the one
on its test's card — ticking either lights the other, and the two are never on screen together. A run
is one lease's output; what a reader recognises across runs, and what a sweep would come for, is the
test. It is keyed on `<project>/<test_name>` out of the **archive** address, so the same test is the
same tick in the groups view, where the URL carries a group id the archive has no directory for.

**No approved Stitch screen shows a checkbox** — none was commissioned, exactly as for the view
toggle above (§1, §11's third list) — so nothing about it is invented and every value is already on
this screen: the search field's frame at checkbox size (`rounded-sm border-2 border-outline-variant
bg-surface`), warming to the `tertiary` green that means *active* in the breadcrumb, the nav item
and the view toggle; `lucide-react`'s `Check` over it in `on-tertiary`, the token paired with that
fill; the label twelve pixels in the code face, the view toggle's own step, warming on hover the way
an inactive segment does and going green when it is on. That is what keeps the deviation small
enough to reconcile in one edit once a design for it exists.

**It is a native `<input type="checkbox">`** with `appearance-none`, not a `<button
role="checkbox">`: the element already carries the role, the tick state, the space bar and the
label association. The glyph is drawn over the box rather than left to the browser, because a
checked native box cannot be recoloured to `tertiary` on every platform — and the ring is
`focus-visible` rather than `focus`, since a checkbox is also focused by the click that just toggled
it and a ring drawn then reads as an error.

**The sentence sits outside the `<label>`, and that is not cosmetic.** An accessible name is
computed from the label's own text, so the sentence — written inside it first — became part of the
name, and the control announced itself as *Keep Traces of this test will be removed…*.
`getByRole('checkbox', { name: 'Keep' })` is what caught it, which is the query a screen reader
performs. **No portal, either**: the popover is anchored on the control and opens over the card's
body, which it may do because the `overflow-hidden` on this screen's cards is on the `<section>`,
and it stays inside that. So there is nothing to measure and nothing to keep in step with a
scroll.

**The cursor came from the base rule, not from a utility on this control.** §5's *a pointer on what
can be pressed* is one rule in `index.css`, and a checkbox is pressable — so
`input[type='checkbox']:not(:disabled)` and `label:has(> input[type='checkbox']:not(:disabled))`
joined that selector rather than this component carrying a `cursor-pointer`. The label is in it
because the word `Archive` toggles the box and is the larger half of the hit area;
`pointer-on-what-can-be-pressed.test.ts` gates both, and refuses the utility.

**It reverses one sentence of #161 in place, and only one.** *Nothing on the run's card is
clickable* was about **navigation**: the tree is the one way to move through the archive, and a card
offering a second route was the objection. This checkbox navigates nowhere. It is the Devices
screen's force-release shape instead — an operator control inside the card that owns the data it
acts on (§7) — and the assertions that stood are the ones that matter: no `<a>` and no `<button>` on
that card, in any state.

---

## 10. The Projects screen, as settled

The panel's fourth destination, between `Archive` and `System` (§3), answering one question: **what
is registered on this host, and what does each project ask the host to do around a lease on it.**
Everything below was settled over two Stitch rounds and is written down for the reason §9 is — the
alternative is the next agent re-deriving it and getting some of it the other way round.

**The approved screen is `89097f87f206419d91751655d67d5f2a`** (`Projects — Final Alignment`). Its
predecessor `74633a3b3d39445a8dedd0de97c2cc2b` is superseded and must not be built from; §12
records what the two rounds cost and why the second worked.

**The one host method behind it is `list_projects`** (R39, #152, `src/daemon/list-projects.ts`), and
the shape of this screen is downstream of one difference from the Archive's: it answers the **whole
root in a single call**, not one level at a time. So there is no tree, no expansion, no second
column and no navigation on this screen — there is nowhere to navigate to. A registration is a
leaf, and the screen is the list of them.

### The shell and the header

The shell is the reference's, unchanged (§3). The breadcrumb reads `Projects`, one segment, in the
active colour, with no heading under it. The describing line is *Projects registered on this host.*
and the header carries **one badge**, `4 registered`, which **goes rather than reading `0`**.

### The card, as settled

**One card per row, never a grid.** A registration is a row of facts about one project rather than a
tile, and unlike the Devices screen there is no second thing for a card to sit beside — no hardware
to compare at a glance, and nothing that changes under the reader.

**So a card is as wide as the content box** (§4, #240; it stopped at `--container-max` until then).
That is what an admin list is, and the width goes somewhere: the body is a two-across `<dl>`
(*As built* below, deviation 2), so a wide window gives the value columns room rather than turning
one identifier into a very long line. The card's own text wraps on whole words and is never
truncated, which is the property that holds at any width. If a measure is ever wanted here it is
`max-w-prose` on prose inside a card, never the row's cap back.

**The header strip carries the label `PROJECT` and then the identifier.** The device card's header
needs no label because a phone model is self-evidently one; `checkout-web` on its own reads as a
title, and it is not — it is the hook file's own name, the identifier the host looked the project up
by, and **the exact string a lease carries as its `project`** (D22). Monospace, verbatim, wrapping
on whole words: never truncated, never ellipsised, never lower-cased. Nothing sits on the right of
the strip, because a registration has no status to put there.

**Four fields, two across, paired like with like:**

- **`APPS` beside `SERVICES`** — the two lists, **one value per line**, in the monospace face
  because their values are identifiers.
- **`INSTALL` beside `TEARDOWN`** — the two that are only ever `declared` or `none declared`, in the
  ordinary body face. The face is what separates a list from an answer, so the pairing reads without
  a rule between them.

**No per-field rules.** The gutter separates the fields now that they are a grid; a rule under one
cell reads as a line across the whole card.

**`none declared` is a complete answer, not missing data.** A project that asks the host to do
nothing is the common, correct case — `apps: []`, `services: []`, no `install`, no `teardown`
(`src/daemon/project-hooks.ts`, and no default there ever names an application, D13) — so a card of
four `none declared`s must not look faded, empty, unloaded or pending. It is the same rule §7's
***nothing attached*** rests on: normal, common and *finished*.

**`SERVICES` is in declaration order and must never be alphabetised.** That order is the order the
host starts them in and its reverse is the order it stops them in (`src/ipc/methods.ts`), so
re-sorting the list would state something false about the host.

**No LED, no dot, no status glyph and no colour on any field.** The device card's LED means
*held or free* — a live fact about hardware. A registration has no such state, and borrowing that
vocabulary here would invent one.

**No control of any kind, and no disabled one.** No `Add`, no `Edit`, no `Delete`, no overflow menu,
and the cards are not links. A greyed-out `Delete` promises a permission tier that does not exist:
editing and deleting a registration wait on the role model D27 defers (D31).

**The five fields are everything the host answers, and a sixth cannot be added from this side.**
`ProjectRegistrationSchema` carries the identifier, `apps`, `hasInstall`, the service names and
`hasTeardown` — and **`env` values and every host path are structurally absent**, with no field
either would fit in (D19), because this answer reaches a browser and a hook file's `env` may hold
anything an operator put there. So a card cannot grow a command, a `cwd`, a port or an environment
value without changing the wire first.

### The card order is the host's order

Ascending identifier, in **code-unit order** (`src/daemon/list-projects.ts`) — not `localeCompare`,
for the reason `list_archive` refuses it: a locale-dependent order would make one host answer
differently from another. Two consequences the screen must show rather than tidy away:

- **A registration the host cannot read sorts where its name puts it**, in among the others.
  Nothing groups broken registrations at the end, and a screen that did would be inventing an order
  the host does not answer in.
- There is no other ordering available. `list_projects` takes **no parameter at all**, so there is
  no sort control to build and none to be asked for.

### The registration the host cannot read

It is **an arm of the union, not a project with empty fields** — which is the whole of what D31's
read buys. Today a hook file that will not parse costs a project its teardown and says so only in
one warning on the daemon's stderr; this card is where that becomes visible.

- A quiet grey banner, **`CONFIGURATION NOT READABLE`**, at its own width and left-aligned — not a
  slab across a full-width card — with the identifier still heading the card as on every other.
- One line under it: ***This is not the same as a project that declares nothing — the file is there
  and the host cannot read it.*** That sentence is the whole point of the state, exactly as *a phone
  may well be plugged in* is for *no view* (§7): the pair must never render alike (D6).
- **No error code, no path, no retry control**, and §5's no-red rule holds. Which of the four causes
  it was — not JSON, not the hook schema, a `project` field disagreeing with its own name, or
  unreadable outright — is deliberately not on the wire (D19), so a code here would dress a refusal
  up as a diagnosis.

### The three states with nothing to list — settled here, not drawn

| The answer | What it means | What renders |
| --- | --- | --- |
| `listed`, `projects: []` | nobody has registered one here | `QuietPanel` — **No projects registered**. No badge, no card. |
| `missing` | there is no projects root | the same panel and the same words |
| `unreadable` | the root is there and the host **cannot say what is in it** | `QuietBanner` — **`PROJECTS ROOT NOT READABLE`**. No badge, no retry, no error code. |
| nothing yet | the request has not answered | one quiet line, `aria-live="polite"`, **no spinner** (§5) |

- **Empty and missing render alike deliberately**, which is the fold §9 already makes at the
  Archive's root: both are the ordinary state of a host whose operator has not done a thing yet, and
  a reader has the same next step either way. *No projects registered* takes §7's ***nothing
  attached*** treatment and **says what would change it** — `rover init` in a project's own
  directory — and **the badge is absent** rather than reading `0 registered`, which would describe a
  set.
- **`PROJECTS ROOT NOT READABLE` carries its own second line**, ***This is not the same as no
  projects being registered — registrations may well be here.*** It is the same pairing the card
  above draws one level down, and for the same reason: D6.
- **Everything unusable folds into *not readable*** — an `error` envelope, a result the panel cannot
  parse, a request nothing answered — the fold `device-list-provider.tsx` and the Archive screen
  both already make. A `refused` sets nothing, because `Session.call` has fired `onRefusal` and the
  router is coming down.

### No polling, and no refresh control

A registration changes when a person runs `rover init` or edits a file on the host, which is not
something this screen makes a claim about seeing. It is fetched on navigation and cached for the
life of the screen — the Archive's rule, not the Devices screen's, and for the Archive's reason:
`list_devices` polls because *what is attached* changes under the reader, and nothing here does.

### As built (#157)

Only what the build settled that the rest of this section does not already say.

**The nav glyph is `Boxes`**, and the reasoning is in §3 with the other three.

**Three deviations from `89097f87f206419d91751655d67d5f2a`'s markup**, in §9's own form:

1. **The scanline layers are dropped** — one in the badge and one in every card header. The texture
   is confined to the navigation chrome (§5), which `app-shell.test.tsx` already asserts for the
   whole of `<main>`, and `held-free-counter.tsx` is the precedent for dropping the badge's.
2. **`md:grid-cols-2` becomes a plain `grid-cols-2`.** The two-across pairing *is* what the columns
   are — `APPS` beside `SERVICES`, `INSTALL` beside `TEARDOWN` — so a breakpoint would make the
   pairing a property of the viewport rather than of the card (§4).
3. **The header row is `PageHeader`'s**, not a rebuilt one — the same reuse §9 records.

And, as with every screen so far: the design's `rounded` is Tailwind v4's `rounded-sm` (§1's radius
rename), and Material Symbols become `lucide-react`.

**The card body is a `<dl>`** of four `<dt>`/`<dd>` pairs — `device-card.tsx`'s own pattern rather
than the markup's spans. A list of identifiers is one `block` span per value in place of the
design's `<br>`, because the values are separate identifiers rather than one string with breaks in
it.

**The badge counts every registration the host answered, an unreadable one included.** The file is
there, so it is a registration, and a badge that left it out would disagree with the cards below
it. There is no singular form — *registered* does not pluralise — and it is absent rather than `0`.

**The copy for the four quiet states, as shipped.** This section settled the words for two of them
and only the treatment for the others:

| The state | What it says |
| --- | --- |
| nothing yet | *Reading what is registered on this host.* |
| nothing registered, and no projects root | **No projects registered** — *A project is registered when someone runs `rover init` in its own directory on this host. Nothing is registered here yet.* |
| the root cannot be read | **`PROJECTS ROOT NOT READABLE`** — *Rover cannot see into this host's projects directory. Something is there and the host will not read it.* + *This is not the same as no projects being registered — registrations may well be here.* |
| a registration that will not parse | **`CONFIGURATION NOT READABLE`** — *This is not the same as a project that declares nothing — the file is there and the host cannot read it.* |

The two root states share no phrase, and neither does the card pair, which is how D6 is held rather
than hoped for: `projects.test.tsx` and `project-card.test.tsx` each assert that neither of a pair's
copy ever appears in the other, the way `archive.test.tsx` and `devices.test.tsx` already do.

**`PROJECTS ROOT NOT READABLE` takes `EyeOff`**, matching `ArchiveNotReadable`: it is the same fact
one level up — a directory the host cannot see into — so it takes the same glyph rather than a new
one. `rover init` is the one command in this copy and is set in the monospace face.

---

## 11. What is not designed yet

Two lists, and the difference between them matters. The first must exist as a Stitch design before
anyone builds it, because getting it wrong is expensive and the mistakes are not obvious. The
second is left to whoever implements it, working from this document — a design round would cost
more than it would settle.

### Design these first

Nothing, at present. The `Projects` screen was the one entry here and it is **done** — two rounds,
shell then content, settled in §10. It earned a design round for a reason worth keeping, because it
is the test to apply to the next candidate: it was the first screen whose rows are *configuration*
rather than hardware or artifacts, and the two mistakes available were expensive and not obvious —
making a read-only screen look like a form, and making a broken file look like a failure of the
panel rather than a fact about the host. A screen with no such pair of traps belongs in the third
list, not this one.

### Open, and not blocking anything

- **The three font families are loaded from Google Fonts over the network** (#111). On a host with
  no internet the panel falls back to system faces — legible, and wrong. Self-hosting them through
  `@fontsource` is the fix and has not been done; it is worth doing in the change that first serves
  the panel from the daemon, since that is when a Rover host stops being assumed to be online.

### Leave these to whoever implements them

Build them in keeping with everything above — the palette and tokens, no looping animation, the
uniform refusal, the vocabulary — and **write what you settled back into this document** (see the
top of this file). Do not commission a Stitch screen for them.

- **The `Projects` screen's four states with nothing to list — done, in §10, and built** (#157).
  The populated screen had a Stitch design and these did not, exactly as the Archive's root level
  and empty-ish states did not (below), and they were settled from this document instead. What they
  settled is written into §10 above: `listed`-but-empty and `missing` render **alike**, which is the
  Archive's own fold one level up, while *nothing registered* and *root not readable* must never
  render alike (D6). Their copy as shipped is in §10's *As built*, and `projects.test.tsx` asserts
  that neither of the pair's words ever appears in the other.
- **The "no view" state with an *empty* list — done** (#113). It was built from this document rather
  than from a Stitch screen, exactly as this list intends, and what it settled is written into §7
  above. Left named here so the next reader can see that the method worked once.
- **The force-release action's three outcomes — done** (#122). Built from this document, and what
  they settled is written into §7 above, together with the fourth case the issue did not name: the
  request that reached nothing, which released nothing and says so.
- **The Archive screen's root level, and its three states with nothing to browse — done** (#132).
  The three levels had approved screens; the root level and the empty-ish states did not, and were
  built from this document as this list intends. What they settled is written into §9 above.
- **The Archive screen's two views, and the group-first arrangement in the second — done** (#165,
  #181). Neither had an approved screen and neither was commissioned one, and both belong here for
  the same reason: by the time either was built, the row anatomy, the card, the shell, the split and
  the empty states were all already settled in §9, so a design round would have re-derived what §9
  fixes and settled only a level vocabulary — which is a table rather than a screen. What they
  settled is written into §9 above: the toggle's frame and colours, the four routes and why the
  view is an address, the group-first level table, what is deliberately absent from it, and its
  three empty-handed answers. The label badges inside that view were settled the same way and are
  built (#182, #197, #200, #206) — they are a palette and a number, and the third-list test applied
  to them too.
- **The groups view's comparison card — done** (#199). It belongs here for the reason the two
  entries above it do, with one difference worth writing down: this one *had* a screen, and it was
  used as a **layout reference only**. `Compare — Visual Diff (V2)` is the one remaining uncorrected
  screen (below) and the operator decided not to run a correction round for this work, so the layout
  came from it and everything else from §9 and the corrected Archive screens — and the screen's
  listed problems became the list of what was deliberately not reproduced. What it settled is written
  into §9 above: when the card is drawn and when the single preview still is, one pane per labelled
  artifact and why, *oldest on the left* as this screen's one order exception and why it is a sort,
  the pane floor with the widths it was measured at, the pane's anatomy, the shared body view, and
- **The Archive preview's rules, and what it deliberately does not offer — done** (#133). They were
  settled here by #131, before there was a screen, and settling them at that point was deliberate:
  #131 is what made them decisions about the *host's answer* rather than about one panel's markup.
  The screen was then built from them, and **what it settled is written into §9 above** — the
  equal-halves layout and why a pinned preview was reversed, the clean region, the honest fourth
  body, and the two costs of an authenticated byte route. **The tree's absence while a file is open,
  and the back arrow it made necessary, were both reversed by #160** and are recorded there in
  place. The five rules below stand as written and are what §9 implements.

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
(`897632dcadce44de9bdee74a94da14f5`) — and the code no longer waits on its correction** (#199). The
operator decided not to run a correction round for the comparison card, so the card was built from
§9 with this screen as a **layout reference only**, and the known problems listed below are exactly
the list of what was not reproduced. What a correction round would still buy is a corrected screen
in the project; nothing in the panel is blocked on one. The Archive screens were corrected and are
settled in §9; this one was not. `Run Detail — Artifacts (V2)` (`36b54fbe032449d8a300ea0825bbf1c8`) was the other,
and it is **retired by #133** rather than waiting for a correction: the preview beside the run does
everything it was for (§9). Known problems with the remaining one, from a first pass: pass/fail
semantics are back (a `SUCCESS` chip, `PASS` in a log, green ticks and red crosses beside runs in the
tree, the words "Visual Regression"); it carries a **second navigation** — a top bar duplicating the
sidebar — with a global `FORCE_RELEASE` button that has nothing to act on outside Devices; `Profile`
sits mid-sidebar instead of pinned at the foot; and the breadcrumb is used as a label rather than as
a path.

- **The `System` screen — done, in §13, and built** (2026-09-08, no issue). It belongs in *this* list rather than in
  the first, and the operator's instruction to design it here is only half the reason; the other
  half is the first list's own test. That test asks whether the screen has a pair of expensive,
  non-obvious traps, and the `Projects` round earned its design because it did: *making a read-only
  screen look like a form*, and *making a broken file look like a failure of the panel*. This screen
  has one trap and it is the mirror of the first — **making a form that stores nothing look like it
  saves** — and it is neither non-obvious nor expensive to avoid, because §11's own rule about a
  control on an unbuilt destination already answers it. So: two fields, no `Save`, and the fact
  stated under them.

- **Destinations that lead nowhere yet — none, as of the `System` screen (2026-09-08).** The entry above this list's opening
  recorded three (`Archive`, `System`, `Profile`); each has since been built, `System` last. What
  survives is the *unknown address*, which keeps the shared component and its own closing line —
  and the `NOT_BUILT_YET` wording is gone with its last caller rather than kept as a spare part.

---

## 12. Working with Stitch — what actually happens

- **One region per prompt, and iterate. A prompt that asks for a whole screen comes back partly
  ignored, and it does not say which part it dropped.** The Projects screen's first generation
  (`74633a3b3d39445a8dedd0de97c2cc2b`) was asked for in one prompt covering the shell, the card
  anatomy, four cards' contents and a list of forbidden elements. The content area came back close
  to what was asked; **the shell was rebuilt from scratch** and wrong in eight places at once — a
  `fixed` sidebar with an `ml-64` on `<main>` (§4's single worst bug, reproduced verbatim), a
  `memory` glyph for `Devices` and `settings` for `System`, an invented `memory` icon beside the
  wordmark, the wordmark itself reduced from `display-lg` to a label-caps `<h1>`, every nav label
  set in caps, the active item drawn as a left border bar instead of the tactile offset, the
  describing line promoted to an `<h2>` the panel has no heading level for, and the header rule
  moved off the header row onto a `<div>` of its own. **None of that was asked for**, and the
  prompt's own instruction to reuse the reference shell verbatim did not survive the length of the
  prompt. So: one region per round, the literal markup to replace (below), and re-read the file
  before the next round.
- **Whether a correction lands in place or as a new screen is not predictable, so check both.** §7
  recorded the new-screen case once, for the empty Devices state. The Projects rounds gave one of
  each, back to back. The **shell** round landed as a new screen: `get_screen` on `74633a…`
  answered with the **same `file id` and a byte-identical file** afterwards, so read on its own it
  looked like an edit that had never happened — while the corrected screen sat beside it under a
  new id and the title `Projects — Final Alignment`. The **content** round on that same screen then
  landed **in place**, with a new `file id` under the id it was asked for. So: after every round,
  re-read the id *and* look for a new screen, and never carry an id forward on the assumption it
  was edited in place.
- **`list_screens` is not a complete inventory.** `74633a3b3d39445a8dedd0de97c2cc2b` is absent from
  it — in the listing taken right after that screen was superseded and in the next one — while
  `get_screen` on that same id still answers with the file and the title. So a screen omitted from
  the listing is not proof it is gone, and the listing is not the place to learn what this project
  holds: **the id written down in §1 is the durable reference**, which is most of why §1's table
  exists. Use `list_screens` to *discover* an id nobody recorded, never to conclude one is dead.
- **A literal-markup prompt does land, and it is the form that does.** The same shell round replaced
  the `<body>` classes, the whole `<nav>`, the whole header block, the `<main>` tag and one content
  class, all in one prompt — every one of them applied, against the eight-way failure the prose
  version produced. Two things came back anyway that the prompt asked it not to add: the reference's
  own `md:hidden` mobile header, with its `settings` icon and its `FORCE RELEASE` button (below in
  this section — it is not portable and #111 dropped it), and `pt-16 md:pt-0` on `<body>` to clear it. Both are
  harmless in a desktop render and neither is reproduced in code.
- **Stitch leaves `data-stitch-orig-*` attributes behind in the markup it edits** — the shell round
  left `data-stitch-orig-opacity="0"` on the `Devices` icon it had just replaced. It is an
  attribute rather than a style, so it renders nothing, but it is editing residue: strip every
  `data-stitch-orig-*` when harvesting, and do not read one as a design intention.
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

---

## 13. The System screen, as settled

The panel's settings destination, and **the first screen in this document with no Stitch design
behind it at all** — the operator asked for it to be designed here (`ai/RULES.md` §8). §11's third
list records why that is admissible rather than a shortcut, and this section is what a design round
would otherwise have produced: the arrangement, the wording, and the two things the screen must not
do.

It answers one question — **what is this host allowed to keep?** — and it holds two settings and
nothing else yet, in one card headed `ARCHIVE SETTINGS`.

**The card is the device card's anatomy**, which is `ContentsCard`'s too: the title in a header
strip of its own — `bg-surface-container-high` above a `border-b-2`, in the tree card's
`DIRECTORY` heading step — and the body beneath it. Reused rather than re-invented, because a card
that says what it holds in a strip is what every other card in this panel already is, and a title
floating inside the body would make this the one that is not. **At the other end of that strip is
what the archive already takes on disk** (#260, below), which is the row the Archive's own cards
already are.

**Inside the body the order is a decision**: the two notes, a subtle rule, then the fields. The
notes say what the card is *for*, so they are read before the numbers they are about rather than
discovered underneath them — and the rule is the **1px** `border-outline-variant` weight an archive
row and the device card's lease panel already use inside a card, never the structural `border-b-2`
that carries this card's own strip. The lighter one separates what the card says from what it lets
you set; the heavier one there would read as two cards inside one border. It is an `<hr>` rather
than a styled `<div>`, because prose above and controls below is a real break rather than a
decorative one.

### It is `System`, not a new `Settings` item

§3 settles four destinations and says in as many words that *`System` stands in for settings*; the
placeholder this replaces promised *the host's own settings will be shown here*. So this fills that
promise rather than adding a fifth item beside it, because two doors to one room is the failure that
arrangement cannot survive — a reader who finds `Settings` will wonder what `System` is, and a reader
who finds `System` will wonder where the settings went. Renaming the destination is a §3 decision and
a one-line edit if the operator ever wants it; nothing in the screen assumes either answer. The
`Terminal` glyph is unchanged, and the cog §3 rejected stays rejected: it was rejected for promising
the write D31 refuses on the *Projects* screen, and nothing here changes that.

### Two settings, one card, because they are one rule with two bounds

| Setting | Unit | Default | What it does |
| --- | --- | --- | --- |
| Disk space for test data | MB, a whole number | `1024` (1 GiB) | Rover deletes the oldest tests first once the archive passes this size |
| Delete tests after | days, a whole number | `30` | A test this old goes even if the disk budget is nowhere near reached |

**Both, rather than either.** A budget alone lets a quiet month keep everything forever; an age alone
lets a busy week fill the disk inside the window. **Whichever is reached first is the one that acts**,
and that sentence sits once under the pair rather than half in each field's own line, where a reader
would have to assemble it.

**The `Keep` tick is named on this screen**, as the exemption from both (§9). It is the one thing a
reader cannot work out from here, and the word is drawn in the same `tertiary` the tick itself uses.

**The defaults are round figures and not fractions of anything.** This panel cannot see how large the
host's disk is, so a percentage would be arithmetic off a number nobody sent (D19). `1024` is
written as a count of MB rather than as `1 GB` because the setting *is* an integer count of
megabytes — the host will be handed a number, not a unit to parse.

**And the budget default is deliberately small.** Of the two ways a default can be wrong, one is
recoverable and the other is not: a gigabyte deletes runs an operator might have kept, which they
fix by raising the number and which the `Keep` tick already covers for the runs that matter, while a
generous default fills the disk the host needs in order to work at all. It is the operator's number
to raise.

### The field, and why it is not `type="number"`

A caps label, the sign-in screen's own input, the unit as text **after** the value, and one line
under it saying what the number does.

- **`type="text"` with `inputMode="numeric"`, and digits enforced on the way in.** A number input
  accepts `e` and `-` in some browsers, hands back an empty string for anything it dislikes —
  losing what was typed — and brings a spinner this design has no styling for. So the field cannot
  hold `1.5`, `-30` or a pasted `12 MB` at all, which makes the invalid state unrepresentable
  rather than validated afterwards.
- **The unit is beside the field, not in it.** It is not part of the value, and it is `aria-hidden`
  because the label already names the setting — a screen reader reading *MB* as part of the field's
  name would turn that name into a sentence.
- **An unfinished field says what is missing, in words.** Cleared or left at zero it is not an
  error and is not dressed as one: `error` is this palette's critical step (§5) and nothing has gone
  wrong. Zero is *keep nothing*, which no operator sets on purpose, so it is *not a setting yet*
  rather than a value — and the line under the field is replaced by the one thing a reader can act
  on.

### There is no `Save`, and nothing is stored

*Corrected in place, 2026-09-08 (#238, and again for #246).* **Rover has a retention mechanism
now, it runs unattended, and this screen still cannot write to it.** The host holds the two numbers
in its own environment — `ROVER_ARTIFACTS_BUDGET_MB` and `ROVER_ARTIFACTS_MAX_AGE_DAYS`, whose
defaults are the `1024` and `30` in the table above, held equal to them by a test — and three
things run them over the archive: `sweep_archive` when an operator asks, a lease's end for the
budget alone, and a clock for both bounds at local midnight and at daemon start (`PROJECT.md` D37,
D38). What is *unchanged* through all of that is the half this section is actually about: **no
method takes either number**, so there is nothing on the host for a `Save` to write. So the draft still lives in React
state and ends with the mount (`panel/src/system/retention-settings.ts`) — a number that survived a
reload would look like a setting the host had been told about, and the operator would have
configured nothing.

**What this section said before** was that nothing sweeps the archive either. That was true until
the sweep landed and is the one clause that had to move — twice, in fact: first when the mechanism
arrived and again when it stopped needing to be asked (#246), which is the last of that wording
anywhere. The *reason* it gave is untouched through both, and it is why the fields still have no
button. The sentence under them moved with it — see below.

**The `Keep` tick was the other half of that pair and no longer is** (corrected in place, #237): it
was React state for this exact reason until the host had somewhere to put it, and since #234 it has
one, so a tick survives a reload and a daemon restart while these two numbers still do not. What
separates them is a host method, which is the only thing that ever separated them.

**A `Save` control is therefore not drawn, and not a disabled one either.** §11 already answers this
for a destination that is not built: *there is nothing here to do yet, and a button would be the
first thing to lie about that*. The fields are editable anyway, because a form nobody can type into
says nothing about whether the design is right.

**What the screen says instead** is two quiet lines under the fields — the pair's own rule, then
*These two numbers are not saved anywhere: the host reads its own, from its own environment, and no
method here can set them.* Ordinary text in the quiet step: no banner, no warning colour, no icon
of alarm, no `role="alert"` (§7). One of those two lines is temporary and comes out if a host
method for writing them ever lands; the other is permanent.

*Corrected in place, 2026-09-08 (#238).* That second line used to read *Nothing is stored yet.
Rover has no retention mechanism, so these two numbers are not saved anywhere and nothing on this
host is sweeping the archive.* Half of it is still true — nothing here saves them — and half of it
stopped being true the day the sweep landed. The replacement keeps the true half and drops the
other rather than softening it, because a screen that hedges about whether the host deletes an
operator's runs is worse than one that is simply out of date.

**Both lines take the card's full width**, not the prose measure the field copy wraps at, and both
sit under the title rather than under the fields — see the arrangement above.

**And the `CalmNotice` is gone from this route.** The screen is not empty any more — it has the two
fields — so *not built yet* would now be false of it, and the one temporary fact belongs beside the
fields it is about rather than in a panel above them.

### What the archive already takes (#259, #260)

A badge at the right end of the header strip, opposite the title:

```
┌─ ARCHIVE SETTINGS ──────────────────── All tests take 7.7 MB on disk ─┐
│  Whichever of the two is reached first is the one that acts. …        │
```

**In the strip, because it is a fact about the host's disk and not the value of either field.**
Beside the disk field it would read as that field's own figure and invite exactly the `X of Y`
comparison the list below refuses; in the strip it is what the card is *about* — which is where the
Archive's own cards put the `Keep` tick (§9). It is the strip's second child and the title's
opposite, and it wraps under the title rather than crowding it once the sentence outgrows the row.

**One pill and one sentence, and both are the Archive header's.** `HeaderBadge` draws it — the
third badge on that one component, so two screens cannot drift apart by a border width — and the
words are `sizeSentence`'s `archive` scope, which is what the Archive screen says at its own root
over the same walk of the same directory. **`All tests take 7.7 MB on disk` is the wording, and
`Tests take …` is what it was weighed against**: the operator proposed the shorter one for this
card, and the longer one won because *all* is what holds the archive's root apart from the groups
view's `Grouped tests take …` over a subset of it (§9). One number with two phrasings on two
screens is drift rather than variety, so there is one table of words and this screen is one more
reader of it.

**The unit steps by itself and the field's does not.** `formatBytes` is 1024-based and moves to `GB`
above 1024 MB, so the card may read `1024` MB in the field and `1.4 GB` in the badge at the same
time. That mismatch is **accepted rather than fixed**: the setting *is* an integer count of
megabytes because the host is handed a number and not a unit to parse (above), while the badge is a
measurement for a person to read. A reader comparing the two converts in their head, which is the
trade this takes in exchange for a figure nobody has to read as seven digits. It is **not** the
units toggle the list below rejects, and that row is amended in place to say so: nothing here lets
a reader choose a unit.

**Absent rather than invented, and #259's honesty rules unchanged.** While the answer is still out,
and where nothing is filed at all, no badge is drawn — no placeholder figure, no `0`, no `—`. A
walk that was cut short renders `All tests take at least 7.7 MB on disk`, because a total from a
bounded walk is not a total; and a size the host could not take gets *The host could not measure
what all tests take on disk* rather than the word `unknown` dropped into the value slot. All three
are §9's rules over the same answer, kept by drawing the same sentence rather than by restating
them.

### What is deliberately absent

- **No `Save`, no `Apply`, no `Reset`** — see above. Nothing to write to.
- **No *`X of Y`*, which is what is left of *no current usage figure*.** *Corrected in place,
  2026-09-09 (#260), with its reasoning rewritten rather than deleted (`ai/RULES.md` §1).* This row
  refused a usage figure outright, and it named the exact condition that would end it: *no answer
  carries the archive's size **or its budget***, so anything drawn here would be a browser's
  arithmetic over a bounded directory walk presented as a fact (D19, and §9's rule that nothing on
  the archive screen is invented). **One half of that condition has been met and the other has
  not.** `measure_archive` has carried the archive's size since #259 — with its own truncation and
  unmeasurable outcomes, so the honesty the row was protecting is in the answer rather than in the
  absence — and the badge above draws it. No answer carries the **budget**, because the number in
  the field is a draft nobody has saved and nothing writes it anywhere. So *Using 3.4 GB of 10 GB*
  stays absent for precisely the reason it always was: the `of 10 GB` half would present a typed-in
  number as the bound the sweep enforces. With it go every percentage, every progress bar and every
  *over budget* colour or word — the sweep's own over-budget case is the sweep's, and it says so in
  the host's log (#238). `sweep_archive` still deliberately carries neither setting, so **neither
  the sweep landing nor its two unattended triggers changed this row** (#238, #245, #246) and they
  are not what changed it now. When a method takes these two numbers the comparison becomes
  possible, and it is a decision of its own then rather than the completion of this one.
- **No preview of what would be deleted.** *Corrected in place, 2026-09-08 (#238): the sweep does
  exist now and can be asked what it would take* — `sweep_archive` takes a `dryRun`. **And it now
  runs whether anybody previews it or not** (#245, #246), which makes a preview here more
  tempting rather than less and changes nothing about the objection. What keeps this absent is that
  the method is **not on `PANEL_METHODS`**, and that is not an oversight to fill in:
  the same call with `dryRun: false` deletes an operator's runs permanently, so a browser is not
  where it belongs while D27's role model is still deferred. A preview control here would be one
  boolean away from the destructive form. It is reached from the CLI (`rover sweep --dry-run`).
- **No units toggle**, no GB/MB switch — **and the badge above is not one** (amended in place,
  #260). The setting is a count of megabytes and stays one. What the badge renders is a
  *measurement*, and its unit is picked from the bytes by `formatBytes` rather than by anybody at
  the keyboard. What this row refuses is a **control**: a switch is a second place a number can be
  wrong, and a formatter that answers the same way for the same bytes on both screens is not.
- **Nothing about the daemon, the host's ports, the users or the projects root.** They are settings
  in the ordinary sense and none of them is writable from a browser (D31, D27's deferred role
  model). When any of them becomes readable here it is a second card on this screen, not a rewrite
  of this one.
