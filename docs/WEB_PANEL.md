# The Web Panel — Future

A running list of what a future read-only web panel needs to do, written down as the idea comes
up, so it is not lost between now and whenever there is room to build it.

**Nothing in this file is a decision or a backlog row.** `PROJECT.md` §9.4 explains why: CLI and
MCP are the whole interface for now (§7), and this panel is not scheduled, not sized, and has no
issue filed. What *is* a decision is that the daemon and the artifact archive are shaped so this
panel can be added later without a redesign (`PROJECT.md` D24, §10) — that shape is what makes
this list worth keeping instead of re-deriving later. When there is room to build any of it, the
item is turned into an issue the same way every `PROJECT.md` §9.3 row is: an outcome, a scope
boundary, dependencies and a size.

---

## Functionality gathered so far

1. **Login** — modeled on Swarm's own.
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
8. **Host token management** — issuing and revoking the shared secret that authenticates a client
   to the host (`PROJECT.md` D20). Kept separate from `owner`, exactly as the daemon already keeps
   them separate.
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

## Deliberately not decided here

- **Auth model beyond "modeled on Swarm's."** Same accounts, same session mechanism, or something
  new — not settled.
- **How the panel talks to the daemon.** Most likely as just another authenticated remote client
  over the same network listener (`PROJECT.md` D17, D20) — not confirmed, and nothing here assumes
  a second, panel-only API exists.
- **Implementation.** Framework, hosting, anything about *how* — this file is what the panel needs
  to do, never how it is built.
