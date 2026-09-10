# Rover

**Your coding agent can build your mobile app but not look at it — Rover gives it hands and
eyes on a real Android phone or iOS simulator.**

<img width="1166" height="612" alt="rover1" src="https://github.com/user-attachments/assets/65dd14f2-e776-4042-a8e9-505b21cd8c6a" />

<br>

It taps, swipes, types, waits for something to appear, screenshots it, reads the view hierarchy,
records video, reads the logs, installs and launches the build, and toggles wifi and airplane
mode — as twenty-five MCP tools, or from the CLI when you would rather drive it yourself.

A daemon on the machine holding the devices lends them out one lease at a time, so two agents —
here or on another machine — never end up driving the same phone.

## Features

- **Both platforms, one set of verbs.** Android phones and emulators over `adb` and iOS simulators
  over `simctl` answer the same `tap`, `read_screen` and `screenshot`, and a verb a device cannot
  perform fails **by name** rather than returning a plausible-looking empty answer.
- **A web panel for the operator.** Live device cards with a lease countdown that ticks down and
  goes back up when the holder renews, one control to force-release a stuck lease, and a file
  explorer over the archive with one field that searches every run on the host.
- **Every run is archived.** The host keeps its own copy of what a lease produced — screenshots,
  recordings and their frames, logs, and the device it all ran on — and prunes itself against a
  disk budget and an age limit with nobody typing anything.
- **Before-and-after comparisons.** Name the investigation on the lease and label the captures, and
  the run before your change and the run after it are filed side by side — the panel draws them as
  two panes and, when you ask, marks where the second one differs.
- **Devices shared rather than fought over.** A lease is renewed by activity rather than by a
  heartbeat — so an agent that pauses to think keeps its device and one that died lets go on its
  own — and the host restores the device whenever it ends.
- **Devices on somebody else's machine.** A host can be exposed over TLS with one token per person,
  so the laptop with the phones on the desk lends them to agents working elsewhere.

Rover moves the device and reports what is on it. It is **not** a test framework — nothing
asserts, nothing turns red on its own, nothing is a CI gate — and judging whether what came back is
right stays the agent's job.

## Quick installation

```bash
git clone git@github.com:SmartTechBrewery/rover.git
cd rover
npm install
npm link
```

Once per project you work on:

```bash
cd ~/Projects/my-app
rover init --write
git add -A && git commit -m "chore: set up Rover"   # .mcp.json, ROVER.md and the agent notes
```

Nothing to start by hand afterwards — the first command that asks for a device brings the host up
itself.

```bash
rover status    # which host answered
rover list      # what is attached, what is free, and who holds what
rover doctor    # the programs that host needs, and where it found them
```

On a Mac lending **iOS simulators**, one more program:

```bash
rover doctor --fix --actor "$(whoami)"
```

The **web panel** is two halves — the host answers the data, `rover panel` serves the page — so it
is two terminals:

```bash
rover users add panel                 # the browser's own credential, printed once
ROVER_HTTP_PORT=4712 rover server     # one terminal
rover panel                           # another, on :5174
```

## Using it

You ask the agent, not Rover. The everyday case is one sentence:

> Install my branch on the device and tell me whether the empty-cart state still renders.

And the one this is really for — did the refactor change anything on screen:

> Screenshot the checkout screen on `main` and again on `refactor/checkout`, then compare the two.
> I expect no changes; the refactor shouldn't have touched the UI.

The agent files both runs under one testing group, and the panel's *Testing groups* view draws
them as two panes with the differences marked. Whether a difference is a regression is yours to
say.

## Documentation

Everything else — the walk-throughs, the configuration reference, the project hooks, the artifact
archive, the web panel and the state of what is built — is in
[`docs/MANUAL.md`](docs/MANUAL.md).
