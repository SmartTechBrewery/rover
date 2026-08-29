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
in place; **no backend is registered yet**. The daemon's IPC message surface has landed too —
the schemas, the framing and a transport-independent server and client — but **no daemon process
yet**: it binds to any duplex stream and nothing has bound it to a socket. The backlog is twenty
issues in dependency order — see [`PROJECT.md`](PROJECT.md) §9.3.

## Where things are

| Document | What it answers |
|---|---|
| [`PROJECT.md`](PROJECT.md) | Why this exists, the sixteen decisions and their reasoning, the verb set, verified adb recipes, the backlog |
| [`ai/RULES.md`](ai/RULES.md) | The single source of truth for agents working in this repo — read it first |
| [`ai/ARCHITECTURE.md`](ai/ARCHITECTURE.md) | The four components, the lease lifecycle, where the iOS seam runs |
| [`ai/CODING_STANDARDS.md`](ai/CODING_STANDARDS.md) | Stack, Zod boundaries, error handling, module shape |
| [`ai/TESTING.md`](ai/TESTING.md) | Vitest, the real-device gate, fixtures, conformance |

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
