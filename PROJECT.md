# PROJECT.md — Rover

> A living document. Updated as the tool is being built.
> Last updated: 2026-08-30

---

## 1. Why we are building this

An agent working on a mobile app can build it and compile it, but it cannot **look** at it. A
compiler has no opinion about pixels: a green build says nothing about a 12dp radius that was meant
to be 10dp, or about a screen that looks fine and does nothing when tapped.

Rover gives the agent hands and eyes on a real device: it taps, scrolls, types, takes screenshots,
reads text out of the view hierarchy, records video, toggles network state. And — more importantly
— it **shares devices between agents**, so two working in parallel do not trample each other's run.

This is not automated testing. Nothing goes red on its own, nothing is an assertion, nothing lands
in CI as a gate. It is clicking through an app, only performed by an agent and with numbers instead
of impressions.

### Where the requirements came from

The verb set and the list of traps come from real practice on a Compose Multiplatform project
(`giotto-ai-demo`), where this method was run by hand through agents for several weeks: 428 lines
describing the method, a file-based lease on the hardware, and three diverging copies of the same
procedure across three skills. Rover has no connection to that project beyond the fact that it
revealed what a tool like this needs. **Nothing specific to that application enters Rover.**

---

## 2. How it works

### Four parties

| Who | How many | Lifetime | Role |
|---|---|---|---|
| **Agent** | many at once | a session | Works on the app. Knows nothing about adb, or where the device physically sits |
| **MCP server** | one per agent | the agent's session | Exposes the verbs. A **client** of a host, not an executor |
| **CLI** | per invocation | seconds | The same client, for a human and for a script |
| **Device host (daemon)** | one per machine **with hardware** | long-running | Holds the devices, grants leases, **executes the verbs**, cleans up |

Why the daemon has to exist separately: two agents working in parallel have **two separate MCP
servers** with no way to talk to each other. The daemon is the one place that sees both and keeps
them off the same device. Without it, one agent's unpinned install reaches the other's device — and
a screenshot of somebody else's build is a green verification of code you did not write. That is
the worst failure mode this class of tool has.

### The agent and the device need not sit on the same machine

This is the essence of the tool, not an extension of it: **Rover hosts the devices, and agents —
wherever they work from — borrow them**. The machine with phones plugged in and emulators running
is rarely the machine the agent sits on, and hardware is the most expensive and least divisible
resource in this arrangement. A tool that lends only locally lends to one person.

The relationship to Swarm is **inverted**. Swarm pushes work out to workers standing on many
machines; Rover stands still and lends devices to whoever asks. Two things follow that would
otherwise be mere convenience: the host is addressable over the network (D17), and the verbs execute
**where the device is** (D19). A third holds even though there is exactly one host: it only ever
lends what is physically attached to it (D18).

### The flow

1. The agent's client connects to a host — the local socket, or a configured remote host.
2. The agent asks for a device with certain properties (platform, optionally a specific model).
3. The host checks adb for what is free, grants a **lease**, and returns the lease id along with
   the device it is on and the list of what may be done on it.
4. The agent calls verbs, passing that lease id — the credential (D20), and the only handle a verb
   call carries; the host derives the serial from it, so the holder of one device cannot address
   another. The host executes them; the client receives the result and the artifacts, and — for
   every verb that produces one — the host separately keeps its own copy in its durable archive
   (D23, §10), on its own disk, regardless of what the client does with the copy it received. Every
   call pushes the lease expiry out.
5. The agent releases the device. The host restores its original state.
6. If the agent dies, loses the network, or simply never releases — the lease expires after 20
   minutes of inactivity and the host cleans up the same way. A dropped connection is not a
   separate mechanism: it is an absence of further calls.

---

## 3. Decisions (settled)

| # | Decision | Why | Date |
|---|---|---|---|
| D1 | **A separate repository, no ties to the source project** | The tool has to serve any mobile app. Everything it knows about one particular product is debt from day one | 2026-08-27 |
| D2 | **Node.js** | The layer is thin: processes, sockets, parsing XML and JSON, a little image work. The MCP ecosystem is at home here | 2026-08-27 |
| D3 | **Two processes: a device host per machine with hardware, a client per agent** | Devices are a shared resource; an agent session is not. Either one without the other fails to scale to two agents, or demands a manual start. **Revised:** the original wording ("a daemon per machine, an MCP server per agent") silently assumed both sides sit on the same machine. That assumption fell with D17; the process split did not | 2026-08-27, revised 2026-08-27 |
| D4 | **Core + CLI, with MCP as a thin adapter onto the same core** | A human debugs the CLI, the CLI works without an agent, the CLI needs no MCP configuration in every project. MCP comes later and duplicates nothing. The reverse order locks the tool inside an agent | 2026-08-27 |
| D5 | **The daemon starts itself on the first call** | The precedent is `adb`, which forks its own server on 5037 and nobody notices. A manual start is a step somebody will forget at the worst possible moment. This covers the **local** host; a remote host is a long-running service its operator starts, and a client never starts one across the network | 2026-08-27 |
| D6 | **The daemon is a cache; adb is the truth** | The daemon introduces a failure mode the file-based lease never had: its own stale state. So it holds nothing it cannot re-derive from `adb devices`, and it re-verifies the device at every lease grant | 2026-08-27 |
| D7 | **A lease per device, not a mutex over the whole machine** | The predecessor took all the hardware exclusively, because it was a file. With two or more devices that wastes every one but the first | 2026-08-27 |
| D8 | **A 20-minute TTL, renewed by every call** | An agent can sit idle for long minutes of thinking, so a fixed time budget is wrong in both directions. A dead agent issues no more calls and expires on its own, with no client-side heartbeat | 2026-08-27 |
| D9 | **Restoration is forced, not requested** | The predecessor *asked*, in a comment, that state be restored before releasing, and nobody ever checked. The daemon does it itself on release **and** on expiry: stop a recording left running and remove its file, stop the app, airplane mode off, wifi back on, stop the project's helper services, then its teardown hook. The recorder goes first because it is the driver most likely to still be holding the device (#191) | 2026-08-27 |
| D10 | **One set of verbs. The platform is a property of the device, not part of a tool's name** | Considered and rejected: `tap_android` / `tap_ios`. Suffixes double the tool list (agents choose worse the longer it gets), force every scenario to be written twice, and make the agent remember what it is standing on. The device knows what it is anyway | 2026-08-27 |
| D11 | **Capability negotiation instead of a lowest common denominator** | Backends are not symmetric and that cannot be hidden. Each declares what it can do; a verb with no backing ends in a **loud error**, not a silent degradation. A suffix says "there is no such tool" and leaves you guessing; a refusal says plainly what is missing | 2026-08-27 |
| D12 | **Determinism is three rules in the verb layer, not a property of the daemon** | (a) no coordinates from memory — the target is resolved from a fresh hierarchy dump **inside** the verb; (b) no `sleep` — only waiting on a condition with a timeout; (c) every action returns the state after itself, so the agent never guesses whether it landed | 2026-08-27 |
| D13 | **Everything project-specific is a hook in configuration** | The install command, starting helper services, cleanup, paths to design renders. The core knows no application's name. The one thing a hook cannot work out for itself is which ports it may use, so the host hands each lease a **slot** and tells every hook child its numbers (R18) — Rover reserves them and never binds them | 2026-08-27 |
| D14 | **Every result names the device and its density** | Two emulators at different densities give different — and both correct — measurements of the same element. Without naming the device, two reports contradict each other and there is no telling which one is lying | 2026-08-27 |
| D15 | **The architecture is modelled on Swarm (`../swarm`)** | Swarm is working Node.js code by the same author, with a proven set of conventions (TypeScript strict/ESM, Biome, Vitest, Zod as the source of truth, a provider registry). Swarm's providers are device backends here — the same module shape. Inventing our own conventions would buy nothing | 2026-08-27 |
| D16 | **Rover and Swarm will be integrated; the preparation starts now** | Swarm will eventually show that a given run is holding a Rover device. Nothing needs building immediately, but two things must be designed for from the start: daemon state queryable by something that is not an agent, and a lease with an explicit owner that Swarm will fill with its own run identity | 2026-08-27 |
| D17 | **The device host is reachable over the network; the agent need not stand on it** | The machine with the hardware is rarely the agent's machine, and hardware is the most expensive and least divisible resource here. A tool that lends only locally serves one person and leaves the phones idle most of the day. The local socket stays the default, zero-config path; the network listener is **a second transport of the same surface**, not a second implementation — otherwise one of the two starts drifting in the week it is written | 2026-08-27 |
| D18 | **Only devices physically attached to the host are ever leased** | `adb connect host:5555` makes some other machine's emulator visible in `adb devices` here, and it is tempting because it "almost works" — but that device is not this machine's hardware, may vanish without warning, and belongs to whatever process put it there. The host refuses it before it ever reaches a lease. **Revised 2026-08-29:** the original wording ("a device belongs to exactly one host") assumed Rover would run as more than one host and guarded against two of them fighting over the same `adb connect`-visible device. The deployment this is built for has exactly one host, so that scenario cannot occur — but the guard itself stays, for its own reason: physical attachment, not host ownership, is what makes a device safe to lease. **Multi-host addressing (R23) is dropped from the backlog entirely** as a consequence (§9.4) | 2026-08-27, revised 2026-08-29 |
| D19 | **The verbs execute on the host; the adapters are clients** | The alternative — the client gets a serial and calls adb itself — requires adb reachable over the network, exposing exactly the surface D17's authenticated listener exists to gate instead, and it strands the project hooks and helper services (D13, port allocation) on the far side of the network from the device they exist to serve. The core stays a library; only which process loads it changes. The consequence to keep in mind in every verb that returns a file: artifacts come back as bytes, and a path handed to the agent must exist **on the agent's machine** | 2026-08-27 |
| D20 | **The host token authenticates; the lease owner attributes. Two different fields** | Anything listening on a network lets strangers in, so a host needs a credential at the door. It was one shared `ROVER_HOST_TOKEN` when this was decided; **D25 retired that** — the listener now hashes the presented token and looks it up in `~/.rover/users.json`, so the credential is per-user and revocable, and the host holds no shared secret at all (R28, #78). The two-fields rule below is untouched by that and is the part that has to survive whatever the credential becomes. It is tempting to derive the owner from whoever authenticated — and then either the token lands in reports and logs, or the attribution cannot be overridden, and Swarm is supposed to put its run identity there (D16). The token says "you may take devices from here"; the owner says "`pr-127-review` is holding this" | 2026-08-27 |
| D21 | **Rover never starts an emulator or connects a physical device — that is the host operator's job** | The host only ever reports what `adb devices` already shows on its own machine (D6). Bringing hardware online — booting an emulator, plugging in a phone — is physical, local work done by whoever operates that machine; it is never a verb the daemon executes and never something a remote client can trigger. Rover's job starts once the device is already there | 2026-08-28 |
| D22 | **A lease carries four more explicit, caller-supplied strings: `project`, `test_name`, an optional `test_description` and an optional `group_id` — and an artifact-producing *call* carries an optional `label`** | `owner` (D16) alone does not give an artifact a findable home: two projects can reuse the same owner string, and "before/after" comparisons need a way to group runs by what they were checking. `project` names which registered project a lease belongs to; `test_name` names the scenario being run and is **deliberately not required to be unique** — running "home screen before changes" and "home screen after changes" as two separate leases with the same-shaped name is the point, not an error case. All of them are opaque strings the core never inspects, parses or defaults from context, exactly like `owner` (D20). **`test_name` was optional when this was decided, and an absent one filed under a single fixed directory name (`unlabeled`)** so the tree's shape never branched on whether the field was supplied — the reasoning being that a caller with nothing to name should not have to invent one. **#129 reversed that half** (2026-09-01): the operator has settled that a lease always carries a `test_name`, and the approved Archive designs are drawn without an `unlabeled` folder (`docs/DESIGN.md` §9), so the fallback was a directory the code invented for nobody and a reader of the code would have put it back on the screen. The field is now required on the wire, at the store and in both clients, and the shape still never branches — because it cannot be absent rather than because something stands in for it. **#148 added the third string, `test_description`, and it is optional** (2026-09-02): `test_name` goes through `pathSegment`, is truncated at 64 characters and has every character outside `[A-Za-z0-9._-]` replaced, so agents keep it short and identifier-shaped — it names the check and cannot say what the run was about, which is the one thing an operator deciding whether to force-release, and anyone reading a run weeks later, actually wants. So a lease may carry one or two sentences beside it. **Why this one may be absent when #129 made `test_name` required is the whole of the distinction:** `test_name` is a *directory name* and the tree's shape depends on it, so an absent one had to be stood in for and standing in for it was the thing #129 removed; a description is *prose the tree does not depend on* — it is never a path segment, `archive-path.ts` never sees it, and the archive files it as a file's contents instead — so absent is a legitimate answer here and nothing is substituted for it, on the wire, in either client or on either card. It gets **its own 1024-character bound** rather than sharing `ATTRIBUTION_MAX_LENGTH`: the 256 exists because the host echoes those strings back inside a refusal message, which nothing does with a description, and 256 is short for two sentences. **#150 added the fourth string, `group_id`, and an artifact-level `label` beside it — both optional** (2026-09-02): `test_name` groups two runs only by naming convention, which an agent has to invent per run, does not survive it choosing different words the second time, and says nothing at all about individual artifacts — so an agent asked to screenshot before and after a change files four facts with nothing tying them. **The two are at two different levels, and that is the whole of the design.** A `group_id` is on the **lease**: several leases sharing one are one investigation, and it is what makes the grouping recoverable after every lease in it has ended. A `label` is on the **call** — `screenshot`, `record_video`, `read_logs`, exactly the three the archive files — because one lease produces several artifacts and they are not all the same thing; a label says *this artifact and that one are the same screen at two moments*. Nothing enforces arity, uniqueness or membership on either: one lease may be its group's only member, a group may have seven, and nothing checks that a second ever arrives. **A `label` on a lease with no `group_id` is refused, in the host's own words, naming both fields** (`label-without-group`) — not a crash and never a quiet drop, because a label means nothing outside a group and an agent that supplied one believing it was recorded would be told nothing. `group_id` takes `ATTRIBUTION_MAX_LENGTH` because it is an identifier rather than prose; `label` gets its own, shorter 64 because it becomes part of an archived **file name** and the archive rewrites any path component past that. Why `group_id` may be absent where #129 made `test_name` required is `test_description`'s answer exactly: the tree's shape does not depend on it — it is filed as a file's contents, `archive-path.ts` never sees it, and the tree stays four levels whether or not it was supplied. A `label` *is* a path component, but of a **file** rather than of a directory level, so it shortens no tree and branches nothing either. **#205 amended this row for `group_id` and for that string only, and two of the things said above stop being true of it** (2026-09-07): `group_id` was whatever the caller typed, stored verbatim, and nothing refused one another lease already used — but a group is keyed `(project, group_id)`, and an agent picks that name from what it is looking at rather than from any source of uniqueness, so the same words come up again the next time somebody opens the same screen and **two unrelated investigations that both reached for `statistics-deliveries` in one project were one group**. That is not a corner case; it is what the field did by default over time, and #181's grouping view, #182's per-group badge alphabet and #199's `(group_id, label)` side-by-side card each read such a collision as one investigation. So **the agent names the investigation, the host mints the id that is actually filed, and hands it back**: a name with no separator in it gets `.` and a short high-entropy suffix appended (`statistics-deliveries` → `statistics-deliveries.h57ssn4`), an id the host already minted is taken **verbatim** — which is how the second, third and seventh lease of one investigation join it — and a *name* containing the reserved separator is **refused in the host's own words, naming the field** (`separator-in-group-id`), never quietly rewritten and never minted onto twice. A name too long to mint an id from within `ATTRIBUTION_MAX_LENGTH` is refused by name as well (`group-id-too-long`) rather than truncated, because a shortened name is a *different* group. Both are refusals as **data**, like `label-without-group`, so both render as a sentence and as a `--json` document in both clients, and neither takes the device. `.` is the separator because it is inside `pathSegment`'s `[A-Za-z0-9._-]` set, so a minted id survives a path component unrewritten and can never pick up the collision hash; the suffix carries a guaranteed digit so an all-letters dotted name (`stats.summary`) is refused rather than read as already minted, which would restore the collision by accident in the field an agent is most likely to write. **The two things that stopped being true are exactly those two**: the host now contributes part of the value, and it now looks at the string's *shape*. It still never reads what the string **says**, never derives one from who authenticated or from any context (D20, ai/RULES.md §1), never checks one against another lease and reads nothing out of the archive — uniqueness comes from the minted bytes, not from a lookup, so there is no index, no catalogue and no new state, and the daemon still holds nothing it cannot re-derive (D6). The shape rule therefore lives in `src/daemon/group-id.ts` and deliberately **not** as a `.refine()` on `GroupIdSchema`, which is also what parses `group_id.json` back off the disk: a refinement there would make every minted id unreadable on the way out, and the grouping view would silently lose exactly the runs this files. **Not retroactive** — no `group_id.json` already on disk is rewritten and every run already archived groups exactly as it did — and the key stays `(project, group_id)`, so `list_archive_groups` and the grouping view's key needed no change and got none. **The panel did need one** (#210 review): `panel/src/archive/variant-name.ts` read the comparison card's pane head by taking the group's whole id off the front of a test name, and a minted id is never the front of one — a test name is still the caller's own `<name>_variantA` — so it now matches the id's **name half** as well, the whole id first for archives filed before this and the half after the separator for one filed since. It splits at the separator and reads nothing of the suffix (`docs/DESIGN.md` §9). `group_id` stays optional, absent still stays absent (a caller who supplied none is minted none, #129's lesson), and arity and membership are still unenforced: one lease may be its group's only member and a group may have seven. **Every other attribution string is untouched** — `owner`, `project`, `test_name` and `test_description` stay opaque, stored as given, parsed by nothing and derived from nothing, and `test_name` stays deliberately **not** unique, which is what still puts the two runs of one check side by side (D24, §10) | 2026-08-29, amended 2026-09-01, amended 2026-09-02 (twice), amended 2026-09-07 |
| D23 | **The host durably archives every artifact-producing verb's output, additive to D19's bytes-over-the-wire return** | A screenshot handed to the agent once during a session answers "does it work right now"; it cannot answer "does it still look the way it did before the refactor" unless a copy survives on disk to diff against later. The archive (§10) is a second effect of the same verb call — it changes nothing about what the client receives, and a path into the archive is never a path handed to the agent. D19 keeps holding: artifacts still cross the machine boundary as bytes | 2026-08-29 |
| D24 | **The artifact archive's tree shape is a deliberate, stable surface, built for a future read-only viewer, not just for a human `find`** | A screenshot returned once to whichever client asked for it (D19) cannot later answer "show me what changed" to anyone outside that one session — the archive (§10, D23) exists so it can. This decision is that the directory shape (`<project>/<test_name>/<lease-id>/<device-serial>/…`) is the contract a future web panel (`docs/WEB_PANEL.md`) would read directly off disk — no database, no rewrite of the tree the day that panel gets built. **This does not move the panel into scope now** (§7 still excludes a dashboard) — it only means the archive's shape is not free to casually change once R25 ships, because something will eventually depend on it. **Revised 2026-09-01:** this row grew a second claim as it was cited — that *listing a directory is the whole query* the tree needs to serve, and so that no search belongs on the surface (§10, R36). **That half is overruled, at the operator's instruction**, and R38's `search_archive` answers a search of the whole archive. The refusal is kept here rather than deleted because it was considered and its reasoning was sound as far as it went: a *parameter* on `list_archive` is how an index gets built by accident, so the search is a **separate method** and `list_archive` keeps its shape exactly. **The no-index half stands untouched, and is the load-bearing one**: no database, no catalogue kept in sync with the files, no cache of a previous walk — every answer is derived from the filesystem at request time, which is precisely why that walk is bounded (depth, match count, directories read) and why a bounded answer says it is truncated | 2026-08-30, revised 2026-09-01 |
| D25 | **Host authentication becomes named, revocable per-user credentials — one shared secret is retired, not kept as a second path** | `ROVER_HOST_TOKEN` (D20) is one static bearer secret for the whole host: everyone who holds it looks identical to the daemon, nobody can be individually cut off without rotating the secret and re-distributing it to everyone else, and there is no record of who actually holds it. That is fine for one operator bootstrapping a host alone and wrong the moment more than one person or system needs independent, revocable access — exactly what a web panel (`docs/WEB_PANEL.md` item 8) needs. Modeled on Swarm's own operator front door (`../swarm/src/cli/commands/users.ts`, `swarm users add/list/grant-admin/revoke-admin/set-password`): `rover users add/list/revoke/rotate <identifier>`, run **on the host machine itself**, never over the network — an operator tool, not a verb. Each user gets one opaque token, printed exactly once at creation or rotation and never again; only its hash is stored (dependency-free, `node:crypto` scrypt-style, mirroring `../swarm/src/identity/auth.ts`'s approach minus the password/session split a bearer token does not need), in `~/.rover/users.json` beside the already-established `~/.rover/rover.sock` (`src/daemon/socket-path.ts`). **D6 applies here too**: the file is the truth, re-read at every connection's auth check and never cached for the daemon's lifetime, so a revoke takes effect on the very next connection with no restart. D20 is otherwise unchanged: the token still only authenticates, the owner string still only attributes, and a user's identifier is never written into a lease's `owner` field automatically | 2026-08-30 |
| D26 | **MCP tool names stay `snake_case` and their arguments stay `camelCase` — the mismatch is deliberate, and every tool says so** | The tool surface reads oddly: `launch_app` takes `leaseId` and `appId`, so the first call an agent writes from the tool *name* is refused. `snake_case` arguments would look more conventional, and were rejected because of what the declaration **is**: the `IPC_METHODS` params schema handed to `registerTool` is the same object the host parses the request with (ai/CODING_STANDARDS.md boundary #1), so the field names an agent reads are the field names the host's own Zod refusals name (`Required at leaseId`), the CLI's `--json` documents carry, and Swarm will read off the same table. Renaming on the MCP side alone means a translation living in a layer that owns translation only, and one field with two spellings — the second vocabulary D10 refuses for verbs, one layer down. What the mismatch actually costs is a first call written from the wrong half of the declaration, so the fix taken instead is **legibility before the call**, the same move D11 makes for capabilities: every tool's description carries one sentence naming the casing and pointing at the schema (`src/mcp/_shared/declaration.ts`, appended in one place so a tool cannot land without it, gated by `tests/unit/mcp/declarations.test.ts`). The refusal stays loud and names both halves, which is the behaviour this project wants. If this is ever revisited, the thing to change is the **wire**, so both clients and the host move together — never one adapter | 2026-08-31 |
| D27 | **The web panel is in scope and is not read-only — it carries authority over the device pool, and only that** | §7 excluded a dashboard while CLI and MCP were the whole interface, and `docs/WEB_PANEL.md` described a read-only viewer. Both are reversed here, and the thing that forced it is an absence rather than a preference: a stuck lease cannot be ended by anyone but its holder, from any interface, because `release_device` takes the lease id as the holder's credential and D20 deliberately keeps that id out of every listing. So the panel acts. **The rule for what belongs in it: an action is a panel action when it is an authority over the shared pool, not a step in one agent's own work.** Force-releasing a stuck lease is the first — it ends somebody else's lease and must run the same restoration that expiry already runs (D9), which is why it is a new trigger on an existing path rather than a new path. **Acquiring a device is deliberately not in that class**: a lease carries the caller's own `owner` string (D22), an agent signs its own work, and a person clicking a button has nothing to sign with — inventing an owner for them would make the attribution D16 and D20 rest on a fiction, and would hand out a device no agent can then use. Every panel action authenticates as a named user (D25); until a role model exists, every named user may perform every panel action, and `docs/WEB_PANEL.md` records that tiering is an open question rather than an assumed one. The panel is a client like any other (D17, D19) — it runs no adb and holds no device state of its own | 2026-08-31 |
| D28 | **Force-releasing a lease is authorised by reaching the surface, and attributed by a string the caller supplies. The host derives neither from the other** | D20 splits the credential from the attribution, and every lease operation until now fitted inside that split: the holder presents the lease id it was handed, and the `owner` string says whose work it is. Force-release fits neither half — it ends a lease the caller never took, so there is no credential of the holder's for it to present, and handing that id out so there could be is exactly the disclosure `ListedDeviceSchema` refuses (D20). So it is keyed on the **serial**, which every listing already shows, and its authorisation is stated here rather than borrowed. **What authorises it is the reach the caller already has.** A caller on the unix socket is a shell on the host machine, which can already reach every device with `adb` directly and needs no token to do it; a caller over the network is a named user in `~/.rover/users.json`, checked at every connection (D25, R28). That is the same reach `acquire_device` and every verb already grant, and inventing a role for this one row would be deciding a question nobody has asked yet: D25 gives every named user identical reach, and `docs/WEB_PANEL.md` records tiering as an **open** question rather than an assumed one. That file's entry stays open — this decision does not quietly close it, and a read-only tier arriving later restricts this row along with the rest rather than instead of them. **Who did it is a caller-supplied `actor` string, exactly as `owner` is** (D20, D22): the host never derives it from whoever authenticated, because that is the derivation D20 exists to forbid — and the acting user's identity is not their token, which never reaches a record. The record is the daemon's own log line, written on the released path only, with every caller-supplied value JSON-escaped so a newline cannot forge a second line; a durable, queryable audit store is the panel's own row and is deliberately not invented here. **And it is a third trigger on the release path, never a third path** (D9): the handler ends the lease through the same `LeaseStore.release` a normal release calls, so the traffic revocation, the restoration, the archive's bookkeeping and the project's teardown happen by construction. That is also why it landed as its own method rather than as a parameter on `release_device` — the release path is genuinely shared, so a second row costs only a table entry, while a params union of "either a lease id or a serial" would weaken the one sentence `ReleaseDeviceParamsSchema` exists to state. This is D27's first panel action, and the CLI carries it too (D4) | 2026-08-31 |
| D29 | **The browser reaches the host through a third transport of the same surface — one HTTP route, authenticated per request against the same user store, and off unless configured** | The panel has to talk to the daemon and cannot: the network transport authenticates with a length-framed NDJSON greeting consumed before the IPC server is attached (R22), which `fetch()` cannot send. **The answer is a third transport, never a second implementation** (D17): `src/daemon/http-listen.ts` consumes the very `IpcServer` the unix socket and the TLS listener already serve, so every method, every schema and every framing rule stays shared by construction — `tests/unit/ipc/transport-independence.test.ts` now forbids `node:http` and `node:https` inside `src/ipc/` for the same reason it forbids `node:tls`. Six things follow, and each was a choice. **One RPC route, `POST /rpc`**, whose body is the existing request envelope: a route per method would be a second place a method name lives, to be kept in step with `IPC_METHODS` by hand, and with one route an HTTP-only method is structurally impossible. **One request is also one frame**: `IpcServer` consumes NDJSON, so a body that is not a single JSON value is answered by this module rather than handed on — otherwise two envelopes in one body would decode into two frames and dispatch both, with the allowlist having decided about only the first, which is the hole review pass 1 of #118 found and closed. **The panel's login is an `rover users` credential and there is no second one** — `Authorization: Bearer <token>`, hashed and looked up in the store `ROVER_USERS_PATH` names, **re-read on every request and never cached** (D6, D25), so `rover users revoke` bites on the very next request over a keep-alive connection the revoked user is already holding. This settles what `docs/WEB_PANEL.md` left open; no `ROVER_HOST_TOKEN` revival, no panel-only secret, no fallback. **The token is a header, never a URL** (D20) — a URL reaches a browser's history, a proxy's access log and a referrer header — and nothing here logs an attempt, because the only interesting thing to log about one is the token that was tried. **One byte-identical refusal for every pre-auth failure**, and it is literally the bytes the TLS gate writes without its newline, because both come from one `UNAUTHENTICATED_REFUSAL` in `src/ipc/protocol.ts`: a missing, malformed or unknown credential, a revoked user, an unreadable store, a path that does not exist and a method the route does not take are all `401` with that body, so authentication precedes routing and a stranger cannot learn which paths exist. Wherever an envelope is the answer there are therefore exactly **two statuses** — `401` and `200`, *read the envelope* — because `IpcErrorCodeSchema` is already the complete error vocabulary and a second one in the status line is two sources of truth that can disagree. **Amended 2026-09-01 (R37, #131): the surface is one RPC route, the credential exchange D30 added, and one byte route.** `GET /artifact/<component>/…` serves one archived file, and it is a route rather than a method for the reason `/session` is one, taken one step further: an artifact is *bytes*, and a recording base64'd into a frame would be inflated by a third, buffered whole on both sides, in a layer capped at 8 MiB — and a browser cannot point an `<img>` or a `<video>` at a method call anyway. The two-status rule was always the *envelope's* rule and it still holds wherever an envelope is the answer; a response that is a file has no vocabulary but the status line, so that route adds `200`/`206`/`400`/`404`/`500` and every one of them is **post-auth** — the pre-auth uniform refusal is untouched, so nothing a stranger can reach varies with the reason, and no body carries a path or an errno (D19). It gains no credential of its own, no cookie, no CORS header and no query-string token: **pasted into a bare tab the address gets the one `401`**, because a top-level navigation sends no header and the alternative is what D20 forbids, so the panel's *Open in a new window* fetches it with the session header and opens the object URL. **Only the panel's methods are reachable**, as an allowlist over the one table and never an addition to it: every method still runs on the host either way (D19), so what this protects is D27 — without it an authenticated user could `acquire_device` from a browser tab and drive the phone with the lease id it was handed. **The panel polls; the surface does not push.** `list_devices` answers with `expiresInMs`, a duration (D17), so the countdown ticks in the browser from a value the server sent and re-syncs on the next poll — which is also how activity renewing a lease (D8) makes the number go back up — and reading never renews. So there is no SSE, no WebSocket and no long poll, and therefore no second connection style to build, authenticate or shut down: that single decision is most of what keeps this change small. **And it is off unless configured**: `ROVER_HTTP_PORT` is its own switch, separate from `ROVER_LISTEN_PORT` because exposing a host to a team's Rover clients is not asking for a browser surface, and because a daemon that started listening for HTTP on a developer's machine merely because they upgraded would be a change in exposure nobody chose. It defaults to loopback rather than to every interface, refuses to start unencrypted anywhere a stranger could reach it, and `spawnDaemon` blanks the switch in an autostarted child exactly as it blanks `ROVER_LISTEN_PORT`. No CORS header is emitted anywhere, because the panel will be served from this same listener once serving its assets is taken on — no roadmap row owns that yet (see R33) — and an emitted one would make this surface readable from any page a browser happens to have open | 2026-08-31 |
| D30 | **A browser holds a session, not the token — minted from an `rover users` credential over the surface's own route, ended by a sign-out, and dead on the next request after a revoke** | D29 settled *which* credential the panel presents and deliberately left one layer open: how a **browser** holds it between reloads. It does not hold it at all. `POST /session` takes `{"token": …}`, verifies it against the same `~/.rover/users.json` the gate reads, and answers `{session, identifier, displayName}` with `cache-control: no-store`; the page then presents that session id in the `Authorization: Bearer` header a token goes in today, and a raw token keeps working there unchanged, so R32's `curl` recipe is not a casualty. `GET /session` is the boot probe and `DELETE /session` ends the session **server-side**, which is what makes signing out real rather than a `localStorage.removeItem`. **Why the id and not the token**: the token is also the operator's CLI credential, it never expires on its own, and the only thing that ends it is `rover users revoke`/`rotate`, which ends it *everywhere* — a session is minted for one browser, expires on its own, and is ended by one verb; the token reaches the host once, in a request body, and the browser never stores it. **Each entry binds the user's `identifier` and `tokenHash`, and resolving one re-reads the store** (D6, D25) — so a revoke kills the session on its very next request, on a keep-alive connection the browser is already holding, and a rotate kills it too, which is the only reading consistent with "rotate invalidates the old token". That comes for free rather than from a callback anyone has to remember to fire, and it is *cheaper* than the token path: an identifier and a hash compared, where a presented token costs one `scrypt` per stored record. **Keyed by the SHA-256 of the id, and deliberately not `scrypt`**: `user-token.ts` pays for `scrypt` because a user's token is at rest in a file that can leak, whereas a session id is 256 bits of CSPRNG output living only in this process's memory — there is nothing to brute-force and no file to leak, and a `scrypt` per request would be a cost with no attacker to spend it on; hashing at all is what keeps a live credential out of the daemon's own heap. **In memory, per listener, dying with the daemon**: a restart signs everyone out, which is honest, needs no file, and cannot go stale against the user store — the rejected alternative, a persisted session store, buys only that restart and costs a second credential file to leak. **A route and not an IPC method**: `/session` is this transport's own credential exchange, the analogue of the greeting frame `network-listen.ts` consumes before attaching the IPC server, which is likewise not on `IPC_METHODS`; a `create_panel_session` method would put a raw credential into an envelope layer that has never carried one and would exist on the unix socket, where a browser cannot reach and a session means nothing. **No `Set-Cookie`, no cookie read, and still no CORS**, so the CSRF question D29 said "arrives with the session" does not arrive: a cookie is attached by the browser to a cross-site request whether the page meant it or not, whereas a header the page sets itself cannot be. The cost is stated rather than hidden — whatever the panel keeps the id in is readable by script, so an XSS in the panel reads it, but it reads a credential that expires, that `DELETE /session` ends, and that is not the token `rover users` issued. **Sliding 8-hour idle expiry**, renewed by use the way D8 renews a lease, swept lazily on a mint and on a resolve — no timer to `unref` and nothing holding the event loop open. **The sign-in body is the one pre-auth body this surface reads**, capped at 4 KiB and abandoned rather than drained over it, and *every* failure — no body, an oversize one, one that is not JSON, one that is not `{token: string}`, an unissued token, a revoked user's still-held token, an unreadable store — gets the one byte-identical `401`, because a diagnosis handed to a pre-auth peer is an oracle and `/rpc`'s `malformed_frame` wording may not be reused there. **D20 is untouched**: the identity a signed-in browser is told is its own and nothing else derives from it — no lease's `owner` is ever an authenticated identity. **Amended 2026-08-31, once the browser's half was built** (#119, R34): the id is kept in `localStorage` under one key, `rover.panel.session`, and the sign-in screen is deliberately **not a route** — the panel renders it in place of the router while there is no session, so the "no credential in a URL" half of D20 holds structurally rather than by care. The edges the host's half could not decide, all of them decided by one rule — **the panel never discards a session id without the host's answer, and never reports an ending it did not get**: a stored id the host answers `401` to on the boot probe is *access ended* and is cleared, because a stored id is evidence a session was live; a boot probe that reaches nothing at all **keeps** the id, because an unreachable host has said nothing about whether the session is good, and a daemon that was restarting must not sign anybody out; a sign-out whose `DELETE` reaches nothing **is not a sign-out** — it keeps the id, stays signed in and says the host did not answer, because announcing an ending nobody performed would discard the one credential that could still perform it and leave a live session on the host for the rest of its idle window (a `401` there is finished, since a host that will not take the id has already forgotten it); and a sign-in that replaces an id the boot probe kept presents that id to `DELETE /session` on the way out, ignoring the answer, so a host that has come back reclaims it instead of holding two live sessions for one person, one of them unreachable by any browser. The panel shows one refusal for a `401` and for a host that never answered alike, worded to claim neither the token nor the host as the cause | 2026-08-31 |
| D31 | **The panel's *Projects* screen is the read alone — the host answers what is registered, and nothing on any transport writes a hook file** | D13 put the per-project hooks on the host and said they are never accepted over the wire; that clause was written before there was a panel, and the panel needs half of it back. The half it needs is the **read**: a registration under `ROVER_PROJECTS_PATH` is invisible to every transport, so `docs/WEB_PANEL.md` item 2 has nothing to build on — and worse, a hook file that will not parse costs a project its teardown while saying so only in one warning on the daemon's stderr, which is a log an operator has no reason to open. The half it does **not** get is the write, and the reason is not caution: `install`, every `services[].start` / `stop` and `teardown` are programs the host spawns with a `cwd` and an `env` (`src/daemon/hook-command.ts`), so accepting one over the wire is arbitrary code execution as the daemon's user — and D27 records that until a role model exists, **every named user may perform every panel action**. Force-releasing a device ends a lease; writing a hook file owns the host, and the two are not the same risk wearing different words. So this **narrows** D13 rather than repealing it: `list_projects` (R39) reads the root and answers what is registered — the identifier, `apps`, whether there is an `install`, the services **by name**, whether there is a `teardown`, and for a file that will not parse **that it will not parse** — while **no path goes in and no path comes out**, no `env` *value* is on any answer, and there is no field either would fit in (D19). Key names may cross; values may not, because a hook file's `env` may hold anything an operator put there and this answer reaches a browser. Registering stays `rover init`'s; editing and deleting a registration from the panel wait on the role model D27 defers | 2026-09-02 |
| D32 | **The host finds `adb` in a fixed list of known locations, and never by searching the disk** | The runner used to invoke it by bare name, so it resolved against the `PATH` of whichever client autostarted the daemon (D5) — for an MCP server launched by a desktop application, a short `PATH` with no `platform-tools` on it, kept for the daemon's whole life. The order is `ROVER_ADB_PATH`, `PATH`, `$ANDROID_HOME`, `$ANDROID_SDK_ROOT`, then the platform's standard SDK location, and a candidate is accepted only once it has been run. **A search of the filesystem was considered and rejected**: a developer machine holds several `adb` binaries at different versions, `adb` replaces a running server whose version does not match the client that reached it, and every measurement in §6 is pinned to a version — so picking one by scanning would disrupt other tools' adb sessions and make §6 non-deterministic. A long-lived, network-reachable daemon (D17) executing a program it found by scanning is a bad property on its own. The resolved path is held in memory and **never written down** (D6); the only durable form is the operator's setting. Nothing about D21 or #167 changes: Rover still writes nothing and rewires nothing — it only widens where it looks for its own use | 2026-09-06 |
| D33 | **The per-test `Keep` flag lives in one document of the host's own — `~/.rover/kept-tests.json`, beside `users.json` and deliberately *outside* the artifact tree** | The flag says *do not sweep this test*, and where it lives had three constraints. **Not the artifact tree**: every sidecar the archive writes goes out with `flag: 'wx'` and is never rewritten (`device_info.json`, `test_description.json`, `group_id.json`), because each records what was true when a run happened — a `Keep` flag is the opposite, it toggles, and it is about the *test* rather than a run. Nothing has ever been written above the run level, and the archive's whole claim is that it is what past leases wrote (D24, §10); a `keep` file at the test level would make the tree contain something no lease put there. **Not a database**: `src/db/migrations/` is an empty scaffold with nothing behind it, and introducing one for a boolean is a far larger decision than this flag (`ai/RULES.md` §1 — Rover has no database). **One document, not a file per test**: the panel draws a whole screen of ticks from one answer, so one read answering the whole set is what keeps *one poll, one answer* (D6, R29), and it is also what lets one write replace the whole document atomically — write-then-`rename`, as `user-store.ts` does, so a process killed mid-write cannot truncate the record of every exemption on the host. **An atomic replace is not enough on its own here, and that is the one thing this store needs beyond `user-store.ts`**: a wire call sets it (below), so two presses can be in the handler at once, and read-modify-write of a whole document does not compose — the later read would not see the earlier press, and left sharing one temporary name both writers would truncate it and rename interleaved bytes over the store. So each write renames a **uniquely named** temporary, and `set_kept_tests` **serialises the read-modify-write per store path**; two overlapping presses both land and both are answered with the set that includes both. That is a lock on a file rather than a cache — nothing is held in memory between calls, and D6 below is untouched. **Two shapes were considered and rejected**: a `keep` file in the tree (above), and a file per kept test (a screen of ticks becomes a directory walk, and no write is atomic across it). **D6 is honoured rather than dodged.** D6 says the daemon holds nothing it cannot re-derive; this cannot be re-derived from anything, which is precisely why it is **not held in the daemon's memory** — the file is the truth, it is read on every call and cached nowhere, exactly as `findUserByToken` re-reads the user store on every connection. A daemon restart therefore changes nothing, which is the durability claim. `users.json` is already durable host state that cannot be re-derived (D25); what is new here is that a **wire call sets it**, since nothing on any transport writes the user store. **The identity stored is the archive's own path vocabulary** — `<project>/<test_name>` as the components `list_archive` answers with, validated by `ArchivePathSegmentSchema` and parsed by nothing (D22) — never the caller's original attribution strings, which `pathSegment` may have rewritten unrecoverably, and because the thing a sweep would come for is the directory. Two rows carry it: `list_kept_tests` answers the whole set, `set_kept_tests` takes however many tests one press stood for — so a group's tick is **one** call — and answers the whole set after the write. Both are on `PANEL_METHODS` (D29) and both are deliberately **not** MCP tools: setting it passes D27's test — it is the operator's authority over a shared resource rather than a step in one agent's work — and an agent that could untick a test would be clearing the exemption on somebody else's run. D28 authorises it unchanged, with `actor` supplied by the caller and never derived from whoever authenticated (D20); the file records it as `keptBy`/`keptAt`, one audit line says it, and it stays off the wire on reads. `rover keep list\|add\|remove` gives the CLI the same reach (D4). **This decides where the flag lives and nothing about retention.** *Amended 2026-09-08 (#238):* the TTL and the size cap are now settled — D34–D36 and `ROVER_ARTIFACTS_MAX_AGE_DAYS`/`ROVER_ARTIFACTS_BUDGET_MB` — and what this flag exempts a test from is those two bounds, absolutely (D35). **Who runs the prune unattended is still undecided** (§9.4): `rover sweep` is the only trigger, and nothing on the host calls it on its own | 2026-09-08, amended 2026-09-08 |
| D34 | **The unit of deletion is one run directory, taken whole, and the oldest go first by the code-unit order of its name** | A retention policy has to decide what a *thing* is before it can delete one, and every finer unit is wrong. Deleting a file, or a `screenshots/` folder, leaves a run whose sidecars no longer describe what is beside them — in a tree whose whole claim is that it is what past leases wrote (D24). Deleting a level *above* the run would take a test or a project, which is a decision about the operator's intent rather than about disk. So the unit is `<project>/<test_name>/<timestamp>-<owner>-<hash>` with its `<serial>` subtree, and a test name or project left holding nothing afterwards is removed as scaffolding; the root never is. *Oldest* is the run directory's own name compared as **text**, never `localeCompare` and never a `Date` parsed out of it: the name leads with a fixed-width UTC basic-format timestamp precisely so code-unit order *is* chronological order (§10), the cutoff instant is formatted by the same function that named the run, and a locale-dependent fold would make one host sweep differently from another — `list_archive`'s own reason for refusing the same call. **A test's age is the age of its newest run**, so a test with a run from yesterday is not thirty days old whatever else it holds, and an old test goes whole rather than losing its oldest runs: the two most recent runs under one test name are the before/after pair `test_name`'s non-uniqueness exists to give | 2026-09-08 |
| D35 | **A kept test (D33) and a run whose lease is live are exempt from both retention bounds, absolutely** | The `Keep` flag shipped ahead of the sweep precisely so the sweep could never delete a test somebody had every reason to believe was safe (D33), and an exemption that yielded under disk pressure would be no exemption. A live lease is the same rule in the other direction: that run directory is being written into *right now*, so deleting it would destroy an in-flight run's artifacts — and the exemption is matched by **path**, built by the same `leaseRunDirectory` the writer files under, so the two cannot drift. The kept-tests store is re-read on every sweep and cached nowhere (D6), and a store that will not parse **abandons the sweep and deletes nothing at all**: the list of what the operator asked to keep is exactly what a deletion may not proceed without | 2026-09-08 |
| D36 | **An archive still over budget with only kept or live runs left is a refusal with one log line, never a kept test deleted** | Something has to give when the two rules collide, and it is not the exemption. Taking a kept test to satisfy a number would make D35 conditional, and the number is a default somebody may never have looked at while the tick is a decision they made deliberately. So the sweep stops, answers `stillOverBudget`, and writes one line on the host's own stderr saying how far over and against what — D28's model: a record on the host, nothing extra on the wire. The archive can therefore sit over its budget indefinitely, and the remedies are all the operator's: untick a test, raise the budget, or wait for a lease to end. The alternative — a budget that is always met — would be a host that quietly overrode the one instruction it was given about somebody else's data | 2026-09-08 |
| D37 | **The disk budget is enforced after every lease ends — released and expired alike — and the age limit is not** | A run finishing is the only moment this archive can *newly* cross its size: nothing else on the host writes into the tree, so a budget checked at any other moment is checked when nothing has changed. It therefore hangs off the path D9 already runs, which is what makes it a teardown rather than a happy path — an expiry restores a device with no caller left to ask, and it sweeps for the same reason. It is deliberately **behind** the release rather than inside it: `release_device` answers as soon as the store has forgotten the lease, the restoration is queued after that and the sweep after *that*, so nothing an agent is waiting on ever waits for a walk of the archive — and a sweep that fails leaves the release successful, with one line on the host's own log saying the archive is a sweep behind. The **one** thing that does wait for the walk is a **shutdown**, and it has to: the unit of deletion is a whole run directory, so a `process.exit` landing inside that `rm` would leave a run every listing still reports while it holds a subset of what its lease wrote — and a partial deletion that happened to bring the tree under budget is never selected again. So `close()` settles the sweep in flight beside the restorations it owes, bounded and warning at the bound for D6's reason: a `close()` that never resolves is worse than a husk reported out loud. The **age** bound is deliberately left out of this trigger: a lease ending makes nothing older, so enforcing it here would be a rule fired by an event that cannot change its answer. It needs a clock, and that is its own change. The accepted cost is one walk of the whole tree per lease, and it was **measured rather than assumed** (§6): ~150 ms for a full archive at the default 1 GiB budget and ~610 ms for one four times over it, linear in the file count and off the answer's path in both cases. So **no cached total was built** — the measurement does not call for one, and D6 binds it in any case: a total is re-derived, never trusted from disk | 2026-09-08 |

---

## 4. The verb set

Working names. All of them take a device handle, and over the wire that handle is the **lease id** — the credential (D20), from which the host derives the serial. A verb call naming a serial beside it would be either redundant or a way for the holder of one device to drive another (D19, R21).

**`force_release_device` is the one exception, and it is the exception that states the rule.** It names the serial precisely *because* the caller has no credential to present: it ends a lease it never took, and handing out the holder's id so it could would be the disclosure D20 keeps out of every listing (D28).

### Devices and leases

| Verb | What it does |
|---|---|
| `list_devices` | What is attached, what is free, whose is what, and what OS version each one runs — for a free device as much as a held one, since no lease is needed to be told (R30) |
| `acquire_device` | Takes a device exclusively; returns a handle and the capability list. Also takes `project` and `test_name`, both required — caller-supplied attribution strings that name the destination in the artifact archive, not application logic (D22, §10). **It also brings up that project's helper services** before it answers (D13, R17 phase 4), so a caller holding a lease has the services that lease implies; one that will not start refuses the grant **by name** (`service-failed`) and hands the lease straight back, because granting a device whose helper services are down is a false yes |
| `release_device` | Hands it back and restores the original state — the applications, the radios, the project's helper services, then its teardown hook (D9). The service stops run with **this** lease's slot, so what they take down is what this grant started rather than one set shared with whoever else holds the project — a contract the hook file keeps by namespacing on `ROVER_SLOT` (R18) and not one the host can check (R17 phase 4) |
| `force_release_device` | Ends the lease **somebody else** holds, keyed on the **serial** rather than on a lease id, and carrying no credential of the holder's (D28). It is a third trigger on `release_device`'s own path rather than a third path, so the restoration is identical (D9). A device nobody is holding is a named refusal and not an error, and the three reasons are distinguishable because they are three different next moves for an operator: `not-held` (here and free), `gone` (this host cannot see it at all any more — D6) and `not-attached` (visible but another machine's, so never leasable — D18). Attributed by a caller-supplied `actor` string, never derived from whoever authenticated; the holder's next verb call is refused `no-lease` |

### Input

| Verb | Notes |
|---|---|
| `tap` | By text or element id; coordinates are the fallback |
| `long_press` | Implemented as a drag in place with a duration |
| `swipe` / `scroll` | |
| `type_text` | Hides the device shell's quoting, so a space, an apostrophe and a shell metacharacter all arrive verbatim. **Non-ASCII it cannot hide — `input text` cannot type it at all** (§6), so the honest answer is a refusal naming the character rather than a silent drop. That refusal is an `unsupported-text` verb failure carrying the serial, the string and the offending characters as escapes, **not** an `internal_error`: the string is the caller's and it is the caller who can fix it (#61). **No target** — an agent taps the field first |
| `press_key` | Back, home, recents, wake. **No target**, so it needs no screen read to aim, which makes it the one input verb provable end to end on hardware before `read_screen` (R13). Those four are **one vocabulary, not a promise every platform has all four**: a backend with no equivalent for one of them refuses **that key by name** — an `unsupported-key` verb failure carrying the serial and the key — deliberately not `missing-capability` and not `internal_error`, because a backend that takes input and lacks one key is a narrower backend rather than a broken one (#215) |

### Reading

| Verb | Notes |
|---|---|
| `screenshot` | The captured image, **as bytes on the result rather than as a path** (D19) — base64, its media type and its byte length, so any file written is the client's own. Needs no capability; a capture over the named size bound is refused by name rather than returned cut short. **The client writes the file** (R24 phase 1): `rover screenshot <lease-id> --out <path>` decodes the bytes, checks what decoded against the byte length the host encoded, writes them on the machine running the CLI and reports `path.resolve` of `--out` — never a host-local path. A refused capture, or one that did not survive the trip, exits 1 and leaves no file at `--out` at all. **A black image is a true answer, not a failed capture** (§6): the check that separates a blocked capture from a broken device is a screenshot of the system home screen, and `read_screen` is the read that survives the block |
| `read_screen` | Texts and element rectangles. **Works even when the app blocks screenshots**. Declares `canReadScreen` as a requirement, so a backend without it fails by name before anything is dispatched rather than answering with an empty screen (D11) |
| `record_video` | A recording of the screen, **as bytes on the result rather than as a path** (D19) — base64, `video/mp4` and its byte length, exactly where `screenshot`'s capture rides. **The recording is provably finished before it is pulled**: the backend waits on a condition for the recorder to be gone, then pulls, then checks the container index on the bytes that actually arrived. A recording without that index was still being written when it was copied and is not a shorter video but a file no player will open, so it is refused as `unfinished-recording` naming the device and the byte length — never handed over, and never an `internal_error` (§6). Declares `canRecordVideo` as a requirement, so a backend without it fails by name before anything is dispatched rather than answering with a null artifact (D11). Duration is bounded by what **one answer** can carry (15 s; the default is 5 s), and going over the artifact bound is the same `artifact-too-large` refusal `screenshot` gives rather than a file cut short — a longer recording is R24's chunked transfer. **The client writes the file** (R24 phase 1): `rover record <lease-id> --out <path> [--duration-ms <n>]` writes the video on the machine running the CLI, on the same two modules `screenshot` uses, and raises its own request timeout past the recording so a long one cannot surface as a hang. An `unfinished-recording` refusal leaves no file at `--out`. **The answer also carries frames sliced from the finished recording** (`result.frames`): PNGs in recording order, scaled down and extracted on the **host** after the pull — never sampled during capture and never a second pass over the device. Extraction uses `ffmpeg` from `PATH`; a host without it refuses as `frame-extraction-unavailable` rather than returning an empty list, and no path in the extractor ever answers with an empty one — a decoder that exited cleanly having written nothing is `frame-extraction-failed` too. Frame count, frame width and total frame bytes are bounded; going over the byte budget is `frames-too-large` carrying both numbers, and the count bound — one above the longest recording at the densest sampling, since sampling rounds up — is enforced as a refusal too, because a capture of a still screen declares a longer timeline than it was asked for and can reach it (§6). The CLI exposes both knobs: `rover record <lease-id> --out <path> [--duration-ms <n>] [--frames-per-second <n>]`, each bounded before the call, and the command answers with both the video and the frames or with neither. **The answer also says what the recording contains** (#183): `result.container` carries the encoded sample count and the duration the **container** declares — read out of the pulled bytes on the host with no decoder, never assumed from the `durationMs` that was asked for, since §6 measures those as different numbers. A capture of a screen that never changed comes back as one sample of zero declared duration, and that case is **named** on the answer (`still-screen`) with the reason in words, because every other check in this verb passes for it and an agent that only sees one frame concludes the tool is broken. It stays `ok` with its one frame — recording an idle screen is legitimate — and bytes whose container this host cannot parse answer `unreadable` rather than throwing or claiming zero. **What frames are honest about is §8**: they sample motion. |
| `start_recording` / `stop_recording` | The same recording asked for as **two calls**, so the device can be driven inside it (#190, R43 phase 2). The start returns while the recorder is still running — the input verbs and `read_screen` work on that device under the same lease and end up in the recording — and the stop signals the recorder, waits on a condition for it to be gone, pulls the file and answers with **exactly what `record_video` answers with**: the same schema, the same normalised video on `result.artifact`, the same frames, the same `container` and the same `normalisation`. `record_video` is untouched; this is a second way to record. Both declare **`canControlRecording`**, which is deliberately not `canRecordVideo` (§5). The start takes no duration — the length is decided by when the stop is called — but the recorder is still given `MAX_RECORDING_MS` as its own kill switch, for the case nothing on the host can cover: since #191 the lease's end stops a recorder the caller walked away from (D9), and the limit is what bounds one whose *host* went away with it. A device holds **one** recording at a time: a second `start_recording`, or a `record_video` during an open session, is `recording-already-running` naming the device and the pids, never queued. Stopping with nothing recording and nothing left behind is `no-recording-running`; a recorder that reached its own limit first is **not** a failure, because the file it left is complete. Nothing on the host remembers that a recording is open — the device is asked (D6) — and because no window was ever named, the stop holds nothing across one: the file follows the recorder's own timeline, and a screen nobody drove is the same `still-screen` `record_video` reports, with nothing to stretch it across. |
| `device_info` | Size, density, computed width in dp, OS version. Needs no capability and addresses nothing on the screen — it answers with the `DeviceInfo` every result already carries (D14), asked for on its own |

### Waiting

| Verb | Notes |
|---|---|
| `wait_for` / `wait_until_gone` | Polling the screen until it happens, with a timeout. **Replaces `sleep`**, which is the main source of false results |

### App and environment

| Verb | Notes |
|---|---|
| `install_app` / `launch_app` / `stop_app` / `clear_app_data` | The last three address a **package**, so they resolve no target and need no capability — the backend methods behind them are required ones. `stop_app` cannot tell a stopped app from a package that was never installed (§6); the state after the action is what answers that. `install_app` is the one that crosses the machine boundary: the caller sends the package **as bytes from its own machine**, never a path, and the host writes it to a file of its own, installs it pinned to the leased device, and deletes the file. It carries no app id — the core knows no application's name (D13) — and a package over the named cap is refused by name rather than truncated (R24). **It also has a second shape, and it is the one that still knows no application's name** (R17 phase 3): a call with no `packageBase64` runs the `install` command declared by *the lease's project*, on the host, with `ROVER_DEVICE_SERIAL` set to the leased device — a verb the caller asks for, never something that happens at grant time, bounded at five minutes (a build, not a teardown; a quarter of the lease TTL; past the client's 30 s default, which such a caller has to raise) and **cancelled with the lease**: a build is the one thing a verb awaits that revoking a backend cannot stop, so the verb call carries an abort signal beside its guard and a release or an expiry kills the child — otherwise those five minutes would be not this caller's wait but the *device's*, since a restoration waits for the ending lease's verb calls and every `acquire_device` waits on the restoration. That wait is bounded anyway, the way the teardown's already was. No project registered, no `install` declared and a non-zero exit are three **named** failures carrying the exit code, the signal and a stderr tail, never `internal_error`; a lease that ended underneath one is the ordinary `no-lease` refusal instead, because a build stopped by its caller going away is not a build that failed. **The client sends the package** (R24 phase 2): `rover install <lease-id> <local-path>` reads it on the machine running the CLI and refuses a source that is missing, cannot be read, is not a regular file, or is over `MAX_TRANSFER_BYTES` **before connecting** — exit 2 with the command's usage, naming the file, its real size off `stat` and the limit, so the host is never asked and nothing partial is ever sent. **Verified on hardware with R24 phase 2** (§6, 2026-08-30): a real 29 487-byte APK installed through `rover install` and confirmed by `pm path` moving to `/data/app`. One *small* package — the cap that refuses a 45 MB one is unchanged |
| `read_logs` | Catches a failure a screenshot will not show. A **bounded** read — the most recent *n* entries, including the buffer the platform records crashes in, with a `truncated` flag so a short read is not read as a quiet device. No following: a tail that stays open is a wait with no condition and a stream over IPC |
| `set_airplane_mode` / `set_wifi` | See §6 — recipes that need no root |
| `pull_file` / `push_file` | The file crosses the boundary **as bytes in both directions**, and no path in either call or answer is a path on the host (D19). `push_file` takes the caller's bytes and a device path; `pull_file` takes a device path and answers with the bytes on `ActionResult.artifact`, exactly where `screenshot` puts a capture — so its result carries no path at all and the client writes the file wherever it likes. The device path is checked as a shape at the boundary (absolute, non-empty, bounded) rather than escaped, because it reaches the transfer as an argument and never as part of a command line a shell reads. One payload, one message: over the named cap is a refusal naming it, never a file cut to fit (R24). No recursive directory transfer. **Both directions are driven from the client** (R24 phase 2): `rover pull <lease-id> <device-path> --out <path>` writes the bytes on the machine running the CLI through the same `src/cli/_shared/artifact.ts` `screenshot` uses — so a refusal leaves no file at `--out` at all — and `rover push <lease-id> <local-path> <device-path>` reads its source through `src/cli/_shared/upload.ts`, which refuses a missing, unreadable, non-regular or over-sized source before any connection exists — the kind first, since only a regular file's size predicts the transfer (§6). The device path goes on the wire exactly as typed and is checked by `DevicePathSchema` at the host, not second-guessed by the client |

---

## 5. The device layer and the iOS seam

**iOS is being built now — this paragraph corrected in place on 2026-09-08.** What it said was
"iOS is not being built now, but the code has to accept it without a rewrite", and that was right
for exactly as long as nothing had been measured against the platform: the seam was a shape to keep
open rather than something with an implementation behind it. `docs/IOS.md` closed that — every
*required* method of the device interface has a working **simulator** implementation, and R44–R47
in §9.3 are the rows. What is still not being built is a **physical** iPhone (§9.4), which cannot
answer `screenshot` at all; that is why the backend is named `ios-simulator` rather than `ios`.

**Since #230 it is not merely built but *registered*** — R44 and R45 are both complete, and
`ios-simulator` is the second manifest in the registry beside `android`. So the seam is no longer
a shape being kept open: there is a second platform behind it, and the conformance suite is a loop
over two manifests rather than over one, which is the only arrangement in which a gate can tell a
passing backend from a check that stopped checking. R46 and R47 are what remain, and they are the
two capabilities that manifest declares **`false`** and can honestly flip later.

The sentence's actual point is untouched, which is why it is rewritten rather than deleted: the
seam does **not** run along "adb versus simctl" — it runs along the device interface: enumeration,
lifecycle, installation, app control, screenshot, hierarchy read, input, the **system-log read**,
and the **two file transfers**.

Some things worth knowing now, so as not to design into a corner:

- **`simctl` can neither tap nor dump a hierarchy.** It can do screenshots, installation and
  lifecycle. Input and tree reads need `idb` or WebDriverAgent — a heavy dependency with a
  lifecycle of its own.
- **Semantic screen reading is not the platform asymmetry this claimed — corrected in place on
  2026-09-08.** What it said was that there is no cheap equivalent on iOS, and that it "may not be
  possible at all". That was a guess, and `docs/IOS.md` §2 and §9 measured it **false for the
  simulator**: `idb ui describe-all` is a full semantic read with labels, roles, traits and point
  frames, and it works on a Compose Multiplatform app. It was a reasonable guess while the only
  evidence was the bullet above — the first-party tool cannot dump a tree — which remains true and
  is the whole cost. What the correction does **not** touch is D11's conclusion immediately below:
  `read_screen` stays a declared capability rather than a required method, because a second program
  with a lifecycle of its own is still what pays for it on that platform. What changes is the
  *reason it matters per platform*, and it inverts: on Android the tree is what survives a
  screenshot an app blocked with `FLAG_SECURE`, while iOS has no such flag and the capture is what
  never gets blocked — so there the tree is a convenience rather than a rescue (`docs/IOS.md` §8).
- Hence D11: `read_screen` **is not a required method** of the interface. It is a declared
  capability the verb layer asks about before using it.
- **Moving a file is not one of those divergences either.** `pushFile` and `pullFile` are
  required methods for the same reason: every platform this targets can put a file on a device
  and take one off it, and the asymmetry that matters is in the *direction*, not the platform —
  a push takes a path on the host, because the host is where the daemon runs, while a pull
  answers with **bytes**, because the answer is read on the agent's machine (D19).
- **A system log is not one of those divergences**, and `readLogs` is therefore a *required*
  method rather than a capability: every platform this targets keeps one, and a flag that is
  always `true` would be noise (`src/core/capabilities.ts`). What differs between platforms is
  the wording inside an entry, which is what the neutral `LogEntry` shape and each backend's own
  parser are for.
- **Holding a recording open is its own divergence**, so `canControlRecording` is a flag of its
  own rather than `canRecordVideo` widened (#190). Capturing a fixed-length recording and holding
  one open while the caller drives the device are different abilities, and a platform whose
  recorder is one command taking a duration — with no process to signal and no way to signal it —
  gives a perfectly good `record_video` and cannot give the other at all. That is a **narrower
  backend rather than a broken one**, and D11's whole point is that it says so by name instead of
  failing at the call. `canRecordVideo` names exactly one method and keeps meaning exactly that.
  The flag names a **third** method since #191 — `discardRecording`, which the lease-end teardown
  calls to stop a recorder somebody abandoned and remove its file. It is the same ability under
  the same flag: a backend that can signal a recorder it is holding open can signal one it is not.
- **A key a platform has no equivalent for is not a divergence a capability can name**, and this
  is the boundary of the whole model rather than an exception to it (#215). Capabilities name
  **methods** (D11, and `CAPABILITY_METHODS`' `as const satisfies` is what keeps that honest), so
  a flag per key would put four booleans behind one method and leave `canInput` meaning nothing;
  and declaring `canInput: false` to dodge one key would refuse `tap`, `swipe` and `type_text`,
  which work. The answer is a **per-argument refusal that names the key** — an `unsupported-key`
  verb failure carrying the serial and the key, on `unsupported-text`'s exact model one argument
  down — so `DeviceKey` stays one shared vocabulary and a backend stays honest in both directions:
  it answers the keys it has, and refuses the ones it does not without claiming it takes no input.
  Answering such a key with something that is *not* the key asked for would be the silent
  degradation ai/RULES.md §2 forbids, sharpened by the fact that the injection tooling accepts a
  key name it does not know in silence and exits 0 (§6).

---

## 6. Technical findings (verified empirically)

Checked on an API 37 emulator, 2026-08-27. The received recipes circulating on the internet are
partly dead here.

- **`svc wifi` and `svc data` no longer exist.** On API 37, `svc` has only `power`, `usb`, `nfc`
  and `system-server`. Every guide using `svc wifi disable` is out of date.
- **Works, without root:** `cmd connectivity airplane-mode enable|disable`
  and `cmd wifi set-wifi-enabled enabled`.
- **`input` on API 37 offers:** `tap`, `swipe`, `draganddrop`, `motionevent`,
  `scroll --axis VSCROLL,n`, `keyevent`, `keycombination`, `text`.
- **A long press is not `keyevent --longpress`** — that flag applies to keys, not to touch. It is
  done with a drag from a point to the same point with a given duration.
- **Fingerprint on an emulator:** `adb emu finger touch 1`. On a physical device you need a real
  finger — the sharpest emulator/phone asymmetry there is.
- **The px→dp scale is `wm density` ÷ 160**, derived from the device every time. Never from the
  screenshot width — that mistake yields a 5% skew in one direction, so it looks like a pile of
  small imperfections rather than an arithmetic error, which is exactly why it survives.
- **A screenshot can be black while the app is healthy.** An app may block screen capture; the
  system then hands back a black buffer with no error in the log. The check: a screenshot of the
  system home screen. The view hierarchy remains readable in that case.

Checked on an API 37 emulator (`sdk_gphone16k_arm64`) with `adb` 37.0.0, 2026-08-29, while
capturing `tests/fixtures/adb/`:

- **`ro.kernel.qemu` is still `1` on API 37.** It is widely described as removed, and it is not —
  alongside `ro.boot.qemu=1`, `ro.hardware=ranchu` and `ro.build.characteristics=emulator`. Any of
  the four identifies an emulator; none of them is the serial or the model, which is the point.
- **`adb`'s `* daemon not running; starting now …` banner goes to stderr, not stdout.** It only
  reaches a device-list parser when the caller merges the two streams — but a daemon that then
  *fails* to start prints `error: cannot connect to daemon at tcp:5037 …` on the same stream, above
  the `List of devices attached` header. Parse the device list anchored on that header: a parser
  that merely skips known prefixes reads the error line as a device with the serial `error:`.
- **`wm size` and `wm density` print an `Override …` line only once one is set**, and `wm size
  reset` / `wm density reset` remove it. The override, not the physical value, is what the device
  renders at — so it is the one a coordinate and the dp scale belong to.
- **The verified view-hierarchy dump recipe is two commands, and the second must be `exec-out`:**

  ```bash
  adb -s "$SERIAL" shell uiautomator dump /sdcard/window_dump.xml
  adb -s "$SERIAL" exec-out cat /sdcard/window_dump.xml > window_dump.xml
  adb -s "$SERIAL" shell rm /sdcard/window_dump.xml
  ```

  `adb shell cat` translates `\n` → `\r\n` and corrupts the XML. `uiautomator dump /dev/tty` is the
  other shortcut every guide shows and is also wrong: it interleaves adb's own
  `UI hierchary dumped to: …` line (adb's typo, not this document's) with the document.
- **A node clipped by a scrolling container comes back with inverted `bounds`.** The last visible
  row of the Settings → Display & touch dump is `bounds="[96,2798][399,2784]"` — its top *below*
  its bottom, so `bottom - top` is -14. `parseUiHierarchy` reports that subtraction as it stands
  rather than clamping it to zero, because every target resolution downstream is addressed through
  this rectangle and a clamped one is a rectangle the device never described. Whether a node is on
  screen is the caller's question, and the sign is the evidence it needs to answer. `src/verbs/`
  is that caller and now answers it: a matched element whose rectangle has no interior, or whose
  centre is off the device, is an `UnaddressableElementError` rather than a point to act on.

Checked on the same API 37 emulator (`sdk_gphone16k_arm64`) with `adb` 37.0.1, 2026-08-29, while
building the app-control primitives (#37). Every one of the four verbs reports at least one failure
in a way its exit code does not:

- **`adb install` does not print `Success` on its own.** A successful `adb -s $S install -r <apk>`
  prints four lines — `Serving...`, `Performing Incremental Install`, `Success`,
  `Install command complete in 49 ms` — and writes `All files should be loaded. Notifying the
  device.` **to stderr on the success path**. So `stdout.trim() === 'Success'` rejects an install
  that worked, and so does "stderr must be empty". The assertion is a `Success` *line*.
- **`adb install` failures are `Failure [INSTALL_…]` on stderr** on this adb, with exit 1 —
  `INSTALL_PARSE_FAILED_NOT_APK` for a file that is not an APK, `INSTALL_FAILED_TEST_ONLY` for a
  debug build without `-t`, `INSTALL_FAILED_UPDATE_INCOMPATIBLE` for a signature mismatch. The
  exit-0-with-`Failure`-on-stdout shape every guide of the era describes was not reproduced here,
  which is exactly why the check reads the output rather than the exit code: the two shapes cost
  the same to handle and only one of them is silent.
- **`cmd package resolve-activity --brief <pkg>` is not brief.** It prints
  `priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true` *above* the
  component, so the answer is the **last** line. It answers `No activity found` on stdout with
  **exit 0** both for a package that is not installed and for one that is installed with nothing
  launchable — indistinguishable, and neither is a component name. Adding
  `-c android.intent.category.LAUNCHER` changed the answer for none of the six packages tried, and
  no package resolved to `android/…ResolverActivity` instead of failing.
- **`am start -n <component>` prints `Starting: Intent {…}` before anything can have gone wrong**,
  so that line alone is not evidence of a launch. A component that does not exist adds
  `Error type 3` / `Error: Activity class {…} does not exist.` — on **stderr**, exit 1 — and one
  that is not exported adds a `java.lang.SecurityException: Permission Denial` stack trace under
  `Exception occurred while executing 'start':`, exit 255. `Warning: Activity not started, intent
  has been delivered to currently running top-most instance.` is the opposite: the app was already
  on top, which is a launch that succeeded.
- **`monkey -p <pkg> -c android.intent.category.LAUNCHER 1` is the worse recipe, measured.** It
  answers a package with no launchable activity and a package that is not installed with the *same*
  `** No activities found to run, monkey aborted.` line, never names the component it started, and
  echoes its own argv on both streams around the answer. `resolve-activity` then `am start -n` is
  two calls and tells you which of the two went wrong.
- **`am force-stop` has no success wording at all — and no failure wording either.** A force-stop
  that worked prints **zero bytes** on both streams and exits 0; `am force-stop
  com.rover.no.such.package` prints zero bytes on both streams and exits 0 as well. So this verb
  cannot distinguish "stopped it" from "there was nothing by that name", and a typo in an app id is
  a silent no-op at the primitive layer. Silence is the only assertable success; anything printed
  is a failure (a missing argument is `IllegalArgumentException`, exit 255). Whether the app is
  really gone is the verb layer's post-state to answer by reading the device (D12, #11).
- **`pm clear` says `Success` on stdout, and refuses with a bare `Failed` on stderr** (exit 1, for
  a package that is not installed) — one word, no package name, nothing else. The error a caller
  sees has to add the app id and the device itself, because adb's own message identifies neither.

Re-checked on the same emulator with `adb` 37.0.1 while responding to the review of #40, 2026-08-29.
All four are about the *argument* side of the same discipline — what goes **into** an adb command
rather than what comes out of one:

- **`adb shell a b c` is not an argv on the device.** adb joins the arguments with single spaces
  and hands the resulting string to the device's own `sh`, so every metacharacter in them is that
  shell's. `execFile` protects the host shell and nothing else. Measured:
  `adb -s $S shell am force-stop 'com.rover.nope;echo INJECTED'` printed `INJECTED` and exited 0,
  and `adb -s $S shell pm clear 'com.rover.nope; echo Success'` came back with `Success` on stdout,
  `Failed` on stderr and **exit 0** — a clear that never happened, reported as done, through the
  same output check that exists to catch exactly that. So an app id is parsed to a shape before it
  is used (`parseAppId`) and quoted at the call site (`shellArg`), not one or the other.
- **An unquoted `$` in a component silently launches the wrong activity.**
  `am start -n com.android.settings/.Settings$MyDeviceInfoActivity` started plain `.Settings` and
  exited 0 — the device's shell expanded `$MyDeviceInfoActivity` to nothing — while
  `am start -n 'com.android.settings/.Settings$MyDeviceInfoActivity'` started the activity asked
  for. Inner-class activities are the common case, not an exotic one: `cmd package query-activities`
  lists forty of them under Settings alone. A component is device output on its way back into a
  device-side command line, and it is quoted for the same reason an app id is.
- **The `* daemon …` banner reaches every verb, not just the device list.** It is written by the
  adb *client* before it dispatches any subcommand, so it lands on the stderr of whatever ran
  first after a server restart. Captured on a `force-stop` that worked:
  `adb kill-server; adb -s $S wait-for-device shell am force-stop com.android.settings` exits 0 with
  an empty stdout and `* daemon not running …` / `* daemon started successfully` on stderr. Any
  "this stream must be empty" assertion is defeated by it intermittently and unreproducibly, which
  is why the filter is one shared predicate rather than a rule each verb re-derives. (On this
  emulator a plain `-s $S` command in the same position exits 1 with `adb: device offline` instead,
  which the runner already turns into a failure — the silent shape needs the device to be reachable
  the moment the server comes up.)
- **A successful `adb install -r` prints two lines here, not the four §6 recorded above.**
  `Performing Streamed Install` / `Success`, empty stderr — adb picked the streamed path rather
  than the incremental one for this APK. Both captures are in `tests/fixtures/adb/`, and both
  defeat `stdout.trim() === 'Success'`, which is the point: the number of lines around the word is
  not a fact worth depending on. `install -r` of a debug build also fails with
  `INSTALL_FAILED_TEST_ONLY: … Did you forget to add -t?` (exit 1) — the flag is not one the
  primitive passes, so a test-only APK is a caller's problem to know about.

Checked on the same API 37 emulator (`sdk_gphone16k_arm64`, 1080×2424) with `adb` 37.0.1 and
`platform-tools` on macOS, 2026-08-29, while building `screenshot` (#38):

- **The verified capture recipe is `adb -s "$SERIAL" exec-out screencap -p`**, and what comes back
  is a PNG the device encoded — 1 331 469 bytes for that screen, `89 50 4e 47 0d 0a 1a 0a` /
  `IHDR 1080×2424 RGBA`. Two consequences for the caller: it is **past Node's 1 MB default
  `maxBuffer`** already, on a modest screen, and `execFile` answers an overflow by killing the
  child, so a capture path that does not raise the limit loses the frame and reports it as a
  process failure. And it costs **2.4 s** (three runs: 2.42, 2.39, 2.30) where every other query
  here is milliseconds, which is a timeout worth setting deliberately rather than inheriting.
- **`adb shell screencap -p` did *not* corrupt the stream on this adb** — byte-identical to the
  `exec-out` capture, with stdout redirected to a file. Neither did `adb shell cat` of a hierarchy
  dump, which §6 above records as corrupting. Both findings stand: the `\n` → `\r\n` translation
  happens when adb allocates a pty, which it decides from the call rather than from the payload, so
  it is **conditional on the adb version, the platform and whether stdin is a terminal**. That is
  the worst possible shape for a bug — it works on the machine it was written on and corrupts every
  frame on someone else's — and it is why the recipe stays `exec-out`, which never allocates one.
  Cheap insurance, and the check that catches it if it is ever traded away is the PNG signature.
- **A screenshot is the one verb whose output cannot be judged by looking at it**, so the assertion
  that says the bytes are a picture of *this* device is the IHDR size against `wm size` — compared
  as an unordered pair, because the capture follows the current rotation while `wm size` reports
  the panel.

Not device findings, but the same kind of trap — observed on macOS 25.6 / Node 25.2 while building
the daemon's unix socket transport (R6), 2026-08-29:

- **A unix socket path is capped at 103 bytes** (`sun_path` is 104 bytes on macOS, 108 on Linux,
  NUL included). Over the cap, `bind` does not report the length — it truncates or answers
  `EINVAL`, and the daemon appears to start on an address nobody can find. `resolveSocketPath`
  rejects it up front, naming the limit and the path.
- **Connecting to a plain file sitting at a socket path answers `ENOTSOCK`, not `ECONNREFUSED`.**
  The stale-socket recovery treats *any* probe failure as "nothing is serving here" for exactly
  this reason: a list of error codes is a list to get wrong on the next platform.
- **`net.Server` has no `closeAllConnections()`** — that one is `http.Server`'s. Without it,
  `server.close()` resolves only when the last connection ends, so a daemon asked to shut down with
  one idle client attached never exits. The daemon tracks its live sockets and destroys them.
- **`import.meta.resolve` is absent under a transform.** It works under `tsx`, and Vitest's SSR
  transform replaces `import.meta` with a shim that has no `resolve`, so autostart falls back to the
  bare `tsx/esm` specifier resolved from the child's cwd. Propagating `process.execArgv` is not a
  substitute: a Vitest worker's `execArgv` does not carry the loader.
- **`node --import tsx/esm <absolute script>` resolves the loader against the *cwd*, not against
  the script** (found 2026-08-31 while taking the MVP through a real project, #104). Making the
  script path absolute changes nothing: `tsx/esm` is a bare specifier and a `--import` argument is
  resolved like a cwd-relative import, so the documented MCP entry started inside this checkout and
  died everywhere else with `Cannot find package 'tsx' imported from <the caller's directory>/` —
  before a single protocol frame, and in the one invocation an MCP client chooses the directory
  for. The fix is a plain `.mjs` launcher (`bin/rover-mcp.mjs`): a bare specifier written *inside* a
  module is resolved by walking up from **that module's** URL, so `import('tsx/esm/api')` there
  finds the checkout's own loader whatever the cwd. Note the asymmetry with the finding above —
  the daemon's autostart is unaffected because it spawns with `cwd: PACKAGE_ROOT`, which is exactly
  what an MCP client does not do. Testing it needs a spawn from a different `cwd`, with no
  `node_modules` above it; no assertion on a string can see a resolution failure.
- **Every project's Rover MCP server dies when *this* checkout's `node_modules` does, and the
  operator is told nothing** (hit 2026-09-08). The launcher above runs Rover **from source**, so
  each consumer project's `.mcp.json` points `node` at `bin/rover-mcp.mjs` here and the server needs
  this checkout's `tsx` — a **devDependency**. So an empty or pruned `node_modules` in this
  directory takes the MCP server down in every project at once, while the checkout looks fine: `git
  status` is clean, because `node_modules` is not tracked. What was observed: the directory existed
  and held **zero** entries, with no npm log for the minute it was emptied, so npm was not what did
  it — an interrupted `npm ci`, a manual `rm -rf`, or a cleanup step in an agent's worktree all end
  the same way, and the cause is not recoverable after the fact. `npm ci` restores it in about three
  seconds.
  **What makes it cost an hour rather than a minute is the diagnosis, not the fix.** The launcher
  already prints exactly the right sentence — *the TypeScript loader is not installed in
  `<checkout>` — run `npm install` there* — but it prints it to **stderr**, and an MCP client
  swallows a failed server's stderr and reports only that the server failed to start. So the useful
  message exists and is unreachable from where the operator is standing. The way to see it is to run
  the handshake by hand, from a foreign `cwd`, which is the same spawn the finding above says a test
  needs:
  ```bash
  cd /tmp && printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
    '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
    | node /abs/path/to/rover/bin/rover-mcp.mjs
  ```
  A healthy server answers `initialize` and lists 25 tools; a broken one prints the sentence. Run
  against a **consumer** project's directory it also proves the whole path — `status` and
  `list_devices` through the same pipe reach the daemon (D5's autostart included), which is what
  separates "the MCP entry is broken" from "the daemon is down".
- **Killing a daemon can hand the socket to one that was still starting.** Several concurrent
  first calls spawn several daemons; the losers exit when they find the path bound, but one still
  starting when the winner is killed finds the path free and binds it. That is correct behaviour —
  and it means a test that starts daemons has to drain the path, not stop one process and assume.
- **`unlink` takes the path, not the inode you decided was dead.** Stale-socket recovery stats the
  path, probes it, stats it again and removes it — and two reclaimers after a crash can both reach
  that last step, so the second one deletes the socket the first has just bound and strands a live
  daemon on an unreachable inode. Comparing inodes narrows the window; it cannot close it, because
  there is no compare-and-delete in the filesystem. The *unlink* is therefore serialized by a
  short-lived `O_EXCL` lock file beside the socket (`<socket>.reclaim`), held across the unlink and
  the re-bind. The lock is not the election — `listen()` still is — and it is discarded on age, so
  a process killed while holding it cannot make the path unreclaimable the way a PID file would.

Checked on the same API 37 emulator (`sdk_gphone16k_arm64`) with `adb` 37.0.1-15733141 while
building the device-change stream (#7), 2026-08-29. The verified recipe for watching the attached
set is `adb track-devices -l`, and every trap below cost something to find:

- **`adb track-devices` is undocumented: it appears nowhere in `adb --help`** (and there is no
  `adb help-all` on this build) — and
  it is the recipe: it streams the device list for as long as it runs, so nothing has to poll. `-l`
  gives exactly the `adb devices -l` long format **minus the `List of devices attached` header**.
- **Its framing is four lowercase hex digits of payload byte length, then the payload**, with no
  separator before the next frame's digits:

  ```
  0074emulator-5554          device product:… model:… device:… transport_id:1\n
  ```

  `0x74` is 116, which is that line **including its trailing newline** — the length covers the
  payload and nothing else. The prefix width is also the bound on a frame: 65535 bytes, so a
  decoder needs no cap of its own.
- **Every change re-emits the whole list, never a delta.** Captured across an
  `adb connect localhost:5555` / `adb disconnect` cycle (the fixture behind
  `parsers/track.test.ts`), seven frames arrived, each one a complete list — including the
  intermediate `offline` and `authorizing` states of the entry that was still negotiating.
- **When the adb server dies, the tracker exits 0** with an empty stderr. Verified by tracking
  against a server on a spare port and killing it: `adb -P 5039 track-devices -l` ended `EXIT=0`.
  So a clean end of stream is **not** "no devices attached" — it is "the source of truth went
  away", and delivering it as an empty list tells an inventory that every device vanished at the
  moment the host lost the ability to know anything. It is also why a tracker must be restarted on
  a bounded backoff: `adb kill-server` is routine on a developer's machine, and without a restart
  the host goes permanently blind after it.
- **The `* daemon not running; starting now at tcp:5040` / `* daemon started successfully` banner
  arrives on the tracker's own stderr, on the success path** — the same trap this section already
  records for `adb devices`. Non-empty stderr is not a failure; it is context for whatever the run
  eventually does.
- **The serial is the only thing that distinguishes a `connect`ed device from a local one.** With
  `adb connect localhost:5555` pointed at the already-attached `emulator-5554`:

  | Query | `emulator-5554` | `localhost:5555` |
  |---|---|---|
  | `adb devices -l` tail | `product:sdk_gphone16k_arm64 model:… device:emu64a16k` | **identical** |
  | `track-devices --proto-text` `connection_type` | `SOCKET` | `SOCKET` |
  | `adb get-devpath` | `unknown` | `unknown` |
  | `adb get-state` | `device` | `device` |

  Two entries, one physical device, and nothing but the serial telling them apart — D18's failure
  mode reproduced in miniature on one machine. So classifying whether a device is physically
  attached here, or only reachable through a network transport, reads the serial
  (`src/backends/android/attachment.ts`), which is the **one** deliberate exception to
  "never infer anything from a serial": transport is not a fact about the device, it is a fact
  about how this host reached it, and `adb connect HOST[:PORT]` writes that address into the serial
  itself.

Checked on the same API 37 emulator (`sdk_gphone16k_arm64`) with `adb` 37.0.1-15733141 while
building the environment primitives (#9), 2026-08-29. §6 above vouched for the two recipes and
recorded nothing about what they print — this is that half, and the last bullet is the one phase 2's
step order depends on:

- **`svc` still has no `wifi` and no `data`.** Re-confirmed on this build: `adb -s $S shell svc`
  lists `power`, `usb`, `nfc`, `system-server` and nothing else. The recipes below are the
  replacements, and both run without root.
- **Both recipes are completely silent on success, and exit 0.** `cmd connectivity airplane-mode
  enable|disable` and `cmd wifi set-wifi-enabled enabled|disabled` each printed **zero bytes on
  both streams** — the same shape `am force-stop` has, so silence is the only assertable success
  and anything printed is a failure. `set-wifi-enabled disabled`, the one argument §6 had never
  vouched for, behaves exactly like its counterpart.
- **Both are idempotent and equally silent about it.** Disabling airplane mode that is already off,
  or asking twice for wifi the device already has, is zero bytes and exit 0 as well — so a
  restoration routine may set the resting state unconditionally without a read first.
- **Their two vocabularies do not match, and a wrong word is loud.** `airplane-mode` takes
  `enable`/`disable`; `set-wifi-enabled` takes `enabled`/`disabled`. Crossing them is not a silent
  no-op: `cmd wifi set-wifi-enabled true` answers `Invalid args for set-wifi-enabled:
  java.lang.IllegalArgumentException: Expected 'enabled' or 'disabled' as next arg but got 'true'`,
  and `cmd connectivity airplane-mode nonsense` prints the connectivity service's entire help text
  — both **on stdout with an empty stderr**, exit 255. That is the opposite of `am start`, which
  puts its refusals on stderr, and it is why the check reads both streams rather than picking one.
- **Here, unlike the app verbs, the exit code is trustworthy too** — every refusal captured exited
  255 while every success exited 0, so `runAdb` rejects a bad argument before any predicate sees it.
  The predicate still refuses printed output: an exit code that happens to agree today is not a
  reason to stop reading what the device said.
- **`cmd connectivity airplane-mode` with no argument is a getter** — it answers `disabled` /
  `enabled` on stdout, exit 0. `cmd wifi status` is the wifi counterpart, whose first line is
  `Wifi is enabled` / `Wifi is disabled`. Noted rather than used: `DeviceBackend` has no
  network-state getter, and adding one is not #9's job.
- **Airplane mode moves wifi as a side effect, and the direction depends on state the device
  remembers.** Both were observed on this one emulator within one session, with
  `settings get global wifi_on` naming which: from `wifi_on=1` (on), `airplane-mode enable` gave
  `wifi_on=3` and `Wifi is disabled` — but after wifi had once been switched on *while airplane
  mode was on* (`wifi_on=2`, the Android 13+ "wifi stays on in airplane mode" override), the very
  next `airplane-mode enable` left it at `wifi_on=2` and `Wifi is enabled`. `wifi_apm_state` reads
  `null` throughout, so the remembered bit is not visible in `settings`. **Turning airplane mode
  off never switches wifi on**: with wifi off and airplane mode on, `airplane-mode disable` left
  `wifi_on=0` and `Wifi is disabled`. The reverse is not true — `set-wifi-enabled` never changed
  `airplane_mode_on`, and `set-wifi-enabled enabled` is honoured while airplane mode is still on.
  So a restoration routine (R9) must set **both** explicitly and set **wifi last**: the airplane
  step can move wifi underneath it, in a direction no caller can predict, while the wifi step
  cannot move airplane mode.

Checked on the same API 37 emulator (`sdk_gphone16k_arm64`, Android 17, 1280×2856 at density
480) with `adb` 37.0.0-14910828 while building the input primitives (#12), 2026-08-30. §6 above
recorded what `input` *offers* and that a long press is a drag in place; this is what each recipe
prints, what coordinate space it takes, and what `input text` does with a caller's string:

- **All four recipes are completely silent on success, and exit 0.** `input tap <x> <y>`,
  `input swipe <x1> <y1> <x2> <y2> <ms>`, `input text <string>` and `input keyevent <code>` each
  printed **zero bytes on both streams** — the same shape `am force-stop` and the two network
  recipes have, so silence is the only assertable success.
- **`input` accepts a great deal of nonsense in exactly that silence, and that is the finding the
  whole capability is built around.** `input keyevent NOT_A_KEY`, `KEYCODE_NOPE`, `999999` and
  `-5` each exited **0 with zero bytes on both streams** and did nothing. So did
  `input tap 99999 99999`, far outside a 1280×2856 panel. Neither a predicate nor a device test
  can tell any of those from work that was done — which is why the keycode table and the dp→px
  conversion are pinned in unit tests, and why a wrong keycode would otherwise be a verb that
  reports success forever.
- **A malformed argv is loud, at exit 255 on stderr.** `input tap` with no arguments, `input tap
  x y`, `input text` with no argument and `input swipe … abc` each answered `Exception occurred
  while executing '<sub>':` above a Java stack trace headed by an `IllegalArgumentException`, and
  exited 255 — so `runAdb` rejects them before any predicate is consulted. **The one refusal that
  exits 0** is `input`'s own dispatch failure: `Unknown command: <x>` on **stdout**, exit 0, which
  is the opposite stream from `am start`'s refusals and is what `parsers/input.ts` exists to
  catch.
- **`input` takes physical pixels, and `Point` is dp — this backend converts.** `wm size` and the
  hierarchy bounds agree at 1280×2856 while `wm density` reports 480, so the scale is 3; a tap at
  the Settings search bar's pixel bounds landed on it, and the same numbers read as dp would have
  landed in the status bar. The scale is `wm density ÷ 160`, asked of the device on **every**
  injection rather than cached — `wm density <n>` changes it under a running lease — and
  `read_screen` (#13) divides by the same number on the way back. The conversion floors, because
  the question is which pixel a point is *in* rather than which pixel centre it is nearest. Note
  that `widthPx / scale` is a rounded double, so the very largest dp coordinate the verb layer
  admits can still multiply back to `widthPx` itself, one column past the panel: one dp value out
  of a whole panel width, recorded rather than defended against, because clamping it needs a
  second query on the hot path of every injection.
- **A drag in place really is a long press, and the threshold is a device *setting*.** Long
  pressing the empty home-screen wallpaper raised the Wallpaper/Widgets/Home-settings menu at
  `input swipe 640 1500 640 1500 390` and did **not** at `380` — matching this device's
  `settings get secure long_press_timeout`, which reads `400`. A plain `input tap` at the same
  point never raised it. So the primitive stays the plain `swipe` with no default duration baked
  in; phase 2's `long_press` should sit comfortably above the threshold rather than on it,
  because the number is per-device configuration.
- **A space needs no `%s` once the argument is quoted.** `input text 'hello world'` typed
  `hello world`, and `'a  b'` kept both spaces — so the `%s` substitution every guide shows is
  not used here at all. All 95 printable ASCII characters (U+0020–U+007E) typed verbatim in a
  single call, backslash included, and one word carrying every shell metacharacter — ampersand,
  pipe, semicolon, dollar, backtick, double quote, parentheses and glob characters — arrived in
  the field unchanged once wrapped in single quotes.
- **`%s` is `input text`'s escape for a space, and only that exact sequence.** `'a%sb'` typed
  `a b`, while `'100%'`, `'%'`, `'%S'` and `'a%'` all typed verbatim. So a caller's literal `%s`
  is not representable in one call — and is representable in two: `'a%'` followed by `'sb'` typed
  `a%sb`. `typeText` cuts the string between the `%` and the `s` of each occurrence for that
  reason, and everything without a `%s` is still exactly one injection.
- **An apostrophe is ordinary text and is escaped rather than refused.** The device-side argument
  `'don'\''t'` typed `don't`. That is why `shellText` sits beside `shellArg` rather than
  replacing it: `shellArg` refuses a `'` because everything it quotes has had its shape checked
  already, while screen content legitimately carries one.
- **`input text` drops a tab and a newline in silence.** `'a<TAB>b'` and `'a<LF>b'` each exited 0
  with zero bytes on both streams and put `ab` in the field. Nothing downstream can see that
  happened.
- **Any non-ASCII character throws inside the device, and nothing at all is typed.** `'zażółć'`,
  `'日本語'`, `'a🙂b'` and `'ab±cd'` each exited **255** with `java.lang.NullPointerException:
  Attempt to get length of null array` from `InputShellCommand.sendText` — `KeyCharacterMap` has
  no events for the character — and the field was left completely unchanged rather than partially
  typed. Loud, but as a stack trace about a null array rather than as anything a caller can act
  on. `typeText` therefore refuses anything outside U+0020–U+007E *before* the call, naming the
  offending characters; the same rule covers the silent tab-and-newline case above, which nothing
  else would.
- **`input text ''` is a legal no-op** — exit 0, nothing printed, nothing typed.

Checked on the same API 37 emulator (`sdk_gphone16k_arm64`) with `adb` 37.0.0, **2026-08-30**,
while building `readScreen` (#13 phase 1). The two-command recipe above is unchanged and still
correct; what follows is what building on it measured.

- **`uiautomator dump`'s confirmation goes to stdout, and stderr is empty.** Captured with
  `> f 2>&1` and then again with the streams separated:
  `UI hierchary dumped to: /sdcard/window_dump.xml\n` on stdout, zero bytes on stderr, exit 0.
  Worth pinning rather than assuming, because this is the one family of commands where adb's
  choice of stream is not predictable — `am start`, `pm clear` and `install` each put their real
  failures on the stream nobody expects.
- **That confirmation is a claim about a path, not proof of a file.**
  `uiautomator dump /data/nope/window_dump.xml` printed exactly the same line, naming that path,
  and **exited 0 having written nothing** — `ls /data/nope/window_dump.xml` afterwards is
  `No such file or directory`. So a predicate that reads the line as "the dump succeeded" is
  wrong; `parsers/uiautomator.ts` answers the *path* instead, and `readScreen` compares it to the
  one it asked for. What that comparison buys is freshness: the dump path is a fixed literal and
  can already hold a previous read's document, so a dump that produced nothing followed by a `cat`
  that succeeds would hand back a screen from a minute ago, indistinguishable from the current one.
- **`ERROR: could not get idle state` could not be reproduced here.** That widely-reported
  failure needs a screen that will not settle; a dump racing a fling, and a dump under five
  concurrent flings, each returned the ordinary confirmation. `readScreen`
  reports the shape loudly through `refused(...)` if a device ever produces it, and deliberately
  does **not** retry — a retry loop is a wait, and waiting belongs to `src/core/wait.ts` and the
  wait verbs rather than inside a primitive. No fixture was invented for it
  (`tests/fixtures/adb/README.md` says so).
- **Two `uiautomator dump`s at once on one device get one of them killed — exit 137, both
  streams empty.** Two `adb -s … shell uiautomator dump /sdcard/window_dump.xml` started
  together: one printed the ordinary confirmation at exit 0 and the other exited **137** having
  printed nothing at all on either stream (3 runs out of 3, 2026-08-30; which of the two loses is
  not predictable). 137 is SIGKILL — the device kills the second instance rather than queueing
  it — so the failure arrives as an `AdbCommandError` with no wording to read, not as a dump that
  says something. The narrower window on the same shared path costs the same: one read's
  `rm` landing between the other's dump and its `cat` leaves the `cat` with no file.
  This is not an exotic case — the IPC server dispatches frames without awaiting them, so a
  client holding one lease can have two verbs reading one device — and it is why
  `AndroidDeviceBackend` queues its reads per serial rather than letting the device arbitrate.
- **`read_screen` works while the app blocks screen capture — verified, and this is R13's own
  acceptance criterion.** On the Settings PIN-entry screen
  (`com.android.settings/…password.ChooseLockPassword`, reached with
  `am start -a android.app.action.SET_NEW_PASSWORD` and two taps),
  `exec-out screencap -p` came back a valid PNG of the full 1280×2856 panel with **every sampled
  pixel at luminance 0** — 20 KB against 1.7 MB for the same panel on the launcher — while
  `readScreen` on the same screen returned a full list of elements — `Set a PIN`, `CLEAR`, `NEXT`
  and a `PIN area` label among them, each with its rectangle. That asymmetry is the whole reason the hierarchy
  read is a first-class verb rather than a fallback for when a screenshot is inconvenient. The
  device was left as it was found: three `KEYCODE_BACK`s out of the flow, no lock set
  (`locksettings get-disabled` still `true`).
- **Rotation is a known, unfixed asymmetry, and it is the hierarchy's turn to have it.** The dump's
  bounds follow the **current surface** while `wm size` reports the **panel**, exactly as the
  capture does (the `screencap` entry above, and `tests/device/android/screenshot.test.ts`). On a rotated device `ScreenInfo.widthDp` and the
  root node's width are therefore each other's transpose, and `requireAddressable()` in
  `src/verbs/target.ts` could reject an element that is plainly visible. Recorded rather than
  fixed: the fix is a rotation-aware `ScreenInfo`, which is a row of its own.
  `tests/device/android/backend.test.ts` compares the two as an unordered pair for this reason,
  which still catches a missing px→dp conversion — the thing that assertion is for — without
  pretending rotation is handled.

Checked on the same emulator while landing the gesture verbs over those primitives (#60, phase 2
of #12), 2026-08-30:

- **A screen-wide `scroll` whose drag starts over the on-screen keyboard is read as gesture
  typing, not as a scroll.** `scroll 'down'` with no target starts a quarter up from the bottom of
  the *screen*, and on a screen showing a keyboard that band is inside it: the keyboard took the
  drag and typed `ty` into the focused search field while the list underneath did not move.
  Nothing failed — the injection exited 0 and the verb answered with an ordinary-looking result.
  So a scroll with no target is a scroll of *whatever occupies that band*, and naming the region
  is what makes it a scroll of the list. The verb has no way to tell the two apart until
  `read_screen` (#13) gives it something to check against, which is why the region is a parameter
  rather than something guessed.
- **`long_press` and `scroll` both do on hardware what their names say.** The verb's default
  800 ms drag in place at the middle of the home screen raised the Wallpaper / Widgets / Apps list
  / Home settings menu, and `scroll 'down'` over the all-apps list moved it from
  `315 INT Kurier DPD…Drive` to `Contacts…Maps`, with `scroll 'up'` putting it back. Neither is
  observable from a mocked runner — the injection succeeds either way — so both were watched on
  the device.

Checked against Node 22 while building R22's host listener, 2026-08-30. All three bit the
implementation before review caught them, and all three are invisible to a test whose peers are
well behaved:

- **`net.Server.close()` waits on sockets a TLS server never told you about.** Its callback fires
  when the server's connection count reaches zero, and that count is incremented at `accept`, not
  at `secureConnection`. A peer that opens a TCP connection and never sends a ClientHello — a port
  scanner, a load balancer's health check, `nc host port` left open — is therefore in no set a
  `secureConnection` handler could have built, while still holding `close()` open forever. Track
  connections on the server's `'connection'` event, not only on `secureConnection`.
- **`socket.setTimeout` is an idle deadline, and every arriving byte rearms it.** It is not a bound
  on how long a peer may stay unauthenticated: one writing a byte at a time keeps it from ever
  firing, so a byte cap bounds the bytes and nothing bounds the time. A window a peer cannot
  extend has to be a plain `setTimeout`, armed once and cleared on the outcome.
- **`handshakeTimeout` does not abort the connection.** It emits `'tlsClientError'` with
  `ERR_TLS_HANDSHAKE_TIMEOUT` on the server and then leaves the socket exactly where it was, so a
  server that merely swallows that event has a log line rather than a deadline. Destroying the
  `TLSSocket` the event carries takes the raw socket with it.

Checked on the same API 37 emulator (`sdk_gphone16k_arm64`) with `adb` 37.0.0 while building
`read_logs` (#69), **2026-08-30**:

- **The verified log recipe is one bounded dump, and every flag earns its place:**

  ```bash
  adb -s "$SERIAL" logcat -d -v threadtime -t "$N" -b main -b crash
  ```

  `-d` dumps and exits — a follow never returns, and there is no sleep and no unbounded wait in
  this repository. **Repeated `-b` works on this adb**; `-b main,crash` is not needed. `-b crash`
  is what makes a crash reachable at all, and `-v threadtime` is the format carrying the
  timestamp, the pid and the level letter on every line. Exit 0, **stderr empty**, and `-t 2000`
  (2253 lines, 331 KB) came back in **36 ms** — this is a query, not a capture.
- **`-t <n>` counts logcat *entries*, and an entry is not a line.** A Java crash is a **single**
  entry whose message runs to fourteen lines, each of which `threadtime` prefixes in full:
  `-t 2 -b crash` returned **29** lines. So a caller that thinks in lines has to bound the answer
  on the host side; asking the device for `n` and trusting it to be `n` lines is wrong by an
  order of magnitude exactly when a crash is in the read.
- **An empty read is zero bytes** — not even a `--------- beginning of …` line (measured with a
  tag filter nothing matched). That separator is printed once per buffer that has anything in it,
  and it is the tool describing its own output rather than something the device said.
- **`am crash <package>` works on API 37, and is asynchronous.** It exits 0 *before* the crash is
  logged: the command returned at `10:54:26.759` and the entry landed at `10:54:26.945`. A test
  that reads the log once, right after it, catches nothing — the read has to be a condition with
  a deadline.
- **A crashed app is logged at level `E`, never `F`.** `am crash` produces
  `E AndroidRuntime: FATAL EXCEPTION: main`, `E AndroidRuntime: Process: <package>, PID: <pid>`
  and `android.app.RemoteServiceException$CrashedByAdbException: shell-induced crash`. The `F`
  letter belongs to a **native** abort — `F libc : Fatal signal 6 (SIGABRT)` and the `F DEBUG`
  tombstone under it, both of which the crash buffer also carries. A check looking for a
  fatal-*level* entry therefore misses every application crash on this platform.
- **The main buffer is chatty enough to lose a crash within seconds.** Idle, 60 entries spanned
  9 s; while an app was launching, 120 entries spanned **1 s** — so a crash twenty seconds old
  was already off the end of a `-t 120` read. A read that has to catch a crash asks for
  thousands, not hundreds, which is why `read_logs` takes the bound from the caller.
- **An entry bound is not a byte bound, and only the byte bound protects the frame.** The
  331 KB / 2253-line measurement above is ~147 bytes a line, so ordinary chatter is nowhere
  near anything — but logcat's own per-entry payload limit is about 4 KB, and the trigger is
  line *size*, not entry count. Measured in this checkout: 5000 entries whose message is 2 KB
  (an HTTP body, a serialised JSON response — well under logcat's limit) encode to a
  **10,440,123-byte** frame, over the 8 MiB `MAX_FRAME_BYTES`. That cap is enforced on the
  **receiving** side, so the result is not a refusal the caller can read: `FrameDecoder`
  throws, the client fails *every* in-flight request on that connection as `malformed_frame`
  and destroys it — a protocol error blaming the host, on a call the params schema explicitly
  allowed. Hence `MAX_LOG_BYTES` (`src/verbs/logs.ts`): a payload-carrying verb needs a bound
  in **bytes**, and a count of things whose size the caller chooses is not one.
- **`kill -6 <pid>` on an app process is refused for the shell user** (`Operation not
  permitted`), so a native abort cannot be induced without `adb root`. The fatal-level fixture was
  produced with `adb -s "$SERIAL" shell log -p f -t <tag> "<message>"` instead, which writes an
  entry at any level the shell asks for — the same six letters logcat prints.
- **What a crash leaves on the screen is not one thing, and it is not stable.** Both of these
  followed `am crash` on the foreground app on the same device within minutes: the **launcher**,
  with nothing on it about the crash at all (`mCurrentFocus=…NexusLauncherActivity`), and a
  **transient dialog** reading `Settings keeps stopping` / `App info` / `Close app`, which shows
  up after repeated crashes of the same package and clears itself again a few seconds later.
  Two consequences, and the first cost a test run:
  - **A crash dialog outlives the suite that raised it** and the next screen read takes it for
    the app under test — `tests/device/android/backend.test.ts`'s "root element matches
    `wm size`" failed at 196 dp against 427 because it was measuring a dialog. A suite that
    crashes an app dismisses what the crash raised (`input keyevent KEYCODE_BACK`) before it
    finishes.
  - **A test may not assert that the screen says nothing about a crash** — that is flaky, and
    when the dialog is up it is false. What holds either way is that the screen never names the
    **package**, the **exception** or the **process**, which is the assertion `read_logs`'
    acceptance test makes: a screenshot says at most that *an* app stopped, and only the log says
    which one and why.

Checked on the same API 37 emulator (`sdk_gphone16k_arm64`) with `adb` 37.0.0 while answering
the review of the transfer verbs (#70), **2026-08-30**:

- **`adb push <file> <existing-directory>` succeeds and puts the file *inside*, under the
  **local** basename.** `adb -s "$SERIAL" push /tmp/probe/payload /data/local/tmp/rover-dir`
  printed `1 file pushed, 0 skipped`, exited 0, and `ls -l` showed the bytes at
  `/data/local/tmp/rover-dir/payload`. A trailing slash behaves the same way. This is the whole
  reason `push_file` refuses a device path that is already a directory: the daemon's own
  temporary file is called `payload`, so without the refusal that internal name becomes
  observable device state, two agents pushing to the same directory overwrite each other's
  `payload`, and both are told `ok`.
- **Nothing in `push`'s output names where the file actually went.** Its success line quotes the
  **host** path it read (`/tmp/probe/payload: 1 file pushed…`), never the remote path it
  resolved — so there is no wording a parser could confirm the destination from, and the check
  has to be a question put to the device beforehand.
- **`adb push` creates missing parent directories.** Pushing to
  `/data/local/tmp/rover-nodir/inner.bin` where `rover-nodir` did not exist exited 0 and created
  both. So "the parent is missing" is not a case the transfer has to handle.
- **`stat -L -c '%s %F' <path>` is the probe both transfers use, and it is present on this
  build.** Exit 0 with `<bytes> <description>` on stdout; exit 1 with
  `stat: '<path>': No such file or directory` on stderr for a path that is not there, and
  `Permission denied` for one the shell user cannot reach. Captures:
  `tests/fixtures/adb/stat.*`.
- **`%F` for an empty file is `regular empty file`, not `regular file`.** A check written from
  memory against `regular file` calls a zero-byte file something it is not — and an empty file is
  a file this protocol already decided it moves. Directories are the single word `directory`.
- **`-L` matters: without it a symlink reports its own link text.** `stat -c '%s %F'` on a link
  whose target was 11 bytes answered `33 symbolic link` — the length of the link text. With `-L`
  it answers `11 regular file`, and a link to a directory answers `4096 directory`, which is what
  both transfers are actually asking about, since `push` and `pull` follow the link too.
- **`adb pull <directory>` is a *recursive* copy, and exits 0.** `adb -s "$SERIAL" pull
  /data/local/tmp/rover-pulldir-probe /tmp/…/pulled` on a directory holding two files across two
  levels printed `2 files pulled, 0 skipped` and reproduced the whole tree on the host. `stat -L
  -c '%s %F'` on that same directory answers `4096 directory` — the inode's own size, not the
  tree's. **So a size read without a kind beside it is not a bound**: it is why `pull_file`
  refuses a device path the probe calls a `directory` before the transfer starts, rather than
  bounding harder afterwards. There is nothing to bound afterwards; the bytes are already here.
- **A character device stats as `0` and pulls without end** — the same hole as the directory,
  on the other shape whose `%s` says nothing about a transfer. `stat -L -c '%s %F' /dev/urandom`
  answers `0 character device` and exits 0, so a size bound compares 0 against the cap and
  passes; `adb -s "$SERIAL" pull /dev/urandom` then wrote **769,196,032 bytes** onto this host
  in the five seconds before it was killed, and would have gone on to the transfer timeout. A
  fifo, a socket and a block device are all reported the same way — a `%F` phrase that is
  neither `directory` nor `regular file`. **So the bound is only meaningful on a regular file**,
  and that is what `pull_file` requires: the probe's `kind` names a regular file rather than
  merely ruling out a directory, and anything else is refused before the transfer starts.
  Capture: `tests/fixtures/adb/stat.character-device.*`.
- **A push to a character device is left to the device, deliberately.** `push_file` refuses only
  a directory, because the directory refusal exists to stop the *daemon's own temporary
  basename* becoming device state under a name the caller never chose — nothing a push to
  `/dev/null` does. There the caller named the exact path it meant, the bytes go where the
  device says they go, and the size is the caller's own already-bounded upload. The asymmetry
  with `pull_file` is stated in both contracts so it reads as a decision, not an omission. What
  it is **not** is a licence to skip the kind check on the *client's own source*, which is a
  different path on a different machine — see the R24 phase 2 finding below.
- **adb writes the *host* path into its own stdout and stderr, so masking the argv is not
  enough.** Measured for all three transfer failures: a refused push prints
  `<host path>: 1 file pushed, 0 skipped.` and then `adb: error: failed to copy '<host path>' to
  '<device path>': remote couldn't create file: Permission denied`; a refused install prints
  `adb: filename doesn't end .apk or .apex: <host path>`; a pull that cannot write its
  destination prints `adb: error: cannot create '<host path>': Permission denied`. All three
  quote the path **byte for byte as it was given**, which is what makes a substring substitution
  on the captured streams safe — and necessary, since D19 says none of those strings may reach a
  client that is not on this machine. (A *successful* pull names the remote path instead:
  `/data/local/tmp/rover-pulldir-probe/: 2 files pulled`.)
Checked on the same API 37 emulator (`sdk_gphone16k_arm64`, Android 17) with `adb`
37.0.1-15733141 while landing `record_video` phase 1 (#14, R14), **2026-08-30**. `screenrecord`
reports itself as **v1.4**:

- **`screenrecord` writes its `moov` atom only when it exits, and a file pulled before then is
  unreadable rather than short.** This is the whole reason the verb is shaped the way it is, and
  both halves of it are committed as fixtures. A finished 3-second recording is `ftyp` (24 B),
  `moov` (1620 B), `free` (1572 B), `mdat` (64-bit extended size) — note the index comes
  **second**, before the payload. The *same recording* pulled while the encoder was still running
  is `ftyp` (24 B), `free` (3192 B — the reserved gap the index will be written into) and an
  `mdat` whose 64-bit size reads **4557430888798830399** over a 3232-byte file. Nothing but the
  `moov` separates them: both start with a well-formed header, both are plausible file sizes, and
  `screenrecord` exited 0 for each. Handing an agent the second one reads as a broken tool rather
  than as a race, so `record_video` refuses it by name.
- **`screenrecord` succeeds silently and refuses loudly.** Zero bytes on both streams at exit 0 on
  the success path; `Unable to open '/data/nope/rover-recording.mp4': No such file or directory`
  on **stderr** at exit **1** for an unwritable path. So there is no exiting-0 failure here — the
  trap `parsers/app-control.ts` and `parsers/network.ts` exist for does not apply, and no refusal
  predicate was written for a case no device produces.
- **`pidof` exists at `/system/bin/pidof` on API 37** and is what makes the completion check a
  condition rather than a sleep. `pidof screenrecord` prints one bare pid and a newline on stdout
  while a recording is in flight, and **prints nothing while exiting 1** once it has gone. That
  non-zero exit is the trap: `adb shell` propagates it and `src/backends/android/adb.ts` treats a
  non-zero exit as a failure, so "no such process" — the answer the wait is looking for — would
  arrive as a broken device. The recipe is `adb -s $SERIAL shell 'pidof screenrecord || true'`.
- **The recorder was already gone by the time its adb client returned**, every time, on this
  emulator. The wait is kept anyway and costs nothing when it is: `waitForCondition` probes before
  any delay, so the ordinary case is one round trip and no wait at all. What it is really for is a
  loaded device, a physical panel, and an adb client that was killed while the encoder ran on.
- **`--time-limit` counts whole seconds and defaults to 180** on this build (`0` removes the limit
  entirely). It is always passed, because it is what makes a recorder that outlived its adb client
  self-terminate instead of running on under the next lease; a fractional duration is rounded
  **up**, never down, and then **floored at one second** — a computed `0` would hand
  `screenrecord` the argument that turns the kill switch off, so the duration that looks like
  "record nothing" is the one that leaves an unbounded recorder on borrowed hardware. The wire
  refuses a non-positive duration, but the core library is also callable in process, so the floor
  lives in the mapping. `MAX_RECORDING_MS` (15 s) is far below every version's cap, so the
  differences between API levels cannot bite.
- **A recorder already running on the same device is refused before anything else happens.** The
  probe asks whether *any* `screenrecord` is running, because matching a particular one would mean
  matching a pid this code never learned. **This read "makes the wait time out" when it was
  measured**, and that was the honest answer while the only way to reach it was a recorder somebody
  else had started: a `wait-timeout` naming the pids, ten seconds later, rather than a lease held
  until it expires. #190 removes that premise — a recording is now held open *on purpose*, so a
  second one is an ordinary thing for an agent to ask for by accident — and the pre-check moved to
  the front of `recordVideo` as `recording-already-running`, naming the device and the pids
  immediately. Either way there is no pull, because the file under it is one somebody else is still
  writing.
- **The pull is `exec-out cat`, never `shell cat`**, for the reason the hierarchy dump already
  records above: `adb shell` may put a pty in the path and a pty translates every `0x0a` in a
  binary payload, conditionally on version, platform and whether stdin is a terminal — so a
  recording that survives on one machine is corrupt on the next.
- **The scratch path is fixed (`/sdcard/rover-recording.mp4`) and made exclusive per path**, the
  way `uiautomator`'s dump path is: two overlapping recordings would otherwise share one file and
  corrupt both. It is removed **before** the recording as well as after, so a leftover from a run
  that died before its cleanup can never be the file that is pulled. **This read "per device"
  when it was measured**, with one queue covering both scratch paths — right while every recording
  ended inside its own verb call, since the two never overlapped and a screen read queued behind a
  recording waited at most as long as the recording the same agent had just asked for. #184 phase 1
  (R43) reversed it, and the measurement both ways is further down this section: the two commands
  do not compete for anything, and a recording held open *on purpose* would otherwise hold every
  screen read on that device for its whole life.
- **Encoded at 2 Mbps rather than `screenrecord`'s 20 Mbps default.** A 3-second recording of a
  static home screen came to 62–64 KB; the rate is what ties `MAX_RECORDING_MS` to
  `MAX_ARTIFACT_BYTES` — 15 s × 250 KB/s ≈ 3.6 MiB against a 4 MiB bound — and the relationship is
  asserted in `tests/unit/backends/android/backend.test.ts` rather than left to drift.

Checked on the same API 37 emulator (`sdk_gphone16k_arm64`, Android 17) with `adb`
37.0.1-15733141 while landing `start_recording` / `stop_recording` (#190, R43 phase 2),
**2026-09-06**. Same `screenrecord` v1.4, and everything above still holds — what is new is the
half of the lifecycle `record_video` never needed, a recorder that outlives the call that started
it:

- **A recorder is detached by redirecting its streams, not by `&` alone.**
  `adb -s $SERIAL shell 'screenrecord --bit-rate 2000000 --time-limit 15 /sdcard/rover-recording.mp4 </dev/null >/dev/null 2>&1 &'`
  returned in **93 ms** with the recorder running. The *same* command without the redirections
  returned only when the recorder exited — **2.24 s** for a `--time-limit 2` run — because adb's
  shell service waits for EOF on the stream rather than for the foreground process, so the `&`
  alone detaches nothing as far as the client is concerned. No `nohup` and no `setsid`: adb sends
  no `SIGHUP` when the session ends, and the recorder outlived every client here.
- **What the redirection throws away is a warning, never the answer.** The un-redirected run above
  printed `ERROR: unable to configure video/avc codec at 1280x2856 (err=-22)` and
  `WARNING: failed at 1280x2856, retrying at 720x1280` — **on stdout, at exit 0**, having recorded
  perfectly well at the fallback size. So nothing that decides an answer is ever read off these
  streams; what is checked is the bytes that arrive, exactly as `record_video` checks them.
- **`SIGINT` makes the recorder write its index and exit, and it is not instantaneous.** The
  recipe is `adb -s $SERIAL shell 'kill -INT $(pidof screenrecord) 2>/dev/null || true'`: it exits
  **0** immediately with a recorder there, and `pidof` still named the recorder for **0.265 s over
  8 further probes** after it. The file at that point is complete and has the ordinary shape:
  `ftyp` (24 B), `moov` (1618 B), `free`, `mdat` — measured again while fixing the trap below as
  247,603 bytes, `ftyp` then `moov`, from a swiped session. So "the recorder is gone" is again a
  condition with a timeout and never a sleep (D12(b)) — and unlike `record_video`'s, where the
  recorder had already exited by the time its adb client returned, this wait genuinely waits. A
  7-second signalled session of a screen being swiped came back declaring **23 samples over
  7.04 s**.
- **`kill` inherits `pidof`'s non-zero exit, and it is worse here than it is there.** **This recipe
  was written without its `|| true`** and the omission held only for as long as the recorder was
  assumed to still be there when the signal lands. It is not: the pids are read one adb round trip
  earlier, so a recorder that reaches its own `--time-limit` in the gap — fifteen seconds is the
  only length `start_recording` / `stop_recording` support, and the one agents are told to drive —
  leaves `$(pidof screenrecord)` expanding to nothing and the shell seeing a bare `kill -INT`. That
  prints `usage:	kill [-s signame | -signum | -signame] { job | pid | pgrp } ...` and exits **1**;
  with the tolerance the same command exits **0** and prints nothing. Measured both ways
  (#195 review). Untolerated it arrives as `AdbCommandError`, which no `toVerbFailure` branch
  names, so the agent is told `internal_error` about a device that is fine — and `stopRecording`'s
  `finally` removes the complete, playable file the recorder had just finished writing, after which
  a retry answers `no-recording-running` and there is no path back to the bytes. Swallowing the
  exit code costs nothing: a recorder that survived the signal is caught by the wait that follows,
  which fails naming the pids still there.
- **`--time-limit` still bounds a recorder whose adb client is long gone.** A detached recorder
  started with `--time-limit 3` exited on its own **3 s** later with nothing on the host holding
  it, leaving a finished 35,181-byte file. That is what makes the limit a kill switch that needs
  nothing on the host to be alive — which is still worth having now that phase 3's lease-end
  teardown stops a stray recorder (#191), because a host that died with the lease cannot run a
  teardown at all. It is why the limit is always passed and never `0`.
- **A stop that arrives before the recorder has written anything leaves a zero-byte file, not a
  missing one.** Signalling immediately after the launch left `/sdcard/rover-recording.mp4` there
  with `stat -c '%s %F'` answering `0 regular empty file`. That is an `unfinished-recording`
  refusal naming 0 bytes — the same refusal, for the same reason, as a pull that raced the encoder.
- **`adb exec-out cat` of a path that does not exist exits 0 and puts the shell's error text on
  *stdout*** — 60 bytes of `cat: /sdcard/rover-recording.mp4: No such file or directory`, with
  the host's stderr empty, measured. That is worse than answering nothing: the pull cannot report
  *there was no recording*, and bytes coming back is not evidence that one did, so a `stop` that
  decides on what the pull returned calls a device that recorded nothing *an unfinished recording
  of 60 bytes*. **This was first written down here as "exits 0 with no output", which is wrong**,
  and the device tests are what caught it. `stat` is what separates the two cases — the same
  `stat -L -c '%s %F'` the two transfers already use, answering `0 regular empty file` for a file
  that is there and empty and exiting **1** for one that is not there at all — which is why
  `stop_recording` asks it before the pull and decides `no-recording-running` on *that* rather
  than on a byte count. `record_video` pulls the same way and is unchanged: a run of it that left
  no file is still `unfinished-recording`, correctly, but names the error text's length rather
  than zero.
- **A start/stop session of a screen nobody drove is the still-screen case, and it is easier to
  reach here than with `record_video`.** A 3-second session in which the only input was an `input
  tap` on dead space came back declaring **one sample, no duration and `r_frame_rate 1/0`**; the
  swiped session above, over the same recorder and the same argv, declared 23. What decides it is
  whether the screen changed, which with two calls is entirely the agent's business — hence the
  `start_recording` description telling it to drive the device.
- **There is no window to hold a still screen across, and none was invented.** `record_video`
  normalises a container declaring no duration by holding its one frame over the window the
  *caller asked for* (#185). A start/stop session has no such number: nothing on the host records
  when the recorder started, because a map of open recordings is exactly the stale daemon state D6
  exists to prevent; `stat -c %W` on `/sdcard` answers `?`, so the device has no birth time to
  subtract; and `ps -o ETIME=` answers in whole seconds (`ps -o etimes=` is rejected outright by
  this toybox). So `stop_recording` keeps the recorder's **own** timeline and names the still
  screen through `container`, rather than reporting a length nobody measured.

Checked on an **API 35** emulator (`sdk_gphone64_arm64`) with `adb` 1.0.41 while building the
environment *verbs* over those primitives (#16), 2026-08-30 — a different API level and a much
older `adb` than everything above, which is the point of recording it:

- **Both recipes work unchanged on API 35, and still without root.** `set_airplane_mode` and
  `set_wifi` were driven end to end over a lease — client, socket, daemon, verb layer, device —
  in both directions and twice in the state the device was already in, and every call answered
  `ok`. So the finding above is not one API level's accident: `cmd connectivity airplane-mode`
  and `cmd wifi set-wifi-enabled` are the recipe across the range Rover has been run on, and
  `svc wifi` is dead on both ends of it.
- **The verb layer's after-state says nothing about the radio, as designed.** Each answer carried
  a `screen` after-state read from the device *after* the toggle — evidence the device was still
  there and answering, and no more than that. Nothing on the screen a device happens to be showing
  reports a radio, and the getters this section records are still not wired to anything.

Checked on an **API 35** emulator (`sdk_gphone64_arm64`, Android 15) with **ffmpeg 8.0** while
landing `record_video` phase 2 — the frames (#82, R14), 2026-08-30:

- **`screenrecord` writes its `moov` *before* the payload, which is what makes a host-side decode
  possible with no temp file.** The box order on a finished recording is `ftyp`, `moov`, `free`,
  `mdat` (recorded above for a different reason: the index is what separates a finished recording
  from one pulled early). An index at the *end* — which is what a general-purpose muxer writes —
  cannot be decoded from a pipe at all, because a decoder reading a stream cannot seek back to the
  payload once it has found the index. So `ffmpeg -i pipe:0` reads these recordings, and the
  extractor writes the bytes to stdin rather than to a file on the host. A file would be a path
  that exists (D19) and a thing to clean up on every failure path.
- **A recording of a screen that never changed decodes to exactly one frame, and the `fps` filter
  emits *nothing* for it.** The virtual display produces a new buffer only when something on the
  screen changes, so two seconds of a still screen is a single sample whose stream duration is
  zero — and `fps=2` over a stream of zero duration writes an **empty** output while exiting **0**
  and saying nothing on stderr. That is the plausible-looking empty result in its purest form: a
  frame list that reads as "nothing happened" for a recording that has a frame. `fps=2:round=up`
  emits the one frame. The filter is never written without it — **and, since that closes the only
  case that legitimately sampled to nothing, a run that exits 0 having written no images at all is
  now `frame-extraction-failed` by name rather than an empty list.**
- **A recording's container duration is *not* the duration it was asked for, and the sampling
  follows the container.** A 15 s `screenrecord` capture of a mostly-still screen came back with
  **two** encoded samples and a declared duration of **27.61 s** (`ffmpeg -i` on the pulled file);
  a 2 s capture of a changing screen sampled to 7 frames where `duration × rate` predicts 4. The
  virtual display emits a buffer only when the screen changes, so the last sample's timestamp can
  sit far past the end of the recording window, and `fps=n` samples the timeline the container
  declares rather than the one the caller asked for. Two things follow, and both are load-bearing:
  `MAX_FRAMES` is a bound a call the wire admits **can reach**, so it is enforced as a named
  refusal rather than described as a guard; and nothing may assert `frames.length ≈ duration ×
  rate`, in a test or anywhere else, because that is an assertion about a device's timing.
- **`-frames:v` makes ffmpeg stop writing and exit 0**, so a cap passed straight to it is a frame
  list quietly cut short — indistinguishable from a complete answer downstream. The decoder is
  given `MAX_FRAMES + 1` and a run that comes back over the bound is refused by name.
- **Frames are scaled to 320 px wide because a lossless image of a real screen is expensive.** The
  same 3-second recording of a launcher with a gradient wallpaper — close to the worst case for
  PNG — came back as 68 KB per frame at 240 px, 101 KB at 320 px, 118 KB at 360 px and 175 KB at
  480 px. A default five-second recording is ten frames, so 320 px is about 1 MB against the
  1.5 MiB `MAX_FRAMES_BYTES` allows beside a recording that may itself be 4 MiB. Over the budget
  is `frames-too-large` naming both numbers, never a shorter list.
- **Unreadable input exits 183 with its reason on stderr**
  (`Invalid data found when processing input`), so the two host-side failures really are
  distinguishable: a decoder that is not installed never starts and carries Node's own
  `spawn ffmpeg ENOENT`, while one that ran and refused carries a code and a stream to quote.

Checked on an **API 37** emulator (`sdk_gphone16k_arm64`, Android 17) while landing #183 — what
`record_video`'s answer says the recording *contains*, 2026-09-06:

- **A still screen is what the committed `screenrecord.finished` fixture already was, and nobody
  had noticed.** Walking its boxes: `mvhd` v0, timescale 10000, duration **0**, and **three**
  `trak`s — one `vide` and two `meta` — each with an `stsz` of `sample_count` **1**. That is
  `ffprobe`'s `nb_frames=1` / `duration=0.000000`, byte for byte, in a fixture committed as
  evidence of something else entirely. Two consequences: the sample count and the declared
  duration are read out of the container with **no decoder**, no second pass over the device and
  no new host dependency (`src/verbs/recording-container.ts`); and the video track must be picked
  by its `mdia/hdlr` handler type, because taking the first `trak` is right on this file **by
  luck** and wrong on the next one. Do not replace that fixture with a capture of a moving screen
  — it is the still-screen case, and `tests/fixtures/adb/README.md` says so.
- **Motion is the variable, not Rover's invocation.** Measured on `emulator-5554` at four
  settings: Rover's own arguments (`--bit-rate 2000000 --time-limit 6`) with swipes on screen gave
  1 267 249 bytes / 5.157 s / 306 frames, and the default arguments with the same swipes gave
  11 631 939 bytes / 4.926 s / 292 frames — so the bit rate changes the size and not the sampling.
  With **nothing** moving, both argument sets produced a **byte-identical** 91 205-byte file of
  one sample and 0.000000 s. A recording that comes back tiny and one-framed is a fact about the
  screen, and two such recordings being nearly the same size is two captures of the same
  unchanged screen rather than evidence that the content has no effect.
- **`mvhd` and the video track's `mdhd` agree, so the movie header is the one to read.** On a
  6 s capture driven with swipes: `mvhd` timescale 10000 duration 37150 (3.715 s), the `vide`
  track's `mdhd` timescale 90000 duration 334346 (3.7149 s), `stsz` sample_count 137, and the
  `stts` deltas summing independently to 137 samples over 334347 units. The two `meta` tracks
  declare duration 0 and one sample each, which is exactly why handler-type selection is
  load-bearing. This was the open question when the fixture alone was available — both its
  numbers are 0, so it cannot separate the two — and it is settled: read `mvhd`.
- **This is a reporting gap, not a refusal, and it was filed as a tool defect once already.** An
  agent recorded twice, got one frame both times, ran `ffprobe`, and concluded that `record_video`
  does not record video. Every check Rover makes was passing correctly — `isFinishedRecording`
  finds `ftyp` and `moov` and judges nothing else, `fps=n:round=up` emits the single sample — and
  nothing in the answer pointed at the paragraph above. A capture of an idle screen is a
  legitimate thing to ask for, so it still answers `ok` with its one frame; what changed is that
  `result.container` now names it (ai/RULES.md §2 — the recording was honest, the answer about it
  was not).

Checked with **ffmpeg 8.1.1** against the committed `screenrecord.finished` fixture — itself a
real API 37 still-screen capture — while landing #185, the host-side normalisation of the
recording, **2026-09-06**. No device was attached for this run, so every number below is off the
fixture and off a synthetic worst case rather than off a live capture; the device cases in
`tests/device/android/recording.test.ts` are what close that gap:

- **The mp4 muxer refuses a non-seekable output, so a normalised recording needs a host temp file
  where the frame extractor needs none.** `-f mp4 pipe:1` exits **234** with
  `muxer does not support non seekable output` / `Could not write header`. The way round it is
  `-movflags frag_keyframe+empty_moov`, and that is worse than the temp file: the fragmented
  output's `stsz` declares **no encoded samples at all**, so `readRecordingContainer` answers
  `unreadable` for it — every recording Rover produced would stop being able to say what it
  contains (#183). So `src/daemon/normalise.ts` writes into a `mkdtemp` directory and removes it
  in a `finally` on every path. The **input** still arrives on `pipe:0`, so the pulled bytes never
  touch the host's disk.
- **A temp file is not by itself a path kept out of answers, because ffmpeg echoes its own output
  URL.** Given the exact argv `normaliseArgs` builds with an absolute output the muxer could not
  open, ffmpeg 8.1.1 at `-loglevel error` printed
  `[out#0/mp4 @ …] Error opening output /tmp/ronly/normalised.mp4: Permission denied` and exited
  **243** — and that stderr is data the refusal carries, so the host's path crossed the wire with
  it. A full temp filesystem (`Error writing trailer of <path>: No space left on device`) and a
  reaper removing the directory under the muxer produce the same shape. So the run is spawned with
  its own directory as `cwd` and handed the **bare** `normalised.mp4`, which is then the only name
  it can echo, and the stderr is redacted besides. Related, and found the same way: `mkdtemp` is
  the one call in that module that runs before any `try`, and its rejection — a temp filesystem
  that is full, read-only or private to a sandbox — matches no branch of `toVerbFailure`, so it
  used to become an `internal_error` carrying the path **Node** puts in its own message. It is now
  `recording-normalisation-unavailable`, the same name a host with no `ffmpeg` gets, because both
  are this machine being unable to run the encoder at all (D19).
- **`+faststart` is what keeps the answered file decodable the way the one it read was.** The box
  order of the normalised output is `ftyp`, `moov`, `free`, `mdat` — the `moov` before the
  payload, which §6 already records as the only reason `ffmpeg -i pipe:0` works on these
  recordings at all. Feeding the normalised file straight back to the frame extractor's own argv
  produced 919 127 bytes of PNGs, which is the executable proof. Without the flag a
  general-purpose muxer writes the index last and nothing downstream can stream what this host
  wrote.
- **A still screen normalises into a video with a timeline in it.** The 64 141-byte fixture —
  `mvhd` duration 0, one sample, `r_frame_rate 1/0` — came back as **62 099 bytes, 150 samples,
  5 000 ms** at `fps=30:round=up,tpad=stop_mode=clone:stop_duration=5 -t 5`, read back with
  Rover's own `readRecordingContainer` rather than with a second tool. That is the whole of what
  #185 claims, on the one file that used to be unplayable.
- **`round=up` matters more here than it does for the frames.** Without `tpad`/`-t`, the same
  fixture at plain `fps=30:round=up` normalises to a **0.033 s, one-sample** file — still
  technically a timeline, still nothing anybody can scrub. And without `round=up` at all the fps
  filter over a zero-duration stream writes nothing while exiting 0, which §6 already records for
  the extractor. The pad-then-cut pair is what makes the output exactly the requested window.
- **A quality-targeted re-encode is free to be several times the size of its input, so the rate is
  capped.** A 15 s 1080×2424 worst case (`testsrc2`, close to pathological for an inter-frame
  codec) re-encoded at `-crf 23` alone came to **10 099 915 bytes**, against the 4 MiB
  `MAX_ARTIFACT_BYTES`. The same source under `-maxrate 2000000 -bufsize 2000000` came to
  **3 772 368 bytes**, 450 samples over 15 000 ms. Without the ceiling this change would answer
  `artifact-too-large` for recordings that are handed over fine today, which is the opposite of
  the point — so `NORMALISED_MAX_BIT_RATE_BPS` is derived from `MAX_ARTIFACT_BYTES` over
  `MAX_RECORDING_MS` and asserted in `tests/unit/verbs/recording-normalisation.test.ts`. It is a
  ceiling and not a guarantee: a container declaring a timeline longer than the request
  (§6's 27.61 s) keeps that timeline, and going over is still the `artifact-too-large` refusal —
  now checked on the **normalised** bytes, because re-encoding is what changes the number.
- **The frames still come off the pulled recording, so `MAX_FRAMES`' derivation is unmoved.**
  Slicing the normalised copy instead would sample a 15 s still-screen capture into 61
  near-identical frames rather than one — over `MAX_FRAMES_BYTES` at ~100 KB each, turning an `ok`
  answer into a `frames-too-large` refusal. The sampling follows the container the *recorder*
  wrote, exactly as it did, and nothing asserts `frames.length ≈ duration × rate` anywhere.

Checked on an **API 37** emulator (`sdk_gphone16k_arm64`, Android 17) and an **API 33** emulator
(`sdk_gphone64_arm64`) with `adb` 37.0.0-14910828 while landing #184 phase 1 — the backend's
scratch-path queues (R43), 2026-09-06:

- **`uiautomator dump` and `screenrecord` do not compete for anything on the device, which is what
  lets the backend's queue be per scratch path rather than per device.** A screen read taken while
  a 6 s recording was in flight on the *same* device answered in **2386 ms** against a **2311 ms**
  baseline with nothing recording, with the same 77 elements either way, and it answered **4077 ms
  before** the recording did (API 37). On the API 33 emulator: **2068 ms** against a 2363 ms
  baseline, 31 elements both times, 4312 ms before. The recording came back **finished** — `moov`
  present — in every one of those runs, so the read costs the recording nothing either.
- **The same measurement with the old per-device key is what the reversal rests on.** With one
  queue covering both scratch paths, that read took **8862 ms** on the same emulator — it did not
  begin until the recorder had gone — and answered **2332 ms after** the recording rather than
  before it. That is tolerable only while a recording ends inside its own verb call; a recording
  deliberately held open while the agent drives the device (R43 phases 2 and 3) would hold every
  `read_screen` on that device for the recorder's whole life, which is the acceptance criterion
  inverted.

Checked against Node 25.2 while building R22's client, 2026-08-30:

- **`tls.connect({ servername })` throws when the value is an IP address.** Not a warning and not
  a value quietly ignored — `ERR_INVALID_ARG_VALUE`, synchronously, before a packet is sent
  ("Setting the TLS ServerName to an IP address is not permitted", RFC 6066). Setting
  `servername` to whatever the caller configured as the host is the obvious thing to write and
  breaks `ROVER_HOST_ADDRESS=10.0.0.4`, which is the *ordinary* way to name a host on a private
  network — while passing every test written against `localhost`. Send SNI only when the address
  is a name (`isIP(address) === 0`). Leaving it out costs nothing: Node still verifies the
  certificate against `host`, IP SANs included, which is the check that matters.

Checked on an **API 35** emulator (`sdk_gphone64_arm64`, Android 15) with `adb`
37.0.1-15733141 while landing R24 phase 2 — the file verbs from the client (#85), 2026-08-30:

- **`install_app` has now been run against a device, end to end from the CLI, and it works.**
  `rover install <lease> ./BookmarkProvider.apk` — a real 29 487-byte APK pulled off the same
  emulator — answered `ok`, and `pm path com.android.bookmarkprovider` moved from
  `/system/app/BookmarkProvider/BookmarkProvider.apk` to a `/data/app/~~…/base.apk`, which is the
  device saying the bytes this client sent are what it is now running. `adb uninstall` put the
  factory copy back. This **closes the gap R15 phase 3 filed** — the verb had until now only been
  exercised over a stub backend, because there is no APK in this repository and there still is
  not; what was missing was somebody running one, not something to write. Read the remaining
  constraint as it is: one small package has been installed this way, not a 45 MB one, and the
  cap that refuses the large one is unchanged.
- **A `push_file` / `pull_file` round trip through the CLI is byte-exact on real hardware.**
  100 000 bytes of `/dev/urandom` — the case a UTF-8 decode anywhere in the path would corrupt
  silently — pushed to `/data/local/tmp`, pulled back to a second local file, `cmp` clean and the
  same SHA-256. Both directions travel base64 in one message and neither command ever printed a
  path belonging to the host.
- **The client-side refusals behave the same against a real host as against a fake one**, which is
  the property worth checking outside a test: a 4 194 305-byte source (one over
  `MAX_TRANSFER_BYTES`) exited 2 naming the file, `4194305` and `4194304`; a missing path exited 2
  carrying `ENOENT` and `stat`; a directory exited 2 saying so. All three printed the command's
  own usage and none of them reached the daemon at all.
- **A size read without a kind beside it is not a bound *on the client's own disk either*.** The
  device-side finding above, on this side of the wire, and it was found by review rather than by
  the emulator. `statSync` answers `size=0, isFile=false` for both a `mkfifo` and `/dev/zero`, so
  `resolveSource` — which refused only a directory and only then compared the size — accepted
  both: measured here, `readFile()` on a fifo fed 8 MiB returned **8 388 608 bytes**, twice a
  `MAX_TRANSFER_BYTES` of 4 194 304, into a process whose whole contract is that the bound lands
  before the read. Encoded, that is ~11 MiB on a socket whose frame cap is 8 MiB — a destroyed
  connection rather than a refusal the caller can read. A fifo with **no** writer is worse than
  wrong: `readFile()` was still blocked after 5 s, so the command hangs with no timeout and no
  connection ever opened, and `/dev/zero` reads until Node's ~2 GiB buffer limit. The shape is
  not exotic — `rover push <lease> <(gzip -c big.bin) /data/local/tmp/x.bin` is a fifo under
  `/dev/fd/` that the caller never thought of as one. **So `resolveSource` requires
  `stats.isFile()`, checked before the size**, exactly as `pull_file` requires the probe's kind
  before its `%s`.

Checked on an API 37 emulator (`sdk_gphone16k_arm64`, Android 17) with `adb` 37.0.1-15733141
while landing R30 — the OS version in the inventory (#108), 2026-08-31. No physical device was
attached to the host that ran these, which is the same limitation every capture in
`tests/fixtures/adb/` carries:

- **The verified per-device OS-version recipe is one round trip carrying two `getprop` calls:**

  ```bash
  adb -s "$SERIAL" shell 'getprop ro.build.version.release; getprop ro.build.version.sdk'
  ```

  Two bare values come back, in that order and on their own lines — `17` then `37` on this
  device. Cheap enough to run per attached device at enumeration, unlike the full `getprop`
  dump `device_info` reads (~23 KB).
- **`getprop` takes exactly one key: a second argument is the *default value*, not a second
  key.** `getprop ro.rover.no.such.property DEFAULTVALUE` prints `DEFAULTVALUE`. So two
  properties is two calls, and anyone who writes `getprop a b` expecting two values gets one
  invented one instead — which would land in the inventory as a version the device never
  reported.
- **A property the device does not have prints an empty line, and exits 0.** Not an error, not
  nothing at all: `getprop ro.rover.no.such.property; getprop ro.build.version.sdk` prints
  `\n37\n`. That is what makes the two values safe to read *positionally* — the line count does
  not depend on which properties exist — and it is captured as
  `tests/fixtures/adb/getprop-version.absent.api37-sdk-gphone16k-arm64.txt` rather than
  believed.
- **This shell prints `\n`, not `\r\n`**, on a command passed as one argument to `adb shell`.
  Verified with `od -c`. The parser strips a trailing `\r` per line anyway, because the
  `uiautomator dump` finding above is the same tool on the same host translating them.

Checked on an **API 35** emulator (`sdk_gphone64_arm64`, Android 15) with `adb`
37.0.1-15733141, 2026-08-31, answering the review of #108 — how long the read above may take:

- **The read costs 0.07–0.11 s**, so it gets a budget of its own rather than the ten seconds
  every other query here takes. Five `/usr/bin/time -p` runs of the recipe above measured
  `real` 0.11, 0.07, 0.08, 0.09, 0.08 s. That matters because it is the only query on the
  enumeration path, and `DeviceInventory.verifyForGrant` runs it on **every lease grant**, in
  parallel across every attached device — so the slowest device on the host decides how long
  a grant for a *healthy* one waits. A wedged handset that adb still reports as `device` used
  to spend the full default on every grant; `OS_VERSION_ADB_TIMEOUT_MS` is 3 s, more than an
  order of magnitude above the measurement and a thirtieth of that cost. Timing out is cheap
  here in a way it is not for a capture or an install: the device is listed without a version
  and asked again at the next enumeration.
- **Nothing in the daemon re-enumerates on a timer**, which is what makes a failed read's
  retry a design question rather than a detail. `adb track-devices` only emits on a *change*,
  so a device set that sits still produces no further frame, and the only other enumeration
  is the one a lease grant runs. So the version a watch could not read is announced by
  whichever path does read it (`OsVersionCache.onLearned`) instead of being re-delivered only
  by the frame that asked — otherwise a single transient failure leaves `list_devices`
  answering `null` for a device an `acquire_device` on the same serial reports a version for,
  until somebody unplugs it.

Checked on **Node v25.8.2** (the repo requires ≥ 22) while landing R32 — the HTTP surface a browser
reaches (#110), 2026-08-31. Nothing here is about a device; all four are about `node:http` refusing
to behave the way its own option names read:

- **An unhandled `clientError` makes the uniform refusal an oracle.** Node's default answers a
  malformed request line with `400 Bad Request` and a blown `headersTimeout` with `408 Request
  Timeout`. Both are *pre-auth* answers that vary with the reason, which is precisely what
  `network-listen.ts` refuses to emit and what every pre-auth failure on this surface has to be
  indistinguishable from. `server.on('clientError', (_error, socket) => socket.destroy())` replaces
  both with nothing, matching the TLS gate's "a peer that never completes the handshake gets no
  frame". This is the first thing to check when reviewing an HTTP listener here.
- **`headersTimeout` is not enforced when it elapses — it is enforced on
  `connectionsCheckingInterval`, which defaults to 30 s.** Measured: `createServer({ headersTimeout:
  250, requestTimeout: 30_000 })` left a peer that sent no headers connected past **4 s** with no
  `clientError` and no drop; adding `connectionsCheckingInterval: 50` dropped it at **261 ms**. So a
  five-second pre-auth deadline is a thirty-second one unless that third option is set beside it,
  and a short test seam does not land inside a test at all. The greeting deadline in
  `network-listen.ts` is a per-socket `setTimeout` and has no such granularity, which is why the
  trap does not exist there.
- **`headersTimeout` must be `<=` `requestTimeout`, and only `createServer()` checks it.** Measured:
  `createServer({ headersTimeout: 30_000, requestTimeout: 5_000 })` throws `ERR_OUT_OF_RANGE`
  ("must be <= requestTimeout"), while assigning the same two as properties after construction
  throws nothing, warns nothing, and leaves the server in exactly that state. Equal is allowed. So
  both are passed to `createServer()`, and the request bound is `Math.max(30_000, authTimeoutMs)` so
  a test seam can never construct the invalid pair.
- **`clientError` is not the only status Node writes for you: an `Expect:` header gets answered a
  layer above it.** Measured on the real listener with no `Authorization` header at all: `Expect:
  foo` answered `417 Expectation Failed` and `Expect: 100-continue` answered a bare `100 Continue`
  ahead of the `401`, both from `parserOnIncoming` and both because *no listener was registered* for
  `'checkExpectation'` / `'checkContinue'` — the exact shape of the `clientError` trap above, which
  is why one being fixed did not fix the other. Registering both and destroying the socket restores
  "exactly two statuses"; found by review pass 1 of #118, which is the argument for the bullet above
  being checked as a class rather than as one event name.
- **Node's default `server.keepAliveTimeout` is 5 000 ms — the same number the panel polls on.**
  Measured on Node **v25.8.2** (2026-09-01): a bare `http.createServer()` reports
  `keepAliveTimeout === 5000`, and the running listener puts it on the wire as `Keep-Alive:
  timeout=5`. `POLL_MS` in `panel/src/devices/device-list-provider.tsx` is also 5 000 ms, and the
  poll's `setInterval` measures from when a request *starts*, so the browser's next request went out
  after an idle gap of 5 000 ms minus one response time — about 50 ms of margin against the
  listener's own idle close, on every single poll, with the dev proxy's reused sockets
  (`panel/vite.config.ts`) carrying a second copy of the race. `keepAliveTimeout` was the one option
  in `http-listen.ts`'s `serverOptions` left at a default; it is now
  `KEEP_ALIVE_TIMEOUT_MS = 65_000`, and `tests/unit/panel/poll-outlives-keep-alive.test.ts` reads the
  panel's `POLL_MS` out of its source to keep the two numbers apart. Found through #125.
- **An unbounded `fetch` behind an in-flight guard turns one lost answer into a screen frozen for
  the life of the tab.** The Devices poll dropped a tick that arrived while the previous request was
  still out — correct, so a slow host cannot have requests stacked on it — but the request holding
  the guard had no deadline, so a host that accepted the connection and never answered held it
  forever. Reproduced (2026-09-01) with a proxy in front of the daemon that swallowed exactly one
  `/rpc`: in headless Chrome the panel sent **no further `/rpc` at all** for the rest of the run, the
  grid went on showing a device that had been detached, and only a reload corrected it. It reads as
  "the poll is fine" because nothing on the screen says otherwise — the lease countdown keeps
  ticking locally from `receivedAtMs` (`panel/src/devices/countdown.ts`). The interval is now the
  request's budget; the guard is only ever as temporary as the request behind it.
- **An authenticated byte route cannot be an `<img src>` or a `<video src>`.** A subresource fetch is
  the browser's *own* request: it carries no `Authorization` header, so `GET /artifact/…` answers it
  with the uniform `401` every unauthenticated request gets (D29, D30), and putting the credential in
  the URL instead is what D20 forbids outright. `panel/src/session/host-client.ts` claimed the
  opposite in a comment — "a browser renders those from the URL" — and the comment was corrected in
  #133 along with the code it was wrong about: the panel fetches the bytes with the session header and
  hands the browser the object URL. Two consequences worth knowing before designing around this
  route. **The whole artifact is buffered in the tab** before it is shown, so a long recording arrives
  in memory rather than streaming. And **the host's `Range` support is not what makes a `<video>` seek
  in the panel** — a blob URL answers ranges in the browser — so that support stays useful for a bare
  `curl` and for anything that fetches the address directly, which is a different set of clients from
  the one it was assumed to serve.
- **A host with no `adb` on its `PATH` looked exactly like one whose adb server had just been
  killed, forever.** Both ended the tracker, both set `stale`, and every surface said the same "the
  host's view was interrupted, check back shortly" — but one clears in 250 ms and the other never
  does: `adb track-devices -l` is restarted on the backoff, fails with `spawn adb ENOENT` every
  time, and nothing anywhere ever says the binary was not found. The information was already
  arriving and being discarded — `DeviceWatcher.onInterrupted` takes a `reason`, and
  `DeviceInventory.markInterrupted` kept only a boolean. Fixed in #168 by classifying that one end
  from the **`ENOENT` error code** Node reports on the spawn (never by matching the message, which
  is written for a person) and carrying it as `staleReason` beside `stale` on `list_devices`. The
  lesson generalises past adb: **a permanent failure presented in the vocabulary of a transient one
  is worse than an error**, because the surface actively tells the reader to wait for something
  that is not coming. `stale` is unchanged and still means "not known to be current" (D6, R35) —
  the reason is additive, and `null` is the ordinary answer.
- **A new *required* field on a method result breaks the new client against the running daemon,
  not the other way round.** `staleReason` was added to `ListDevicesResultSchema` as
  `.nullable()`, which is this repo's usual house style — and `rover list` then answered
  `Host returned an invalid result for 'list_devices': staleReason: Required` against a daemon
  that had been up since before the change (#168, hit on 2026-09-05). That is the *ordinary* case
  rather than an edge one: the daemon starts itself on the first call and then stays up for days
  while every client is re-run from the working tree, so client and host routinely differ by
  whatever landed since. `PROTOCOL_VERSION` does not catch it — it governs the envelope, and the
  rule there already says an added optional field is not an incompatible change. So: **a result
  field added to an existing method is written required and read optional.**
  `StaleReasonSchema.nullish().default(null)` does both from one schema — the host still cannot
  omit it, because the inferred result type is the *output* type, and an older daemon's answer
  still parses, folding absent into the `null` that daemon meant anyway.

Checked on macOS 15 (Darwin 25.6.0, arm64) with `adb` 37.0.1-15733141, 2026-09-06, while
implementing D32:

- **`adb version` answers from the client alone and starts no server.** Run with
  `ANDROID_ADB_SERVER_PORT` pointed at an unused port, it printed `Android Debug Bridge version
  1.0.41` / `Version 37.0.1-15733141` and the path it is installed as, exited 0, and no server
  process appeared on that port — while the operator's existing server on 5037 was left running and
  untouched. That is what makes it usable as the acceptance check of the `adb` search: confirming a
  candidate runs costs one short-lived process and changes nothing about the adb the rest of the
  machine is talking to. `adb devices` would not do — it starts a server as a side effect, which is
  also why `scripts/check-adb.mjs` executes nothing at all.

Measured on macOS 26.6.2 (Darwin 25.6.0, arm64, Apple M3 Pro, APFS on the internal SSD) with
Node v25.2.1, 2026-09-08, while putting the disk budget on the end of every lease (D37, #245):

- **One walk of a full archive costs about 150 ms, and the cost is in the *file count* rather
  than in the bytes.** A tree of the shape §10 describes — 540 runs across 3 projects, 5220
  files, 956 MiB, which is a host sitting at the default 1 GiB budget — walked in **145–155 ms**
  over five consecutive walks. A neglected one four times over that budget — 2160 runs, 20880
  files, 3825 MiB — took **609–686 ms**. That is ~29 µs per file in both, so the walk is linear
  in how many files the archive holds and flat in how large they are: `sizeOfTree` `stat`s every
  file and reads none of them, and doubling a recording's length costs nothing.
- **What it was measured with, and the two ways it is generous to itself.** The shipping
  `createArchiveSweeper` doing a `dryRun` walk with the bounds set far above the tree, so what is
  timed is the walk and nothing else. The archive was **generated**, because no host here had one
  that had accumulated naturally — the file counts and the shape are §10's, the contents are
  zeroes. And the page cache was **warm**: a first walk after a reboot will cost more than this,
  and the number to carry forward is the shape (linear in files, tens of µs each) rather than the
  millisecond.
- **The conclusion, which is the reason the measurement was asked for:** at those numbers a walk
  on the release path needs no cached total. It is off the answer's path already — the sweep is
  `void`-ed behind a release that has already been answered — so the 150 ms is not latency an
  agent waits on, and even the neglected-archive case is I/O the host absorbs between one lease
  and the next. **Nothing was cached**, and had the numbers said otherwise the answer would still
  not have been a cache built here: D6 binds one (a total is re-derived at start, never trusted
  from disk), which makes it its own change rather than a line in this one.

---

## 7. Scope

**In scope:** Android over adb — emulators and physical devices in debug mode treated alike. A
device pool, leases, state restoration. The verbs from §4. CLI and MCP. A host reachable over the
network: an agent on machine A borrows a device from machine B, where Rover runs (D17–D20).
Authentication by host token. **A web panel served by the host** — the operator's view of the
device pool and the archive, and the operator actions that have no home at a terminal (D27).
**A CI gate that runs `npm run verify`** — lint, typecheck, unit
tests — on every pull request (R26); no device tests, since a CI runner has no Android device.

**Out of scope for now:** iOS (the seam only, see §5). Automated tests with assertions — CI runs
the existing unit-test suite, it does not add device-driven assertions of its own. Cloud
device farms, **more than one Rover host in a single deployment** (D18, revised 2026-08-29; §9.4),
a host catalogue, and hosts registering with one another — a
client is configured with the address of its one host and that is all. Comparison against
design renders — Rover supplies screenshots and measurements; judging them against the design is
the agent's job. **Starting emulators and connecting physical devices** — that belongs to whoever
operates the host machine, not to Rover (D21).

**A dashboard was out of scope here until 2026-08-31, and is not any more (D27).** The paragraph
above used to end "and anything resembling a dashboard", followed by a parenthetical noting that
the read-only viewer D24 shaped the archive for "is still not being built now". Both were true
while CLI and MCP were the whole interface. What changed is not the reasoning — D17's single host,
D19's host-side verbs and D24's archive shape are all untouched — but a gap those decisions left:
**there is no way, from any interface, to end a lease you did not take.** `release_device` takes
the lease id as the holder's credential, and D20 keeps that id out of every listing precisely so
nobody can use it against the holder, so `rover release` cannot help an operator either. That is a
missing authority over the pool, not a convenience a dashboard adds. The panel is therefore in
scope, it is **not** read-only, and D27 says what it may do.

---

## 8. What this method will not see

Worth naming out loud, because silence reads as "checked".

- **Nothing goes red on its own.** There is no assertion here; the quality of the result depends on
  the agent's attention, not on the tool.
- **Colour, typeface, weight, radius and spacing — only when the app allows itself to be
  photographed.** A screenshot block takes away the pixels and leaves the semantics.
- **Motion is only ever sampled.** Frames say something rotated; they say nothing about easing,
  duration, or stutter. `record_video` answers with a recording *and* frames cut out of it, and
  both sample: the recorder writes a new frame only when the screen changes, and the extraction
  then samples that a few times a second at a reduced width. An agent asking "is this animation
  smooth" is asking a question neither answers, and reading one out of them anyway is the
  plausible-looking wrong result this whole design is against. The full-resolution read of a
  single moment is `screenshot`.
- **Measurement error is ±1–3 px**, worse on antialiased edges. A 1dp difference is not reported as
  a defect without checking it at several points.
- **One density per device.** A result from one emulator is not a result for every phone — see D14.

---

## 9. State of the work and the backlog

### 9.1 Done

- [x] Settling the verb set and how it all works
- [x] Verifying the adb recipes on API 37 (§6)
- [x] `PROJECT.md`, `.gitignore`
- [x] Agent rules: `CLAUDE.md` → `ai/RULES.md`, plus `ai/CODING_STANDARDS.md`, `ai/ARCHITECTURE.md`, `ai/TESTING.md`
- [x] The board (`ai/RULES.md` §5) and the `/write-issue`, `/solve-issue` skills

### 9.2 How to turn this backlog into issues

**One row of the table below is one issue.** `/write-issue` is assumed — it writes the
specification, picks the labels, puts the card in the Backlog column and records the **Blocked by**
relationships. A row is not a specification; it fixes the four things we do not want to renegotiate
per issue: the **outcome**, the **scope boundary**, the **dependencies** and the **size**.

Four rules when filing these issues:

1. **File them in the table's order** and record `Blocked by` immediately, because nearly every one
   has a real prerequisite. The order of the Backlog column should mirror this table.
2. **The completion criterion from the "Outcome" column goes into the issue as an acceptance
   criterion**, verbatim. It is worded so that it can be checked, not merely declared.
3. **A row number is an identity, not a position.** R21–R24 arrived after the first twenty were
   filed (remote hosts, D17–D20), R25 after that (the artifact archive, D23), and R27–R28 later
   still (per-user auth, D25) — each sits where the dependency order puts them, not at the end of
   the table. The Backlog column mirrors the order of the rows, not their numbering. **R23 was
   later dropped entirely** (D18, revised 2026-08-29; §9.4) — its number is retired, not reused.
4. **Do not split a row into subtasks at filing time.** If it turns out too large during the work,
   whoever implements it splits it — and then it is clear where the seam runs.

### 9.3 The backlog, in dependency order

| # | Task | Outcome — completion criterion | Depends on | Size |
|---|---|---|---|---|
| R1 | Node.js skeleton | `package.json`, `tsconfig.json` + `tsconfig.typecheck.json`, `biome.json`, `vitest.config.ts`, `lefthook.yml`, commitlint, the `lint` / `typecheck` / `test:unit` / `test:device` / `verify` scripts. **`npm run verify` passes on an empty tree.** The configuration is copied from `../swarm`, not invented | — | S |
| R26 | CI: a `verify` workflow on every pull request | A GitHub Actions workflow copied from `../swarm`'s `.github/workflows/verify.yml` and trimmed to this repo's shape (no `dashboard/` subproject to install): checkout, Node 22 via `actions/setup-node` with npm caching, `npm ci`, `npm run verify`. Triggered on `pull_request`; a `concurrency` group cancels a superseded run; `permissions: contents: read`. **No device test runs in CI** — `test:device` needs a real Android device, which no CI runner has, and `npm run verify` already excludes it | R1 | S |
| R2 | Device interface, capability manifest, registry | The manifest is a Zod schema; the registry accepts a backend through one import in the barrel. **No file outside `src/backends/` contains a platform name.** With no backend at all | R1 | M |
| R3 | Backend conformance suite | One run per **registered** manifest. Detects a stub by reading the method's source; a declared capability with no dispatch = failure; an explicit opt-out (`false`) passes. The gate must exist **before** the first backend (`ai/TESTING.md`) | R2 | M |
| R4 | adb output parsers + fixtures from a real device | `adb devices -l`, `wm size`, `wm density`, `getprop`, the `uiautomator` XML. Fixtures in `tests/fixtures/`, with the API level and model in the filename. **No parser infers anything from the shape of a serial** | R1 | M |
| R5 | Android backend: enumeration, `device_info`, lifecycle | The first registered manifest — `index.ts` lands in the change that removes the last stub, not earlier. Reports density and the computed width in dp (D14) | R2, R3, R4 | L |
| R6 | Daemon: process, socket, autostart, IPC | Autostart on the first call (D5). **Two concurrent CLI invocations produce one daemon** — whoever loses the bind connects to the winner, not to a lock file. Every message parsed by a schema, never cast. **The IPC surface is transport-agnostic from day one** (D17) — the network listener from R22 is to be an added transport, not a rewrite | R1 | M |
| R7 | Device inventory in the daemon | The `adb track-devices` stream plus **re-verification at every grant** (D6). A device that disappeared mid-lease is a named error, not an exception to the rule. **The host does not take into inventory a device reached through `adb connect` rather than physically attached** (D18) — the refusal is loud and names the reason | R5, R6 | M |
| R8 | Leases | Granted per device (D7), the owner an explicit string (D16), a 20-minute TTL **renewed by activity**, not by a heartbeat (D8). **A test with five concurrent clients yields exactly one winner** — the predecessor let four through. Only devices physically attached to the host are ever granted a lease (D18). The lease additionally carries `project` and `test_name`, both required (D22) — two more explicit, caller-supplied strings, never inspected or defaulted by the core | R7 | L |
| R9 | State restoration | Stop a recording left running (#191, R43 phase 3), stop the app, airplane mode off, wifi back on, the project's helper services, the project hook. **A test proves the teardown runs on the expiry path too**, not only on `release` (D9). Split in two: the backend's network primitives landed first (#9) so the routine has something real to drive, and §6 records why it must set both radios explicitly with **wifi last** | R8 | M |
| R10 | CLI: `list`, `acquire`, `release`, `status` | Readable by a human and scriptable. This is the interface everything above is debugged through (D4). The host is named by a flag; no flag means the local host. **`rover init` was added later (2026-09-01) and is the one command that runs outside this checkout**: it onboards another repository — the project's hook file under `ROVER_PROJECTS_PATH`, the `rover` entry merged into that project's `.mcp.json`, a generated `ROVER.md`, and the snippet that tells an agent a manual test means Rover. Like `users` (D25) it asks no host: a hook file is host configuration that is never accepted over the wire (D13), and the other three files are the project's own. It **guesses nothing it cannot show you** — every detection is reported with the file it came from, an unrecognised project is registered with no install rather than a plausible one, and an existing hook file is kept rather than overwritten, because it may carry services and a teardown that cannot be reconstructed from the directory. **The page it generates is found before it is written**, by a marker the page carries rather than by its filename (`src/cli/init/locate.ts`): a human moves it into `docs/` or renames it, and the next run rewrites it where it now lives instead of scattering a second copy at the root — which would be exactly the drift a generated page exists to prevent, reintroduced by the tool that generates it. Two of its own pages in one project is a refusal naming both, **before the first write** rather than after three, and a markdown file it did not write is never overwritten. It is also what made §9.4's `bin` decision worth reversing | R8 | S |
| R11 | Verb layer foundation | Target resolution from a **fresh** read inside the verb, waiting on a condition with a timeout, returning the state after the action (D12). **There is not a single `sleep` in the repo** — enforced by a lint rule or a test. A timeout says what it waited for and what it found instead. A verb's result is serializable — the host will execute it, not the client (D19, R21) | R5, R8 | L |
| R21 | Host-side verb execution | The daemon loads the core; the CLI and MCP call verbs over the same surface as leases (D19). **No adb in a client process** — checkable by a test. This row stands ahead of the verb families deliberately: changing the execution model after they are written is a rewrite of six files instead of one | R11 | L |
| R22 | Host network listener and authentication | TCP with TLS alongside the local socket, **the same surface, a second transport** (D17). The host token authenticates, the owner string attributes — **two separate fields, and a test proves the token never becomes the owner nor reaches a log** (D20). A refusal does not reveal what the host has attached | R21 | L |
| R27 | Host user store + `rover users` CLI | A local, host-only credential store (`~/.rover/users.json`, one record per user: identifier, display name, token hash, created-at) and a `rover users add \| list \| revoke \| rotate <identifier>` command that manages it (D25). Dependency-free, `node:crypto`-only hashing. `add` and `rotate` print the raw token **exactly once**; it is never stored, logged, or printed again, and `list` never prints a token or its hash. **This command touches the file directly and never goes over the network or through the daemon** — it runs on the machine holding the instance, not for a remote caller | R10 | M |
| R28 | Network listener authenticates against the user store, retiring the single shared token | `network-listen.ts`'s greeting check stops comparing against one `ROVER_HOST_TOKEN` and instead hashes the presented token and looks it up in R27's store, **re-read at every connection attempt** — never cached for the daemon's lifetime (D6, D25). `ROVER_HOST_TOKEN` and the listener-side schema fields tied to it are removed, not kept as a parallel path. A revoked user is refused on their very next connection attempt, with the daemon already running — no restart. The client side (`network-connect.ts`) is unchanged in shape: a client still presents one opaque token in the greeting, and only what that token has to be — one issued by `rover users add`, not a fixed shared secret — changes | R27, R22 | M |
| R12 | Input verbs | **Done** (#12, #60, #61). `tap`, `long_press`, `swipe`, `scroll`, `type_text`, `press_key`. `long_press` as a drag in place — **not** `keyevent --longpress` (§6) — held past the device's own `secure long_press_timeout`, which is configuration rather than a constant. `type_text` hides the device shell's quoting. Split the way R9 and R16 were, into three: the backend's four **primitives** landed first (#12 phase 1) — `tap` / `swipe` / `typeText` / `pressKey` behind `canInput`, with the dp→px conversion and the text limits §6 records — then the four **gesture verbs** over them (#60 phase 2), `tap` / `long_press` / `swipe` / `scroll`, each on the R11 spine with its own `IPC_METHODS` row; `type_text` and `press_key` closed it (#61), both on the spine with **no target**, and with the backend's text refusal given a wire shape of its own rather than left as `internal_error` | R21 | M |
| R13 | Read verbs | `screenshot`, `read_screen`, `device_info`. `read_screen` works with screen capture blocked and **is a declared capability, not a required method** (§5). Split the way R12 was, into three: the backend's **primitive** landed first (#13 phase 1) — `readScreen` behind `canReadScreen`, the two-command dump recipe of §6 mapped onto `ScreenElement[]` in dp — which is also what flipped the last `false` in the Android manifest and so turned on every path already written against it: after-states, targets by text, and both waits. Two of the three read **verbs** landed second (#67 phase 2) — `read_screen` and `device_info`, one module on the R11 spine with an empty action, because a read verb's work *is* the spine's own capture; `read_screen` carries `requires: ['canReadScreen']`, which is what turns a backend without the capability into a loud failure before dispatch instead of the softer `after: { kind: 'unavailable' }` an unrequired verb would answer, and `device_info` needs no capability because its answer is the `DeviceInfo` D14 puts on every result. `screenshot` landed third (#68 phase 3): the one read that cannot answer in that shape, because pixels are bytes rather than a state the result already carries. It is on the same spine with `requires: []` — the backend method is required, not capability-gated — and what it adds is one nullable `artifact` on `ActionResult` carrying base64, a media type and a byte length, required-and-nullable because `undefined` does not survive JSON. `MAX_ARTIFACT_BYTES` (4 MiB) is derived from the 8 MiB frame cap with base64's inflation accounted for, and going over it is an `artifact-too-large` failure naming both numbers rather than a truncated image. R13's last acceptance criterion — a black screenshot stays distinguishable from a broken device — is documented on the verb and in README.md rather than asserted, because it takes a known screen: the check is a capture of the system home screen, and `read_screen` is the read that survives a capture block (§6). The transfer contract around the bytes is R24 and the durable archive is R25 | R21 | M |
| R14 | `record_video` + slicing into frames | **Done** — phase 1 (#14) the recording, phase 2 (#82) the frames. The recording must finish before it is pulled — a file pulled earlier has no `moov` atom and cannot be read at all. Split the way R12 and R13 were, except that the primitive and the verb over it are **one phase** here: `recordVideo` is a method nothing but this verb would ever call, so landing it alone would ship a dead method and a capability flag declaring an ability no caller can reach. So phase 1 is the whole lifecycle — `canRecordVideo` as a declared capability rather than a required method (§5, D11), `recordVideo(serial, { durationMs })` answering with **bytes and never a host path** (D19), the `record_video` verb on the R11 spine with `requires: ['canRecordVideo']`, one `IPC_METHODS` row and one daemon handler, and the recording on the existing `ActionResult.artifact` so no second answer shape was needed. The Android half is §6's measured recipe: `screenrecord` to a fixed device-side scratch path made exclusive per device — **per scratch path since R43 phase 1**, so a screen read no longer queues behind a recording — completion detected by `waitForCondition` polling `pidof` until the recorder is gone — **a condition with a timeout, never a sleep** (D12(b)) — then `exec-out cat`, then a top-level MP4 box walk requiring `ftyp` first and a `moov` present, then `rm -f` in a `finally` that runs on the refusal paths too. A pull without a `moov` is an `unfinished-recording` verb failure naming the device and the byte length rather than an `internal_error`. `MAX_RECORDING_MS` (15 s) is derived from `MAX_ARTIFACT_BYTES` against the backend's 2 Mbps, and the relationship is asserted rather than left to drift; over the artifact bound is still `artifact-too-large`, never a truncated file. R24 (chunked transfer) and R25 (the durable archive) were unchanged by that phase. **Phase 2 added the frames** on `RecordVideoResultSchema = ActionResultSchema.extend({ frames })` — the `ReadLogsResultSchema` pattern, so the recording stayed on `artifact` and one field was added — with `RecordVideoCallResultSchema` on the row and `runVerb` already generic in the `ActionResult` subtype. The extraction is a host tool (`ffmpeg` off `PATH`, §6's measured recipe: the recording on stdin, PNGs on stdout, **no host temp file**, an explicit stdout bound and an explicit timeout), and it lives in `src/daemon/frames.ts` rather than in the verb layer because `src/ipc/verb-methods.ts` imports the verb schemas — a spawn under `src/verbs/` would be `node:child_process` in every CLI's module graph. So the verb declares a `FrameExtractor` and the daemon supplies it, the way it supplies the backend, and `tests/unit/no-backend-in-a-client.test.ts` walks the graph to keep that a fact. Three named failures, all data rather than `internal_error`: `frame-extraction-unavailable` (the branch for a decoder that never started), `frame-extraction-failed` carrying the exit code and the stderr, and `frames-too-large` carrying the count and both byte numbers. `MAX_FRAMES_BYTES` (1.5 MiB) is derived from the frame cap with the recording's own base64 share accounted for, `MAX_FRAMES` from `MAX_RECORDING_MS` × `MAX_FRAMES_PER_SECOND` **+ 1** — `fps=n:round=up` fills slots `0…duration × rate` — and both derivations are asserted rather than left to drift. That one is a bound a real call reaches rather than a guard: §6 measures a 15 s capture of a still screen declaring a 27.61 s timeline, and the sampling follows the container. So the decoder is given `MAX_FRAMES + 1` on `-frames:v` — the flag exits 0 when it bites, so a cap passed straight to it is a list silently cut short — and an overrun is a named refusal, and `FRAME_EXTRACTION_TIMEOUT_MS` lives beside the other verb-layer bounds in `src/verbs/record.ts` rather than in the runner, because `rover record`'s own request timeout has to cover it and a client may not import a daemon module. R24 and R25 are unchanged by phase 2 as well. **#183 added the reporting half**: the answer now carries what the recording *contains* on `result.container` — the encoded sample count and the container's own declared duration, read by a bounded box walk in the verb layer (`src/verbs/recording-container.ts`, no process and no host filesystem, so it stays out of the daemon and out of no client's module graph) — and **names** the still-screen case rather than adding a refusal for it. A recording of an idle screen stays `ok` with the one frame `round=up` extracts, because it is a true answer about the device; what was wrong was the answer saying nothing about it (ai/RULES.md §2). Neither the extractor nor its bounds changed. **#185 added the normalisation half**: the artifact is no longer whatever the encoder wrote. `screenrecord` produces a variable-frame-rate stream whose samples exist only where the screen changed, so a still screen was a structurally valid MP4 no player would show anything for and an ordinary capture declared a timeline that was not the requested one — a file written to a client's disk (R24) and filed in the durable archive (R25) that whoever opened it could not tell from a broken one. So the pulled recording is re-encoded on the **host**, before it becomes `result.artifact`, at a constant `NORMALISED_FRAME_RATE`: held across the requested window when the container declared no duration of its own, otherwise over the recorder's own timeline with every sample intact, because compressing a container declaring 27.61 s into the 15 s that were asked for would mean dropping a sample or re-timing it. `result.normalisation` says **which of the two** it is showing, and it and `result.container` are deliberately about two different files — `container` still describes the pulled bytes, which is the only place the still-screen case can be *named*, since a normalised still screen is many samples over the window. Split the way the frames were: `src/verbs/recording-normalisation.ts` is the pure policy and the constants (no process, no filesystem, so it stays out of every client's module graph), `src/daemon/normalise.ts` is the `ffmpeg` run. That one writes a **host temp file** where the frame extractor deliberately writes none, and §6 records why — the mp4 muxer refuses a non-seekable output, and the fragmented alternative makes `readRecordingContainer` answer `unreadable` — so it owns a `mkdtemp` directory and removes it in a `finally` on every path, with the input still on `pipe:0`. Keeping that file out of every answer took two things beyond writing it under `mkdtemp`, both §6 traps: the run is spawned with its own directory as `cwd` against a **bare** output name, because ffmpeg echoes its output URL in its own error-level messages and that stderr is data a refusal carries, and the scratch file is redacted out of that stderr besides; and a `mkdtemp` that rejects is a named refusal rather than the `internal_error` an unmapped fs error would become, carrying Node's own message and the path in it (D19). `+faststart` keeps what it writes decodable from a pipe, which is the property everything downstream rests on. Two more named failures, both data rather than `internal_error`: `recording-normalisation-unavailable`, which is this host unable to run the encoder at all — off `PATH`, or with nowhere to let it write — and `recording-normalisation-failed`, which covers an exit 0 that wrote nothing — the one path by which a silently un-normalised file could otherwise have become the answer. `MAX_ARTIFACT_BYTES` now bounds the **normalised** bytes, because re-encoding changes the count, and `NORMALISED_MAX_BIT_RATE_BPS` exists so that normalising cannot turn a call that works today into an `artifact-too-large` refusal. What did **not** move: the frames are still sliced from the pulled recording, so `MAX_FRAMES` keeps its derivation and its assertion, and nothing anywhere relates a frame count to a duration times a rate | R13 | S |
| R15 | App verbs | `install_app`, `launch_app`, `stop_app`, `clear_app_data`, `read_logs`, `pull_file`, `push_file`. `read_logs` is to catch a failure a screenshot will not show. Split the way R12 was, into three: the **app-lifecycle verbs** landed first (#15 phase 1) — `launch_app` / `stop_app` / `clear_app_data`, each on the R11 spine over a backend primitive that already existed, sharing one `IPC_METHODS` params schema, with `requires: []` and no target because an app id addresses a package rather than something on the screen; `read_logs` landed as phase 2 (#69) — a required `DeviceBackend.readLogs`, a log parser with captures of its own, and the first verb whose answer carries a payload beyond `ActionResult`, which is what factored `VerbCallResultSchema` into `verbCallResultOf()` and made `runVerb` generic for phase 3 to reuse; `install_app`, `pull_file` and `push_file` landed as phase 3 (#70) — the transfer half, and a byte-transfer concern (R24) rather than an app-lifecycle one: two required `DeviceBackend` methods (`pushFile`, `pullFile`), a `MAX_TRANSFER_BYTES` cap (4 MiB) enforced in the params schema so an over-sized call is `invalid_params` naming the limit rather than a frame the host allocates, and the host temp file the two inbound rows need written and removed by the daemon's handler in a `finally`. `pull_file` answers on `ActionResult.artifact` like `screenshot` rather than in a shape of its own, so its result carries no path at all. **`install_app` was unexercised against a device when this row landed** — there is no APK in this repository, the same constraint `tests/device/android/app-control.test.ts` records — and **R24 phase 2 (#85) closed that gap**: a real 29 487-byte APK installed end to end through `rover install`, confirmed by `pm path` moving to `/data/app` (§6, 2026-08-30). What was already established is the piece adb decides before the device is involved: `adb install -r` refuses a file whose name does not end `.apk`/`.apex` with `filename doesn't end .apk or .apex`, and takes the same bytes once renamed (§6), which is what `withInstallablePackage` exists for. Everything else about the verb — the decode, the host temp file and its removal, the size refusal — is still covered over a stub backend, and the automated suite carries no APK | R21 | M |
| R16 | Environment verbs | **Done** (#9, #16). `set_airplane_mode`, `set_wifi` through `cmd connectivity` and `cmd wifi` — **not** through `svc`, which is gone (§6). Both paths without root. Split in two: the **primitives** landed with R9's first phase (#9) — `setAirplaneMode` / `setWifiEnabled` on the Android backend, behind `canControlNetwork` — and the **verb layer** over them landed second (#16), one module on the R11 spine, two rows sharing one `IPC_METHODS` params schema (a lease id and a required `enabled` boolean, so "turn wifi off" and "say nothing" cannot be the same call), no new backend method and no new answer shape. It is the first family whose `requires` names a capability that is not always true — `['canControlNetwork']`, reached through `capabilityMethod()` rather than `context.backend.*`, which is what turns a backend without the toggles into a `missing-capability` failure naming capability, device and backend before anything is dispatched (D11) instead of a toggle that reported success. Both answer with a null `target`, because a radio is not something on the screen, and with the state after themselves (D12(c)) — the spine's own capture, which is evidence the device was still answering and **not** a reading of the radio: `DeviceBackend` still has no network getter, and §6 records the two reads that would be one. These drive the same two backend methods R9's restoration drives, which is what keeps the two callers from drifting: one recipe per toggle, in one backend, with a second caller rather than a second path | R21 | S |
| R24 | Artifact transfer across the machine boundary | **Done** — phase 1 (#24) the client writes the bytes it is handed, phase 2 (#85) the three file verbs from the client. Screenshots, recordings and pulled files come back as bytes; **a path returned to the agent exists on the agent's machine** (D19). In the other direction: `install_app` and `push_file` send a file to the host. The recording from R14 finishes on the host before the transfer, not during it. The size limit is explicit and named, and does not announce itself as a truncated file. **Phase 1** (#24) was the *client* half, proved with the two verbs that already produce bytes. The host half was already there (`ArtifactSchema` is base64 and never a path; `MAX_ARTIFACT_BYTES` is checked before encoding and refused as `artifact-too-large`; R14 proves a recording finished before it is pulled), and what was missing was the other end of the wire: no client had ever decoded an artifact. Two shared CLI modules — `src/cli/_shared/artifact.ts`, which decodes, checks the decoded length against the host's own `byteLength`, writes the bytes **here** and answers `path.resolve` of `--out`; and `src/cli/_shared/verb.ts`, which renders a `VerbCallResult`'s three branches and picks the exit code — under `rover screenshot` and `rover record`. `--out` is required, so the CLI invents no naming policy. The write is the last thing that happens and only on the `ok` branch, so `artifact-too-large`, `unfinished-recording` and a decoded length that disagrees with the host's all exit 1 leaving **no** file at `--out` rather than a short one. `record` raises its own request timeout past the 15 s recording bound. Neither module branches on `--host`, and `tests/unit/cli/remote-host.test.ts` asserts the remote path writes the same bytes to the same kind of local path as the local one. **R15 phase 3 (#70) landed the host half of those three file verbs, and with it both caps this row lifts**: `MAX_TRANSFER_BYTES` (4 MiB) inbound and `MAX_ARTIFACT_BYTES` (4 MiB) outbound, derived from the 8 MiB frame cap with base64's inflation accounted for, and both refusing by name rather than truncating. **Phase 2 done** (#85) — those three verbs from the client, and the first time bytes travel *toward* a host. `rover pull` is phase 1's writer with a device path added, because `pull_file` answers on `ActionResult.artifact` exactly where `screenshot` does, so it reuses both shared modules unchanged. The direction that was new is the upload, and it is one module: `src/cli/_shared/upload.ts` — `resolveSource` resolves the path and stats it, refusing a missing file, one this process cannot read, one that is **not a regular file** and one over `MAX_TRANSFER_BYTES` as a `UsageError` (exit 2, with the command's own usage, naming the file, its real size and the limit); `readPayload` reads and base64-encodes it. **The size comes off `stat` and never off the buffer**, which is the same reasoning `src/verbs/files.ts` records for handing `MAX_ARTIFACT_BYTES` *down* to `pullFile` rather than checking on the way back — a refusal issued after the bytes are in the heap has already cost what it was meant to prevent. Both happen **before `connectToHost`**, so the acceptance criterion is assertable rather than argued: when a source is refused the backend mock records no call at all, which is what "nothing partial was sent" means here. Exit 2 rather than the 1 reserved for a host that said no mirrors `boundAttribution` — the value is the caller's and decidable before any connection. `deliverTransfer` renders the outbound direction's answer, built from what the host said and never from the call, so `--json` structurally cannot echo the payload. `rover push` and `rover install` take a `<local-path>` and `install_app` takes no device path at all, because the package is on the caller's disk (D19). The round trip is asserted over a payload that is **not** valid UTF-8, since a decode in the middle is the silent corruption this path invites, and once more over `--host remote` because one code path serves both hosts. The manual run against a real device is what covers `install_app`, and it is the run that finally exercised it: a real 29 487-byte APK installed through `rover install`, plus a byte-exact 100 000-byte push/pull round trip and all three client-side refusals (§6, 2026-08-30). **The automated suite still carries no APK**, so `install_app` is covered there only over a stub backend. What is left after this row is the **mechanism** — chunking, resumption, streaming — which has to land underneath those verbs without changing their contract. The number that says why: a real APK is routinely tens of megabytes (the one used to check the install recipe was 45 MB), so `install_app` today moves a small package and refuses a large one | R13, R14, R15 | M |
| R25 | Durable artifact archive on the host | **Done** (#27). Every verb that produces a screenshot, a recording, or a log pull additionally writes it into `<project>/<test_name>/<lease-id>/<device-serial>/…` on the host (D23, §10), alongside a `device_info.json` snapshot per lease-device pair (D14). **An absent `test_name` fell back to a single fixed directory name** so the tree shape never varied; **#129 reversed that** — `test_name` is required, and the shape now never varies because the field cannot be absent (D22, as amended). **The archive path is never the one returned to the agent** — R24's bytes-over-the-wire contract is unchanged by this row. Retention (a TTL or size cap, and who prunes) is explicitly out of scope here — see §9.4. The write lives in `src/daemon/verb-handlers.ts`'s shared preamble rather than in `src/verbs/`, for the reason `src/daemon/frames.ts` does: `src/ipc/verb-methods.ts` imports the verb schemas, so host filesystem work under `src/verbs/` would be host behaviour inside every client's module graph (D19). Unlike the frame extractor it needed **no seam in the verb layer at all** — no verb signature, verb option or result schema changed, because the daemon already holds the lease and the finished result together — which is also what makes "the archive path is never returned" structural: `src/ipc/server.ts` parses every answer against that row's `.strict()` schema, so a path on a result would be `invalid_result` before it left the host. Two modules: `src/daemon/archive-path.ts` (where the root is — `ROVER_ARTIFACTS_PATH`, empty counts as unset — and how an opaque caller string becomes one path segment, §10's sanitising rule with the collision suffix) and `src/daemon/archive.ts` (the write, one `switch` on the verb for the three payload kinds). `Lease` gained one host-local field, `createdAtMs`, because the directory name has to sit where the run *started* and `use()` pushes `expiresAtMs` forward on every call. Sequence numbers are per lease and per kind, allocated **synchronously before any await** — a holder can fire two verbs down one connection — and dropped by `ArtifactArchive.forget` off the lease store's existing end hook, so the daemon does not grow with the number of leases it has granted. `record` **never throws**: a full disk or an unwritable root is a `console.warn` naming the path, and the verb answers exactly as it would have, which is what makes the archive additive rather than substitutive. `StartDaemonOptions.artifactsRoot` is **required** rather than defaulted, for the reason `network` is never read from `process.env` there: a unit test must not write into the developer's own `~/.rover/artifacts`. Retention is still §9.4's, and the follow-up row is filed now that this has shipped | R8, R13, R14, R15, R24 | M |
| R17 | Project hooks (D13) | A Zod schema: the install command, helper services, teardown. **The core knows no application's name**, and a default value that mentions one is a bug. The schema also carries the `project` identifier consumed by R25's archive (D22), so it is set once per project instead of retyped by every caller. **Done in four phases** (#17, #94, #95, #96) — the hook file and the one consumer this repository had already built a seam for, then the client-side `project` default, then the install command, then the helper services; each field landed with its consumer, because a field without one is a row in the catalogue describing something nothing reads (`ai/RULES.md` §7). What landed: `src/daemon/project-hooks.ts`, the Zod source of truth for `<project>.json` under `ROVER_PROJECTS_PATH` (`~/.rover/projects`, empty counts as unset), carrying `project`, `apps`, `install`, `services` and `teardown`, mirrored row for row in `README.md`. The empty file parses to `apps: []` and no hooks at all, asserted — that is the executable form of "a default that names an application is a bug". The file lives on the **host** (D19: verbs run where the hardware is, and D19's own reasoning names the project hooks as the thing that must not be stranded on the far side of the network); it is never accepted over the wire, and it is re-read at every use and never cached (D6), so an edit bites on the next lease that ends with nothing restarted. **The identifier shape is the traversal guard**: a `project` string that is not `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` resolves to no hooks, and no path is built from it at all — not a sanitised one, which is the difference from §10's archive segments, where an opaque string has to *become* a directory. A file whose `project` field disagrees with its own name is a loud refusal naming both, so a copied file cannot quietly serve the wrong project. Three modules rather than one, and the split is load-bearing: `project-hooks.ts` only reads and parses, so anything may import it; `hook-command.ts` is the only one that spawns (`shell: false`, an 8 s bound asserted to sit under the restorer's 10 s rather than left to drift, a stderr **tail**, `ROVER_PROJECT` and `ROVER_DEVICE_SERIAL` in the child's environment, a named `HookCommandFailedError`). The run ends on the child's own `exit`, never on `close`, which is what makes that 8 s a bound at all: `close` waits for the *pipes*, and the ordinary teardown that backgrounds a helper leaves a grandchild holding them with nothing left to kill it — so the hook would exit 0 in milliseconds and be reported ten seconds later as one that never finished, with the promise and its two pipes retained for the daemon's lifetime; and `project-resolver.ts` joins them. It sits beside `frames.ts` under `src/daemon/` for that module's reason and one more — `restore.ts` is imported by `lease-handlers.ts`, so a spawn there would trip `remote-never-spawns.test.ts`. R9's `ProjectResolver` seam widened in exactly two ways: **async**, because it reads a file now and a synchronous read would block the daemon's event loop for every other connection, and **given the serial**, because a teardown that cannot name the device it is undoing is the wrong shape for the phases after this one. Its existing containment is unchanged, which is what makes one unparseable file cost that project's own steps and nothing else. `StartDaemonOptions.projectsRoot` is **required** and resolved from the environment only in `main.ts`, for `artifactsRoot`'s reason and more sharply: a `startDaemon()` in a unit test must not start running commands out of the developer's own `~/.rover/projects`. The headline criterion is proved end to end over a real hook file and a real child process, on **both** paths a lease can end (D9, R9) — a `release_device`, and a swept expiry with nobody left to ask. **Phase 2** (#94) added the other side of the identifier: `ROVER_PROJECT_FILE`, a client-side variable naming **one** hook file, whose `project` becomes the default for `rover acquire`'s `--project` and the MCP `acquire_device` tool's `project` argument (D22) — set once per project instead of retyped per call. Convenience only, and the boundaries are the point: the wire is untouched (`AcquireDeviceParamsSchema` is not edited, `project` stays a required opaque string the core never inspects), `owner` is still never derived from anything (D16, D20), and nothing is searched for — one explicit path, no walk up from `cwd`, no `.rover/` convention. Both clients resolve it the same way through one reader in `project-hooks.ts`, which is what phase 1's spawn-free split bought: a client imports it without tripping `no-backend-in-a-client.test.ts`. Two shapes are load-bearing. The MCP tool's optional variant is **derived** — `AcquireDeviceParamsSchema.partial({ project: true })` — and chosen only when a file is configured, because the SDK validates a call against the *declaration* before the handler runs: a hand-written second copy would drift, and an always-optional declaration would lie to the agent about what it must supply. And a configured file that is missing or will not parse is a loud failure naming the path — exit 2 from the CLI, a startup death on stderr for the MCP server, before any tool is advertised — never a silent fallback, because the quiet version of that is a lease attributed to nothing, which is the failure D20 and D22 exist to prevent. **Phase 3** (#95) added the install command and the verb that runs it: `ProjectHooksSchema` gains an optional `install` (the same `HookCommand` as the teardown, with no default naming anything — the empty file still parses to no install, asserted), and `InstallAppParamsSchema.packageBase64` becomes **optional**, so one verb answers two ways and the schema says which arrived — a call carrying bytes is unchanged in wire, bound and result, and a call carrying none runs the lease's project's install on the host with `ROVER_DEVICE_SERIAL` set to the leased device, which is the pinning that keeps an install off a neighbour's hardware (§2). The verb layer still never spawns: `src/verbs/files.ts` declares a `ProjectInstaller` seam and `src/daemon/project-install.ts` fills it, the `FrameExtractor` split exactly, because `src/ipc/verb-methods.ts` imports the verb schemas and a `node:child_process` under `src/verbs/` would land in every client's module graph. Three **named** failures rather than `internal_error`, because each is a different next move: `project-not-registered` (send the bytes, or have the project registered), `install-hook-undeclared` (the file is there and declares no install — an `ok` here would report an install that never ran, and a default command would be the core naming an application), and `install-hook-failed` carrying the exit code, the signal and a stderr tail, since a non-zero exit is data and only the stderr says why a build refused. `HookCommandFailedError` gained one field, `outcome`, so the runner's own words for how a run ended survive into that answer — an exit, a kill at the bound and a program that never started are indistinguishable from a null exit code. The bound is `INSTALL_HOOK_TIMEOUT_MS`, five minutes, and it lives in the **verb layer** for `FRAME_EXTRACTION_TIMEOUT_MS`'s reason — a client has to see it and cannot import a daemon module (D19) — with both of its relationships asserted rather than described: under `LEASE_TTL_MS` (D8: the lease is renewed when the call arrives, so an install that outlived it would have the sweep fire restoration on a device the install is still driving) and inside `MAX_VERB_TIMEOUT_MS`, and above the teardown's 8 s because a build is not a stop. It is a verb a caller asks for and never runs at grant time. Byte-transfer limits are untouched: `MAX_TRANSFER_BYTES` and `MAX_ARTIFACT_BYTES` are R24's row. Proved end to end over the real socket against a **real hook file and a real child process** — the marker the hook writes carries the project and the serial it was told — with the three refusals and the untouched bytes path asserted beside it. **Both clients now ask for it** (#104, which is where that gap was closed): `rover install <lease-id>` with the `<local-path>` left off is the byte-less form, and `install_app` is an MCP tool declared as `InstallAppParamsSchema.omit({ packageBase64: true })` — the project form and no other, so an agent cannot paste an APK into a JSON argument. Both clients raise their own request timeout to `INSTALL_HOOK_TIMEOUT_MS + DEFAULT_REQUEST_TIMEOUT_MS`, which is the relationship this row's five-minute bound was written down for. Neither client decides whether the form is *available*: an omitted package is simply a key missing from the request, so `project-not-registered` and `install-hook-undeclared` stay the host's named answers at exit 1 (or `isError`) rather than a usage error a client invented about the wrong machine's configuration. **Phase 4** (#96) added the helper services, the last third of D13's hook set: `ProjectHooksSchema` gains `services`, a bounded list (at most eight) of named entries each carrying a `start` hook command and an optional `stop`, on the same `HookCommand` shape — the empty file still parses to no services, asserted, and `stop` is optional because a container started with `--rm` has nothing for the host to stop. The name shape is narrow for the reason the project identifier's is, minus the traversal half: nothing is looked up by it, but it is **quoted back to whoever was refused a device**, so a newline in one would be a hook file writing its own lines into a client's terminal. `src/daemon/project-services.ts` starts them inside `acquire_device`, in declaration order, **after** the re-verification and the previous lessee's restoration and **before** the grant is answered; a start that fails refuses the grant through one new reason in the existing vocabulary — `service-failed`, carrying the service's name and the program's stderr tail — stops in reverse whatever that grant had already brought up, and releases the lease it took, so the device is free for the next caller rather than held by a grant that did not work out. A hook file that will not parse refuses a grant the same way, which is a **behaviour change worth stating**: before this, such a file only warned when a lease ended; now it also blocks grants on that project, because a file the host cannot read is a file whose services it cannot start, and the alternative is a lease on a device nothing was started for. That start is the one awaited step **below** the store's synchronous insert, and both of `lease-handlers.ts`'s ordering rules survive it: exclusivity is settled by then, so no second grant can interleave, and the start never throws, so nothing past the insert can turn into `internal_error` and wedge the device for a TTL. It cannot move above the insert either — a caller about to be refused `held` would otherwise start, and then stop, the services of whoever actually holds the device. The whole phase is bounded by `SERVICE_START_TIMEOUT_MS` (20 s, each command capped by whatever is left of it), stated against the client's 30 s `DEFAULT_REQUEST_TIMEOUT_MS` because `acquire_device` is the one call no client raises that for, and a grant answered after the caller gave up holds the device for a full `LEASE_TTL_MS`. The **stopping** half is the restoration's and reaches the device through the resolver that already answers the teardown, one read of the file for both: the stops run ahead of `teardown`, in the reverse of declaration order, each contained by the existing `step()` and bounded by `TEARDOWN_TIMEOUT_MS`, on **release and on expiry alike** (D9). They are unconditional, the way the app and radio steps are, so a `stop` must tolerate a service that is not running. What a grant started is tracked per lease and dropped on the lease store's end hook beside `ArtifactArchive.forget`, so the host does not grow with the leases it has granted. **No port field and no allocation** — that is R18, which landed first (#18), so a service's `start` and `stop` go through the same `runHookCommand` and are told the lease's slot for free. That slot is what makes the stops correct per **lease** rather than per project: two devices can be leased for one project at once, both grants run the same declared commands, and a `start`/`stop` pair namespacing by `ROVER_SLOT` brings up one instance per lease and takes down its own. A pair that ignores it addresses one shared instance instead, and then the first lease to end takes it away from the other — the project's contract to keep, stated in `README.md` where the file is written, because these are opaque commands and the host cannot read one and tell which shape it is. The **refusal path shares the 20 s too, its rollback stops included**: a fresh per-command bound there would let a project with several slow `stop` commands answer `service-failed` after the client's 30 s had already turned it into an opaque host error, losing the one thing a named refusal is for, so one deadline is taken before the first start and a stop with nothing left of it is warned about rather than spawned. Health checks, readiness probes and restart-on-crash are out of scope too, which is why a start must be a start rather than a wait for readiness. Proved over a real hook file and real child processes on both paths a lease can end, plus over the real socket for the refusal | R9 | M |
| R18 | Per-slot helper service port allocation | **Done** (#18). No race, with recovery after an orphaned slot. The precondition for parallel work with more than two devices. A **slot** is a live lease's numbered parallel position on this host, and the ports follow from its index by arithmetic — `SLOT_PORT_BASE + index * PORTS_PER_SLOT`, in `src/daemon/slots.ts`. Load-bearing choices, in the order they matter. **The slot lives on the `Lease` record**, not in a second table keyed by lease id: its lifetime is exactly the lease's, every consumer already has the lease in hand, and a parallel table is precisely the second piece of state that can fall out of step with the set of live leases (D6). The store carries it and reads nothing out of it, the way it treats `owner`, `project` and `testName`, and `use()`'s spread carries it through a renewal — asserted, because a renewal that dropped it would silently unport every later hook. **The allocation sits inside the same straight-line section that makes a grant exclusive** (`lease-handlers.ts`), immediately before `leases.acquire` and after the one thing on that path that can throw, so two concurrent grants cannot both be given one block for exactly the reason they cannot both be given one device — R8's guarantee, bought a second time rather than reinvented — and a grant refused because somebody holds the device hands its slot straight back, still with no `await` in between. Proved by R8's own five-client test in a second costume: five clients on five different devices, all held at a barrier inside `describeDevice` (the grant path's only `await`) so every one is provably past it before any reaches the store, get five distinct indices and five disjoint port ranges. **Every lease gets one, hooks or no hooks**: deciding otherwise would mean reading the project's hook file at grant time, which is a file read, which is an `await` in the one section that may not have one. **Reclamation is the last step of the lease-end path, not the first.** `DeviceRestorer` gained an `onRestored` seam invoked at the tail of the per-serial chain, and `listen.ts` fills it with `slots.release(lease.slot)`; `onLeaseEnded` is deliberately *not* given a fourth line. The teardown that just ran is the thing that was told those ports, and the allocator hands out the lowest free index — so freeing them when the record disappeared would give the very next grant a block the previous lessee's `stop` is still on, as the likely case rather than a rare one. Same path and same clock as restoration (D9), never a second timer with its own idea of what is dead, and `TEARDOWN_TIMEOUT_MS`/`SETTLE_TIMEOUT_MS` already bound how late reclamation can be. The headline criterion is proved on the expiry path with nobody left to ask — acquire, move the injected clock past the TTL, `sweep()`, settle, and the orphaned index is back and handed to the next grant — beside a test that pins the ordering by asserting `taken() === 1` from inside the teardown itself. **An exhausted pool refuses by name**: `AcquireRefusalReasonSchema` gained `no-slot`, with a message naming the device and the pool size. Granting a lease with no ports would be the silent degradation `ai/RULES.md` §2 forbids and `internal_error` would say the host broke when it is simply full; both clients render a refusal generically, so neither needed editing. **Rover reserves numbers and never binds them** — the project's own service does — so the allocator does not probe: a probe would be check-then-use, and it would have to be awaited inside the section that may not await. The guarantee is bounded honestly instead: no two live leases are ever given the same numbers. The range is chosen to be out of the way — `SLOT_PORT_BASE = 26000`, `PORTS_PER_SLOT = 8`, `SLOT_COUNT = 64`, so 26000–26511, one contiguous block an operator can reserve or firewall in a line, clear of the ports device tooling and web projects actually use and **below every ephemeral range** so the OS cannot hand one out from under a lease. They are constants with test seams in the spirit of `LEASE_TTL_MS`, **not** environment variables and no catalogue row: the catalogue is what an operator *sets*, and there is nothing to tune yet; if the range ever collides on a real host, the follow-up is a documented variable added deliberately. **What a hook is told**: `ROVER_SLOT`, `ROVER_PORT_BASE` and `ROVER_PORT_COUNT` beside the existing `ROVER_PROJECT` and `ROVER_DEVICE_SERIAL`, written after the hook's own declared `env` so a project cannot override the one thing the daemon must guarantee. `ROVER_PORT_COUNT` exists so a hook reads the block size rather than hard-coding one that later drifts. `HookCommandContext.slot` is **required**, not optional — every hook run belongs to a lease and every lease has a slot, and a required field is what stops a future third call site from quietly running a child that was told nothing. Asserted against real child processes on both hook families and on both paths a lease can end. Nothing crosses the wire: `GrantedLeaseSchema` stays `.strict()` and gained nothing, with a negative assertion over the real socket saying out loud that ports are host state. **This landed before R17 phase 4** (#96, helper services in the hook file), and is not a field nothing reads: the ports have two real consumers today in the `install` and `teardown` hooks, which already run as real child processes. R17 phase 4 (#96) then landed on top of it: a service's `start`/`stop` go through the same `runHookCommand` and inherit this contract for free, and the slot is what lets one project be leased twice at once with a set of services each — the stops run with the **ending** lease's slot, so a pair that namespaces by it takes down that grant's own instance | R17 | S |
| R19 | MCP server | Verbs as tools, Zod schemas as their declarations. **A missing capability is a loud, agent-readable error** naming the capability and the device (D11) — never a silent degradation. Zero verb logic in this layer. Pointing at a remote host is server configuration, not a tool parameter — the agent does not know where the hardware sits. **Split in three, the way R12–R14 were: phase 1 the server and the device tools (#19), phase 2 the verb tools (#89), phase 3 the rows that carry bytes — `screenshot`, `record_video`, `install_app`, `push_file`, `pull_file` — and the artifact contract. Phases 1 and 2 done** — `src/mcp/` on `@modelcontextprotocol/sdk`, stdio, `npm run mcp`, declaring the four device and lease rows of `IPC_METHODS` (`status`, `list_devices`, `acquire_device`, `release_device`) under those names exactly. The exported `*ParamsSchema` values **are** the `registerTool` declarations, so the JSON Schema an agent reads and the parse the daemon performs are one object and there is no hand-written copy to drift; no `outputSchema` is declared, because a result schema's *output* type is full of branded transforms JSON Schema cannot express, and the answer travels as the host's own document in a JSON text block plus `structuredContent`. Every handler is one connection, one IPC request and a `close()` in a `finally` — the CLI's own shape, so the local host autostarts on the first tool call (D5) and no connection is held across one. A refused acquire is `isError` carrying `heldBy`, an unreachable host is a sentence naming the address and the port, and neither is ever an empty list. Which host it asks is **configuration, resolved at startup**: `ROVER_HOST_ADDRESS` set means remote, unset means the local daemon, a half-configured remote dies on stderr before the transport is connected, and no tool takes a host parameter (D17). Two things landed with it: the transport choice moved out of `src/cli/_shared/host.ts` into `src/daemon/host.ts` so the two clients share the one place a transport is chosen (the CLI keeps its `--host` translation and its exit codes, unchanged), and `entryUrl` moved to `src/core/entrypoint.ts` so the MCP entrypoint does not import the CLI — whose `console.log` would corrupt a frame on a stdout that belongs to the protocol, which `tests/unit/mcp/stdout.test.ts` now gates as a source scan. `mcp/index.ts` is on `CLIENT_ENTRYPOINTS` (D19). **Phase 2 added the sixteen verb rows whose answer is plain data** — `wait_for`, `wait_until_gone`, `tap`, `long_press`, `swipe`, `scroll`, `type_text`, `press_key`, `read_screen`, `device_info`, `launch_app`, `stop_app`, `clear_app_data`, `read_logs`, `set_airplane_mode`, `set_wifi` — under those names exactly, with no platform suffix (D10). One table, one row per verb, each declared from the same exported `*ParamsSchema` the daemon parses with, so the three app rows share one declaration and the two environment rows share another, exactly as the calls do. Zero verb logic: every handler is one `callHost` and one shared mapping of `verbCallResultOf`'s three branches, so an `ok` travels whole — the resolved target, the after-state and `read_logs`' entries where the host put them — while a failure and a refusal are both `isError` leading with the host's own sentence and carrying the structured document under it, which is the same three branches `src/cli/_shared/verb.ts` renders for a human. **A missing capability is the loud error D11 asks for**: `read_screen` on a backend that does not declare `canReadScreen`, and either environment row on one without `canControlNetwork`, come back `isError` carrying the `missing-capability` failure — the kind, the capability, the serial, the platform and the backend label — never an empty screen, never a toggle that quietly did nothing, never an `ok`; the tool descriptions name the capability too, so an agent can check the list `acquire_device` gave it before it calls. The five rows that can be asked to outlast the client's 30 s default — the two waits, `long_press`, `swipe`, `scroll` — raise their own request timeout from the call's own knob plus that default, with the verb's own default imported to size it and never put on the wire, so a long-but-normal call is never reported as a hang (`rover record`'s pattern). A completeness gate over `IPC_METHODS` keeps a verb row from landing later with no tool: every key is either a registered tool or on a short, named list of the byte-carrying rows phase 3 owns. **#104 added the nineteenth verb tool and settled the other two**: `install_app` ships in its byte-less form only — the declaration is `InstallAppParamsSchema.omit({ packageBase64: true })`, derived the way `acquire_device`'s variant is derived with `.partial()`, so the tool is the project-install form (D13) and there is no payload field to fill — with the request timeout raised to the host's own `INSTALL_HOOK_TIMEOUT_MS` plus the default, and the five-minute budget named in the description because it can outlast an MCP client's own tool-call deadline. `push_file` and `pull_file` stay off the surface and the gate's named list is now exactly those two: neither has a form that carries no bytes, so exposing either means settling how a client supplies and receives a whole file, which is R24 phase 2's mechanism and not one adapter's call. The same row moved the **entry**: `bin/rover-mcp.mjs`, because `--import tsx/esm` is resolved against the MCP client's working directory and so started nowhere but this checkout (§6, and §9.4 on why this is not the published `rover` command) | R12, R13, R15, R16 | L |
| R20 | `README.md` — quick start | **Done** (#20). The file has existed since the repo was created and describes the shape of the project; what it lacks is what could not be written before the code: how to start the daemon, take a device and wire up the MCP server, with commands that work. Separately: how to expose the host on the network and how to connect to it remotely | R10, R19, R24 | S |
| R30 | Device OS version in the inventory, without a lease | **Done** (#108). `DeviceSchema` carries **two** fields — the version string and the API level beside it, the same pair and the same names `DeviceInfoSchema` already used — and `list_devices` returns both for free devices too, read by the backend at enumeration and memoized per serial for as long as that serial stays attached (D6: re-derived at every enumeration, and never read on a verb's path). **Not** through `device_info`, which needs a lease and so can never answer for a free device. Nullable, and a null is a real answer: an `unauthorized` device is listed without a version — it is not even asked, since its state came from the device list already parsed — rather than dropped, and never fails the whole listing. Platform and version stay two fields. No platform branch outside the backend (D10). The recipe is **run** against a real device and lands in §6 with its API level, plus two fixtures | R5, R7 | S |
| R29 | `list_devices` carries when a lease was granted | **Done** (#107). `LeaseHolderSchema` gains the grant instant alongside `expiresInMs`. A client can render `GRANTED` without inference: the two are independent, because activity renews the expiry (D8) and never moves the grant. **No `leaseId` joins the listing** — D20's reason for its absence is unchanged. A unit test covers a renewed lease: expiry moves, grant time does not. What landed: `grantedAt`, an ISO-8601 UTC string (`z.string().datetime()`) rather than epoch milliseconds — the encoding `UserRecordSchema.createdAt` already uses, and the one that cannot be mistaken for the durations beside it. **What it gives up is clock-skew independence, not JSON**: it is the host's clock, so a client renders it and never differences it against its own, and anything relative still comes from `expiresInMs`. `GrantedLeaseSchema` deliberately did **not** gain it — the winner of an acquire already knows when it was granted. `src/daemon/lease-holder.ts` is still the single disclosure path, so D20 is unchanged | R8 | XS |
| R31 | Force-release: end a lease you did not take | **Done** (#109). A method keyed on the **serial**, carrying no credential of the holder's, running the full release path so restoration happens exactly as it does on expiry (D9). **No `leaseId` is exposed anywhere to achieve it** (D20). Already-free and vanished-since are distinguishable named results, because they mean different things to an operator. On the CLI too, so it is debuggable without a browser (D4). The authorisation model is D27's: any named user, until a role model exists. What landed: `force_release_device` on the one IPC surface, taking `{ serial, actor }` and answering `released` with the public `LeaseHolderSchema` projection — so the answer names who was holding it and, like every other disclosure, never the id (`src/daemon/lease-holder.ts` is still the single path). Three refusal reasons rather than two, because the inventory's existing mapping gives `not-attached` for free and it is honest (D18): `not-held`, `gone`, `not-attached`. `rover force-release <serial> --actor <string>`, with `--actor` required and never derived. The authorisation model is written down as **D28**, which is a genuine extension of D20 rather than an application of it, and it leaves `docs/WEB_PANEL.md`'s tiering question open. Two choices could have gone the other way. **A separate method rather than a parameter on `release_device`**: the concern behind the alternative — one release code path — holds anyway, because both handlers end a lease through the single `LeaseStore.release` where D9 is wired, while a params union of "either a lease id or a serial" would weaken the one sentence `ReleaseDeviceParamsSchema` exists to state. **The lease is looked up before the device**: a device that vanished mid-lease is *the* stuck lease an operator most needs to clear, so asking the inventory first and refusing `gone` would have pinned that lease for the full TTL with nothing able to end it — `gone` is therefore only reachable for a device nobody holds. Deliberately **not** an MCP tool: an agent ending a peer's lease is the opposite of what that surface is for, and the completeness gate records it as a decision rather than an omission | R8, R9, R28 | M |
| R32 | HTTP surface: a third transport a browser can reach | A browser cannot speak the framed NDJSON greeting the network listener consumes before dispatch, so the panel has no entry point at all. This binds the **same `IpcServer`** the unix socket and TCP listener already serve — a third transport, not a second implementation, the rule `network-listen.ts` records and `transport-independence.test.ts` guards. No second method table, and no method reachable over HTTP that is not on the one surface. Authenticates against the **same user store**, re-read per request and never cached, so `rover users revoke` bites on the next request (D25). One byte-identical refusal for every pre-auth failure. The token never reaches a URL, a log or a report (D20). **Off unless configured**, matching `ROVER_LISTEN_PORT`'s own switch. **Done** (#110): `src/daemon/http-listen.ts` serves one route, `POST /rpc`, carrying the existing request and response envelopes to the very `IpcServer` the other two transports serve — over an in-memory duplex, so `src/ipc/` is untouched and the independence gate now forbids `node:http` and `node:https` there too. The gate is `Authorization: Bearer <token>` against the user store, read per **request** rather than per connection, which is stronger than R28's guarantee and is pinned by a test that revokes between two requests on one keep-alive connection. Exactly two statuses — `401`, the byte-identical refusal `UNAUTHENTICATED_REFUSAL` gives both gates, and `200`, meaning read the envelope. A method allowlist (`list_devices` and, since R35's second half, `force_release_device`) keeps `acquire_device` and every verb off this surface without a second table. **The panel polls** — no push, no second connection style (D29). `ROVER_HTTP_PORT` is its own switch, loopback by default, TLS required off loopback, and blanked in an autostarted child | R28 | L |
| R33 | Panel scaffold: tooling, design tokens, the app shell | **Done** (#111). `panel/` is a Vite + React + Tailwind v4 + TanStack Router application in **one npm package with the rest of the repository**, not a nested one like Swarm's `dashboard/`: a second `package.json` would need a second install step and a second lockfile the CI cache key does not cover, and R26's workflow is `npm ci` + `npm run verify` unchanged because of it. The Analog Horizon tokens live in `panel/src/tokens.css`, harvested from `get_project`'s `designMd` and captured verbatim as a fixture — **not** from the emitted screen's Tailwind config, whose `borderRadius` block is shifted one step and whose `full` cannot be a pill (`docs/DESIGN.md` §11). That file is the only place in the panel a colour is written, and three source-scan gates in `tests/unit/panel/` hold the line: the tokens reached the file and no literal exists elsewhere, no `@keyframes`/`animation`/`animate-*` anywhere, and no `PASS`/`SUCCESS`/`Analytics` vocabulary. The shell is one flex row with `min-h-screen` and no `fixed`/`sticky`/`ml-*` anywhere, which is `docs/DESIGN.md` §3's one height and §4's one positioning model in a single declaration. `Archive`, `System`, `Profile` and any unknown address reach a calm placeholder rather than a 404 — with different closing lines, because a screen that is not built yet will be and an unknown address will not. The host's HTTP surface landed with R32, but it serves `POST /rpc` and no static assets: serving the panel's own files from that listener is owned by no row here yet, so the panel runs from `panel:dev` until one takes it | R20 | M |
| R34 | Panel login: present a host credential, hold a session | **Done** (#112 the host half, #119 the browser's). Resolves what `docs/WEB_PANEL.md` left open — whether the panel's login is R27's credential or a layer on it. `rover users revoke` must end an existing session on the next request, not at the next login. Uniform refusal, no self-service account creation, and the token never reaches a URL or a log (D20, D25). The screen is `Sign In — Rover OS` (`5035330b2c12401080263625ff564369`) in the Stitch project `Rover`, and only its default state was ever designed — the other four are settled in `docs/DESIGN.md` §8 instead, which is where §10 says states like these belong. **The host half is done** (#112): `POST /session` exchanges a token for an opaque session id, `GET /session` is the boot probe and `DELETE /session` ends it server-side, with the gate taking a session id or a raw token in the same `Authorization: Bearer` header. Sessions live in `src/daemon/panel-session.ts` — in memory, keyed by the SHA-256 of the id, each bound to a user's `identifier` and `tokenHash`, so a resolve re-reads the store and a `rover users revoke` or `rotate` ends a live browser session on its very next request, over a keep-alive connection the browser is already holding. Sliding 8-hour idle window swept lazily; no cookie, no CORS, no CSRF surface; the sign-in body is the one pre-auth body the surface reads, capped at 4 KiB, and every failure is the one byte-identical `401` (D30). **And the browser's half is done too** (#119): the sign-in screen is **not a route** — `panel/src/app.tsx` renders it in place of the router while there is no live session, so there is no address a credential could be attached to and no redirect target to record — with one masked monospace token input, a reveal, no host field, no account creation and no spinner. `panel/src/session/` holds the client (relative URLs only, `Authorization: Bearer`, a `401` as a typed refusal, never a credential in a URL and nothing logged), the store (`localStorage`, one key, the **session id only** and never the token) and the state machine `checking | signed-out | signed-in | refused | access-ended`, whose `onRefusal()` is the one path to *access ended* so R35's requests inherit the bounce. `Profile` shows who you are signed in as and carries the one **Sign out** control, which sends `DELETE /session` **before** the browser forgets the id. `docs/DESIGN.md` §8 now settles all four undesigned states and the edges between them, under one rule — the panel never discards a session id without the host's answer, and never reports an ending it did not get: a stored id the host refuses on boot is *access ended* and is cleared, a boot probe that reaches nothing is a cold arrival and the id is **kept**, a sign-out the host never answered stays signed in on `Profile` and says so, and a sign-in that replaces a kept id ends that id best-effort so no orphan session is left behind on the host. In development `panel/vite.config.ts` proxies `/rpc` and `/session` to `ROVER_HTTP_PORT` — the panel is same-origin in production and the host emits no CORS header for a cross-origin dev server to use | R32, R33 | M |
| R35 | The Devices screen | The panel's default view, against real host data: every device, free or held, with owner, project, test name, grant time and a countdown that **goes back up** when activity renews the lease (D8). Force-release with a confirmation. **Three distinct empty-ish states**, none of which may render as another: nothing attached (normal — D21), `stale: true` meaning *no view* rather than no devices (D6), and the host unreachable. No pass/fail badge, no status colour, no success rate, no acquire action (D22, D27). Serials never truncated. **The grant time is no longer a UTC timestamp** (#223): every instant the panel draws reads `2026-08-31 16:02` — the reader's own zone, to the minute, one format decided in one module — which reverses half of what this row landed with, in place and with its reason rewritten in `docs/DESIGN.md` §6 and §9. The half that stands is the load-bearing one: nothing differences a host instant against the browser's clock, and anything relative still comes from `expiresInMs` (D17, R29). The CLI is untouched and keeps printing the host's exact instant, because its output gets piped and pasted into a log. **Done** (#113, #122): the grid and every one of its states are built and read live host data by polling `list_devices` — the four states of the screen (devices; nothing attached; a stale view over a list; a stale view over an *empty* list, which `docs/DESIGN.md` §7 now settles) plus the host being unreachable, which replaces the whole page rather than dimming the shell. The countdown was watched going **back up** against a running host after a verb renewed the lease. A device is **not** simply free or held: one the host reports as `unauthorized` or `offline` holds no lease and would still be refused `not-ready`, so the card says what the host reports instead of `free` and the counter carries it as a third term (#123 review) — the CLI's `STATE` column had been saying so all along, and two clients of one method may not disagree about one device. **Force-release landed second** (#122) and made this the first screen that changes anything: `force_release_device` joined `PANEL_METHODS` in `src/daemon/http-listen.ts`, one **recessive** control sits on each held card below the lease data it acts on, and the settled Stitch confirmation asks first — with **Cancel filled and Force Release recessive** and the header `secondary-container` rather than red, recorded in `docs/DESIGN.md` §7 so neither is "fixed" later. The `actor` is the signed-in user's `identifier`, because D28 forbids *the host* deriving attribution and a client saying who it is, is the opposite of that. Three outcomes that must not collapse into one — the card going free without a reload, a lease that had already ended on its own, and a device no longer on this host — plus a fourth case the issue did not name: the request that reached nothing, which released nothing, keeps the dialog open and says so (§8's rule that the panel never reports an ending it did not get). All three settled ones are said **above the grid** rather than on the card, because the control lives inside the lease panel and the answer unmounts it; they stay until dismissed, since a line the next poll clears is a line nobody read. **The live half was not actually live until #125**: the poll's in-flight guard held an unbounded request, so one answer the host never gave froze the grid for the life of the tab while the countdown went on ticking — and the listener's idle window was Node's 5 000 ms default, the same number as `POLL_MS`, which is what supplied the missing answer. Each interval's request now carries the interval as its deadline and the listener holds an idle connection for 65 s. Still polling, still request/response, still no push (D29) | R29, R30, R31, R32, R33, R34 | L |
| R36 | The host lists the artifact archive, one directory level at a time | **Done** (#130). The archive (§10) had no reader on any transport, so the approved Archive designs could not be built at all. `list_archive` answers **one level** of the tree: it takes `{ path }` — the components a previous answer returned, `[]` being the root — and answers that level's entries, each carrying only what one `readdir` plus a `stat` or one `readdir` of a child can honestly say (a directory's own `childCount`, and `onlyChild` when it holds exactly one; a file's `sizeBytes`; a symlink or socket named as `other` rather than dropped). **It is still a listing rather than a query, and every one of those refusals stands**: no filter, search, sort parameter, recursion or aggregate across levels, on this row, ever. **Revised 2026-09-01:** the reason has been re-aimed rather than deleted. It was that D24 held listing a directory to *be* the query; that half of D24 is now overruled and the archive is searchable — but by **R38's separate `search_archive` method**, not by a parameter here, because the surviving half of the reasoning is the sharper one: a parameter that turned this into a query is how an index gets built by accident. `list_archive`'s params, result, ordering, handler and CLI command are unchanged by R38, which is what "a new capability is a new method" means in the diff. The order is fixed and unconditional — ascending by name in code-unit order, not `localeCompare` — which is what makes D24's "the two most recent runs under one `test_name` are the last two in the listing" true through this method. **Empty, missing and unreadable are three distinguishable answers**, as a discriminated union on `outcome`, because the pair that must never render alike is *the archive is empty* versus *the host cannot say what is in the archive* — the same distinction `stale` draws on the Devices screen (D6, `docs/DESIGN.md` §7); one level down, the same rule makes an unreadable child's `childCount` `null` rather than `0`. **No host path is on any result and there is no field one would fit in** (D19) — not even a `message`, which is why a level the host cannot read is warned about on the host, naming the path and the errno, exactly as `ArtifactArchive.record` warns. **Containment is two rules, not one.** `ArchivePathSegmentSchema` refuses `.`, `..`, a separator and a NUL, which is all `join(root, ...path)` needs to stay under the root *as a string*; and the handler resolves the directory and compares it against the resolved root before it reads anything, because a symlink inside the root escapes it without any of those characters and `readdir` follows the one in its own argument. A link that points back inside the root stays reachable — this is containment, not a ban on links — and a link out of it is `unreadable`, with the target named in the host's log and nowhere else. The warning stringifies every path it names (`JSON.stringify`, as D28's force-release audit line does): a component may legally carry a newline or an ESC, and a record another line can be forged into is not a record. A backslash is deliberately *not* refused — it is an ordinary filename character here, and refusing it would make a name the host itself answered with un-addressable on the next request. Every component stays opaque and nothing parses one (D22): decomposing `<timestamp>-<owner>-<hash>` is the panel's job when the panel is built. On `PANEL_METHODS` (D29) and on the CLI as `rover archive [<component> ...]`, so the archive is debuggable without a browser (D4). Deliberately **not** an MCP tool, recorded in the completeness gate as a decision: an agent already receives its own artifacts as bytes, and advertising this would hand every agent a listing of every other agent's runs on the host. Known and accepted: **no pagination** — a `test_name` with months of runs is one large answer, `limit`/`offset` is precisely the parameter the refusal above forbids, and the real fix is retention (§9.4, undecided) | R25, R32 | S |
| R37 | The host serves one archived artifact's bytes to a browser | **Done** (#131). R36 answered *what is filed* and had no way to answer *what is in it*, so the approved Archive preview — a screenshot shown, a recording played, a log printed, and one control, **Open in a new window** — had no address to fetch. `GET /artifact/<component>/…` serves **one file per request**, addressed by exactly the components `list_archive` answered with (`ArchivePathSegmentSchema` is imported, never copied), so the archive has **one path vocabulary** and no caller ever composes a host path (D19). **A route and not a method**, which is D29 amended in place rather than a new decision: an artifact is *bytes*, a recording base64'd into an envelope would be inflated by a third and buffered whole on both sides in a layer capped at 8 MiB, and a browser cannot point an `<img>` or a `<video>` at a method call. `PANEL_METHODS` is untouched. **Authenticated exactly as the rest of the surface is** — the session id or a raw token in `Authorization: Bearer`, resolved against the user store on *every* request, so `rover users revoke` ends access to archived artifacts on the next request over a keep-alive connection the revoked user is already holding (D25, D30), which is pinned in `http-listener.test.ts` beside the same assertion for `/rpc`. **Containment is enforced again on the read side rather than assumed**: the schema bounds the path as a string, and the reader `realpath`s the request and the root and refuses anything that resolves outside — a symlink escapes without a single refused character. A link pointing back *inside* the root stays served, and one pointing out is `unreadable`, with both paths named in the host's log and nowhere else. **`content-type` comes from the extension** — `.png`, `.mp4`, `.txt`, `.json`, which is §10's tree exactly, plus the writer's `.bin` fallback — taken from the **addressed** name rather than the resolved one, so the type is a function of the address a listing answered with. An unrecognised extension is served as `application/octet-stream` rather than refused, because refusing would make a file the listing honestly answered with un-fetchable — the trap the backslash rule records from the other side — and `x-content-type-options: nosniff` on **every** response is what keeps that safe, a browser sniffing an octet-stream into HTML being script in the panel's own origin. A CSP was considered and dropped: `sandbox` governs a document and does nothing for an `<img>` or `<video>` subresource. **Missing and unreadable are distinguishable and neither is a `200` with empty bytes** — `404` and `500`, in `list_archive`'s own words, plus `400` for an address no listing could have answered; a directory, a FIFO or a socket addressed as a file is `unreadable`, and no body carries a path or an errno (D19). Every one of those statuses is **post-auth**: the pre-auth uniform refusal is untouched, so nothing a stranger can reach varies with the reason. **One `bytes=` range is answered with `206`**, which the issue left open and which is included for a reason that was written as an acceptance criterion: Safari issues `Range: bytes=0-1` before it will play a `<video>` at all and a server answering `200` gets no playback, and seeking a long recording is the second reason. **That reasoning was written for a client that turned out not to exist, and #133 proved it** (§6): the panel cannot point a `<video>` at this route at all, because a subresource fetch carries no `Authorization` header — it fetches the bytes with the session header and plays a **blob URL**, and a blob URL answers ranges in the browser. So the `206` and its reasoning stay, with the client corrected: the range serves a bare `curl` and anything else fetching the address directly, which is a different set of clients from the browser it was assumed to serve, and no `<video>` in the panel depends on it. Everything else — a multi-range header, a malformed one, an unsatisfiable one, a unit that is not `bytes` — is **ignored and the whole file served**, which RFC 9110 permits and which removes `416` and every partial-content edge case. **`/artifact` and not `/archive`**, singular: the panel owns the client route `/archive`, it will be same-origin once this listener serves `panel/dist`, and a host route there would shadow the screen that browses the archive. Known and accepted, stated rather than buried: **the address is not openable in a bare tab** — a top-level navigation sends no `Authorization` header and a credential in a URL is what D20 forbids, so **Open in a new window** fetches the URL with the session header and opens the object URL; and there is no `HEAD`, no conditional request (`ETag`/`If-Modified-Since`), no multi-range and no compression. **No download affordance anywhere**, recorded in `docs/DESIGN.md` §10 as a choice rather than a limitation: this is a view, not a transfer. Retention (§9.4) is now overdue — this is the row that puts a browser on the archive | R32, R36 | S |
| R38 | The host searches the artifact archive, and the panel's tree card is what asks | **Done** (#144, the host's method; #146, the `DIRECTORY` card's field and the searched tree). R36 answered *what is filed* one level at a time and R37 *what is in one file*, and neither could answer **where in the archive does this text appear** — which on an archive of months of runs is the question an operator actually has, and which no amount of walking answers cheaply. `search_archive` takes `{ text }` and **nothing else** and answers matching entries of the **whole** archive as component arrays — `ArchivePathSegmentSchema` imported, never copied, so the archive keeps **one path vocabulary** across all three of its reads and every match is an address `list_archive` and `/artifact` already accept. Each match carries `path` and `kind` (`list_archive`'s own three words) and nothing else: no `childCount`, no `onlyChild`, no `sizeBytes` — a search answers *where*, and *what is in it* is a listing's question. **No host path is on any result and there is no field one would fit in** (D19), not even a `message`, which is why an unreadable level is warned about on the host exactly as `list_archive` warns. **This reverses half of D24 at the operator's instruction, and the half it does not reverse is the load-bearing one**: there is no index, no database, no catalogue kept in sync with the files and no cache of a previous walk — the answer is a walk of the filesystem at request time. So the walk is **bounded three ways**: depth is `MAX_ARCHIVE_PATH_DEPTH` (8, imported, so every match is addressable), matches are capped at `MAX_ARCHIVE_SEARCH_MATCHES` (200) *in the schema* so the bound is structural, and directories read are capped at `MAX_ARCHIVE_SEARCH_DIRECTORIES` (5 000) *in the handler*, that being the only bound that caps disk work when nothing matches. **`truncated` means exactly one thing** — at least one directory that exists was not fully examined, so matches may be missing — and every bound, plus a level the host could not read mid-walk, sets it; the sentence is the same sentence in the schema and in the module. The two bounds reachable mid-walk differ on purpose: the match cap ends the walk, because no further match could be carried, while the directory bound only stops it **descending**, since the names already read cost no more disk and dropping them would answer nothing at all for the one archive big enough to reach it. **The walk is breadth-first, and that is load-bearing**: shallow components are what an operator searches for and machine-named files sit deepest, so the match cap truncates the deepest, least specific hits first — depth-first would let one run of five hundred screenshots fill the answer before the second project was reached. Within a level the order is `list_archive`'s own: ascending by name in code-unit order, unconditionally. **A component is matched whole, verbatim and case-insensitively** — the needle is a substring of the entire name, nothing splits it on a hyphen or reads a timestamp, owner or hash out of it (D22), and the fold is `toLowerCase` and never `toLocaleLowerCase` so two hosts answer alike; that rule is written into the params schema's own docblock, which is where a caller reads it. **Containment comes free and the reason is recorded so a refactor cannot lose it**: there is no caller-supplied path to escape with, and the walk descends only into a dirent whose `isDirectory()` is true — which is `false` for a symlink under `withFileTypes`, so no link is followed and a matching one is answered as `other` by name. `list_archive`'s `realpath` comparison has no counterpart to earn here. Three outcomes, `list_archive`'s own — `searched` / `missing` / `unreadable` — and `matches: []` with `truncated: false` is *nothing matched*, not a failure. On `PANEL_METHODS` (D29) and deliberately **not** an MCP tool, recorded in the completeness gate as a decision: an agent already receives its own artifacts as bytes (D19), and where `list_archive` at least made an agent walk to another agent's runs a level at a time, one call here hands over every one of them. Deliberately **not** built: no index or cache of any kind, no `rover archive --search`, no pagination, no caller-settable bound, no start path, no kind filter, no sort — every one of those is the parameter D24 refused, and the bounds here are the host's. `list_archive` is untouched. **The panel half is #146 and is Done**: the `DIRECTORY` card carries the design's own field between the header strip and the tree, and typing in it draws every match in the tree in place — each hit visible, ancestors expanded, branches with no match not drawn, and no `DEEPEST_EXPANDABLE_DEPTH`, because the searched tree draws exactly the addresses the host answered — which was how a hit *below* a run became reachable at all while a run was a leaf in the URL's tree. **That clause is amended in place (#159)**: the browsing tree now reaches every address too, so neither tree has a depth bound and the searched one is no longer the only way down there. Nothing host-side changes and R38 itself is not reversed — this method still answers a search of the whole archive out of one walk. **The whole matched tree comes from the one answer** (`panel/src/archive/search-tree.ts`), never from per-level `list_archive` calls — the walk this method exists to replace is not paid for again in the browser. A hit row is the browsing row: same `<Link>`, same classes, no count, no status glyph, no outcome colour. **The text is component state and is deliberately not in the address**, which amends `docs/DESIGN.md` §9's *the whole of the screen's state is the address* rule in place: where you are is still the URL, and a reload or a shared link lands there without somebody else's search. Debounced at 300 ms with one request in flight and superseded answers dropped, so the panel never asks per keystroke; no polling, because the archive is finished data. **Three states that share no phrase** with each other or with *Nothing in the archive* / `ARCHIVE NOT READABLE`, in flight being one quiet line and no spinner, and a truncated answer saying so *above* the hits — **whether or not anything matched** (#149 review): the host sets `truncated` without recording a match whenever a bound or an unreadable subtree stops a descent, so *nothing matched* has two sentences, one for a whole archive examined and one for a part of it, and the definitive negative is never said about a search that was cut short. That answer is on the wire in the panel's fixture, captured rather than written. The field is absent in every state that draws no tree, by construction: it is part of the tree card. The one deviation from the approved markup is the placeholder — *Search the whole archive...* rather than the design's *Filter this tree...*, which describes a client-side filter this is not — recorded in §9 with its reason, along with the correction that the input is in `8dcd4330…` as well as `b91c300d…`. **The panel half now serves both arrangements** (#207, amending in place the clause that made the field the `All` view's alone): the reason it was withheld from the groups view was about *addresses* — `search_archive` answers the archive's own, which that arrangement does not own — and an address composes, `archiveAddressOf` dropping the group id and `groupsAddressOf` putting it back, so a match under a grouped run has an address there after all. **Nothing host-side changes and R38 itself is not reversed**: the second population is composed **panel-side** out of the `list_archive_groups` answer the groups view already holds (`panel/src/archive/group-search.ts`), so there is no `groupsOnly` key on this method — a caller-settable bound is precisely the parameter D24 refused — no second search method, no new wire shape and no index. The population is the runs that carry a group id and everything under them; a run that named no group is not a hit and a match shallower than a run is not addressable there at all. `truncated` keeps its one meaning and is **OR-ed across the two bounded walks** the answer is assembled from, so the definitive negative is never said about either being short, and the sentences that claim a population narrow with it rather than a fourth state being invented. The stated cost, recorded rather than hidden: the 200-match cap is spent on the whole archive, so a host with many ungrouped runs reaches `truncated` sooner in that view — a host-side method answering one bounded walk with the group already in the address is the recorded alternative and is deliberately not built | R36 | S |
| R39 | The host lists the registered projects, read-only | **Done** (#152). A project registration is host-operator configuration in `<root>/<project>.json` under `ROVER_PROJECTS_PATH` (D13) and **nothing on any transport could see it**: the only way to find out what this host does around a lease was `ls ~/.rover/projects` and opening the files — so the panel's fourth destination had nothing to read, and a hook file that will not parse stayed invisible until a project quietly stopped being torn down. `list_projects` takes **nothing** — `z.object({}).strict()`, no path in and none out — and answers every registration under the root: the identifier, `apps`, whether there is an `install`, the helper services **by name in declaration order**, and whether there is a `teardown`. **Two failure axes, and both are distinguishable rather than flattened.** The root's own is `list_archive`'s three words — `listed` / `missing` / `unreadable` — because a host where nobody has ever registered a project is the ordinary state and must not render like a root the host cannot read (D6). The per-entry axis is a second discriminated union, `registered` / `unreadable`, and it exists so that **a file that will not parse cannot be mistaken for a project declaring nothing**: `apps: []`, `services: []`, no `install`, no `teardown` is the common, correct case, and the two must not render alike. Which of the four ways a file failed — not JSON, schema mismatch, a `project` field disagreeing with its own filename, unreadable — is deliberately **not** on the wire: that diagnosis names a path, so it goes in a warning on the host (D19), and a reason enum is easy to add later against a designed screen and impossible to remove from a wire schema. **No `env` value and no host path is on any answer, structurally**: `install` and `teardown` are booleans and a service is a name, so there is no field a program, an `args` entry, a `cwd` or an `env` value could arrive in — the way `ListArchiveResultSchema` has no `message` (D19) — and `src/ipc/server.ts` parses every result against that `.strict()` schema. **The reader is `readProjectHooks` itself, reused rather than reimplemented**, so what the screen reports and what the host will actually run at lease end cannot diverge, the filename-agreement check comes for free, and D6 comes with it: nothing is cached, so an operator who fixes a hook file sees it fixed on the next request rather than on the next daemon restart. A `*.json` whose stem is not an identifier is warned about and left out — nothing will ever look it up — and anything that is not a `*.json` is skipped in silence. One fixed order, ascending in **code-unit** order and never `localeCompare`, for the reason `list_archive` refuses it: a locale-dependent order makes one host answer differently from another. On `PANEL_METHODS` (D29) and deliberately **not** an MCP tool — the asymmetry `list_archive`, `search_archive` and `force_release_device` already have, in a different key: what the host operator configured this machine to run is not something every agent on it needs to enumerate. Deliberately **not** built: every write (D31 — no method creates, edits, renames or deletes a hook file, and none takes a path into that directory), a per-entry reason enum, a cache or index of any kind, a `rover projects` CLI command (`search_archive` set that precedent), and the *Projects* screen itself, which is not designed yet | R32 | S |
| R40 | `rover init` registers a project against the host, and asks for what it cannot infer | `init` writes the hook file itself (`src/cli/commands/init.ts`), which is right only when it runs on the machine holding the devices; pointed at a remote host it registers the project on the wrong machine and says nothing. It should **ask the host**, prefilling everything it can already detect — the identifier from the directory, `apps` and `install` from the project's own files (`src/cli/init/detect.ts`) — and **prompting for the fields that need a person** rather than guessing one, which is the rule `detect.ts` already follows. **Blocked on a decision rather than on code**: this is a write into the projects directory over the wire, which D13 forbids and which D31 narrowed **for the read only**. Settle it in §3 first — create-only, never overwriting, is the rule `init` already keeps on disk and is the narrowest form the write can take — then file this. | R39, and a decision | M |
| R41 | Group connected runs, and connected artifacts across them | **Done** (#150). Two optional, opaque attribution strings at two levels (D22, as amended): a **`group_id` on a lease**, so several leases are one investigation, and a **`label` on an artifact-producing call** — `screenshot`, `record_video`, `read_logs`, exactly the three the archive files — so artifacts across those leases are the same thing at two moments. The outcome to check: *after every lease in a group has ended, a reader can still recover which runs share a group and which artifacts share a label.* Both reach the archive without the tree branching on either — `group_id` is filed as `group_id.json` on `device_info.json`'s terms and a `label` goes into the artifact’s **file name** beside the sequence number, so `leaseArchiveDirectory` stays always four levels (§10, #129). A `<group_id>/` level was the option considered and not taken. **A `label` on a lease with no `group_id` is refused by name** (`label-without-group`) rather than accepted with the label dropped, which is the one behaviour here that is not merely additive; it is a verb refusal like any other, so it renders as a sentence and as a `--json` document in both clients. Nothing enforces arity, uniqueness or membership — one lease may be its group’s only member and a group may have seven. Read off the call in `src/daemon/verb-handlers.ts` and handed to the archive, so **no verb signature, verb option or result schema changed**, exactly as R25 needed none; no archive path reaches a client either (D19). `rover acquire --group-id`, `--label` on `rover screenshot` and `rover record`, and the MCP declarations come from the same schemas. The criterion the row turns on is the last one: `rover init`’s generated `ai/ROVER.md` carries the before/after pattern as a **worked example** — two `acquire_device` calls sharing a `groupId`, each with a `testName` of its own ending in a distinct `_variant` letter (#177), a `screenshot` in each sharing a `label` — and the agent-file snippet carries the trigger, because an agent that never learns the fields exist does the comparison anyway and files four unrelated artifacts. **#205 corrected what those two calls carry**: the host now mints the `group_id` it files and answers with it (D22, as amended), so the second call sends the id the first grant came back with rather than the same literal name — an example showing one literal twice would now teach a group of one plus a second group nobody asked for, which is the same criterion failing in a new way. The comparison card reads the id's name half, not its minted suffix (`panel/src/archive/variant-name.ts`). Surfacing either in the web panel is its own row against the approved Stitch screens, **begun by #165** — which puts an `All` / `Testing groups` toggle on the Archive screen, with the second view an explicit placeholder until #181 filled it in — **its host half has now landed as `list_archive_groups` (#178)**: one method on `PANEL_METHODS` and on all three transports, taking no parameter and answering, from one bounded walk, which groups exist as a `(project, groupId)` pair, which runs are in each as the components `list_archive` would name them, and which of a grouped run’s artifacts carry a label together with **the label as the archive filed it** — `pathSegment` is not reversible, so the caller’s own string is unrecoverable and is never presented as one, which is the rule `docs/DESIGN.md` §9 already states for `OWNER`. It is decoded by `filedLabelOf`, the inverse of the `labelled` that wrote the name, both in `archive-path.ts` so one module owns that layout in both directions and a writer/reader round-trip test pins it. **Nothing about what the archive writes changed to serve it**: no sidecar file, no `<group_id>/` level, `leaseArchiveDirectory` still always four levels, so every run already on disk is readable by it. Bounded like `search_archive` and for its reason — no index, no catalogue, no cache, so the answer is a walk at request time capped by directories read, by three structural caps and by a fourth cap on the whole answer (the three structural ones bound one level each and not their product, and an over-large frame arrives at its caller as *malformed* rather than as large), with one `truncated` flag meaning *at least one directory that exists was not fully examined* — and answering `list_archive`’s own three outcomes, so *no groups here* and *the host cannot read the archive* never render alike (D6). **The panel arrangement is now built** (#181): the `Testing groups` segment stops being a placeholder and draws a second arrangement of the same archive — project, then the `groupId`, then the standard arrangement unchanged (test name, run, and the run’s contents to any depth) — out of one `list_archive_groups` answer, in the same tree component with the same row anatomy and the same card beside it, and on addresses of its own (`/groups`, `/groups/$`), which settles the question #165 deliberately left open by making the view a place a reload and a shared link land on. A run that named no group is not drawn and neither is a project with none, because this view answers *what groups exist* and the `All` view still lists every run. **#181 left the tree card's search field out of that view, and #207 puts it in** (amended in place — the row records the reversal rather than the omission being deleted): the arrangement is now searchable over its **own** runs, on the same field in the same place with the same debounce and the same four states, restricted and re-addressed panel-side out of this method's own answer (`group-search.ts`) with no host change, D24 untouched, and `truncated` OR-ed across the two bounded walks so a short answer narrows the claim instead of the panel saying nothing is filed under a group. R38 carries the whole account and `docs/DESIGN.md` §9 the reversed reasoning. **And the label badges are built, which completes the three phases** (#182, amended in place by #197 and #206): inside a group every distinct filed label takes a **number** — the next integer from `1`, in the order the host answered them — drawn as a small `#`-prefixed pill beside the artifact’s name, with the same label carrying the same number everywhere in that group and nothing about a number stable across groups. **There is no ceiling and no overflow value** (#206): an integer has no last value, so no label a group can file is left undistinguished. **The number carries the meaning, never the colour alone**, and the filed label travels with every badge as an accessible name and a `title`, because a number is a code local to one group; an artifact with no label carries no badge, so an archive that never used labels draws the tree it always did. **A badge is not the file’s own ordinal** — archived artifacts already lead with a zero-padded one in their names, so the badge leads with `#`, is never zero-padded, and is a filled pill rather than text in the row’s name; and **no number reads as a rank**, because nothing about a badge is sorted, scored or compared (`ai/RULES.md` §1). The palette is five tokens of `panel/src/tokens.css` and no hex (`tests/unit/panel/tokens-are-the-source-of-truth.test.ts` is the gate), chosen so that **no badge colour can read as an outcome**: `error` is excluded outright and the three steps `docs/DESIGN.md` §5 gives a device state to are spent, so no two badges can pair into a red/green verdict. **#182 concluded that four letters is what Analog Horizon can honestly carry** — three accent families, three spent steps, no honest fifth hue — making `@` a first-class case and a longer alphabet a commissioned categorical ramp (§8) rather than a swatch picked at the keyboard. **#197 reversed the letter half of that in place**: the conclusion was about *colour* and was applied to *letters*, which nothing makes the same count — a letter is drawn in text and is the channel that carries the meaning, and R41 enforces no arity on labels either, so real use went straight past four and one group filing nine distinct labels had five of nine badges reading `@`. The letters then ran the whole alphabet on the **same four colours cycled family-first** (`A`/`E`/`I`/… primary, `B`/`F`/`J`/… secondary, and so on), so neighbouring letters were always different families by construction, the first cycle stayed byte-identical to what #182 shipped, and `@` moved to past the twenty-sixth with its meaning unchanged. **#206 then removed the ceiling itself, and `@` with it**: the ceiling existed only because an alphabet has a last letter, and twenty-six was a larger arbitrary number rather than a different kind of answer — nothing about the archive, the host’s answer or the palette ever asked for one. The badges are integers from `1`, so what is unbounded is the **glyph**; the palette keeps its own ceiling, and the number is what disambiguates past it. What did not move is the colour half: `error` excluded, §5’s three spent device-state steps unavailable, no red/green pair, every colour from `tokens.css` or derived from it with `tokens-are-the-source-of-truth.test.ts` the gate — and a **new hue** is still the operator’s commissioned ramp rather than a keyboard swatch. **#200 then modulated the cycles** so `E`…`Z` are the same four hues at a different step rather than a plain repeat of `A`…`D`: seven stops per family, each a `color-mix(in srgb, …)` between two tokens of that family in `panel/src/index.css` with the component writing only a family and a cycle, cycle 1 byte-identical to what #182 shipped because mixing at 100% is the identity, and the glyph’s own text step never flipping — which the numbers, not an assumption, settled. That closes the one weak adjacency #197 had to record (the cycle boundary `#4`/`#5`, ΔE 13.6 as a plain repeat and 19.7 now), and the criterion it could have broken is enforced rather than argued: `tests/unit/panel/label-badge-palette.test.ts` recomputes all twenty-eight fills from the tokens and fails on a digit below 4.5:1 on its fill, a badge below 3:1 against the card, any derived fill within ΔE 10 of the free-device green, the held blue, the warning orange, the not-ready grey or either half of `error`, and any pair of consecutive fills within ΔE 15. **Four families over seven steps is twenty-eight fills and no more**, which is why #206 wraps rather than inventing a twenty-ninth: past `#28` the colour repeats and the digits are the identity, the ceiling is the named `PALETTE_CYCLES` constant in `label-badge.tsx`, and because the fills are periodic in twenty-eight the gate walks `#1`…`#29` — every consecutive pair an unbounded numbering can produce, the wrap included. The `-fixed-dim` tokens looked like a free second cycle and are **rejected with their numbers** in §9: two of the three are byte-identical to a colour already spent (`tertiary-fixed-dim` is `--color-tertiary`, the free-device green; `primary-fixed-dim` is `--color-primary`) and the third, `#ffb59a`, is ΔE 9.3 from `--color-error`. §9 carries the badge vocabulary, the palette and the reasoning, both reversals included — the removal of `@`, whose justification was written twice, is recorded there rather than left to vanish from the record. What is still not Rover’s is comparing, diffing or scoring anything, which is the agent’s judgement (ai/RULES.md §1). The `_variant` suffix is a **caller convention and nothing else**: `test_name` stays opaque and deliberately not unique (D22), the host neither reads nor requires it, and what it buys is a nameable directory per run in §10’s tree, and it is what makes the arms of one comparison sibling rows under a group in the panel’s grouping view (#181) — spending the `ls`-shaped diff D24 records, since the arms of one comparison are now sibling `<test_name>` directories held together by the `group_id` filed with each run | R25 | M |
| R42 | The Projects screen | **Done** (#157). The panel's fourth destination, between `Archive` and `System`, against real host data: every registration the host answers, **one card per row** — the identifier, `apps`, whether there is an `install`, the services by name, whether there is a `teardown` — and a registration the host cannot read drawn as **that**, never as a project declaring nothing. **Read-only, and nothing on it writes**: no `Add`, no `Edit`, no `Delete`, and not a disabled one either (D31). The design is settled in `docs/DESIGN.md` §10, the four states with nothing to list included, and so is the card order — it is the host's own, so a registration that will not parse sorts among the others rather than being grouped last. **No polling and no refresh control**: a registration changes when a person runs `rover init` or edits a file on the host, and this screen makes no claim to see that happen. Checkable: against a projects root holding one good registration, one that declares nothing at all and one whose hook file will not parse, the screen draws three cards a reader can tell apart — and *nothing registered* and *root not readable* never render alike. **What the build settled**: the nav glyph is `Boxes` from `lucide-react` — deliberately not a tree glyph, because §10 settles that this screen has no hierarchy and a tree would collide with the `Archive`, which is one, and not a cog, which would promise the write D31 refuses. The badge **counts every registration the host answered, an unreadable one included** — the file is there, so it is a registration — and goes rather than reading `0`. Three deviations from the approved markup, recorded in `docs/DESIGN.md` §10: the scanline layers in the badge and every card header are dropped (§5, chrome only), the reference's `md:grid-cols-2` becomes a plain `grid-cols-2` because the two-across pairing *is* what the columns are (§4), and the header row is the existing `PageHeader` rather than a rebuilt one. Verified against a real host: three cards in the host's order with the broken one in the middle, then the root moved aside for *No projects registered* and `chmod 000` for `PROJECTS ROOT NOT READABLE`. | R39 | M |
| R43 | A recording held open while the agent drives the device | Three phases, split out of #184. `record_video` is one call that starts a recorder, waits for it and answers with the whole file, so the only recording an agent can ask for is a window fixed in advance — never *record while I do this*. **Phase 1 is done** (#184): `AndroidDeviceBackend.exclusivelyOn` excludes per **(device, scratch path)** pair rather than per device, so a `read_screen` no longer queues behind a recording on the same device. It reverses the *one queue covers both paths* reasoning **in place with its reason rewritten** rather than deleting it (ai/RULES.md §1) — that reasoning was right while every recording ended inside its own verb call, and what removes its premise is a recorder held open on purpose. §6 carries the measurement both ways: with the split key a screen read during a 6 s recording answered in 2386 ms and 4 s *before* the recording; with the shared key the same read took 8862 ms and answered *after* it. No verb, capability, backend method, `IPC_METHODS` row or MCP tool was added, `recordVideo`'s own lifecycle and every artifact bound are untouched, and `src/daemon/verb-traffic.ts` still registers concurrent calls on one device rather than excluding them, on purpose. **Phase 2 is done** (#190): `start_recording` and `stop_recording`, so an agent drives the device *inside* the recording rather than deciding its length in advance. `record_video` is untouched — this is a second way to record, not a replacement — and the two share everything downstream: `stop_recording` reuses `RecordVideoResultSchema` whole rather than declaring a second shape carrying the same four fields, files into the same `recordings` branch of the archive under the same per-lease sequence, and is the fourth call that takes a `label`. The ability is a **new declared capability**, `canControlRecording`, and deliberately not `canRecordVideo` widened: that flag names exactly one method, and a platform whose recorder is one command taking a duration answers it perfectly well while having no way to hold a recording open at all (D11). Both methods landed together because `CAPABILITY_METHODS` naming one a backend does not answer fails the conformance suite, the split point `canInput`'s four primitives already sit on. The Android half is §6's second measured recipe: `screenrecord` launched **detached** — the redirections are what detach it, not the `&`, since adb's shell service waits for EOF on the stream — with `--time-limit` still always passed, because it was the only thing bounding a recorder whose caller went away until phase 3 landed the teardown, and it stays as the bound for a host that died with the lease; then `pidof` becoming non-empty waited on as a condition, so *it started* is checked rather than assumed; then `kill -INT`, `pidof` becoming empty waited on again — the recorder went on being named for a quarter of a second after the interrupt returned, where `record_video`'s had always already exited — then the transfers' own `stat` to ask whether there is a file at all, then the same `exec-out cat`, the same `moov` check on the bytes that arrived and the same `rm -f` in a `finally`. The `stat` is load-bearing rather than defensive: `exec-out cat` of a missing path exits 0 with the shell's error text **on stdout** (§6), so *bytes came back* cannot decide whether anything recorded, and without it `no-recording-running` is unreachable. **`adb` is the truth and no recording is remembered on the host** (D6): a map of open recordings would be exactly the stale daemon state that decision exists to prevent, so both methods ask the device. A device already recording is refused **by name**, `recording-already-running` carrying the pids, which covers a second `start_recording` *and* a `record_video` during an open session — the latter was a `wait-timeout` ten seconds later before this, honest while somebody else's recorder was the only way to reach it and wrong once holding one open is the point. `no-recording-running` is the other new failure and is deliberately narrow: a recorder that reached its own limit before the stop left a complete file and is an `ok` answer with it, so the named failure is *nothing recorded at all*. The one thing this pair cannot say is how long the recording ran — nothing times the gap between two calls, `stat -c %W` on `/sdcard` answers `?`, and `ps -o ETIME=` is whole seconds — so `stop_recording` normalises with **no requested window** (`planNormalisation` now takes `number | null`) and the file keeps the recorder's own timeline, with the still-screen case named through `container` exactly as `record_video`'s is rather than held across a length nobody measured. **Phase 3 is done** (#191): the teardown, stopping a recorder that outlived its lease, which is the daemon's job on release *and* on expiry (D9) and never the caller's. `--time-limit` stays and is still the kill switch for a host that went away entirely, but it is no longer the only thing bounding a stray recorder: `src/daemon/restore.ts` gained one step, **ahead of the app steps** because a recorder is the driver most likely to still be holding the device and force-stopping an app underneath one is the two-drivers problem in miniature. It is contained and capability-gated exactly as the network steps are — a failure is a warning naming the step and the steps after it still run, and a backend that does not declare `canControlRecording` gets a warning naming the capability rather than an error or a skipped restoration. The backend method is `discardRecording` and is deliberately **not** `stopRecording` with the answer thrown away: it asks, signals, waits on the recorder being gone and removes the file, and it never pulls, checks or answers with bytes — a lease that ended has no caller to hand a recording to, dragging several megabytes off a device nobody is waiting on buys nothing, and `UnfinishedRecordingError` on the half-recording an abandoned lease usually leaves would turn the ordinary case into a failure. Archiving that half-recording is a second decision nobody has asked for, so the bytes are dropped and the warning says so. Force-release needs no branch: it runs the full release path already (R31), so `tests/unit/daemon/force-release.test.ts` asserts it inherits the step rather than adding a path for it. Checkable for phase 1, and checked: on a real device a screen read and a recording on one device overlap, and the recording still comes back finished. Checkable for phase 2, and checked: on a real device a start, several gestures and a `read_screen` under one lease, then a stop, come back as a finished recording declaring more than one sample and a non-zero duration and slicing into more than one frame. Checkable for phase 3, and checked: on a real device a recording started over a lease and never stopped leaves no `screenrecord` running and no `/sdcard/rover-recording.mp4` behind, on the release path and on the expiry path alike | R14 | M |
| R44 | iOS simulator parsers, screen metrics, log mapping and fixtures from a real simulator | `src/backends/ios-simulator/` with **no process spawning and no registration** — pure functions plus captures from a real simulator, so the layer that reads the platform's output is green before anything drives it. Four things: the device enumeration (`simctl list -j` parsed and joined onto `Device[]`), the screen metrics off a device type's `profile.plist`, the system-log mapping onto `LogEntry`, and the attachment classification. Filed as **one row covering all four**, per §9.2 rule 4 — whoever implements it splits it, and then it is clear where the seam runs. Checkable: the suites pass on a machine with no simulator and no Xcode at all, every fixture is a capture with the Xcode and runtime versions in its filename (there is no API level to record on this platform), the barrel registers nothing new and the conformance suite is untouched. **Phase 1 is done** (#213): the enumeration and the attachment constant. `osVersion` comes from the runtime *list* joined on `identifier` and never from the device map's key — measured on Xcode 26.4.1, 2026-09-08, the key ends `iOS-26-4` while the runtime reports `26.4.1`, so reading the key reports a version no installed runtime has — `osApiLevel` is always `null` because inventing one from a version string is inventing data, `Booted` is the only `ready`, and the vendor schemas are deliberately non-`.strict()` where `AdbDeviceSchema` is strict, because that shape's key set is ours and this one is Apple's. **Phase 2 is done** (#218): the screen metrics, a device type's `profile.plist` read and mapped onto the neutral screen shape. **Phase 3 is done** (#219): the unified log's NDJSON mapped onto `LogEntry`. That is all four things, and **this row is complete** — the developer-directory search filed as *parsers 4/4* (#220) is R45's locate-and-verify half and is recorded there | R2 | M |
| R45 | The iOS simulator backend on `simctl` alone | The second registered manifest, `platform: 'ios-simulator'` rather than `'ios'` (`docs/IOS.md` §10) — every required method plus `canRecordVideo` and `canControlRecording`, with `canReadScreen`, `canInput` and `canControlNetwork` declared **`false`** and therefore refused by name rather than degraded. Worth having even if idb is never adopted, because it needs no third-party dependency at all. The completion criterion is `docs/IOS.md` §10 step 1: `canControlNetwork` false for good, `clearAppData` as uninstall-and-install, `pushFile` under the device's own `dataPath`, `screenshot` refusing a device that is not `Booted` rather than hanging 60 s (§8 trap 1), and `bootstatus` as the wait condition so nothing sleeps. `index.ts` lands with the **capabilities the manifest has to declare** rather than merely with the last stub — corrected in place after #229 removed that stub without it, since a manifest that declared `canRecordVideo` before a recorder existed would fail the conformance gate it is there to pass — and the tooling is located and verified the way `adb` is. **That half is done** (#220): `src/backends/ios-simulator/developer-dir.ts` walks `DEVELOPER_DIR`, then the `xcode-select` selection read as the symlink `/var/db/xcode_select_link` is, then `/Applications/Xcode.app/Contents/Developer`, and accepts the first that holds a `usr/bin/simctl` this user may execute. It was filed as *parsers 4/4* alongside R44's issues, but it is this row's work rather than a fifth thing of R44's. Verification asks the filesystem rather than running the binary — the one deliberate departure from `adb-path.ts` — because "Command Line Tools are installed" is the state a developer machine is most likely to be in while looking fully equipped (`docs/IOS.md` §1), so a developer directory existing proves nothing and the utility inside it is the whole question; nothing in the module spawns a process, which is what lets a machine that has never had Xcode run every suite over it. Both forms `xcrun` honours are accepted — the Developer directory and the application bundle holding it — normalised on the rule that was *measured* rather than assumed (macOS 26.6.2 / 25G83, 2026-09-08): a candidate becomes the `Contents/Developer` inside it when there is one, which is not a `.app` suffix test, since `xcrun` normalises a non-bundle directory holding `Contents/Developer` too and leaves a `…app` without one verbatim. Without that, `DEVELOPER_DIR=/Applications/Xcode-beta.app` — a value the platform's own tool honours — is walked silently past, which is the one escape hatch the search has. **The `tooling-missing` interruption names `simctl`, not Xcode** — this row said Xcode and is reversed here in place with its reason rewritten (ai/RULES.md §1). The reasoning about Command Line Tools is untouched and is still why the tooling has to be *verified* rather than merely located; what was wrong was the name on the interruption. It names the program that was not found, for the reason `ADB_NOT_INSTALLED` names `adb` and not the platform-tools: the program is the half a person can act on, and shared code renders the name without ever learning what it is for (ai/RULES.md §2). `docs/IOS.md` §1 left it open as "`simctl`/`Xcode`"; this settles it. The failure itself names **each** place in the order it was tried, a place that yielded nothing included — `DEVELOPER_DIR — not set` — which is `describeAdbSearch`'s rule and for its reason. The resolver is **unmemoised on purpose**: holding the answer for a process's life, and the rule that a *failure* must not be held, are daemon lifecycle and belong with this row's backend, not with the search. **The rest of this row is being delivered in five phases**, the way R44's four were: the process layer, then the backend class with its enumeration and lifecycle, then the app and transfer methods, then capture and logs, then the recorder — and `index.ts`, `capabilities.ts` and the barrel import line land in the **last** of them, beside the recorder and the two capabilities it declares. That is one phase later than "with the change that removes the last stub", which is what this row used to say and what #229 corrected by removing the last required-method stub while registering nothing: the gate reads a manifest's declarations against its methods, so the manifest waits for the abilities rather than for the stubs. `tests/unit/backends/barrel.test.ts` still reads `['android']` until then. **Phase 1 is done** (#214): `src/backends/ios-simulator/simctl.ts`, the runner every method will go through. `simctl` is executed **directly** out of the directory the search above verified and never through `xcrun` — measured on macOS 26.6.2 / Xcode 26.4.1, 2026-09-08, `env -u DEVELOPER_DIR <dir>/usr/bin/simctl list -j devices runtimes` answers in full at exit 0 in 0.11–0.20 s, and the shim would add a second search that can disagree with the one already made (`docs/IOS.md` §1). Every invocation has a timeout, the udid goes immediately after the subcommand in the one function that addresses a device so no caller can forget the pin, the literal `booted` is refused there because `simctl` would otherwise pick a booted device of its own and report success, and **the exit code carries no meaning**: three subcommands produced three different numbers — 148 for an invalid device, 1 for an unrecognised subcommand with its usage text on *stdout*, 3 for a terminate that found nothing — so both streams and the number are surfaced together and nothing is mapped (`docs/IOS.md` §2). This platform also gained the device gate it never had: `ROVER_TEST_SIMULATOR`, probed through the backend's own resolution, warned about loudly, and booting nothing itself. **Phase 2 is done** (#227): `src/backends/ios-simulator/backend.ts`, the class, answering the four methods about *which devices are there and what they are* while every other required method is a `not implemented yet` stub — which is what lets it declare `implements DeviceBackend` and have its signatures typechecked with nothing registered. `listDevices` is one `simctl list -j devices runtimes` through `toDevices`, **both listings in one invocation** because neither is derivable from the other and two calls could disagree — a runtime uninstalled between them reports a device without a version that has one — and `describeDevice` is that enumeration filtered, `null` for a device that has gone. **`watchDevices` polls, and the gap is a `setTimeout` re-armed after each poll**: two seconds, against a listing measured at 0.11–0.24 s, which needs no sixth entry on `NO_SLEEP_PAUSE_CALLERS` and cannot stack two polls the way an interval a slow `simctl` outran would. The full current set goes out on subscription and whenever the **mapped** `Device[]` differs — never the raw JSON, because every device entry carries a `dataPathSize` that moves as the simulator writes to its own disk, and never the tool's ordering, which is keyed by runtime. A failed poll is one `onInterrupted` and the poll continues, with only `SimctlNotFoundError` classified and carrying `SIMCTL_MISSING` (#168); an interruption **clears what the caller was last told**, so the next successful poll re-delivers even when nothing changed, rather than leaving a caller holding a set it has been told to distrust. `deviceInfo` joins the device's `deviceTypeIdentifier` onto the `devicetypes` listing and reads that type's own `profile.plist` off disk, asking for `devices runtimes devicetypes` in **one** invocation — measured on macOS 26.6.2 (25G83) / Xcode 26.4.1 (17E202), 2026-09-08: all three listings and no `pairs`, exit 0 in 0.24 s, 115 KB — and it **throws** where `describeDevice` answers `null`, which is the contract's own distinction; a device type that does not resolve and a profile that will not read throw naming what was missing, never a plausible-looking screen. **`DeviceInfo.model` is the simulator's operator-chosen `name`, not the device type's `name` or `modelIdentifier`** — the two shapes carry one field under one name, so reporting the hardware model here would make `list_devices` and `device_info` disagree about what one device is called; when a field for a hardware model exists, `modelIdentifier` is what goes in it. Verified against a booted iPhone 17 on Xcode 26.4.1: 1206×2622 px, `density` **460** (a dpi, three digits) beside `densityScale` **3**, and `widthDp` 402 — exactly 1206/3 **Phase 3 is done** (#228): the app lifecycle and the two file transfers — six of the eight remaining stubs, leaving only `screenshot` and `readLogs`. `installApp` is `simctl install` with the host path masked out of any failure, and **it stages nothing** — the one place this diverges from the Android side, whose `withInstallablePackage` exists because `adb install` checks the file *name*. Measured on the same bench: `simctl` reads the contents, installing one zipped bundle at exit 0 as `payload`, `payload.zip` and `Rover.ipa` alike, which is what the layer above hands down; the name matters only for an unzipped `.app` **directory**, and one arrives already named by the toolchain that built it. `launchApp` is `simctl launch`. **`stopApp` is idempotent off the tool's *wording*, never off its exit code**: a terminate that found nothing exits 3, and the number is meaningless on this platform (Phase 1 above), so `parsers/app-control.ts` reads the stderr against two captured fixtures and an app that was not running counts as stopped. `clearAppData` is **`get_app_container … app` → copy the bundle off the device → uninstall → install the copy**, in that order because the path the tool prints is *inside* the storage the uninstall removes — verified by doing it — so staging afterwards would leave nothing to reinstall from. That route costs a fresh data container UUID, which is what it cannot preserve and the reason the honest alternative was recorded rather than hidden (`docs/IOS.md` §2 rules out both others, `install_app_data` included, across three plist spellings); between the uninstall and the install the app is not on the device, and a reinstall that fails says so rather than reporting the tool's exit code as though nothing had happened. **The two transfers reach no simulator at all** — the one thing here with no Android counterpart: a simulator's storage *is* a directory on this host, so a push is `copyFile` and a pull is `readFile`, both under the device's own `dataPath` out of `simctl list -j devices`, read per transfer rather than held (D6). `src/backends/ios-simulator/containers.ts` owns that mapping and confines it **lexically** — resolved and then required to be inside the root with a separator, so neither a `..` that climbs out nor a prefix sibling (`…/data-elsewhere`) passes, and the refusal names no host path. A push creates the parents it needs, refuses a destination that is already a directory, and every `node:fs` failure on either side is re-issued carrying the errno and the caller's own device path, because the library names a host path in every message it writes (D19). `redactArgv` arrived in the runner for the same rule one layer down: `simctl.ts` masks a named argument out of the failure it raises, so an install's staged bundle path never crosses the boundary. **Phase 4 is done** (#229): the screen capture and the log read — the last two stubs, so every required method of `DeviceBackend` is answered and nothing is registered yet all the same, the manifest landing with the recorder in phase 5. `screenshot` **checks the device's state first and bounds the capture regardless**, because those are two different failures: a capture on a device that is not booted blocks for **60.68 s** and then reports *Timeout waiting for screen surfaces* (measured on macOS 26.6.2 / Xcode 26.4.1, 2026-09-08), which the check turns into a 0.12 s refusal naming the device and its state, while the state changing between the check and the capture is what the 30 s budget is for. **The capture goes to a file this backend stages under `tmpdir()` and removes, never to stdout** — `simctl help io` documents `-` for it and that route is broken on this platform, exiting non-zero having written nothing because `-` is taken as a file name on a read-only volume; a *relative* path fails the same way, so the staged path is absolute (`docs/IOS.md` §8 trap 10). `--mask ignored` is passed for the frame arithmetic and changes no dimension: the PNG came back 1206×2622, exactly what `deviceInfo` reports, and the bytes are checked to be a PNG before they are answered as bytes rather than a path (D19). **`readLogs` pushes the bound into the query, and what it pushes is the device and a window rather than the process filter `docs/IOS.md` §5 first proposed** — reversed there in place with its reason rewritten, because `ReadLogsOptions` carries only `maxEntries` and there is no process to filter by. `simctl spawn` is itself the device scope (the answer holds `launchd_sim`, `backboardd` and `SpringBoard`, 1,958 entries against 2,766 for the same 20 s window of the host's own log), **a widening window `30s → 2m → 5m` is the rest of it**, and `--info --debug` are not optional: without them two of the five levels are silently missing. That window was a single `--last 30s` when this phase was first delivered, chosen against the 5,000-entry ceiling at a measured 67–160 entries per second, and **is corrected here in place with its reason rewritten** (the #239 review): 30 s at that rate holds 2,000–4,800 entries, *below* the ceiling, so a caller asking for 5,000 got everything the window had together with `truncated: false` — told by the one flag that exists to say otherwise that nothing older was dropped, while the device's store held an order of magnitude more (2,053 entries in 30 s against 34,819 in 5 m on the same bench). One window is not a substitute for the Android side's `+ 1`, because `log show` bounds a window and a predicate and nothing else and there is no count knob to ask one more than the cap of; **widening until the device says more than the cap is**, so the read re-tries at the next width while the answer would fit, the *cap* rather than the lookback binds it, and only the widest width may answer `truncated: false` — the same claim `logcat -t` makes when the ring buffer holds less than the cap. The widening is self-limiting and so nearly free: a device chatty enough to fill the cap fills it at 30 s and is never re-read, and the widest read only happens on a device quiet enough for it to be small. **The other half of that argument — that the widest read is therefore also small in bytes, ~15 MB at the ceiling and well inside the read's own 64 MB buffer — did not hold, and is corrected here in place with its reason rewritten** (the same review's second pass): it was a claim about a *rate*, and a read taken after something happened is exactly where the rate is not uniform. A burst that has aged out of the narrowest width is still inside a wider one, so the wider read is large precisely when the narrow one came back quiet — measured on the same bench on a simulator a minute past boot, `30s` 94,154 entries / **113.6 MB**, `2m` 160,587 / 191.8 MB, `5m` 195,444 / 232.4 MB, and on a second device type read seconds after boot `30s` 107.9 MB, `2m` **576.8 MB**, `5m` 756.4 MB — one to two orders of magnitude past that buffer, and an overflow is not a graceful truncation but a killed child and a lost answer. So the escalation is bounded by **bytes as well as by count**: a wider width that overflows ends the widening and the narrower width's answer stands, flagged `truncated: true`, an overflow being positive proof the device said far more than the cap. Raising the buffer is not the fix, since 756 MB was an *idle* device's figure with nothing under test on it. An overflow at the **narrowest** width still fails loudly — nothing came back to keep, and the partial buffer is the *oldest* bytes of the window where a log read is asked for the newest — which on this bench is reachable for the first half-minute after a boot at any cap at all, and at the peak of the burst arrives as the ten-second budget instead; what would answer that is a streaming read keeping a rolling tail of `maxEntries + 1` lines, the way `logcat -t` gets it on Android, and `simctl.ts` has no streaming runner yet (its own row when one is filed). **Phase 5 is done, and with it this row** (#230): the recorder, and the **second registered manifest** — `{ platform: 'ios-simulator', label: 'iOS Simulator (simctl)', capabilities: { canReadScreen: false, canInput: false, canControlNetwork: false, canRecordVideo: true, canControlRecording: true } }`, `capabilities.ts` plus a side-effect `index.ts` plus **one import line** in the barrel and no edit anywhere else, which is what the module shape was for. The label departs from `docs/IOS.md` §10's `(simctl + idb)` on purpose: there is no idb here, and naming one would promise a `readScreen` and an input vocabulary this backend does not have. The two `false` flags beside `canControlNetwork` are opt-outs rather than gaps — an **absent** method beside a `false` flag is a complete backend, a stub beside it is one under construction — so there is no `setAirplaneMode` and no `setWifiEnabled` at all, and this is the first registered manifest from which `MissingCapabilityError` is reachable on a real device rather than only on a synthetic one. **The recorder is a process on the *host*, and every difference from the Android side follows from that.** `simctl io <device> recordVideo` writes `Recording started` to **stderr** once the first frame is processed — measured on this bench, macOS 26.6.2 (25G83) / Xcode 26.6 (17F113) / iOS 26.5 (23F77), 2026-09-08, at 0.14–0.23 s — and finalises the file on **`SIGINT`**, exiting 0 in 20–30 ms; the wait is on that marker specifically, because an ordinary successful run prints `Note: No display specified…` to the same stream ~0.12 s earlier and a wait on "anything on stderr" would return before a frame existed. **It has no `--time-limit`**, so nothing on the device stops it: both `record_video`'s window and `StartRecordingOptions.maxDurationMs` are a **deadline timer on this host whose callback sends the signal** — explicitly not a sleep (D12, `tests/helpers/no-sleep-scan.ts`) — and what that costs is stated rather than hidden, since a daemon that dies takes the limit with it where `screenrecord --time-limit` would not. The lease-end teardown (`discardRecording`, D9) covers every case but that one, and it matters more here than on the other platform for exactly that reason. **Whether a device is recording is asked of the machine** (D6) and the machine is this **host's own process table**, `ps -A -o pid=,command=` matched on `io <udid> recordVideo` **and** on the program's basename being `simctl` — which is what survives a daemon restart, what sees a recorder another program started, and what `RecordingAlreadyRunningError` and `NoRecordingRunningError` are decided from; a handle is held only as a way to *act*. The container is QuickTime, brand `qt  `, `ftyp` → `moov` → `wide` → `mdat`, so `moov` precedes `mdat` and `src/verbs/recording-container.ts`'s shared walk reads it — the committed capture parses as one sample declaring 2,042 ms — and `--codec h264` is asked for explicitly because the default is `hevc` and the bytes are opened on somebody else's machine. There is **no bit rate to ask for** on this platform: an idle screen came back at ~50 KB/s (100,782 bytes for ~2 s) and four full-screen repaints at ~2.8 MB/s (810,871 bytes for 0.29 s), so `MAX_ARTIFACT_BYTES` (4 MiB) binds a busy-screen recording in under two seconds and the honest answer is that such a recording is short — where `../android/backend.ts` buys its way out with `RECORDING_BIT_RATE_BPS`. Three failure modes bit the implementer and are recorded in `docs/IOS.md` §8 as traps 12–14: a recording on a device that is **not booted** reports success at every step — marker at 0.228 s, exit 0, both success lines — and writes a **zero-byte file**, which is why the device's state is checked before anything is started and is the only thing between a caller and a recording of nothing; a **`SIGKILL`** on a recorder leaves CoreSimulator holding that device's recording lock (exit 16, *Host recording is already in progress*) with the encoder still writing and nothing but a shutdown-and-boot to clear it, so `SIGINT` is the only signal this backend ever sends; and matching the recorder in `ps` needs the **program** as well as the arguments — the token scan alone matched the capturing agent's own shell during measurement — compared by **basename**, because `<developer-dir>/usr/bin/simctl` is a bash shim that `exec`s the CoreSimulator binary and the running process reports that path while keeping the pid. `tests/unit/backends/barrel.test.ts` and `tests/unit/backends/conformance.test.ts` now read `['android', 'ios-simulator']`, which is the tripwire doing its job, and `tests/device/ios-simulator/verb-dispatch.test.ts` is the first iOS suite to take a lease from a daemon on a socket — the thing registration is what made possible | R44, R3 | L |
| R46 | The per-key refusal this platform needs before `canInput` can be declared | Shared code carries the per-argument refusal already (#215), so what is left is this platform's answer to the key vocabulary `DeviceKey` fixes: `back` and `home` are answered, `wake` reads lock state first so the press is idempotent, and the key with no equivalent is refused **by name** with an `unsupported-key` failure rather than answered with something that is not the key asked for. Its own row because the decision is about the shared vocabulary rather than about one backend's plumbing (`docs/IOS.md` §5, §10 step 3) | R45 | S |
| R47 | idb — the screen read, the four input primitives, and a real device stream | `docs/IOS.md` §10 step 2: `readScreen`, `tap`, `swipe`, `typeText`, `pressKey`, and `watchDevices` moved off the `simctl list` poll onto the companion's `--notify` change stream, which emits the full current set on every change and is `DeviceWatcher.onDevices`' contract to the letter (§7). Talk gRPC from Node rather than shelling out to the Python client, supervise one companion per target, **never** call its file push (it kills the companion, §4), and classify a companion crash as an interruption rather than a device fault. Checkable: `canReadScreen` and `canInput` flip to `true` with the conformance suite green, and a second simulator booting produces one full-set update per transition with no polling anywhere. **This row is being delivered in five phases**, the way R44's four and R45's five were: the pure layer under idb, then `watchDevices` on the stream with the poll as fallback, then one supervised companion per target over gRPC, then `readScreen`, then the four input primitives — and `capabilities.ts` moves in the last two, beside the abilities it declares. **Phase 1 is done** (#216): where `idb_companion` is on this host, and what its `--notify` target stream says. **Nothing spawns a process, nothing registers and no capability moves** — the shape `developer-dir.ts` and `parsers/simctl-list.ts` already set for this backend's first external program, and `tests/unit/backends/barrel.test.ts` and `conformance.test.ts` still read `['android', 'ios-simulator']` with the label unchanged at `iOS Simulator (simctl)`. `src/backends/ios-simulator/idb-companion-path.ts` is the search, and it has **two rows and no third**: `ROVER_IDB_COMPANION_PATH` taken verbatim (empty counts as unset), then every `PATH` entry in order with an empty entry skipped, and off macOS the list is empty so every suite stays runnable on a Linux runner. Two rows because this program has **no canonical install location at all** — brew no longer carries it, the old `facebook/fb` tap is gone, and the supported install is an unpacked release tarball wherever the operator put it — which is the argument README already makes for `ffmpeg`, with the override added on top because a tarball in a scratch directory is on no `PATH`, least of all the short one a GUI-launched daemon inherits (D5). Never a walk of the disk (D32). **A candidate is accepted on the filesystem rather than by being run**, which is one step short of `adb-path.ts` and deliberately so: `adb version` is acceptable only because it was *measured* to start no server, whereas one companion per target is something this backend has to supervise rather than start as a side effect of looking — and nothing spawning a process is what lets the suites import the module on a machine that has never had idb. Phase 3 starts a companion on purpose and is where a side-effect-free flag could be measured; what was measured here is that `--version` prints only `{"build_date":"Sep 1 2026","build_time":"08:51:20"}`, so a capture is pinned to the **release tag** it was downloaded from and not to anything the program will say. Unmemoised, `developer-dir.ts`' stance, since a companion arriving on a running host is what phase 2's restart-on-a-backoff exists to pick up. `IDB_COMPANION_MISSING` is the `tooling-missing` cause naming `idb_companion` and it needed **no shared-code edit**: `InterruptionCauseSchema.tool` is already a free program name, so a backend's *second* program asks nothing of the device interface. `parsers/idb-notify.ts` is the frame decoder and the vendor schema, both written from a capture taken on this repository's own bench — companion **v1.5.2** on Xcode 26.6 / iOS 26.5, 2026-09-08, `idb-notify.idbcompanion1.5.2-xcode26.6-ios26.5.txt`, the companion's version leading the filename because the companion is what governs this format. The framing is **one JSON array per line, newline-terminated**, each line the full set; the decoder holds the trailing partial and a frame it cannot read is terminal for that run (`TrackFramingError`'s reasoning — framing that has lost sync cannot be resynchronised, and a device list assembled from a guess is worse than none). **The terminating newline arrives in its own write** — the reads came in at `1784, 1, 1784, 1783, 1789, 1, 1785` bytes — which is why this is a decoder rather than a `split('\n')` per chunk. The target schema is a non-`.strict()` projection of Meta's six keys with `state` **and** `type` open strings, for `SimctlDeviceSchema`'s reason on the first and because this bench had no physical target paired on the second: an enum there would refuse the one frame the exclusion rule exists for. `toNotifiedDevices` is a second entry point in `devices.ts` rather than a module of its own, so the platform id, the `Booted`-is-the-only-`ready` predicate and `SIMULATOR_ATTACHMENT` are each decided once — `toDeviceState` now takes a bare state token so both paths share it literally. Two decisions there are not mechanical. **`osVersion` is normalised to the version alone**: idb reports `iOS 26.5` where `simctl`'s runtime reports `26.5` for that same runtime, and two spellings for one device would let the watch and `listDevices` disclose two different OS versions — the disagreement `deviceInfo`'s `model` note already refuses on the model field. A second `simctl list -j` capture was taken minutes later on the same bench for exactly that assertion, so the suite compares `toDevices` and `toNotifiedDevices` **device by device** over the same eleven simulators rather than each against a literal, which is the drift that matters. **And only a simulator under an iOS runtime is admitted, as an allowlist**: idb enumerates physical targets, `attachment.ts` records that a paired-but-absent iPhone is served by this platform's tooling by default forever, and a physical device cannot answer `screenshot` — a *required* method (`docs/IOS.md` §6). An allowlist because the direction of the mistake is not symmetric: an unrecognised target excluded is a device this host declines to lend, while one admitted by default is D18's two-agents-one-device failure wearing a disguise. Neither exclusion is in the capture, because no iPhone was paired to the bench and only the iOS runtime was installed, so both are pinned by inline cases named as inline. **What a green suite here cannot claim**, and the change says so: that the parser matches what the companion prints in general. It matches one capture from one version on one host; the first evidence past that is phase 2's device test. **Phase 2 is done** (#249): `watchDevices` runs on the notify stream, with the `simctl list` poll kept as the **fallback**. `src/backends/ios-simulator/idb-companion.ts` is the streaming runner — `spawn`, `stdin: 'ignore'`, `close` rather than `exit`, `onStdout`/`onStderr`/`onEnd(reason)` with `onEnd` exactly once, a `stop()` that kills, and **deliberately no timeout** for `streamSimctlOnDevice`'s stated reason: the one call that uses it is supposed to stay open, so a timeout would guarantee the failure it exists to prevent. The argv is the caller's and the process is the module's, so phase 3 reuses the spawn half for a companion started with `--udid` without a second copy of any of it; `resolveIdbCompanion()` throwing is let out **synchronously** so the watch can classify it, exactly as that runner lets `SimctlNotFoundError` out, and `streamOutcome` is now exported from `simctl.ts` rather than copied a third time. stdout is handed over as **bytes** because a chunk boundary can fall inside a multi-byte character; stderr is decoded, and the **tail** goes into the interruption message rather than into the runner's `reason`, which is that runner's rule that whoever puts a stream into a message is who bounds it. In `watchDevices` the two sources sit behind one delivery rule and **only one delivers at a time**: a frame is the only evidence the stream is healthy, so a frame is what takes the watch off the poll, and while the stream is up `simctl list` is not run at all. **A lost view is one `onInterrupted`, never an empty set** — an empty set reads as every device having gone away, which for an inventory means releasing devices that never moved — carrying `IDB_COMPANION_MISSING` when there is no companion to run, `SIMCTL_MISSING` when the fallback has no `simctl`, and `null` otherwise, because `null` is the claim "this is expected to clear". **The view is whichever source is serving the caller**, which is what makes the fallback exactly one interruption rather than one per attempt: once the poll is delivering, a companion that fails to start again changes nothing the caller can observe and is silent. Restarted on a doubling backoff, `AndroidDeviceBackend`'s `TRACK_RESTART_MIN/MAX_DELAY_MS` shape at 250 ms to 5 s, reset by a frame — a `setTimeout` whose callback does the next attempt and never a sleep — because an `idb_companion` unpacked onto a *running* host is what the restart exists to pick up, the search being unmemoised. A frame the decoder cannot read is terminal for that run and reported rather than thrown, since there is nothing above a stdout handler to catch it. `stop()` silences every handler synchronously, kills whichever companion is live and clears whichever timer is pending. **No capability, method, manifest or gRPC work**: `listDevices`, `describeDevice` and `deviceInfo` keep reading `simctl`, because idb is not a second source of truth for an enumeration a lease grant re-verifies (D6) — what makes the two safe to mix is phase 1's normalisation of the notify path's `os_version` onto `simctl`'s spelling. `tests/device/setup.ts` gains a fifth flag, `ROVER_TEST_IDB`, probed through `resolveIdbCompanion()` rather than a bare name (#171) and **spawning nothing at all**, which is not restraint but the whole of what that search does; it is warned about as loudly as the ffmpeg gate. `idb-companion.ts` is added to `remote-never-spawns.test.ts`' `ALLOWED_TO_SPAWN` deliberately, and it is the one entry there whose child is unbounded by design. **What a green unit suite here cannot claim** is that a real companion behaves as its mock does; the device case that closes that gap asserts the first delivery names the booted device `listDevices` names with the same `osVersion` string, and it skips on a host with no companion. **One trap was hit building this and it would have made the whole stream silently unavailable** (`docs/IOS.md` §8 trap 15): `idb_companion` resolves Xcode through `xcode-select`, so on a bench whose selection is CommandLineTools — the state §1 of that document says a developer machine is most likely to be in — it exits **0 with an empty stdout** and one line on stderr, while `simctl` runs perfectly through `developer-dir.ts`' search of the same machine. So the runner exports `DEVELOPER_DIR` for the child, set to `resolveDeveloperDir()`, which is #171's "never measure two machines" one program further out and preserves an operator's own value by construction since that variable is the first row of the search; a resolution that fails leaves the environment untouched, because the companion's own complaint about a host with no Xcode is more accurate than a substitute. **Driven end to end on this bench afterwards** with one `iPhone 17 Pro` booted and shut down again through the fixture README's own recipe: three deliveries, each the full set of eleven, at +0/+326/+3754 ms and zero interruptions, with no `simctl list` run at all — and the `Booting` frame collapsed rather than missing, since `Booting` and `Shutdown` both map to `offline`, which is the delivery rule saying that the companion emits per change *it* sees while the watch delivers per change a caller can see | R46 | L |

**R20 is done** (#20). `README.md` opens with a `## Quick start` covering the four things it
could not carry before the code existed: taking a device on this machine, the MCP client entry and
how to prove it handshakes, exposing this machine as a network host, and reaching one from a
client. Every command in it was run before it was written, and the outputs shown are the ones that
were printed. What the run could and could not cover, stated there and here rather than left to
read as "checked":

- The device was `emulator-5554`, an `sdk_gphone64_arm64` emulator on **API 35** (Android 15).
  §6's adb recipes were verified on API 37 and its later recording, frame and environment findings
  on this same API 35 emulator; nothing in §6 was re-verified by this row.
- **The remote pair was exercised on one machine over TLS on loopback**, with a self-signed
  certificate carrying `IP:127.0.0.1` in its `subjectAltName`, one process listening and one
  connecting. There was no second machine, so the README says so and says which value to
  substitute. What that run did prove end to end: the TLS listener, a token from `rover users add`,
  `status` / `list` / `acquire` / `screenshot` / `release` over `--host remote`, an MCP server
  driving the same host through its `env` block, all four distinct connection failures
  (`ECONNREFUSED`, a rejected token, `DEPTH_ZERO_SELF_SIGNED_CERT`, `ERR_TLS_CERT_ALTNAME_INVALID`)
  and `rover users revoke` biting on the very next attempt with the daemon still up.
- **`record` was not run and is therefore not shown.** This machine has no `ffmpeg`, so the call
  exits 1 with `frame-extraction-unavailable` — which was run, and is named in the README as a gap
  rather than presented as a working command.
- The MCP server was driven over stdio rather than through an MCP client's own configuration: three
  frames in, the handshake and **22 tools** back — 23 since #104 added `install_app` — plus a real
  `list_devices` call against the device and both startup guards (an incomplete `ROVER_HOST_*` set,
  and a `ROVER_PROJECT_FILE` naming no file).
- **A published entry point was not part of this row** and was not added then: the quick start
  shipped against `npm run rover --`, which is what works in a fresh checkout. §9.4 below reversed
  that on 2026-09-01, when `rover init` gave the CLI a command that has to run outside this
  checkout — and the quick start still works unlinked, because each pasteable line is now rendered
  as the form the reader's own invocation proves.

**R19 phase 3 is done** (#90). `screenshot` and `record_video` are MCP tools: screenshots return
an inline image and write nothing, while recordings are written under the agent-local
`ROVER_MCP_ARTIFACT_DIR` and their frames return inline. The shared byte-level decode, length
check, write and payload-free description live in `src/client/artifact.ts`, so neither the CLI nor
the MCP adapter can silently diverge. The file-transfer tools remained outside MCP with that
phase; R24 phase 2 delivered their CLI commands, and #104 later added `install_app` in its
byte-less form alone, leaving `push_file` and `pull_file` out.

### 9.4 Outside the backlog — deliberately

- **Physical iOS devices — narrowed from "the iOS backend", and the decision this bullet used to
  record reversed (2026-09-08).** The simulator is in the backlog: R44–R47 in §9.3, and R44 phase 1
  has shipped (#213). What stays outside it is the **hardware**.

  **What this said before, and why it was right at the time.** Only the seam was built (§5), and
  before an issue could exist two things had to be settled: the dependency on `idb` or
  WebDriverAgent, and accepting that `read_screen` might have no equivalent on that platform at
  all. Both were open questions rather than objections, and filing a row against either of them
  would have been filing against a guess.

  **What changed is that both were measured, and `docs/IOS.md` is what measured them.** idb is
  alive and characterised — 1.5.2 released 2026-09-01, a prebuilt arm64 companion, a gRPC server
  rather than the Python client that fronts it, and one deterministic crash (its file push) that a
  simulator's host-path container means nothing needs to call. And `read_screen` has a **full**
  simulator equivalent: `idb ui describe-all` returns labels, roles, traits and point frames, and
  it works on a Compose Multiplatform app. R45 is also the answer to the dependency question in a
  form neither option offered — every required method and two capabilities on the first-party tool
  alone, with the heavy dependency added afterwards as R47 rather than assumed up front.

  **What stays parked is the hardware, and the wall is a required method.** Apple's supported path
  to a real iPhone has no screenshot subcommand at all, and `screenshot` is a *required* method of
  `DeviceBackend` rather than a gated capability, so nothing this repository can write makes a
  physical iPhone a device this contract can lend honestly (`docs/IOS.md` §6). The only path that
  clears it is a WebDriverAgent-class in-device agent — an XCUITest bundle per device, a
  developer-signed build, a provisioning profile, a port per device and an agent process whose
  crash is a device outage. **Nothing in that section is measured**, because no phone was attached.
  The row is filed when somebody wants to pay for that agent, and the reason is recorded here then
  — because "iOS is supported" will otherwise be read as covering hardware, which is exactly why
  the backend is named `ios-simulator` and not `ios`.

  **The one thing that has to be written down before that row exists** is D18's shape on this
  platform, and it already is: the enumeration serves a **paired but absent** iPhone with a name, a
  udid, an OS version and a hostname on a Mac with nothing plugged in, so `transportType` is the
  field that decides `this-host` from `another-host` and `tunnelState: unavailable` is admissible
  as neither. That is in `src/backends/ios-simulator/attachment.ts` and in `docs/IOS.md` §7, where
  whoever picks the row up will look.
- **Swarm integration (D16).** Nothing to build now; R6 and R8 only have to keep the road open —
  daemon state queryable from outside MCP, and a lease with an explicit owner.
- **A `Planning` column on the board.** Swarm maps such a status in its project configuration and
  our board does not have one (`ai/RULES.md` §5). To be settled when onboarding Rover into Swarm:
  add the column or configure that phase away. Do not add a column nobody uses in the meantime.
- **Retention policy for the artifact archive (§10, D23, D24).** A TTL, a size cap, and who runs
  the prune — a human operator by cron, or the daemon itself — are all still undecided. This can no
  longer be left until disk pressure is actually observed: once a future web panel (`docs/WEB_PANEL.md`)
  reads this archive directly, unbounded growth is a problem from the panel's first day, not
  something to wait and see about. R25 still builds the archive with no pruning of its own — but
  the follow-up retention row is filed **once R25 ships**, ahead of any work that reads the archive.
  **Status, 2026-08-31:** R25 shipped (#27) and the row is still not filed, while panel work now is
  (R29–R35). That is a deliberate narrowing rather than a lapse — the Devices screen reads the live
  inventory and never touches the archive, so it cannot make growth worse. The constraint binds on
  R33's successors, the archive-browsing and comparison screens, and the row is filed before the
  first of those, not before the panel as a whole.
  **Status, 2026-09-08:** the *operator's exemption* landed ahead of the policy (#234, D33) — a
  per-test `Keep` flag in the host's own `~/.rover/kept-tests.json`, with two methods and a CLI
  command that read and set it. **The retention policy itself is untouched and still undecided**:
  no TTL, no size cap, nobody nominated to run the prune, and nothing anywhere sweeps or deletes an
  artifact. What changed is the order the two arrive in, and deliberately so — a sweep must not ship
  before the exemption exists, because it could then delete a test an operator had every reason to
  believe was kept. It now cannot: the flag is on disk, outside the tree, and survives a restart.
  The row stays open until the TTL, the cap and the prune's owner are settled together.
  **Status, 2026-09-08 (#238, phase 1 of three):** two of those three are now settled and named,
  and the mechanism exists. The **cap** is `ROVER_ARTIFACTS_BUDGET_MB` (1024) and the **TTL** is
  `ROVER_ARTIFACTS_MAX_AGE_DAYS` (30), both host environment variables asserted equal to the System
  screen's own defaults so the two cannot diverge; what they mean is D34 (the unit of deletion and
  the ordering), D35 (the two absolute exemptions) and D36 (an unmeetable budget is a refusal, never
  a kept test deleted). The mechanism is `src/daemon/archive-sweep.ts`, reachable as `sweep_archive`
  and `rover sweep --dry-run|--actor`.
  **Status, 2026-09-08 (#245, phase 2 of three): half of the third thing is now settled — the
  *budget* runs unattended.** Every lease that ends, released or expired, is followed by a
  budget-only sweep on the path D9 already runs (D37, `sweepAfterLease` in
  `src/daemon/archive-sweep.ts`, wired at the restorer in `src/daemon/listen.ts`). So a host
  nobody ever types a command on no longer grows past its disk budget, which is what this row was
  named after. It is behind the release rather than in it, so no agent waits on the walk, and a
  sweep that fails leaves the release successful and says so on the host's log. A **shutdown**
  waits for it, bounded, because a `process.exit` inside the deletion would leave a half-emptied
  run behind (D37). The walk's cost is in §6 and was measured rather than assumed, because it is
  now paid on a path an agent is waiting near: ~150 ms for a full archive at the default budget,
  and no cached total was built.
  **What is still open is the other half: the age limit, which still only runs when asked.**
  Nothing here is a clock — no timer, no midnight pass, no start-up pass — so a test on a host
  inside its budget can sit there past thirty days until an operator runs `rover sweep`. Phase 3
  closes it, and **this row moves into the backlog proper (§9.3) only when it lands.** Saying so
  here is what keeps it honest in the meantime: half the policy now enforces itself, and half of
  it is still waiting for somebody to ask.
- **Multi-host addressing (R23), dropped.** The deployment this is built for has exactly one
  machine with hardware, so a device handle stays a bare serial and a client never aggregates more
  than one host (D18, revised 2026-08-29). If devices ever end up spread across more than one
  machine, R23's shape — host+serial handles, a client-side host registry that aggregates several
  hosts and names any that did not answer — is the row to revive. Nothing in D17 (the one host
  reachable over the network) or D19 (verbs execute on the host) needs to change for that; it is
  simply not being built against a need that does not exist yet.
- **A published `rover` entry point — taken, and the decision this bullet used to record
  reversed (2026-09-01).** `package.json` now carries `"bin": { "rover": "bin/rover.mjs" }` and
  stays `"private": true`. Nothing is linked automatically: a fresh clone still has no `rover` on
  its `PATH` and still types `npm run rover --`; `npm link` in the checkout is what puts the
  command there.

  **What this said before, and why it was right at the time.** The objection was that a `bin`
  entry makes a quick start *worse*: a bare `rover list` is `command not found` in every fresh
  clone until somebody links a private package that runs TypeScript through `tsx`, and R20 had
  just asked for a quick start whose commands actually work. Two questions were left open with
  it — shipping through `tsx` versus adding a build step, and what `npm link` means for a package
  marked private.

  **What changed is that a command now has to run where this checkout is not.** `rover init`
  onboards *another* repository — its hook file, its `.mcp.json`, its `ROVER.md`, its agent
  file — and `npm run rover -- init` from that repository's directory runs whatever
  `package.json` is sitting there. No form of the npm invocation does the job, which is a
  different situation from the one this bullet was written about: every other command is run from
  inside the checkout, by somebody who already has it open.

  Both open questions turned out to have cheap answers. `npm link` works on a `"private": true`
  package — private governs `npm publish` and nothing else — so no build step and no registry are
  involved, and `bin/rover.mjs` ships through `tsx` exactly as `bin/rover-mcp.mjs` does, for the
  same resolution reason (§6): a bare `--import` specifier resolves against the caller's working
  directory, which is precisely what a linked command cannot rely on, while a bare specifier
  inside the launcher resolves next to itself, in the checkout, where the loader is.

  **The original objection is answered rather than accepted as a cost.** `INVOCATION`
  (`src/cli/_shared/output.ts`) is no longer one constant that has to be right for everybody: it
  answers from `process.argv[1]` — `rover` when the process came through the launcher, `npm run
  rover --` when it did not — so every pasteable line names the form its own reader has just
  proved works. A fresh clone reads `npm run rover -- status`, a linked checkout reads `rover
  status`, and neither is ever told to type the other one's command.

  **`bin/rover-mcp.mjs` was never that, and its own reasoning is untouched by the reversal**
  (#104). The objection above was `command not found` for a name nobody put on a `PATH`; that
  file is named by
  **absolute path** in an MCP client's own configuration, which is a path that config already had
  to state, so there is no lookup to fail. It needs no link, and it is unaffected by there now
  being one. It exists because the MCP server's entry is the one Rover invocation
  with no `npm run` wrapper in front of it, and `node --import tsx/esm <absolute script>` resolves
  the loader against the *client's* working directory (§6) — so the documented configuration
  started in this checkout and nowhere else. A bare specifier inside the launcher resolves against
  the launcher's own URL instead, which is where the loader is.
- **The web panel.** Not scheduled, not sized, no issue filed — CLI and MCP are the whole interface
  for now (§7). But the daemon and the archive (§10, D23, D24) are deliberately shaped so a
  read-only panel can be added later without a redesign, so the functionality it will need is being
  written down as it comes up, in `docs/WEB_PANEL.md`. Turning any one line of it into an actual
  backlog row happens only when this section's other rows are far enough along to make room for it.

---

## 10. Artifact retention on the host

Every verb that produces a screenshot, a recording, or a log pull writes into a fixed directory
tree on the host, **in addition to** returning bytes to the client (D19, D23) — this is a second,
host-local effect of the same call, never a substitute for it and never a path handed to the agent.

```
<rover-data-dir>/artifacts/          # ROVER_ARTIFACTS_PATH, default ~/.rover/artifacts
  <project>/
    <test_name>/
      <timestamp>-<owner>-<hash>/    # the lease's own directory, generated by the daemon
        <device-serial>/
          device_info.json           # size, density, dp scale, OS version — a static copy of D14
          test_description.json      # the lease's own account of the run, when it supplied one
          group_id.json              # which investigation this run belongs to, when it named one
          screenshots/
            001_<verb>.png
            002_<label>_<verb>.png   # <label> only when the call carried one
          recordings/
            001.mp4
            001_frames/
              0001.png
          logs/
            001_read_logs.txt
```

- **`project` and `test_name` are opaque, caller-supplied strings** (D22) — the core never parses,
  validates their content, or derives one from the other. `project` is the top-level partition, so
  two projects reusing the same `owner` or `test_name` never collide.
- **`test_description` is a fourth opaque string and is *not* part of the tree's shape** (D22, as
  amended #148). It is prose rather than a directory name, so it never goes through `pathSegment`,
  `archive-path.ts` never sees it, and no level above is named from it — `test_name` remains the
  only caller string the tree is shaped from. What the archive does with it is file it, as
  `test_description.json`, on `device_info.json`'s exact terms: **written once with `flag: 'wx'`,
  never rewritten, beside the first artifact the lease produced**, so it says what the lease said
  when the run happened and it outlives the lease. A lease that supplied none writes no file, and a
  lease that produced no bytes writes nothing at all — including this, because nothing files a
  description at grant time and no run directory is created by a grant.
  **It sits *inside* the `<serial>` directory rather than beside it**, which is one level deeper
  than what it describes, and the reason is the read side: `list_archive` publishes a run's serial
  to the panel as the run directory's `onlyChild`, which is `null` for a directory holding anything
  other than exactly one entry, so a second entry at the run level would blank `SERIAL` and the run's
  device card for every run that has a description, and leave the tree with no level to open under
  the run. One lease is one
  device (D7), so the `<serial>` directory is the lease-device pair's and is one-to-one with the
  lease in any case. Nothing indexes it and nothing searches it: `search_archive` searches **names**
  (R38), and widening it to file contents is a different decision.
- **`group_id` is a fifth string, is *not* part of the tree's shape either, and is the one
  that spans leases** (D22, as amended #150 and #205). Several leases carrying one group id are one
  investigation. It is the one attribution string the host does not merely store: the caller names
  the investigation and the host mints the id it files, appending a reserved `.` and a short suffix
  (#205, `src/daemon/group-id.ts`). What lands here is therefore the host's id, and what this
  section files is unchanged by that — a minted id survives `pathSegment` unrewritten by
  construction, and nothing about the tree branches on it. It cannot be a directory name — it would be a *fifth level*, and the tree is
  deliberately always four — so it is filed as `group_id.json` on `test_description.json`'s exact
  terms: **written once with `flag: 'wx'`, never rewritten, beside the first artifact the lease
  produced**, inside the `<serial>` directory for the same `onlyChild` reason. That is what makes
  the criterion hold: **after every lease in a group has ended, a reader can still recover which
  runs share it** — by walking the tree and reading that file, which is the same request-time walk
  R38 already makes rather than an index (D24). Nothing joins two runs, counts a group's members or
  checks that a second ever arrives; the host writes down what the lease claimed. **That walk is
  `list_archive_groups`** (#178): the third *method* that reads this archive answers which groups exist,
  which runs are in each, and which of a grouped run's artifacts carry a label — bounded, with no
  index, no catalogue and no cache, exactly as `search_archive` is. A run with no `group_id.json`
  is absent from that answer and nothing is invented for it.
- **A `label` is an artifact's own name and it lives in the *file name*, not in the tree** (D22, as
  amended #150). It comes off the **call** — `screenshot`, `record_video`, `read_logs`, exactly the
  three this section files — rather than off the lease, because one lease takes several screenshots
  and they are not all the same screen. It sits immediately after the sequence number, which still
  leads because the number is what says *order*: `001_home-screen_screenshot.png`,
  `001_home-screen.mp4` with `001_home-screen_frames/` beside it, `001_home-screen_read_logs.txt`.
  So *which artifacts are the same thing at two moments* is answered by listing a directory, which
  is what the tree is shaped for (D24). It goes through `pathSegment` like every other path
  component, collision hash and all — so keep a label short and identifier-shaped, exactly as
  `test_name` wants to be. **A `label` requires the lease to carry a `group_id`** and the host
  refuses the call by name otherwise (D22): a label only means something inside a group.
  **It is read back out of the name by `list_archive_groups`** (#178), and what comes back is the
  label **as the archive filed it** — `pathSegment` truncates, rewrites and hashes, so the caller's
  own string is genuinely unrecoverable and nothing anywhere presents the filed text as one. The
  decoding is `filedLabelOf`, the inverse of the `labelled` that wrote the name, and both live in
  `archive-path.ts` so one module owns this layout in both directions. It is still an identity that
  behaves — two different labels essentially never arrive as one filed string, an unrewritten one
  being itself and a rewritten one carrying a hash of the original — which is all *the same label
  is the same thing at two moments* needs. **One class of label cannot be read back, and is
  answered as none rather than as a guess**: a recording is the one artifact filed with no fixed
  suffix after the label (`<seq>_<label>.mp4`), so a recording labelled exactly `screenshot` or
  `read_logs` is spelled the way an *unlabelled* screenshot or log is, and `filedLabelOf` resolves
  that towards the suffix — the recording and its `<seq>_<label>_frames` directory are both absent
  from `list_archive_groups` rather than one of them carrying a label nothing can trust. A label
  merely *ending* in `_screenshot` or `_read_logs` comes back as its head (`home` for
  `home_screenshot`), on both halves of that pair. Giving a recording a suffix of its own would
  settle both, and it is not taken here for the reason the sidecar below is not: it changes what
  the archive writes, and every run already on disk would decode by a different rule from the ones
  written after it. A **sidecar file recording the caller's exact label** was
  considered and **not taken**: it would change what the archive writes, it could not be `wx`-once
  the way `group_id.json` is because a lease writes many artifacts over its life, and it would
  leave every run already on a host's disk without one.
- **Neither branches the tree's shape.** An unlabelled call is filed under the name it always had,
  a lease with no group files no `group_id.json`, and `leaseArchiveDirectory` is four levels in
  every combination — which `run-identity.ts`, `list_archive` and the panel's three levels all
  count on. A `<group_id>/` level was considered and **not taken**: it would make "what else is in
  this group" free to query and would break *always four levels*, which is the branch #129 removed.
- **`test_name` is deliberately not unique.** Two leases can carry the same name at two different
  points in time — exactly the shape a before/after refactor comparison needs: list the directory
  and the two most recent runs are the two sides of the diff.
- **`test_name` is required**, so the tree is always four levels and never branches on whether the
  field was supplied (D22, as amended #129). It used to fall back to one fixed directory name
  (`unlabeled`); nothing writes that any more, and an `unlabeled/` already on a host's disk is left
  exactly where it is — it lists like any other folder and is not special-cased by anything.
- **The lease's directory needs no project or test name baked into it** — both are already the
  enclosing directories. It is `<timestamp>-<owner>-<hash>`: chronological within its folder, and
  self-disambiguating without repeating information the path already carries. It is **derived from
  the lease, and is not the lease id**: the id is the credential that ends a lease (D20), and a
  tree shaped to be browsed by a human and later served by a read-only panel (D24) must not have
  live credentials in its path names — so the `<hash>` is the first eight hex characters of a
  SHA-256 of the id, and the id itself never appears. `<timestamp>` is the instant the lease was
  granted, in UTC basic format (`20260830T170501Z`), which sorts chronologically as text.
- **Every path segment is sanitised, and sanitising is not validating** (D22). `project`,
  `test_name`, `owner` and the serial are opaque strings the core never parses, and nothing
  branches on what they say — but one of them is about to become a path component, so: anything
  outside `[A-Za-z0-9._-]` becomes `_`, leading `.` and `-` runs are stripped (which kills `.`,
  `..`, a hidden directory and anything that could read as a flag), the result is truncated to 64
  characters, an empty result becomes `_`, and **if any of that changed the string, an eight-hex
  hash of the caller's original is appended**. A string that needed no rewriting is left exactly as
  it was typed, so the common case stays readable; two different hostile strings that would
  otherwise sanitise alike land in two directories rather than sharing one, because a shared one
  would make the before/after diff compare two callers' runs. Known and accepted: a
  case-insensitive filesystem folds `Home` and `home` into one directory.
- **A verb that produced no bytes writes nothing**, not even a directory — a lease that only ever
  tapped leaves no empty scaffolding in the tree.
- **The archive can never fail the call.** It is a second effect, so a full disk, an unwritable
  root or a permission error is warned about on the host — naming the path and the reason — and the
  verb's answer goes back exactly as it was.
- **The archive path is never the one returned to the agent** (D19, R24 unchanged). A client asking
  "what does the archive look like" is a different question from "what did this verb call return",
  and the two are never conflated. Structurally, not by discipline: `src/ipc/server.ts` parses every
  handler's answer against that row's `.strict()` result schema, so a path put on a result would be
  rejected as `invalid_result` before it reached a client.
- **The tree is deliberately walkable without an index** (D24) — and still is: no database, no
  separate catalogue kept in sync with the files, no cache of a walk. What changed on 2026-09-01 is
  that listing a directory is no longer the **only** query a viewer can run: R38's `search_archive`
  searches the tree by **walking it at request time**, which is the same no-index property spent
  differently rather than abandoned, and is why that walk is bounded and says when it was. The two
  most recent `<lease-id>` folders under one `test_name` are already the before/after pair a diff
  view wants, which is the reason `test_name` is deliberately not unique (above).
- **The tree is now *read* over the surface** — `list_archive` (R36), one directory level per call,
  taking the components a previous answer returned and never a path on the host. Empty, missing and
  unreadable are three answers rather than one, because each renders differently and the pair that
  must never be confused is *the archive is empty* with *the host cannot say what is in the
  archive*. No path appears on a result and there is no field one would fit in (D19), so a level the
  host cannot read is diagnosed in the host's own log instead. It is a listing and not a query, and
  stays one: the parameter that would make it one is how an index gets built by accident (D24). The
  query itself is a **separate method** beside it — see the bullet below.
- **And the tree's *bytes* are now readable too** — `GET /artifact/<component>/…` (R37), one file
  per request, addressed by the same components `list_archive` answers with, so the archive has one
  path vocabulary rather than two. It is a route on the HTTP surface rather than a method on the one
  table, because an artifact is bytes and an envelope carries JSON: a recording base64'd into a
  frame would be inflated by a third, buffered whole on both sides, and still not something a
  browser can point an `<img>` or a `<video>` at. `missing` and `unreadable` are `list_archive`'s
  own words on this route too, containment is resolved and compared again rather than assumed, and
  no path or errno is on any answer (D19).
- **And the tree is *searchable*, which is the archive's third read** — `search_archive` (R38),
  since 2026-09-01. It takes the text and nothing else and answers matching entries of the **whole**
  archive as component arrays — the same path vocabulary `list_archive` answers with and
  `/artifact` accepts, so no caller ever composes a host path and no result has a field one would
  fit in (D19). It is a **separate method rather than a parameter** on `list_archive`, whose shape
  is untouched. There is still **no index**: the answer is a bounded walk of the filesystem at
  request time, capped by depth, by match count and by directories read, and a bounded answer says
  `truncated`. A component is matched **whole, verbatim and case-insensitively** — nothing
  decomposes a name to search it (D22). A level the host cannot read mid-walk does not fail the
  search: the reason and the path stay in the host's own log, as `list_archive` already warns, and
  the answer says it is truncated. On `PANEL_METHODS` (D29) and deliberately **not** an MCP tool,
  which is `list_archive`'s reason with more force — one call would hand an agent the run names of
  every other agent on the host. **The reader that asks is the Archive screen's tree card** (#146):
  the field between its header strip and the tree, debounced with one request in flight, and the
  whole matched tree drawn from that one answer rather than re-walked a level at a time.
- **The operator can now say *keep this test* — and the tree grew nothing to carry it** (D33,
  #234). The flag is per `<project>/<test_name>`, the two leading components above, and it lives in
  `~/.rover/kept-tests.json`: a document of the **host's** own, beside `users.json` and outside this
  tree entirely. No `keep` file at the test level, no sidecar in a run, no fifth level, no field on
  anything already written — nothing in the layout above changed, and a host that upgrades finds its
  archive byte-identical. The reason is this section's own two rules. Every sidecar here is written
  once with `flag: 'wx'` and never rewritten, because each says what was true when a run happened,
  while a `Keep` flag toggles and is about the *test* rather than a run; and nothing has ever been
  written above the run level, so a file at the test level would be the first — in a tree whose
  whole claim is that it is what past leases wrote (D24). The identity is the archive's own path
  vocabulary, `list_archive`'s components validated by `ArchivePathSegmentSchema` and parsed by
  nothing (D22), because the thing a sweep would one day come for is the directory. `keptBy` and
  `keptAt` are recorded in that file and on one audit line, never on the wire (D20, D28). The whole
  argument is D33.
- **Retention now has a policy, and this tree is what it deletes from** (§9.4, D34–D36, #238).
  *Edited in place; what this bullet said before is below.* Two host settings bound what may be
  kept — `ROVER_ARTIFACTS_BUDGET_MB` (1024) and `ROVER_ARTIFACTS_MAX_AGE_DAYS` (30) — and whichever
  is reached first is the one that acts.

  **What is deleted is one run directory, whole**: `<project>/<test_name>/<timestamp>-<owner>-<hash>`
  together with its entire `<serial>` subtree, and never anything finer. Not a file, not a
  `screenshots/` folder, not one sidecar: a half-deleted run is one whose `device_info.json` and
  `test_description.json` no longer describe what is beside them, in a tree whose whole claim is
  that it is what past leases wrote (D24). The oldest go first, by the **code-unit order of the run
  directory's own name** — which is chronological order because `<timestamp>` leads and is
  fixed-width UTC basic format (above), so nothing parses a name to work it out and `localeCompare`
  is never called (D34, D22).

  **A test's age is the age of its newest run**, so a test with a run from yesterday is never old
  however much else it holds, and a test that *is* old goes whole rather than losing its oldest
  runs: the two most recent runs under one `test_name` are the before/after pair its non-uniqueness
  exists to give (above).

  **What is never deleted**: a test the operator marked `Keep` (D33, D35), a run whose lease is
  live — matched by the path `leaseRunDirectory` builds, which is the writer's own function — and
  neither of those even to bring the archive under its budget (D36). An archive over budget with
  only those left is a refusal with one log line on the host, and the operator's to resolve.

  **The empty-level cleanup**: a `<test_name>` directory the sweep emptied is removed, and a
  `<project>` directory that leaves empty is removed after it. An empty level is scaffolding rather
  than a record, so it goes — but **the root is never removed**, and nothing above the run level is
  ever deleted while it still holds a run. `ENOTEMPTY` is the ordinary case rather than a failure:
  a lease may have filed a new run between the walk and the cleanup.

  **The disk budget runs on its own; the age limit does not.** Every lease that ends — released
  and expired alike — is followed by a budget-only sweep of this tree (D37, #245), so a host
  nobody types a command on no longer grows past `ROVER_ARTIFACTS_BUDGET_MB`. What has no trigger
  but `rover sweep` and `sweep_archive` is the **age** bound: no timer, no midnight pass, no
  start-up pass, so a tree inside its budget can hold a test past `ROVER_ARTIFACTS_MAX_AGE_DAYS`
  until somebody asks. That half is the one part of §9.4 that is still open.

  **What this bullet said before, and why it was right at the time.** *Retention is undecided —
  without one, this grows without bound on machines that usually have the least disk to spare, and
  it stops being a someday problem the moment a panel is reading this archive on a schedule (D24).
  The `Keep` flag above does not decide it and must not be read as deciding it: it records which
  tests an operator wants exempted from a sweep that does not exist yet. No TTL, no size cap,
  nobody nominated to run the prune, and nothing in this repository deletes an artifact today. What
  the flag does buy is the order — the sweep now cannot ship ahead of the exemption and delete a
  test somebody had every reason to believe was kept.* That order is exactly what happened, and the
  last sentence is the reason this bullet could be replaced rather than argued about: the exemption
  was on disk before anything could delete anything.
