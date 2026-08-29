# Architecture

What is actually built, and where the seams run. `PROJECT.md` carries the decisions and their reasoning; this document carries the shape. Where they disagree, one of them is stale — fix it rather than picking a side.

---

## Components

| Component | Instances | Lifetime | Owns |
|---|---|---|---|
| **Daemon — the device host** (`src/daemon/`) | one per machine **with devices**, reachable over the network | long-running | Device inventory, leases, port allocation, state restoration, **and executing the verbs** |
| **IPC surface** (`src/ipc/`) | library, loaded by the daemon and by every client | per connection | The wire schemas, NDJSON framing, request dispatch and response correlation — the protocol itself |
| **Core** (`src/core/`, `src/backends/`) | library | — | The device interface, the backends, the verbs |
| **CLI** (`src/cli/`) | per invocation | seconds | Human and script entry point — a **client** of a host, local or remote |
| **MCP server** (`src/mcp/`) | one per agent | agent session | Exposes the verbs as tools — also a **client** of a host |

### Where the transport seam runs

`src/ipc/` is the protocol and nothing else. It binds to a Node `Duplex` and to no other
type (`PROJECT.md` D17): no socket path, no peer uid, no hostname, nothing that assumes the
client shares a filesystem, a user or a clock with the host. A transport — the local socket
first, TLS for a remote host later (D22) — is a **separate module that consumes this one**,
handing it an already-connected stream. That is what makes a network listener an added
transport rather than a rewrite, and it is checkable by reading the imports: the unit tests
drive the whole surface over an in-memory stream pair that is not a socket at all.

### Why the daemon exists at all

Two agents working in parallel have two separate MCP servers, which cannot see each other. Devices are a shared resource; an agent session is not. Without one process holding the inventory, an unpinned install reaches every attached device and one agent screenshots the other's build — a green verification of code you did not write, which is the worst failure this class of tool has.

### Agents borrow devices; they do not host them

Rover is the machine that owns the hardware, and agents connect **to** it from wherever they run
(`PROJECT.md` D17). The relationship to Swarm is inverted: Swarm pushes work out to workers on many
machines; Rover stands still and lends devices to whoever asks. Three invariants follow, and all
three are load-bearing:

- **A device belongs to exactly one host** — the machine it is physically attached to (D18). `adb
  connect` makes another host's emulator appear in the local `adb devices`, at which point two
  daemons both believe it is theirs and free, and both grant a lease on it. That is D3's failure
  mode wearing a disguise, and both sides see green while it happens.
- **Verbs execute on the host** (D19). The core is still a library; the daemon is simply the
  process that loads it. A client that received a serial and ran `adb` itself would need adb
  reachable over the network — which D18 forbids — and would strand the project hooks and helper
  services on the far side of the network from the device they exist to serve.
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

One interface, several backends, registered through a manifest (`ai/CODING_STANDARDS.md`, "Module shape for a device backend"). The interface covers: enumeration, lifecycle, install, app control, screen capture, hierarchy read, input, and environment (network state).

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
- **Restoration runs on release *and* on expiry** (D9): stop the app, airplane mode off, wifi on, then the project's teardown hook. A teardown that only runs on the happy path is not a teardown.
- **A lease carries an owner string** — `issue-112`, `pr-127-review`, and later a Swarm run identity (`ai/RULES.md` §1). Never derive it from a process id, and never from whoever authenticated (D20).
- **Only the owning host grants a lease**, and the handle names the host as well as the serial (D18).
- **A dropped connection is not a special case.** It is an absence of further calls, and the TTL already covers that.
- **Inventory is re-verified at grant time** (D6): the daemon is a cache and `adb` is the truth. A device that disappeared mid-lease is an ordinary case with its own error, not an exception path.

---

## The verb layer

Verbs live above the backends and below the adapters, and this is where determinism is enforced (D12) — not in the agent's discipline:

- **Target resolution happens inside the verb**, from a screen captured during that call. A coordinate is a fallback, never the primary address of an element.
- **Waiting is polling on a condition with a timeout.** There is no sleep in this codebase. A timeout reports what it waited for and what was on screen instead.
- **Every verb returns post-state**, so the agent never infers success from the absence of an error.

---

## Project hooks

Everything application-specific is a hook in the project's configuration file (D13): how to install, what helper services to start and stop, what teardown means beyond the device defaults. The core knows no application's name, and a default that mentions one is a bug.

---

## Not built, deliberately

No database — the daemon's *operational* state (inventory, leases, ports) is per-host, ephemeral and re-derivable. The artifact archive (`PROJECT.md` §10, D23) is a deliberate exception: files on disk, not daemon state, and nothing the daemon needs to survive a restart to keep working. No cloud half. No CI gate. No device farm, no host catalogue and no registration of hosts with one another: a client learns about hosts from its own configuration and nowhere else (`PROJECT.md` §7). No comparison against design renders: Rover supplies screenshots and measurements; judging them is the agent's job.
