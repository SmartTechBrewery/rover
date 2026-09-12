# Rover — the feature catalogue

**Who this is for: agents, not users.** It is the long-form inventory of what Rover actually does,
written so that anything user-facing — the `README.md`, a release note, an issue's motivation
paragraph, the `ROVER.md` an agent reads before its first call — can be *derived* from one place
instead of re-derived from the source every time. It is deliberately verbose where the README must
be terse.

Every feature below carries the same three things:

- **The hook** — one sentence a person would recognise as a reason to use Rover. This is the line
  the README is allowed to quote; everything under it is the part the README must leave out.
- **What it is** — the long description, including the reasoning, because a feature stripped of
  its reasoning gets re-litigated by the next agent that meets it.
- **Where it lives** — the modules, the decisions in `PROJECT.md`, and the documents that own the
  detail.

Two rules for keeping this file honest:

1. **This document describes what exists**, on the same terms `ai/RULES.md` §6 sets for everything
   else. A feature that is planned goes in `PROJECT.md` §9's backlog, never here. Where something
   works only under a condition — a program installed, a platform, a size — the condition is part
   of the description.
2. **When a change adds, removes or reshapes a feature, this file is edited in the same change**,
   the way `PROJECT.md` and `README.md` are (`ai/RULES.md` §1). A reversed decision is rewritten in
   place with its reasoning, not deleted.

---

## 0. The one-paragraph product, and the line it will not cross

**The hook.** Rover gives a coding agent hands and eyes on a real mobile device, and lends those
devices out one at a time so several agents — including agents on other machines — can work in
parallel without fighting over the hardware.

**What it is.** Four parts: a **daemon** (one per machine with devices — owns the inventory, grants
leases, runs the verbs, restores state, keeps the archive), a **core** library (the device
abstraction and the verbs), a **CLI**, and an **MCP server** (one per agent session). The CLI and
the MCP server are *clients*: they ask, they never touch hardware. Android over `adb` and iOS
simulators over `simctl` + `idb_companion` are the two backends that exist.

**The line.** Rover is **not a test framework**. Nothing asserts, nothing goes red on its own,
nothing is a CI gate. It moves the device and reports what is on it; judging whether that is
correct is the agent's job. What is forbidden everywhere, in every surface: a pass, a fail, a
score, a percentage, a similarity figure, a threshold, a baseline arm and a current one, a
red/green pairing, a ranking of findings, anything that goes red by itself.

**Where the line was drawn, exactly** (`ai/RULES.md` §1, settled 2026-09-10): the rule is about
**verdicts, not arithmetic**. *These two files differ in this rectangle* is measurement of the same
class as a file's size on disk, and it is allowed — see §14. *Whether that difference is good* is
not, and never will be. A feature that computes something must be able to say which side of that
line it is on **in one sentence**.

**Why it exists at all.** An agent can build a mobile app and cannot look at it. Everything else
here follows from that sentence, plus the fact that a phone is a single-occupancy resource on a
desk that several agents want at once.

---

## 1. One device abstraction, two platforms, no platform-shaped verbs

**The hook.** The same `tap`, `read_screen` and `screenshot` on an Android phone and on an iOS
simulator — and where a platform genuinely cannot do something, it refuses **by name** instead of
pretending.

**What it is.** `src/core/device.ts` is the device contract; `src/backends/<platform>/` is one
folder per backend, joined to the registry through **one import line** in the barrel
(`src/backends/index.ts`). Adding the iOS backend cost a folder and that line — no edit to
dispatch, to the registry, or to any verb. No shared code may branch on the platform; a missing
ability is a **declared capability**, not a missing method (`ai/RULES.md` §2, `PROJECT.md` D10).

The two registered backends:

- **`android`**, over `adb`. Answers everything the contract asks for, including the network
  toggles, and reads its own screen through the view hierarchy.
- **`ios-simulator`**, over `simctl`, with **`idb_companion` beside it** for the screen read and
  the four input primitives. Named `ios-simulator` and not `ios` on purpose: a physical iPhone
  cannot answer `screenshot` at all, so hardware is a different backend, not a gap in this one.

**Capabilities are a Zod manifest per backend**, gated by a conformance suite that now runs over
two manifests rather than one — which is the only arrangement in which it can tell a passing
backend from a check that stopped checking. The iOS backend is the first to declare something
**`false`**: `canControlNetwork`, permanently, because a simulator uses the host's network stack —
the only truthful `set_wifi` would change the networking of the machine lending devices to other
people, and the cosmetic status-bar override `simctl` will happily draw is precisely the
plausible-looking answer this project refuses. `canReadScreen` (#251) and `canInput` (#252) both
started `false` and have since flipped to `true`.

**Refusals get finer than a flag.** `press_key` on a simulator answers `home` and `wake` and
refuses `back` and `recents` as `unsupported-key`, naming the key — a device that takes input
saying so about *one key* rather than claiming it takes none. That is a different answer from
`missing-capability` on purpose: one says try another key, the other says try another device.

**Where it lives.** `src/core/device.ts`, `src/core/capabilities.ts`, `src/backends/`,
`docs/IOS.md` (every iOS claim measured, with the traps), `PROJECT.md` D10, §5.

---

## 2. Leases — the reason the daemon exists

**The hook.** A lease grants **one device** to one named owner; a busy device answers with *who
holds it and for how long*, never an error; and a lease that stops being used lets go on its own.

**What it is.** `acquire_device` takes a serial and three required strings the host **stores and
never inspects** — `owner`, `project`, `test_name` — plus two optional ones, `test_description`
and `group_id`. None is ever derived from who you are or from what authenticated you: *the token
authenticates, the owner string attributes* (D16, D20, D22). Five clients asking at once produce
exactly one winner.

- **The TTL is 20 minutes, renewed by activity rather than by a heartbeat.** An agent that pauses
  to think keeps its device; one that died lets go without anyone reaping it by hand.
- **A held device is a refusal, not an error** — it names the holder, the project, the test name
  and the remaining time, and **never the holder's lease id**. The lease id is the credential every
  verb call carries; it is printed once, to whoever was granted it.
- **`group_id` is the one string the host does not merely store.** You name the investigation, the
  host **mints** the id — your name plus a reserved `.` and a short suffix — and answers with it on
  the grant. Passing the same *name* twice therefore files two groups, which is the point: a name
  an agent picked from what it was looking at is not a source of uniqueness. A name containing the
  separator is refused (`separator-in-group-id`), and one too long to mint inside 256 characters is
  refused (`group-id-too-long`) rather than truncated into a different group. Nothing is looked
  up — uniqueness comes from the minted bytes, so the host still holds no index (D6).
- **`test_description`** is prose the host stores, shows beside the test name in the panel, and
  files with the run so it outlives the lease.
- **Every lease also gets a slot and a private port block** — see §12.

**Force-release is the operator's, and still hands out no lease id** (D28). `force_release_device`
is keyed on the **serial**, which every listing already shows, precisely because ending somebody
else's lease has no credential of theirs to present. It runs the same restoration path a normal
release does, the holder's next verb call is refused `no-lease`, and `actor` — a caller-supplied
string, derived from nothing — records who did it. `not-held`, `gone` and `not-attached` are three
different next moves rather than one error.

**Where it lives.** `src/daemon/leases.ts`, `lease-handlers.ts`, `lease-holder.ts`,
`group-id.ts`, `slots.ts`; `PROJECT.md` D6, D9, D16, D20, D22, D28.

---

## 3. The host restores the device — always, and never the caller

**The hook.** However a lease ends — released, force-released, or expired with the agent long
gone — the host puts the device back before anyone else gets it.

**What it is.** The predecessor tool *asked* callers, in a comment, to clean up before releasing;
nobody ever checked and nobody ever did. So restoration runs from the one place a lease is observed
to end (D9), in this order:

1. **Stop a recording the lease left running, and delete the file** — the recorder goes first
   because it is the driver most likely to still be holding the device, and its bytes are
   *dropped*: a lease that ended has nobody left to hand a recording to.
2. **Stop the project's applications** (the `apps` the hook file declares, in order).
3. **Airplane mode off, then wifi on** — in that order, for the reason `PROJECT.md` §6 records.
4. **Stop the project's helper services**, in reverse declaration order.
5. **Run the project's teardown hook**, bounded at eight seconds.

A step that fails is reported and **the remaining steps still run** — including when a project
resolver throws, which costs that project's own steps and never the device's. A device is never
handed to the next lessee while its restoration is still in flight. An unref'ed sweep is what
notices a lease whose holder died, and daemon shutdown sweeps once more and then waits, bounded,
for what it still owes — leases die with the host, so a restoration abandoned there is one nothing
will ever retry.

**Where it lives.** `src/daemon/restore.ts`, `project-services.ts`, `project-hooks.ts`;
`PROJECT.md` D9.

---

## 4. The verb set — twenty-five tools over one method table

**The hook.** Everything an agent needs to drive a device: touch, text, keys, waits, screen reads,
screenshots, video, logs, app control, file transfer and the radios — one vocabulary, on both
platforms.

**What it is.** `src/verbs/` is the layer above the backends. Every verb takes and returns Zod
schemas of plain data, because the host runs the verb and the agent reads the answer somewhere else
(D19). A verb call carries the **lease id**, never a serial — the host derives the device from the
credential.

| Family | Verbs | Notes |
| --- | --- | --- |
| Input | `tap`, `long_press`, `swipe`, `scroll`, `type_text`, `press_key` | six uses of one spine; `src/verbs/input.ts` |
| Waits | `wait_for`, `wait_until_gone` | the vocabulary that replaces `sleep`; `wait-for.ts` |
| Reads | `read_screen`, `device_info`, `screenshot` | `read.ts`; `screenshot`'s answer is bytes |
| Apps | `launch_app`, `stop_app`, `clear_app_data` | address a package, resolve no target; `app.ts` |
| Logs | `read_logs` | bounded, never follows; `logs.ts` |
| Recording | `record_video`, `start_recording`, `stop_recording` | `record.ts`, `recording-session.ts` |
| Files | `install_app`, `push_file`, `pull_file` | `files.ts`; §11 covers which are MCP tools |
| Environment | `set_airplane_mode`, `set_wifi` | `environment.ts`; declares `canControlNetwork` |
| Device & lease | `status`, `list_devices`, `acquire_device`, `release_device` | the four non-verb rows |

**Composition happens once, above the backends.** `long_press` is a drag from a point to that same
point held past the device's long-press timeout — never the long-press flag on a key event, which
applies to keys and not to touch. `scroll` is a drag across the middle of a region. So neither
needs anything new from a backend: the device interface keeps its four input primitives.
`scroll`'s direction is where the **content** goes — the sense a scrollbar and a wheel already
have — so `scroll 'down'` drags upwards; it scrolls the element it was pointed at, or the screen
when pointed at nothing, and it refuses a bare coordinate, because a point has no extent and cannot
say how far a scroll may travel.

**`type_text` and `press_key` address no element**, so their result's `target` is `null` — a fact
about the verb, not a resolution that failed. There is deliberately no target option on
`type_text`: an agent that wants text in a field taps it and then types. `type_text` hands the
string to the backend **byte for byte** — a string this layer had helpfully escaped would arrive on
screen with the escaping in it — and what a device cannot type at all comes back as
`unsupported-text` naming the characters as escapes.

**`read_screen` is a first-class verb and not a fallback.** It survives an app blocking screen
capture, which is the case where pixels are gone and nothing is logged about it (§16).

**Where it lives.** `src/verbs/`, `src/ipc/` for the method table, `PROJECT.md` §4.

---

## 5. Determinism by construction

**The hook.** A target resolves from a screen captured *inside* the call, waiting is on a condition
with a timeout, and every action answers with the state after itself — so the three classic ways an
agent gets a false green are closed in the tool rather than left to the agent's discipline.

**What it is** (D12), and all three are enforced by shape, not by convention:

- **`resolveTarget()` takes a target and nothing else** — no screen, no element list, no state read
  a turn ago. A coordinate remembered from a previous turn is the single most common source of a
  false green in this class of tool, and here there is nowhere to pass one. Two elements matching
  one text target is a **loud error naming every candidate** rather than a first match that is
  right half the time; nothing matching names what was on screen instead; a coordinate remains the
  documented fallback and is marked in the result as not having come from a screen. Every resolved
  point is range-checked against the device — an element scrolled out of its container comes back
  with an inverted rectangle, and the midpoint of that is arithmetic rather than a place to tap, so
  it is refused by name.
- **No `sleep`, anywhere.** `src/core/wait.ts` is the only module allowed to construct a delay:
  `waitForCondition` polls a probe until the condition is met or the deadline passes, and a probe
  reporting *unmet* is required **by its own type** to say what it found instead, so a timeout
  names both halves. `tests/unit/no-sleep.test.ts` scans `src/` and `tests/` for every promisified
  timer shape a sleep is spelled with; three files are exempt. It is a floor, not a proof.
- **Every action returns the state after itself**, through `performAction()`: consult the
  capability manifest **before** touching the device, resolve fresh, act, then read the state
  after. A device that cannot read its screen answers "unavailable, and here is the capability that
  would have answered" rather than an empty list that reads as a blank screen; a read that was
  attempted and failed says *that*, because an exception after the action has run is the one answer
  that leaves an agent guessing whether it landed.

**The two waits stand beside the spine rather than on it**, because `performAction()` resolves
before it acts and for a wait the resolution *is* the work. **Every poll reads the screen again** —
a wait over one cached read is the stale-coordinate failure with a timer attached. `wait_for` waits
until the target is there *and* actionable, so an element still clipped out of its scrolling
container is *not yet* rather than a failure, while an ambiguous target is refused outright,
because more polling cannot specify an under-specified request. `wait_until_gone` asks the mirror
question of *matches* rather than of a resolution, and will not take a text target's `index`, since
an index names a slot in the match list and a slot empties the moment any sibling leaves.

**Where it lives.** `src/verbs/perform.ts`, `target.ts`, `wait-for.ts`, `src/core/wait.ts`,
`tests/unit/no-sleep.test.ts`; `PROJECT.md` D12.

---

## 6. The daemon — one per machine, starts itself, caches nothing it cannot re-derive

**The hook.** There is nothing to start: the first command that needs a device brings the host up,
and two agents can never end up driving the same phone.

**What it is.** The daemon binds a unix socket, serves a schema-checked IPC surface over it, and
**starts itself on the first call** (D5) — two concurrent callers producing exactly one daemon. It
holds a **device inventory** fed by each backend's change stream, and it is an inventory of *what
can be borrowed now*, not a catalogue of what the machine could run: a virtual device nobody
started is not in it, the way an unplugged phone is not, while an attached-but-unusable device
stays listed with the state that says why (D41). Anything reached through `adb connect` is refused
outright — it is not this machine's hardware, and treating it as if it were is the
two-agents-one-device failure wearing a disguise (D18).

**The inventory is a cache and never the authority** (D6). A lease **re-verifies its device against
the backend at grant time**, and `list_devices` answers `stale` whenever the list is not known to
be current — with a `staleReason` in the one case that will not clear on its own,
`tooling-missing`, which names the program the host could not run and the platform it therefore
cannot see. Every transient interruption leaves the reason `null`.

**Why a daemon at all.** Two agents have two separate MCP servers that cannot see each other, while
the devices are shared. Without a daemon, an unpinned install reaches every attached device and one
agent screenshots the other's build.

**One method table, three transports.** The unix socket, the TCP+TLS listener (§7) and the HTTP
surface the browser uses (§15) all dispatch the same table from the same handler — no second
implementation of anything, and no status path that exists only inside the MCP layer
(`ai/RULES.md` §1, D29).

**Where it lives.** `src/daemon/` (`main.ts`, `host.ts`, `listen.ts`, `inventory.ts`,
`connect.ts`), `src/ipc/`; `PROJECT.md` D5, D6, D18, D41.

---

## 7. Devices on somebody else's machine

**The hook.** The laptop with the phones on the desk can lend them to agents working on other
machines, over TLS, with one token per person.

**What it is.** Setting `ROVER_LISTEN_PORT` — with `ROVER_TLS_CERT` and `ROVER_TLS_KEY` beside it —
starts a TCP+TLS listener alongside the local socket, serving the same surface (D17, D20, D25). It
is opt-in in the strongest sense: **`rover list` clears that variable in any daemon it autostarts**,
so a listener only ever exists because an operator exported those variables and ran `rover server`
on purpose.

- **Authentication is a one-line greeting the transport reads and consumes** before the message
  surface sees the connection, so a token never enters a request and can never become a lease's
  owner.
- **The host holds no shared secret.** `rover users add <id>` prints a token **once** and stores
  only its `scrypt` hash (fresh salt per record, `node:crypto`, no dependency) in
  `~/.rover/users.json`, mode `0600`. `users list` never shows a token or a hash; `users rotate`
  mints a fresh one; `users revoke` removes the record. A duplicate identifier is refused rather
  than overwritten, because an overwrite silently revokes a credential somebody is holding.
- **The store is re-read at every connection attempt.** `revoke` and `rotate` bite on that user's
  very next call with the daemon still running — no restart, no signal, nothing to reload.
- **Every pre-auth failure is one byte-identical refusal and a closed connection** — no reason, no
  device list, no count, no serials, no user, because a refusal that varied would be an oracle.
- **`rover users` needs no daemon and takes no `--host`.** It edits this machine's own file.

**On the client**, four environment variables (`ROVER_HOST_ADDRESS`, `ROVER_HOST_PORT`,
`ROVER_HOST_TOKEN`, optional `ROVER_HOST_CA`) plus `--host remote` — the identical method table,
answers and exit codes. **A client never starts a remote host.** The four ways this goes wrong are
four different messages because they call for four different next moves: `ECONNREFUSED` naming the
address; a rejected token (never printed); an untrusted certificate (`DEPTH_ZERO_SELF_SIGNED_CERT`
→ name it in `ROVER_HOST_CA`); and a certificate that does not carry that address in its
`subjectAltName` (`ERR_TLS_CERT_ALTNAME_INVALID`, which `ROVER_HOST_CA` does *not* fix). None of
them is ever an empty device list and none hangs — a peer that accepts and then stalls the
handshake is given ten seconds and named as `ETIMEDOUT`. Verification is never turned off; there is
no flag that skips it.

**What is deliberately absent: discovery.** No host catalogue, no registration, no "connect to
somebody else's host" story. A client is configured with one host's address and nothing else
(`PROJECT.md` §7, D18).

**Where it lives.** `src/daemon/network-listen.ts`, `network-connect.ts`, `network-config.ts`,
`user-store.ts`, `user-token.ts`; `PROJECT.md` D17, D20, D25.

---

## 8. Artifacts come back as bytes, and the host keeps its own copy

**The hook.** Whatever a verb captures is handed to the caller as bytes — never a path on a machine
they are not on — and the host *additionally* files a durable copy, so a run from last week is
still there to look at.

**What it is.** Two halves that must not be confused.

**The answer.** `screenshot`, `record_video`, `stop_recording` and `pull_file` answer on
`result.artifact`: base64, a media type, and the length those bytes decode to. **Never a path.**
The capture happens on the host and the answer is read wherever the agent is, so a filesystem
location would name a file that is not there — or worse, one that is. Where the bytes land is the
client's own decision and the client's own disk. `read_logs` carries its own payload: the device's
log parsed into neutral entries (timestamp as the device printed it, level, tag, pid, line),
bounded, newest kept, with `truncated` saying when there were more — because a short read that
reads as a quiet device is worse than no read. It never follows: following would be a wait with no
condition and a stream over IPC.

**The archive** (D24, R36). A four-level tree under `ROVER_ARTIFACTS_PATH`:

```
~/.rover/artifacts/<project>/<test_name>/<runId>/<device-serial>/
    device_info.json          # size, density, dp scale, OS version, system bar insets
    test_description.json     # what the lease said this run was about, if anything
    group_id.json             # which investigation this run belongs to, if any
    screenshots/001_screenshot.png
    screenshots/002_home-screen_screenshot.png     # when the call carried a label
    recordings/001.mp4
    recordings/001_frames/0001.png
    logs/001_read_logs.txt
```

The run directory leads with a **UTC timestamp** precisely so text order is chronological order —
nothing parses a directory name to work that out — followed by the owner and a short id.
`test_name` is deliberately **not** unique: run "home screen" before a refactor and again after it,
and the two most recent run directories are the two sides of the diff. A **label** is the one
caller string that reaches a name, and it is a *file* name, right after the sequence number, so
listing `screenshots/` shows which captures are the same screen. `test_description` and `group_id`
shape none of the tree — the tree is always four levels, so a group would have to be a fifth — and
are filed as sidecar files written once and never rewritten.

**Everything the archive writes is written once.** That is why the `Keep` flag (§13) lives outside
it.

**Where it lives.** `src/daemon/archive.ts`, `archive-path.ts`, `archive-file.ts`;
`PROJECT.md` D19, D24, §10.

---

## 9. Recording that actually plays

**The hook.** `record_video` hands back an mp4 a player will open, plus the frames sliced out of
it — and `start_recording` / `stop_recording` let an agent record *while it does something*.

**What it is**, and every clause here exists because the naive version fails:

- **Finished before it leaves the device.** A recorder writes its container index **last**, so a
  file copied a moment early is not a shorter video, it is a file no decoder will accept — which
  reads like a broken tool rather than a race. The host records, waits **on a condition** for the
  recorder to be gone, pulls, checks the index on the bytes that actually arrived, and only then
  answers. Missing index → `unfinished-recording`, carrying the device and the byte length.
- **Normalised on the host, so the file always plays.** A device recorder produces samples only
  where the screen changed: a capture of a still screen is a structurally valid MP4 with **one
  sample declaring a duration of zero** — nothing to scrub, and no player will show anything.
  So the host re-encodes at a constant frame rate over a real timeline, and `result.normalisation`
  says **which** timeline you are looking at: `requested` (the window you asked for, when the
  recording declared none of its own) or `container` (the recorder's own timestamps, every sample
  intact). Those two are different numbers and the second is routinely larger.
- **The answer says what was recorded, separately from what you were handed.** `result.container`
  carries the encoded sample count and the duration the file itself declares, read **as it came off
  the device** — a fifteen-second capture of a barely-changing screen has been measured declaring
  27.61 s. A recording of a screen that never changed is named as exactly that (`still-screen`),
  with the reason in words: it still exits 0, still writes the video, still carries its frame. The
  point of naming it is that every other check passes for it, so an agent seeing one frame had
  nothing to conclude from but its own suspicion.
- **Frames come back beside the video**, on `result.frames` — PNGs in order, each with its media
  type and byte length, never a path — sliced from the **finished** recording on the host, so the
  device is touched once and never sampled while recording. They are scaled down on purpose: a
  frame is for reading *what changed*, and the full-resolution read of one moment is `screenshot`.
  `framesPerSecond` is the one knob, two by default.
- **`ffmpeg` on the host does both jobs**, found on `PATH`, driven with the recording on stdin and
  images off stdout — **no temporary file is ever written**, which is also why no path exists that
  could leak into an answer. A host without it refuses by name
  (`recording-normalisation-unavailable`, or `frame-extraction-unavailable` for a host that could
  normalise but not slice) rather than answering with an empty frame list, which would read as a
  screen on which nothing happened. Four distinct decoder failures have four names; **no path
  answers with an empty list**.
- **`rover record` answers with both or neither.** On a host with no `ffmpeg` it exits 1 and writes
  no video either.
- **Every bound is a named refusal, never a shorter answer.** Duration is capped at fifteen
  seconds, and frame count, width and total size are all bounded — because a frame list missing its
  middle reads as a recording in which nothing happened between two moments that are no longer next
  to each other.

**The session pair.** `start_recording` returns while the recorder is still running, so input verbs
and `read_screen` work under the same lease and land in the recording; `stop_recording` signals,
waits on a condition, pulls, and answers with **exactly what `record_video` answers with** — same
schema, same normalisation, same frames. They declare **`canControlRecording`**, deliberately not
`canRecordVideo`: a platform whose recorder is one command taking a duration gives a perfectly good
`record_video` and cannot hold a recording open, and that is a narrower backend rather than a
broken one. One recording per device — a second start, or a `record_video` during an open session,
is `recording-already-running` naming the processes that were there. Nothing on the host remembers
that a recording is open (D6): whether one is is a question for the device, asked when it matters.
A caller that walks away is the **lease teardown's** problem (§3), with the recorder's own
fifteen-second kill switch covering only the case a teardown cannot — a host that died with the
lease.

**Where it lives.** `src/verbs/record.ts`, `recording-session.ts`, `recording-container.ts`,
`recording-normalisation.ts`, `src/daemon/frames.ts`, `normalise.ts`.

---

## 10. File transfer, and the install that runs the project's own build

**The hook.** Push a file to the device, pull one back, install a package — with every path in the
API belonging unambiguously to one machine.

**What it is.** `install_app`, `push_file` and `pull_file` exist because the agent is somewhere
else, the device is here, and the host is in between. So a package or a pushed file arrives **as
bytes from the caller's machine**, and a pulled file goes back **as bytes**; the host writes inbound
bytes to a file of its own and deletes it in a `finally`, including when the transfer failed —
which is the case that would otherwise leave somebody's package on a machine that lends the same
hardware to the next agent. **No host path reaches the agent, in an answer or in a failure.**

- **`push_file` names the file to write, never a directory to put it in.** The platforms' own
  transfer tools copy into such a path under a basename the *host* chose, report success, and print
  nothing that names where the bytes went. A trailing slash is caught at the boundary; an existing
  directory is caught by asking the device before any bytes move.
- **`pull_file` refuses a directory for a second reason: the size bound would not hold.** Asking a
  device how big a directory is answers for the inode — 4096 bytes, whatever the tree holds
  (measured, `PROJECT.md` §6) — so a pull of `/sdcard/DCIM/Camera` would clear the bound and put
  every recording on the host's disk, in the one process holding every lease on the machine. A
  character device reports zero and then reads forever. Both are refused on what the device says
  the path **is**, not on what it says the path weighs.
- **One call carries one whole file, capped at `MAX_TRANSFER_BYTES` (4 MiB**, derived from the
  8 MiB frame cap with base64 inflation accounted for). Say the uncomfortable part plainly: **a
  real APK is routinely tens of megabytes**, so the byte-carrying `install_app` works for a small
  package and refuses a large one by name. Chunked transfer is its own issue and will land
  *underneath* these verbs rather than change what they promise. The outbound cap
  (`MAX_ARTIFACT_BYTES`) is handed **down** to the backend, so a pull refuses before copying
  anything onto the host.
- **The CLI refuses before connecting.** A missing source, one it cannot read, one that is not a
  regular file, or one over the cap exits 2 with usage, naming the file, its real size and the
  limit — and the size comes off `stat` rather than off a buffer, so an oversized file is never
  loaded. **Kind is checked before size**, because `<(gzip -c big.bin)` hands a command a pipe
  without the caller thinking of it as one, and a pipe's size says nothing about what it would
  send. The consequence worth stating: when a source is refused, **the host is not asked at all**,
  so nothing partial can have been sent.

**`install_app` has a second shape, and it is the one that matters day to day: send no bytes.**
The host then runs the `install` command declared in the hook file of *the project this lease was
taken with* — a Gradle build, a deploy script, whatever the project already has — with
`ROVER_DEVICE_SERIAL` set to the leased device, so what it builds lands where the lease says and
never on a neighbour's. It is a verb the caller asks for, never something that happens at grant
time, and it is bounded at **five minutes**: generous for a real build, a quarter of the lease TTL
so the lease cannot expire under it, and well past a client's 30 s default request timeout — which
a caller asking for one has to raise (`rover install` raises its own). Three named answers rather
than `internal_error`: `project-not-registered`, `install-hook-undeclared`, and
`install-hook-failed` carrying the exit code, the signal and the tail of stderr.

**Where it lives.** `src/verbs/files.ts`, `src/daemon/project-install.ts`,
`src/cli/_shared/upload.ts`; `PROJECT.md` D13, R24.

---

## 11. The MCP server — and the twelve methods that deliberately have no tool

**The hook.** One `rover init` and an agent has twenty-five tools; a screenshot comes back **inline**
as an image the model looks at directly, and a recording comes back as frames plus an mp4 on the
agent's own machine.

**What it is.** One process per agent session, MCP over stdio, declaring **25 tools** under the
`IPC_METHODS` names exactly: the four device and lease rows, the eighteen verbs whose answer is
plain data, and the three whose answer is bytes.

- **Tool names are `snake_case`, arguments are `camelCase`** (D26) — `launch_app` takes `leaseId`
  and `appId`. The input schema each tool advertises *is* the object the host parses the request
  with, so what the schema spells is what a refusal names. A call that gets it wrong is refused
  loudly, naming both the missing camelCase key and the unrecognised snake_case one.
- **`screenshot` answers inline** — an MCP `image` block — and writes nothing, because an inline
  image is the one form of artifact that needs no path. **`record_video` and `stop_recording` write
  the mp4 to the agent's own machine** (`ROVER_MCP_ARTIFACT_DIR`) and report the absolute local
  path, because an mp4 is not something a model can read; their frames come back inline. None of
  the three takes a destination or a format, for the same reason none takes a host.
- **Which host an agent talks to is the `env` block's business and never a tool argument** (D17).
  An agent cannot see or change the machine that answered.
- **The launcher is `bin/rover-mcp.mjs`, named by absolute path.** `node --import tsx/esm .../src/mcp/index.ts`
  looks equivalent and is not: `tsx/esm` is a bare specifier resolved against the **client's**
  working directory, so that form starts only inside the checkout and dies everywhere else before a
  single frame. `npm run mcp` is equally wrong — its two-line banner lands in the protocol stream.
  `tests/unit/mcp/entry.test.ts` spawns the launcher from a temp directory with no `node_modules`
  above it, because that failure is a resolution question no assertion on a string can see.
- **Mis-wiring fails at startup, on stderr, before one tool is advertised** — a partial remote
  configuration and a missing `ROVER_PROJECT_FILE` both exit 1 with the reason.

**The method table holds 41 rows and 25 of them are tools. The other sixteen have no tool
deliberately**, each recorded as a decision in `tests/unit/mcp/verb-declarations.test.ts` so no row
can quietly land without one. Four reasons cover all sixteen:

- **Authority over the shared pool is the operator's, not an agent's.** `force_release_device` (an
  agent must not end another agent's lease), `set_kept_tests` (what the operator keeps is not an
  agent's to decide — an agent that could untick a test would be clearing the exemption on somebody
  else's run), `sweep_archive` (it deletes an operator's data, permanently, with no undo), and
  `delete_project`, `delete_archived_test` and `delete_archived_group` in the same key — `test_name`
  is deliberately not unique, so those runs are what *other* agents' leases wrote.
- **Reading the host's archive would hand one agent every other agent's runs.** `list_archive`,
  `search_archive`, `list_archive_groups`, `list_kept_tests`, `list_projects`, `measure_archive`
  and `measure_archive_groups`. An agent already receives its own artifacts as bytes and already
  knows its own project, test name, group and labels, having chosen them — so there is nothing
  there it needs and could not already have. These live on the panel's surface, which is the
  operator's own browser.
- **The two host-tooling rows are about somebody's laptop, not about a device.**
  `list_host_tooling` answers what the host machine has installed, **in paths on that machine** —
  the one answer on this surface that carries host paths on purpose, which is exactly what D19
  keeps away from an agent — and `install_host_tool` downloads and unpacks a program there, which
  is an operator's decision with an actor attached. An agent that meets an unbacked capability
  already gets what it needs: a `missing-capability` failure naming the program, the device and the
  backend, which is a sentence to relay to a person rather than an install to attempt.
- **Two rows wait on capability rather than on policy.** `push_file` and `pull_file` have no form
  that carries no bytes, and a whole file as a tool argument means an agent producing several
  megabytes of base64 (R24 phase 2).

**Where it lives.** `src/mcp/`, `bin/rover-mcp.mjs`; `PROJECT.md` D26, D27, D28, D33, R24, R36,
R38, R39, R41, R49.

---

## 12. Project hooks, slots and ports

**The hook.** Rover knows nothing about your application; one small file per project tells the host
what to install, what to run beside a lease, and what to tear down — and every lease gets its own
port block, so several agents can run helper services at once.

**What it is** (D13). One `<project>.json` under `ROVER_PROJECTS_PATH` (`~/.rover/projects` by
default), on the **host**. Five fields and only five: `project` (required, and it **must equal the
file's own name** — a mismatch is refused out loud when the lease ends, so a file copied from
another project cannot quietly serve this one), `apps`, `install`, `services`, `teardown`. Every
hook is `command` + `args` — **never a shell line**, because nothing here is word-split or
glob-expanded; an operator who wants a shell makes the shell the program. `cwd` and `env` are
optional, and so is every hook: a default here would be Rover naming somebody's application. There
is deliberately **no port field**.

- **Helper services are the one hook the host runs without being asked**, at both ends of a lease.
  A grant starts them in declaration order, after the device is re-verified and the previous
  lessee's state is restored, and **before the grant is answered** — so a caller holding a lease has
  the services that lease implies. One that will not start **refuses the grant, naming it**
  (`service-failed`, with the program's stderr on the end), stops whatever had already come up, and
  frees the device: granting a device whose services are down would be a success that fails at the
  first thing the agent tries. All of a project's starts share **twenty seconds**, which sits under
  the 30 s a client waits, because `acquire_device` is the one call no client raises its timeout
  for.
- **Each stop runs with its own lease's slot, and that is a contract you have to keep.** Two
  devices can be leased for the same project at once; both grants run the same `start` and both
  ends run the same `stop`. A pair that ignores `ROVER_SLOT` and addresses one shared instance
  brings up one database that both leases use, and then the *first* lease to end takes it away from
  the other, mid-lease, with no refusal left to tell it. **Rover cannot check this for you** — a
  hook is an opaque command.
- **Every lease is granted a slot and a private port block.** `ROVER_SLOT` (0-based index),
  `ROVER_PORT_BASE`, `ROVER_PORT_COUNT` — 8 consecutive ports per slot from 26000, 64 slots,
  26000–26511: one contiguous range an operator can firewall in a line. Read `ROVER_PORT_COUNT`
  rather than assuming the size. There is **no environment variable to move the range**: these are
  values the daemon sets for a child, not configuration. Two promises and one non-promise: **no two
  live leases are ever told the same numbers** (the slot is taken in the same indivisible step that
  makes the lease exclusive); **a slot comes back after that lease's teardown has run**, so numbers
  a hook is still shutting down are never handed on, and an agent that died leaks no ports; and
  **Rover reserves the numbers, never binds or probes them** — a hook that hard-codes 3000 is on its
  own. Every slot in use is a named refusal (`no-slot`) rather than a lease with no ports.
- **Nothing is cached.** Every lease that ends re-reads the file, so an edit needs no restart, and a
  file that will not parse is a warning naming the file rather than a project silently treated as
  having no hooks.
- **The trust model, stated rather than inferred.** Whoever can write into `ROVER_PROJECTS_PATH` can
  run programs as the daemon's user. A lease's `project` string **authorizes nothing** (D20) — it
  attributes, and here it also *selects*: any caller that can take a lease at all can name any
  project registered on this host and cause its teardown, services and install to run. That is the
  same trust already extended to everyone in the user store, but the natural mistake is a teardown
  written as though it only ever follows a lease that project's own team took. Per-user project
  authorization is deliberately out of scope: D20 is that the two never mix.
- **The one thing a client may do with a hook file is read the `project` out of it.**
  `ROVER_PROJECT_FILE` points at one — the project's own copy in its repository will do — and
  `acquire` stops needing `--project` (D22). One field, nothing else; a client never runs anything
  a file declares.

**Where it lives.** `src/daemon/project-hooks.ts`, `project-services.ts`, `project-install.ts`,
`slots.ts`, `hook-command.ts`; `PROJECT.md` D13, D20, D22, R18.

---

## 13. Retention — the archive prunes itself, and `keep` is what survives it

**The hook.** A host that records video all day stays inside its disk budget with nobody typing
anything, and the runs you marked *keep* are never taken.

**What it is.** Two bounds, **whichever is reached first**: `ROVER_ARTIFACTS_BUDGET_MB` (default
`1024`) and `ROVER_ARTIFACTS_MAX_AGE_DAYS` (default `30`). Both are the *host's* settings, read from
its own environment — no command sends either and no answer carries either.

- **The unit of deletion is one run, taken whole, oldest first.** Never a file and never part of a
  run: a half-deleted run is one whose sidecars no longer describe what is beside them. Oldest is by
  the run directory's own name (UTC-timestamp-led). A test name or project left holding nothing is
  removed; the root never is.
- **A test's age is the age of its newest run.** A test with a run from yesterday is not thirty days
  old however much else it holds, and a test that *is* old goes whole rather than losing its oldest
  runs — the two most recent runs under one test name are the before/after pair the tree is shaped
  for.
- **It runs on its own** (D37, D38): the **budget** after every lease ends, released or expired
  alike, behind the release rather than inside it so a release is never slowed or failed by one; and
  **both** bounds at local midnight **and at daemon start** — the start pass being what covers a Mac
  that was asleep or shut down at midnight. The pass compares the clock against when it last ran
  rather than trusting the timer. Nothing is persisted and no cron entry is needed. **What that
  costs you is up to a day of over-run**, and `rover sweep` is how you ask sooner.
- **`rover sweep --dry-run --actor <who>` asks what would go and deletes nothing.** `--dry-run` is
  deliberately not the default — a command you typed does what it says. `--actor` is required on
  both forms and derived from nothing. There is no undo, no trash directory and no confirmation
  prompt.
- **Two exemptions, and they are absolute**: a test marked `Keep`, and a run whose lease is live.
  Neither is ever taken, not even to bring the archive under budget. An archive over budget with
  only those left is *reported as such* and nothing is deleted — that one is the operator's to
  resolve. **A kept-tests store the host cannot parse abandons the sweep and deletes nothing at
  all** (R48).

**`Keep` is per `<project>/<test_name>`** — the two leading components an `archive` listing names —
and lives in `~/.rover/kept-tests.json`, **outside the archive** (D33), because everything the
archive writes is written once and never rewritten while this toggles. Read on every call, cached
nowhere, so a restart changes nothing and an operator editing it by hand is obeyed next call. Reachable
from `rover keep list|add|remove` and from the panel; `set_kept_tests` takes however many tests one
press stood for, so a group's tick is one request.

**Three explicit deletions, three different addresses** — and none of them is a retention bound, so
a kept test is taken with the rest of what was asked for:

| Command | Address | What goes |
| --- | --- | --- |
| `rover delete-project <p>` | one project | its hook file, its archive subtree, its kept-test entries (D42) |
| `rover delete-test <p> <t>` | the `<project>/<test_name>` pair | that test's runs and its kept entry; the project level too if that was its last test (D43) |
| `rover delete-group <p> <g>` | a project plus a **group id** | only the runs whose group id matches — a test's runs in another group or in none stay (D43) |

All three require `--actor`, all three refuse rather than delete around a **live lease**, and
`delete-group` is a bounded walk rather than a single removal, so it answers **how many runs went**
and says `partial` when it was cut short instead of claiming the group is gone.

**Where it lives.** `src/daemon/archive-retention.ts`, `archive-sweep.ts`, `archive-size.ts`,
`retention-schedule.ts`, `kept-tests.ts`, `delete-project.ts`, `delete-archived-test.ts`,
`delete-archived-group.ts`; `PROJECT.md` D33, D35, D37, D38, D42, D43, R48, R49.

---

## 14. Before-and-after comparisons

**The hook.** Name the investigation on the lease and label the captures, and the run before your
change and the run after it are filed side by side — with the panel arranging them into two panes
and, on request, boxing where the second one differs.

**What it is**, in three layers.

**The filing.** `--group-id` ties runs, `--label` ties artifacts. You send a *name* and the host
mints the id, printing it on the grant (`Group: app-bar-top-space.h57ssn4`); the second acquire
passes that printed id back. Three arms are as normal as two, and nothing requires a second run
ever happens. **A `--label` requires a `--group-id`** — sent without one, the call is refused by
name, never accepted with the label quietly dropped, because a label with nothing to be compared
against would be a string you supplied and nobody recorded.

**The arrangement.** `list_archive_groups` answers which runs share a group and which of their
artifacts share a label, as addresses in the same path vocabulary, from a bounded walk with no
index behind it (R41). The panel's **Testing groups** view draws it: project → group id → test name
→ run → contents. A run that named no group is not drawn, and neither is a project with none —
this view answers *what groups exist*, and the `All` view still lists every run, so nothing becomes
unreachable. Labelled artifacts carry a small **numbered pill**: inside one group each distinct
label takes the next number from `1`, the same label is the same number everywhere in that group,
there is no ceiling and no overflow value, the number carries the meaning (never the colour alone,
so the label is a tooltip and reaches a screen reader), and no number is a rank.

**The comparison card** (#199, `docs/DESIGN.md` §9). Drawn when the selection is a labelled
artifact in the groups view with **two or more artifacts under that label in the same
`(project, groupId)`**; everything else stays the single preview. One pane per labelled artifact,
**oldest on the left** — the one deliberate exception to *most recent first* on that screen, so a
before/after reads chronologically. Nothing enforces arity, so three arms are three panes.

**The difference marks** (2026-09-10, `docs/DESIGN.md` §9) — the one feature that has had to sit
exactly on the verdict line, and the reversal is argued out in place rather than deleted:

- **Off until asked for.** A `Differences` lamp in the header strip, `secondary` and not `tertiary`
  precisely because green means *kept* and *you are here* everywhere else in the panel, and a green
  lamp over an artifact would read as a judgement about it.
- **On exactly two panes.** A difference is pairwise; with three arms there is no pair to take
  without naming one of them the reference — which is the `BASELINE` this card refuses to have. A
  group of seven gets no control at all, and the absence is the honest answer.
- **Marks go on the second pane, never the first**, because the first is what the second is read
  against, and *oldest on the left* is what makes the second one the later one rather than the
  chosen one.
- **An overlay, never a drawing.** The `<img>` is the same element on the same bytes the host
  filed; the boxes are DOM on top, one `<svg>` in the artifact's own pixel coordinates, so they
  survive `object-contain`, a 240px pane, a 700px one, a resize and a zoom with no measurement at
  all. Compositing into a canvas would make the panel show an image no file in the archive
  contains, on the one screen whose rule is *what you are looking at is the file*.
- **Rows are aligned before pixels are compared, and that is the whole design decision.** Measured
  against a real pair in the archive (1280×2856, one emulator): a plain per-pixel threshold marks
  **38 regions over 38% of the screen** on a pair whose real difference is a clock and a scroll
  offset, because everything below an insertion shifts down. Aligning rows first gives **4 regions
  over 18%**, and they are the right four. Differing pixels are counted per 16px tile rather than
  per pixel, because antialiased text differs along every glyph edge and a per-pixel mask marks the
  typography rather than the change.
- **Four sentences for four ways there is nothing to compare** — different screens (D14: both
  measurements are correct and scaling one onto the other would invent an answer), no pixels (a
  labelled recording or log), no difference, and the count itself: **`4 regions differ`, never
  `96% identical`**, which is the sentence a threshold would be hiding in. An empty overlay must
  never stand in for any of them, because it reads as *these are the same*.
- **The system bars are set aside where the device said where they are.** `device_info` carries
  `screen.systemBars` — the insets in physical pixels, or `null` for a device that did not say, and
  **`null` (not answered) and four zeros (no bars) must not fold together**: the first leaves a
  consumer with nothing to set aside, the second says there is nothing to set aside. It is what
  decides whether the status bar's clock is marked as a difference on every single pair.

**Rover files all of this and stops there.** It does not score the two images, rank the regions or
decide whether the fix worked.

**Where it lives.** `panel/src/archive/label-comparison.ts`, `image-diff.ts`,
`marked-differences.ts`, `panel/src/components/archive/comparison-card.tsx`,
`difference-toggle.tsx`, `src/daemon/list-archive-groups.ts`, `src/core/device.ts`;
`docs/DESIGN.md` §9, `PROJECT.md` D14, D22, R41.

---

## 15. The web panel

**The hook.** A browser view of the host: live device cards with a lease countdown that ticks down
and goes back up when the holder renews, one control to force-release a stuck lease, and a file
explorer over every run the host ever filed.

**What it is.** `panel/` is a Vite + React application sharing the repository's single
`package.json`. **One process is the whole machine**: `ROVER_HTTP_PORT=4712 rover server` serves the
panel *and* its data from one origin, so <http://127.0.0.1:4712> is the address and there is nothing
else to start. This paragraph read *`rover panel` serves it on :5174 … so both halves run for now*,
and it is rewritten in place with its reasoning rather than deleted (`ai/RULES.md` §1): the second
process existed only because the host did not serve `panel/dist`, and that gap is closed (R52).
`rover panel` is now a line printing that URL and what has to be up; `npm run panel:dev` is
unchanged and is the development server, for working on the panel itself.

**The panel is built, not shipped.** `npm run panel:build` writes `panel/dist` once, in the Rover
checkout, and the host serves whatever is there — re-read per request, so building while a host is
running takes effect on the next reload. A host with no build answers **one plain sentence naming
`npm run panel:build`**, never a silent `404` and never a blank page: a page that is up and empty is
the silent degradation this project forbids everywhere else, and the host cannot run `vite` on the
operator's behalf because a copy installed with `--omit=dev` has none.

**The transport** (D29). A browser cannot speak the framed NDJSON greeting the TCP listener
consumes, so the panel reaches the host through a third transport of the *same* surface:
`POST /rpc` carrying the same envelopes, plus three additions of its own — the `/session` verbs,
`GET /artifact/<component>/…`, which answers bytes, and the panel's own files on everything left.
It is **off unless `ROVER_HTTP_PORT` is set**,
defaults to loopback, and `rover list` clears the switch in anything it autostarts.

- **Only the panel's methods are reachable** — an allowlist over the one table — so a browser tab
  cannot take a lease and then drive a phone with it. One request is one envelope.
- **Two statuses wherever an envelope is the answer**: `200` (read the envelope; its `error.code` is
  the vocabulary every Rover client already reads) and `401`, byte-identical for a missing
  credential, a malformed one, an unknown token, a revoked user, an unreadable store, an unknown
  path and the wrong method alike — authentication happens before routing on every path that
  answers host data, and a refusal that varied would tell a stranger something. The token goes in the header and never in the URL (D20);
  nothing about one of these requests or refusals is logged — the only interesting thing to log
  about an attempt is the token that was tried. (**Scoped to the envelope surface, and it has to
  be**: the static route below reads the filesystem, so a file it will not serve — a symlink out of
  the bundle, a directory, a stray FIFO — does put one line on the host's log. That is the
  operator's diagnosis of their own tree and it is bounded to one line per distinct problem per
  daemon, so an unauthenticated peer cannot replay it into a full disk.)
- **The store is read on every request**, keep-alive connections and artifact fetches included.
- **The bundle is the one route in front of the gate, and it is the same exception `POST /session`
  already is** (R52). The login screen *is* the bundle, so a gate in front of `GET /` would refuse
  the only page that can obtain a credential. It widens nothing: `/rpc`, `/session` and
  `/artifact/…` keep the per-request gate exactly as it was, and every pre-auth failure on them is
  still the one byte-identical `401`. **Route precedence is stated in code, not left to ordering** —
  the three host routes match by their whole address first and the bundle is only ever what is
  left, so a wrong verb on a gated path is a refusal and never a page. Path containment is the
  artifact route's own, pointed at a second root: no `..`, no symlink escape, no directory listing.
  **It is bounded in the three ways a pre-auth route has to be**: `GET` and `HEAD` only, so no body
  is read from a peer this host has not identified; reads only inside `panel/dist`; and it says at
  most one thing per distinct problem per daemon on the log, so the diagnosis survives and a peer
  looping a request cannot fill a disk with it. `HEAD` is taken here and nowhere else, because a
  launchd agent's liveness probe is a `HEAD /` and an operator who writes the obvious one should
  not get a `401`. The cost, stated rather than hidden: a stranger who reaches the port can tell
  this is a Rover host, and **off loopback the bundle is readable by anyone who can reach it** —
  acceptable because it carries no credential and no host data, which is a property that has to
  stay true.
- **The artifact route** takes listing components, never a host path. Content type comes from the
  extension with `nosniff` on every response; nothing escapes the archive root (a traversal is
  `400 invalid_path`, a symlink resolving outside is `500 unreadable`, neither carrying a path); a
  missing file and an unreadable one are told apart (`404` vs `500`) and neither is ever a `200`
  with no bytes; one `bytes=` range is answered with `206`, which is what makes a `<video>` play in
  Safari at all. **The address is not openable in a bare tab** — a top-level navigation sends no
  header — so *Open in a new window* fetches with the session header and opens the object URL.
- **A browser holds a session, not the token** (D30). `POST /session` exchanges it once;
  `GET /session` is the probe a reload restores from; `DELETE /session` ends it **on the host**.
  Sessions live in memory: restarting the daemon signs everyone out, there is no session file to
  leak or prune, and eight hours idle expires one. A session is bound to the user's identifier *and*
  to their token hash, re-checked every request, so `users revoke` or `users rotate` signs a live
  browser out on its next request. No cookie is set or read, so there is no CSRF surface and no CORS
  header for one to ride in on. Off loopback, TLS becomes required and the daemon refuses to start
  without it.

**The four destinations:**

- **Devices** (default). Polls `list_devices`; a card per attached device — model, serial, platform,
  OS version, and either *free* or the lease holding it with owner, project, test name, the grant
  instant, and a countdown that **goes back up** when activity renews the lease. Held cards first,
  then free, then the ones no lease can be taken on: a device the host reports `unauthorized` or
  `offline` is neither held nor free and is counted apart, because the daemon would refuse a lease
  on it and calling it free would be a claim the host will not honour. Four states are distinguished
  on purpose, and the last two are the reason: nothing attached; a stale view over a list; a stale
  view over an *empty* list, which means Rover cannot say what is attached rather than that nothing
  is; and the host being unreachable, which replaces the page.
- **Projects.** One `list_projects` on navigation — no polling — and a card per project: identifier,
  the apps it names, its helper services by name, whether there is an `install` and a `teardown`. No
  `env` value and no host path is on the answer. Nothing here edits a hook file; the one write is
  `delete_project`.
- **Archive.** A file explorer: a tree that expands one directory at a time and reaches every
  address, beside the contents of whatever is selected. Opening a node closes nothing else; branches
  accumulate; a second click on the same row collapses it. **The address is in the URL** — a reload
  and a shared link land where you were, with the branch the address names open and nobody else's
  browsing. Each level is one `list_archive` call **for a level actually on screen**. **While a
  lease is live anywhere on the host, every level on screen re-reads itself every five seconds**, so
  a run that lands appears where it belongs without a reload and without losing your place; while
  no lease is, nothing is asked at all. **One field searches the whole archive** — one
  `search_archive` call once the text settles, never one per keystroke, every match drawn in the
  tree in place with its ancestors expanded and branches holding no match not drawn; the answer is
  bounded, because there is no index behind it, and an answer that had to stop early says so
  **including when it found nothing at all**. A run shows its directory name in full, the owner and
  grant time read out of that name, the serial, everything the lease wrote with a size or file
  count, and the device it ran on read out of `device_info.json` — a fact the file does not carry
  says `unknown`, and none of it is guessed. **Two views**, `All` and `Testing groups` (§14), each
  with addresses of its own (`/archive…`, `/groups…`). **Nothing is added**: no duration, no
  trigger, no verdict, no file that was not in the listing.
- **System.** The two retention bounds, drawn from the host's own settings, with the archive's
  measured size beside them. **Nothing is stored and no `Save` is drawn**, because no method writes
  either number — a control that appeared to write would be worse than the plain sentence saying
  where the numbers stand. `Profile` carries who you are signed in as and the one `Sign out`
  control.

**Three writes, admitted one at a time on D27's test** — named, bounded, and stated before they
fire: `force_release_device`, `set_kept_tests` and `delete_project`. Each asks first, in a dialog
that names exactly what it will affect and says in plain words what confirming does; `Cancel` is the
prominent control and the destructive one recessive, on purpose — the safe exit is the easier
target. What the host answered is then said above the grid, and the answers read differently because
they mean different things. **A confirmed action that reached nothing announces nothing**: the
dialog stays open and the control comes back. Every write is attributed to the signed-in user's
identifier, so the host's audit line names a person and not a browser.

**Rules that hold everywhere in the panel.** The preview region is clean — no scanline, tint,
gradient, bezel, phone frame, glow or watermark; a hairline border is the most that is permitted,
and the difference marks (§14) are the single argued exception. An image is contained at its natural
aspect ratio and never scaled up past its own pixels; a recording is a plain `<video controls>` with
no autoplay and no loop; a log is monospace with a line-number gutter and **no colour on the level**,
because `W` and `E` are the device's words about its own logs, not Rover's verdict. There is **no
download button anywhere** — this is a view, not a transfer. The design system is Analog Horizon;
`panel/src/tokens.css` is the only file allowed to write a colour value, and `tests/unit/panel/`
holds the gates that keep it that way.

**Where it lives.** `panel/`, `src/daemon/http-listen.ts`, `panel-bundle.ts`, `contained-file.ts`,
`panel-session.ts`, `archive-file.ts`, `list-archive.ts`, `search-archive.ts`, `list-projects.ts`,
`measure-archive-groups.ts`, `src/cli/commands/panel.ts`; `docs/DESIGN.md` (the screens),
`docs/WEB_PANEL.md` (the running list), `PROJECT.md` D27, D29, D30, D40, R52.

---

## 16. Setup, and the two commands that make a machine ready

**The hook.** Clone, `npm install`, `npm link`, then `rover init --write` inside the project you are
working on — and there is nothing to start by hand afterwards.

**What it is.**

- **`rover init`** is the odd command among them: it asks no host, needs no device, and is meant to
  run from **outside** this checkout. It writes four things — the project's hook file under
  `~/.rover/projects/`, detected from a Gradle wrapper where there is one; the `rover` MCP server
  merged into the project's `.mcp.json` with both absolute paths filled in; `ROVER.md`, the page an
  agent reads before its first call (generated — re-run `init` rather than editing it); and a short
  block in `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` saying that a manual test means Rover (`--write`
  inserts it, without the flag it is printed).
- **`rover doctor`** reports the programs the host needs and where it found them. **`rover doctor
  --fix --actor <who>`** downloads a pinned `idb_companion` release **on the host**, checks it
  against the published checksum and unpacks it under that host's `~/.rover`, where the search looks
  last — so there is no `PATH` to arrange and no variable to export. Run it twice and the second run
  downloads nothing. It is macOS-only, because simulators are.
- **`adb` and `idb_companion` are found without a `PATH`.** An Android SDK in the standard place is
  found; `ROVER_ADB_PATH` / `ROVER_IDB_COMPANION_PATH` name an executable anywhere else and win over
  anything Rover installed. **Rover changes nothing about your `PATH` or your shell configuration** —
  what is on this machine's `PATH` is the operator's, the same way the devices are.
- **Rover lends what is already attached.** It never starts an emulator and never connects a phone
  itself (D21), and never takes a device reached over `adb connect` into its inventory (D18).
- **`npm install` also installs the git hooks** and warns when it can find no `adb`.

**The CLI surface**: `status`, `list`, `doctor`, `acquire`, `release`, `force-release`, `screenshot`,
`record`, `pull`, `push`, `install`, `archive`, `keep`, `sweep`, `delete-project`, `delete-test`,
`delete-group`, `users`, `server`, `panel`, `init`. Human-readable by default; `--json` gives one
document on stdout with every diagnostic on stderr. It holds **no verb logic** — each command parses
flags, calls one IPC method, renders the answer, picks an exit code. `--host` names the host: absent
is local, `remote` is what the four environment variables name, anything else fails loudly instead of
hanging.

**Exit codes.** `0` success; `1` the operation did not succeed (a refused acquire, a release that
found no live lease, an archive level that is not there or cannot be read, an unreachable host, a
request the host rejected…); `2` usage error (unknown command or flag, a missing
`--owner`/`--project`/`--actor`, an attribution string past 256 characters, a `--host` that is
neither, or `remote` with nothing in the environment naming one). **A `release` that found nothing
exits `1` on purpose** — the host cannot tell "no such id" from "already gone", and exiting `0`
would let a mistyped lease id read as success.

**Bytes in and out, from the client's side.** `--out` is a path on **your** machine and is required
— there is no filename the CLI could invent that its caller could predict. What decoded is checked
against the byte length the host encoded **before anything is written**, so a refused or damaged
transfer exits 1 and leaves **no file at all** rather than a short one. `rover record --duration-ms`
raises its own request timeout past the recording, so a long recording is never a hang.

**Where it lives.** `src/cli/`, `src/cli/init/`, `src/daemon/tooling-handlers.ts`;
`PROJECT.md` D4, D19, D21, §9.4.

---

## 17. The host runs from login, so nobody races it for the socket

**The hook.** One command installs this machine's host as a launchd agent, so the panel is on
`http://127.0.0.1:4712` from the moment you log in — no terminal window holding it, and no client
able to get to the socket first and leave a host no browser can reach.

**What it is.** `bin/rover-server-agent`, six subcommands, each taking an optional `<checkout>` that
defaults to the current directory:

| | |
| --- | --- |
| `install` | write the LaunchAgent and start it, waiting for the panel to answer |
| `uninstall` | stop it gracefully and remove the agent (the logs stay) |
| `status` | is it loaded, whose host is on the socket, is the panel answering |
| `restart` | stop it gracefully and start it again |
| `reload` | `npm run reload` in the foreground, then restart — stops on a failed build |
| `logs` | tail this host's stdout and stderr |

**The convenience is the smaller half, and the correctness the larger one.** Every client call —
including an MCP server an agent spawns — starts a daemon when none is running, and deliberately
clears `ROVER_LISTEN_PORT` and `ROVER_HTTP_PORT` in it, because a host that began listening for
other machines or for browsers as a side effect of `rover list` would be exposure nobody chose
(D40). That daemon takes the socket, and a `rover server` typed afterwards finds it there and exits
1 — a host that is up, holding devices, and reachable by nobody. **A host that starts at login is
always first**, so that race does not arise; and when it does arise anyway — somebody stopped the
host by hand and then ran a command — `status` is what names it, because telling a portless daemon
apart from this agent's own host is the failure this tool exists around.

**Four things about it are Rover's own rather than launchd boilerplate.**

- **The plist carries the ports**, because launchd reads no rc file and those two variables are
  exactly what an autostarted daemon drops. It carries a **fixed allowlist of seven**:
  `ROVER_HTTP_PORT` (default `4712`), `ROVER_HTTP_ADDRESS`, `ROVER_LISTEN_PORT`,
  `ROVER_LISTEN_ADDRESS`, `ROVER_TLS_CERT`, `ROVER_TLS_KEY`, `ROVER_SOCKET_PATH` — read from the
  shell that runs `install`. **Nothing secret may be written into a plist, and there is no field
  where one could be**: no `--env`, no environment pass-through, no file read into the dict. That is
  safe because the host holds no secret at all (D25) — its credentials are hashes in
  `~/.rover/users.json` — and `ROVER_HOST_TOKEN`, the one variable that *is* a secret, is a
  **client's** and is not on the list.
- **`PATH` resolves `adb` and `idb_companion`, not just `node`.** The daemon spawns both by name, so
  a host with only `node` on its `PATH` starts cleanly and fails every verb. `install` asks this
  checkout's own search (`scripts/device-tool-dirs.mjs`, #171) rather than `command -v`, because the
  installing shell usually cannot find `adb` either. For `adb` this is belt-and-braces — the SDK
  locations already find it; for a hand-installed `idb_companion` it is the only thing that does.
- **`install` refuses while any host holds the socket, and names the pid.** Under `KeepAlive`,
  losing that race is an infinite thirty-second crash loop rather than a message. The check is the
  one `rover server` already makes (`src/daemon/host-on-socket.ts`), never a second one — and never
  `rover status`, which autostarts a daemon and would cause the very damage the guard prevents.
- **Readiness is `GET /` on `ROVER_HTTP_PORT`, everywhere.** One request proves the process is up,
  kept its port, and is serving the panel. It is pre-auth by design (D29), so no credential is
  involved in a liveness check.

**`reload` is one definition, not two.** `npm run reload` is `npm install && npm run panel:build` in
`package.json`, and the script runs it in the **foreground** and restarts nothing if it fails — so a
`vite` error lands on your terminal and the host keeps serving the build it already had.

**A graceful stop releases the leases, and that was measured** (#294). `uninstall` and `restart` stop
the host with `SIGTERM`, which `rover server` forwards to the daemon, which runs its own shutdown.
That shutdown used to sweep only *expired* leases: against `emulator-5554` on API 37, a lease that
had turned airplane mode on and a graceful stop left the device in airplane mode indefinitely. It
now ends live leases too, through the same path a caller's release takes (D9 as amended) — which
matters far more under launchd, where the host is stopped at logout, at reboot and on every
`reload`, than it did for a foreground host somebody was watching.

**macOS only**, because launchd is. Off macOS the script says so and names the equivalent: a
`systemd --user` unit running the same command.

**Where it lives.** `bin/rover-server-agent`, `scripts/host-on-socket.mjs`,
`scripts/device-tool-dirs.mjs`, `src/daemon/host-on-socket.ts`, `src/daemon/listen.ts`;
[`docs/launchd-host-autostart.md`](launchd-host-autostart.md); `PROJECT.md` D9, D18, D25, D29, D40.

---

## 18. What Rover deliberately will not tell you

**The hook.** Everything Rover cannot answer, said out loud — because silence reads as *checked*.

- **Nothing goes red on its own.** No assertion exists anywhere here. The quality of a result
  depends on the agent's attention, not on the tool.
- **The two platforms are not equally capable, and Rover says which is which.** A simulator answers
  every required call, records video, reads the screen and takes input, and refuses the network
  toggles **by name**; `press_key` answers `home` and `wake` and refuses `back` and `recents` by
  name. **Physical iPhones are not supported at all.**
- **Pixels are gone whenever an app blocks screen capture** — the system hands back a valid, all
  black image and logs nothing. The check that tells a blocked capture from a broken device is a
  screenshot of the system home screen. `read_screen` survives the block and answers in full.
- **Motion is only ever sampled.** A recording and its frames can say something moved and roughly
  when. Whether an animation eased well, dropped a frame, or would read as jank is a question
  neither answers, and reading it out of them anyway is exactly the plausible-looking wrong answer
  this design is against.
- **Measurement error is ±1–3 px**, worse on antialiased edges, and there is **one density per
  device** — a result from one emulator is not a result for every phone (D14).
- **One call carries one whole file, capped at 4 MiB**, so the byte-carrying `install_app` refuses a
  real APK by name. The way a real APK reaches a device today is `install` with **no** path (§10).
- **`push_file` and `pull_file` are not MCP tools**, so only the CLI can move a file.
- **`install_app` as a tool can outlast an MCP client's own request timeout** — the host allows five
  minutes and some clients wait less. The build keeps running on the host; the answer is lost.
  `rover install` from a terminal has no such limit.
- **Retention's worst case is a day.** A bound can be over-run until the next pass; `rover sweep` is
  how you ask sooner.
- **A device-level refusal can still reach the caller as `internal_error`** rather than as an answer
  about the device — launching a package that is not installed, or pulling a path the device does not
  have. It is true of every verb family and is filed as its own issue.
- **`install_app` is verified on hardware; its automated coverage is not.** A real 29 KB APK was
  installed end to end and confirmed from `/data/app`, but there is no APK in this repository, so in
  the suite the verb is exercised over a stub backend. Read that as the stated gap.
- **`rover` is on a `PATH` only where somebody ran `npm link`.** Nothing links it for you.

---

## 19. Configuration surface

Everything host-level comes from the environment, and **every row mirrors a Zod schema, which is the
source of truth** (`ai/RULES.md` §7): the daemon and the CLI fail at startup naming the variable and
the reason rather than binding something surprising. `docs/MANUAL.md` carries the full table with each
row's reasoning; this is the map.

| Group | Variables |
| --- | --- |
| Tooling | `ROVER_ADB_PATH`, `ROVER_IDB_COMPANION_PATH` |
| Host paths | `ROVER_SOCKET_PATH`, `ROVER_USERS_PATH`, `ROVER_ARTIFACTS_PATH`, `ROVER_KEPT_TESTS_PATH`, `ROVER_PROJECTS_PATH` |
| Retention | `ROVER_ARTIFACTS_BUDGET_MB`, `ROVER_ARTIFACTS_MAX_AGE_DAYS` |
| Network listener (opt-in) | `ROVER_LISTEN_PORT`, `ROVER_TLS_CERT`, `ROVER_TLS_KEY`, `ROVER_LISTEN_ADDRESS` |
| HTTP / panel surface (opt-in) | `ROVER_HTTP_PORT`, `ROVER_HTTP_ADDRESS` |
| Client side | `ROVER_HOST_ADDRESS`, `ROVER_HOST_PORT`, `ROVER_HOST_TOKEN`, `ROVER_HOST_CA`, `ROVER_PROJECT_FILE`, `ROVER_MCP_ARTIFACT_DIR` |
| Set *by* the daemon for a hook's child | `ROVER_PROJECT`, `ROVER_DEVICE_SERIAL`, `ROVER_SLOT`, `ROVER_PORT_BASE`, `ROVER_PORT_COUNT` |

Two properties worth carrying into any user-facing text: **the two listeners are opt-in switches**,
and **a client-autostarted daemon clears both**, so no ordinary command can turn a laptop into a
network host.

---

## 20. Using this file to write user-facing text

**The order features earn on a landing page**, judged by *what would make a reader stay*:

1. **Hands and eyes on a real device for an agent** (§0, §4) — the reason anyone is reading.
2. **Both platforms, one set of verbs** (§1).
3. **Devices shared rather than fought over** (§2, §3) — the thing no alternative does.
4. **Setup is two commands and nothing to start** (§16) — and on a Mac the host itself starts at
   login, in no terminal at all (§17).
5. **Deterministic by construction** (§5) — the reason to trust what comes back.
6. **Devices on somebody else's machine** (§7).
7. **Every run archived, before-and-after comparisons, the panel** (§8, §13, §14, §15).

**What must never be dropped, however short the text gets:** the *not a test framework* line (§0),
and the fact that a verb a device cannot perform **fails by name** (§1). Those two are the product's
character, not caveats.

**What belongs in reference documentation and not in a README:** exit codes, the full environment
table, the wire protocol, hook-file schemas, transport statuses, the MCP tool inventory, refusal
names, and every *why it is not the other way* paragraph. If a sentence begins by explaining a
rejected alternative, it belongs here or in `PROJECT.md`.

**A test for any user-facing sentence about a feature:** it should survive being read by someone who
has not yet decided to try Rover. The reasoning under it — this file — is for the reader who already
has.
