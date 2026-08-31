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

1. **Login** — modeled on Swarm's own. Which credential it presents is now settled (below).
2. **Project registration** — modeled on Swarm's own.
3. **List of devices available in the system** — Android only for now, whatever the host's `adb`
   reports (`PROJECT.md` §4 `list_devices`).
4. **List of jobs run** — global and per project, modeled on Swarm's own.
5. **Access to historical test artifacts** — screenshots, recordings, reports — as a searchable
   file tree. This is exactly what the artifact archive (`PROJECT.md` §10) is shaped to serve
   directly off disk (D24): no index to build, a directory listing is the whole query.
6. **Live lease state** — which device is held, by which `owner` / `project` / `test_name`, and how
   long until the lease expires on its own (`PROJECT.md` D8).
7. **Force-release a stuck lease** — before its TTL naturally runs out, an operator action rather
   than something a client can do to another client's lease.
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
(`PROJECT.md` D28, R32, #110). The panel reaches the host over an HTTP surface that is a *third
transport of the same `IpcServer`*, not a panel-only API: one route,
`POST /rpc`, carrying the same envelopes, authenticated by `Authorization: Bearer <token>` against
`~/.rover/users.json` and re-read on **every request**, so `rover users revoke` ends a panel user's
access on their next request rather than at their next login. There is no second secret and no
fallback. What is still open is one layer above it — how a *browser* holds that credential between
reloads — and that is R34's (#112), which inherits the answer rather than reopening it.

## Deliberately not decided here

- **Whether a user's access is all-or-nothing.** R27–R28 (D25) give every user the same bearer
  credential with the same reach — device leases and (once it exists) the archive alike. A
  read-only role, scoped to browsing the archive without ever acquiring a device, is a real
  candidate once the panel actually needs one, but no such tiering exists yet and none is assumed.
- **Implementation.** Framework, hosting, anything about *how* — this file is what the panel needs
  to do, never how it is built.
