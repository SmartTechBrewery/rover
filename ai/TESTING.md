# Testing & git hooks

Same tooling as Swarm — copy its config rather than picking a different stack.

Note the double meaning of "test" in this repo and keep it straight: Rover *performs* manual verification on devices, and Rover *is* a Node.js program with its own automated tests. This document is about the second one.

## Test runner

**Vitest**, not Jest. Split into two projects:

- **Unit tests** (`tests/unit/**/*.test.ts`) — mock every external call: `adb`, `simctl`, the filesystem, the socket. No real device, no real daemon. `vi.mock()` at the top of the file, before imports.
- **Device tests** (`tests/device/**/*.test.ts`) — run against a **real attached device**, serially. They gate on `describe.skipIf(!process.env.ROVER_TEST_DEVICE)`, set by `tests/device/setup.ts` when it finds a usable device, so a machine with nothing attached **skips rather than fails**. Same pattern as Swarm's database gate.

Device tests take a lease like any other client. A device test that talks to `adb` directly, outside the lease, will eventually run on a device another agent is using, and that is precisely the failure this whole project exists to prevent.

## Fixtures come off a real device

Every parser is tested against output **captured from a real device**, stored under `tests/fixtures/` with the API level and model in the filename. Hand-written fixtures encode what you believe the tool prints, so the parser passes and production fails on the difference — which is the exact shape of the bug this rule prevents.

Re-capture rather than hand-edit when a format changes, and add the new fixture beside the old one instead of replacing it: a parser has to keep working on the API levels already in use.

## Test data

Factory functions (`createMockDevice()`, `createMockLease()`, `createMockCapabilities()`) returning sensible defaults and accepting `Partial<T>` overrides, mirroring Swarm's `tests/helpers/factories.ts`. Don't hand-construct the same fixture inline in every file.

## Backend conformance

`tests/unit/backends/conformance.test.ts` — one suite run per **registered** backend manifest, driven by `listDeviceBackends()` rather than a hand-kept list, mirroring Swarm's provider-conformance suites. It asserts the shape shared code reads, not behaviour:

- unique platform id; every required interface method present; every capability flag a boolean;
- every capability the manifest declares is one the backend actually dispatches on — a declared-but-unanswered capability otherwise surfaces as a runtime failure at the worst moment, in front of an agent that was told it was available;
- **no method is a stub** — a registered-but-unbuilt backend answers `not implemented yet`, which is a function of the right shape and passes every other assertion, so the suite reads each method's own source for that sentinel;
- **and no method is a *silent* stub** — the same source scan rejects a body that does nothing or returns a bare empty value (`[]`, `{}`, `null`, empty bytes), which is the plausible-looking empty result ai/RULES.md §2 forbids and the one a sentinel scan alone never sees. It reads only the method's own body, so it is a floor rather than a proof;
- **a declared opt-out is not a stub.** A backend that honestly reports `canReadScreen: false` is complete, not unfinished. The suite asserts the flag is a boolean and that any method present carries no sentinel; it does not demand every capability be present.

The checks themselves live in `tests/helpers/backend-conformance.ts` and return violation strings rather than asserting, because the gate **ships before the first backend** (PROJECT.md §9.3, R3 ahead of R5) and its loop over the registry therefore has nothing to run over yet. `tests/unit/backends/conformance-harness.test.ts` runs them against synthetic backends — one deliberate violation per rule — so the gate is proved rather than vacuously green. Build a fixture for it with `createConformingDeviceBackend()`: a `vi.fn()` stringifies to the runner's wrapper, so a mock-built backend is invisible to every scan (and is reported as unreadable for exactly that reason).

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
