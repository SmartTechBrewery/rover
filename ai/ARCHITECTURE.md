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

Each pair is handed the same `IpcServer` or wrapped by the same `createIpcClient`, so there is
one method table, one dispatcher, one set of schemas, and nothing for the four to drift from.
`src/daemon/network-config.ts` carries both halves' configuration, and `ROVER_HOST_TOKEN` is
deliberately one variable for both: a machine that hosts devices and also borrows one is
holding one secret, not two.

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
other transport; and `src/ipc/` genuinely does not know it is authenticated. Every pre-auth
failure — wrong token, missing, malformed, oversize, or a handshake that times out — gets one
byte-identical `unauthenticated` refusal and a destroyed connection, because a refusal that varied
with the reason would tell a stranger something about the host (D20). The token authenticates and
attributes nothing: a lease's owner is a separate, caller-supplied string, never derived from
whoever authenticated.

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
  host-local path is a bug even when it works on a local host.

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

One interface, several backends, registered through a manifest (`ai/CODING_STANDARDS.md`, "Module shape for a device backend"). The interface covers: enumeration and being told when the attached set changes, lifecycle, device facts (screen size, density, the derived dp scale and the OS version), install, app control, screen capture, hierarchy read, input, and environment (network state).

### Capabilities, not a lowest common denominator

Backends are genuinely asymmetric and flattening that is the design mistake to avoid (`PROJECT.md` D11):

- `simctl` cannot tap and cannot dump a hierarchy. Input and tree reads on iOS need `idb` or WebDriverAgent — a heavy dependency with its own lifecycle.
- **Semantic screen reading may have no iOS equivalent at all.** On Android it is the one capability that survives an app blocking screen capture. That is why `read_screen` is **not a required method** of the interface but a declared capability the verb layer queries first.
- A physical Android phone cannot be handed a synthetic fingerprint; an emulator can.

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
- **`ActionResult`** names the verb, the device (as `DeviceInfo`, so D14's density travels with the
  measurement), the resolved target and the state after the action. A backend with input but no
  screen reading answers an explicit `unavailable` after-state naming the capability that would have
  answered — never an empty element list, which reads as a blank screen. A read that was declared,
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
- **A shared preamble, one row per verb.** `createVerbHandlers` does the renew / register /
  re-verify / resolve work once, so each further verb family is one `IPC_METHODS` row and one
  `runVerb` call rather than another copy of it — and inherits the rule above by construction rather
  than by remembering it. That is why this row landed before the verb families. The three app rows
  are what that promise looks like cashed: they share one params schema between them, because the
  three calls are identical, and a verb that later grows a field of its own forks it rather than
  widening what every row would then advertise.

---

## Project hooks

Everything application-specific is a hook in the project's configuration file (D13): how to install, what helper services to start and stop, what teardown means beyond the device defaults. The core knows no application's name, and a default that mentions one is a bug.

---

## Not built, deliberately

No database — the daemon's *operational* state (inventory, leases, ports) is per-host, ephemeral and re-derivable. The artifact archive (`PROJECT.md` §10, D23) is a deliberate exception: files on disk, not daemon state, and nothing the daemon needs to survive a restart to keep working. No cloud half. Rover is nothing's CI gate — it asserts nothing about the app under test and turns nothing red on its own; the `verify` workflow on this repo's own pull requests (`PROJECT.md` §7, R26) runs Rover's unit suite and is not part of the product. No device farm, no host catalogue and no registration of hosts with one another: a client learns about hosts from its own configuration and nowhere else (`PROJECT.md` §7). No comparison against design renders: Rover supplies screenshots and measurements; judging them is the agent's job.
