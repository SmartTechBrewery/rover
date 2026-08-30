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

**There is a CLI** (D4) — `rover list`, `acquire`, `release`, `screenshot`, `record`, `status` and
`users`, human-readable by default and one JSON document on stdout with `--json`, every diagnostic
on stderr. It holds no verb logic: each command parses flags, calls one IPC method, renders the
answer and picks an exit code. `list` shows what is attached, what is free and who holds the rest —
the owner, project and test name, and how much longer they have — and says out loud when the host
does not know its own view to be current, rather than quietly printing a short list. `acquire`
requires an explicit `--owner` and `--project` and derives neither. `status` says which host
answered. The host is named by `--host`: no flag means the local one, `remote` is the machine
`ROVER_HOST_ADDRESS`, `ROVER_HOST_PORT` and `ROVER_HOST_TOKEN` name, and anything else fails loudly
instead of hanging. `screenshot` and `record` are the two commands that bring bytes back: the verb
runs on the host and the capture returns base64 rather than a path (D19), so `--out` is a path on
**this** machine, it is required — there is no filename the CLI could invent that anything calling
it could predict — and the path reported is `path.resolve` of what you passed. What decoded is
checked against the byte length the host encoded before anything is written, so a capture the host
refused, or one that did not survive the trip, exits 1 and leaves no file at `--out` at all rather
than a short one. `rover record --duration-ms <n>` raises its own request timeout past the
recording, so a long recording is never a hang. `users` is the one command that asks no host at
all: it reads and writes this machine's own `~/.rover/users.json` directly, works whether or not a
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
of anything bigger, and the durable copy the host keeps, are their own issues.

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
are recorded rather than hidden. **`install_app` has not been run against a device by anyone yet**:
there is no APK in this repository and adding a binary to carry one is not a change's job, so the
verb is unverified on hardware — read that as a stated gap rather than as a check somebody
completed. What is established is the half adb settles before the device is involved, which is the
half `withInstallablePackage` exists for: `adb install -r` refuses a file whose name does not end
`.apk` or `.apex`, and takes the same bytes once renamed. Everything else about it — the decode,
the host temp file and its removal, the size refusal — is covered over a stub backend. And a
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
`ROVER_HOST_CA`, never by turning verification off. The backlog is twenty issues in dependency
order — see [`PROJECT.md`](PROJECT.md) §9.3.

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
| `ROVER_LISTEN_PORT` | unset — **no network listener** | The opt-in switch for the TCP+TLS listener that serves the same IPC surface as the local socket. Unset or empty and nothing binds, nothing else below is read, and the daemon is a purely local host. Set it and the next two become **required together**: a port with no TLS material would be a listener nobody could trust, so a missing one is a startup failure naming every variable still missing rather than a half-configured host. Who may connect is not a variable at all — it comes from the user store (`ROVER_USERS_PATH`), which always resolves, so a host with no users yet starts and refuses everyone. 1–65535. |
| `ROVER_TLS_CERT` | — (required with the port) | Path to the PEM certificate (chain) the listener presents. |
| `ROVER_TLS_KEY` | — (required with the port) | Path to the matching PEM private key. Unreadable material is a startup failure naming the variable and the path, not a TLS mystery on the first connection. |
| `ROVER_LISTEN_ADDRESS` | `0.0.0.0` | Which interface the network listener binds, so an operator can narrow it to a VPN or loopback interface instead of every one. Only read when the port is set. |
| `ROVER_HOST_ADDRESS` | unset — **no remote host** | The opt-in switch on the *client* side: the address of the host `--host remote` asks. Unset or empty and nothing below is read, `--host remote` is a usage error, and `rover` is a purely local client. Set it and `ROVER_HOST_PORT` and `ROVER_HOST_TOKEN` become **required together**, because a client cannot guess either — a missing one is a usage error naming every variable still missing. Exactly one remote host is configurable (`PROJECT.md` D18); there is no catalogue. |
| `ROVER_HOST_TOKEN` | — (required with `ROVER_HOST_ADDRESS`) | **A client-side credential, and only that** — the value `rover users add` (or `users rotate`) printed on the host, pasted on the machine that borrows a device. The host itself no longer reads this variable: it authenticates against its user store, so a token is revocable and rotatable where it was issued rather than being a secret both machines hold forever (`PROJECT.md` D25). At least **32 characters**, checked locally so a truncated paste fails here naming the variable instead of coming back as an opaque refusal. It is a **host-level** setting and belongs in the environment, never in a file the repository tracks. The token **authenticates and attributes nothing**: a lease's owner is a separate, caller-supplied string (`PROJECT.md` D20). |
| `ROVER_HOST_PORT` | — (required with the address) | The port that host listens on — its own `ROVER_LISTEN_PORT`, named from the other side. 1–65535. |
| `ROVER_HOST_CA` | unset — the system trust store | Path to a PEM certificate to trust in addition to nothing else — normally the host's own certificate, which is how a self-signed host is trusted. There is deliberately **no variable that turns verification off**: a client that skipped the check would accept any host that answered on that port. |

While a daemon is coming up over a socket a crashed one left behind, a `<socket>.reclaim` lock file
may briefly appear beside it. It is removed by whoever took it, and any left behind by a killed
process is discarded on age by the next start.

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
listener only ever exists because somebody exported these three variables and ran the daemon.

```bash
# A certificate for the host. Use your own CA in anything that matters; this is the shape.
openssl req -x509 -newkey rsa:2048 -nodes -days 365   -keyout rover-key.pem -out rover-cert.pem   -subj "/CN=rover-host" -addext "subjectAltName=DNS:rover-host,IP:10.0.0.4"

export ROVER_TLS_CERT=/etc/rover/rover-cert.pem
export ROVER_TLS_KEY=/etc/rover/rover-key.pem
export ROVER_LISTEN_ADDRESS=10.0.0.4                # optional; 0.0.0.0 otherwise
export ROVER_LISTEN_PORT=4711                       # the switch — set it last
npm run daemon

# Issue access, per person, before or after the daemon is up — it re-reads the store every time.
npm run rover -- users add alice --name "Alice Example"
```

**The host holds no secret of its own.** Access is one token per user, issued by `rover users add`
and taken away by `rover users revoke` on this machine — so there is nothing here to copy to a
client except the token that command printed for it, and nothing to rotate everywhere at once when
one person leaves. `.gitignore` refuses `*.pem` and `*.key` so a certificate generated inside a
checkout cannot be committed by accident. A caller that fails to authenticate is told only that
authentication failed — no reason, no device list, no serials, and not even whether the token was
unknown or revoked — and the connection is closed.

### Connecting to a remote host

On the machine doing the work, point the client at that host and add `--host remote`:

```bash
export ROVER_HOST_ADDRESS=10.0.0.4                  # or the hostname on its certificate
export ROVER_HOST_PORT=4711
export ROVER_HOST_TOKEN="…"                         # the token `rover users add` printed on the host
export ROVER_HOST_CA=/etc/rover/rover-cert.pem      # optional; the system trust store otherwise

npm run rover -- list --host remote
npm run rover -- acquire <serial> --host remote --owner issue-112 --project rover
```

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
| [`PROJECT.md`](PROJECT.md) | Why this exists, the sixteen decisions and their reasoning, the verb set, verified adb recipes, the backlog |
| [`ai/RULES.md`](ai/RULES.md) | The single source of truth for agents working in this repo — read it first |
| [`ai/ARCHITECTURE.md`](ai/ARCHITECTURE.md) | The four components, the lease lifecycle, where the iOS seam runs |
| [`ai/CODING_STANDARDS.md`](ai/CODING_STANDARDS.md) | Stack, Zod boundaries, error handling, module shape |
| [`ai/TESTING.md`](ai/TESTING.md) | Vitest, the real-device gate, fixtures, conformance |

In the source tree: `src/core/` holds the device contract and the branded ids, `src/backends/` one
folder per platform, `src/verbs/` the verb spine with the input verbs, the app verbs, the read verbs
and the waits described above, `src/ipc/` the
wire protocol and the transport-agnostic client and server, `src/daemon/` the socket and the
inventory and the leases — plus the host-side tools the verbs are handed, such as the frame
extractor — and `src/cli/` the `rover` command.

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
