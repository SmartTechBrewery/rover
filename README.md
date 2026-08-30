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

**The verb layer has a spine, seven verbs on it and the two waits standing beside it.**
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
after a whole timeout. Both answer with the same `ActionResult` as every other action, and the
*reading* they poll is real: the Android backend answers `readScreen` and declares
`canReadScreen`, so the reading `read_screen` will expose is already there underneath them.

**`launch_app`, `stop_app` and `clear_app_data` are that same spine used three more times**
(`src/verbs/app.ts`), and they are what a verb looks like when it addresses **a package rather than
something on the screen**: they resolve no target at all, so no screen is read before the action and
the result's target is `null` — a fact about the verb, not a resolution that failed. They need no
capability either, and say so with an explicit empty list: the three backend methods behind them are
*required* ones, and a `canControlApps` flag would be a capability that is always true. So they add
no backend method, no capability and no result shape — the whole family is one module, one params
schema shared by all three, and three rows on the method table. `stop_app` cannot tell "stopped it"
from "there was no such package", because the device is silent either way; the state after the
action is what will answer that once `read_screen` lands, and there is deliberately no probe
pretending otherwise in the meantime.

**`read_logs` is the verb that sees what a screenshot cannot** (`src/verbs/logs.ts`), and it is the
first one whose answer carries a payload of its own: the device's log, parsed into neutral entries —
a timestamp as the device printed it, a level, a tag, a process id and the line — on top of
everything every other verb answers with. An app that crashed and vanished leaves a screen you
cannot tell from someone pressing home, and the log is where the exception is; proved against a real
device, where a crashed app is named in the read while nothing on the screen names it. The read is
**bounded and never follows**: the caller says how many entries, the device's newest are the ones
kept, and `truncated` says when there were more, because a short read that reads as a quiet device
is worse than no read. Following a log would be a wait with no condition and a stream over IPC, and
is deliberately not here. The remaining verbs — `type_text`, `press_key`, `screenshot`,
`read_screen`, `install_app`, `pull_file`, `push_file` — are their own issues.

**The daemon loads the core and runs the verbs**, and a client only asks (D19). The two waits, the
four gestures, the three app verbs and the log read are callable over the same connection as
`acquire_device` — the same envelope,
the same framing, one method table — and a verb call carries the lease id rather than a serial,
because the lease id is the credential and the host derives the device from it. A verb that fails
comes back as an *answer* naming what happened — the element was not there, the wait timed out, the
device cannot read its screen — and never as a broken host; only the host actually breaking is an
`internal_error`. There is no `adb` in a client process, and
`tests/unit/no-backend-in-a-client.test.ts` walks the import graph from every client entrypoint to
say so rather than asking politely. Against a real device today all of it runs on the hardware: a
`tap` at a coordinate injects, `launch_app` and `stop_app` reach the package, and — since the
Android backend learned to read its own screen — a target addressed by text resolves against a
hierarchy read inside the verb, both waits poll a real screen, and every action comes back carrying
the elements that were on it afterwards. One gap is recorded rather than hidden — a device-level
refusal, such as launching a package that is not installed, still reaches the caller as
`internal_error` rather than as an answer about the device. That is true of every verb family here,
not just this one, and it is filed as its own issue.

**The host can now listen on the network, and only if you ask it to** (D17, D20). Setting
`ROVER_LISTEN_PORT` — with a host token and a TLS certificate beside it — starts a TCP+TLS
listener alongside the local unix socket, serving the *same* IPC surface from the same handler:
one method table, two transports, no second implementation of anything. A network caller
authenticates with a one-line greeting the transport reads and consumes before the message
surface ever sees the connection, so the token never enters a request and never becomes a lease's
owner — the token authenticates, the owner string attributes, and they are separate fields. Every
pre-auth failure gets one byte-identical refusal and a closed connection: no reason, no device
list, no count, no serials, because a refusal that varied would be an oracle. Without those
variables nothing binds, the local socket needs no token and no configuration, and a daemon
autostarted by `rover list` clears the switch so a plain command can never turn a laptop into a
network host. The client half — `--host remote` — is the other half of `PROJECT.md` R22. The
backlog is twenty issues in dependency order — see [`PROJECT.md`](PROJECT.md) §9.3.

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
| `ROVER_LISTEN_PORT` | unset — **no network listener** | The opt-in switch for the TCP+TLS listener that serves the same IPC surface as the local socket. Unset or empty and nothing binds, nothing else below is read, and the daemon is a purely local host. Set it and the next three become **required together**: a port with no token would be a listener that lets strangers in, so a missing one is a startup failure naming every variable still missing rather than a half-configured host. 1–65535. |
| `ROVER_HOST_TOKEN` | — (required with the port) | The shared secret every network caller presents. At least **32 characters**; it is a bearer secret on an open port, and length is the only thing that makes guessing hopeless. It is a **host-level** setting and belongs in the environment, never in a file the repository tracks. Deliberately the same name a client will read, so a machine that is both holds one secret rather than two that drift apart. The token **authenticates and attributes nothing**: a lease's owner is a separate, caller-supplied string (`PROJECT.md` D20). |
| `ROVER_TLS_CERT` | — (required with the port) | Path to the PEM certificate (chain) the listener presents. |
| `ROVER_TLS_KEY` | — (required with the port) | Path to the matching PEM private key. Unreadable material is a startup failure naming the variable and the path, not a TLS mystery on the first connection. |
| `ROVER_LISTEN_ADDRESS` | `0.0.0.0` | Which interface the network listener binds, so an operator can narrow it to a VPN or loopback interface instead of every one. Only read when the port is set. |

While a daemon is coming up over a socket a crashed one left behind, a `<socket>.reclaim` lock file
may briefly appear beside it. It is removed by whoever took it, and any left behind by a killed
process is discarded on age by the next start.

### Exposing a host on the network

A network host is a **service its operator starts on purpose**, never something a client brings up
behind their back — `rover list` clears `ROVER_LISTEN_PORT` in any daemon it autostarts, so the
listener only ever exists because somebody exported these four variables and ran the daemon.

```bash
# A certificate for the host. Use your own CA in anything that matters; this is the shape.
openssl req -x509 -newkey rsa:2048 -nodes -days 365   -keyout rover-key.pem -out rover-cert.pem   -subj "/CN=rover-host" -addext "subjectAltName=DNS:rover-host,IP:10.0.0.4"

export ROVER_HOST_TOKEN="$(openssl rand -hex 24)"   # at least 32 characters
export ROVER_TLS_CERT=/etc/rover/rover-cert.pem
export ROVER_TLS_KEY=/etc/rover/rover-key.pem
export ROVER_LISTEN_ADDRESS=10.0.0.4                # optional; 0.0.0.0 otherwise
export ROVER_LISTEN_PORT=4711                       # the switch — set it last
npm run daemon
```

The token is a shared secret: keep it in the environment (or your secret store), never in a file
the repository tracks, and give the client machines the same value. `.gitignore` refuses `*.pem`
and `*.key` so a certificate generated inside a checkout cannot be committed by accident. A caller
that fails to authenticate is told only that authentication failed — no reason, no device list, no
serials — and the connection is closed.

## Where things are

| Document | What it answers |
|---|---|
| [`PROJECT.md`](PROJECT.md) | Why this exists, the sixteen decisions and their reasoning, the verb set, verified adb recipes, the backlog |
| [`ai/RULES.md`](ai/RULES.md) | The single source of truth for agents working in this repo — read it first |
| [`ai/ARCHITECTURE.md`](ai/ARCHITECTURE.md) | The four components, the lease lifecycle, where the iOS seam runs |
| [`ai/CODING_STANDARDS.md`](ai/CODING_STANDARDS.md) | Stack, Zod boundaries, error handling, module shape |
| [`ai/TESTING.md`](ai/TESTING.md) | Vitest, the real-device gate, fixtures, conformance |

In the source tree: `src/core/` holds the device contract and the branded ids, `src/backends/` one
folder per platform, `src/verbs/` the verb spine with the gestures, the app verbs and the waits described above, `src/ipc/` the
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
