# Coding standards

Rover's stack and style are copied from **Swarm** (`../swarm`), which copied them from Cascade, on purpose: the patterns proved out on a real Node.js codebase and reinventing them here buys nothing. When in doubt, read the equivalent file in `../swarm/src` and match its shape.

## Language & tooling

- **TypeScript, strict, ESM-only.** `strict: true`, plus `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`. Node 22+. `"type": "module"` — `import`/`export` only, no `require`. Relative imports use explicit `.js` extensions (even though the source is `.ts`) because that is what Node's ESM resolver needs at runtime.
- **Path alias**: `@/*` → `./src/*`. Prefer it over long `../../../` chains.
- **Biome**, not ESLint/Prettier, for both lint and format. One tool, one config (`biome.json`), one command (`npm run lint:fix`). House style: tabs (width 2), 100-char lines, single quotes, semicolons always, trailing commas in multiline structures, imports auto-sorted.
- **Vitest**, not Jest — see `ai/TESTING.md`.
- **Lefthook** for git hooks — see `ai/TESTING.md`.

## Zod is the source of truth for shapes that cross a boundary

Rover has four boundaries and every one of them gets a Zod schema, with the TypeScript type as `z.infer<typeof schema>` — never a hand-written `interface` duplicating what the schema already says:

1. **MCP tool inputs and outputs.** The schema *is* the tool declaration the agent reads; a hand-written duplicate drifts and the agent is the one who finds out.
2. **Daemon IPC.** Two processes, so every message is parsed, never cast.
3. **Project configuration** (the hooks of D13).
4. **Backend capability manifests.**

## Parsing external tool output

`adb`, `simctl` and friends are external programs with unstable output, and this is where the sloppiest code in this class of tool lives.

- **Parse into a schema, never regex into an inline object.** `adb devices -l` and a hierarchy dump both get a parser module with its own tests and its own fixture files captured from a real device.
- **Never parse a serial to infer anything.** `emulator-5554` looks structured and a physical device's serial is an arbitrary string. Platform, model and density come from queries, never from the shape of an identifier.
- **A non-zero exit is data, not just an error.** Capture stdout, stderr and the exit code together and surface all three; `adb` reports meaningful failures on stdout with exit 0 more often than is comfortable.
- **Every external invocation has a timeout.** A hung `adb` call with no timeout wedges a lease until it expires.

## Error handling

- **Throw for programmer and validation errors** (`throw new Error(...)`) — no `Result<T, E>` wrapper type. This codebase's convention is exceptions; mixing both makes call sites unpredictable.
- **Return `null`/`undefined` for "not found" or "not applicable"** — no free device matching a request, no element with that text. Reserve `throw` for a bug or bad input.
- **A missing capability is its own error type**, distinguishable from a device error and from a bug. It names the capability, the device and the backend, because "this is not supported here" and "this broke" call for opposite responses from the agent.
- **A verb that timed out reports what it was waiting for and what was on screen instead.** A bare "timeout" makes the agent guess, and it will guess wrong.
- **Async/await everywhere**, no raw `.then()` chains, no callbacks.

## Naming

- Files: kebab-case (`android-backend.ts`, `lease-store.ts`).
- Classes: PascalCase (`AndroidDeviceBackend`).
- Functions/variables: camelCase. Constants: UPPER_CASE.
- **Branded ID types for identifiers that are easy to confuse** — a device serial, a lease id and an element id are all strings and mixing them up should be a compile error, not a runtime bug. Define them the way Swarm defines its ids.
- **Verbs are named for what the user of the device does**, not for the command underneath: `tap`, not `sendMotionEvent`; `read_screen`, not `uiautomatorDump`. The verb outlives the tool that implements it.

## Module shape for a device backend

Every backend follows the same three-file shape — don't improvise a different structure per platform:

```
src/backends/<platform>/
  capabilities.ts   # Zod manifest — what this backend can do
  backend.ts        # the class implementing the shared device interface
  index.ts          # side-effect-only: registers the manifest with the registry
```

Backends register themselves by being imported from one barrel file. Adding a backend should never require editing shared code — only its own folder plus one import line in the barrel. A branch on platform outside `src/backends/<platform>/` means the abstraction is being bypassed; fix the abstraction.

## Comments

Default to none. Write one only for a non-obvious invariant, a workaround, or a **why** — never a restatement of the next line. Comment density stays low and concentrated on the cross-cutting invariants: why a lease needs re-verification, why a wait cannot be a sleep, why a recipe uses `cmd connectivity` instead of the `svc` call every guide shows.

One local exception, and it is load-bearing: **a workaround for external-tool behaviour records the platform version it was observed on.** `// svc wifi is gone as of API 37` is worth ten lines of anything else, because the next agent's alternative is rediscovering it on a device.
