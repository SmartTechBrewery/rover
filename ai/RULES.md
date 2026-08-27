# Rover — Agent Rules

System prompt and working conventions for AI agents in this repository — the **single source of truth**. Read this in full before writing code. `CLAUDE.md`, `AGENTS.md` and `GEMINI.md` at the repo root simply point here.

---

## 1. What this project is

**Rover** gives a coding agent hands and eyes on a real mobile device, and shares those devices between agents working in parallel. It is a **daemon** (one per machine — owns devices, grants leases, restores state), a **core library** (the device abstraction and the verbs), a **CLI**, and an **MCP server** (one per agent — exposes the verbs). Android over `adb` is what is built; iOS is a seam, not an implementation (§2).

It is **not** a test framework. Nothing asserts, nothing goes red on its own, nothing is a CI gate. Rover moves the device and reports what is on it; judging whether that is correct is the agent's job.

**Read `PROJECT.md` before writing code.** It carries the fourteen decisions this design rests on, with the reasoning behind each, plus adb recipes verified against a real device. When a rule here is underspecified, the decision table there is the tie-breaker.

**Keep `PROJECT.md` and `README.md` current.** If a change makes either inaccurate — a renamed verb, a changed lease rule, a decision reversed — update it in the same change. A reversed decision is edited **in place with its reason rewritten**, not deleted: the record of what was considered and rejected is most of that document's value.

### Rover is modelled on Swarm

The stack, the file layout and the conventions here are copied from **Swarm** (`../swarm`) on purpose, the same way Swarm copied Cascade: the patterns already proved out on a real Node.js codebase, and reinventing them here buys nothing. When a shape is underspecified, go read the equivalent file in `../swarm` and match it.

What transfers: the TypeScript/ESM/Biome/Vitest/Lefthook stack, Zod-as-source-of-truth, the registry-and-manifest module shape (Swarm's *providers* are Rover's *device backends*), the conformance-suite pattern, the comment discipline, the GitHub conventions in §3.

What does not: anything about webhooks, PM boards, worktrees, Postgres or the agent-CLI harness. Rover has no cloud half and no database.

### Rover and Swarm will be integrated

Swarm will eventually surface that a run is using a Rover device — which device, held how long, by which phase. Nothing needs building for that yet, but two obligations start now:

- **The daemon's state must be queryable by something that is not an agent.** Whatever answers `list_devices` for the MCP server answers it for Swarm too. Don't build a status path that only exists inside the MCP layer.
- **A lease has to be attributable.** It carries an owner string the way `device-lease.sh` did (`issue-112`, `pr-127-review`). Swarm will put its own run identity there. Never make the owner implicit or derived from a process ID.

---

## 2. Engineering conventions

Read before writing code in the relevant area:

- **`ai/CODING_STANDARDS.md`** — language and tooling, Zod-as-source-of-truth, error handling, naming, the device-backend module shape, comment density.
- **`ai/ARCHITECTURE.md`** — the four components, the lease lifecycle, the device abstraction and where the iOS seam runs.
- **`ai/TESTING.md`** — Vitest conventions, how a test that needs a real device is gated, git hooks, what "done" means.

Keep these current the same way `PROJECT.md` must stay current (§1).

### Device features must stay backend-agnostic

Rover's whole value proposition is one set of verbs across platforms (`PROJECT.md` D10). That survives exactly as long as nobody branches on the platform outside a backend's own folder.

- **No `if (device.platform === 'android')` in shared code.** If you find yourself writing one, the device interface is missing a method or the capability model is being bypassed — fix that instead of adding the branch.
- **No verb named after a platform.** `tap`, not `tap_android`. This was considered and rejected in D10; the reasoning is in `PROJECT.md` and does not need relitigating.
- **A missing ability is a declared capability, not a missing method.** Backends are genuinely asymmetric — iOS has no cheap equivalent of `read_screen`, and a physical Android phone cannot fake a fingerprint. A backend declares what it can do; a verb without backing **fails loudly**, naming the capability and the device. Never degrade silently, and never return a plausible-looking empty result where the honest answer is "this device cannot do that".
- **Adding a backend must not require editing shared code** — only its own folder plus one import line in the barrel.

### The daemon is a cache; adb is the truth

The daemon introduces a failure mode the old lease file did not have: its own stale state (`PROJECT.md` D6). So it holds nothing it cannot re-derive from `adb devices`, and it **re-verifies the device at every lease grant**. A device that vanished mid-lease is a first-class case, not an exception path.

### Never trust a remembered coordinate, and never sleep

Three rules make a verb deterministic (`PROJECT.md` D12), and all three live in the verb, not in the agent's discipline:

1. Targets resolve from a **freshly captured** screen inside the verb. A coordinate passed in from a previous turn is the single most common source of a false green in this class of tool.
2. Waiting is **on a condition, with a timeout**. No `sleep`, anywhere, for any reason. If you are tempted, the condition you actually want is missing from the wait vocabulary — add it.
3. Every action returns the state after itself, so the agent never has to guess whether it landed.

### Restoring state is the daemon's job, not the caller's

The predecessor *asked* callers, in a comment, to restore state before releasing; nobody ever checked, and nobody ever did. The daemon restores on release **and on expiry** (`PROJECT.md` D9). A teardown that only runs on the happy path is not a teardown.

---

## 3. GitHub

- **Always interact with GitHub through the `gh` CLI** (PRs, issues, reviews, merges, releases) — not the web UI or raw API.
- **Contribute as the `jkwiecien` account.** Before any GitHub operation, verify the active account and switch if needed:

  ```bash
  gh auth status --active 2>&1 | grep -q 'account jkwiecien$' || gh auth switch --user jkwiecien
  ```

- **Commit attribution must also be `jkwiecien`** — gh's account only governs the API; GitHub's contribution graph follows the commit *email*. The local override lives in `.git/config` and is not committed:

  ```bash
  git config --local user.name "Jacek Kwiecien"
  git config --local user.email "jacek.kwiecien@gmail.com"
  ```

  If a commit ever resolves to `jkwiecien@solvd.com` (the global default), the local override is missing or was reset — restore it before committing.

- **Repo**: `SmartTechBrewery/rover`. The remote is `git@gh-personal:SmartTechBrewery/rover.git`, **not** `git@github.com:…`.

  `gh auth switch` governs the API only; `git push` goes over SSH and picks its key from `~/.ssh/config`, where plain `github.com` is pinned to the work identity. Pushing through it fails with `Permission to SmartTechBrewery/rover.git denied to jacek-solvd` — an authorization error that looks like a missing repository, on an account you thought you had switched away from. `gh-personal` is the alias carrying the personal key. If a clone or a new remote is ever added with the plain host, rewrite it.
- **Conventional commits**, enforced by commitlint on `commit-msg`. Subject imperative and lowercase, 100 characters max, body explaining *why*.

---

## 4. Project skills → expose to Claude, Antigravity and Codex, but keep local-only

Whenever asked to create a project skill, keep its canonical copy at `.claude/skills/<name>/SKILL.md` — **and** make it visible to Antigravity and Codex through their shared project-scoped path:

```bash
mkdir -p .agents/skills
ln -s ../../.claude/skills/<name> .agents/skills/<name>
```

Do this as part of creating the skill, not as a follow-up. **Skills are not committed** — both directories are gitignored; they are personal tooling, not shared artifacts.

---

## 5. Task board

Not wired up yet. Until it is, the backlog is `PROJECT.md` §9 and GitHub issues on `SmartTechBrewery/rover`. When a Projects board is created, record its ids here the way Swarm's `ai/RULES.md` §5 records its own — board URL, project node id, Status field id and every option id — because looking them up again costs an API round trip every single time.

---

## 6. Workflow expectations

- **Verify before claiming done.** Run lint, typecheck and the relevant tests. If something could not be run — no device attached, no simulator — **say so plainly** rather than implying it passed. Silence reads as "checked", which is worse than a stated gap.
- **Small, reviewable changes over sweeping rewrites.**
- **Verify device behaviour against a device, never against a memory of one.** This repo already has evidence for why: `svc wifi disable` appears in every guide on the internet and does not exist on API 37. Recipes go in `PROJECT.md` §6 **only after being run**, with the API level they were run against.
- **When a verb's semantics are unclear, read `ai/ARCHITECTURE.md` first**, then `PROJECT.md`'s decision table. Do not guess a lease rule or a capability name.
- **A failure mode that bit you goes in `PROJECT.md` §6 or §8 in the same change.** The predecessor's most valuable artifact was its table of traps, every one of which had actually happened. That table is only ever written by whoever just lost the hour.

---

## 7. Configuration

Rover reads configuration from a per-project file (the hooks of `PROJECT.md` D13: install command, helper services, teardown) and from environment variables for host-level settings (lease TTL, socket path, log level).

- **Zod schemas are the source of truth** for every option; the human-facing catalogue mirrors them and must not drift.
- **Keep the catalogue current** — whenever a change adds, removes, renames or re-defaults an option, update its row in the same change.
- **Nothing project-specific may reach the core.** An option that names one application belongs in that project's hook file, never in a default.
