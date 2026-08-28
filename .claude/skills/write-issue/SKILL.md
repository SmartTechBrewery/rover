---
name: write-issue
description: Create a well-scoped GitHub issue for SmartTechBrewery/rover from the current conversation or details supplied with the request, then immediately add it to the Rover Kanban Board in Backlog. Use when the user asks to write, file, capture, or create a GitHub issue, including after discussing a bug, improvement, or follow-up.
---

# Write Issue

Create one actionable issue without turning it into an implementation prescription. The issue may
be based on the session's established context; ask only for a material missing detail that cannot
be safely inferred.

`ai/RULES.md` is the single source of truth for this project and overrides anything here that
drifts from it. §5 describes the board this skill writes to.

## 1. Establish the issue

1. Derive the problem, desired outcome, scope, evidence, and acceptance criteria from the
   conversation. If the user supplied issue text directly, treat it as the primary source.
2. **Check `PROJECT.md` §9.3 first** — the backlog in dependency order (row numbers are identities, not positions: R21–R24 sit mid-table). Most planned
   work is already a row there, and a row fixes four things the issue must not renegotiate: the
   outcome, the scope boundary, the dependencies and the size. If the request matches a row, you
   are transferring it, not authoring it: carry the "Outcome" column into the issue verbatim as
   an acceptance criterion, and record the `Depends on` column as native **Blocked by** (§3). Then search for duplicates:
   ```bash
   gh issue list --repo SmartTechBrewery/rover --state all --search "<keywords>" \
     --json number,title,state
   ```
   If an existing issue covers the work, show it to the user instead of filing a duplicate unless
   they explicitly want a separate one.
3. Concise, outcome-oriented title. A body that makes the problem and the success conditions
   clear. Include links, error output, or reproduction steps when known.
4. Do **not** mandate an implementation approach, module layout, or detailed plan unless the user
   stated it as a requirement. Implementation ideas go under a clearly non-binding heading. Do not
   add a `## Plan` section — planning belongs to whoever implements, and both `/solve-issue` and
   Swarm's Planning phase write their own.
5. Pick a type label (§2.2). If it is genuinely ambiguous, ask before creating — every issue needs
   one. Do **not** set the board's `Priority` field: it is a single-select with no options
   defined, so there is nothing valid to assign.

Use this shape when it fits, omitting sections with no useful information:

```markdown
## Problem

...

## Desired outcome

...

## Acceptance criteria

- ...

## Context

...

## Non-binding suggestions

- ...
```

### 1a. Grounding an issue in this project's documents

Rover has no design renders and no visual acceptance criteria — the equivalents are the decision
table and the architecture:

- **Cite the decision by number** when an issue touches something already settled: "per D9,
  restoration runs on expiry as well as release". If the issue *contradicts* a decision, say so
  explicitly and say why — a reversal is a legitimate outcome, a silent contradiction is not. The
  reversal is then edited into `PROJECT.md` in place, with its reason rewritten (`ai/RULES.md` §1).
- **Point at `ai/ARCHITECTURE.md`** for anything crossing a component boundary — which of the
  daemon / core / CLI / MCP owns the change, and whether it moves a responsibility between them.
- **Name the capability** when the work touches a device backend, not just the platform: an issue
  saying "add iOS screenshots" is really "implement the `screenshot` capability in the iOS
  backend, leaving `read_screen` undeclared".

Keep the project's own constraints visible where they bear on the work: no sleeps, no coordinates
carried between calls, no platform branch outside a backend folder, nothing project-specific in
the core (`ai/RULES.md` §2). An issue that quietly implies any of those is a bug in the issue.

### 1b. An adb or simctl recipe in an issue must say where it came from

If the issue proposes a specific command, state whether it was **run** or **read somewhere**, and
on what API level. `svc wifi disable` is in every guide on the internet and does not exist on API
37. An unverified recipe in an issue body becomes a verified one the moment somebody implements
it without checking.

## 2. Create and board the issue

This skill is for an interactive, human-driven session. It writes specs; it does not implement
them and never chains into `/solve-issue`.

1. **Identity and scopes** (`ai/RULES.md` §3):
   ```bash
   gh auth status --active 2>&1 | grep -q 'account jkwiecien$' || gh auth switch --user jkwiecien
   gh api -i user | grep -i '^X-Oauth-Scopes'   # must include: repo, read:org, project
   ```
   If `project` is missing, re-login — a plain `gh auth refresh` can leave a stale token in the
   keyring. `gh auth login` is interactive and cannot be run for the user; ask them to run it
   themselves with a leading `!` in the prompt, then continue:
   ```bash
   gh auth login --hostname github.com --git-protocol ssh --scopes "repo,read:org,project"
   ```

2. Create the issue with its labels. Write the body through `--body-file -` and a heredoc, never
   `--body "…"` — bodies contain backticks and `$`, and shell interpolation will mangle them.

   ```bash
   gh issue create --repo SmartTechBrewery/rover \
     --title "<title>" --label <type> --label <component> --label swarm --body-file - <<'EOF'
   <body>
   EOF
   ```

   **Two label axes, plus the automation opt-in:**

   | Axis | Values |
   |---|---|
   | Type (exactly one, required) | `bug`, `enhancement`, `feature` |
   | Component (zero or more) | `daemon`, `core`, `backend`, `cli`, `mcp`, `docs` |
   | Automation | `swarm` |

   **The `swarm` label is what lets Swarm pick the issue up at all.** It is Swarm's
   `pipeline.automationLabel` — an item without it is skipped at every dispatch, with no worktree
   and no agent. Add it by default, since delegating this repo's work to Swarm is the intent.
   Leave it off only when the user says the issue is theirs to do by hand.

   Create any missing labels first; these are safe to re-run:
   ```bash
   gh label create daemon  --repo SmartTechBrewery/rover --color 1D76DB --description "Device inventory, leases, restoration" --force
   gh label create core    --repo SmartTechBrewery/rover --color 0E8A16 --description "Device interface and the verb layer" --force
   gh label create backend --repo SmartTechBrewery/rover --color 5319E7 --description "A platform backend (android, ios)" --force
   gh label create cli     --repo SmartTechBrewery/rover --color FBCA04 --description "Command-line entry point" --force
   gh label create mcp     --repo SmartTechBrewery/rover --color A2EEEF --description "MCP server and tool declarations" --force
   gh label create docs    --repo SmartTechBrewery/rover --color BFD4F2 --description "PROJECT.md, ai/*.md, README" --force
   gh label create swarm   --repo SmartTechBrewery/rover --color 000000 --description "Swarm automation opt-in" --force
   ```

3. Immediately add it to the live board — owner `SmartTechBrewery`, project number `7` ("Rover
   Kanban Board") — and set Status to **Backlog**. Do not defer either step.

   ```bash
   gh project item-add 7 --owner SmartTechBrewery \
     --url https://github.com/SmartTechBrewery/rover/issues/<N>     # prints the PVTI_ item ID
   gh project item-edit --project-id PVT_kwDODb1Ycc4BhrDR --id <PVTI_item_id> \
     --field-id PVTSSF_lADODb1Ycc4BhrDRzhgl7cM --single-select-option-id f75ad846
   ```

   Item IDs are per-card — look them up at the time of use, never hardcode one. The field and
   option IDs are in `ai/RULES.md` §5; re-derive them rather than trusting a stale copy if a call
   fails: `gh project field-list 7 --owner SmartTechBrewery --format json`.

4. When the conversation gives a half-day estimate, set `Size` and `Estimate`:

   | Estimate | Size | Option ID |
   |---|---|---|
   | `0.5d` | XS | `6c6483d2` |
   | `1d` | S | `f784b110` |
   | `1.5d` | M | `7515a9f1` |
   | `2d` | L | `817d0097` |
   | `> 2d` | XL | `db339eb2` |

   ```bash
   gh project item-edit --project-id PVT_kwDODb1Ycc4BhrDR --id <PVTI_item_id> \
     --field-id PVTSSF_lADODb1Ycc4BhrDRzhgl7fY --single-select-option-id <size option id>
   gh project item-edit --project-id PVT_kwDODb1Ycc4BhrDR --id <PVTI_item_id> \
     --field-id PVTF_lADODb1Ycc4BhrDRzhgl7fc --number <half-days, e.g. 1 for 0.5d>
   ```

5. Place the new card in intended execution order in the Backlog column: prerequisites first,
   then independent work by agreed priority. `gh project` cannot reorder, so use GraphQL —
   `afterId` is the item the new card should sit **after**, omitted to move it to the top:

   ```bash
   gh api graphql -f query='
     mutation($project:ID!, $item:ID!, $after:ID) {
       updateProjectV2ItemPosition(input:{projectId:$project, itemId:$item, afterId:$after}) {
         clientMutationId
       }
     }' -f project=PVT_kwDODb1Ycc4BhrDR -f item=<PVTI_item_id> -f after=<PVTI_predecessor_id>
   ```

   Read the current order first with
   `gh project item-list 7 --owner SmartTechBrewery --format json --limit 100` — the array comes
   back in board order.

## 3. Record dependencies

Rover is being built in layers, so most early issues have real prerequisites — the verb layer
cannot be built before the device interface, and no backend can be registered before the
conformance suite exists to gate it.

1. Identify prerequisites from the conversation, the issue body, or known board work.
2. For each, record GitHub's native **Blocked by** relationship on the dependent issue, in
   addition to any prose. Do not substitute a checklist. `gh` has no subcommand for this; the REST
   endpoint takes the blocking issue's **node ID**, not its number:

   ```bash
   blocker_id=$(gh api repos/SmartTechBrewery/rover/issues/<blocking-N> --jq .id)
   gh api repos/SmartTechBrewery/rover/issues/<dependent-N>/dependencies/blocked_by \
     -X POST -F issue_id="$blocker_id"
   ```

   Verify with
   `gh api repos/SmartTechBrewery/rover/issues/<dependent-N>/dependencies/blocked_by --jq '.[].number'`.
   If the endpoint is unavailable for this repository, say so in your report and fall back to
   prose plus `depends on: #N` in the body — don't silently drop the dependency.
3. If the new issue is a prerequisite for existing board issues, review those and add their
   **Blocked by** relationships too.
4. Recheck board ordering after any dependency change, so prerequisites stay ahead of what they
   block.

## 4. Report

Return the issue URL and number, its labels (including whether `swarm` was applied), its
Backlog status on the board, any `Size`/`Estimate` set, its placement rationale, and every
dependency recorded. State non-binding suggestions separately from requirements.

Then stop. Do not create a branch or worktree, do not begin implementing, and do not invoke
`/solve-issue` — filing a spec and building it are separate decisions, and the human takes the
second one.
