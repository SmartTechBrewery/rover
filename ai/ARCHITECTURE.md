# Architecture

What is actually built, and where the seams run. `PROJECT.md` carries the decisions and their reasoning; this document carries the shape. Where they disagree, one of them is stale — fix it rather than picking a side.

---

## Components

| Component | Instances | Lifetime | Owns |
|---|---|---|---|
| **Daemon — the device host** (`src/daemon/`) | one per machine **with devices**, reachable over the network | long-running | Device inventory, leases, port allocation, state restoration, **and executing the verbs** |
| **IPC surface** (`src/ipc/`) | library, loaded by the daemon and by every client | per connection | The wire schemas, NDJSON framing, request dispatch and response correlation — the protocol itself |
| **Core** (`src/core/`, `src/backends/`, `src/verbs/`) | library | — | The device interface, the backends, the verbs |
| **CLI** (`src/cli/`) | per invocation | seconds | Human and script entry point — a **client** of a host, local or remote |
| **MCP server** (`src/mcp/`) | one per agent | agent session | Exposes the verbs as tools — also a **client** of a host |
| **Shared client half** (`src/client/`) | library, loaded by both adapters | — | The parts of being a client that must not differ between them — today the artifact writer and its length check |

### Where the transport seam runs

`src/ipc/` is the protocol and nothing else. It binds to a Node `Duplex` and to no other
type (`PROJECT.md` D17): no socket path, no peer uid, no hostname, nothing that assumes the
client shares a filesystem, a user or a clock with the host. A transport is a **separate module
that consumes this one**, handing it an already-connected stream. That is what makes a network
listener an added transport rather than a rewrite, and it is checkable by reading the imports:
the unit tests drive the whole surface over an in-memory stream pair that is not a socket at all.

**Both transports exist now, and both halves of each.** The two listeners share one
`IpcServer` instance built in `src/daemon/listen.ts`; the two clients share one
`createIpcClient`:

| | Host side | Client side |
|---|---|---|
| Local unix socket | `src/daemon/listen.ts` — no token, no configuration | `src/daemon/connect.ts` — **and autostart lives here** (D5) |
| TCP + TLS | `src/daemon/network-listen.ts` — opt-in via `ROVER_LISTEN_PORT` | `src/daemon/network-connect.ts` — configured by `ROVER_HOST_ADDRESS` |

`src/daemon/host.ts` is where a client **chooses** between those two client halves, and it is
single because there are two clients: the CLI asks for a host with `--host` and the MCP server
takes one from its own environment, and a second copy of that function would be a second place
autostart could be reached from. Each client keeps only its own translation — `--host` and exit
codes in `src/cli/_shared/host.ts`, the environment switch in `src/mcp/_shared/host.ts`.

Each pair is handed the same `IpcServer` or wrapped by the same `createIpcClient`, so there is
one method table, one dispatcher, one set of schemas, and nothing for the four to drift from.
`src/daemon/network-config.ts` carries both halves' configuration, and the two halves are
deliberately **asymmetric** (D25): the host half holds no secret at all — it names a user store,
`~/.rover/users.json`, that `rover users` writes — while `ROVER_HOST_TOKEN` is the *client's*
own credential, the token that host printed for it once. There is no shared secret left on the
host side, because a way in that no `rover users revoke` could take away is what the store
exists to retire.

**Autostart is contained by that table rather than by discipline.** `network-connect.ts` does
not import `node:child_process` and never may — a host reachable over a network is a service
its operator runs, so a client that cannot reach one says so, naming the address, the port and
the error code (D5). `tests/unit/daemon/remote-never-spawns.test.ts` is the executable form of
that line, and `src/cli/_shared/host.ts` is the single place the two client halves are chosen
between (`--host local | remote`).

**The token gate sits in front of `handleConnection`, never inside it.** A request envelope is
`{ protocolVersion, id, method, params }` and nothing else, so authentication cannot be a field
on a request or a method in the table. It is a one-line NDJSON greeting — `{"token":"…"}` — that
`network-listen.ts` reads and consumes before the IPC server is attached to the stream. Three
things follow, and all three are wanted: no method can be dispatched before authentication *by
construction* rather than by a flag; the local socket stays ungated because the gate lives in the
other transport; and `src/ipc/` genuinely does not know it is authenticated. The gate resolves
the presented token against the user store — hashed, then looked up in `~/.rover/users.json`,
**re-read at every connection attempt and never cached for the daemon's lifetime** (D6, D25), so
a revoked user is refused on their very next attempt with nothing restarted. Every pre-auth
failure — a token no user holds, a revoked one, missing, malformed, oversize, a store this host
cannot read, or a handshake that times out — gets one byte-identical `unauthenticated` refusal
and a destroyed connection, because a refusal that varied with the reason would tell a stranger
something about the host (D20). The token authenticates and attributes nothing: a lease's owner
is a separate, caller-supplied string, never derived from whoever authenticated.

### Why the daemon exists at all

Two agents working in parallel have two separate MCP servers, which cannot see each other. Devices are a shared resource; an agent session is not. Without one process holding the inventory, an unpinned install reaches every attached device and one agent screenshots the other's build — a green verification of code you did not write, which is the worst failure this class of tool has.

### Agents borrow devices; they do not host them

Rover is the machine that owns the hardware, and agents connect **to** it from wherever they run
(`PROJECT.md` D17). The relationship to Swarm is inverted: Swarm pushes work out to workers on many
machines; Rover stands still and lends devices to whoever asks. The invariants below follow, and
all of them are load-bearing:

- **Only what is physically attached to the host is ever leased** (D18, revised 2026-08-29). `adb
  connect` can make some other machine's emulator appear in the local `adb devices`; leasing it out
  anyway hands out hardware this host does not actually control, which can vanish or belong to an
  unrelated process without warning. The host refuses it before it ever reaches a lease.
- **Verbs execute on the host** (D19). The core is still a library; the daemon is simply the
  process that loads it. A client that received a serial and ran `adb` itself would need adb
  reachable over the network — exactly the exposure D17's authenticated listener exists to gate
  instead — and would strand the project hooks and helper services on the far side of the network
  from the device they exist to serve.
- **Artifacts cross a machine boundary.** Screenshots, recordings and pulled files come back as
  bytes; a path handed to the agent must exist **on the agent's machine**. A verb that returns a
  host-local path is a bug even when it works on a local host. The client half of that contract is
  `src/client/artifact.ts` — the one place any client turns an `ActionResult.artifact` into a
  file. It decodes, checks the decoded length against the `byteLength` the host encoded (`Buffer`
  drops characters outside the base64 alphabet rather than failing, so a mangled payload otherwise
  becomes a short file that announces nothing), writes the bytes locally and answers
  `path.resolve` of the caller's own `--out`. It also owns `describeWithoutBytes`, which is how
  either client says what an answer carries without repeating megabytes of base64 alongside it.
  **The write is the last thing it does and only on the `ok` branch**, so a refusal or a failed
  transfer leaves no file at the destination rather than a truncated one. Nothing in it branches
  on which host answered: a local host and a remote one arrive as the same field of the same
  schema, which is what makes the guarantee a property of the module instead of of every command
  remembering it. It lives outside both adapters because the MCP server cannot import from
  `src/cli/`: that tree prints through `console.log`, which would corrupt its stdio frames. What
  each adapter keeps is what only it has: `--out` resolution, human rendering and exit codes on
  one side (`src/cli/_shared/`), the artifact directory and MCP content blocks on the other
  (`src/mcp/_shared/artifact.ts`). The other direction has the mirror of it,
  `src/cli/_shared/upload.ts` — the one place a client reads a local file for a host, behind
  `rover push` and `rover install`. It resolves the path against **this** process, stats it, and
  refuses a missing file, an unreadable one, one that is not a regular file and one over
  `MAX_TRANSFER_BYTES` as a usage error naming the file, its real size and the limit. **The size
  is read off `stat`, never off the buffer, and the kind is read before the size** — a named pipe
  or a character device stats as zero and then reads without end, so the cap only means something
  once the path is known to be a regular file, which is the rule `pull_file` follows on the device
  side. Every check runs before `connectToHost`: an over-sized source is refused
  without ever being loaded, and with the host not asked at all, so nothing partial can have been
  sent. That mirrors what `src/verbs/files.ts` does on the host by handing `MAX_ARTIFACT_BYTES`
  *down* to `pullFile` rather than checking on the way back.

Authentication is the host's token; attribution is the lease's owner string. They are separate
fields on purpose (D20) — collapsing them either leaks the token into reports or makes the owner
impossible to set, and Swarm needs to set it (D16).

### Why the CLI is not a thin wrapper on the MCP server

The dependency runs the other way (`PROJECT.md` D4): core → CLI, and MCP as a second adapter onto the same core. A human debugs the CLI, CI runs the CLI, and the CLI needs no MCP configuration. Building MCP-first locks the tool inside an agent and makes every bug reproducible only through one.

### Process responsibilities — who owns what

- **The daemon owns anything shared or destructive**: which device belongs to whom, which ports are taken, and putting a device back the way it was found.
- **The core owns everything about *a* device** and nothing about *which* device. It receives a serial it has been granted and does not know that leases exist — nor that a client on another machine is waiting for the result.
- **The adapters own no execution.** The CLI and the MCP server are clients: they carry a request to a host and carry a result back. There is no adb in a client process, and that is a thing to test for, not to trust.
- **The adapters own translation only.** No verb logic in `src/mcp/` or `src/cli/`. If an adapter grows a behaviour, that behaviour belongs in the core and the adapter is calling it wrong.

### Auto-start

The daemon starts on first use, the way `adb` forks its own server on 5037 (`PROJECT.md` D5). Startup races are expected — two CLI invocations at once — and are resolved by the socket, not by a lock file: whoever loses the bind connects to the winner. What that socket carries is `src/ipc/` above: the transport hands each accepted connection to the IPC server as a `Duplex` and knows nothing else about the protocol.

This is the **local** host only. A remote host is a long-running service its operator starts; a client never starts one across the network, and a connection refused there is an error to report, not a cue to spawn anything.

---

## The device abstraction

One interface, several backends, registered through a manifest (`ai/CODING_STANDARDS.md`, "Module shape for a device backend"). The interface covers: enumeration and being told when the attached set changes, lifecycle, device facts (screen size, density, the derived dp scale and the OS version), install, app control, screen capture, the system-log read, hierarchy read, input, and environment (network state).

### Capabilities, not a lowest common denominator

Backends are genuinely asymmetric and flattening that is the design mistake to avoid (`PROJECT.md` D11):

- `simctl` cannot tap and cannot dump a hierarchy. Input and tree reads on iOS need `idb` or WebDriverAgent — a heavy dependency with its own lifecycle.
- **Semantic screen reading may have no iOS equivalent at all.** On Android it is the one capability that survives an app blocking screen capture. That is why `read_screen` is **not a required method** of the interface but a declared capability the verb layer queries first.
- A physical Android phone cannot be handed a synthetic fingerprint; an emulator can.
- **Screen recording is another of them**, and it is why `recordVideo` is a declared capability
  rather than a required method: an iOS *simulator* records with `simctl io recordVideo`, while a
  physical iOS device has no cheap command-line equivalent at all. `record_video` declares
  `requires: ['canRecordVideo']` for `read_screen`'s reason — the payload *is* the answer, so a
  backend without it has to fail by name before dispatch rather than answer with no recording.
- **A system log is not one of those asymmetries**, which is why `readLogs` is a *required* method and not a capability: every platform here keeps one, and a flag that is always `true` is noise (`src/core/capabilities.ts`). What differs is the wording inside an entry — that is what the neutral `LogEntry` shape and a backend's own parser absorb.
- **Moving a file is not one either**, so `pushFile` and `pullFile` are required too. The asymmetry that matters there is the *direction* rather than the platform: a push takes a path on the host, because the host is where the daemon runs, and a pull answers with **bytes**, because the answer is read on the agent's machine (D19).
- **A missing *host* program is not one either, and it must not be modelled as a capability.**
  Slicing a recording into frames needs a video decoder this project does not contain, so the host
  drives `ffmpeg` off `PATH` (`src/daemon/frames.ts`). Capabilities describe what a device backend
  can do; `ffmpeg` says nothing about any device, and the remedy is different in kind — install a
  program *here*, rather than stop asking *that device*. So it is a named verb failure
  (`frame-extraction-unavailable`) and never a `Capabilities` flag, and the honest empty-result rule
  applies exactly as it does to a capability — with no exception left to it. A frame list on an `ok`
  answer is **never empty**: the one case that legitimately sampled to nothing (a screen that never
  changed) is closed inside the filter, and every other way a host produces no images is one of the
  named `frame-extraction-…` failures.

So: each backend declares its manifest, the verb layer checks before dispatching, and an unbacked verb fails with an error naming the capability and the device. A conformance suite runs once per registered manifest — see `ai/TESTING.md`.

### Where the iOS seam runs

**Not** along "adb versus simctl". Along the interface above. An iOS backend will need at least two external programs where Android needs one, so nothing in the interface may assume a single tool per backend, a single process, or that enumeration is cheap (`simctl list` is a poll; `adb track-devices` is a stream).

---

## Lease lifecycle

```
request ──▶ match against a re-verified inventory
              │
              ├─ nothing free ──▶ wait, or refuse with what is held and by whom
              │
              └─ grant ──▶ handle + capability manifest
                             │
                             │  every verb call pushes the expiry out
                             │
                             ├─ release ──────┐
                             ├─ expiry (20m) ─┤──▶ restore ──▶ back to the pool
                             └─ device gone ──┘
```

- **Per device, not per machine** (D7). The predecessor took the whole rig because it was a file.
- **The TTL is refreshed by activity, not by a heartbeat** (D8). An agent pauses to think for minutes at a time, so a fixed budget is wrong in both directions; a dead agent issues no more calls and expires on its own.
- **Restoration runs on release *and* on expiry** (D9): stop the app, airplane mode off, wifi on, then the project's teardown hook. A teardown that only runs on the happy path is not a teardown. Every step is contained, including working out what the project owns, so one unreadable project description costs that project's steps rather than the device's. The teardown hook is foreign code and is bounded like the shutdown's other waits, because a grant queues behind it. `close()` sweeps once more and then waits out what is still owed, bounded: a lease dies with the host, so an abandoned restoration is never retried by anything.
- **A lease carries an owner string** — `issue-112`, `pr-127-review`, and later a Swarm run identity (`ai/RULES.md` §1). Never derive it from a process id, and never from whoever authenticated (D20).
- **Only a device physically attached to the host is ever granted a lease** (D18); the handle is
  the device serial — there is exactly one host, so nothing else needs naming.
- **A dropped connection is not a special case.** It is an absence of further calls, and the TTL already covers that.
- **Inventory is re-verified at grant time** (D6): the daemon is a cache and `adb` is the truth. A device that disappeared mid-lease is an ordinary case with its own error, not an exception path.

---

## The verb layer

Verbs live above the backends and below the adapters, and this is where determinism is enforced (D12) — not in the agent's discipline:

- **Target resolution happens inside the verb**, from a screen captured during that call. A coordinate is a fallback, never the primary address of an element.
- **Waiting is polling on a condition with a timeout.** There is no sleep in this codebase — the vocabulary is `waitForCondition` in `src/core/wait.ts`, the one module allowed to construct a delay, and `tests/unit/no-sleep.test.ts` is the gate that keeps it the only one. A timeout reports what it was waiting for and what was on screen instead. `wait_for` and `wait_until_gone` (`src/verbs/wait-for.ts`) are what an agent actually calls.
- **Every verb returns post-state**, so the agent never infers success from the absence of an error.
- **A gesture's duration is the device's own**, passed to the drag as an argument and never waited out on the host — which is why the input verbs need no exemption from the rule above.

### The spine every verb is built on

`src/verbs/` is where those rules are enforced once rather than once per verb. A verb hands
`performAction()` what it needs, what it is aimed at and what it does, and gets a result back:

- **`VerbContext`** — the serial, the backend and its capability manifest — is constructed by the
  caller that already resolved the device: `src/daemon/verb-handlers.ts`, which is the only place
  in the tree that builds one in production. The verb layer never looks a device up.
  `capabilityMethod()` is the only way it reaches a capability-gated method, so the manifest is
  consulted before every dispatch (D11); a capability declared with no method behind it is a wiring
  bug and says so, distinctly from a device that honestly opted out.
- **`resolveTarget()` takes a target and nothing else** — no screen, no element list, no
  previously-read state — which is what makes the fresh read structural instead of a rule. A miss is
  `null`; `requireTarget()` is the loud version and names what was on screen instead. Two matches
  are `AmbiguousTargetError` naming every candidate, because a silent first match is right half the
  time, and the remedy in that message is the one that target kind can actually take. A
  `by: 'point'` target stays the documented fallback (`PROJECT.md` §4), marked in the result as
  **not** having come from a screen. **Every** resolved point is range-checked against the device,
  however it was arrived at: an element the screen read reported is not evidence that it is
  reachable, since a node clipped out of its scrolling container comes back with inverted bounds
  (`PROJECT.md` §6) whose midpoint is arithmetic rather than a place. That is
  `UnaddressableElementError`, distinct from "not found" because the element *was* found.
- **`waitFor()` and `waitUntilGone()`** are the wait vocabulary as verbs, and the reason they are
  not built on `performAction()` is that their work *is* the resolution: a spine that resolves the
  target before running the action would resolve it before the wait had happened. Every poll is a
  new screen read — a wait over one cached read is the stale-coordinate failure with a timer on it —
  and the capability check comes before the first poll, so a backend that cannot read its screen is
  told so by name rather than after a whole timeout. `wait_for` waits until the target is there
  **and can be acted on**, reading a clipped element as *not yet* rather than as a failure, since a
  screen still moving is what a wait is for; an ambiguous target is not, and propagates. Presence
  for `wait_until_gone` is a match rather than a resolution: an element matched twice is still there
  twice, not an under-specified request; its timeout reports those matches rather than the screen
  they sit in, because they are what kept the condition false. Both take a `ScreenTarget` — a
  `by: 'point'` target has no presence a screen read can confirm or deny, so it is not a question
  these can be asked — and `wait_until_gone` narrows that again to an `AbsenceTarget`, `ScreenTarget`
  without a text target's `index`: an index is a slot in the match list, not an identity, so it
  empties as soon as any sibling goes and would report a row as gone while it is still on screen.
  Both refusals are types rather than runtime checks, so neither verb is handed a field it drops.
- **`tap()`, `longPress()`, `swipe()` and `scroll()`** (`src/verbs/input.ts`) are the first verbs
  built *on* the spine rather than beside it, and each is one `performAction()` call: none of them
  reads a screen itself, so the three rules hold for them by construction instead of by four
  authors remembering. `long_press` is a drag from a point to that same point held past the
  device's own long-press timeout — never a key event carrying a long-press flag, which applies to
  keys and not to touch (`PROJECT.md` §6) — and `scroll` is a drag across the middle of a region,
  so neither adds a backend method: `DeviceBackend`'s input methods stay four primitives and the
  composition lives in one place for every platform. `scroll`'s direction is where the **content**
  goes, the sense a scrollbar has, which makes `scroll 'down'` a drag *upwards*; the region is the
  resolved element's own rectangle, or the whole screen when none was named, and it will not take
  a `by: 'point'` target at all — a coordinate has no extent, so it cannot say how far a scroll
  may travel. `swipe` is the one verb with two targets: `from` goes through the spine and is what
  the result reports, `to` is resolved inside the action from its own read, because widening the
  spine to carry a second target would generalise it for one caller.
- **`typeText()` and `pressKey()`** (`src/verbs/input.ts`) complete that family and are the two
  that pass **no target at all**. `PerformActionOptions.target` is optional for exactly this: a key
  press addresses no element, and neither does text going to whatever holds focus, so the
  `ActionResult`'s `target` is `null` — a fact about the verb, not a resolution that failed. Neither
  therefore reads a screen to aim, so neither can fail on a target a screen read would have had to
  find first. There is no target *option* on `type_text` either: an
  agent composes `tap` with it, rather than keeping a second copy of the spine's resolution here.
  `pressKey` takes `DeviceKey` — the vocabulary in `src/core/device.ts`, shared with the backend and
  with the wire so all three refuse the same keys. `typeText` hands the caller's string to the
  backend **byte for byte and inspects none of it**: what a device's own text entry reads rather
  than types is that backend's knowledge, and any escaping rule applied here would be one platform's
  rule applied to every platform. A device that cannot type a string at all answers
  `UnsupportedTextError` — a device-layer error like a missing capability, mapped to an
  `unsupported-text` failure naming the offending characters as escapes, because the string is the
  caller's and the caller is who can change it. A plain `Error` there would arrive as
  `internal_error`, telling an agent the host broke over a string the agent chose.
- **`launchApp()`, `stopApp()` and `clearAppData()`** (`src/verbs/app.ts`) are the same spine with
  two things left out, and both omissions are the family's whole content. **`requires: []` is the
  honest answer for a verb built only on required interface methods**: these three are declared on
  `DeviceBackend` itself, so there is no capability to assert, and the list is required rather than
  optional precisely so an author has to say that out loud instead of leaving it off. They reach
  `context.backend` directly rather than through `capabilityMethod()`, which will not typecheck for
  an ungated method — the type saying so is the design working, and adding a `canControlApps` flag
  to "fix" it would be a capability that is always true. **And they pass no target at all**, because
  an app id addresses a package rather than something on the screen: no screen is read before the
  action and `ActionResult.target` is `null`, which is a fact about the verb rather than a
  resolution that failed. `stop_app` cannot distinguish a stopped app from a package that was never
  installed — the device answers the same either way (`PROJECT.md` §6) — so the after-state is what
  settles that, and no probe here pretends to. One family-wide gap is recorded rather than hidden: a
  device-level refusal, such as launching a package that is not installed, is still a rejected
  promise out of the backend and so arrives as `internal_error`. That is true of every verb family
  here and is filed as its own issue rather than fixed one family at a time.
- **`readLogs()`** (`src/verbs/logs.ts`) is the same spine again, and the first verb whose answer
  carries **more than an `ActionResult`**: the log entries ride on top of it. That is what factored
  `VerbCallResultSchema` into a `verbCallResultOf()` factory in `src/ipc/verb-methods.ts` and made
  `runVerb` generic in the result type — only the `ok` branch varies, so a failure and a refusal
  stay one vocabulary whatever was asked. It is still the only verb that needs that extension:
  `pull_file`'s payload is bytes, and bytes already have a place on every result. The verb owns the default bound; a backend never invents one, and
  a `truncated` flag it cannot decide for itself keeps a short read from reading as a quiet device.
  Like the app verbs it requires no capability and resolves no target, and like every bounded read
  in this repository it does not follow — a tail that stays open is a wait with no condition and a
  stream over a protocol built for request and response.
- **`recordVideo()`** (`src/verbs/record.ts`) is the second verb whose answer carries more than an
  `ActionResult`, and it reuses `readLogs`' machinery rather than forking it:
  `RecordVideoResultSchema` is `ActionResultSchema.extend({ frames })`, its row's answer comes out
  of the same `verbCallResultOf()` factory, and `runVerb` was already generic. The recording rides
  on `artifact` where `screenshot`'s capture does; the frames are the one field added. What is new
  in shape is **where the work happens**: extracting frames needs a host program, and a program
  started from anywhere under `src/verbs/` would be `node:child_process` in every client's module
  graph, since `src/ipc/verb-methods.ts` imports these schemas (D19). So the verb declares a
  `FrameExtractor` — a function from a finished recording to images — and the daemon supplies the
  one implementation (`src/daemon/frames.ts`), exactly as it supplies `context.backend`. That is the
  pattern to copy for the next host-side tool, and `tests/unit/no-backend-in-a-client.test.ts` walks
  the graph from each client entrypoint so it stays a fact rather than a convention. The bounds live
  with the verb rather than with the tool, so they hold whichever extractor was handed in — and that
  includes the extraction *timeout*, which is a verb-layer constant even though only the daemon's
  runner passes it to a process: `rover record`'s own request timeout has to cover every budget the
  host spends inside one call, and a client cannot import a daemon module to read one.
- **`readScreen()` and `deviceInfo()`** (`src/verbs/read.ts`) are the spine with the *middle* left
  out: their action is empty, because a read verb's work is the capture `performAction()` already
  performs for every verb — the screen for the after-state, the device for D14. Routing them
  through the spine rather than around it costs one no-op call and is what keeps a read from
  growing an answer shape of its own. `read_screen` declares `requires: ['canReadScreen']`, and
  that declaration is the verb: without it the call would still answer, with the `unavailable`
  after-state below, which is honest for a *tap* and wrong here — for a read the state is not
  context around an action, it is the entire answer, so D11's loud failure has to come before
  dispatch. `device_info` requires nothing (a required backend method, like the app family) and
  answers with `result.device`. Neither passes a target, for the same reason the app verbs do not.
- **`installApp()`, `pushFile()` and `pullFile()`** (`src/verbs/files.ts`) are the family whose
  subject is **which machine a file is on**. The spine again, with `requires: []` and no target for
  the app family's reasons; what is particular to them is the boundary. Bytes go *in* — a package
  and a pushed file arrive base64 in the call, because a path from a caller names a file on the
  wrong machine — and bytes come *out*: `pull_file` puts them on `ActionResult.artifact`, exactly
  where `screenshot` puts a capture, rather than in a result shape of its own. That reuse is the
  load-bearing decision rather than an economy: the artifact already refuses an over-sized answer by
  name instead of cutting it, and an answer with no field for a path is one that can never carry a
  host path (D19). The host-side file the two inbound rows need is written and removed by the
  daemon's handler in a `finally` — not by the verb, which touches no filesystem, and not in
  `src/ipc/`. Two named caps bound the two directions (`MAX_TRANSFER_BYTES` in, `MAX_ARTIFACT_BYTES`
  out), and both refuse rather than truncate; raising them is R24's row, landing underneath these
  verbs rather than changing what they promise. **Each cap is applied where its bytes are.** The
  inbound one is a params schema, so an over-sized call is refused before the host decodes anything;
  the outbound one is handed *down* to the backend (`PullFileOptions`, the way `ReadLogsOptions`
  already carries `maxEntries`), so a file too big to answer with is refused before it is staged on
  the host and read into the daemon's memory. A bound checked only on the way back would already
  have cost what it was for.
- **Two things that layer does *not* relay, and states instead.** A `devicePath` is never a
  directory, in either direction, and both refusals are Rover's rule rather than a device answer.
  For `pushFile` the platforms' own tools copy the file inside such a path under a **host-side**
  basename and call that a success, so relaying it is how a caller gets `ok` about bytes under a
  name this host invented (ai/RULES.md §2). For `pullFile` the rule is stronger — the source must
  be a **regular file**, not merely not-a-directory — and that is what keeps the cap above
  meaningful, because a regular file is the only shape whose reported size predicts the transfer.
  A directory's copy is *recursive* while the size reported for it is the directory's own few
  kilobytes; a character device reports **zero** and then reads until the transfer times out. A
  backend bounding on the reported number alone would admit either and only discover it once every
  byte was on the host, so the kind is refused before the transfer rather than the size after it.
  The asymmetry is deliberate: inbound there is nothing to bound, the caller named the exact
  destination, and what a device special file does with the bytes is the device's answer. And no host path
  reaches the caller in a *failure* either — the same D19 that keeps paths out of results keeps the
  daemon's own temporary file out of the message an `internal_error` carries, in the command it
  quotes *and* in the streams, since adb writes the path it was handed back into its own output.
- **`setAirplaneMode()` and `setWifi()`** (`src/verbs/environment.ts`) are the same spine again, and
  the family where `requires` finally does the other half of its job. Both declare
  `requires: ['canControlNetwork']` and reach the backend through `capabilityMethod()` rather than
  `context.backend.*` — the mirror image of the app verbs, whose methods are required ones
  `capabilityMethod` will not typecheck for. A backend that does not declare the capability is a
  `MissingCapabilityError` before anything is dispatched, naming capability, device and backend
  (D11), which is the difference between "this device cannot do that" and a toggle that answered
  `ok` and moved nothing. Neither passes a target — a radio is not something on the screen, so
  `ActionResult.target` is `null` like the app verbs' — and the after-state each answers with is the
  spine's own capture: evidence that the device was still there and answering, and deliberately
  **not** a reading of the radio, since `DeviceBackend` has no network getter and neither verb
  invents one. These are the same two backend methods `src/daemon/restore.ts` drives when a lease
  ends, which is what stops the verb layer and the restoration drifting: one recipe per toggle, in
  one backend, with a second caller rather than a second path — and the order the restoration uses
  is worth copying, because the airplane-mode toggle can move wifi underneath it while the wifi
  toggle never moves airplane mode (`PROJECT.md` §6).
- **`ActionResult`** names the verb, the device (as `DeviceInfo`, so D14's density travels with the
  measurement), the resolved target and the state after the action. A backend with input but no
  screen reading answers an explicit `unavailable` after-state naming the capability that would have
  answered — never an empty element list, which reads as a blank screen. `screenshot` and
  `record_video` are the two verbs whose answer is not a state the result already carries, and both
  hang their bytes off the same nullable `artifact` field rather than growing a second home for
  them — `record_video` extends the schema for its *frames* and still leaves the recording there. A read that was declared,
  attempted and rejected is the separate `failed` branch: once the action has run, an exception in
  its place would leave the agent unable to tell whether it landed, which is exactly what D12(c)
  rules out. Every shape is a Zod schema of plain data, because the host executes the verb and the
  agent reads the result somewhere else (D19).

### Where a verb call comes from

The daemon loads the core and executes the verbs; the CLI and the MCP server are clients that ask
over the same surface as leases (D19, R21). `src/daemon/main.ts` — the entrypoint, and not the
module that binds the socket — imports the backend barrel, so the process holding the hardware is
the process with a registry.

- **A verb call carries the lease id, not a serial.** The lease id is the credential (D20) and the
  host derives the device from it, so the holder of one device cannot address another.
- **The lease is renewed when the call arrives**, before any await (D8). Renewing on completion
  instead would let a long verb's own lease expire while it runs, and an expiry mid-verb fires
  restoration on a device the verb is actively driving. `MAX_VERB_TIMEOUT_MS` caps a wait far below
  the TTL so that is unreachable rather than merely unlikely.
- **The device is re-verified per call, never read from the snapshot** (D6) — the same
  `verifyForGrant` a grant uses, which is what separates "the device went away" from a stale cache
  entry.
- **The answer has three branches, all data** (`src/ipc/verb-methods.ts`). `ok` carries the
  `ActionResult`. `failed` carries a `VerbFailure` — the verb-layer errors as a parseable union
  (`src/verbs/failure.ts`), each branch carrying both the error's own message and its structured
  fields, so a client can print one line or branch on a `kind`. `refused` means no verb ran at all:
  `no-lease`, `gone`, `not-attached`, `not-ready`. Anything outside those three throws and arrives
  as `internal_error`, which keeps that code meaning "the host broke".
- **A verb never outlives the lease that authorised it.** A release the server did not wait for, or
  an expiry the sweep observes, can land while a verb is still polling the device. So the whole call
  is registered with `src/daemon/verb-traffic.ts` for as long as it runs: the lease's end revokes the
  backend that call was handed, its next device call throws, and the answer is `refused` /
  `no-lease`. Revocation cannot stop a round trip already issued, so there is a second half — the
  restoration a lease's end starts waits for those calls to unwind first, and `acquire_device`
  inherits that wait through `DeviceRestorer.settle`. Without both, the host itself becomes the
  second driver of a device it has already lent to somebody else.
- **A call that produced bytes has a second effect: the archive** (D23, `PROJECT.md` §10). Every
  `ok` answer from a `screenshot`, a `record_video` or a `read_logs` is also written into the
  host's own durable tree — `src/daemon/archive.ts`, wired into the same preamble. It is
  **additive, never substitutive**: the bytes still go back to the client exactly as R24 settled,
  and no archive path is ever put on an answer. That last part is structural rather than
  disciplined — `src/ipc/server.ts` parses every handler's answer against that row's `.strict()`
  result schema, so a path on a result is `invalid_result` before it leaves the host. It cannot
  fail the call either: `ArtifactArchive.record` never throws, so an unwritable root is a warning
  on the host and an unchanged answer to the agent. It lives in the daemon for `src/daemon/frames.ts`'s
  reason — the verb layer is in every client's module graph, and host filesystem work under it
  would be host behaviour inside a CLI (D19).
- **A shared preamble, one row per verb.** `createVerbHandlers` does the renew / register /
  re-verify / resolve work once, so each further verb family is one `IPC_METHODS` row and one
  `runVerb` call rather than another copy of it — and inherits the rule above by construction rather
  than by remembering it. That is why this row landed before the verb families. The three app rows
  are what that promise looks like cashed: they share one params schema between them, because the
  three calls are identical, and a verb that later grows a field of its own forks it rather than
  widening what every row would then advertise.

### Where an MCP tool call comes from

`src/mcp/` is the second adapter onto the same host surface (D4, R19), and it is a **client**
exactly as the CLI is: it holds no verb logic and reaches no backend, which
`tests/unit/no-backend-in-a-client.test.ts` walks its module graph to keep true.

- **The Zod schemas are the tool declarations.** Each `registerTool` is handed the exported
  `*ParamsSchema` from `src/ipc/methods.ts` whole, so the JSON Schema an agent reads and the parse
  the daemon performs are one object rather than two that drift (`ai/CODING_STANDARDS.md`,
  boundary #1). The tool names are the `IPC_METHODS` keys, unchanged. No `outputSchema` is
  declared: a result schema's *output* type is full of branded transforms JSON Schema cannot
  express, and the client has already parsed the answer against the real schema.
- **One tool call is one connection**: connect, one request, `close()` in a `finally` — the same
  thing every CLI command does, so there is no held connection to reconnect and the local host
  autostarts on the first call (D5).
- **The verbs are tools under the same names.** The sixteen `IPC_METHODS` verb rows whose answer
  is plain data are declared from one table (`src/mcp/tools/verbs.ts`), each from its own exported
  `*ParamsSchema` — so the three app rows share one declaration and the two environment rows share
  another, exactly as the calls do. **Zero verb logic**: every handler is one `callHost` and one
  shared mapping of `verbCallResultOf`'s three branches (`src/mcp/_shared/verb-answer.ts`), so an
  `ok` travels whole — the resolved target, the after-state and `read_logs`' entries included — and
  a failure and a refusal are both `isError` carrying the host's own sentence with the structured
  document under it. The CLI's `src/cli/_shared/verb.ts` is the same three branches rendered for a
  human; neither decides anything the host already decided. A completeness gate over
  `IPC_METHODS` is what stops a verb row landing later with no tool and no decision.
- **An artifact reaches the agent as bytes it can use, never as a path on the host**
  (`src/mcp/tools/artifacts.ts`, `src/mcp/_shared/artifact.ts`). The two rows whose answer *is*
  bytes answer differently, because their bytes are different things. `screenshot` comes back as
  an inline MCP `image` block and writes nothing — a screenshot exists to be looked at, and an
  inline image is the one form of an artifact that needs no path at all, which is how D19 is
  satisfied here. `record_video` writes the recording to a file **on the agent's machine** and
  reports its absolute local path, because an mp4 is not something a model can read; its frames
  come back as image blocks, already bounded by `MAX_FRAMES_BYTES` and `MAX_FRAMES`, so the
  recording is legible without a second call. Neither declaration has a destination or a format
  on it, because the capture happens on the host. The document beside the blocks goes through
  `describeWithoutBytes`, so `structuredContent` says what the answer carries without repeating
  it. Where a recording lands is `ROVER_MCP_ARTIFACT_DIR` — server configuration for the reason
  the host is one — created on demand, and only when there are bytes to write: a refusal
  (`artifact-too-large`, `unfinished-recording`, `frame-extraction-unavailable`,
  `frames-too-large`) is `isError` naming it and leaves **no** file behind, not a truncated one
  and not a zero-byte one. `record_video` raises its own request timeout past the recording *and*
  the host's frame extraction, `rover record`'s three-term sum with every term imported. The three
  rows that move a whole file — `install_app`, `push_file`, `pull_file` — are deliberately not
  tools: how a client supplies and receives a file is R24 phase 2's, and neither client has it.
- **A missing capability is a loud, agent-readable error** (D11). `read_screen` against a backend
  that does not declare `canReadScreen`, and either environment row against one without
  `canControlNetwork`, come back `isError` carrying the `missing-capability` failure — the
  capability, the serial, the platform and the backend's label — never an empty screen, never a
  toggle that quietly did nothing, never an `ok`. The tool descriptions name the capability too,
  so an agent can check the list `acquire_device` handed it before it calls.
- **A call that can outlast the client's own deadline raises it.** A verb may be asked to wait or
  hold for up to `MAX_VERB_TIMEOUT_MS`, well past the 30 s `DEFAULT_REQUEST_TIMEOUT_MS`, so the two
  waits and the three gestures with a `durationMs` derive a request timeout from the call's own
  knob plus that default — `rover record`'s pattern. The verb's own default is imported to size it
  and never put on the request, so the verb's default stays the only default, and a long-but-normal
  call is never reported as a hang.
- **The host is configuration, never a parameter** (D17). `ROVER_HOST_ADDRESS` set means the
  remote host, unset means the local daemon, and it is resolved at startup, before the stdio
  transport is connected — a half-configured server dies naming what is missing rather than
  advertising tools and failing at the agent's first call. No tool takes a host argument, so an
  agent cannot redirect a call at a machine nobody pointed it at.
- **A refusal is loud and carries the host's own document.** The answer travels verbatim as a JSON
  text block plus `structuredContent`; a refused acquire is `isError` carrying `heldBy`, and an
  unreachable host is a sentence naming the address and the port. Never an empty list that reads
  like an answer.
- **stdout belongs to the protocol.** The stdio transport frames on stdout, so nothing under
  `src/mcp/` may import `src/cli/_shared/output.ts` or call `console.log`; diagnostics go to
  stderr, and `tests/unit/mcp/stdout.test.ts` is the source-scan gate under that.

---

## Project hooks

Everything application-specific is a hook in the project's configuration file (D13): how to install, what helper services to start and stop, what teardown means beyond the device defaults. The core knows no application's name, and a default that mentions one is a bug.

**Where it lives.** One file per project, `<project>.json` under `ROVER_PROJECTS_PATH` (`~/.rover/projects` by default), beside `rover.sock`, `users.json` and `artifacts/`. It is **host-side operator configuration**: verbs run where the hardware is (D19), and a teardown stranded on the client's machine could not stop the helper service it started. Nothing about it crosses the wire — a lease carries an opaque `project` *string* (D22), and no IPC method reads a hook file, writes one, or accepts a path into that directory. The file is selected by that string, **re-read at every use and never cached** (D6), and a string that is not a valid identifier resolves to no hooks at all — which is also the traversal guard, since no path is ever built from one that failed the shape.

**What it carries today.** `project` (which must equal the file's own name), `apps` — the applications a lease on this project drove — and `teardown`, one command declared as a program and its arguments rather than a shell line. The install command and the helper services are named in D13 and are not in the schema yet: a field lands with its consumer (`ai/RULES.md` §7). `src/daemon/project-hooks.ts` is the Zod schema and the reader; `README.md`'s configuration section mirrors it.

**How it reaches the device.** Through the restorer's existing seam and nowhere else. `src/daemon/restore.ts` names a `ProjectResolver`; `src/daemon/project-resolver.ts` fills it from the hook file, and `src/daemon/hook-command.ts` — the only one of the three that starts a process — runs the declared command bounded, with `shell: false`, output tail-limited, and `ROVER_PROJECT` and `ROVER_DEVICE_SERIAL` in the child's environment. That bound is on the hook's own process — the run ends when the child exits, not when its pipes close — so a teardown that backgrounds a helper is finished the moment it exits, and the daemon is never left waiting on descriptors a grandchild inherited. The split is load-bearing: `restore.ts` is imported by `lease-handlers.ts` and must stay free of a spawn (`tests/unit/daemon/remote-never-spawns.test.ts`), and reading a hook file must stay importable from anywhere. Because the seam hangs off the lease store's end hook, the teardown runs on **release and on expiry alike** (D9) — the second being the path where there is no caller left to ask.

---

## Not built, deliberately

No database — the daemon's *operational* state (inventory, leases, ports) is per-host, ephemeral and re-derivable. The artifact archive (`PROJECT.md` §10, D23) is a deliberate exception: files on disk, not daemon state, and nothing the daemon needs to survive a restart to keep working. Its directory shape is itself a stable contract a future read-only web panel would read directly off disk (`PROJECT.md` D24, `docs/WEB_PANEL.md`) — that panel is not being built now, but the archive is already shaped so building it later needs no redesign. No cloud half. Rover is nothing's CI gate — it asserts nothing about the app under test and turns nothing red on its own; the `verify` workflow on this repo's own pull requests (`PROJECT.md` §7, R26) runs Rover's unit suite and is not part of the product. No device farm, no host catalogue and no registration of hosts with one another: a client learns about hosts from its own configuration and nowhere else (`PROJECT.md` §7). No comparison against design renders: Rover supplies screenshots and measurements; judging them is the agent's job.
