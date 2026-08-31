# Initial design prompt — the web panel's first four screens

The prompt handed to an AI design tool (Stitch) to produce the first visual designs for the
web panel. It covers screens 1–4 of the first batch only; the full running list of
what the panel eventually needs is [`WEB_PANEL.md`](./WEB_PANEL.md).

**Nothing here is a decision or a backlog row**, exactly as `WEB_PANEL.md` says of itself:
`PROJECT.md` §7 still excludes a dashboard from scope, and commissioning designs does not
change that. Each screen becomes an issue the same way every `PROJECT.md` §9.3 row does — an
outcome, a scope boundary, dependencies and a size — before anything is built.

## What this prompt deliberately does and does not do

- **It describes function and content, never layout.** No sidebar, table, card or grid is named,
  so the design tool proposes the visual language itself.
- **It never calls a run a "test".** Rover is not a test framework (`README.md`, `PROJECT.md`
  §7), so the prompt states that twice and explicitly forbids pass/fail badges and status
  columns. `test name` survives only because that is the field's real name (D22), and the prompt
  says outright that it does not mean a test.
- **It covers four screens, not eleven.** `WEB_PANEL.md` items 1, 8, 10 and 11 (login, host user
  management, retention, MCP config generator) are left out of this batch: they are conventional
  forms, and retention is not even a settled decision yet (§9.4).
- **It omits a projects/settings/profile navigation.** A `project` is an opaque caller-supplied
  string (D22), not an entity with its own screen; panel settings do not exist yet; and the
  profile screen belongs to `WEB_PANEL.md` item 8, whose credential model is still open. The
  prompt asks only for whatever shared navigation ties the four screens together.

## Which decisions each screen rests on

| Screen | `WEB_PANEL.md` | `PROJECT.md` |
| --- | --- | --- |
| 1 — Devices and live leases | 3, 6, 7 | D6, D7, D8, D18, D20, D21 |
| 2 — Archive browsing | 5 | D22, D23, D24, §10 |
| 3 — Run detail | 5 | D14, D19, D23, §10 |
| 4 — Compare (before/after) | 9 | D22, D24 |

---

## What has since been superseded

**The prompt below is a record of what was sent, and is reproduced verbatim — including the parts
that are no longer true.** Two of its statements have been overtaken:

- **"The panel is READ-ONLY, with exactly one action in it."** It is not read-only. `PROJECT.md`
  D27 settles what it may do: actions that are an authority over the shared device pool, of which
  force-release is the first and not necessarily the last. Acquiring a device remains excluded, for
  the reason D27 gives.
- **"whatever shared navigation ties the four screens together."** That navigation is settled now
  and is not open to reinvention per screen. [`DESIGN.md`](./DESIGN.md) carries it, along with
  everything else the Devices screen established.

Everything else in the prompt still holds, in particular that **Rover is not a test framework** —
no pass/fail badge, status colour or success rate belongs anywhere in this UI.

---

## The prompt

```text
I need UI designs for a web panel. Below is what the product does, the screens
I need, and what data each one has. Please design the visual language yourself —
I'm describing function and content, not layout.

## The product

Rover gives AI coding agents hands and eyes on real mobile devices. An agent can
write a mobile app but cannot look at it. Rover taps, scrolls, types, takes
screenshots, reads the view hierarchy, records video, reads logs, installs apps
and toggles the network on physical phones and emulators — and it shares those
devices between several agents working at the same time.

A background service runs on the one machine the phones are plugged into. It keeps
a single inventory of that machine's devices, so two agents never end up driving
the same phone. An agent takes a device on a time-limited "lease", works, and
releases it.

Rover is NOT a test framework. Nothing asserts, nothing passes or fails, nothing
turns red on its own. It moves the device and reports what it saw; deciding whether
that was correct is the agent's job. So: no pass/fail badges, no green/red status
columns, no success rates anywhere in this design. There is no "test result" object.

The panel is READ-ONLY, with exactly one action in it: force-releasing a stuck lease.
No forms, no editing, no create/delete flows.

## Vocabulary (please use these words in the UI)

- Device — a phone or emulator attached to the machine. Identified by a serial
  like "emulator-5554" or "R5CT10ABCDE".
- Lease — one agent's temporary hold on one device. Carries an owner, a project,
  an optional test name, and expires on its own after 20 minutes unless activity
  renews it.
- Owner — free text saying who holds it, e.g. "issue-112" or "pr-127-review".
- Project — free text grouping work, e.g. "checkout-app".
- Test name — free text labelling what was being exercised, e.g. "home screen".
  Deliberately NOT unique: the same name recurs across runs on purpose, so two runs
  of the same scenario can be compared before and after a code change.
- Run — everything one lease produced, archived on the machine after it ended.
- Artifact — a screenshot, a video recording, extracted video frames, or a log dump.

## Screens

### 1. Home — devices and live leases

The default view. Answers two questions: is a device free right now, and who is
holding the rest and for how long.

Per device: serial, platform (Android for now), model name, state, and either "free"
or the lease holding it. For a held device also: owner, project, test name (may be
absent), when the lease was granted, and a live countdown to expiry — this ticks
down in real time and renews when the agent is active.

The one action: force-release a lease before it expires on its own.

Empty state matters: a machine with no devices attached at all is normal and common.
Rover never starts an emulator or plugs in a phone — a human does that — so this
screen must read as "nothing is attached", not as an error.

### 2. Archive — browsing past runs

A three-level hierarchy, browsed as a tree: project, then test name, then the
individual runs under it, newest first.

A run is labelled by when it started, who owned it, and a short identifier, e.g.
"2026-08-30 17:05 UTC · issue-112 · 9f1c2ab4".

Two things to design for. Runs with no test name are grouped under "unlabeled".
And this archive is never pruned, so a busy machine accumulates thousands of runs —
the browsing and filtering experience should assume a large tree, not a demo with
five entries.

### 3. Run detail — one run's artifacts

Everything a single lease produced, grouped by the device it ran on.

- Device information captured at the time: screen size, pixel density, dp scale,
  OS version.
- Screenshots, in the order they were taken.
- Video recordings, each of which may also have individual frames extracted from it.
- Log dumps, as plain text.

A run may contain nothing at all — a lease that only tapped around produces no
artifacts — and that state should feel intentional rather than broken.

This is the screen where users will spend most of their time, so images deserve
room to breathe and a way to be viewed large.

### 4. Compare — before and after

Two runs of the same test name, shown side by side, so a user can see what changed
between them. Typically the two most recent runs of that name: one from before a code
change and one from after.

The comparison is visual and human-judged. Rover computes no diff and reports no
verdict — the panel puts the two sets of screenshots next to each other and the person
decides.

## Visual direction

Colourful retro — the optimism of late-70s and 80s computing and consumer
electronics. Saturated, characterful palette rather than the muted greys of a typical
developer dashboard. Have fun with it.

Two things it has to survive. The interface is full of dense technical strings —
device serials, UTC timestamps, short hashes, long file names — so whatever type and
colour choices you make must keep those unambiguous and easy to scan. And screenshots
of mobile apps are the main content on two of the four screens, so the surrounding
palette should frame arbitrary screenshot colours without fighting them.

Please design screens 1 through 4 as desktop web pages, plus whatever shared
navigation ties them together.
```
