# Testing & git hooks

Same tooling as Swarm — copy its config rather than picking a different stack.

Note the double meaning of "test" in this repo and keep it straight: Rover *performs* manual verification on devices, and Rover *is* a Node.js program with its own automated tests. This document is about the second one.

## Test runner

**Vitest**, not Jest. Split into two projects:

- **Unit tests** (`tests/unit/**/*.test.ts`) — mock every external call: `adb`, `simctl`, the filesystem, the socket. No real device, no real daemon. `vi.mock()` at the top of the file, before imports. One deliberate exception, below.
- **Device tests** (`tests/device/**/*.test.ts`) — run against a **real attached device**, serially. They gate on `describe.skipIf(!process.env.ROVER_TEST_DEVICE)`, set by `tests/device/setup.ts` when it finds a usable device, so a machine with nothing attached **skips rather than fails**. Same pattern as Swarm's database gate.

Device tests take a lease like any other client. A device test that talks to `adb` directly, outside the lease, will eventually run on a device another agent is using, and that is precisely the failure this whole project exists to prevent.

### The exception: `tests/unit/daemon/` uses a real socket and real child processes

`tests/unit/daemon/` binds an actual unix socket and, for autostart, spawns actual detached `node` processes. That is a departure from the rule above and it is on purpose, because what those tests assert cannot be asserted against a mock:

- **The bind is the mutual exclusion.** Two invocations racing to start a daemon are arbitrated by the kernel — one `listen()` succeeds, the other gets `EADDRINUSE` and connects to the winner instead (no lock file, no PID file). A stubbed `listen()` that never touches the filesystem cannot produce `EADDRINUSE`, so a test built on one would prove only that the code calls the function it was written around.
- **Autostart is a real process or it is nothing.** The acceptance criterion is three concurrent clients getting three answers carrying the **same** `pid`. A mocked `spawn` cannot have a pid, cannot lose a race, and cannot leave a stale socket behind when it is killed.
- **Stale-socket recovery is filesystem behaviour.** `SIGKILL` a daemon and its socket file survives it; the recovery path stats an inode, probes, unlinks and re-binds. Every step of that is the real filesystem answering.

The cost is contained rather than accepted wholesale:

- Every socket lives inside a per-test `mkdtemp(join(tmpdir(), 'rover-'))`, removed in `afterEach`. **No test ever binds `~/.rover/rover.sock`** — that path belongs to whoever is running the tests, and binding it would take their own daemon down mid-run.
- Every **detached child** daemon a test starts is stopped in `afterEach`, by pid. The `status` result's `pid` is what makes that possible: such a child is never held as a `ChildProcess`, so the protocol is the only handle on it. An **in-process** daemon — `startDaemon()` called from the test itself, as `bind-race.test.ts` does — is closed through its `RunningDaemon` handle instead, and `stopDaemonAt` deliberately declines to signal a pid equal to `process.pid`: killing it would take the test runner down with it. `tests/helpers/daemon-socket.ts` carries the temp-socket and teardown helpers.
- The suite is still in the `unit` project — it needs no device and no hardware — but the autostart tests set an explicit `{ timeout: 30_000 }`, because starting a Node process costs far more than vitest's 5 s default allows.

Everything above this exception still holds elsewhere: a test that wants a transport and not a daemon uses `tests/helpers/duplex-pair.ts`, which is how `tests/unit/ipc/` drives the message surface over no socket at all.

## Fixtures come off a real device

Every parser is tested against output **captured from a real device**, stored under `tests/fixtures/` with the API level and model in the filename. Hand-written fixtures encode what you believe the tool prints, so the parser passes and production fails on the difference — which is the exact shape of the bug this rule prevents.

Re-capture rather than hand-edit when a format changes, and add the new fixture beside the old one instead of replacing it: a parser has to keep working on the API levels already in use.

## Test data

Factory functions (`createMockDevice()`, `createMockLease()`, `createMockCapabilities()`) returning sensible defaults and accepting `Partial<T>` overrides, mirroring Swarm's `tests/helpers/factories.ts`. Don't hand-construct the same fixture inline in every file.

## Backend conformance

One suite run per **registered** backend manifest, mirroring Swarm's provider-conformance suites — asserting the shape shared code reads, not behaviour:

- unique platform id; every required interface method present;
- **no method is a stub** — a registered-but-unbuilt backend answers `not implemented yet`, which is a function of the right shape and passes every other assertion, so the suite reads each method's own source for that sentinel;
- every capability the manifest declares is one the backend actually dispatches on — a declared-but-unanswered capability otherwise surfaces as a runtime failure at the worst moment, in front of an agent that was told it was available;
- **a declared opt-out is not a stub.** A backend that honestly reports `canReadScreen: false` is complete, not unfinished. The suite asserts the flag is a boolean and the method carries no sentinel; it does not demand every capability be present.

**A backend under construction registers nothing.** Build it phase by phase with tests constructing the class directly, and land its `index.ts` in the phase that removes the last stub. Registering a stub-bearing manifest early fails this suite and forces an exemption that disables the gate for the backend already passing it.

## What the automated tests cannot cover

Worth stating so nobody reads a green suite as more than it is. Whether a tap landed on the intended button, whether a screenshot shows the right screen, whether a wait condition matches what a human means by "the list has loaded" — none of that is reachable from a mocked `adb`. Device tests reach some of it; the rest is why Rover exists rather than being the thing Rover verifies.

## Type-checking (tests included)

`tsc` runs against **both `src/` and `tests/`** — `npm run typecheck` and the pre-commit hook point at `tsconfig.typecheck.json`, which extends the base config with `noEmit` and widens `include` to the test tree. The base `tsconfig.json` stays `src`-only because it doubles as the build config.

Type your `vi.fn()` mocks with their real call signature rather than a bare `vi.fn(async () => …)` — an untyped mock infers a zero-argument signature, so `mock.calls[0][0]` indexes an empty tuple and fails to typecheck.

## Git hooks (Lefthook)

`lefthook.yml`, installed via the npm `prepare` script:

- **pre-commit** (parallel): Biome lint+format on staged files (auto-fix and re-stage), `tsc --noEmit -p tsconfig.typecheck.json`.
- **pre-push**: the unit suite. Device tests are not in the push gate — they need hardware and would fail a push from a machine with nothing attached.
- **commit-msg**: conventional-commit format via commitlint.

The same unit gate runs again on every pull request — `.github/workflows/verify.yml` calls `npm run verify` on a runner, so a hook someone skipped locally still gets caught. Device tests stay out of it for the same reason they stay out of the push gate: no runner has hardware.

## What "done" means for a change

Lint, typecheck and the unit suite actually run — not assumed. If a change touches a backend, it is not done until it has been exercised **against a real device**, and if that was not possible, the change says so plainly. Silence reads as "checked", and in this repo that has a specific cost: an untested adb recipe looks exactly like a tested one right up to the moment it runs on someone's device.
