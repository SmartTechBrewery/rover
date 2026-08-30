# Rover — Agent Rules

System prompt and working conventions for AI agents in this repository — the **single source of truth**. Read this in full before writing code. `CLAUDE.md`, `AGENTS.md` and `GEMINI.md` at the repo root simply point here.

---

## 1. What this project is

**Rover** gives a coding agent hands and eyes on a real mobile device, and shares those devices between agents working in parallel — **including agents on other machines**. It is a **daemon** (one per machine with devices, reachable over the network — owns devices, grants leases, restores state, and runs the verbs), a **core library** (the device abstraction and the verbs), a **CLI**, and an **MCP server** (one per agent). The CLI and the MCP server are **clients** of a host, local or remote. Android over `adb` is what is built; iOS is a seam, not an implementation (§2).

It is **not** a test framework. Nothing asserts, nothing goes red on its own, nothing is a CI gate. Rover moves the device and reports what is on it; judging whether that is correct is the agent's job.

**Read `PROJECT.md` before writing code.** It carries the twenty decisions this design rests on, with the reasoning behind each, plus adb recipes verified against a real device. When a rule here is underspecified, the decision table there is the tie-breaker.

**Keep `PROJECT.md` and `README.md` current.** If a change makes either inaccurate — a renamed verb, a changed lease rule, a decision reversed — update it in the same change. A reversed decision is edited **in place with its reason rewritten**, not deleted: the record of what was considered and rejected is most of that document's value.

### Rover is modelled on Swarm

The stack, the file layout and the conventions here are copied from **Swarm** (`../swarm`) on purpose, the same way Swarm copied Cascade: the patterns already proved out on a real Node.js codebase, and reinventing them here buys nothing. When a shape is underspecified, go read the equivalent file in `../swarm` and match it.

What transfers: the TypeScript/ESM/Biome/Vitest/Lefthook stack, Zod-as-source-of-truth, the registry-and-manifest module shape (Swarm's *providers* are Rover's *device backends*), the conformance-suite pattern, the comment discipline, the GitHub conventions in §3.

What does not: anything about webhooks, PM boards, worktrees, Postgres or the agent-CLI harness. Rover has no cloud half and no database.

### Rover and Swarm will be integrated

The two tools point in opposite directions and that is the useful part: Swarm pushes work out to workers on many machines, while Rover stands still and lends devices to whoever connects (`PROJECT.md` D17). A Swarm worker on one machine borrowing a device from a Rover host on another is the shape both sides are being built for.

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

### The host owns the device; the client only asks

Rover lends hardware to agents that are not on the machine holding it (`PROJECT.md` D17), and the
whole arrangement rests on three rules:

- **Only what is physically attached to the host is ever leased** (D18). Never take a device
  reached through `adb connect` into the inventory — it is not this machine's hardware, and
  treating it as if it were is the two-agents-one-device failure wearing a disguise.
- **Verbs run on the host, never in the client** (D19). No `adb` in a CLI or MCP process. Artifacts
  come back as bytes, and any path returned to the agent must exist on the agent's machine.
- **The token authenticates, the owner string attributes** (D20). Never derive a lease owner from
  whoever authenticated, and never let a token reach a log or a report.

### The daemon is a cache; adb is the truth

The daemon introduces a failure mode the old lease file did not have: its own stale state (`PROJECT.md` D6). So it holds nothing it cannot re-derive from `adb devices`, and it **re-verifies the device at every lease grant**. A device that vanished mid-lease is a first-class case, not an exception path.

### Never trust a remembered coordinate, and never sleep

Three rules make a verb deterministic (`PROJECT.md` D12), and all three live in the verb, not in the agent's discipline:

1. Targets resolve from a **freshly captured** screen inside the verb. A coordinate passed in from a previous turn is the single most common source of a false green in this class of tool.
2. Waiting is **on a condition, with a timeout**. No `sleep`, anywhere, for any reason. If you are tempted, the condition you actually want is missing from the wait vocabulary — add it. The vocabulary is `src/core/wait.ts`, the only module allowed to construct a delay, and `tests/unit/no-sleep.test.ts` enforces that over `src/` and `tests/` alike (`ai/TESTING.md`, "The no-sleep gate").
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

Do this as part of creating the skill, not as a follow-up. A skill is not done until the `.agents/skills` symlink exists and the same skill is available to all three agents.

**Skills are committed here — a deliberate departure from Swarm**, where both directories are gitignored as personal tooling. Rover's skills are not personal: they carry the board's field and option ids, the label vocabulary, the review checklist and the worktree rules, and Rover's work is delegated to agents that run in **fresh worktrees and on other machines**. An uncommitted skill is invisible to every one of them, which turns a shared procedure into something only the machine that authored it can follow.

Two obligations follow from committing them:

- **No secrets, ever.** Skills are now public repository content. They may name accounts, hosts and ids; never a token, and never anything that would not survive being read by someone outside the project.
- **A skill that drifts is a bug like any other.** When a change moves a board id, renames a verb, or alters the verification commands, update the skills in the same change — the same rule §1 applies to `PROJECT.md`.

---

## 5. Task board

The backlog lives in **GitHub Projects**: <https://github.com/orgs/SmartTechBrewery/projects/7> — "Rover Kanban Board", owner `SmartTechBrewery` (org-level, so a plain org webhook can deliver `projects_v2_item`), project number `7`, project node id `PVT_kwDODb1Ycc4BhrDR`. Every task is a GitHub issue in `SmartTechBrewery/rover`.

- **Status field** `PVTSSF_lADODb1Ycc4BhrDRzhgl7cM` — `Backlog` (`f75ad846`), `Ready` (`61e4505c`), `In progress` (`47fc9ee4`), `In review` (`df73e18b`), `Done` (`98236657`).
- **Size field** `PVTSSF_lADODb1Ycc4BhrDRzhgl7fY` — XS `6c6483d2`, S `f784b110`, M `7515a9f1`, L `817d0097`, XL `db339eb2`. **Estimate** (number, half-days) `PVTF_lADODb1Ycc4BhrDRzhgl7fc`.
- **`Priority` has no options defined** — it is a single-select with an empty option list, so there is nothing valid to assign. Leave it alone until someone defines the vocabulary.
- **There is no `Planning` column.** Swarm's own board has one and its config maps a `planning` status; onboarding Rover into Swarm will mean either adding the column here or configuring that phase away. Decide it then — don't add a column nobody uses in the meantime.

**Every newly created issue carries the `swarm` label and goes on the board immediately with Status `Backlog`.** The label is Swarm's `pipeline.automationLabel`: an item without it is skipped at **every** dispatch — no worktree, no agent, zero tokens. It is an automation opt-in and grants no access to anything; removing it is the supported way to take an item off automation. Leave it off only when the user says the issue is theirs to do by hand.

Also give every issue a type label (`bug`, `enhancement`, `feature`) and, where it helps, a component label (`daemon`, `core`, `backend`, `cli`, `mcp`, `docs`).

**Record dependencies natively.** Rover is built in layers — the verb layer cannot precede the device interface, and no backend registers before the conformance suite exists to gate it. Use GitHub's **Blocked by** relationship, not prose, and keep the Backlog column ordered so prerequisites sit ahead of what they block.

Move a card's Status as work progresses: **In progress** when implementation starts, **In review** when a PR is open, **Done** only on merge. Interact through `gh` as the account in §3. The `/write-issue` and `/solve-issue` skills automate all of the above and carry the same ids.

---

## 6. Workflow expectations

- **Verify before claiming done.** Run lint, typecheck and the relevant tests. If something could not be run — no device attached, no simulator — **say so plainly** rather than implying it passed. Silence reads as "checked", which is worse than a stated gap.
- **Small, reviewable changes over sweeping rewrites.**
- **Verify device behaviour against a device, never against a memory of one.** This repo already has evidence for why: `svc wifi disable` appears in every guide on the internet and does not exist on API 37. Recipes go in `PROJECT.md` §6 **only after being run**, with the API level they were run against.
- **When a verb's semantics are unclear, read `ai/ARCHITECTURE.md` first**, then `PROJECT.md`'s decision table. Do not guess a lease rule or a capability name.
- **A failure mode that bit you goes in `PROJECT.md` §6 or §8 in the same change.** The predecessor's most valuable artifact was its table of traps, every one of which had actually happened. That table is only ever written by whoever just lost the hour.

---

## 7. Configuration

Rover reads configuration from a per-project file (the hooks of `PROJECT.md` D13: install command, helper services, teardown) and from environment variables for host-level settings (lease TTL, socket path, log level). That file is `<project>.json` under `ROVER_PROJECTS_PATH` (`~/.rover/projects` by default), on the **host** — `src/daemon/project-hooks.ts` is its schema and its reader. It carries `project`, `apps`, `install` and `teardown` today; helper services are still to come, and each field lands with its consumer. A **client** may be pointed at one such file by `ROVER_PROJECT_FILE` and reads a single field out of it — the `project` that then defaults `acquire`'s attribution string (D22); it reads nothing else and runs nothing a file declares.

- **Zod schemas are the source of truth** for every option; the human-facing catalogue mirrors them and must not drift.
- **Keep the catalogue current** — whenever a change adds, removes, renames or re-defaults an option, update its row in the same change.
- **Nothing project-specific may reach the core.** An option that names one application belongs in that project's hook file, never in a default.
