# Rover

Hands and eyes on a real mobile device, for coding agents — and a way to share those devices
between several agents working at once.

An agent can build a mobile app but cannot look at it. Rover taps, scrolls, types, screenshots,
reads the view hierarchy, records video and toggles the network, over `adb`. A daemon keeps one
inventory of the machine's devices so two agents never end up driving the same phone.

It is **not** a test framework. Nothing asserts, nothing turns red on its own, nothing is a CI
gate. Rover moves the device and reports what is on it; judging whether that is right is the
agent's job.

## Quick start

Two runs, in this order: **take a device on this machine**, and — when the devices are on some
other machine — **expose that machine as a host** and reach it from where the work happens. Every
command below was actually run on the machine this section was written on, and the outputs shown
are the ones it printed; what could not be run says so rather than being shown unrun
(`ai/RULES.md` §6).

There is no `bin/` launcher, so `rover` is typed `npm run rover --` — with `-s` in anything that
reads the output, because `npm run` prints its own two-line banner on stdout ahead of the command.
Why there is no launcher, and the one line that changes when there is, is `PROJECT.md` §9.4.

### What you need

- **Node 22 or newer**, and `npm install` in this checkout — that also installs the git hooks.
- **`adb` on `PATH`, with a device in debug mode.** `adb devices` has to name it before Rover can:
  Rover lends what is already attached and never starts an emulator or connects a phone itself
  (`PROJECT.md` D21), and it never takes a device reached over `adb connect` into its inventory,
  because that is not this machine's hardware (D18).
- **`ffmpeg` on the host, and only for `record`.** The machine this was written on does not have
  it, so `record` is not shown below — see [what this will not tell
  you](#what-this-will-not-tell-you).

The device everything below ran against: `emulator-5554`, an `sdk_gphone64_arm64` emulator on
**API 35** (Android 15).

### Take a device on this machine

Nothing needs starting by hand — the first call brings the daemon up (`PROJECT.md` D5), and
`status` is the call that says which host answered:

```bash
npm run -s rover -- status
```

```
host: local
pid: 96427
uptime: 0s
protocol version: 1
```

`list` is what is attached, what is free and who holds the rest:

```bash
npm run -s rover -- list
```

```
SERIAL         PLATFORM  MODEL               STATE  HELD BY
emulator-5554  android   sdk_gphone64_arm64  ready  free
```

`acquire` takes **one device**, not the machine. `--owner` and `--project` are required and
neither is ever derived from who you are (D16, D20); `--test-name` is optional, opaque, and is
what files two runs of the same check next to each other in the host's archive.

```bash
npm run -s rover -- acquire emulator-5554 --owner issue-20 --project rover --test-name "quick start"
```

```
Acquired 'emulator-5554' for 'issue-20' (project rover, test quick start).
Release it with: npm run rover -- release 2744ae37-aafd-4179-b02c-b353127a23b2
Expires in 19m unless activity renews it.
```

That lease id is the credential every verb call carries, and it is printed once, to whoever was
granted the lease. Ask for the same device again while it is held and the answer is a **refusal**
rather than an error — naming the holder, and never the holder's lease id:

```bash
npm run -s rover -- acquire emulator-5554 --owner someone-else --project rover   # exits 1
```

```
Not granted (held): Device 'emulator-5554' is held by 'issue-20' for another 1186855ms
Held by issue-20 (project rover, test quick start) — 19m left, granted 2026-08-31T09:14:07.512Z.
```

Now drive it. The verb runs on the **host** and the bytes come back over the wire, so `--out` is a
path on **this** machine, and it is required — there is no filename this CLI could invent that its
caller could predict (D19):

```bash
npm run -s rover -- screenshot <lease-id> --out /tmp/rover-quickstart.png
```

```
Wrote 1376820 bytes of image/png to /tmp/rover-quickstart.png
```

A transfer the host refused, or one that did not survive the trip, exits 1 and leaves **no** file
at `--out` at all rather than a short one; an `--out` that names a directory is a usage error
(exit 2) before anything is captured. `--json` is the form to script against — one document on
stdout, every diagnostic on stderr:

```bash
npm run -s rover -- list --json
```

```json
{
  "host": "local",
  "devices": [
    {
      "serial": "emulator-5554",
      "platform": "android",
      "model": "sdk_gphone64_arm64",
      "state": "ready",
      "attachment": "this-host",
      "heldBy": {
        "serial": "emulator-5554",
        "owner": "issue-20",
        "project": "rover",
        "testName": "quick start",
        "grantedAt": "2026-08-31T09:14:07.512Z",
        "expiresInMs": 1191269
      }
    }
  ],
  "stale": false
}
```

Hand the device back when you are done. A lease also ends on its own 20 minutes after the last
call, and either way it is the **host** that restores the device (D9) — a caller is never asked to
and cannot opt out:

```bash
npm run -s rover -- release <lease-id>
```

If somebody else's lease is stuck and you are the operator, end it by naming the **device** — you
were never handed their lease id, and the host will not hand it out (D20, D28). The device is
restored exactly as it is on a normal release, and `--actor` is required because it records who did
it:

```bash
npm run -s rover -- force-release <serial> --actor "$USER"
```

`npm run rover -- --help` lists every command, the global flags and the exit codes.

### Wire up the MCP server

The MCP server is one process per agent session, speaking MCP over stdio. An agent's server entry
runs `node` on **one absolute path** — `bin/rover-mcp.mjs` in this checkout — and **never**
`npm run mcp`: that banner would land in the protocol stream ahead of the first frame, and
`npm run mcp` really does write `> rover@0.1.0 mcp` and the command line to stdout before the
server has said anything.

```jsonc
{
  "mcpServers": {
    "rover": {
      "command": "node",
      "args": ["/absolute/path/to/rover/bin/rover-mcp.mjs"],
      "env": {
        "ROVER_PROJECT_FILE": "/absolute/path/to/your-project/your-project.json"
      }
    }
  }
}
```

Copy that from your own project's directory and it starts there. **This is the one line where the
obvious form is wrong**: `node --import tsx/esm /absolute/path/to/rover/src/mcp/index.ts` looks
equivalent and is not, because `tsx/esm` is a bare specifier and Node resolves a `--import`
argument against the **client's working directory**, never against the script. An MCP client picks
its own directory, so that form starts only inside this checkout and dies everywhere else with
`Cannot find package 'tsx' imported from <your project>/` before a single frame. The launcher is a
plain `.mjs` file whose own bare specifier resolves next to itself — inside the checkout, where
the loader is — so there is one path to paste rather than a `node_modules` path as well.
`tests/unit/mcp/entry.test.ts` spawns it from a temp directory with no `node_modules` above it,
because that failure is a resolution question and no assertion on a string can see it. (This is
not the published `rover` entry point `PROJECT.md` §9.4 leaves outside the backlog: nothing is on
a `PATH`, `package.json` still has no `bin`, and every CLI line here is still `npm run rover --`.)

`ROVER_PROJECT_FILE` is optional and buys one thing: `acquire_device` may then omit `project`
(D22) — it is read for that single field and nothing the file declares is ever run by a client.
**Which host an agent talks to is this `env` block's business and never a tool argument** (D17),
which is what the pair of sections below is about; an agent cannot see or change the machine that
answered.

**The tool names are `snake_case` and their arguments are `camelCase`** — `launch_app` takes
`leaseId` and `appId`, not `lease_id` and `app_id`. That is deliberate (D26): the input schema
each tool advertises *is* the object the host parses the request with, so what the schema spells
is what the host parses and what a refusal names. Copy the property names out of the schema
rather than off the tool name; every tool's description says so, and a call that gets it wrong is
refused loudly, naming both the missing camelCase key and the unrecognised snake_case one.

You can prove the wiring with no agent in the picture. Three frames in, two answers out:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node bin/rover-mcp.mjs
```

The first answer is the handshake (`"protocolVersion":"2025-06-18"`, `"serverInfo":{"name":"rover"`
…) and the second lists **23 tools**: the four device and lease rows, the seventeen verbs whose
answer is plain data, and the two whose answer is bytes. Swap the last frame for a call to watch
one run against the device:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_devices","arguments":{}}}' \
  | node bin/rover-mcp.mjs
```

The two ways to mis-wire this fail at **startup**, on stderr, before one tool is advertised —
rather than starting and breaking at the agent's first call:

```bash
ROVER_HOST_ADDRESS=1.2.3.4 node bin/rover-mcp.mjs
# ROVER_HOST_ADDRESS is set, so this client would ask a remote host, but ROVER_HOST_PORT,
# ROVER_HOST_TOKEN are not set. …  (exits 1)

ROVER_PROJECT_FILE=/nope.json node bin/rover-mcp.mjs
# There is no project hook file at /nope.json, and ROVER_PROJECT_FILE names it. …  (exits 1)
```

### Expose this machine as a host

**The run below is one machine playing both parts**, over TLS on loopback, because there was no
second machine to hand when this was written. On two machines not one command changes except the
address: put the host's own address on the network in the certificate's `subjectAltName`, in
`ROVER_LISTEN_ADDRESS` here and in `ROVER_HOST_ADDRESS` on the client, everywhere `127.0.0.1`
appears below.

A network host is a service its operator starts on purpose, never something a client brings up
behind their back — `rover list` clears `ROVER_LISTEN_PORT` in any daemon it autostarts, so the
listener only ever exists because somebody exported these variables and ran the daemon.

```bash
# A certificate for the host. Use your own CA in anything that matters; this is the shape.
# The subjectAltName has to carry the address clients will put in ROVER_HOST_ADDRESS.
mkdir -p /tmp/rover-net
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout /tmp/rover-net/rover-key.pem -out /tmp/rover-net/rover-cert.pem \
  -subj "/CN=rover-host" -addext "subjectAltName=DNS:rover-host,IP:127.0.0.1"

export ROVER_TLS_CERT=/tmp/rover-net/rover-cert.pem
export ROVER_TLS_KEY=/tmp/rover-net/rover-key.pem
export ROVER_LISTEN_ADDRESS=127.0.0.1        # optional; 0.0.0.0 otherwise
export ROVER_LISTEN_PORT=4711                # the switch — set it last
npm run daemon
```

```
Rover is listening on 127.0.0.1:4711 (TLS).
```

It runs in the foreground and serves the network and the local unix socket from one handler, so a
plain `rover list` on this machine keeps working against the same host. Stopping it is `kill` on
the pid `rover status` printed; it unlinks its socket on the way out. `.gitignore` refuses `*.pem`
and `*.key`, so a certificate generated inside a checkout cannot be committed by accident —
generating it outside one, as above, is better still.

Then issue access, one token per person. `users` needs no daemon and asks no host at all: it reads
and writes this machine's own `~/.rover/users.json` directly, before or after the daemon is up.

```bash
npm run -s rover -- users add alice --name "Alice Example"
```

```
Created user 'alice'. Its token:
Tba-…
That token is stored only as a hash. It is not shown again and cannot be recovered — hand it over
now, or mint a fresh one with `rover users rotate`.
```

Hand that value to the person and nothing else — the host keeps only its hash, and there is no
shared secret beside it. `rover users revoke alice` takes it away, and because the daemon re-reads
the store at **every connection attempt**, it bites on alice's very next call with nothing
restarted: `list --host remote` was refused immediately after a `revoke`, with the same daemon
still running.

**What this deliberately does not do.** There is no host catalogue, no registration and no
discovery. Rover is built for exactly one device host, and a client is configured with that host's
address and nothing else (`PROJECT.md` §7, D18) — so there is no "connect to somebody else's host"
story to go looking for, and the exports below are the whole of the client's configuration.

### Take a device on another machine

On the machine doing the work, point the client at that host and add `--host remote`. Nothing else
about a command changes: the same method table, the same answers, the same exit codes.

```bash
export ROVER_HOST_ADDRESS=127.0.0.1                 # must be an address that certificate names
export ROVER_HOST_PORT=4711
export ROVER_HOST_TOKEN="…"                         # what that host's `rover users add` printed
export ROVER_HOST_CA=/tmp/rover-net/rover-cert.pem  # optional; the system trust store otherwise

npm run -s rover -- status --host remote
npm run -s rover -- list --host remote
npm run -s rover -- acquire emulator-5554 --host remote --owner issue-20 --project rover
npm run -s rover -- screenshot <lease-id> --host remote --out /tmp/rover-remote.png
npm run -s rover -- release <lease-id> --host remote
```

`status --host remote` answers with the **host's** pid and uptime, which is how you tell which
machine you reached. `screenshot` still writes on **this** machine (D19), and `acquire`'s printed
`Release it with: …` line does not carry `--host remote` — add it, or the release goes to the
wrong host.

An MCP server reaches a remote host the same way, through its `env` block rather than through a
tool argument:

```jsonc
"env": {
  "ROVER_HOST_ADDRESS": "127.0.0.1",
  "ROVER_HOST_PORT": "4711",
  "ROVER_HOST_TOKEN": "…",
  "ROVER_HOST_CA": "/tmp/rover-net/rover-cert.pem"
}
```

Four ways this goes wrong are four different messages, because they call for four different next
moves. All four were run:

| What is wrong | What comes back |
|---|---|
| Nothing is listening there | `ECONNREFUSED`, naming the address and the port, and saying that a client never starts a host |
| The host rejected the token | "rejected `ROVER_HOST_TOKEN`" — unknown, revoked or rotated there; the value itself is never printed |
| The certificate is not trusted | `DEPTH_ZERO_SELF_SIGNED_CERT` — name the certificate in `ROVER_HOST_CA`; verification is never turned off |
| The certificate does not name that address | `ERR_TLS_CERT_ALTNAME_INVALID`, listing the names it does carry — `ROVER_HOST_CA` is not what fixes this one |

None of them is ever an empty device list and none of them hangs; a peer that accepts the
connection and then never finishes the handshake is given ten seconds and then named too. See
[Connecting to a remote host](#connecting-to-a-remote-host) for the reasoning behind each.

### What this will not tell you

Worth naming out loud, because silence reads as "checked". `PROJECT.md` §8 is the full list; the
short form:

- **Nothing goes red on its own.** There is no assertion anywhere here. The quality of the result
  depends on the agent's attention, not on the tool.
- **Pixels are gone whenever an app blocks screen capture** — the system hands back a valid, all
  black image and logs nothing. `read_screen` survives the block and answers in full, which is why
  it is a first-class verb rather than a fallback.
- **Motion is only ever sampled.** A recording and its frames can say something moved and roughly
  when; "is this animation smooth" is a question neither answers.
- **Measurement error is ±1–3 px**, worse on antialiased edges, and **one density per device** — a
  result from one emulator is not a result for every phone (D14).

And the gaps this quick start runs into today, rather than in principle:

- **`record` was not run for this section**, because this machine has no `ffmpeg`. It was tried:
  the call exits 1 with `frame-extraction-unavailable`, naming the program to install, and writes
  no video either — never an empty frame list, which would read as a screen on which nothing
  happened.
- **One call carries one whole file, capped at 4 MiB**, so `install <lease-id> <local-path>` moves
  a small package and refuses a real APK by name. Chunked transfer is its own issue — and the way
  a real APK reaches the device today is `install` with **no** path, which runs the project's own
  install on the host instead of sending anything.
- **`push_file` and `pull_file` are not MCP tools**, so an agent cannot push or pull a file —
  only the CLI can. Neither has a form that carries no bytes, which is what `install_app` has and
  what got it a tool; a whole file as a tool argument waits for `PROJECT.md` R24 phase 2.
- **`install_app` as a tool can outlast an MCP client's own request timeout.** The host gives a
  project's install five minutes, and some clients wait less than that for a tool call. The build
  keeps running on the host when a client gives up, but the answer is lost — `rover install` from
  a terminal is the form with no such limit.
- **Nothing prunes the host's artifact archive** under `~/.rover/artifacts` (`PROJECT.md` §9.4).
- **The remote pair above was exercised on one machine over loopback**, with a self-signed
  certificate, one process playing host and one playing client. Two machines on a real network
  were not available for this section.
- **There is no published `rover` command**, which is why every CLI line here starts
  `npm run rover --` (`PROJECT.md` §9.4). `bin/rover-mcp.mjs` is not that: it is one file an MCP
  config names by absolute path, and nothing is linked onto a `PATH`.

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

**A stuck lease can be ended by an operator** (`force_release_device`, D28) — and still without the
lease id ever being handed out. That call is keyed on the device **serial**, which every listing
already shows, precisely because ending somebody else's lease has no credential of theirs to
present; putting the id in a listing so it could would be the disclosure the protocol refuses. It
runs the same release path a normal release does, so the device is restored identically (D9), and
the holder's next verb call is refused `no-lease` rather than quietly driving a device the host may
since have handed on. A device nobody is holding is a named refusal and not an error, and the three
reasons are three different next moves: `not-held`, `gone` and `not-attached`. Who did it is a
caller-supplied `actor` string the host records and derives from nothing — never from whoever
authenticated, and never a token (D20).

**The daemon restores the device itself** (D9) — on `release_device`, on `force_release_device` and
on expiry alike, from the one place a lease is observed to end. It stops the project's applications, turns airplane mode off,
turns wifi back on (in that order: `PROJECT.md` §6 records why the wifi step has to be last), stops
the project's helper services and runs the project's teardown hook. A caller is never asked to do any of it and cannot opt out; a
step that fails is reported and the remaining steps still run — including a project resolver that
throws, which costs that project's own steps and never the device's; and a device is never handed
to the next lessee while its restoration is still in flight. An unref'ed sweep is what notices a
lease whose holder died — such an agent issues no further calls, so nothing else would ever ask —
and shutting the daemon down sweeps once more and then waits, bounded, for whatever it still owes:
leases die with the host, so a restoration abandoned there is one nothing will ever retry. Which
applications a project owns and what its hook does arrive through an injected resolver — the
per-project configuration that fills it is its own issue (`PROJECT.md` §9.3, R17), so today that
resolver answers nothing and only the two network steps have work to do.

**There is a CLI** (D4) — `rover list`, `acquire`, `release`, `force-release`, `screenshot`,
`record`, `pull`, `push`,
`install`, `status` and `users`, human-readable by default and one JSON document on stdout with `--json`, every diagnostic
on stderr. It holds no verb logic: each command parses flags, calls one IPC method, renders the
answer and picks an exit code. `list` shows what is attached, what is free and who holds the rest —
the owner, project and test name, and how much longer they have — and says out loud when the host
does not know its own view to be current, rather than quietly printing a short list. `acquire`
requires an explicit `--owner` and `--project` and derives neither, and `force-release` requires an
explicit `--actor` for the same reason — it names the device, not a lease id, because it ends a
lease this caller never took. `status` says which host
answered. The host is named by `--host`: no flag means the local one, `remote` is the machine
`ROVER_HOST_ADDRESS`, `ROVER_HOST_PORT` and `ROVER_HOST_TOKEN` name, and anything else fails loudly
instead of hanging. `screenshot`, `record` and `pull` are the three commands that bring bytes back:
the verb runs on the host and the answer returns base64 rather than a path (D19), so `--out` is a
path on **this** machine, it is required — there is no filename the CLI could invent that anything
calling it could predict — and the path reported is `path.resolve` of what you passed. What decoded
is checked against the byte length the host encoded before anything is written, so a transfer the
host refused, or one that did not survive the trip, exits 1 and leaves no file at `--out` at all
rather than a short one. `rover record --duration-ms <n>` raises its own request timeout past the
recording, so a long recording is never a hang. `push` and `install` are the two that go the other
way: they read a file from **this** machine, so the path they name is yours and never the host's,
and everything they can refuse they refuse **before connecting** — a source that is missing, cannot
be read, is not a regular file (a directory, a named pipe, a device), or is over the bytes one call
may carry exits 2 with the command's own usage, naming the file, its real size and the limit. The
size is read off `stat` rather than off a buffer, so an over-sized file is refused without ever
being loaded, and the kind is checked before the size, because a pipe's size says nothing about how
much it would send. The host is never asked at all: nothing partial can be sent because nothing is
sent. `users` is the one command that asks no
host at all: it reads and writes this machine's own `~/.rover/users.json` directly, works whether or not a
daemon is running, and takes no `--host` (see "Managing host users" below).

**Waiting is a condition, never a duration.** `src/core/wait.ts` is the one module in the
repository allowed to construct a delay: `waitForCondition` polls a probe until it reports the
condition met or the deadline passes, and a probe that reports *unmet* is required by its own type
to say what it found instead — so a timeout names both halves (`PROJECT.md` D12). The rule has a
test behind it rather than only a convention: `tests/unit/no-sleep.test.ts` scans `src/` and
`tests/` for every promisified-timer shape a sleep is spelled with, and for a call to
`waitForCondition`'s own poll gap from a file that has not said why it needs one. Only three files
are exempt from the scan. It is a floor, not a proof — a determined re-implementation gets
through, and reading the wait vocabulary is still how you learn what a wait here looks like.

**The verb layer has a spine, nineteen verbs on it and the two waits standing beside it.**
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

**The six input verbs are that spine used six times** (`src/verbs/input.ts`),
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
`canReadScreen`, and `read_screen` is now the verb that exposes it directly.

**`type_text` and `press_key` complete the input row, and they are the two of it that address no
element.** A key press aims at nothing and neither does text going to whatever holds focus, so both
go through the spine with **no target at all** and their result's `target` is `null` — a fact about
the verb rather than a resolution that failed. There is no target *option* on `type_text` either: an
agent that wants text in a particular field taps it and then types, rather than having a second copy
of `tap`'s resolution live here. `press_key` speaks the four keys of `DeviceKey` — back, home,
recents, wake — shared with the backend and the wire so a key nobody implements is refused at the
boundary instead of pressed into silence. `type_text` hands the caller's string to the backend
**byte for byte**: quoting and whatever a device's own text entry reads rather than types belong to
the backend, and a string this layer had helpfully escaped would arrive on screen with the escaping
in it. What a device cannot type at all — every non-ASCII character on the Android backend today —
comes back as an `unsupported-text` failure naming the characters as escapes, so an agent is told
which one to change rather than that the host broke.

**`launch_app`, `stop_app` and `clear_app_data` are that same spine used three more times**
(`src/verbs/app.ts`), and they are what a verb looks like when it addresses **a package rather than
something on the screen**: they resolve no target at all, so no screen is read before the action and
the result's target is `null` — a fact about the verb, not a resolution that failed. They need no
capability either, and say so with an explicit empty list: the three backend methods behind them are
*required* ones, and a `canControlApps` flag would be a capability that is always true. So they add
no backend method, no capability and no result shape — the whole family is one module, one params
schema shared by all three, and three rows on the method table. `stop_app` cannot tell "stopped it"
from "there was no such package", because the device is silent either way; the state after the
action is what answers that, and there is deliberately no probe pretending otherwise.

**`read_screen` and `device_info` are the same spine again, with nothing in the middle**
(`src/verbs/read.ts`). Every other verb does something and then reports the state after it; these
two ask for that state and nothing else, so their action is empty and the answer is the capture the
spine already performs for every verb there is — which is what keeps "every verb answers the same
way" true rather than giving the reads a second answer shape of their own. `read_screen` hands back
the texts and the element rectangles, in dp, and it **declares `canReadScreen` as a requirement**:
on a backend that does not have it the call fails by name — the capability, the device, the backend
— before anything is dispatched, rather than answering with an empty screen, because for a read the
state *is* the answer rather than context around an action. `device_info` requires nothing, since
every backend must answer it, and reports size, density, the computed width in dp and the OS
version — the same `DeviceInfo` every result already carries (D14), now askable on its own without
moving the device first. Neither addresses anything on the screen, so both answer `target: null`,
and both carry the lease id and nothing else on the wire.

**`screenshot` is the third read, and the one whose answer is a payload** rather than a state the
result already carries. It sits on the same spine and needs no capability either, and what it adds
is one field: `result.artifact`, carrying the image **as bytes** — base64, its media type and the
length those bytes decode to. **Never a path.** The capture happens on the host and the answer is
read wherever the agent is, so a filesystem location would name a file that is not there, or worse,
one that is; where the bytes end up is the client's own decision and the client's own disk. The
call carries the lease id and nothing else for the same reason — there is no destination to send.
A capture too large for one answer is refused by name, `artifact-too-large` carrying both the size
and the bound, rather than trimmed to fit: half a PNG still decodes to a picture, and an agent
handed one reads a screen that is blank below a line as something the device did. Chunked transfer
of anything bigger is its own issue; the durable copy the host keeps is built and described below.

**A black screenshot is a true answer about the device, not a failed capture.** An app can block
screen capture, and the system then hands back a valid, entirely black image with nothing in any
log to say so. So the check that tells a blocked capture from a broken device is **a screenshot of
the system home screen**: black there is a broken device, black only inside the app is that app
blocking capture. And `read_screen` is the read that survives the block — on a screen whose pixels
are gone the hierarchy comes back in full, texts and rectangles and all, which is why it is a
first-class verb rather than a fallback for when a screenshot is inconvenient (PROJECT.md §6).

**`record_video` is the second verb whose answer is bytes**, and the whole verb is one promise:
the recording it hands you is a file a player will actually open. A recorder writes its container
index **last**, so a file copied off a device a moment early is not a shorter video — it is a file no
decoder will accept at all, which reads like a broken tool rather than a race. So the host records,
then waits on a *condition* for the recorder to be gone (never a sleep), then pulls, then checks the
index on the bytes that actually arrived, and only then answers. A recording missing that index is
refused by name — `unfinished-recording`, carrying the device and the byte length — rather than
handed over, and rather than surfacing as a broken host. The recording rides on the same
`result.artifact` a screenshot does, base64 and `video/mp4` and a byte length, and never a path, for
the reasons above. It declares `canRecordVideo`, so a device that cannot record says so before
anything is dispatched. Duration is the one knob — five seconds by default, capped at fifteen,
because that is what **one answer** can carry; a longer recording is chunked transfer, its own
issue, and going over the bound is the same `artifact-too-large` refusal rather than a file cut
short. A caller asking for a long one should raise its own request timeout, which defaults to 30 s.

**The same answer carries the frames sliced out of that recording.** They come back on
`result.frames` — PNGs, in the order they were recorded, each with its media type and byte length,
never a path — and they are cut out of the **finished** recording on the host, after the completion
condition and the pull, so the device is touched once and never sampled while it is being recorded.
They are scaled down on purpose: a frame is for reading *what changed*, and the full-resolution read
of one moment is `screenshot`. The one knob is `framesPerSecond`, two by default — and `rover record`
exposes it as `--frames-per-second`, bounded before the call the way `--duration-ms` is.

Extraction needs a video decoder, this project contains none, and writing one is out of the
question — so the host drives `ffmpeg`, found on `PATH` the way `adb` is, with the recording written
to its standard input and the images read back off its standard output. **No temporary file is ever
written**, which is also why no path exists that could end up in an answer. That is a fact about the
*host* rather than about the device, so it is not a device capability: a machine without `ffmpeg`
refuses by name — `frame-extraction-unavailable`, naming the program and what to install — rather
than answering with an empty list of frames, because an empty list would read as a screen on which
nothing happened. **No path answers with an empty list at all**: a decoder that could not start, one
that exited non-zero, one that wrote something unreadable and one that exited cleanly having written
nothing are four failures with four names.

The count, the width and the total size are all bounded and named, and going over any of them is a
refusal rather than a shorter list — a frame list missing its middle reads as a recording in which
nothing happened between two moments that are no longer next to each other. The width is a fixed
default the verb owns. The count is derived from the longest recording at the densest sampling, and
it is a bound a real call can reach: a capture of a screen that barely changed declares a container
timeline much longer than the recording was asked for, and the sampling follows the container. The
total size is the bound the ordinary case reaches, refused with both numbers on it.

Because the extraction happens inside the same call, `rover record` answers with **both or neither**:
on a host with no decoder installed the command exits 1 with `frame-extraction-unavailable` and
writes no video either, and its `--help` says so.

**What a recording is honest about: it samples motion, and the frames sample it again.** It can tell
you something moved and roughly when. It cannot tell you how the movement eased, whether a frame was
dropped, or whether what a person would call jank happened — and reading any of that out of it
anyway is exactly the plausible-looking wrong answer this whole design is against.

**`read_logs` is the verb that sees what a screenshot cannot** (`src/verbs/logs.ts`), and it is the
first one whose answer carries a payload of its own: the device's log, parsed into neutral entries —
a timestamp as the device printed it, a level, a tag, a process id and the line — on top of
everything every other verb answers with. An app that crashed and vanished leaves a screen you
cannot tell from someone pressing home, and the log is where the exception is; proved against a real
device, where a crashed app is named in the read while nothing on the screen names it. The read is
**bounded and never follows**: the caller says how many entries, the device's newest are the ones
kept, and `truncated` says when there were more, because a short read that reads as a quiet device
is worse than no read. Following a log would be a wait with no condition and a stream over IPC, and
is deliberately not here.

**`install_app`, `push_file` and `pull_file` are the family whose whole subject is *which machine a
file is on*** (`src/verbs/files.ts`). The agent is somewhere else, the device is here, and the host
is in between — so a package to install and a file to push arrive **as bytes from the caller's
machine**, never as a path, and a pulled file goes back **as bytes** on the same `result.artifact`
a screenshot uses. That means `pull_file`'s answer contains no path at all: where the file lands is
the client's own decision and the client's own disk. The host writes the inbound bytes to a file of
its own, hands it to the device, and deletes it in a `finally` — including when the transfer failed,
which is the case that would otherwise leave somebody's package on a machine that lends the same
hardware to the next agent. `install_app` carries no application id, because the core knows no
application's name; what gets installed is the package the caller sent, pinned to the leased device.

**`install_app` has a second shape: send no bytes, and the host runs the project's own install.**
A call that omits `packageBase64` asks the host to run the `install` command declared in the hook
file of *the project this lease was taken with* — a build, a deploy script, whatever that project
already has (see "Project hooks" below). The command runs on the host with `ROVER_DEVICE_SERIAL`
set to the leased device, so what it installs lands where the lease says and never on a
neighbour's. It is a verb the caller asks for and never something that happens at grant time, and
it is bounded at five minutes — generous enough for a real build, a quarter of the twenty-minute
lease TTL so the lease cannot expire under it, and well past the client's own 30 s default request
timeout, which a caller asking for one has to raise. The three ways it can go wrong are named
answers rather than `internal_error`: `project-not-registered` (this host has no hook file for
that project), `install-hook-undeclared` (it has one and it declares no `install`), and
`install-hook-failed`, carrying the exit code, the signal if there was one and the tail of the
command's own stderr. A call that *does* carry bytes is unchanged in every respect. **Both clients
reach this shape.** `rover install <lease-id>` with no path is it — the CLI raises its own request
timeout past the host's five minutes so a build that is merely compiling is never reported here as
a hang — and `install_app` is an MCP tool in exactly this shape and no other: the declaration
omits `packageBase64` altogether, so an agent has the project form and no way to paste an APK into
a JSON argument.

**`push_file` names the file to write, never a directory to put it in.** A push to a path that is
already a directory is refused rather than transferred into, and that is a rule Rover states rather
than a device answer it relays: the platforms' own transfer tools copy the file *inside* such a path
under a basename the **host** chose, report a success, and print nothing that names where the bytes
actually went. So a caller that meant `/sdcard/Download/report.bin` and wrote `/sdcard/Download`
would be told `ok` about a file it cannot find, under a name that appears in no schema and no
answer — on hardware this host lends to somebody else next. A trailing slash is caught at the
boundary; an existing directory is caught by asking the device before any bytes move.

**`pull_file` names the file to read, and refuses a directory for a second reason: the size bound
below would not hold.** The platforms' own transfer copies a directory *recursively*, while asking
the device how big a directory is answers for the directory itself — 4096 bytes, whatever the tree
under it holds (measured, PROJECT.md §6). So `pull_file` on `/sdcard/DCIM/Camera` would clear the
bound on 4096 and put every recording on this host's disk before anything could count them, in the
one process that holds every lease on the machine. The same probe that catches a push into a
directory catches this, and it runs before the transfer rather than after.

**No path on the host reaches the agent, in an answer or in a failure.** A refusal from a transfer
names the device path, the device and what the device said — never the temporary file the daemon
wrote the caller's bytes into, which names nothing on the machine reading the message and has been
deleted by the time anyone reads it.

**One call carries one whole file, and the limit says so out loud.** A payload over
`MAX_TRANSFER_BYTES` (4 MiB, derived from the 8 MiB frame cap with base64's inflation accounted
for) is refused at the boundary with a message naming both its size and the limit — never a file cut
to fit, because a truncated file is not distinguishable from a whole one. Say the uncomfortable part
plainly: **a real APK is routinely tens of megabytes**, so `install_app` works today for a small
package and refuses a large one by name. Chunked transfer is its own issue, and it will land
underneath these verbs rather than change what they promise. The outbound limit is enforced the same
way round: `MAX_ARTIFACT_BYTES` is handed **down** to the backend, so `pull_file` refuses a file too
big to answer with *before* copying it onto the host and into the daemon's memory — a bound applied
only on the way back would have already cost what it was meant to prevent, in the one process
holding every lease on the machine. That bound only means anything on a **regular file**, so that
is what a pull requires: a directory is a recursive copy whose reported size is the inode's own few
kilobytes, and a character device reports zero and then reads forever, so both are refused on what
the device says the path *is* rather than bounded on what it says the path weighs.

**Three commands drive that family from the client, and each one names the machine each path is
on**: `rover pull <lease-id> <device-path> --out <path>` writes the device's file **here**, on the
same two modules `screenshot` uses and with the same guarantee — a refusal or a transfer that did
not survive the trip exits 1 and leaves no file at `--out` at all. `rover push <lease-id>
<local-path> <device-path>` and `rover install <lease-id> <local-path>` read a file from **this**
machine and send its bytes; `src/cli/_shared/upload.ts` is the one place that happens. `rover
install`'s path is **optional**, and leaving it off is the project form above: nothing is read
here, nothing travels, and whether that form is available stays the host's answer — a project it
has no hook file for, or one declaring no install, exits 1 with the host's own
`project-not-registered` or `install-hook-undeclared` rather than a usage error this CLI invented. Everything
those two can refuse, they refuse before a connection exists — a missing file, one this process
cannot read, one that is not a regular file, and one over the byte cap, named with its real size
and the limit — and the size comes off `stat` rather than off a buffer, so an over-sized file is
refused without ever being loaded. **The kind is checked before the size on this side of the wire
too**, for the reason a pull checks it on the device's: a named pipe or a character device stats as
zero bytes and then reads without end, so the cap would wave either through — and `<(gzip -c
big.bin)` hands a command a pipe without the caller thinking of it as one. The consequence is the
one worth stating: when a source is refused, **the host is not asked at all**, so nothing partial
can have been sent. Neither direction echoes the payload back —
`--json` reports what the host answered and where the bytes went, never the bytes.

**`set_airplane_mode` and `set_wifi` toggle the radios without root** (`src/verbs/environment.ts`),
through the commands verified on a real device rather than the `svc wifi disable` every guide on the
internet still shows — that one does not exist on the API level Rover was built against, and it
fails in a way that looks like a permissions problem (PROJECT.md §6). Controlling the network is a
declared capability rather than an assumption, and these two demand it the way `read_screen` demands
its own: a device that cannot do it is told so by name, naming the capability and the device, rather
than answering `ok` and moving nothing. Each returns the state after itself like every other verb —
which is evidence the device was still there and answering, not a reading of the radio, because
nothing in the device abstraction reads one back. They are also exactly the commands the daemon's own restoration runs when a lease
ends, so there is one recipe per toggle rather than two that can drift, and the order matters for
the reason the restoration records: airplane mode first, wifi last.

**The daemon loads the core and runs the verbs**, and a client only asks (D19). The two waits, the
six input verbs, the three app verbs, the three read verbs, the log read, screen recording, the two
environment verbs and the three file transfers are callable over the same connection as
`acquire_device` — the same envelope, the same framing, one method table — and a verb call carries
the lease id rather than a serial, because the lease id is the credential and the host derives the
device from it. A verb that fails comes back as an *answer* naming what happened —
the element was not there, the wait timed out, the device cannot read its screen — and never as a
broken host; only the host actually breaking is an `internal_error`. There is no `adb` in a client
process — and no `ffmpeg` either, nor anything else that starts a program:
`tests/unit/no-backend-in-a-client.test.ts` walks the import graph from every client entrypoint and
says so rather than asking politely, which is why the frame extractor lives beside the daemon and is
handed to the verb rather than imported by it. Against a real device today all of it runs on the
hardware: a `tap` at a coordinate injects, `press_key` and `type_text` reach the device without aiming at
anything, `launch_app` and `stop_app` reach the package, `read_screen` and `device_info` answer off
the hardware, `screenshot` brings back a real PNG of the panel the device reports, `record_video`
brings back a recording that is provably finished before it leaves the device together with the
frames sliced out of it on the host, `read_logs` brings
back the device's own log, `push_file` and `pull_file` move a binary file to the device and back
byte for byte, and `set_airplane_mode` and `set_wifi` move the device's real radios
over a lease and without root — and, since the Android backend learned to read its own screen —
a target addressed by text resolves against a hierarchy read inside the verb, both waits poll a
real screen, and every action comes back carrying the elements that were on it afterwards. Two gaps
are recorded rather than hidden. **`install_app` is now verified on hardware, and its automated
coverage still is not**: a real 29-kilobyte APK was installed end to end through `rover install`
and confirmed by the device reporting the package from `/data/app` afterwards (PROJECT.md §6). But
there is no APK in this repository and adding a binary to carry one is not a change's job, so in
the test suite the verb is exercised over a stub backend and nothing else — read that as the stated
gap. What that stub covers is the decode, the host temp file and its removal, and the size refusal;
what adb settles before the device is involved is the half `withInstallablePackage` exists for:
`adb install -r` refuses a file whose name does not end `.apk` or `.apex`, and takes the same bytes
once renamed. And a
device-level refusal, such as launching a package that is not installed, still reaches the caller as
`internal_error` rather than as an answer about the device — which is what a `pull_file` of a path
the device does not have reports today. That is true of every verb family here, not just this one,
and it is filed as its own issue.

**The host can now listen on the network, and only if you ask it to** (D17, D20, D25). Setting
`ROVER_LISTEN_PORT` — with a TLS certificate beside it — starts a TCP+TLS listener alongside the
local unix socket, serving the *same* IPC surface from the same handler: one method table, two
transports, no second implementation of anything. A network caller authenticates with a one-line
greeting the transport reads and consumes before the message surface ever sees the connection, so
the token never enters a request and never becomes a lease's owner — the token authenticates, the
owner string attributes, and they are separate fields. **The host holds no shared secret**: the
greeting's token is hashed and looked up in the user store `rover users add` writes, re-read at
every connection attempt, so `rover users revoke` refuses that user on their very next attempt
with the daemon still running and nothing restarted. Every pre-auth failure gets one byte-identical
refusal and a closed connection: no reason, no device list, no count, no serials, no user, because
a refusal that varied would be an oracle. Without those variables nothing binds, the local socket
needs no token and no configuration, and a daemon autostarted by `rover list` clears the switch so
a plain command can never turn a laptop into a network host.

**And a client can now reach one** — `rover --host remote list` (R22's other half). It connects
over TLS to the host `ROVER_HOST_ADDRESS` and `ROVER_HOST_PORT` name, presents
`ROVER_HOST_TOKEN` — a token that host's own `rover users add` printed, not a secret both
machines share — and drives the identical method table; `--host local` and no flag are
unchanged, autostart included. **A client never starts a remote host**: nothing listening on that port is a failure
naming the address, the port and `ECONNREFUSED`, and a peer that accepts the connection and then
says nothing is given ten seconds and then named too — never an empty device list, never a hang —
and a token the host rejects says so, distinctly, without ever printing the token. The
certificate is verified; a self-signed host is trusted by naming its certificate in
`ROVER_HOST_CA`, never by turning verification off. The backlog is in dependency order — see
[`PROJECT.md`](PROJECT.md) §9.3.

The commands are in the [quick start](#quick-start) above, each one with the output it printed;
`npm run rover -- --help` is the full list, and `npm run daemon` runs the daemon in the foreground
instead of letting the first call start it.

`npm run` prints its own banner to stdout ahead of the command, so a script that parses the JSON
uses `npm run -s rover -- list --json` or invokes `node --import tsx/esm src/cli/index.ts list
--json` directly. **That banner matters more for `mcp` than anywhere else**: its stdout carries
MCP protocol frames, so an agent's server entry runs `node bin/rover-mcp.mjs` — an absolute path
to that one file, from whatever directory the client happens to be in — and a bare `npm run mcp`
writes two lines into the stream before the first frame. `npm run -s mcp` is the by-hand
equivalent from inside this checkout; the launcher is what makes the same server start from
outside it, because `--import tsx/esm` resolves against the caller's directory rather than against
the script. What that entry looks like in an MCP client's own configuration, and how to prove it
handshakes, is [Wire up the MCP server](#wire-up-the-mcp-server) above. What exists today is the
server, speaking stdio, declaring
twenty-three tools under the `IPC_METHODS` names exactly: the four device and lease rows (`status`, `list_devices`,
`acquire_device`, `release_device`), the seventeen verbs whose answer is plain data
(`wait_for`, `wait_until_gone`, `tap`, `long_press`, `swipe`, `scroll`, `type_text`,
`press_key`, `read_screen`, `device_info`, `launch_app`, `stop_app`, `clear_app_data`,
`read_logs`, `install_app`, `set_airplane_mode`, `set_wifi`), and the two whose answer is bytes.
Every one of them takes **camelCase** arguments under a `snake_case` name (D26), and says so in
its own description.

Those two are `screenshot` and `record_video`, and how their bytes reach an agent is the point
of the pair. **`screenshot` answers with the image inline** — an MCP `image` block the model
looks at directly — and writes nothing, because an inline image is the one form of an artifact
that needs no path at all. **`record_video` writes the recording to a file on the machine
running the server** and reports its absolute local path, because an mp4 is not something a
model can read; its frames come back inline like a screenshot, so the recording is legible
without a second call. Where that file lands is `ROVER_MCP_ARTIFACT_DIR` below, and it is
always a path on the agent's own machine — never one on the host, even when the two are the
same machine. Neither tool takes a destination or a format, for the same reason neither takes
a host. A refusal (`artifact-too-large`, `unfinished-recording`,
`frame-extraction-unavailable`, `frames-too-large`) is an error naming it and leaves no file
behind at all — never a truncated one.

`install_app` is a tool in **one** of its two forms: it takes the lease id and nothing else, and
the host runs what the lease's project declared as its install (D13). There is deliberately no
package argument on it — the byte-carrying form stays the CLI's, because a whole file as a tool
argument means an agent producing several megabytes of base64. That is what `push_file` and
`pull_file` are still waiting for and why they are not tools: `PROJECT.md` R24 phase 2 owns how a
client supplies and receives a file, and neither of those rows has a second form that carries
none. `force_release_device` is the third row with no tool, and its reason will not expire: **an
agent must not be able to end another agent's lease.** It is authority over the shared pool rather
than a step in one caller's work, which is what makes it an operator action (D27, D28) reached from
the CLI and, later, the panel. `tests/unit/mcp/verb-declarations.test.ts` records all three as
decisions, so no row can quietly land with no tool. There is no published `rover` command — a published entry point is outside the backlog
deliberately, and `PROJECT.md` §9.4 records why and what changes when it lands; `bin/rover-mcp.mjs`
is a path an MCP config states absolutely and not that.

Exit codes: `0` success; `1` the operation did not succeed (a refused `acquire`, a `release` that
found no live lease, a `force-release` that found no lease on the device, an unreachable host, a
request the host rejected); `2` usage error (unknown
command or flag, a missing `--owner`/`--project`/`--actor`, an attribution string past the 256 characters
the host accepts, a `--host` that is neither `local` nor `remote`, or `remote` with nothing in
the environment naming one). A `release`
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
| `ROVER_USERS_PATH` | `~/.rover/users.json` | Absolute path of the host's own user store — one record per user: identifier, display name, the **hash** of that user's token, and when it was created. Never a token: `rover users add` and `rover users rotate` print the raw value once and store only its hash. **Empty counts as unset**, as it is for the socket. Read by `rover users`, which touches the file directly and never goes over the network (`PROJECT.md` D25), **and by the network listener**, which is the host's entire authentication surface: the token in a caller's greeting is hashed and looked up here, re-read at every connection attempt and never cached, so `revoke` and `rotate` take effect on the very next attempt with the daemon still running. |
| `ROVER_ARTIFACTS_PATH` | `~/.rover/artifacts` | Root of the durable artifact archive: every `screenshot`, `record_video` and `read_logs` call additionally writes its output here, on the host, **in addition to** returning the bytes to the client (`PROJECT.md` D23, §10). **Empty counts as unset**, as it is for the socket. Read only by the daemon — a client never resolves it, and the archive path is never the one an agent is given. **Nothing prunes it**: retention is deliberately undecided (`PROJECT.md` §9.4), so this grows without bound until an operator removes what they no longer want. |
| `ROVER_PROJECTS_PATH` | `~/.rover/projects` | Directory holding the **per-project hook files** — one `<project>.json` per project, selected by the `project` string a lease carries (`PROJECT.md` D13, and see below). **Empty counts as unset**, as it is for the socket. Read only by the daemon, on the machine the devices are attached to: a hook file names a program the host runs with the daemon's own privileges, and nothing about it is ever accepted over the wire. Files are **re-read at every use and never cached** (`PROJECT.md` D6) — when a lease ends, and when an `install_app` carrying no package asks for the project's own install — so editing one takes effect on the very next call with nothing restarted. A `project` string that is not a valid identifier — anything with a separator, a leading `-`, whitespace or over 64 characters — resolves to **no hooks at all**, because no path is ever built from it. |
| `ROVER_PROJECT_FILE` | unset — **no default project** | The opt-in switch on the *client* side, and the counterpart of `ROVER_PROJECTS_PATH` above: the path of **one** project hook file on the machine running the client, whose `project` identifier becomes the default for `rover acquire`'s `--project` and for the MCP `acquire_device` tool's `project` argument (`PROJECT.md` D22). Unset or empty and nothing is read, `--project` is required exactly as it was, and the tool still declares the argument — **empty counts as unset**, as it is for the socket. Given both, the flag or the argument wins. It is one explicit path and there is no search: nothing walks up from the working directory and no `.rover/` convention exists, so the file a client reads is the file you named. A path naming a file that is missing or will not parse is a **loud client-side failure naming it** — exit 2 from the CLI, and an MCP server that dies on stderr at startup rather than advertising a tool it cannot fill in — never a silent fallback to attributing the lease to nothing. Convenience only: nothing else in the file is read here, no client ever runs what one declares, and the wire is unchanged — `project` stays a required, opaque string the host stores and never interprets. `owner` is **never** defaulted from this or from anything else (`PROJECT.md` D16, D20). |
| `ROVER_LISTEN_PORT` | unset — **no network listener** | The opt-in switch for the TCP+TLS listener that serves the same IPC surface as the local socket. Unset or empty and nothing binds, nothing else below is read, and the daemon is a purely local host. Set it and the next two become **required together**: a port with no TLS material would be a listener nobody could trust, so a missing one is a startup failure naming every variable still missing rather than a half-configured host. Who may connect is not a variable at all — it comes from the user store (`ROVER_USERS_PATH`), which always resolves, so a host with no users yet starts and refuses everyone. 1–65535. |
| `ROVER_TLS_CERT` | — (required with the port) | Path to the PEM certificate (chain) the listener presents. |
| `ROVER_TLS_KEY` | — (required with the port) | Path to the matching PEM private key. Unreadable material is a startup failure naming the variable and the path, not a TLS mystery on the first connection. |
| `ROVER_LISTEN_ADDRESS` | `0.0.0.0` | Which interface the network listener binds, so an operator can narrow it to a VPN or loopback interface instead of every one. Only read when the port is set. |
| `ROVER_HOST_ADDRESS` | unset — **no remote host** | The opt-in switch on the *client* side: the address of the host `--host remote` asks. Unset or empty and nothing below is read, `--host remote` is a usage error, and `rover` is a purely local client. Set it and `ROVER_HOST_PORT` and `ROVER_HOST_TOKEN` become **required together**, because a client cannot guess either — a missing one is a usage error naming every variable still missing. Exactly one remote host is configurable (`PROJECT.md` D18); there is no catalogue. **It is also what points an MCP server at a remote host** (`npm run mcp`), and there it is the *only* thing that can: an MCP client launches each server with its own `env` block, so this variable is that server's configuration, no tool takes a host parameter, and an agent can neither see nor change which host answered (`PROJECT.md` D17). An MCP server reads it at startup rather than at the first tool call, so a half-configured one fails on stderr before it advertises anything. |
| `ROVER_HOST_TOKEN` | — (required with `ROVER_HOST_ADDRESS`) | **A client-side credential, and only that** — the value `rover users add` (or `users rotate`) printed on the host, pasted on the machine that borrows a device. The host itself no longer reads this variable: it authenticates against its user store, so a token is revocable and rotatable where it was issued rather than being a secret both machines hold forever (`PROJECT.md` D25). At least **32 characters**, checked locally so a truncated paste fails here naming the variable instead of coming back as an opaque refusal. It is a **host-level** setting and belongs in the environment, never in a file the repository tracks. The token **authenticates and attributes nothing**: a lease's owner is a separate, caller-supplied string (`PROJECT.md` D20). |
| `ROVER_HOST_PORT` | — (required with the address) | The port that host listens on — its own `ROVER_LISTEN_PORT`, named from the other side. 1–65535. |
| `ROVER_HOST_CA` | unset — the system trust store | Path to a PEM certificate to trust in addition to nothing else — normally the host's own certificate, which is how a self-signed host is trusted. There is deliberately **no variable that turns verification off**: a client that skipped the check would accept any host that answered on that port. |
| `ROVER_MCP_ARTIFACT_DIR` | a `rover-artifacts` directory under the OS temp directory | Where the **MCP server** writes the files it hands an agent — today just `record_video`'s recording, because an mp4 is not something a model can read inline. It is the agent's own machine, never the host's: the capture happens wherever the device is and the path reported back has to exist where the answer is read (`PROJECT.md` D19). **Empty counts as unset**, as it is for the socket. Server configuration rather than a tool parameter, for the reason `ROVER_HOST_ADDRESS` is one — an MCP client launches each server with its own `env` block, and where an agent's files land on your disk is your decision rather than a free-text field in front of a model. Created on demand and only when there are bytes to write, so a refused recording leaves nothing behind and a server nobody asked to record never creates it. **Nothing prunes it**, the way nothing prunes the host's own archive. `screenshot` never writes here at all, because its capture comes back as an inline image and an inline image needs no path. |

While a daemon is coming up over a socket a crashed one left behind, a `<socket>.reclaim` lock file
may briefly appear beside it. It is removed by whoever took it, and any left behind by a killed
process is discarded on age by the next start.

### Project hooks

Everything application-specific is a hook in the project's own file (`PROJECT.md` D13) — the core
knows no application's name, and a default that mentions one is a bug. One file per project, named
after it, under `ROVER_PROJECTS_PATH`:

```
~/.rover/projects/
  checkout-web.json
  storefront.json
```

```jsonc
{
  "project": "checkout-web",
  "apps": ["com.example.checkout", "com.example.checkout.helper"],
  "install": {
    "command": "bash",
    "args": ["-lc", "scripts/rover-install.sh"],
    "cwd": "/srv/checkout-web"
  },
  "services": [
    {
      "name": "db",
      // One instance per lease, named after the slot — see "each stop runs with its own
      // lease's slot" below. `$ROVER_SLOT` needs a shell, so the shell is the program.
      "start": {
        "command": "bash",
        "args": ["-lc", "docker compose -p checkout-web-$ROVER_SLOT up -d db"]
      },
      "stop": {
        "command": "bash",
        "args": ["-lc", "docker compose -p checkout-web-$ROVER_SLOT down"]
      }
    },
    {
      "name": "mock-payments",
      "start": { "command": "bash", "args": ["-lc", "scripts/mocks.sh start"] },
      "stop": { "command": "bash", "args": ["-lc", "scripts/mocks.sh stop"] }
    }
  ],
  "teardown": {
    "command": "bash",
    "args": ["-lc", "scripts/rover-teardown.sh"],
    "cwd": "/srv/checkout-web",
    "env": { "STAGE": "local" }
  }
}
```

Five fields, and only these five. `project` is required and **must equal the file's own
name** — a mismatch is refused out loud when the lease ends, in a warning naming both, with that
project's apps and teardown skipped while the device itself is still restored; a file copied from
another project cannot quietly serve this one. `apps` is the list of applications a lease on this project drove;
they are stopped on the device when the lease ends, in the order given, and an empty list is a
perfectly good answer. `install` is one command the **host** runs when a caller asks for
`install_app` **without sending a package** — what installing this project's application means
here, which the core cannot know because it knows no application's name. `teardown` is one command
the **host** runs when the lease ends. `services` are the processes the host runs *for* a lease —
each with a name, a `start` and an optional `stop`. Every hook has the same shape: `command`
and `args` only — never a shell line, because nothing here is word-split or glob-expanded, so an
operator who wants a shell makes the shell the program, as the example does. `cwd` and `env` are
optional, and so is every hook: nothing is defaulted and `services` defaults to empty, because a
default here would be Rover naming somebody's application. There is no **port** field: every
lease receives a private port block automatically, and the hook receives it through the slot
variables described below.

The `install` hook runs only when a caller asks for it — never at grant time — and it gets
`ROVER_PROJECT`, `ROVER_DEVICE_SERIAL` and the slot's three variables (below) the way the
teardown does, so what it builds is
installed onto the device the lease names and never onto a neighbour's. It is bounded at **five
minutes** rather than the teardown's eight seconds, because it is a build and not a stop: that is
a quarter of the twenty-minute lease TTL, which a lease renewed at the start of the call cannot
run out inside, and it is well past a client's own 30 s default request timeout — a caller asking
for a project install has to raise that itself, or it will report a hang on its own machine while
the build is still running on the host. A command that is missing, declares no `install`, or exits
non-zero is a **named** answer to that call (`project-not-registered`, `install-hook-undeclared`,
`install-hook-failed` with the exit code and a stderr tail), never a broken host.

The **helper services** are the one hook the host runs *without being asked*, at both ends of a
lease. A grant starts them in the order they are declared, after the device has been re-verified
and after the previous lessee's state has been put back, and **before the grant is answered** — so
a caller holding a lease has the services that lease implies rather than services still coming up.
One that will not start **refuses the grant, naming it**: `Not granted (service-failed): … the
'mock-payments' helper service declared by project 'checkout-web' did not start — …`, with the
program's own stderr on the end. Anything that grant had already brought up is stopped again, the
lease is handed straight back, and the device is free for the next caller — granting a device whose
helper services are down would be a success that fails at the first thing the agent tries. A hook
file that will not parse refuses a grant the same way, naming the file: a file the host cannot read
is a file whose services it cannot start.

They are stopped by the restoration, in the reverse of the order they were declared in and ahead of
the teardown hook, on **both** paths a lease ends by. Each stop is contained and bounded like the
teardown, and each runs **unconditionally** — the same way an application that was never launched
is still stopped — so a `stop` has to tolerate a service that is not running.

**Each stop runs with its own lease's slot, and that is a contract you have to keep.** Two devices
can be leased for the same project at once — that is what slots are for — and when they are, both
grants run the same declared `start` commands and each lease's end runs the same declared `stop`.
So a `start`/`stop` pair has to **namespace on `ROVER_SLOT`**, the way the `db` service in the
example above does: one instance per lease, and the stop takes down that lease's own. A pair that
ignores the slot and addresses a single shared instance instead — `docker compose up -d db` and
`docker compose down` with no project name — brings up one database that both leases use, and
then the *first* lease to end takes it away from the other, in the middle of its lease, with no
refusal left to tell it. Rover cannot check this for you: a hook is an opaque command, and the host
has no way to read one and tell which of the two shapes it was handed. The same applies to the
**`teardown`** hook, which runs at every lease's end and should undo that lease's slot rather than
the project's shared state.

Two things follow from a start being a bounded command like any other. All of a project's starts
share **twenty seconds** — and so does stopping them again when one of them refuses the grant,
which is inside the same wait the caller is doing. That sits under the 30 s a client waits for a
reply, because `acquire_device` is the one call no client raises its own timeout for: a grant
answered after the caller gave up holds the device for the full twenty-minute TTL, and a refusal
answered late reaches the agent as a request timeout with no service named rather than as the
`service-failed` it is. A `stop` that the budget runs out before is **not run**, and says so in a
warning naming the service that may still be running. And a start should *start* — Rover runs no
health check, waits for no readiness probe and restarts nothing that crashes later; a service meant
to outlive the command that starts it is the project's own business, exactly as it is for a teardown
that backgrounds a helper.

The **teardown** hook runs when a lease on that project **ends by either path — a `rover release`,
and an expiry with the agent that held the device long gone** (`PROJECT.md` D9). Its child gets
`ROVER_PROJECT` and `ROVER_DEVICE_SERIAL` in the environment, on top of the daemon's own and
whatever `env` declares — along with the slot's three, below — so a teardown can name the device
it is undoing and the ports it is freeing. It is bounded: eight
seconds, then the hook's own process is killed and the failure — the exit code and the tail of its
stderr — becomes a warning. The bound is on the hook and not on everything the hook started: a
teardown that backgrounds a helper is finished the moment it exits, and what it left running is
the operator's to manage. A hook that fails costs its own project's steps and nothing else; the
device is still put back.

#### Every lease gets a slot, and its own ports

Two agents starting a helper service at the same moment would otherwise race for the same port
number, which is the thing that stops more than a couple of devices being worked on in parallel
(`PROJECT.md` D13, backlog R18). So **every lease is granted a *slot*** — its numbered parallel
position on this host — and every hook the daemon runs for that lease is told it, on top of
`ROVER_PROJECT` and `ROVER_DEVICE_SERIAL`:

| Variable | What it is |
|---|---|
| `ROVER_SLOT` | The lease's 0-based slot index. Useful wherever a run needs a unique suffix, not just for a port. |
| `ROVER_PORT_BASE` | The first port of this lease's block. |
| `ROVER_PORT_COUNT` | How many consecutive ports from `ROVER_PORT_BASE` are this lease's. |

Read `ROVER_PORT_COUNT` rather than assuming the block size, so a hook does not drift from the
daemon if the number ever changes. The blocks are 8 consecutive ports each, starting at 26000,
with 64 slots — 26000–26511, one contiguous range an operator can reserve or firewall in a single
line. There is **no environment variable to move it**: these are values the daemon sets for a
child, not configuration an operator supplies, and if the range ever collides on a real host that
is a change to make deliberately rather than a knob to leave lying around.

Two things Rover promises here, and one it does not:

- **No two live leases are ever told the same numbers**, however many agents ask at the same
  instant. The slot is taken in the same indivisible step that makes the lease exclusive.
- **A slot comes back when the lease ends, by either path** — a `rover release` or an expiry with
  the agent long gone — and it comes back *after* that lease's teardown has run, so the numbers a
  hook is still shutting down are never handed to the next lessee. An agent that died leaks no
  ports.
- **Rover reserves the numbers; it never binds them and never probes them.** Nothing on the host
  listens on a slot's ports — the project's own service does — so a hook that ignores what it was
  told and hard-codes 3000 is on its own. A hook's declared `env` cannot override the three
  variables above, for the same reason.

If every slot on the host is in use, an `acquire_device` is **refused by name** (`no-slot`, with
a message saying how many there are) rather than granted a lease with no ports.

Four things worth being clear about, because this file's commands run with the daemon's
privileges:

- **It lives on the host, never on the client.** Verbs run where the hardware is (`PROJECT.md`
  D19), and a teardown stranded on the far side of the network could not stop what it started. No
  IPC method reads a hook file, writes one, or takes a path into this directory — a lease carries
  a `project` *string* and nothing else.
- **It is the host operator's file.** Whoever can write into `ROVER_PROJECTS_PATH` can run
  programs as the user the daemon runs as. That is the same trust the daemon already has, and it
  is why the directory is host-side configuration rather than anything a borrower supplies.
- **Nothing is cached.** Every lease that ends re-reads the file, so an edit needs no restart, and
  a file that will not parse is a warning naming the file rather than a project silently treated
  as having no hooks.
- **A lease's `project` string authorizes nothing** (`PROJECT.md` D20) — it attributes, and here
  it also *selects*. Any caller that can take a lease at all, over the local socket or over the
  TCP listener with any operator-issued token, can name any project registered on this host and
  cause that project's teardown and helper services to run when the lease ends — and, with one
  `install_app` carrying no bytes, that project's install command to run while it is held. That is the same trust already
  extended to everyone in `ROVER_USERS_PATH`, but it is worth saying rather than inferring,
  because the natural mistake is a teardown written as though it only ever follows a lease that
  project's own team took — restarting a shared service, clearing shared state — which a mistyped
  or borrowed `project` string on somebody else's lease would then trigger. Per-user project
  authorization is deliberately not in scope: D20 is that the two never mix. Naming a project also
  buys that caller a little of what the host knows about it, because a failed install has to be
  actionable: the answer names the **program** the hook file declared and carries the tail of its
  **stderr**, and if the file exists but will not parse — or disagrees with its own name — the
  `internal_error` that reports the operator's mistake names the **host path** it lives at. The
  three named failures carry no path; that one branch does.

The one thing a **client** may do with a hook file is read the `project` out of it. Point
`ROVER_PROJECT_FILE` at one — the project's own copy in its repository will do; it need not be the
host's — and `rover acquire` stops needing `--project`, as does the MCP `acquire_device` tool
(`PROJECT.md` D22). That is a convenience about who types the string and nothing else: the client
reads that one field, never `apps`, `install`, `services` or `teardown`, never runs anything the file declares, and the
lease still carries `project` as the plain string it always was. A file that is named but missing
or unparseable fails on the spot, naming it. `--owner` is untouched by all of this and is never
derived from anything (D16, D20).

### The artifact archive

A screenshot, a recording or a log read comes back to whoever asked as bytes — that is the whole
contract, and it is unchanged. The host *additionally* keeps a copy of its own, filed so that two
runs of the same named check, taken at two different points in time, sit next to each other:

```
~/.rover/artifacts/
  <project>/
    <test_name-or-"unlabeled">/
      20260830T170501Z-issue-112-9f1c2ab4/   # one lease: when it started, who held it
        <device-serial>/
          device_info.json                   # size, density, dp scale, OS version
          screenshots/001_screenshot.png
          recordings/001.mp4
          recordings/001_frames/0001.png
          logs/001_read_logs.txt
```

`project` and `--test-name` are the two strings you set on `rover acquire`; both are opaque —
nothing parses them — and an absent test name files under `unlabeled`, so the shape never varies.
The test name is deliberately **not** unique: run "home screen" before a refactor and again after
it, `ls` that directory, and the two most recent lease folders are the two sides of the diff.

Two things worth knowing. The archive is never what a verb answers with — a path here means
nothing on the machine the agent runs on, so you are handed the bytes and decide where they go.
And **nothing prunes this tree**: retention is deliberately out of scope for now
(`PROJECT.md` §9.4), so on a host that records video all day it is the directory to watch.

### Managing host users

`rover users` is the host's own credential file and the command that manages it (`PROJECT.md`
D25). It runs **on the machine holding the devices**, against `~/.rover/users.json` directly — no
network, no daemon, no `--host`, and it works with nothing running.

```bash
npm run rover -- users add alice --name "Alice Example"   # prints the token once
npm run rover -- users list                               # identifier, name, created — never a token
npm run rover -- users rotate alice                       # a fresh token; the old one stops working
npm run rover -- users revoke alice                       # removes the record outright
```

The token is printed **exactly once**, by `add` and by `rotate`. Only its `scrypt` hash — a fresh
random salt per record, `node:crypto` and no dependency — is written to the file, which is created
mode `0600`; `list` never prints a token or a hash, and nothing can show a token again. An operator
who loses one runs `rotate`, which is what makes that safe. A duplicate identifier is refused by
name rather than overwritten, because an overwrite would silently revoke a credential somebody is
holding.

**This store is what the network listener authenticates against.** A token issued here is the value
a client puts in its own `ROVER_HOST_TOKEN`, and it is the only way in — there is no shared secret
beside it (`PROJECT.md` D20, D25). The daemon re-reads the file at **every connection attempt** and
caches nothing, so `revoke` and `rotate` bite on that user's very next attempt with the daemon
still running: no restart, no signal, nothing to reload. `add` works the same way in the other
direction — a user created while the daemon is up can connect immediately.

### Exposing a host on the network

A network host is a **service its operator starts on purpose**, never something a client brings up
behind their back — `rover list` clears `ROVER_LISTEN_PORT` in any daemon it autostarts, so the
listener only ever exists because somebody exported `ROVER_TLS_CERT`, `ROVER_TLS_KEY` and
`ROVER_LISTEN_PORT` and ran the daemon.

The commands — the certificate, the three exports, the daemon and the token — are in [expose this
machine as a host](#expose-this-machine-as-a-host) above, with the output each one printed.
Substitute the host's own address on the network for the `127.0.0.1` they were run against, in the
certificate's `subjectAltName` and in `ROVER_LISTEN_ADDRESS` alike.

**The host holds no secret of its own.** Access is one token per user, issued by `rover users add`
and taken away by `rover users revoke` on this machine — so there is nothing here to copy to a
client except the token that command printed for it, and nothing to rotate everywhere at once when
one person leaves. `.gitignore` refuses `*.pem` and `*.key` so a certificate generated inside a
checkout cannot be committed by accident. A caller that fails to authenticate is told only that
authentication failed — no reason, no device list, no serials, and not even whether the token was
unknown or revoked — and the connection is closed.

### Connecting to a remote host

On the machine doing the work, point the client at that host and add `--host remote`.

The four exports and the commands that follow them are in [take a device on another
machine](#take-a-device-on-another-machine) above, along with the `env` block an MCP server reaches
the same host through.

Copy the host's certificate to the client and name it in `ROVER_HOST_CA` — that is how a
self-signed host is trusted, and there is no flag anywhere that skips the check instead. Omit
the variable only if the host's certificate is signed by a CA the machine already trusts.

Three failures are three different messages, on purpose, because they call for three different
next moves: **nothing is listening there** (the address, the port and `ECONNREFUSED` — a remote
host is a service its operator starts, and no client will ever start one for you); **the host
rejected `ROVER_HOST_TOKEN`** (no user on that host holds this token, or the one who did has been
revoked or rotated — ask its operator for a fresh `rover users add`; the value itself is never
printed); and **the certificate was not trusted** (name it in `ROVER_HOST_CA`). None of
them is ever an empty device list, and none of them ever waits: a peer that accepts the
connection and then never completes the TLS handshake — a forwarded port whose far end is gone,
a load balancer with no live backend — is given ten seconds and then reported as `ETIMEDOUT`,
naming the same address and port. A certificate that verifies but does not carry
`ROVER_HOST_ADDRESS`'s value in its `subjectAltName` is a fourth, separate message, because
`ROVER_HOST_CA` is not what fixes it.

## Where things are

| Document | What it answers |
|---|---|
| [`PROJECT.md`](PROJECT.md) | Why this exists, the decisions and their reasoning, the verb set, verified adb recipes, the backlog |
| [`ai/RULES.md`](ai/RULES.md) | The single source of truth for agents working in this repo — read it first |
| [`ai/ARCHITECTURE.md`](ai/ARCHITECTURE.md) | The four components, the lease lifecycle, where the iOS seam runs |
| [`ai/CODING_STANDARDS.md`](ai/CODING_STANDARDS.md) | Stack, Zod boundaries, error handling, module shape |
| [`ai/TESTING.md`](ai/TESTING.md) | Vitest, the real-device gate, fixtures, conformance |

In the source tree: `src/core/` holds the device contract and the branded ids, `src/backends/` one
folder per platform, `src/verbs/` the verb spine with the input verbs, the app verbs, the read verbs
and the waits described above, `src/ipc/` the
wire protocol and the transport-agnostic client and server, `src/daemon/` the socket and the
inventory and the leases — plus the host-side tools the verbs are handed, such as the frame
extractor, the durable artifact archive (`src/daemon/archive.ts`) and the per-project hook files
(`src/daemon/project-hooks.ts`) — `src/cli/` the `rover` command, and `src/mcp/` the MCP server,
whose entry an agent's configuration names through `bin/rover-mcp.mjs`.

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
healthy — it needs no device and no host tool. `npm run test:device` needs a device on `adb`, and
the `record_video` cases additionally need `ffmpeg` on `PATH`; a host missing either **skips those
suites loudly** rather than failing or passing in silence. Issues are filed with `/write-issue` and implemented with
`/solve-issue`; both are committed under `.claude/skills/`. Work is also delegated to
[Swarm](https://github.com/SmartTechBrewery/swarm), which is why every issue carries the `swarm`
label.
