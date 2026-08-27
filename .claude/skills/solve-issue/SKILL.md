---
name: solve-issue
description: Interactive workflow that implements a GitHub issue for Rover end-to-end in its own git worktree — plan, implement, verify with lint/typecheck/tests and against a real device, then independent subagent review and response, with the Projects board kept in step.
---

# Solve Issue Skill

## Usage

Trigger with `/solve-issue <issue-number>` — e.g. `/solve-issue 6`. Also triggered by asking to
"solve issue 6" / "work issue 6" / "pick up issue 6 from the board".

This runs one issue from spec to open PR: a short written plan, the implementation, verification,
then two independent subagents — one reviewing, one responding to that review. The split matters:
the reviewer must not be the implementer, which is why Steps 6 and 7 are subagents rather than
something you do inline.

Everything happens in a **dedicated git worktree**, not the shared checkout.

**This is the interactive path.** Rover's work is also delegated to Swarm, whose pipeline covers
the same ground with its own phases. Use this skill when a human is driving; don't run it against
an issue Swarm already has in flight.

**Read `ai/RULES.md` first.** It is the single source of truth and overrides anything here that
drifts from it. This skill is a procedure, not a second ruleset.

---

## Step-by-step procedure

### Step 0: Confirm identity and scopes

```bash
gh api user --jq .login                      # expect: jkwiecien
gh api -i user | grep -i '^X-Oauth-Scopes'   # must include: repo, read:org, project
```

If the login is wrong, `gh auth switch --user jkwiecien`. If `project` is missing, re-login
(a plain `gh auth refresh` can leave a stale token in the keyring):

```bash
gh auth login --hostname github.com --git-protocol ssh --scopes "repo,read:org,project"
```

**`gh auth switch` does not affect `git push`.** It moves the API account only; pushes go over SSH
and take their key from `~/.ssh/config`, where plain `github.com` is pinned to the work identity.
The remote must be `git@gh-personal:SmartTechBrewery/rover.git` (`ai/RULES.md` §3) — a worktree
inherits it from the checkout, but check if a push is ever refused as `jacek-solvd`.

### Step 1: Resolve the issue

1. The argument is a bare issue number in `SmartTechBrewery/rover`.
2. Fetch it:
   ```bash
   gh issue view <N> --repo SmartTechBrewery/rover --json number,title,body,state,url,labels
   ```
   If it doesn't exist, stop and tell the user rather than guessing. If it's closed, confirm
   before continuing.
3. Read the title and body in full — that is the spec. Then:
   - **Read `PROJECT.md` before questioning any decision the issue rests on.** Sixteen of them are
     recorded with their reasoning, including the trade-offs that were considered and rejected. If
     the issue genuinely contradicts one, that is a reversal to raise with the user, not to make
     quietly — and it is edited into `PROJECT.md` in place, with its reason rewritten.
   - **Read `ai/ARCHITECTURE.md`** for anything crossing a component boundary, and
     `ai/CODING_STANDARDS.md` for the module shape you are about to add to.
   - **Read the equivalent file in `../swarm/src`** when a shape is underspecified. Rover copies
     Swarm's conventions deliberately (`PROJECT.md` D15); matching them beats inventing.
4. If the issue is underspecified and the intent isn't recoverable from those, stop and ask.

### Step 2: Provision a worktree

1. **Always branch from `origin/main`, never from local `main`.** Local `main` may be behind, and
   branching from stale history is how a PR arrives with a diff nobody asked for.
   ```bash
   git fetch origin
   git worktree add .worktrees/issue-<N>-<kebab-slug> -b <feat|fix|chore>/<kebab-slug> origin/main
   ```
   Do not stack the branch on another issue's branch even when the issue declares a dependency —
   every worktree starts from the latest `origin/main`. If a dependency is genuinely unmerged, say
   so in the PR body and resolve the overlap in this branch rather than changing the base.
2. **Install dependencies in the worktree; do not symlink or share `node_modules`.**
   ```bash
   cd .worktrees/issue-<N>-<slug> && npm ci
   ```
   A shared `node_modules` is the same class of trap as a shared build cache: native bindings and
   `.bin` shims resolve against the tree they were installed in, and lefthook's `prepare` hook
   installs its git hooks into whichever `.git` it saw first. One `npm ci` per worktree costs a
   minute and buys a verification step that means something.
3. Symlink `.env` from the main checkout if the issue's work needs it — it is gitignored, so the
   worktree has none. Use an **absolute** target; a relative `../…` link dangles two levels down:
   ```bash
   ln -sfn "$(pwd)/.env" ".worktrees/issue-<N>-<slug>/.env"
   ```
4. All remaining steps run with CWD set to that worktree. Subagents spawned in Steps 6–7 do
   **not** inherit your shell CWD — give them the absolute worktree path explicitly.

> `.worktrees/` must be gitignored. If it isn't yet, add it in the same commit as your first
> change (`chore` scope).

### Step 3: Move the board card to "In progress"

Invoking this skill *is* the explicit instruction to move the board — but only for the card
belonging to `<N>`. Don't touch anything else.

1. Find the item (item IDs are per-card and must be looked up, never hardcoded):
   ```bash
   gh project item-list 7 --owner SmartTechBrewery --format json --limit 100 \
     | jq -r '.items[] | select(.content.number == <N>) | .id'
   ```
2. If the issue isn't on the board yet, add it — this prints the item ID:
   ```bash
   gh project item-add 7 --owner SmartTechBrewery \
     --url https://github.com/SmartTechBrewery/rover/issues/<N>
   ```
3. Move it:
   ```bash
   gh project item-edit \
     --project-id PVT_kwDODb1Ycc4BhrDR \
     --id <PVTI_item_id> \
     --field-id PVTSSF_lADODb1Ycc4BhrDRzhgl7cM \
     --single-select-option-id 47fc9ee4      # In progress
   ```

### Step 4: Plan

Before writing any code, do a short planning pass and record it on the issue.

1. Write a **concise** plan: the files you expect to add or change, the approach, and what you are
   deliberately leaving out of scope. A handful of bullets, not a design doc. Name the components
   it touches (daemon / core / backend / cli / mcp) so the reviewer can check boundary discipline.
2. Append it to the **issue body** — not a comment — preserving the original spec:
   ```bash
   body=$(gh issue view <N> --repo SmartTechBrewery/rover --json body -q .body)
   printf '%s\n\n## Plan\n\n<your plan markdown>\n' "$body" \
     | gh issue edit <N> --repo SmartTechBrewery/rover --body-file -
   ```
   If the body already carries a `## Plan` from an earlier run, replace it rather than appending
   a second one.
3. A new dependency needs justification, and Context7 consulted first. Rover's runtime surface is
   deliberately small — a package that saves an hour and adds a native build step is a net loss.

### Step 5: Implement (you do this directly — no subagent)

1. Re-read the parts of `ai/RULES.md` and `ai/CODING_STANDARDS.md` your change touches. The ones
   that bite hardest: no platform branch outside a backend folder, Zod at every boundary, no
   sleeps anywhere, targets resolved inside the verb, capabilities declared rather than assumed.
2. Implement fully, inside the worktree. Keep the diff small and reviewable. If you spot unrelated
   follow-up work, file a new issue instead of doing it now.
3. **Parsers get fixtures captured from a real device**, stored under `tests/fixtures/` with the
   API level and model in the filename (`ai/TESTING.md`). A hand-written fixture encodes what you
   believe `adb` prints; the parser then passes and production fails on the difference.
4. Verify:
   ```bash
   npm run lint
   npm run typecheck
   npm run test:unit
   ```
   Fix whatever these surface. Do not hand work to review with a red build.
5. **If the change touches a backend, the daemon, or any adb invocation, exercise it against a
   real device.** Mocked `adb` output proves the parser reads what you told it to read; it proves
   nothing about what the device says.
   ```bash
   adb devices -l                  # is anything attached?
   ROVER_TEST_DEVICE=1 npm run test:device
   ```
   Rover's own leasing is what keeps two agents off one device — **use it rather than reaching for
   `adb` directly**, including here. A device test that bypasses the lease will eventually run on
   a device another agent is holding, which is the exact failure this project exists to prevent.

   If nothing is attached, the device suite skips rather than fails — and then **say in the PR
   body that no device check happened.** Silence reads as "checked", which is worse than a stated
   gap. This matters more here than in most repos: an unverified adb recipe looks exactly like a
   verified one until it runs on somebody's phone.
6. **A new recipe goes into `PROJECT.md` §6 with the API level it was run against**, in the same
   change. That section is only ever written by whoever just spent the hour discovering that the
   documented command no longer exists.
7. Commit with a Conventional Commit message per `ai/RULES.md` §3 — imperative, lowercase subject,
   no trailing period, 100 characters max, a scope naming the component, a body explaining *why*,
   and the AI-assistance footer:
   ```
   feat(daemon): re-verify the device at grant time

   The daemon is a cache and adb is the truth (D6). Trusting the inventory
   hands out a serial that vanished, and the failure surfaces three verbs
   later as an unexplained timeout.

   Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
   ```
8. Push and open the PR:
   ```bash
   git push -u origin <branch>
   gh pr create --repo SmartTechBrewery/rover --title "<issue title>" --body "Closes #<N>

   <summary of the change>"
   ```
   Then move the board card to **In review** (option id `df73e18b`, same `item-edit` call as
   Step 3).

### Step 6: Independent review (subagent)

Spawn a subagent via the Agent tool. Do **not** review the work in this same context — a fresh
reviewer with no attachment to the implementation is the entire point. Give it:

- The absolute worktree path to `cd` into, the issue number `<N>`, the PR number and branch, and
  instructions to read the **full diff** (`gh pr diff <PR> --repo SmartTechBrewery/rover` or
  `git diff origin/main...HEAD` — never local `main`, which Step 2 established may be stale).
- `ai/RULES.md`, `ai/CODING_STANDARDS.md`, `ai/ARCHITECTURE.md` and `ai/TESTING.md` as the
  standard to check against.
- Instructions to look for, in rough order of how much damage each does here:
  - **a `sleep`, or any wait not expressed as a condition with a timeout** — the single rule most
    likely to be broken under time pressure, and the one that makes results non-reproducible;
  - **a coordinate or an element handle carried between calls** instead of resolved inside the
    verb from a fresh capture;
  - **a platform branch outside `src/backends/<platform>/`**, or a verb named after a platform;
  - **a capability assumed rather than declared and checked** — including a method that returns a
    plausible empty result where the honest answer is "this device cannot do that";
  - **a boundary crossed without a Zod schema** — MCP tool shapes, daemon IPC, config, manifests;
  - **an external command parsed by inline regex**, without a fixture captured from a real device;
  - **an external invocation with no timeout**, which wedges a lease until it expires;
  - **anything inferred from the shape of a serial**;
  - **state restoration that only runs on the happy path** — release without expiry (D9);
  - **anything application-specific reaching the core** rather than a project hook (D13);
  - correctness bugs, missed edge cases, and untyped `vi.fn()` mocks.
- Instructions to raise any place where the code and `PROJECT.md`'s decisions **conflict** rather
  than silently picking one.
- Instructions to post findings as a **plain comment** (`gh pr comment`), not a formal review
  (`gh pr review`): this runs under a single `gh` identity, and GitHub refuses to let an author
  approve or request changes on their own PR. Lead with a parseable verdict line:
  ```bash
  gh pr comment <PR> --repo SmartTechBrewery/rover --body "**Review verdict: changes requested** (PR #<PR>)

  <findings>"
  # or, if nothing worth blocking on:
  gh pr comment <PR> --repo SmartTechBrewery/rover --body "**Review verdict: approved** (PR #<PR>)

  <summary>"
  ```

Wait for it to finish and report back exactly what it posted.

### Step 7: Respond to review (a second, separate subagent)

Spawn another subagent — not the same one, and not you — to act as the implementer responding.
Give it:

- The absolute worktree path, the issue number `<N>`, the PR number, and instructions to fetch the
  Step 6 comment and any follow-ups
  (`gh pr view <PR> --repo SmartTechBrewery/rover --json comments`).
- Instructions that for **each** point raised it must either fix the code — then commit and push —
  or, if the comment is mistaken, reply explaining why. Pushing back is a legitimate outcome;
  silently complying with a wrong review is not.
- Instructions to re-run the Step 5 verification after any fix — lint, typecheck, unit tests, and
  the device suite if the fix touched a backend or the daemon — before pushing.
- Instructions to post a point-by-point response as a plain PR comment, saying for each whether it
  fixed the code (with the commit) or pushed back (with rationale).
- Instructions to leave the PR mergeable. This skill does not loop into another review round
  automatically, and does not auto-merge.

### Step 8: Wrap up

1. Report the PR URL, what the reviewer flagged, and how each point was handled — fixed vs. pushed
   back, with rationale. State plainly whether a device check happened.
2. Leave the worktree in place. A further review round may still need it.
3. Leave the PR open for a human to merge. Never merge it yourself.
4. Leave the board card in **In review**. Only a human merging the PR moves it to Done.

### Step 9: Cleanup (only once the user confirms the PR merged)

Don't do this proactively — only after the user says the PR was merged:

```bash
git worktree remove --force .worktrees/issue-<N>-<slug>
git branch -d <branch> 2>/dev/null || true
```

The `Closes #<N>` in the PR body auto-closes the issue on merge, and GitHub's built-in workflow
moves the card to **Done** (option id `98236657`) — verify it landed there rather than setting it
by hand.
