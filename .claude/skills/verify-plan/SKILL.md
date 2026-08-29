---
name: verify-plan
description: Verify a plan for a Rover GitHub issue against the actual current codebase, not just against its own prose. Invoke with an issue number (e.g. "/verify-plan 27" or "/verify-plan #27"). Works against either an automated Swarm Planning-phase comment ("## 🗺️ Proposed implementation plan" / "## 🗺️ Preplan — Phase N of M") or a manually-written "## Plan" section appended to the issue body by `/solve-issue`. Extracts every checkable factual/technical claim the plan makes and dispatches a fork to verify each one by reading the real files — function names, line numbers, existing patterns, what a cited dependency issue actually shipped — then reports per-claim verdicts, an overall safe/needs-correction verdict, and suggested corrections for anything wrong.
---

# Verify Plan

Fact-check a Rover implementation plan: not a design review of whether the approach is a good
idea, but an audit of whether what it says about the codebase is true. A plan can be
well-reasoned and still cite a verb that doesn't exist, a line number that's drifted, a decision
number that says something it doesn't, or a dependency issue's "already shipped" shape that isn't
what actually landed — any of which sends implementation down the wrong path. Catch that before
it does.

Rover's plans live in two places, and this skill handles both:

- **An automated Swarm Planning-phase comment** — opens `## 🗺️ Proposed implementation plan` or,
  for a split-child issue, `## 🗺️ Preplan — Phase N of M`. Confirmed live on this board (issues
  #2, #4, #26 already carry `tb-implementer` plan comments with the same
  `<!-- swarm-planning-delivery:… -->` / `<!-- swarm-preplan-comment:… -->` markers Swarm's own
  repo uses).
- **A manually-written plan** — a `## Plan` section `/solve-issue` appends to the **issue body**
  (Step 4 there), used when a human or agent plans and implements an issue directly instead of
  through the automated pipeline.

These are genuinely different artifacts in different places; treat whichever one exists on the
issue as *the* plan for step 1, and follow the matching branch in step 5 when correcting it.

## Hard guardrails

- **Never change labels or move the board card.** The one thing this skill is allowed to edit is
  the plan itself — a comment (step 5, comment branch) or the `## Plan` section of the issue body
  (step 5, body branch) — and nothing else in either place.
- **Never silently force-update the local repo.** `git pull --ff-only` only; if it can't
  fast-forward, stop and tell the user rather than rebasing/resetting for them.
- **Verify facts, not taste.** This is not a second opinion on the plan's design decisions — only
  on whether its factual claims about the codebase hold up. If the user also wants a design
  review, that's a separate ask.

## 1. Resolve the issue and its plan

1. Strip a leading `#` if present; call the resulting number `<ISSUE>`.
2. Ensure `gh` is acting as `jkwiecien` (`ai/RULES.md` §3):
   ```bash
   gh auth status --active 2>&1 | grep -q 'account jkwiecien$' || gh auth switch --user jkwiecien
   ```
3. Fetch the issue body, its labels, and every comment, oldest to newest:
   ```bash
   gh issue view <ISSUE> --repo SmartTechBrewery/rover --json title,state,labels,body \
     -q '{title,state,labels:[.labels[].name],body}'
   gh issue view <ISSUE> --repo SmartTechBrewery/rover --json comments -q '.comments[].body'
   ```
4. Locate the plan, checking both places:
   - **Comment-based**: a comment opening with `## 🗺️ Proposed implementation plan`, or for a
     split-child issue `## 🗺️ Preplan — Phase N of M`.
   - **Body-based**: a `## Plan` heading inside the issue body, appended after the original spec
     (`/solve-issue` Step 4's convention — it replaces rather than duplicates this section on a
     re-run, so there is at most one).
   - If both exist, verify the comment-based plan — it is the one an automated Implementation run
     actually reads, and the body-based one is either stale or was never the operative plan for
     this issue.
   - If **neither** exists, stop and report plainly: for the comment case, check the `planned`
     label and whether the board's `Status` field is `Planning` (`gh project item-list 7 --owner
     SmartTechBrewery --format json --limit 100 | jq '.items[] | select(.content.number==<ISSUE>)
     | .status'`); for the body case, tell the user to run `/solve-issue <ISSUE>` through its Plan
     step first. Do not invent a plan to verify.
5. If the issue is a split child (the `swarm:split-child` label, a `## 🗺️ Preplan — Phase N of M`
   heading, or the plan text says "split from a larger task"), note its stated parent/sibling
   phases and carry their issue numbers into step 2.2 below — a plan that assumes an earlier phase
   "must land first" needs that phase checked for real, not assumed from its own text.

## 2. Get the ground truth to verify against

1. **Fetch and fast-forward local `main` before reading anything.** Rover runs the same Swarm
   pipeline as any other `swarm`-labeled repo on this board — the `tb-implementer` plan comments
   already on this board are the proof — so `main` can move between sessions the same way
   `ai/RULES.md` §6 already warns about for device behavior: never verify against a memory of the
   tree, only against what is actually there.
   ```bash
   git fetch origin main
   git pull --ff-only origin main
   ```
   If that can't fast-forward cleanly, stop and tell the user their local `main` has diverged and
   ask how to proceed — never force, rebase, or reset it for them.
2. For every dependency the plan names as "must land first," "already merged," or "row N already
   gives us X": check its **real** current state, not its own plan text — `gh issue view <dep>
   --repo SmartTechBrewery/rover --json state,stateReason`, and if closed, find its merging PR
   (`gh pr list --repo SmartTechBrewery/rover --search "<dep> in:body" --state merged --json
   number,title,mergedAt`) and skim what actually shipped. An implementation can drift from its
   own plan during review, so "what row N delivered" must be checked against shipped code, not
   row N's plan.
3. Reuse anything this conversation already established this session — a file you already read, a
   function you already confirmed exists — instead of re-deriving it. Cite it in the report rather
   than re-checking it, and tell the fork (step 4) the same so it doesn't burn tool calls
   re-confirming what's already known.

## 3. Extract every checkable claim

Read the plan in full and pull out every claim that names something concrete and falsifiable: a
file path, a line number, a function/type/class name, an existing pattern or precedent it says to
mirror, a decision it cites by number (`PROJECT.md` D1–D25 and counting — check the number says
what the plan claims it says, not just that the number exists), a quoted line from `PROJECT.md` or
`ai/ARCHITECTURE.md`, a described current behavior of another module, or a fact about what a
dependency shipped. Don't skip claims that look "obviously true" — real errors surface in exactly
those as often as in the intricate ones.

Also note anything stated as a design decision with a reason ("no fallback chain, because…") — not
a line-number fact, but still worth having the fork check whether the stated reasoning matches the
code and the decision it's reasoning about.

## 4. Dispatch verification to a fork

Spawn one `Agent` call with `subagent_type: "fork"`, carrying the full claim list, each phrased as
a concrete, independently-checkable instruction ("read file X, confirm function Y exists with
shape Z, confirm the claimed line number", "read `PROJECT.md` D<N>, confirm it says what the plan
claims"). Point it at `ai/ARCHITECTURE.md` and `ai/CODING_STANDARDS.md` as the other ground-truth
docs for anything about component boundaries, the device-backend module shape, or naming — Rover
has no ADRs; these two plus `PROJECT.md`'s decision table are the whole authority. This keeps the
file-reading — often extensive — out of this session's context; only the verdicts come back.

Ask the fork to report, for each claim, one line: `CONFIRMED` / `WRONG` (state the actual fact) /
`PARTIALLY WRONG` / `COULDN'T VERIFY` (state why) — then a short separate list of any additional
real risks, inconsistencies, or gaps noticed while reading that the plan didn't mention (a
platform name leaking outside `src/backends/`, a `sleep` where a condition wait belongs, a
verb that doesn't return post-state — see `ai/RULES.md` §2), and one overall verdict sentence: safe
to implement as-is, or needs a correction first, naming the specific blocking claim(s).

If the plan naturally splits into two independent clusters (e.g. two split-sibling phases being
checked together), dispatch two forks in parallel rather than one large one.

## 5. Report and correct

Relay the verdicts compactly: group `CONFIRMED` claims rather than listing each one at length;
give every `WRONG`/`PARTIALLY WRONG` claim its full detail, since those are the point of the
exercise. For each real correction, **state the suggested fix**, not just "this is wrong" —
whoever reads the plan next needs the actual correction, not only a flag.

End with the overall verdict. Only if corrections were found, ask the user whether to apply them.

**Default to editing the plan in place, not appending a separate corrective comment or a second
`## Plan` section.** A note tacked on after the plan is easy to miss — for a human skimming the
issue, and for an Implementation run that may only ever read the plan itself. A precise inline fix
is safer. Which mechanics apply depends on where the plan lives (step 1):

### Comment-based plan

1. Resolve the plan comment's numeric REST id (the GraphQL `IC_...` id from `--json comments`
   won't work for editing): `gh api repos/SmartTechBrewery/rover/issues/<ISSUE>/comments -q '.[] |
   {id, user: .user.login, created_at}'` — match it by author/timestamp/content against the plan
   you already fetched.
2. Fetch the raw current body: `gh api repos/SmartTechBrewery/rover/issues/comments/<id> -q
   '.body' > /tmp/plan_body.txt`.
3. Make the smallest possible precise text replacement for each correction — fix the actual wrong
   claim inline, don't rewrite surrounding prose.
4. **Preserve any trailing machine-readable marker exactly** — a line like
   `<!-- swarm-planning-delivery:… -->` or `<!-- swarm-preplan-comment:… -->`. Never edit, move, or
   remove it; insert everything new *before* it.
5. Append a short, clearly attributed, visible note before that marker — `**Edit (jkwiecien, via
   /verify-plan):** corrected "<original wrong text>" — <the actual fact and the fix>.` — so the
   correction stays auditable even though it now lives inline rather than in a separate comment.
   Do not silently rewrite history with no trace.
6. PATCH it: build a small JSON file with the full corrected body (`{"body": "..."}`, e.g. via
   Python's `json.dump` to a temp file — untrusted characters in the body make raw shell quoting
   unsafe) and `gh api --method PATCH repos/SmartTechBrewery/rover/issues/comments/<id> --input
   /tmp/plan_patch.json`. **`gh api -f body=@file` does NOT dereference the file — it sets the
   literal string `"@file"` as the body.** Use `--input` with a real JSON file, never `-f`/`-F`
   for this.
7. Verify the patch landed (`gh api .../comments/<id> -q '.body'`, confirm the fix is inline and
   the marker is intact) before reporting success.

### Body-based plan

1. Fetch the current full issue body: `gh issue view <ISSUE> --repo SmartTechBrewery/rover --json
   body -q .body > /tmp/issue_body.txt`.
2. Make the smallest possible precise text replacement inside the `## Plan` section only — never
   touch the original spec sections above it.
3. Append a short, clearly attributed note at the end of the `## Plan` section — `**Edit
   (jkwiecien, via /verify-plan):** corrected "<original wrong text>" — <the actual fact and the
   fix>.` — for the same auditability reason as the comment case.
4. `gh issue edit <ISSUE> --repo SmartTechBrewery/rover --body-file /tmp/issue_body.txt`.
5. Verify the edit landed (`gh issue view <ISSUE> --repo SmartTechBrewery/rover --json body -q
   .body`, confirm the fix is inline and the rest of the body is untouched) before reporting
   success.

Fall back to a separate comment only when editing genuinely isn't safe or possible — the edit is
rejected (permission), the plan's structure is too tangled to fix with a small in-place edit, or
the correction is too large to state as a short attributed note. Say which case applies if you
fall back.
