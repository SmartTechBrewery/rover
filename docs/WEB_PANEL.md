# The Web Panel

A running list of what the web panel needs to do, written down as the idea comes up, so it is not
lost between now and whenever there is room to build each part.

**This file used to open by saying nothing in it was a decision or a backlog row, and that the
panel was read-only.** Both stopped being true on 2026-08-31. The panel is in scope (`PROJECT.md`
§7), it is **not** read-only, and what it may do is **D27**: it carries authority over the shared
device pool — force-releasing a stuck lease is the first such action — and deliberately does *not*
acquire devices, because a lease carries the caller's own `owner` string (D22) and a person
clicking a button has nothing to sign one with.

**Items 3, 6 and 7 are now scheduled**, as `PROJECT.md` §9.3 rows R29–R35, together with the
transport and scaffolding they need. The rest of this list is still what it always was: gathered,
unscheduled, and turned into an issue the same way every §9.3 row is — an outcome, a scope
boundary, dependencies and a size.

Design work lives in [`DESIGN.md`](./DESIGN.md); the brief that produced the first screens is
[`DESIGN_INITIAL_PROMPT.md`](./DESIGN_INITIAL_PROMPT.md).

---

## Functionality gathered so far

1. **Login** — **done** (#110, #112, #119). Which credential it presents, and how a browser holds
   it, are both settled below, and both halves are built: the panel presents an `rover users` token
   once, holds the session id it is given, and signs out in a way that ends the session on the
   host.
2. **Project registration** — modeled on Swarm's own, and **split in two on 2026-09-02**
   (`PROJECT.md` D31). The **read half is done** (R39, #152 for the host; R42, #157 for the
   screen): a `Projects` destination between `Archive` and `System` showing what is registered on
   this host and what each project declares. `list_projects` answers the identifier, `apps`,
   whether there is an `install`, the services by name, whether there is a `teardown`, and for a
   hook file that will not parse **that it will not parse** — with no `env` value and no host path
   on any answer — and the screen draws one card per registration in the host's own order, with a
   registration it cannot read drawn as *that* rather than as a project declaring nothing
   (`docs/DESIGN.md` §10). It still does not poll.
   ***Nothing on it writes* has stopped being true, and this paragraph is rewritten in place rather
   than deleted** (2026-09-09, #273, `ai/RULES.md` §1). It read that the screen's `Delete project`
   control was **wired to nothing** — no handler, no confirmation, no call — so *nothing on it
   writes* was still literally true, the affordance having been settled ahead of the action on
   purpose. Both halves of the delete are built now, so **the panel deletes**: pressing the control
   opens a confirmation, and confirming calls `delete_project`.
   **What the delete is** (`PROJECT.md` D42, R50): the hook file, that project's own subtree of the
   artifact archive and its kept-test entries, in one operator action, refusing while a lease on the
   project is live. It does not wait on D27, because the privilege question is answered by the
   request being **named and bounded** rather than by a role model (D31 as amended). Phase 1 (#271)
   put it on the one method table and on the CLI as `rover delete-project` (D4); phase 2 (#273) put
   it on `PANEL_METHODS` with the confirmation that calls it, exactly as `force_release_device`
   joined that list with the screen that calls it (R35, #122). It is deliberately still **not** an
   MCP tool.
   **What the panel's own half settled** (`docs/DESIGN.md` §10): the confirmation is §7's shape —
   `Cancel` filled and prominent, the destructive control recessive, a `secondary-container` header
   rather than a red one — with one deliberate departure, that it **states what will go in numbers**
   before it fires: the identifier, what the archive holds for this project, and how many of its
   tests are marked `Keep`. Both figures come off reads the panel already had (`measure_archive`,
   #259; `list_kept_tests`, #234), so no host read was added. The four outcomes are said as four in
   one polite live region above the list; a request that reached nothing is not one of them and
   leaves the dialog open. And **the screen re-reads rather than editing what it had** — the list
   after a settled delete is `list_projects`' answer again — while still not polling and still
   offering no refresh control.
   **Editing a registration still waits on the role model** D27 defers — a hook file names programs
   the host spawns, so writing one over the wire is a far larger privilege than force-releasing a
   lease, and today every named user holds every panel privilege. That reason is untouched by the
   delete, which makes the host run strictly *less* and names no program. Registering stays
   `rover init`'s job; R40 is the open question of it doing that against a host it is not running on.
3. **List of devices available in the system** — **done** (#113). Android only for now, whatever the
   host's `adb` reports (`PROJECT.md` §4 `list_devices`): the Devices screen polls `list_devices`
   over the HTTP surface and renders every device the host reports as one card — model, serial,
   platform, OS version — in a grid whose column count follows the width available to the content.
4. **List of jobs run** — global and per project, modeled on Swarm's own.
5. **Access to historical test artifacts** — screenshots, recordings, reports — as a file tree.
   This is exactly what the artifact archive (`PROJECT.md` §10) is shaped to serve directly off
   disk (D24): no index to build, a directory listing is the whole query. **The host half has
   landed** (R36, #130): `list_archive` answers **one directory level** — it takes the components a
   previous answer returned, never a path on the host, and answers that level's entries with what
   one `readdir` plus a `stat` can honestly say. It is a **listing rather than a query**: no
   filter, no search, no sort parameter, no recursion, because the parameter that would make it a
   query is how an index gets built by accident. **Searching is a second method rather than that
   parameter** (R38, #144), and the tree card is what asks it (#146) — see the end of this entry. Empty, missing and unreadable are three
   distinguishable answers, so the screen can render "nothing is filed here" differently from "this
   host cannot say what is filed here" — the same distinction §7's `stale` draws. It is on
   `PANEL_METHODS` and on the CLI (`rover archive [<component> ...]`), so the archive is debuggable
   without a browser (D4). **Reading an artifact's bytes landed next** (R37, #131): `GET
   /artifact/<component>/…` serves one file per request, addressed by the same components the
   listing answered with, behind the same per-request gate, with a content type from the extension
   so a browser renders a PNG, plays an MP4 and shows a `.txt` as text. A missing file and an
   unreadable one are distinguishable and neither is a success with empty bytes; nothing that
   resolves outside the archive root is served; and one `bytes=` range is answered, which is what
   makes a `<video>` play in Safari at all. **The browsing half is now built too** (#132): the
   Archive screen is a file explorer over the archive — a tree that expands one `readdir` at a time
   beside the contents of whatever is selected, at three levels (a project, a test name, a run),
   with the run's serial read off the level above as `onlyChild` rather than as a level of its own.
   The path is in the URL, so a reload lands where you were and a link is shareable. Its three
   states with nothing to browse are settled in `docs/DESIGN.md` §9, including the one that matters:
   *the archive cannot be read* never renders as *the archive is empty*. **A selected run also names
   the device it ran on** (#136): the `DEVICE — FROM device_info.json` card is the panel's first
   read of a file's *contents* rather than a listing, off #131's byte route, and every value on it —
   model, platform, OS version, API level, screen size and density — comes out of that run's own
   file. A fact the file does not carry is named as `unknown`, `platform` is printed verbatim so it
   reads `android` and never `Android`, and a file that is missing and one that cannot be read are
   two different sentences, neither of them an alarm. **And opening an artifact is built too**
   (#133, its arrangement reversed in place by #160): a file draws the preview **alone** in the one
   card beside the tree, and the tree is there at every depth an open file included — so there is no
   back arrow, nothing gives way to a second column, and **the tree** is how another file is chosen.
   The run's own `CONTENTS` listing, which used to be, is gone with it (#161): a selected run is its
   identity card and its device card, and nothing on either navigates. An image is contained at its natural aspect ratio, a
   recording is a plain video that neither autoplays nor loops, and a text file is printed verbatim
   with a line-number gutter and **no colour on the log level** — `W` and `E` are the device's words
   about its own logs, not a verdict. **Nothing is laid over or around the artifact**: no scanline, no
   tint, no gradient, no frame, no bezel; a hairline border is the most that is permitted, which is
   §5's rule cashed in on the one screen it was written for. The open file is part of the path, so a
   reload lands on it and the link is shareable. The one control is **Open in a new window**, and
   there is still **no download control anywhere in the panel**: this is a view, not a transfer.
   **And the tree is searchable** (R38, #144 the host's method and #146 the panel's field): the
   `DIRECTORY` card carries a field between its header strip and the tree, and typing in it asks the
   host to search the *whole* archive once the text settles — never per keystroke — with every match
   drawn in the tree in place, ancestors expanded and branches holding no match not drawn. It is
   still **no index**: the answer is a bounded walk of the files at request time, and a truncated one
   says so rather than looking complete. The text is component state and deliberately not in the
   URL, so a shared link still lands on the *address*; selecting a hit navigates there and the screen
   carries on exactly as it does when you browse to it. **And the screen has two views** (#165, filled
   in by #181): a text-only `All` / `Testing groups` toggle beside the header badge, where `All` is
   everything above, unchanged, and `Testing groups` is the same archive arranged by the `group_id`
   a lease named (`PROJECT.md` R41) — project, then the group id, then the standard arrangement
   under it: test name, run, and the run's contents to any depth. The host half landed first as
   **`list_archive_groups`** (#178), which answers from one bounded walk which groups exist, which
   runs are in each and which of a grouped run's artifacts carry a label — every run and artifact as
   an address this screen already accepts, so the view composes no path and parses no name. The
   panel half (#181) draws it in the **same tree component, with the same row anatomy and the same
   card beside it**, on addresses of its own — `/groups` and `/groups/$` — so the view is somewhere
   a reload and a shared link land, which is the question #165 deliberately left open. A run that
   named no group is not drawn and neither is a project with none: this view answers *what groups
   exist*, and the `All` view still lists every run. **The label badges completed it** (#182): inside
   one group every distinct filed label takes a **number** — `1`, `2`, `3`, … in the order the host
   answered them — drawn as a small pill beside the artifact's name, with the number carrying the
   meaning and never the colour alone, and the filed label reachable by hover and by
   screen reader. Nothing about a number is stable across groups, an artifact with no label carries
   no badge, and no badge colour may read as an outcome.
   **There is no ceiling and no overflow value, because #206 removed the last one in place**: #182
   shipped four letters plus `@`, #197 reversed the four-letter limit — a conclusion about *colour*
   applied to *letters*, after one real group filing nine labels made five of nine badges read `@` —
   and took the alphabet to `Z`, but twenty-six is a larger arbitrary number rather than a different
   kind of answer, and `@` survived it. An integer has no last value, so `@` is deleted rather than
   moved further out and nothing a group files is left undistinguished. **The palette keeps a ceiling
   of its own, and every cycle is a step off the last** (#200): the four colours are cycled
   family-first so consecutive numbers are always different families, and `5` onwards is the same
   four families modulated a step deeper into each family's own dark step, derived with `color-mix`
   over the tokens — so a later cycle is recognisably the same hue at another level rather than a
   plain repeat, which is what closes the one weak adjacency #197 had to record, the cycle boundary
   at `4`/`5`. Four families over seven steps is twenty-eight fills, and past the twenty-eighth
   the colour **repeats** while the digits distinguish. **The badge draws the bare number** — it is a
   filled pill between the row's glyph and its name and is never zero-padded, which is what keeps it
   from being read as the artifact's own ordinal in its file name; it led with a `#` as a third
   channel under #206 and does not since #269, because those two already separate the two on their
   own. What did not move is that no badge colour may read as an outcome — nor may a number read as
   a rank — and that a
   **new hue** would still be a commissioned categorical ramp rather than a colour picked at the
   keyboard; the derived steps are measured against exactly that by
   `tests/unit/panel/label-badge-palette.test.ts`. `docs/DESIGN.md` §9 records all of it — which of
   *design it* and *settle it here* was chosen and why, both reversals with their reasons rewritten
   in place, and the cost that shapes the preview: an authenticated byte route cannot be an
   `<img src>`, so the panel fetches the bytes with the session header and renders an object URL,
   and the whole artifact is therefore buffered in the tab.
   **And the screen performs one destructive operator action now** (#276, `PROJECT.md` D43, R51
   phase 2): a `Remove` control beside the `Keep` tick on the two cards whose tick is about a test —
   a test name's card in both views and a run's `Run Details` — which takes that test's directory
   with every run filed under it and its kept-test entry, in one call to `delete_archived_test`. It
   **asks first**, in the confirmation shape `docs/DESIGN.md` §7 settled and §10 built for a
   registration — and it is literally the *same component*, because that frame was extracted into
   `panel/src/components/confirm-destructive-dialog.tsx` when this landed rather than described
   twice. The confirmation states what will go in numbers before it fires — the test, how many runs,
   what they take on disk and whether it is marked `Keep` — with **no new host read** beyond the one
   `measure_archive` it makes on opening; opened from a run's card it says in as many words that the
   run on screen goes with the rest. The four outcomes are said as four in one polite live region
   above the content area, so the line **outlives the card it was about**, and a request that reached
   nothing is not one of them: it leaves the dialog open with the control usable again and says
   nothing above the tree. **The screen survives deleting the address it is looking at** — on a
   settled delete the selection moves to the test's parent with `replace` and the level cache
   re-reads, so the breadcrumb and the tree land somewhere that exists; on a `refused` neither
   happens, nothing having been touched. **And since #277 a group's card carries one too** (R51
   phase 3, D43), which closed the phase boundary this item recorded — it read *a group's card
   carries the tick and no `Remove` yet: that is R51's phase 3*, and it has landed.
   `delete_archived_group` takes a project component and the group id a lease named and removes
   **the runs whose group id matches and nothing else**: a test's runs that are in another group or
   in none stay, and a test the deletion empties goes with its `Keep`. It reuses phase 2's control,
   dialog, notice, re-read and navigation whole — what is the group's own is its figures (`RUNS` off
   the grouping answer, read as *at least n runs* whenever that answer was truncated, because the
   two walks are bounded differently and the delete can take more than the listing saw; `ON DISK`
   off `measure_archive_groups`, and **no `KEPT` row**, there being no group-level flag) and its
   words, which say that runs of the same tests outside the group stay. A
   settled outcome re-reads **both** caches, the levels one and the grouping answer this view draws
   its own levels from, and lands the selection on the project; a group whose runs are not listed
   gets no control, which is the rule its tick already keeps.
   ***Still no polling* has stopped being true, and this clause is rewritten in place rather than
   deleted** (2026-09-10, #287 then #288, `ai/RULES.md` §1). It read *still no polling and still no
   refresh control*, on the premise that the archive was finished data — which was false for exactly
   the window a lease is open in: the listings went stale while runs were being filed under the
   reader, and only a browser reload corrected them. So **the levels the screen draws re-read
   themselves every 5 s while a lease is live**, gated off the `list_devices` poll the page already
   runs, and nothing at all while no lease is — the idle cost is unchanged. **And the grouping walk
   this view's own arrangement comes out of is re-walked every 30 s** on the same gate (#288,
   amended in place — it read *deliberately not on that clock and #287's phase 2*), only while this
   view is open: six times the listings' interval, because it walks the whole archive rather than
   one directory, and two answers that cost different things cannot share a cadence. So a run filed
   under the group the reader has open appears there without a reload, with the group's and the test
   name's counts following it. Every other read on the screen is still taken once, each for its own
   recorded reason, and there is **still no refresh control**: neither clock has a caller a reader
   can reach. `docs/DESIGN.md` §9 carries the whole of it.
6. **Live lease state** — **done** (#113). A held card carries the `owner`, the `project`, the
   `test_name` and the grant instant, with a countdown to the expiry that ticks once a second and
   **goes back up** when activity renews the lease (`PROJECT.md` D8) — verified against a running
   host, not only in a test. A held/free counter above the grid is derived from the same array the
   cards come from, so it cannot disagree with them — and since #267 from the same **partition**:
   the cards are drawn held, then free, then not ready, and the badge's three numbers are the sizes
   of those very three groups. Held first because held is what this screen is read for.
7. **Force-release a stuck lease** — **done** (#122). Before its TTL naturally runs out, an operator
   action rather than something a client can do to another client's lease. The host method landed
   first (R31, #109): `force_release_device`, keyed on the device serial rather than on the holder's
   lease id, running the same restoration a normal release runs, and recorded against a
   caller-supplied `actor` string. Its authorisation model is `PROJECT.md` **D28** — reaching the
   surface authorises, the `actor` string attributes, and the host derives neither from the other.
   The panel's own affordance is now built: a recessive control on each held card, the settled
   confirmation dialog (`docs/DESIGN.md` §7), and three distinct outcomes plus the request that
   reached nothing. The `actor` it sends is the signed-in user's `identifier`, so the daemon's audit
   line names a person rather than a browser, and `force_release_device` joined `PANEL_METHODS` on
   the HTTP surface with it. It is on the CLI too (`rover force-release <serial> --actor <string>`),
   so the action is debuggable without a browser (D4).
8. **Host user management** — issuing and revoking a named user's access to the host. No longer a
   single shared secret to design around: `PROJECT.md` D25 already replaces `ROVER_HOST_TOKEN` with
   named, revocable per-user credentials (`rover users add/list/revoke/rotate`, R27–R28) precisely
   so a panel has individual accounts to manage instead of one secret everyone shares. Kept separate
   from `owner`, exactly as the daemon already keeps them separate (D20).
9. **Before/after comparison view** — **done** (#199), and **corrected in place**: this item used
   to say *list the two most recent `<lease-id>` folders under one `test_name`*, which predates
   #150. The key is not recency under a test name; it is **`groupId` + `label`**. A lease names a
   group and files an artifact under a label (`PROJECT.md` R41), and `list_archive_groups` answers
   which runs share a group and which of their artifacts share a label — so *these two are the same
   thing at two moments* is a claim the caller made and the host recorded, rather than something
   recency has to stand in for. That is stronger than the original key in both directions: two arms
   of one investigation are ordinarily *sibling test names*
   (`statistics-deliveries_variantA` / `…_variantB`), which the old wording could not pair at all,
   and two unrelated recent runs under one test name are no longer paired just for being recent.
   The load-bearing half of this item survives unchanged and is why it was ever written here: **the
   panel does no work to find the set** — the archive's own shape plus one bounded walk put them
   next to each other, and the card is a pure function over that one answer with no second request.
   **D22 and D24 stand and are not contradicted**: `test_name` is still deliberately not unique, a
   path component is still opaque, and the label is still the archive's own filed string rather than
   the caller's. What is built is the Testing groups view's comparison card
   (`docs/DESIGN.md` §9): one label names it, one pane per artifact filed under that label in that
   group, side by side, oldest run on the left. **Two is the common case and nothing caps it** — a
   group may hold seven runs — and there is no diff, no score and no verdict, because the comparison
   is visual and human-judged (`ai/RULES.md` §1).
10. **Archive disk usage / retention view** — how much space the archive is using, and a manual
    prune action. **Both the exemption and the policy now exist on the host, and neither is on this
    surface.** The exemption is the `Keep` flag (`PROJECT.md` D33, #234): per
    `<project>/<test_name>`, in a file of the host's own outside the artifact tree, read and set over
    `list_kept_tests` and `set_kept_tests` here and from `rover keep`. **A *named* delete is on this
    surface now and the untargeted prune still is not** (2026-09-09, #276):
    `delete_archived_test` joined `PANEL_METHODS` with the `Remove` control beside the `Keep` tick
    (item 5, `PROJECT.md` D43, R51 phase 2), `delete_archived_group` joined it with the same control
    on a group's card (#277, R51 phase 3), and what admits both where `sweep_archive` is refused is
    D42's distinction rather than a softer reading of the same risk — one test or one group by name,
    with the runs and the bytes stated before it fires, against a policy deciding what goes across
    every project on the host. The policy is
    `ROVER_ARTIFACTS_BUDGET_MB` and `ROVER_ARTIFACTS_MAX_AGE_DAYS` with `sweep_archive` behind them
    (D34–D36, #238) — and that row is deliberately **not** on `PANEL_METHODS`: it deletes an
    operator's runs permanently, so a browser is not where it belongs while D27's role model is
    still deferred, and the prune action here waits on that model rather than on the mechanism. **How
    much space the archive is using is answered and drawn** (corrected in place, #259, #260): the
    host measures one scope on request (`measure_archive`, R49) and the System screen's
    `ARCHIVE SETTINGS` card says what the whole archive takes in its own header strip, in the same
    sentence the Archive screen's root badge uses. What is still this item's and still blocked is
    the half that was always the harder one — *`X of Y`*, a percentage, a usage bar: no answer
    carries the archive's **budget**, the number in that field is a draft nobody has saved, and
    `sweep_archive` deliberately carries neither setting (`docs/DESIGN.md` §13). **Nothing is left open on the policy itself**: the budget runs
    after every lease ends and both bounds run at local midnight and at daemon start (`PROJECT.md`
    D37, D38, R48), so *who runs it unattended* — the last open question here — is answered and the
    host needs nobody. Every named user may set the flag, exactly as every named user
    may force-release (D27, D28); tiering stays open below.
11. **MCP config generator** — after registering a project, a ready-to-paste MCP server
    configuration snippet, so a user doesn't hand-write the pointer to their host.

## Explicitly dropped

- **A multi-host aggregation view.** Moot — Rover is single-host by design (`PROJECT.md` D18,
  revised 2026-08-29). Nothing here aggregates across hosts because there is never more than one.

## Settled since this list was written

**The panel's login is an `rover users` credential** — the same one, not a layer on top
(`PROJECT.md` D29, R32, #110). The panel reaches the host over an HTTP surface that is a *third
transport of the same `IpcServer`*, not a panel-only API: one route,
`POST /rpc`, carrying the same envelopes, authenticated by `Authorization: Bearer <token>` against
`~/.rover/users.json` and re-read on **every request**, so `rover users revoke` ends a panel user's
access on their next request rather than at their next login. There is no second secret and no
fallback.

**And a browser holds a session, not that token** (`PROJECT.md` D30, R34, #112) — the layer the
paragraph above used to leave open. `POST /session` takes `{"token": …}`, checks it against the
same store, and answers `{session, identifier, displayName}`; the page presents that session id in
the same `Authorization: Bearer` header afterwards, and never stores the token at all. `GET
/session` is the boot probe, `DELETE /session` ends the session **on the host** — so signing out is
real rather than a `localStorage.removeItem`. Each session is bound to the user's `identifier` and
`tokenHash` and re-checked against the store on every request, so `rover users revoke` — or
`rotate` — ends a live browser session on its very next request, exactly as it ends a token's. No
cookie is set and none is read, so there is no CSRF surface; the daemon restarting signs everyone
out.

**And the Devices screen reads live host data** (#113). It polls `list_devices` — the only method it
calls, and the only one the surface lets it (`PANEL_METHODS`) — and renders four states of one
screen plus one of the whole page: devices attached; nothing attached, which is normal and common
(D21); a stale view over a list, whose lease fields stay exact because `stale` is about the host's
view of the *hardware* and a lease has no view to go stale (D6); a stale view over an **empty** list,
which means *no view* and must never read as *nothing attached* — the state `DESIGN.md` §7 now
settles; and the host being unreachable, which leaves the navigation nothing to reach and so
replaces the whole page. No force-release control, no confirmation and no write of any kind: that is
the second half of R35.

**The browser's own half is built** (#119). The sign-in screen is deliberately **not a route** — the
panel renders it in place of the router while there is no live session — so there is no address a
credential could be attached to. One masked monospace field for the token, a reveal, no host field,
no account creation, no spinner. `panel/src/session/` holds the client, the store and the state
machine; the **session id only** goes into `localStorage`, never the token, and the credential travels
in a header rather than a cookie so no cross-site request can carry it. `Profile` says who you are
signed in as and carries the one **Sign out** control, which reports what it achieved: a `DELETE`
nothing answered ended nothing, so the panel stays signed in and says so rather than announcing a
sign-out the host never performed. The four states nobody had designed — refused, checking, signed
out and access ended — are settled in `DESIGN.md` §8.

## Deliberately not decided here

- **Whether a user's access is all-or-nothing.** R27–R28 (D25) give every user the same bearer
  credential with the same reach — device leases and (once it exists) the archive alike. A
  read-only role, scoped to browsing the archive without ever acquiring a device, is a real
  candidate once the panel actually needs one, but no such tiering exists yet and none is assumed.
  **D28 does not close this**, and it says so itself: force-release is authorised by the reach every
  named user already has, precisely so that the first operator action did not have to invent a tier
  in passing. A read-only tier arriving later restricts that row along with the rest.
- **Implementation.** Framework, hosting, anything about *how* — this file is what the panel needs
  to do, never how it is built.
