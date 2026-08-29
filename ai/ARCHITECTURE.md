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
client shares a filesystem, a user or a clock with the host. A transport — the local socket
first, TLS for a remote host later (D17, R22) — is a **separate module that consumes this
one**, handing it an already-connected stream. That is what makes a network listener an added
transport rather than a rewrite, and it is checkable by reading the imports: the unit tests
drive the whole surface over an in-memory stream pair that is not a socket at all.

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
- **Waiting is polling on a condition with a timeout.** There is no sleep in this codebase — the vocabulary is `waitForCondition` in `src/core/wait.ts`, the one module allowed to construct a delay, and `tests/unit/no-sleep.test.ts` is the gate that keeps it the only one. A timeout reports what it was waiting for and what was on screen instead.
- **Every verb returns post-state**, so the agent never infers success from the absence of an error.

### The spine every verb is built on

`src/verbs/` is where those rules are enforced once rather than once per verb. A verb hands
`performAction()` what it needs, what it is aimed at and what it does, and gets a result back:

- **`VerbContext`** — the serial, the backend and its capability manifest — is constructed by the
  caller that already resolved the device (R21's daemon handler). The verb layer never looks a
  device up. `capabilityMethod()` is the only way it reaches a capability-gated method, so the
  manifest is consulted before every dispatch (D11); a capability declared with no method behind it
  is a wiring bug and says so, distinctly from a device that honestly opted out.
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
- **`ActionResult`** names the verb, the device (as `DeviceInfo`, so D14's density travels with the
  measurement), the resolved target and the state after the action. A backend with input but no
  screen reading answers an explicit `unavailable` after-state naming the capability that would have
  answered — never an empty element list, which reads as a blank screen. A read that was declared,
  attempted and rejected is the separate `failed` branch: once the action has run, an exception in
  its place would leave the agent unable to tell whether it landed, which is exactly what D12(c)
  rules out. Every shape is a Zod schema of plain data, because the host executes the verb and the
  agent reads the result somewhere else (D19).

---

## Project hooks

Everything application-specific is a hook in the project's configuration file (D13): how to install, what helper services to start and stop, what teardown means beyond the device defaults. The core knows no application's name, and a default that mentions one is a bug.

---

## Not built, deliberately

No database — the daemon's *operational* state (inventory, leases, ports) is per-host, ephemeral and re-derivable. The artifact archive (`PROJECT.md` §10, D23) is a deliberate exception: files on disk, not daemon state, and nothing the daemon needs to survive a restart to keep working. No cloud half. Rover is nothing's CI gate — it asserts nothing about the app under test and turns nothing red on its own; the `verify` workflow on this repo's own pull requests (`PROJECT.md` §7, R26) runs Rover's unit suite and is not part of the product. No device farm, no host catalogue and no registration of hosts with one another: a client learns about hosts from its own configuration and nowhere else (`PROJECT.md` §7). No comparison against design renders: Rover supplies screenshots and measurements; judging them is the agent's job.
