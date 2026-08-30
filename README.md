# Rover

Hands and eyes on a real mobile device, for coding agents — and a way to share those devices
between several agents working at once.

An agent can build a mobile app but cannot look at it. Rover taps, scrolls, types, screenshots,
reads the view hierarchy, records video and toggles the network, over `adb`. A daemon keeps one
inventory of the machine's devices so two agents never end up driving the same phone.

It is **not** a test framework. Nothing asserts, nothing turns red on its own, nothing is a CI
gate. Rover moves the device and reports what is on it; judging whether that is right is the
agent's job.

## Status

Design and rules are settled. The toolchain and the device-backend contract — the device
interface, the Zod capability manifest and the registry a backend joins through one import — are
in place, and the Android backend is registered. The daemon runs: it binds a unix socket, serves
the schema-checked IPC surface over it, and **starts itself on the first call**, with two
concurrent callers producing exactly one daemon. It now holds a **device inventory** — one entry
per device, fed by each registered backend's change stream, refusing anything attached to another
host — and answers `list_devices` alongside `status`. The inventory is a cache and never the
authority: a lease re-verifies its device against the backend at grant time (`PROJECT.md` D6),
and `list_devices` says `stale` whenever the list is not known to be current.

**Leases work.** `acquire_device` grants one device — not the whole machine — to an explicit
caller-supplied `owner` string, alongside a `project` and an optional `test_name` the host stores
and never inspects. The lease runs on a 20-minute TTL **renewed by activity rather than by a
heartbeat**, so an agent that pauses to think keeps its device and one that died lets go on its
own. A busy device is a refusal that names who holds it and for how much longer, never an error,
and never the holder's lease id; `release_device` hands it back. Five clients asking at once get
exactly one winner. `list_devices` names each device's holder the same way — the owner, project and
test name, and how much longer they have, or nothing at all for a free device — and never the lease
id, which is what ends a lease and belongs only to whoever was granted it.

**The daemon restores the device itself** (D9) — on `release_device` and on expiry alike, from the
one place a lease is observed to end. It stops the project's applications, turns airplane mode off,
turns wifi back on (in that order: `PROJECT.md` §6 records why the wifi step has to be last) and
runs the project's teardown hook. A caller is never asked to do any of it and cannot opt out; a
step that fails is reported and the remaining steps still run — including a project resolver that
throws, which costs that project's own steps and never the device's; and a device is never handed
to the next lessee while its restoration is still in flight. An unref'ed sweep is what notices a
lease whose holder died — such an agent issues no further calls, so nothing else would ever ask —
and shutting the daemon down sweeps once more and then waits, bounded, for whatever it still owes:
leases die with the host, so a restoration abandoned there is one nothing will ever retry. Which
applications a project owns and what its hook does arrive through an injected resolver — the
per-project configuration that fills it is its own issue (`PROJECT.md` §9.3, R17), so today that
resolver answers nothing and only the two network steps have work to do.

**There is a CLI** (D4) — `rover list`, `acquire`, `release` and `status`, human-readable by
default and one JSON document on stdout with `--json`, every diagnostic on stderr. It holds no
verb logic: each command parses flags, calls one IPC method, renders the answer and picks an exit
code. `list` shows what is attached, what is free and who holds the rest — the owner, project and
test name, and how much longer they have — and says out loud when the host does not know its own
view to be current, rather than quietly printing a short list. `acquire` requires an explicit
`--owner` and `--project` and derives neither. `status` says which host answered. The host is named
by `--host`; no flag means the local one, and `local` is the only value reachable until the network
listener lands (`PROJECT.md` R22), so anything else fails loudly instead of hanging.

**Waiting is a condition, never a duration.** `src/core/wait.ts` is the one module in the
repository allowed to construct a delay: `waitForCondition` polls a probe until it reports the
condition met or the deadline passes, and a probe that reports *unmet* is required by its own type
to say what it found instead — so a timeout names both halves (`PROJECT.md` D12). The rule has a
test behind it rather than only a convention: `tests/unit/no-sleep.test.ts` scans `src/` and
`tests/` for every promisified-timer shape a sleep is spelled with, and for a call to
`waitForCondition`'s own poll gap from a file that has not said why it needs one. Only three files
are exempt from the scan. It is a floor, not a proof — a determined re-implementation gets
through, and reading the wait vocabulary is still how you learn what a wait here looks like.

**The verb layer has a spine, four gestures on it and the two waits standing beside it.**
`src/verbs/` is the layer above the backends where determinism stops being a rule and becomes a
signature (D12): `resolveTarget()` takes
a target and *nothing else* — no screen, no element list, no state read a turn ago — so a target can
only ever be resolved from a screen captured inside that call. Two elements matching one text target
is a loud error naming every candidate rather than a first match that is right half the time; nothing
matching names what was on screen instead; and a coordinate stays available as the documented
fallback, marked in the result as not having come from a screen. Every resolved point is
range-checked against the device, whichever way it was arrived at — an element scrolled out of its
container comes back with a rectangle whose corners are inverted, and the midpoint of that is
arithmetic rather than a place to tap, so it is refused by name instead.
`performAction()` is where the three rules meet: it consults the capability manifest **before** it
touches the device, resolves fresh, acts, and then reads the state after the action — and a device
that cannot read its screen answers an explicit "unavailable, and here is the capability that would
have answered" rather than an empty list that reads as a blank screen, while a read that was
attempted and failed says *that*, because an exception after the action has run is the one answer
that leaves the agent guessing whether it landed. Every argument and every
result is a Zod schema of plain data, because the host runs the verb and the agent reads the answer
somewhere else (D19).

**`tap`, `long_press`, `swipe` and `scroll` are that spine used four times** (`src/verbs/input.ts`),
and each of them is one `performAction()` call: not one reads a screen of its own, so a verb author
has nothing to remember and nothing to get wrong. `long_press` is a drag from a point to that same
point, held past the device's own long-press timeout — never the long-press flag on a key event,
which applies to keys and not to touch — and `scroll` is a drag across the middle of a region, so
neither needs anything new from a backend: the device interface keeps its four input primitives and
the composition happens once, above them. `scroll`'s direction is where the **content** goes, the
sense a scrollbar and a wheel already have, so `scroll 'down'` drags *upwards*; it scrolls the
element it was pointed at, or the screen when it was pointed at nothing, and it will not take a
coordinate, because a point has no extent and so cannot say how far a scroll may travel. `swipe` is
the only verb here with two ends: the one it starts from goes through the spine and is what the
result names, and the other is resolved inside the action from its own read. A gesture's duration is
spent by the *device* — it is an argument to the drag, never a wait on this side — which is why
none of these verbs is an exception to the no-sleep rule.

**`wait_for` and `wait_until_gone` stand beside that spine rather than on it** — the vocabulary
that replaces `sleep` rather than the rule that forbids it. They share its answer shape
(`resultAfterAction`) but not its order, because `performAction()` resolves the target *before* it
acts, and for a wait the resolution **is** the work. Both poll to a timeout, and **every poll
reads the screen again**: a wait over one cached read is the stale-coordinate failure with a timer
attached, re-grown inside the verbs meant to remove it. `wait_for` waits until the target is there
*and* somewhere it can be acted on, so an element still clipped out of its scrolling container is
*not yet* rather than a failure — a screen still moving is what a wait is for — while a target two
elements match is refused outright, because more polling cannot specify an under-specified request.
`wait_until_gone` asks the mirror question, and asks it of matches rather than of a resolution: an
element matched twice is still there twice — and for the same reason it will not take a text
target's `index`, since an index names a slot in the match list rather than an element, and a slot
empties the moment any sibling leaves. A timeout names what was waited for and what stood in its
way — the screen for `wait_for`, which missed on all of it, the matches that are still there for
`wait_until_gone` — bounded so a two-hundred-element screen is a message and not a wall, and a
backend that does not declare `canReadScreen` is told so by name before the first poll rather than
after a whole timeout. Both answer with the same `ActionResult` as every other action. The remaining
verbs — `type_text`, `press_key`, `screenshot`, `read_screen` — are their own issues.

**The daemon loads the core and runs the verbs**, and a client only asks (D19). The two waits and
the four gestures are callable over the same connection as `acquire_device` — the same envelope,
the same framing, one method table — and a verb call carries the lease id rather than a serial,
because the lease id is the credential and the host derives the device from it. A verb that fails
comes back as an *answer* naming what happened — the element was not there, the wait timed out, the
device cannot read its screen — and never as a broken host; only the host actually breaking is an
`internal_error`. There is no `adb` in a client process, and
`tests/unit/no-backend-in-a-client.test.ts` walks the import graph from every client entrypoint to
say so rather than asking politely. Against a real device today a `tap` at a coordinate runs on the
hardware, while both waits and anything addressed by text answer `missing-capability`:
`read_screen` is its own issue, and the manifest says so rather than pretending. The backlog is twenty issues in dependency order — see
[`PROJECT.md`](PROJECT.md) §9.3.

```bash
npm run rover -- status              # start the daemon if it is not running, report which host answered
npm run rover -- list                # what is attached, what is free, who holds the rest
npm run rover -- acquire <serial> --owner issue-112 --project rover
npm run rover -- release <lease-id>
npm run rover -- --help              # the four commands, the global flags and the exit codes
npm run daemon                       # run the daemon in the foreground instead, to watch it start
```

`npm run` prints its own banner to stdout ahead of the command, so a script that parses the JSON
uses `npm run -s rover -- list --json` or invokes `node --import tsx/esm src/cli/index.ts list
--json` directly. There is no `bin/` launcher yet — the published entry point is `PROJECT.md` R20's
to settle.

Exit codes: `0` success; `1` the operation did not succeed (a refused `acquire`, a `release` that
found no live lease, an unreachable host, a request the host rejected); `2` usage error (unknown
command or flag, a missing `--owner`/`--project`, an attribution string past the 256 characters
the host accepts, a `--host` nothing can reach yet). A `release`
that found nothing exits `1` on purpose — the host cannot tell "no such id" from "already gone",
and exiting `0` would let a mistyped lease id read as success.

Stopping the daemon is `kill <pid>` on the pid `rover status` printed; it unlinks its socket on
the way out, and the next call brings a new one up.

## Configuration

Host-level settings come from the environment. Every row here mirrors a Zod schema, which is the
source of truth for what a valid value is (`ai/RULES.md` §7) — the daemon and the CLI both fail at
startup, naming the variable and the reason, rather than binding something surprising.

| Variable | Default | Value |
|---|---|---|
| `ROVER_SOCKET_PATH` | `~/.rover/rover.sock` | Absolute path of the unix socket the local daemon binds and a local client connects to. **Empty counts as unset** — an exported-but-blank variable is what a shell leaves behind, and reading it as a real setting would point the daemon at the current directory. At most **103 bytes of UTF-8**: a unix socket address is a fixed-size struct (104 bytes on macOS, 108 on Linux, NUL included), and over the cap `bind` truncates or answers `EINVAL` instead of naming the length, so a longer path is rejected at startup with the byte count and the path. |

While a daemon is coming up over a socket a crashed one left behind, a `<socket>.reclaim` lock file
may briefly appear beside it. It is removed by whoever took it, and any left behind by a killed
process is discarded on age by the next start.

## Where things are

| Document | What it answers |
|---|---|
| [`PROJECT.md`](PROJECT.md) | Why this exists, the sixteen decisions and their reasoning, the verb set, verified adb recipes, the backlog |
| [`ai/RULES.md`](ai/RULES.md) | The single source of truth for agents working in this repo — read it first |
| [`ai/ARCHITECTURE.md`](ai/ARCHITECTURE.md) | The four components, the lease lifecycle, where the iOS seam runs |
| [`ai/CODING_STANDARDS.md`](ai/CODING_STANDARDS.md) | Stack, Zod boundaries, error handling, module shape |
| [`ai/TESTING.md`](ai/TESTING.md) | Vitest, the real-device gate, fixtures, conformance |

In the source tree: `src/core/` holds the device contract and the branded ids, `src/backends/` one
folder per platform, `src/verbs/` the verb spine with the gestures and the waits described above, `src/ipc/` the
wire protocol and the transport-agnostic client and server, `src/daemon/` the socket and the
inventory and the leases, and `src/cli/` the `rover` command.

## Shape

Four parts. A **daemon**, one per machine, owning the device inventory, the leases and state
restoration. A **core** library holding the device abstraction and the verbs. A **CLI**, and an
**MCP server** — one per agent — as two adapters onto that same core.

The daemon exists because two agents have two separate MCP servers that cannot see each other,
while the devices are shared. Without it, an unpinned install reaches every attached device and
one agent screenshots the other's build.

## Working on this repo

Read `ai/RULES.md` in full first. `npm install` sets up the toolchain and installs the git hooks;
`npm run verify` (lint, typecheck, unit tests) is the one command that says whether the tree is
healthy. Issues are filed with `/write-issue` and implemented with
`/solve-issue`; both are committed under `.claude/skills/`. Work is also delegated to
[Swarm](https://github.com/SmartTechBrewery/swarm), which is why every issue carries the `swarm`
label.
