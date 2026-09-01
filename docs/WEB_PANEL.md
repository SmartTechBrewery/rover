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
2. **Project registration** — modeled on Swarm's own.
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
   query is how an index gets built by accident. Empty, missing and unreadable are three
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
   (#133): a file chosen from a run's `CONTENTS` replaces the directory tree with a preview beside the
   run's own column, so the artifact is read where it was found — two equal halves, one back arrow
   that brings the tree back, and the folder being browsed expanded to its file names because
   `CONTENTS` is now how another file is chosen. An image is contained at its natural aspect ratio, a
   recording is a plain video that neither autoplays nor loops, and a text file is printed verbatim
   with a line-number gutter and **no colour on the log level** — `W` and `E` are the device's words
   about its own logs, not a verdict. **Nothing is laid over or around the artifact**: no scanline, no
   tint, no gradient, no frame, no bezel; a hairline border is the most that is permitted, which is
   §5's rule cashed in on the one screen it was written for. The open file is part of the path, so a
   reload lands on it and the link is shareable. The one control is **Open in a new window**, and
   there is still **no download control anywhere in the panel**: this is a view, not a transfer.
   `docs/DESIGN.md` §9 records what it settled, including the cost that shapes it — an authenticated
   byte route cannot be an `<img src>`, so the panel fetches the bytes with the session header and
   renders an object URL, and the whole artifact is therefore buffered in the tab.
6. **Live lease state** — **done** (#113). A held card carries the `owner`, the `project`, the
   `test_name` and the grant instant, with a countdown to the expiry that ticks once a second and
   **goes back up** when activity renews the lease (`PROJECT.md` D8) — verified against a running
   host, not only in a test. A held/free counter above the grid is derived from the same array the
   cards come from, so it cannot disagree with them.
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
9. **Before/after diff view** — list the two most recent `<lease-id>` folders under one
   `test_name` and show them side by side. This is the reason `test_name` is deliberately not
   unique (`PROJECT.md` D22) — the panel does no work to find the pair, the archive's shape already
   puts them next to each other.
10. **Archive disk usage / retention view** — how much space the archive is using, and, once a
    retention policy exists (`PROJECT.md` §9.4 — still undecided), a manual prune action.
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
