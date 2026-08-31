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
| D9 | **Restoration is forced, not requested** | The predecessor *asked*, in a comment, that state be restored before releasing, and nobody ever checked. The daemon does it itself on release **and** on expiry: stop the app, airplane mode off, wifi back on, stop the project's helper services, then its teardown hook | 2026-08-27 |
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
| D22 | **A lease carries two more explicit, caller-supplied strings: `project` and `test_name`** | `owner` (D16) alone does not give an artifact a findable home: two projects can reuse the same owner string, and "before/after" comparisons need a way to group runs by what they were checking. `project` names which registered project a lease belongs to; `test_name` names the scenario being run and is **deliberately not required to be unique** — running "home screen before changes" and "home screen after changes" as two separate leases with the same-shaped name is the point, not an error case. Both are opaque strings the core never inspects, parses or defaults from context, exactly like `owner` (D20) | 2026-08-29 |
| D23 | **The host durably archives every artifact-producing verb's output, additive to D19's bytes-over-the-wire return** | A screenshot handed to the agent once during a session answers "does it work right now"; it cannot answer "does it still look the way it did before the refactor" unless a copy survives on disk to diff against later. The archive (§10) is a second effect of the same verb call — it changes nothing about what the client receives, and a path into the archive is never a path handed to the agent. D19 keeps holding: artifacts still cross the machine boundary as bytes | 2026-08-29 |
| D24 | **The artifact archive's tree shape is a deliberate, stable surface, built for a future read-only viewer, not just for a human `find`** | A screenshot returned once to whichever client asked for it (D19) cannot later answer "show me what changed" to anyone outside that one session — the archive (§10, D23) exists so it can. This decision is that the directory shape (`<project>/<test_name>/<lease-id>/<device-serial>/…`) is the contract a future web panel (`docs/WEB_PANEL.md`) would read directly off disk — no database, no rewrite of the tree the day that panel gets built. **This does not move the panel into scope now** (§7 still excludes a dashboard) — it only means the archive's shape is not free to casually change once R25 ships, because something will eventually depend on it | 2026-08-30 |
| D25 | **Host authentication becomes named, revocable per-user credentials — one shared secret is retired, not kept as a second path** | `ROVER_HOST_TOKEN` (D20) is one static bearer secret for the whole host: everyone who holds it looks identical to the daemon, nobody can be individually cut off without rotating the secret and re-distributing it to everyone else, and there is no record of who actually holds it. That is fine for one operator bootstrapping a host alone and wrong the moment more than one person or system needs independent, revocable access — exactly what a web panel (`docs/WEB_PANEL.md` item 8) needs. Modeled on Swarm's own operator front door (`../swarm/src/cli/commands/users.ts`, `swarm users add/list/grant-admin/revoke-admin/set-password`): `rover users add/list/revoke/rotate <identifier>`, run **on the host machine itself**, never over the network — an operator tool, not a verb. Each user gets one opaque token, printed exactly once at creation or rotation and never again; only its hash is stored (dependency-free, `node:crypto` scrypt-style, mirroring `../swarm/src/identity/auth.ts`'s approach minus the password/session split a bearer token does not need), in `~/.rover/users.json` beside the already-established `~/.rover/rover.sock` (`src/daemon/socket-path.ts`). **D6 applies here too**: the file is the truth, re-read at every connection's auth check and never cached for the daemon's lifetime, so a revoke takes effect on the very next connection with no restart. D20 is otherwise unchanged: the token still only authenticates, the owner string still only attributes, and a user's identifier is never written into a lease's `owner` field automatically | 2026-08-30 |
| D26 | **MCP tool names stay `snake_case` and their arguments stay `camelCase` — the mismatch is deliberate, and every tool says so** | The tool surface reads oddly: `launch_app` takes `leaseId` and `appId`, so the first call an agent writes from the tool *name* is refused. `snake_case` arguments would look more conventional, and were rejected because of what the declaration **is**: the `IPC_METHODS` params schema handed to `registerTool` is the same object the host parses the request with (ai/CODING_STANDARDS.md boundary #1), so the field names an agent reads are the field names the host's own Zod refusals name (`Required at leaseId`), the CLI's `--json` documents carry, and Swarm will read off the same table. Renaming on the MCP side alone means a translation living in a layer that owns translation only, and one field with two spellings — the second vocabulary D10 refuses for verbs, one layer down. What the mismatch actually costs is a first call written from the wrong half of the declaration, so the fix taken instead is **legibility before the call**, the same move D11 makes for capabilities: every tool's description carries one sentence naming the casing and pointing at the schema (`src/mcp/_shared/declaration.ts`, appended in one place so a tool cannot land without it, gated by `tests/unit/mcp/declarations.test.ts`). The refusal stays loud and names both halves, which is the behaviour this project wants. If this is ever revisited, the thing to change is the **wire**, so both clients and the host move together — never one adapter | 2026-08-31 |
| D27 | **The web panel is in scope and is not read-only — it carries authority over the device pool, and only that** | §7 excluded a dashboard while CLI and MCP were the whole interface, and `docs/WEB_PANEL.md` described a read-only viewer. Both are reversed here, and the thing that forced it is an absence rather than a preference: a stuck lease cannot be ended by anyone but its holder, from any interface, because `release_device` takes the lease id as the holder's credential and D20 deliberately keeps that id out of every listing. So the panel acts. **The rule for what belongs in it: an action is a panel action when it is an authority over the shared pool, not a step in one agent's own work.** Force-releasing a stuck lease is the first — it ends somebody else's lease and must run the same restoration that expiry already runs (D9), which is why it is a new trigger on an existing path rather than a new path. **Acquiring a device is deliberately not in that class**: a lease carries the caller's own `owner` string (D22), an agent signs its own work, and a person clicking a button has nothing to sign with — inventing an owner for them would make the attribution D16 and D20 rest on a fiction, and would hand out a device no agent can then use. Every panel action authenticates as a named user (D25); until a role model exists, every named user may perform every panel action, and `docs/WEB_PANEL.md` records that tiering is an open question rather than an assumed one. The panel is a client like any other (D17, D19) — it runs no adb and holds no device state of its own | 2026-08-31 |
| D28 | **Force-releasing a lease is authorised by reaching the surface, and attributed by a string the caller supplies. The host derives neither from the other** | D20 splits the credential from the attribution, and every lease operation until now fitted inside that split: the holder presents the lease id it was handed, and the `owner` string says whose work it is. Force-release fits neither half — it ends a lease the caller never took, so there is no credential of the holder's for it to present, and handing that id out so there could be is exactly the disclosure `ListedDeviceSchema` refuses (D20). So it is keyed on the **serial**, which every listing already shows, and its authorisation is stated here rather than borrowed. **What authorises it is the reach the caller already has.** A caller on the unix socket is a shell on the host machine, which can already reach every device with `adb` directly and needs no token to do it; a caller over the network is a named user in `~/.rover/users.json`, checked at every connection (D25, R28). That is the same reach `acquire_device` and every verb already grant, and inventing a role for this one row would be deciding a question nobody has asked yet: D25 gives every named user identical reach, and `docs/WEB_PANEL.md` records tiering as an **open** question rather than an assumed one. That file's entry stays open — this decision does not quietly close it, and a read-only tier arriving later restricts this row along with the rest rather than instead of them. **Who did it is a caller-supplied `actor` string, exactly as `owner` is** (D20, D22): the host never derives it from whoever authenticated, because that is the derivation D20 exists to forbid — and the acting user's identity is not their token, which never reaches a record. The record is the daemon's own log line, written on the released path only, with every caller-supplied value JSON-escaped so a newline cannot forge a second line; a durable, queryable audit store is the panel's own row and is deliberately not invented here. **And it is a third trigger on the release path, never a third path** (D9): the handler ends the lease through the same `LeaseStore.release` a normal release calls, so the traffic revocation, the restoration, the archive's bookkeeping and the project's teardown happen by construction. That is also why it landed as its own method rather than as a parameter on `release_device` — the release path is genuinely shared, so a second row costs only a table entry, while a params union of "either a lease id or a serial" would weaken the one sentence `ReleaseDeviceParamsSchema` exists to state. This is D27's first panel action, and the CLI carries it too (D4) | 2026-08-31 |
| D29 | **The browser reaches the host through a third transport of the same surface — one HTTP route, authenticated per request against the same user store, and off unless configured** | The panel has to talk to the daemon and cannot: the network transport authenticates with a length-framed NDJSON greeting consumed before the IPC server is attached (R22), which `fetch()` cannot send. **The answer is a third transport, never a second implementation** (D17): `src/daemon/http-listen.ts` consumes the very `IpcServer` the unix socket and the TLS listener already serve, so every method, every schema and every framing rule stays shared by construction — `tests/unit/ipc/transport-independence.test.ts` now forbids `node:http` and `node:https` inside `src/ipc/` for the same reason it forbids `node:tls`. Six things follow, and each was a choice. **One route, `POST /rpc`**, whose body is the existing request envelope: a route per method would be a second place a method name lives, to be kept in step with `IPC_METHODS` by hand, and with one route an HTTP-only method is structurally impossible. **One request is also one frame**: `IpcServer` consumes NDJSON, so a body that is not a single JSON value is answered by this module rather than handed on — otherwise two envelopes in one body would decode into two frames and dispatch both, with the allowlist having decided about only the first, which is the hole review pass 1 of #118 found and closed. **The panel's login is an `rover users` credential and there is no second one** — `Authorization: Bearer <token>`, hashed and looked up in the store `ROVER_USERS_PATH` names, **re-read on every request and never cached** (D6, D25), so `rover users revoke` bites on the very next request over a keep-alive connection the revoked user is already holding. This settles what `docs/WEB_PANEL.md` left open; no `ROVER_HOST_TOKEN` revival, no panel-only secret, no fallback. **The token is a header, never a URL** (D20) — a URL reaches a browser's history, a proxy's access log and a referrer header — and nothing here logs an attempt, because the only interesting thing to log about one is the token that was tried. **One byte-identical refusal for every pre-auth failure**, and it is literally the bytes the TLS gate writes without its newline, because both come from one `UNAUTHENTICATED_REFUSAL` in `src/ipc/protocol.ts`: a missing, malformed or unknown credential, a revoked user, an unreadable store, a path that does not exist and a method the route does not take are all `401` with that body, so authentication precedes routing and a stranger cannot learn which paths exist. There are therefore exactly **two statuses** — `401` and `200`, *read the envelope* — because `IpcErrorCodeSchema` is already the complete error vocabulary and a second one in the status line is two sources of truth that can disagree. **Only the panel's methods are reachable**, as an allowlist over the one table and never an addition to it: every method still runs on the host either way (D19), so what this protects is D27 — without it an authenticated user could `acquire_device` from a browser tab and drive the phone with the lease id it was handed. **The panel polls; the surface does not push.** `list_devices` answers with `expiresInMs`, a duration (D17), so the countdown ticks in the browser from a value the server sent and re-syncs on the next poll — which is also how activity renewing a lease (D8) makes the number go back up — and reading never renews. So there is no SSE, no WebSocket and no long poll, and therefore no second connection style to build, authenticate or shut down: that single decision is most of what keeps this change small. **And it is off unless configured**: `ROVER_HTTP_PORT` is its own switch, separate from `ROVER_LISTEN_PORT` because exposing a host to a team's Rover clients is not asking for a browser surface, and because a daemon that started listening for HTTP on a developer's machine merely because they upgraded would be a change in exposure nobody chose. It defaults to loopback rather than to every interface, refuses to start unencrypted anywhere a stranger could reach it, and `spawnDaemon` blanks the switch in an autostarted child exactly as it blanks `ROVER_LISTEN_PORT`. No CORS header is emitted anywhere, because the panel will be served from this same listener once serving its assets is taken on — no roadmap row owns that yet (see R33) — and an emitted one would make this surface readable from any page a browser happens to have open | 2026-08-31 |
| D30 | **A browser holds a session, not the token — minted from an `rover users` credential over the surface's own route, ended by a sign-out, and dead on the next request after a revoke** | D29 settled *which* credential the panel presents and deliberately left one layer open: how a **browser** holds it between reloads. It does not hold it at all. `POST /session` takes `{"token": …}`, verifies it against the same `~/.rover/users.json` the gate reads, and answers `{session, identifier, displayName}` with `cache-control: no-store`; the page then presents that session id in the `Authorization: Bearer` header a token goes in today, and a raw token keeps working there unchanged, so R32's `curl` recipe is not a casualty. `GET /session` is the boot probe and `DELETE /session` ends the session **server-side**, which is what makes signing out real rather than a `localStorage.removeItem`. **Why the id and not the token**: the token is also the operator's CLI credential, it never expires on its own, and the only thing that ends it is `rover users revoke`/`rotate`, which ends it *everywhere* — a session is minted for one browser, expires on its own, and is ended by one verb; the token reaches the host once, in a request body, and the browser never stores it. **Each entry binds the user's `identifier` and `tokenHash`, and resolving one re-reads the store** (D6, D25) — so a revoke kills the session on its very next request, on a keep-alive connection the browser is already holding, and a rotate kills it too, which is the only reading consistent with "rotate invalidates the old token". That comes for free rather than from a callback anyone has to remember to fire, and it is *cheaper* than the token path: an identifier and a hash compared, where a presented token costs one `scrypt` per stored record. **Keyed by the SHA-256 of the id, and deliberately not `scrypt`**: `user-token.ts` pays for `scrypt` because a user's token is at rest in a file that can leak, whereas a session id is 256 bits of CSPRNG output living only in this process's memory — there is nothing to brute-force and no file to leak, and a `scrypt` per request would be a cost with no attacker to spend it on; hashing at all is what keeps a live credential out of the daemon's own heap. **In memory, per listener, dying with the daemon**: a restart signs everyone out, which is honest, needs no file, and cannot go stale against the user store — the rejected alternative, a persisted session store, buys only that restart and costs a second credential file to leak. **A route and not an IPC method**: `/session` is this transport's own credential exchange, the analogue of the greeting frame `network-listen.ts` consumes before attaching the IPC server, which is likewise not on `IPC_METHODS`; a `create_panel_session` method would put a raw credential into an envelope layer that has never carried one and would exist on the unix socket, where a browser cannot reach and a session means nothing. **No `Set-Cookie`, no cookie read, and still no CORS**, so the CSRF question D29 said "arrives with the session" does not arrive: a cookie is attached by the browser to a cross-site request whether the page meant it or not, whereas a header the page sets itself cannot be. The cost is stated rather than hidden — whatever the panel keeps the id in is readable by script, so an XSS in the panel reads it, but it reads a credential that expires, that `DELETE /session` ends, and that is not the token `rover users` issued. **Sliding 8-hour idle expiry**, renewed by use the way D8 renews a lease, swept lazily on a mint and on a resolve — no timer to `unref` and nothing holding the event loop open. **The sign-in body is the one pre-auth body this surface reads**, capped at 4 KiB and abandoned rather than drained over it, and *every* failure — no body, an oversize one, one that is not JSON, one that is not `{token: string}`, an unissued token, a revoked user's still-held token, an unreadable store — gets the one byte-identical `401`, because a diagnosis handed to a pre-auth peer is an oracle and `/rpc`'s `malformed_frame` wording may not be reused there. **D20 is untouched**: the identity a signed-in browser is told is its own and nothing else derives from it — no lease's `owner` is ever an authenticated identity. **Amended 2026-08-31, once the browser's half was built** (#119, R34): the id is kept in `localStorage` under one key, `rover.panel.session`, and the sign-in screen is deliberately **not a route** — the panel renders it in place of the router while there is no session, so the "no credential in a URL" half of D20 holds structurally rather than by care. The edges the host's half could not decide, all of them decided by one rule — **the panel never discards a session id without the host's answer, and never reports an ending it did not get**: a stored id the host answers `401` to on the boot probe is *access ended* and is cleared, because a stored id is evidence a session was live; a boot probe that reaches nothing at all **keeps** the id, because an unreachable host has said nothing about whether the session is good, and a daemon that was restarting must not sign anybody out; a sign-out whose `DELETE` reaches nothing **is not a sign-out** — it keeps the id, stays signed in and says the host did not answer, because announcing an ending nobody performed would discard the one credential that could still perform it and leave a live session on the host for the rest of its idle window (a `401` there is finished, since a host that will not take the id has already forgotten it); and a sign-in that replaces an id the boot probe kept presents that id to `DELETE /session` on the way out, ignoring the answer, so a host that has come back reclaims it instead of holding two live sessions for one person, one of them unreachable by any browser. The panel shows one refusal for a `401` and for a host that never answered alike, worded to claim neither the token nor the host as the cause | 2026-08-31 |

---

## 4. The verb set

Working names. All of them take a device handle, and over the wire that handle is the **lease id** — the credential (D20), from which the host derives the serial. A verb call naming a serial beside it would be either redundant or a way for the holder of one device to drive another (D19, R21).

**`force_release_device` is the one exception, and it is the exception that states the rule.** It names the serial precisely *because* the caller has no credential to present: it ends a lease it never took, and handing out the holder's id so it could would be the disclosure D20 keeps out of every listing (D28).

### Devices and leases

| Verb | What it does |
|---|---|
| `list_devices` | What is attached, what is free, whose is what, and what OS version each one runs — for a free device as much as a held one, since no lease is needed to be told (R30) |
| `acquire_device` | Takes a device exclusively; returns a handle and the capability list. Also takes `project` and an optional `test_name` — caller-supplied attribution strings that name the destination in the artifact archive, not application logic (D22, §10). **It also brings up that project's helper services** before it answers (D13, R17 phase 4), so a caller holding a lease has the services that lease implies; one that will not start refuses the grant **by name** (`service-failed`) and hands the lease straight back, because granting a device whose helper services are down is a false yes |
| `release_device` | Hands it back and restores the original state — the applications, the radios, the project's helper services, then its teardown hook (D9). The service stops run with **this** lease's slot, so what they take down is what this grant started rather than one set shared with whoever else holds the project — a contract the hook file keeps by namespacing on `ROVER_SLOT` (R18) and not one the host can check (R17 phase 4) |
| `force_release_device` | Ends the lease **somebody else** holds, keyed on the **serial** rather than on a lease id, and carrying no credential of the holder's (D28). It is a third trigger on `release_device`'s own path rather than a third path, so the restoration is identical (D9). A device nobody is holding is a named refusal and not an error, and the three reasons are distinguishable because they are three different next moves for an operator: `not-held` (here and free), `gone` (this host cannot see it at all any more — D6) and `not-attached` (visible but another machine's, so never leasable — D18). Attributed by a caller-supplied `actor` string, never derived from whoever authenticated; the holder's next verb call is refused `no-lease` |

### Input

| Verb | Notes |
|---|---|
| `tap` | By text or element id; coordinates are the fallback |
| `long_press` | Implemented as a drag in place with a duration |
| `swipe` / `scroll` | |
| `type_text` | Hides the device shell's quoting, so a space, an apostrophe and a shell metacharacter all arrive verbatim. **Non-ASCII it cannot hide — `input text` cannot type it at all** (§6), so the honest answer is a refusal naming the character rather than a silent drop. That refusal is an `unsupported-text` verb failure carrying the serial, the string and the offending characters as escapes, **not** an `internal_error`: the string is the caller's and it is the caller who can fix it (#61). **No target** — an agent taps the field first |
| `press_key` | Back, home, recents, wake. **No target**, so it needs no screen read to aim, which makes it the one input verb provable end to end on hardware before `read_screen` (R13) |

### Reading

| Verb | Notes |
|---|---|
| `screenshot` | The captured image, **as bytes on the result rather than as a path** (D19) — base64, its media type and its byte length, so any file written is the client's own. Needs no capability; a capture over the named size bound is refused by name rather than returned cut short. **The client writes the file** (R24 phase 1): `rover screenshot <lease-id> --out <path>` decodes the bytes, checks what decoded against the byte length the host encoded, writes them on the machine running the CLI and reports `path.resolve` of `--out` — never a host-local path. A refused capture, or one that did not survive the trip, exits 1 and leaves no file at `--out` at all. **A black image is a true answer, not a failed capture** (§6): the check that separates a blocked capture from a broken device is a screenshot of the system home screen, and `read_screen` is the read that survives the block |
| `read_screen` | Texts and element rectangles. **Works even when the app blocks screenshots**. Declares `canReadScreen` as a requirement, so a backend without it fails by name before anything is dispatched rather than answering with an empty screen (D11) |
| `record_video` | A recording of the screen, **as bytes on the result rather than as a path** (D19) — base64, `video/mp4` and its byte length, exactly where `screenshot`'s capture rides. **The recording is provably finished before it is pulled**: the backend waits on a condition for the recorder to be gone, then pulls, then checks the container index on the bytes that actually arrived. A recording without that index was still being written when it was copied and is not a shorter video but a file no player will open, so it is refused as `unfinished-recording` naming the device and the byte length — never handed over, and never an `internal_error` (§6). Declares `canRecordVideo` as a requirement, so a backend without it fails by name before anything is dispatched rather than answering with a null artifact (D11). Duration is bounded by what **one answer** can carry (15 s; the default is 5 s), and going over the artifact bound is the same `artifact-too-large` refusal `screenshot` gives rather than a file cut short — a longer recording is R24's chunked transfer. **The client writes the file** (R24 phase 1): `rover record <lease-id> --out <path> [--duration-ms <n>]` writes the video on the machine running the CLI, on the same two modules `screenshot` uses, and raises its own request timeout past the recording so a long one cannot surface as a hang. An `unfinished-recording` refusal leaves no file at `--out`. **The answer also carries frames sliced from the finished recording** (`result.frames`): PNGs in recording order, scaled down and extracted on the **host** after the pull — never sampled during capture and never a second pass over the device. Extraction uses `ffmpeg` from `PATH`; a host without it refuses as `frame-extraction-unavailable` rather than returning an empty list, and no path in the extractor ever answers with an empty one — a decoder that exited cleanly having written nothing is `frame-extraction-failed` too. Frame count, frame width and total frame bytes are bounded; going over the byte budget is `frames-too-large` carrying both numbers, and the count bound — one above the longest recording at the densest sampling, since sampling rounds up — is enforced as a refusal too, because a capture of a still screen declares a longer timeline than it was asked for and can reach it (§6). The CLI exposes both knobs: `rover record <lease-id> --out <path> [--duration-ms <n>] [--frames-per-second <n>]`, each bounded before the call, and the command answers with both the video and the frames or with neither. **What frames are honest about is §8**: they sample motion. |
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

iOS is not being built now, but the code has to accept it without a rewrite. The seam does **not**
run along "adb versus simctl" — it runs along the device interface: enumeration, lifecycle,
installation, app control, screenshot, hierarchy read, input, the **system-log read**, and the
**two file transfers**.

Some things worth knowing now, so as not to design into a corner:

- **`simctl` can neither tap nor dump a hierarchy.** It can do screenshots, installation and
  lifecycle. Input and tree reads need `idb` or WebDriverAgent — a heavy dependency with a
  lifecycle of its own.
- **Semantic screen reading has no cheap equivalent on iOS.** On Android it is the one capability
  that survives a screenshot block. On iOS it may not be possible at all.
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
- **A recorder somebody else started on the same device makes the wait time out.** The probe asks
  whether *any* `screenrecord` is running, because matching a particular one would mean matching a
  pid this code never learned. That is a `wait-timeout` naming the pids that were there, rather
  than a lease held until it expires — and no pull, because the file under it is one somebody else
  is still writing.
- **The pull is `exec-out cat`, never `shell cat`**, for the reason the hierarchy dump already
  records above: `adb shell` may put a pty in the path and a pty translates every `0x0a` in a
  binary payload, conditionally on version, platform and whether stdin is a terminal — so a
  recording that survives on one machine is corrupt on the next.
- **The scratch path is fixed (`/sdcard/rover-recording.mp4`) and made exclusive per device**, the
  way `uiautomator`'s dump path is: two overlapping recordings would otherwise share one file and
  corrupt both. It is removed **before** the recording as well as after, so a leftover from a run
  that died before its cleanup can never be the file that is pulled.
- **Encoded at 2 Mbps rather than `screenrecord`'s 20 Mbps default.** A 3-second recording of a
  static home screen came to 62–64 KB; the rate is what ties `MAX_RECORDING_MS` to
  `MAX_ARTIFACT_BYTES` — 15 s × 250 KB/s ≈ 3.6 MiB against a 4 MiB bound — and the relationship is
  asserted in `tests/unit/backends/android/backend.test.ts` rather than left to drift.

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
| R8 | Leases | Granted per device (D7), the owner an explicit string (D16), a 20-minute TTL **renewed by activity**, not by a heartbeat (D8). **A test with five concurrent clients yields exactly one winner** — the predecessor let four through. Only devices physically attached to the host are ever granted a lease (D18). The lease additionally carries `project` and an optional `test_name` (D22) — two more explicit, caller-supplied strings, never inspected or defaulted by the core | R7 | L |
| R9 | State restoration | Stop the app, airplane mode off, wifi back on, the project's helper services, the project hook. **A test proves the teardown runs on the expiry path too**, not only on `release` (D9). Split in two: the backend's network primitives landed first (#9) so the routine has something real to drive, and §6 records why it must set both radios explicitly with **wifi last** | R8 | M |
| R10 | CLI: `list`, `acquire`, `release`, `status` | Readable by a human and scriptable. This is the interface everything above is debugged through (D4). The host is named by a flag; no flag means the local host | R8 | S |
| R11 | Verb layer foundation | Target resolution from a **fresh** read inside the verb, waiting on a condition with a timeout, returning the state after the action (D12). **There is not a single `sleep` in the repo** — enforced by a lint rule or a test. A timeout says what it waited for and what it found instead. A verb's result is serializable — the host will execute it, not the client (D19, R21) | R5, R8 | L |
| R21 | Host-side verb execution | The daemon loads the core; the CLI and MCP call verbs over the same surface as leases (D19). **No adb in a client process** — checkable by a test. This row stands ahead of the verb families deliberately: changing the execution model after they are written is a rewrite of six files instead of one | R11 | L |
| R22 | Host network listener and authentication | TCP with TLS alongside the local socket, **the same surface, a second transport** (D17). The host token authenticates, the owner string attributes — **two separate fields, and a test proves the token never becomes the owner nor reaches a log** (D20). A refusal does not reveal what the host has attached | R21 | L |
| R27 | Host user store + `rover users` CLI | A local, host-only credential store (`~/.rover/users.json`, one record per user: identifier, display name, token hash, created-at) and a `rover users add \| list \| revoke \| rotate <identifier>` command that manages it (D25). Dependency-free, `node:crypto`-only hashing. `add` and `rotate` print the raw token **exactly once**; it is never stored, logged, or printed again, and `list` never prints a token or its hash. **This command touches the file directly and never goes over the network or through the daemon** — it runs on the machine holding the instance, not for a remote caller | R10 | M |
| R28 | Network listener authenticates against the user store, retiring the single shared token | `network-listen.ts`'s greeting check stops comparing against one `ROVER_HOST_TOKEN` and instead hashes the presented token and looks it up in R27's store, **re-read at every connection attempt** — never cached for the daemon's lifetime (D6, D25). `ROVER_HOST_TOKEN` and the listener-side schema fields tied to it are removed, not kept as a parallel path. A revoked user is refused on their very next connection attempt, with the daemon already running — no restart. The client side (`network-connect.ts`) is unchanged in shape: a client still presents one opaque token in the greeting, and only what that token has to be — one issued by `rover users add`, not a fixed shared secret — changes | R27, R22 | M |
| R12 | Input verbs | **Done** (#12, #60, #61). `tap`, `long_press`, `swipe`, `scroll`, `type_text`, `press_key`. `long_press` as a drag in place — **not** `keyevent --longpress` (§6) — held past the device's own `secure long_press_timeout`, which is configuration rather than a constant. `type_text` hides the device shell's quoting. Split the way R9 and R16 were, into three: the backend's four **primitives** landed first (#12 phase 1) — `tap` / `swipe` / `typeText` / `pressKey` behind `canInput`, with the dp→px conversion and the text limits §6 records — then the four **gesture verbs** over them (#60 phase 2), `tap` / `long_press` / `swipe` / `scroll`, each on the R11 spine with its own `IPC_METHODS` row; `type_text` and `press_key` closed it (#61), both on the spine with **no target**, and with the backend's text refusal given a wire shape of its own rather than left as `internal_error` | R21 | M |
| R13 | Read verbs | `screenshot`, `read_screen`, `device_info`. `read_screen` works with screen capture blocked and **is a declared capability, not a required method** (§5). Split the way R12 was, into three: the backend's **primitive** landed first (#13 phase 1) — `readScreen` behind `canReadScreen`, the two-command dump recipe of §6 mapped onto `ScreenElement[]` in dp — which is also what flipped the last `false` in the Android manifest and so turned on every path already written against it: after-states, targets by text, and both waits. Two of the three read **verbs** landed second (#67 phase 2) — `read_screen` and `device_info`, one module on the R11 spine with an empty action, because a read verb's work *is* the spine's own capture; `read_screen` carries `requires: ['canReadScreen']`, which is what turns a backend without the capability into a loud failure before dispatch instead of the softer `after: { kind: 'unavailable' }` an unrequired verb would answer, and `device_info` needs no capability because its answer is the `DeviceInfo` D14 puts on every result. `screenshot` landed third (#68 phase 3): the one read that cannot answer in that shape, because pixels are bytes rather than a state the result already carries. It is on the same spine with `requires: []` — the backend method is required, not capability-gated — and what it adds is one nullable `artifact` on `ActionResult` carrying base64, a media type and a byte length, required-and-nullable because `undefined` does not survive JSON. `MAX_ARTIFACT_BYTES` (4 MiB) is derived from the 8 MiB frame cap with base64's inflation accounted for, and going over it is an `artifact-too-large` failure naming both numbers rather than a truncated image. R13's last acceptance criterion — a black screenshot stays distinguishable from a broken device — is documented on the verb and in README.md rather than asserted, because it takes a known screen: the check is a capture of the system home screen, and `read_screen` is the read that survives a capture block (§6). The transfer contract around the bytes is R24 and the durable archive is R25 | R21 | M |
| R14 | `record_video` + slicing into frames | **Done** — phase 1 (#14) the recording, phase 2 (#82) the frames. The recording must finish before it is pulled — a file pulled earlier has no `moov` atom and cannot be read at all. Split the way R12 and R13 were, except that the primitive and the verb over it are **one phase** here: `recordVideo` is a method nothing but this verb would ever call, so landing it alone would ship a dead method and a capability flag declaring an ability no caller can reach. So phase 1 is the whole lifecycle — `canRecordVideo` as a declared capability rather than a required method (§5, D11), `recordVideo(serial, { durationMs })` answering with **bytes and never a host path** (D19), the `record_video` verb on the R11 spine with `requires: ['canRecordVideo']`, one `IPC_METHODS` row and one daemon handler, and the recording on the existing `ActionResult.artifact` so no second answer shape was needed. The Android half is §6's measured recipe: `screenrecord` to a fixed device-side scratch path made exclusive per device, completion detected by `waitForCondition` polling `pidof` until the recorder is gone — **a condition with a timeout, never a sleep** (D12(b)) — then `exec-out cat`, then a top-level MP4 box walk requiring `ftyp` first and a `moov` present, then `rm -f` in a `finally` that runs on the refusal paths too. A pull without a `moov` is an `unfinished-recording` verb failure naming the device and the byte length rather than an `internal_error`. `MAX_RECORDING_MS` (15 s) is derived from `MAX_ARTIFACT_BYTES` against the backend's 2 Mbps, and the relationship is asserted rather than left to drift; over the artifact bound is still `artifact-too-large`, never a truncated file. R24 (chunked transfer) and R25 (the durable archive) were unchanged by that phase. **Phase 2 added the frames** on `RecordVideoResultSchema = ActionResultSchema.extend({ frames })` — the `ReadLogsResultSchema` pattern, so the recording stayed on `artifact` and one field was added — with `RecordVideoCallResultSchema` on the row and `runVerb` already generic in the `ActionResult` subtype. The extraction is a host tool (`ffmpeg` off `PATH`, §6's measured recipe: the recording on stdin, PNGs on stdout, **no host temp file**, an explicit stdout bound and an explicit timeout), and it lives in `src/daemon/frames.ts` rather than in the verb layer because `src/ipc/verb-methods.ts` imports the verb schemas — a spawn under `src/verbs/` would be `node:child_process` in every CLI's module graph. So the verb declares a `FrameExtractor` and the daemon supplies it, the way it supplies the backend, and `tests/unit/no-backend-in-a-client.test.ts` walks the graph to keep that a fact. Three named failures, all data rather than `internal_error`: `frame-extraction-unavailable` (the branch for a decoder that never started), `frame-extraction-failed` carrying the exit code and the stderr, and `frames-too-large` carrying the count and both byte numbers. `MAX_FRAMES_BYTES` (1.5 MiB) is derived from the frame cap with the recording's own base64 share accounted for, `MAX_FRAMES` from `MAX_RECORDING_MS` × `MAX_FRAMES_PER_SECOND` **+ 1** — `fps=n:round=up` fills slots `0…duration × rate` — and both derivations are asserted rather than left to drift. That one is a bound a real call reaches rather than a guard: §6 measures a 15 s capture of a still screen declaring a 27.61 s timeline, and the sampling follows the container. So the decoder is given `MAX_FRAMES + 1` on `-frames:v` — the flag exits 0 when it bites, so a cap passed straight to it is a list silently cut short — and an overrun is a named refusal, and `FRAME_EXTRACTION_TIMEOUT_MS` lives beside the other verb-layer bounds in `src/verbs/record.ts` rather than in the runner, because `rover record`'s own request timeout has to cover it and a client may not import a daemon module. R24 and R25 are unchanged by phase 2 as well | R13 | S |
| R15 | App verbs | `install_app`, `launch_app`, `stop_app`, `clear_app_data`, `read_logs`, `pull_file`, `push_file`. `read_logs` is to catch a failure a screenshot will not show. Split the way R12 was, into three: the **app-lifecycle verbs** landed first (#15 phase 1) — `launch_app` / `stop_app` / `clear_app_data`, each on the R11 spine over a backend primitive that already existed, sharing one `IPC_METHODS` params schema, with `requires: []` and no target because an app id addresses a package rather than something on the screen; `read_logs` landed as phase 2 (#69) — a required `DeviceBackend.readLogs`, a log parser with captures of its own, and the first verb whose answer carries a payload beyond `ActionResult`, which is what factored `VerbCallResultSchema` into `verbCallResultOf()` and made `runVerb` generic for phase 3 to reuse; `install_app`, `pull_file` and `push_file` landed as phase 3 (#70) — the transfer half, and a byte-transfer concern (R24) rather than an app-lifecycle one: two required `DeviceBackend` methods (`pushFile`, `pullFile`), a `MAX_TRANSFER_BYTES` cap (4 MiB) enforced in the params schema so an over-sized call is `invalid_params` naming the limit rather than a frame the host allocates, and the host temp file the two inbound rows need written and removed by the daemon's handler in a `finally`. `pull_file` answers on `ActionResult.artifact` like `screenshot` rather than in a shape of its own, so its result carries no path at all. **`install_app` was unexercised against a device when this row landed** — there is no APK in this repository, the same constraint `tests/device/android/app-control.test.ts` records — and **R24 phase 2 (#85) closed that gap**: a real 29 487-byte APK installed end to end through `rover install`, confirmed by `pm path` moving to `/data/app` (§6, 2026-08-30). What was already established is the piece adb decides before the device is involved: `adb install -r` refuses a file whose name does not end `.apk`/`.apex` with `filename doesn't end .apk or .apex`, and takes the same bytes once renamed (§6), which is what `withInstallablePackage` exists for. Everything else about the verb — the decode, the host temp file and its removal, the size refusal — is still covered over a stub backend, and the automated suite carries no APK | R21 | M |
| R16 | Environment verbs | **Done** (#9, #16). `set_airplane_mode`, `set_wifi` through `cmd connectivity` and `cmd wifi` — **not** through `svc`, which is gone (§6). Both paths without root. Split in two: the **primitives** landed with R9's first phase (#9) — `setAirplaneMode` / `setWifiEnabled` on the Android backend, behind `canControlNetwork` — and the **verb layer** over them landed second (#16), one module on the R11 spine, two rows sharing one `IPC_METHODS` params schema (a lease id and a required `enabled` boolean, so "turn wifi off" and "say nothing" cannot be the same call), no new backend method and no new answer shape. It is the first family whose `requires` names a capability that is not always true — `['canControlNetwork']`, reached through `capabilityMethod()` rather than `context.backend.*`, which is what turns a backend without the toggles into a `missing-capability` failure naming capability, device and backend before anything is dispatched (D11) instead of a toggle that reported success. Both answer with a null `target`, because a radio is not something on the screen, and with the state after themselves (D12(c)) — the spine's own capture, which is evidence the device was still answering and **not** a reading of the radio: `DeviceBackend` still has no network getter, and §6 records the two reads that would be one. These drive the same two backend methods R9's restoration drives, which is what keeps the two callers from drifting: one recipe per toggle, in one backend, with a second caller rather than a second path | R21 | S |
| R24 | Artifact transfer across the machine boundary | **Done** — phase 1 (#24) the client writes the bytes it is handed, phase 2 (#85) the three file verbs from the client. Screenshots, recordings and pulled files come back as bytes; **a path returned to the agent exists on the agent's machine** (D19). In the other direction: `install_app` and `push_file` send a file to the host. The recording from R14 finishes on the host before the transfer, not during it. The size limit is explicit and named, and does not announce itself as a truncated file. **Phase 1** (#24) was the *client* half, proved with the two verbs that already produce bytes. The host half was already there (`ArtifactSchema` is base64 and never a path; `MAX_ARTIFACT_BYTES` is checked before encoding and refused as `artifact-too-large`; R14 proves a recording finished before it is pulled), and what was missing was the other end of the wire: no client had ever decoded an artifact. Two shared CLI modules — `src/cli/_shared/artifact.ts`, which decodes, checks the decoded length against the host's own `byteLength`, writes the bytes **here** and answers `path.resolve` of `--out`; and `src/cli/_shared/verb.ts`, which renders a `VerbCallResult`'s three branches and picks the exit code — under `rover screenshot` and `rover record`. `--out` is required, so the CLI invents no naming policy. The write is the last thing that happens and only on the `ok` branch, so `artifact-too-large`, `unfinished-recording` and a decoded length that disagrees with the host's all exit 1 leaving **no** file at `--out` rather than a short one. `record` raises its own request timeout past the 15 s recording bound. Neither module branches on `--host`, and `tests/unit/cli/remote-host.test.ts` asserts the remote path writes the same bytes to the same kind of local path as the local one. **R15 phase 3 (#70) landed the host half of those three file verbs, and with it both caps this row lifts**: `MAX_TRANSFER_BYTES` (4 MiB) inbound and `MAX_ARTIFACT_BYTES` (4 MiB) outbound, derived from the 8 MiB frame cap with base64's inflation accounted for, and both refusing by name rather than truncating. **Phase 2 done** (#85) — those three verbs from the client, and the first time bytes travel *toward* a host. `rover pull` is phase 1's writer with a device path added, because `pull_file` answers on `ActionResult.artifact` exactly where `screenshot` does, so it reuses both shared modules unchanged. The direction that was new is the upload, and it is one module: `src/cli/_shared/upload.ts` — `resolveSource` resolves the path and stats it, refusing a missing file, one this process cannot read, one that is **not a regular file** and one over `MAX_TRANSFER_BYTES` as a `UsageError` (exit 2, with the command's own usage, naming the file, its real size and the limit); `readPayload` reads and base64-encodes it. **The size comes off `stat` and never off the buffer**, which is the same reasoning `src/verbs/files.ts` records for handing `MAX_ARTIFACT_BYTES` *down* to `pullFile` rather than checking on the way back — a refusal issued after the bytes are in the heap has already cost what it was meant to prevent. Both happen **before `connectToHost`**, so the acceptance criterion is assertable rather than argued: when a source is refused the backend mock records no call at all, which is what "nothing partial was sent" means here. Exit 2 rather than the 1 reserved for a host that said no mirrors `boundAttribution` — the value is the caller's and decidable before any connection. `deliverTransfer` renders the outbound direction's answer, built from what the host said and never from the call, so `--json` structurally cannot echo the payload. `rover push` and `rover install` take a `<local-path>` and `install_app` takes no device path at all, because the package is on the caller's disk (D19). The round trip is asserted over a payload that is **not** valid UTF-8, since a decode in the middle is the silent corruption this path invites, and once more over `--host remote` because one code path serves both hosts. The manual run against a real device is what covers `install_app`, and it is the run that finally exercised it: a real 29 487-byte APK installed through `rover install`, plus a byte-exact 100 000-byte push/pull round trip and all three client-side refusals (§6, 2026-08-30). **The automated suite still carries no APK**, so `install_app` is covered there only over a stub backend. What is left after this row is the **mechanism** — chunking, resumption, streaming — which has to land underneath those verbs without changing their contract. The number that says why: a real APK is routinely tens of megabytes (the one used to check the install recipe was 45 MB), so `install_app` today moves a small package and refuses a large one | R13, R14, R15 | M |
| R25 | Durable artifact archive on the host | **Done** (#27). Every verb that produces a screenshot, a recording, or a log pull additionally writes it into `<project>/<test_name>/<lease-id>/<device-serial>/…` on the host (D23, §10), alongside a `device_info.json` snapshot per lease-device pair (D14). **An absent `test_name` falls back to a single fixed directory name**, so the tree shape never varies. **The archive path is never the one returned to the agent** — R24's bytes-over-the-wire contract is unchanged by this row. Retention (a TTL or size cap, and who prunes) is explicitly out of scope here — see §9.4. The write lives in `src/daemon/verb-handlers.ts`'s shared preamble rather than in `src/verbs/`, for the reason `src/daemon/frames.ts` does: `src/ipc/verb-methods.ts` imports the verb schemas, so host filesystem work under `src/verbs/` would be host behaviour inside every client's module graph (D19). Unlike the frame extractor it needed **no seam in the verb layer at all** — no verb signature, verb option or result schema changed, because the daemon already holds the lease and the finished result together — which is also what makes "the archive path is never returned" structural: `src/ipc/server.ts` parses every answer against that row's `.strict()` schema, so a path on a result would be `invalid_result` before it left the host. Two modules: `src/daemon/archive-path.ts` (where the root is — `ROVER_ARTIFACTS_PATH`, empty counts as unset — and how an opaque caller string becomes one path segment, §10's sanitising rule with the collision suffix) and `src/daemon/archive.ts` (the write, one `switch` on the verb for the three payload kinds). `Lease` gained one host-local field, `createdAtMs`, because the directory name has to sit where the run *started* and `use()` pushes `expiresAtMs` forward on every call. Sequence numbers are per lease and per kind, allocated **synchronously before any await** — a holder can fire two verbs down one connection — and dropped by `ArtifactArchive.forget` off the lease store's existing end hook, so the daemon does not grow with the number of leases it has granted. `record` **never throws**: a full disk or an unwritable root is a `console.warn` naming the path, and the verb answers exactly as it would have, which is what makes the archive additive rather than substitutive. `StartDaemonOptions.artifactsRoot` is **required** rather than defaulted, for the reason `network` is never read from `process.env` there: a unit test must not write into the developer's own `~/.rover/artifacts`. Retention is still §9.4's, and the follow-up row is filed now that this has shipped | R8, R13, R14, R15, R24 | M |
| R17 | Project hooks (D13) | A Zod schema: the install command, helper services, teardown. **The core knows no application's name**, and a default value that mentions one is a bug. The schema also carries the `project` identifier consumed by R25's archive (D22), so it is set once per project instead of retyped by every caller. **Done in four phases** (#17, #94, #95, #96) — the hook file and the one consumer this repository had already built a seam for, then the client-side `project` default, then the install command, then the helper services; each field landed with its consumer, because a field without one is a row in the catalogue describing something nothing reads (`ai/RULES.md` §7). What landed: `src/daemon/project-hooks.ts`, the Zod source of truth for `<project>.json` under `ROVER_PROJECTS_PATH` (`~/.rover/projects`, empty counts as unset), carrying `project`, `apps`, `install`, `services` and `teardown`, mirrored row for row in `README.md`. The empty file parses to `apps: []` and no hooks at all, asserted — that is the executable form of "a default that names an application is a bug". The file lives on the **host** (D19: verbs run where the hardware is, and D19's own reasoning names the project hooks as the thing that must not be stranded on the far side of the network); it is never accepted over the wire, and it is re-read at every use and never cached (D6), so an edit bites on the next lease that ends with nothing restarted. **The identifier shape is the traversal guard**: a `project` string that is not `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` resolves to no hooks, and no path is built from it at all — not a sanitised one, which is the difference from §10's archive segments, where an opaque string has to *become* a directory. A file whose `project` field disagrees with its own name is a loud refusal naming both, so a copied file cannot quietly serve the wrong project. Three modules rather than one, and the split is load-bearing: `project-hooks.ts` only reads and parses, so anything may import it; `hook-command.ts` is the only one that spawns (`shell: false`, an 8 s bound asserted to sit under the restorer's 10 s rather than left to drift, a stderr **tail**, `ROVER_PROJECT` and `ROVER_DEVICE_SERIAL` in the child's environment, a named `HookCommandFailedError`). The run ends on the child's own `exit`, never on `close`, which is what makes that 8 s a bound at all: `close` waits for the *pipes*, and the ordinary teardown that backgrounds a helper leaves a grandchild holding them with nothing left to kill it — so the hook would exit 0 in milliseconds and be reported ten seconds later as one that never finished, with the promise and its two pipes retained for the daemon's lifetime; and `project-resolver.ts` joins them. It sits beside `frames.ts` under `src/daemon/` for that module's reason and one more — `restore.ts` is imported by `lease-handlers.ts`, so a spawn there would trip `remote-never-spawns.test.ts`. R9's `ProjectResolver` seam widened in exactly two ways: **async**, because it reads a file now and a synchronous read would block the daemon's event loop for every other connection, and **given the serial**, because a teardown that cannot name the device it is undoing is the wrong shape for the phases after this one. Its existing containment is unchanged, which is what makes one unparseable file cost that project's own steps and nothing else. `StartDaemonOptions.projectsRoot` is **required** and resolved from the environment only in `main.ts`, for `artifactsRoot`'s reason and more sharply: a `startDaemon()` in a unit test must not start running commands out of the developer's own `~/.rover/projects`. The headline criterion is proved end to end over a real hook file and a real child process, on **both** paths a lease can end (D9, R9) — a `release_device`, and a swept expiry with nobody left to ask. **Phase 2** (#94) added the other side of the identifier: `ROVER_PROJECT_FILE`, a client-side variable naming **one** hook file, whose `project` becomes the default for `rover acquire`'s `--project` and the MCP `acquire_device` tool's `project` argument (D22) — set once per project instead of retyped per call. Convenience only, and the boundaries are the point: the wire is untouched (`AcquireDeviceParamsSchema` is not edited, `project` stays a required opaque string the core never inspects), `owner` is still never derived from anything (D16, D20), and nothing is searched for — one explicit path, no walk up from `cwd`, no `.rover/` convention. Both clients resolve it the same way through one reader in `project-hooks.ts`, which is what phase 1's spawn-free split bought: a client imports it without tripping `no-backend-in-a-client.test.ts`. Two shapes are load-bearing. The MCP tool's optional variant is **derived** — `AcquireDeviceParamsSchema.partial({ project: true })` — and chosen only when a file is configured, because the SDK validates a call against the *declaration* before the handler runs: a hand-written second copy would drift, and an always-optional declaration would lie to the agent about what it must supply. And a configured file that is missing or will not parse is a loud failure naming the path — exit 2 from the CLI, a startup death on stderr for the MCP server, before any tool is advertised — never a silent fallback, because the quiet version of that is a lease attributed to nothing, which is the failure D20 and D22 exist to prevent. **Phase 3** (#95) added the install command and the verb that runs it: `ProjectHooksSchema` gains an optional `install` (the same `HookCommand` as the teardown, with no default naming anything — the empty file still parses to no install, asserted), and `InstallAppParamsSchema.packageBase64` becomes **optional**, so one verb answers two ways and the schema says which arrived — a call carrying bytes is unchanged in wire, bound and result, and a call carrying none runs the lease's project's install on the host with `ROVER_DEVICE_SERIAL` set to the leased device, which is the pinning that keeps an install off a neighbour's hardware (§2). The verb layer still never spawns: `src/verbs/files.ts` declares a `ProjectInstaller` seam and `src/daemon/project-install.ts` fills it, the `FrameExtractor` split exactly, because `src/ipc/verb-methods.ts` imports the verb schemas and a `node:child_process` under `src/verbs/` would land in every client's module graph. Three **named** failures rather than `internal_error`, because each is a different next move: `project-not-registered` (send the bytes, or have the project registered), `install-hook-undeclared` (the file is there and declares no install — an `ok` here would report an install that never ran, and a default command would be the core naming an application), and `install-hook-failed` carrying the exit code, the signal and a stderr tail, since a non-zero exit is data and only the stderr says why a build refused. `HookCommandFailedError` gained one field, `outcome`, so the runner's own words for how a run ended survive into that answer — an exit, a kill at the bound and a program that never started are indistinguishable from a null exit code. The bound is `INSTALL_HOOK_TIMEOUT_MS`, five minutes, and it lives in the **verb layer** for `FRAME_EXTRACTION_TIMEOUT_MS`'s reason — a client has to see it and cannot import a daemon module (D19) — with both of its relationships asserted rather than described: under `LEASE_TTL_MS` (D8: the lease is renewed when the call arrives, so an install that outlived it would have the sweep fire restoration on a device the install is still driving) and inside `MAX_VERB_TIMEOUT_MS`, and above the teardown's 8 s because a build is not a stop. It is a verb a caller asks for and never runs at grant time. Byte-transfer limits are untouched: `MAX_TRANSFER_BYTES` and `MAX_ARTIFACT_BYTES` are R24's row. Proved end to end over the real socket against a **real hook file and a real child process** — the marker the hook writes carries the project and the serial it was told — with the three refusals and the untouched bytes path asserted beside it. **Both clients now ask for it** (#104, which is where that gap was closed): `rover install <lease-id>` with the `<local-path>` left off is the byte-less form, and `install_app` is an MCP tool declared as `InstallAppParamsSchema.omit({ packageBase64: true })` — the project form and no other, so an agent cannot paste an APK into a JSON argument. Both clients raise their own request timeout to `INSTALL_HOOK_TIMEOUT_MS + DEFAULT_REQUEST_TIMEOUT_MS`, which is the relationship this row's five-minute bound was written down for. Neither client decides whether the form is *available*: an omitted package is simply a key missing from the request, so `project-not-registered` and `install-hook-undeclared` stay the host's named answers at exit 1 (or `isError`) rather than a usage error a client invented about the wrong machine's configuration. **Phase 4** (#96) added the helper services, the last third of D13's hook set: `ProjectHooksSchema` gains `services`, a bounded list (at most eight) of named entries each carrying a `start` hook command and an optional `stop`, on the same `HookCommand` shape — the empty file still parses to no services, asserted, and `stop` is optional because a container started with `--rm` has nothing for the host to stop. The name shape is narrow for the reason the project identifier's is, minus the traversal half: nothing is looked up by it, but it is **quoted back to whoever was refused a device**, so a newline in one would be a hook file writing its own lines into a client's terminal. `src/daemon/project-services.ts` starts them inside `acquire_device`, in declaration order, **after** the re-verification and the previous lessee's restoration and **before** the grant is answered; a start that fails refuses the grant through one new reason in the existing vocabulary — `service-failed`, carrying the service's name and the program's stderr tail — stops in reverse whatever that grant had already brought up, and releases the lease it took, so the device is free for the next caller rather than held by a grant that did not work out. A hook file that will not parse refuses a grant the same way, which is a **behaviour change worth stating**: before this, such a file only warned when a lease ended; now it also blocks grants on that project, because a file the host cannot read is a file whose services it cannot start, and the alternative is a lease on a device nothing was started for. That start is the one awaited step **below** the store's synchronous insert, and both of `lease-handlers.ts`'s ordering rules survive it: exclusivity is settled by then, so no second grant can interleave, and the start never throws, so nothing past the insert can turn into `internal_error` and wedge the device for a TTL. It cannot move above the insert either — a caller about to be refused `held` would otherwise start, and then stop, the services of whoever actually holds the device. The whole phase is bounded by `SERVICE_START_TIMEOUT_MS` (20 s, each command capped by whatever is left of it), stated against the client's 30 s `DEFAULT_REQUEST_TIMEOUT_MS` because `acquire_device` is the one call no client raises that for, and a grant answered after the caller gave up holds the device for a full `LEASE_TTL_MS`. The **stopping** half is the restoration's and reaches the device through the resolver that already answers the teardown, one read of the file for both: the stops run ahead of `teardown`, in the reverse of declaration order, each contained by the existing `step()` and bounded by `TEARDOWN_TIMEOUT_MS`, on **release and on expiry alike** (D9). They are unconditional, the way the app and radio steps are, so a `stop` must tolerate a service that is not running. What a grant started is tracked per lease and dropped on the lease store's end hook beside `ArtifactArchive.forget`, so the host does not grow with the leases it has granted. **No port field and no allocation** — that is R18, which landed first (#18), so a service's `start` and `stop` go through the same `runHookCommand` and are told the lease's slot for free. That slot is what makes the stops correct per **lease** rather than per project: two devices can be leased for one project at once, both grants run the same declared commands, and a `start`/`stop` pair namespacing by `ROVER_SLOT` brings up one instance per lease and takes down its own. A pair that ignores it addresses one shared instance instead, and then the first lease to end takes it away from the other — the project's contract to keep, stated in `README.md` where the file is written, because these are opaque commands and the host cannot read one and tell which shape it is. The **refusal path shares the 20 s too, its rollback stops included**: a fresh per-command bound there would let a project with several slow `stop` commands answer `service-failed` after the client's 30 s had already turned it into an opaque host error, losing the one thing a named refusal is for, so one deadline is taken before the first start and a stop with nothing left of it is warned about rather than spawned. Health checks, readiness probes and restart-on-crash are out of scope too, which is why a start must be a start rather than a wait for readiness. Proved over a real hook file and real child processes on both paths a lease can end, plus over the real socket for the refusal | R9 | M |
| R18 | Per-slot helper service port allocation | **Done** (#18). No race, with recovery after an orphaned slot. The precondition for parallel work with more than two devices. A **slot** is a live lease's numbered parallel position on this host, and the ports follow from its index by arithmetic — `SLOT_PORT_BASE + index * PORTS_PER_SLOT`, in `src/daemon/slots.ts`. Load-bearing choices, in the order they matter. **The slot lives on the `Lease` record**, not in a second table keyed by lease id: its lifetime is exactly the lease's, every consumer already has the lease in hand, and a parallel table is precisely the second piece of state that can fall out of step with the set of live leases (D6). The store carries it and reads nothing out of it, the way it treats `owner`, `project` and `testName`, and `use()`'s spread carries it through a renewal — asserted, because a renewal that dropped it would silently unport every later hook. **The allocation sits inside the same straight-line section that makes a grant exclusive** (`lease-handlers.ts`), immediately before `leases.acquire` and after the one thing on that path that can throw, so two concurrent grants cannot both be given one block for exactly the reason they cannot both be given one device — R8's guarantee, bought a second time rather than reinvented — and a grant refused because somebody holds the device hands its slot straight back, still with no `await` in between. Proved by R8's own five-client test in a second costume: five clients on five different devices, all held at a barrier inside `describeDevice` (the grant path's only `await`) so every one is provably past it before any reaches the store, get five distinct indices and five disjoint port ranges. **Every lease gets one, hooks or no hooks**: deciding otherwise would mean reading the project's hook file at grant time, which is a file read, which is an `await` in the one section that may not have one. **Reclamation is the last step of the lease-end path, not the first.** `DeviceRestorer` gained an `onRestored` seam invoked at the tail of the per-serial chain, and `listen.ts` fills it with `slots.release(lease.slot)`; `onLeaseEnded` is deliberately *not* given a fourth line. The teardown that just ran is the thing that was told those ports, and the allocator hands out the lowest free index — so freeing them when the record disappeared would give the very next grant a block the previous lessee's `stop` is still on, as the likely case rather than a rare one. Same path and same clock as restoration (D9), never a second timer with its own idea of what is dead, and `TEARDOWN_TIMEOUT_MS`/`SETTLE_TIMEOUT_MS` already bound how late reclamation can be. The headline criterion is proved on the expiry path with nobody left to ask — acquire, move the injected clock past the TTL, `sweep()`, settle, and the orphaned index is back and handed to the next grant — beside a test that pins the ordering by asserting `taken() === 1` from inside the teardown itself. **An exhausted pool refuses by name**: `AcquireRefusalReasonSchema` gained `no-slot`, with a message naming the device and the pool size. Granting a lease with no ports would be the silent degradation `ai/RULES.md` §2 forbids and `internal_error` would say the host broke when it is simply full; both clients render a refusal generically, so neither needed editing. **Rover reserves numbers and never binds them** — the project's own service does — so the allocator does not probe: a probe would be check-then-use, and it would have to be awaited inside the section that may not await. The guarantee is bounded honestly instead: no two live leases are ever given the same numbers. The range is chosen to be out of the way — `SLOT_PORT_BASE = 26000`, `PORTS_PER_SLOT = 8`, `SLOT_COUNT = 64`, so 26000–26511, one contiguous block an operator can reserve or firewall in a line, clear of the ports device tooling and web projects actually use and **below every ephemeral range** so the OS cannot hand one out from under a lease. They are constants with test seams in the spirit of `LEASE_TTL_MS`, **not** environment variables and no catalogue row: the catalogue is what an operator *sets*, and there is nothing to tune yet; if the range ever collides on a real host, the follow-up is a documented variable added deliberately. **What a hook is told**: `ROVER_SLOT`, `ROVER_PORT_BASE` and `ROVER_PORT_COUNT` beside the existing `ROVER_PROJECT` and `ROVER_DEVICE_SERIAL`, written after the hook's own declared `env` so a project cannot override the one thing the daemon must guarantee. `ROVER_PORT_COUNT` exists so a hook reads the block size rather than hard-coding one that later drifts. `HookCommandContext.slot` is **required**, not optional — every hook run belongs to a lease and every lease has a slot, and a required field is what stops a future third call site from quietly running a child that was told nothing. Asserted against real child processes on both hook families and on both paths a lease can end. Nothing crosses the wire: `GrantedLeaseSchema` stays `.strict()` and gained nothing, with a negative assertion over the real socket saying out loud that ports are host state. **This landed before R17 phase 4** (#96, helper services in the hook file), and is not a field nothing reads: the ports have two real consumers today in the `install` and `teardown` hooks, which already run as real child processes. R17 phase 4 (#96) then landed on top of it: a service's `start`/`stop` go through the same `runHookCommand` and inherit this contract for free, and the slot is what lets one project be leased twice at once with a set of services each — the stops run with the **ending** lease's slot, so a pair that namespaces by it takes down that grant's own instance | R17 | S |
| R19 | MCP server | Verbs as tools, Zod schemas as their declarations. **A missing capability is a loud, agent-readable error** naming the capability and the device (D11) — never a silent degradation. Zero verb logic in this layer. Pointing at a remote host is server configuration, not a tool parameter — the agent does not know where the hardware sits. **Split in three, the way R12–R14 were: phase 1 the server and the device tools (#19), phase 2 the verb tools (#89), phase 3 the rows that carry bytes — `screenshot`, `record_video`, `install_app`, `push_file`, `pull_file` — and the artifact contract. Phases 1 and 2 done** — `src/mcp/` on `@modelcontextprotocol/sdk`, stdio, `npm run mcp`, declaring the four device and lease rows of `IPC_METHODS` (`status`, `list_devices`, `acquire_device`, `release_device`) under those names exactly. The exported `*ParamsSchema` values **are** the `registerTool` declarations, so the JSON Schema an agent reads and the parse the daemon performs are one object and there is no hand-written copy to drift; no `outputSchema` is declared, because a result schema's *output* type is full of branded transforms JSON Schema cannot express, and the answer travels as the host's own document in a JSON text block plus `structuredContent`. Every handler is one connection, one IPC request and a `close()` in a `finally` — the CLI's own shape, so the local host autostarts on the first tool call (D5) and no connection is held across one. A refused acquire is `isError` carrying `heldBy`, an unreachable host is a sentence naming the address and the port, and neither is ever an empty list. Which host it asks is **configuration, resolved at startup**: `ROVER_HOST_ADDRESS` set means remote, unset means the local daemon, a half-configured remote dies on stderr before the transport is connected, and no tool takes a host parameter (D17). Two things landed with it: the transport choice moved out of `src/cli/_shared/host.ts` into `src/daemon/host.ts` so the two clients share the one place a transport is chosen (the CLI keeps its `--host` translation and its exit codes, unchanged), and `entryUrl` moved to `src/core/entrypoint.ts` so the MCP entrypoint does not import the CLI — whose `console.log` would corrupt a frame on a stdout that belongs to the protocol, which `tests/unit/mcp/stdout.test.ts` now gates as a source scan. `mcp/index.ts` is on `CLIENT_ENTRYPOINTS` (D19). **Phase 2 added the sixteen verb rows whose answer is plain data** — `wait_for`, `wait_until_gone`, `tap`, `long_press`, `swipe`, `scroll`, `type_text`, `press_key`, `read_screen`, `device_info`, `launch_app`, `stop_app`, `clear_app_data`, `read_logs`, `set_airplane_mode`, `set_wifi` — under those names exactly, with no platform suffix (D10). One table, one row per verb, each declared from the same exported `*ParamsSchema` the daemon parses with, so the three app rows share one declaration and the two environment rows share another, exactly as the calls do. Zero verb logic: every handler is one `callHost` and one shared mapping of `verbCallResultOf`'s three branches, so an `ok` travels whole — the resolved target, the after-state and `read_logs`' entries where the host put them — while a failure and a refusal are both `isError` leading with the host's own sentence and carrying the structured document under it, which is the same three branches `src/cli/_shared/verb.ts` renders for a human. **A missing capability is the loud error D11 asks for**: `read_screen` on a backend that does not declare `canReadScreen`, and either environment row on one without `canControlNetwork`, come back `isError` carrying the `missing-capability` failure — the kind, the capability, the serial, the platform and the backend label — never an empty screen, never a toggle that quietly did nothing, never an `ok`; the tool descriptions name the capability too, so an agent can check the list `acquire_device` gave it before it calls. The five rows that can be asked to outlast the client's 30 s default — the two waits, `long_press`, `swipe`, `scroll` — raise their own request timeout from the call's own knob plus that default, with the verb's own default imported to size it and never put on the wire, so a long-but-normal call is never reported as a hang (`rover record`'s pattern). A completeness gate over `IPC_METHODS` keeps a verb row from landing later with no tool: every key is either a registered tool or on a short, named list of the byte-carrying rows phase 3 owns. **#104 added the nineteenth verb tool and settled the other two**: `install_app` ships in its byte-less form only — the declaration is `InstallAppParamsSchema.omit({ packageBase64: true })`, derived the way `acquire_device`'s variant is derived with `.partial()`, so the tool is the project-install form (D13) and there is no payload field to fill — with the request timeout raised to the host's own `INSTALL_HOOK_TIMEOUT_MS` plus the default, and the five-minute budget named in the description because it can outlast an MCP client's own tool-call deadline. `push_file` and `pull_file` stay off the surface and the gate's named list is now exactly those two: neither has a form that carries no bytes, so exposing either means settling how a client supplies and receives a whole file, which is R24 phase 2's mechanism and not one adapter's call. The same row moved the **entry**: `bin/rover-mcp.mjs`, because `--import tsx/esm` is resolved against the MCP client's working directory and so started nowhere but this checkout (§6, and §9.4 on why this is not the published `rover` command) | R12, R13, R15, R16 | L |
| R20 | `README.md` — quick start | **Done** (#20). The file has existed since the repo was created and describes the shape of the project; what it lacks is what could not be written before the code: how to start the daemon, take a device and wire up the MCP server, with commands that work. Separately: how to expose the host on the network and how to connect to it remotely | R10, R19, R24 | S |
| R30 | Device OS version in the inventory, without a lease | **Done** (#108). `DeviceSchema` carries **two** fields — the version string and the API level beside it, the same pair and the same names `DeviceInfoSchema` already used — and `list_devices` returns both for free devices too, read by the backend at enumeration and memoized per serial for as long as that serial stays attached (D6: re-derived at every enumeration, and never read on a verb's path). **Not** through `device_info`, which needs a lease and so can never answer for a free device. Nullable, and a null is a real answer: an `unauthorized` device is listed without a version — it is not even asked, since its state came from the device list already parsed — rather than dropped, and never fails the whole listing. Platform and version stay two fields. No platform branch outside the backend (D10). The recipe is **run** against a real device and lands in §6 with its API level, plus two fixtures | R5, R7 | S |
| R29 | `list_devices` carries when a lease was granted | **Done** (#107). `LeaseHolderSchema` gains the grant instant alongside `expiresInMs`. A client can render `GRANTED` without inference: the two are independent, because activity renews the expiry (D8) and never moves the grant. **No `leaseId` joins the listing** — D20's reason for its absence is unchanged. A unit test covers a renewed lease: expiry moves, grant time does not. What landed: `grantedAt`, an ISO-8601 UTC string (`z.string().datetime()`) rather than epoch milliseconds — the encoding `UserRecordSchema.createdAt` already uses, and the one that cannot be mistaken for the durations beside it. **What it gives up is clock-skew independence, not JSON**: it is the host's clock, so a client renders it and never differences it against its own, and anything relative still comes from `expiresInMs`. `GrantedLeaseSchema` deliberately did **not** gain it — the winner of an acquire already knows when it was granted. `src/daemon/lease-holder.ts` is still the single disclosure path, so D20 is unchanged | R8 | XS |
| R31 | Force-release: end a lease you did not take | **Done** (#109). A method keyed on the **serial**, carrying no credential of the holder's, running the full release path so restoration happens exactly as it does on expiry (D9). **No `leaseId` is exposed anywhere to achieve it** (D20). Already-free and vanished-since are distinguishable named results, because they mean different things to an operator. On the CLI too, so it is debuggable without a browser (D4). The authorisation model is D27's: any named user, until a role model exists. What landed: `force_release_device` on the one IPC surface, taking `{ serial, actor }` and answering `released` with the public `LeaseHolderSchema` projection — so the answer names who was holding it and, like every other disclosure, never the id (`src/daemon/lease-holder.ts` is still the single path). Three refusal reasons rather than two, because the inventory's existing mapping gives `not-attached` for free and it is honest (D18): `not-held`, `gone`, `not-attached`. `rover force-release <serial> --actor <string>`, with `--actor` required and never derived. The authorisation model is written down as **D28**, which is a genuine extension of D20 rather than an application of it, and it leaves `docs/WEB_PANEL.md`'s tiering question open. Two choices could have gone the other way. **A separate method rather than a parameter on `release_device`**: the concern behind the alternative — one release code path — holds anyway, because both handlers end a lease through the single `LeaseStore.release` where D9 is wired, while a params union of "either a lease id or a serial" would weaken the one sentence `ReleaseDeviceParamsSchema` exists to state. **The lease is looked up before the device**: a device that vanished mid-lease is *the* stuck lease an operator most needs to clear, so asking the inventory first and refusing `gone` would have pinned that lease for the full TTL with nothing able to end it — `gone` is therefore only reachable for a device nobody holds. Deliberately **not** an MCP tool: an agent ending a peer's lease is the opposite of what that surface is for, and the completeness gate records it as a decision rather than an omission | R8, R9, R28 | M |
| R32 | HTTP surface: a third transport a browser can reach | A browser cannot speak the framed NDJSON greeting the network listener consumes before dispatch, so the panel has no entry point at all. This binds the **same `IpcServer`** the unix socket and TCP listener already serve — a third transport, not a second implementation, the rule `network-listen.ts` records and `transport-independence.test.ts` guards. No second method table, and no method reachable over HTTP that is not on the one surface. Authenticates against the **same user store**, re-read per request and never cached, so `rover users revoke` bites on the next request (D25). One byte-identical refusal for every pre-auth failure. The token never reaches a URL, a log or a report (D20). **Off unless configured**, matching `ROVER_LISTEN_PORT`'s own switch. **Done** (#110): `src/daemon/http-listen.ts` serves one route, `POST /rpc`, carrying the existing request and response envelopes to the very `IpcServer` the other two transports serve — over an in-memory duplex, so `src/ipc/` is untouched and the independence gate now forbids `node:http` and `node:https` there too. The gate is `Authorization: Bearer <token>` against the user store, read per **request** rather than per connection, which is stronger than R28's guarantee and is pinned by a test that revokes between two requests on one keep-alive connection. Exactly two statuses — `401`, the byte-identical refusal `UNAUTHENTICATED_REFUSAL` gives both gates, and `200`, meaning read the envelope. A method allowlist (`list_devices` today; `force_release_device` joins it with the screen that calls it, R35) keeps `acquire_device` and every verb off this surface without a second table. **The panel polls** — no push, no second connection style (D29). `ROVER_HTTP_PORT` is its own switch, loopback by default, TLS required off loopback, and blanked in an autostarted child | R28 | L |
| R33 | Panel scaffold: tooling, design tokens, the app shell | **Done** (#111). `panel/` is a Vite + React + Tailwind v4 + TanStack Router application in **one npm package with the rest of the repository**, not a nested one like Swarm's `dashboard/`: a second `package.json` would need a second install step and a second lockfile the CI cache key does not cover, and R26's workflow is `npm ci` + `npm run verify` unchanged because of it. The Analog Horizon tokens live in `panel/src/tokens.css`, harvested from `get_project`'s `designMd` and captured verbatim as a fixture — **not** from the emitted screen's Tailwind config, whose `borderRadius` block is shifted one step and whose `full` cannot be a pill (`docs/DESIGN.md` §10). That file is the only place in the panel a colour is written, and three source-scan gates in `tests/unit/panel/` hold the line: the tokens reached the file and no literal exists elsewhere, no `@keyframes`/`animation`/`animate-*` anywhere, and no `PASS`/`SUCCESS`/`Analytics` vocabulary. The shell is one flex row with `min-h-screen` and no `fixed`/`sticky`/`ml-*` anywhere, which is `docs/DESIGN.md` §3's one height and §4's one positioning model in a single declaration. `Archive`, `System`, `Profile` and any unknown address reach a calm placeholder rather than a 404 — with different closing lines, because a screen that is not built yet will be and an unknown address will not. The host's HTTP surface landed with R32, but it serves `POST /rpc` and no static assets: serving the panel's own files from that listener is owned by no row here yet, so the panel runs from `panel:dev` until one takes it | R20 | M |
| R34 | Panel login: present a host credential, hold a session | **Done** (#112 the host half, #119 the browser's). Resolves what `docs/WEB_PANEL.md` left open — whether the panel's login is R27's credential or a layer on it. `rover users revoke` must end an existing session on the next request, not at the next login. Uniform refusal, no self-service account creation, and the token never reaches a URL or a log (D20, D25). The screen is `Sign In — Rover OS` (`5035330b2c12401080263625ff564369`) in the Stitch project `Rover`, and only its default state was ever designed — the other four are settled in `docs/DESIGN.md` §8 instead, which is where §9 says states like these belong. **The host half is done** (#112): `POST /session` exchanges a token for an opaque session id, `GET /session` is the boot probe and `DELETE /session` ends it server-side, with the gate taking a session id or a raw token in the same `Authorization: Bearer` header. Sessions live in `src/daemon/panel-session.ts` — in memory, keyed by the SHA-256 of the id, each bound to a user's `identifier` and `tokenHash`, so a resolve re-reads the store and a `rover users revoke` or `rotate` ends a live browser session on its very next request, over a keep-alive connection the browser is already holding. Sliding 8-hour idle window swept lazily; no cookie, no CORS, no CSRF surface; the sign-in body is the one pre-auth body the surface reads, capped at 4 KiB, and every failure is the one byte-identical `401` (D30). **And the browser's half is done too** (#119): the sign-in screen is **not a route** — `panel/src/app.tsx` renders it in place of the router while there is no live session, so there is no address a credential could be attached to and no redirect target to record — with one masked monospace token input, a reveal, no host field, no account creation and no spinner. `panel/src/session/` holds the client (relative URLs only, `Authorization: Bearer`, a `401` as a typed refusal, never a credential in a URL and nothing logged), the store (`localStorage`, one key, the **session id only** and never the token) and the state machine `checking | signed-out | signed-in | refused | access-ended`, whose `onRefusal()` is the one path to *access ended* so R35's requests inherit the bounce. `Profile` shows who you are signed in as and carries the one **Sign out** control, which sends `DELETE /session` **before** the browser forgets the id. `docs/DESIGN.md` §8 now settles all four undesigned states and the edges between them, under one rule — the panel never discards a session id without the host's answer, and never reports an ending it did not get: a stored id the host refuses on boot is *access ended* and is cleared, a boot probe that reaches nothing is a cold arrival and the id is **kept**, a sign-out the host never answered stays signed in on `Profile` and says so, and a sign-in that replaces a kept id ends that id best-effort so no orphan session is left behind on the host. In development `panel/vite.config.ts` proxies `/rpc` and `/session` to `ROVER_HTTP_PORT` — the panel is same-origin in production and the host emits no CORS header for a cross-origin dev server to use | R32, R33 | M |
| R35 | The Devices screen | The panel's default view, against real host data: every device, free or held, with owner, project, test name, grant time and a countdown that **goes back up** when activity renews the lease (D8). Force-release with a confirmation. **Three distinct empty-ish states**, none of which may render as another: nothing attached (normal — D21), `stale: true` meaning *no view* rather than no devices (D6), and the host unreachable. No pass/fail badge, no status colour, no success rate, no acquire action (D22, D27). Serials and UTC timestamps never truncated. **Half done** (#113): the grid and every one of its states are built and read live host data by polling `list_devices` — the four states of the screen (devices; nothing attached; a stale view over a list; a stale view over an *empty* list, which `docs/DESIGN.md` §7 now settles) plus the host being unreachable, which replaces the whole page rather than dimming the shell. The countdown was watched going **back up** against a running host after a verb renewed the lease. A device is **not** simply free or held: one the host reports as `unauthorized` or `offline` holds no lease and would still be refused `not-ready`, so the card says what the host reports instead of `free` and the counter carries it as a third term (#123 review) — the CLI's `STATE` column had been saying so all along, and two clients of one method may not disagree about one device. **What is left is force-release**: the control on the card, the confirmation, its three outcomes, and `force_release_device` joining `PANEL_METHODS` in `src/daemon/http-listen.ts` | R29, R30, R31, R32, R33, R34 | L |

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
- **A published entry point is not part of this row** and was not added: the quick start ships
  against `npm run rover --`, which is what works in a fresh checkout, and §9.4 below now carries
  that decision along with the one line that changes if it is ever revisited.

**R19 phase 3 is done** (#90). `screenshot` and `record_video` are MCP tools: screenshots return
an inline image and write nothing, while recordings are written under the agent-local
`ROVER_MCP_ARTIFACT_DIR` and their frames return inline. The shared byte-level decode, length
check, write and payload-free description live in `src/client/artifact.ts`, so neither the CLI nor
the MCP adapter can silently diverge. The file-transfer tools remained outside MCP with that
phase; R24 phase 2 delivered their CLI commands, and #104 later added `install_app` in its
byte-less form alone, leaving `push_file` and `pull_file` out.

### 9.4 Outside the backlog — deliberately

- **The iOS backend.** Only the seam is built (§5). Before an issue exists, the dependency on `idb`
  or WebDriverAgent has to be settled, along with accepting that `read_screen` may have no
  equivalent there at all.
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
- **Multi-host addressing (R23), dropped.** The deployment this is built for has exactly one
  machine with hardware, so a device handle stays a bare serial and a client never aggregates more
  than one host (D18, revised 2026-08-29). If devices ever end up spread across more than one
  machine, R23's shape — host+serial handles, a client-side host registry that aggregates several
  hosts and names any that did not answer — is the row to revive. Nothing in D17 (the one host
  reachable over the network) or D19 (verbs execute on the host) needs to change for that; it is
  simply not being built against a need that does not exist yet.
- **A published `rover` entry point.** `package.json` is `"private": true` and has no `bin`, so
  `rover` is typed `npm run rover --` and the CLI renders every pasteable line through one
  constant, `INVOCATION` in `src/cli/_shared/output.ts`. R20 asked for a quick start whose commands
  work, and a `bin` entry would have made it worse rather than better: a bare `rover list` is
  `command not found` in every fresh clone until somebody globally links a private package that
  runs TypeScript through `tsx`. Publishing one is its own decision — shipping through `tsx` versus
  adding a build step, and what `npm link` means for a package marked private — and it is not
  scheduled. When it is taken, that constant becomes `'rover'` and nothing else moves.

  **`bin/rover-mcp.mjs` is not that, and the reasoning above is untouched by it** (#104). The
  objection here is `command not found` for a name nobody put on a `PATH`; that file is named by
  **absolute path** in an MCP client's own configuration, which is a path that config already had
  to state, so there is no lookup to fail. Nothing is linked, `package.json` still has no `bin`,
  and no CLI line changes. It exists because the MCP server's entry is the one Rover invocation
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
    <test_name-or-"unlabeled">/
      <timestamp>-<owner>-<hash>/    # the lease's own directory, generated by the daemon
        <device-serial>/
          device_info.json           # size, density, dp scale, OS version — a static copy of D14
          screenshots/
            001_<verb>.png
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
- **`test_name` is deliberately not unique.** Two leases can carry the same name at two different
  points in time — exactly the shape a before/after refactor comparison needs: list the directory
  and the two most recent runs are the two sides of the diff.
- **An absent `test_name` falls back to one fixed directory name** (`unlabeled`), so the tree shape
  never branches on whether the field was supplied.
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
- **The tree is deliberately walkable without an index** (D24). Listing a directory is the whole
  query a future read-only viewer would run — no database, no separate catalogue kept in sync with
  the files. The two most recent `<lease-id>` folders under one `test_name` are already the
  before/after pair a diff view wants, which is the reason `test_name` is deliberately not unique
  (above).
- **Retention is undecided** (§9.4) — without one, this grows without bound on machines that
  usually have the least disk to spare, and it stops being a someday problem the moment a panel is
  reading this archive on a schedule (D24).
