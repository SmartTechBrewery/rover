# Rover

<img width="1166" height="612" alt="rover1" src="https://github.com/user-attachments/assets/65dd14f2-e776-4042-a8e9-505b21cd8c6a" />


**Hands and eyes on a real mobile device, for coding agents** — and a way to share those devices
between several agents working at once.

An agent can build your mobile app but cannot look at it. Rover hands it the device: tap, swipe,
type, wait for something to appear, screenshot it, read the view hierarchy, record video, read the
logs, install and launch the app, toggle wifi and airplane mode. A daemon on the machine holding
the devices lends them out one lease at a time, so two agents — on this machine or on another one
— never end up driving the same phone.

**Android and iOS, and the setup is a clone and two commands.** `npm install`, `npm link`, then
`rover init --write` inside the project you are working on: that writes the MCP server into
`.mcp.json`, the page an agent reads before its first call, and a line in `CLAUDE.md` /
`AGENTS.md` / `GEMINI.md` saying that a manual test means Rover. There is nothing to start by hand
afterwards — the first command that asks for a device brings the host up itself.

## What you get

- **Both platforms, one set of verbs.** Android phones and emulators over `adb`; on a Mac, **iOS
  simulators** over `simctl`, with `idb_companion` beside it for the screen read and the input
  verbs. The same `tap`, `read_screen` and `screenshot` in both places — no verb is named after a
  platform — and `rover doctor --fix` installs the one extra program the simulator side needs.
- **Twenty-five tools over MCP**, and the same surface from a CLI when you would rather drive it
  yourself. A screenshot comes back to the model **inline**, as an image it looks at directly; a
  recording comes back as frames plus an mp4 written on the agent's own machine.
- **Devices shared rather than fought over.** A lease grants one device to one named owner, is
  renewed by activity rather than by a heartbeat — so an agent that pauses to think keeps its
  device and one that died lets go on its own — and the host restores the device when it ends,
  however it ends: recording stopped, the project's apps stopped, airplane mode off, wifi back on.
  A busy device answers with who holds it and for how much longer, never with an error.
- **Devices on somebody else's machine.** A host can be exposed over TLS with per-user tokens, so
  the laptop with the phones on the desk lends them to agents working elsewhere.
- **Every run is archived.** The host keeps its own copy of what a lease produced, filed under
  `<project>/<test-name>/<run>` — screenshots, recordings and their frames, logs, and the device it
  all ran on — so a run from last week is still there to look at. It prunes itself against a disk
  budget and an age limit with nobody typing anything, and `rover keep` pins the tests that must
  survive that.
- **Before-and-after comparisons.** Name the investigation on the lease and label the captures:
  the run before your change and the run after it are filed side by side under one group, with the
  matching screenshots carrying the same label, and the panel has a whole view arranged that way.
- **Search over everything ever filed.** The panel's archive carries one field that searches the
  whole archive on the host and draws every match in place in the tree; the CLI walks the same tree
  a level at a time.
- **A web panel for the operator.** Live device cards with a lease countdown that ticks down and
  goes back up when the holder renews, one control to force-release a stuck lease, and a file
  explorer over the archive that previews images, recordings and logs in the browser.
- **Deterministic by construction.** A target resolves from a screen captured *inside* the call,
  never from a coordinate remembered a turn ago; waiting is on a condition with a timeout and there
  is no `sleep` anywhere in the repository; every action answers with the state after itself. Two
  elements matching one target is a loud error naming both, and a verb a device cannot perform
  fails **by name** rather than returning a plausible-looking empty answer.

Rover moves the device and reports what is on it. It is **not** a test framework — nothing
asserts, nothing turns red on its own, nothing is a CI gate — and judging whether what came back is
right stays the agent's job.

## Quick installation

```bash
git clone git@github.com:SmartTechBrewery/rover.git
cd rover
npm install     # installs the git hooks, and checks this machine has an adb Rover can run
npm link        # puts `rover` on your PATH, running this checkout
```

Skip `npm link` and every `rover` below is typed `npm run rover --` from inside this checkout —
except `rover init`, which has to run in *another* project's directory.

### On a mac lending iOS simulators

Simulators are macOS-only and so is this step — off macOS Rover looks for none of it. One more
program: `read_screen` and all four input verbs go through `idb_companion`, which has no package
manager and no installer, so Rover keeps its own:

```bash
rover doctor --fix --actor "$(whoami)"
```

That downloads a pinned release **on the host**, checks it against the checksum the release
publishes, and unpacks it under that host's `~/.rover`, where the search looks last — so there is
no `PATH` to arrange and no variable to export. Run it twice and it downloads nothing the second
time. Without `--fix` it only reports.

Already have a companion, or on an Intel mac the release has no build for? Point Rover at it with
`ROVER_IDB_COMPANION_PATH` and yours wins over anything Rover installed — see [where Rover looks
for `idb_companion`](docs/MANUAL.md#where-rover-looks-for-idb_companion).

### Once per project

```bash
cd ~/Projects/my-app
rover init --write
```

| Where | What |
| --- | --- |
| `~/.rover/projects/my-app.json` | the project's hook file — what the host installs and stops for a lease on it (D13), detected from a Gradle wrapper where there is one |
| `my-app/.mcp.json` | the `rover` MCP server, merged into whatever was already there |
| `my-app/ROVER.md` | the page an agent reads before its first call. Generated — re-run `init` rather than editing it, and move it wherever it belongs |
| `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` | a short block saying that a manual test means Rover. `--write` inserts it; without the flag it is printed |

Nothing there asks a host, so it needs no daemon and no device. `rover init --help` has the flags.

### Check the wiring

```bash
rover status    # which host answered, its pid and uptime
rover list      # what is attached, what is free, and who holds what
rover doctor    # the programs that host needs, and where it found them
```

Nothing to start by hand — the first command that asks a host brings the daemon up (D5).

### The host, and the panel

Start the host yourself when you want to watch its log, or when it has to be reachable — an
autostarted one deliberately listens to nothing but this machine:

```bash
rover server                          # the host, in the foreground; Ctrl-C stops it
```

The web panel needs **both** commands, because they are two halves: the host answers the data, and
`rover panel` only serves the page. Two terminals:

```bash
rover users add panel                 # the browser's own credential, printed once
ROVER_HTTP_PORT=4712 rover server     # one terminal — the data
rover panel                           # another — the page, on :5174
```

Same variable in both halves, so there is one number to keep in step. Leave `ROVER_HTTP_PORT`
unset and the host serves no browser at all.

## Documentation

Everything else — the walk-throughs, the configuration reference, the project hooks, the artifact
archive, the web panel and the state of what is built — is in
[`docs/MANUAL.md`](docs/MANUAL.md).
