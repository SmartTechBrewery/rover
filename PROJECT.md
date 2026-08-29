# PROJECT.md — Rover

> A living document. Updated as the tool is being built.
> Last updated: 2026-08-29

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
3. The host checks adb for what is free, grants a **lease**, and returns a device handle along with
   the list of what may be done on it. The handle is the device serial — there is exactly one host,
   so nothing else needs naming (D18).
4. The agent calls verbs, passing that handle. The host executes them; the client receives the
   result and the artifacts. Every call pushes the lease expiry out.
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
| D9 | **Restoration is forced, not requested** | The predecessor *asked*, in a comment, that state be restored before releasing, and nobody ever checked. The daemon does it itself on release **and** on expiry: stop the app, airplane mode off, wifi back on, project hooks | 2026-08-27 |
| D10 | **One set of verbs. The platform is a property of the device, not part of a tool's name** | Considered and rejected: `tap_android` / `tap_ios`. Suffixes double the tool list (agents choose worse the longer it gets), force every scenario to be written twice, and make the agent remember what it is standing on. The device knows what it is anyway | 2026-08-27 |
| D11 | **Capability negotiation instead of a lowest common denominator** | Backends are not symmetric and that cannot be hidden. Each declares what it can do; a verb with no backing ends in a **loud error**, not a silent degradation. A suffix says "there is no such tool" and leaves you guessing; a refusal says plainly what is missing | 2026-08-27 |
| D12 | **Determinism is three rules in the verb layer, not a property of the daemon** | (a) no coordinates from memory — the target is resolved from a fresh hierarchy dump **inside** the verb; (b) no `sleep` — only waiting on a condition with a timeout; (c) every action returns the state after itself, so the agent never guesses whether it landed | 2026-08-27 |
| D13 | **Everything project-specific is a hook in configuration** | The install command, starting helper services, cleanup, paths to design renders. The core knows no application's name | 2026-08-27 |
| D14 | **Every result names the device and its density** | Two emulators at different densities give different — and both correct — measurements of the same element. Without naming the device, two reports contradict each other and there is no telling which one is lying | 2026-08-27 |
| D15 | **The architecture is modelled on Swarm (`../swarm`)** | Swarm is working Node.js code by the same author, with a proven set of conventions (TypeScript strict/ESM, Biome, Vitest, Zod as the source of truth, a provider registry). Swarm's providers are device backends here — the same module shape. Inventing our own conventions would buy nothing | 2026-08-27 |
| D16 | **Rover and Swarm will be integrated; the preparation starts now** | Swarm will eventually show that a given run is holding a Rover device. Nothing needs building immediately, but two things must be designed for from the start: daemon state queryable by something that is not an agent, and a lease with an explicit owner that Swarm will fill with its own run identity | 2026-08-27 |
| D17 | **The device host is reachable over the network; the agent need not stand on it** | The machine with the hardware is rarely the agent's machine, and hardware is the most expensive and least divisible resource here. A tool that lends only locally serves one person and leaves the phones idle most of the day. The local socket stays the default, zero-config path; the network listener is **a second transport of the same surface**, not a second implementation — otherwise one of the two starts drifting in the week it is written | 2026-08-27 |
| D18 | **Only devices physically attached to the host are ever leased** | `adb connect host:5555` makes some other machine's emulator visible in `adb devices` here, and it is tempting because it "almost works" — but that device is not this machine's hardware, may vanish without warning, and belongs to whatever process put it there. The host refuses it before it ever reaches a lease. **Revised 2026-08-29:** the original wording ("a device belongs to exactly one host") assumed Rover would run as more than one host and guarded against two of them fighting over the same `adb connect`-visible device. The deployment this is built for has exactly one host, so that scenario cannot occur — but the guard itself stays, for its own reason: physical attachment, not host ownership, is what makes a device safe to lease. **Multi-host addressing (R23) is dropped from the backlog entirely** as a consequence (§9.4) | 2026-08-27, revised 2026-08-29 |
| D19 | **The verbs execute on the host; the adapters are clients** | The alternative — the client gets a serial and calls adb itself — requires adb reachable over the network, exposing exactly the surface D17's authenticated listener exists to gate instead, and it strands the project hooks and helper services (D13, port allocation) on the far side of the network from the device they exist to serve. The core stays a library; only which process loads it changes. The consequence to keep in mind in every verb that returns a file: artifacts come back as bytes, and a path handed to the agent must exist **on the agent's machine** | 2026-08-27 |
| D20 | **The host token authenticates; the lease owner attributes. Two different fields** | Anything listening on a network lets strangers in, so a host needs a shared secret. It is tempting to derive the owner from whoever authenticated — and then either the token lands in reports and logs, or the attribution cannot be overridden, and Swarm is supposed to put its run identity there (D16). The token says "you may take devices from here"; the owner says "`pr-127-review` is holding this" | 2026-08-27 |
| D21 | **Rover never starts an emulator or connects a physical device — that is the host operator's job** | The host only ever reports what `adb devices` already shows on its own machine (D6). Bringing hardware online — booting an emulator, plugging in a phone — is physical, local work done by whoever operates that machine; it is never a verb the daemon executes and never something a remote client can trigger. Rover's job starts once the device is already there | 2026-08-28 |
| D22 | **A lease carries two more explicit, caller-supplied strings: `project` and `test_name`** | `owner` (D16) alone does not give an artifact a findable home: two projects can reuse the same owner string, and "before/after" comparisons need a way to group runs by what they were checking. `project` names which registered project a lease belongs to; `test_name` names the scenario being run and is **deliberately not required to be unique** — running "home screen before changes" and "home screen after changes" as two separate leases with the same-shaped name is the point, not an error case. Both are opaque strings the core never inspects, parses or defaults from context, exactly like `owner` (D20) | 2026-08-29 |
| D23 | **The host durably archives every artifact-producing verb's output, additive to D19's bytes-over-the-wire return** | A screenshot handed to the agent once during a session answers "does it work right now"; it cannot answer "does it still look the way it did before the refactor" unless a copy survives on disk to diff against later. The archive (§10) is a second effect of the same verb call — it changes nothing about what the client receives, and a path into the archive is never a path handed to the agent. D19 keeps holding: artifacts still cross the machine boundary as bytes | 2026-08-29 |

---

## 4. The verb set

Working names. All of them take a device handle.

### Devices and leases

| Verb | What it does |
|---|---|
| `list_devices` | What is attached, what is free, whose is what |
| `acquire_device` | Takes a device exclusively; returns a handle and the capability list. Also takes `project` and an optional `test_name` — caller-supplied attribution strings that name the destination in the artifact archive, not application logic (D22, §10) |
| `release_device` | Hands it back and restores the original state |

### Input

| Verb | Notes |
|---|---|
| `tap` | By text or element id; coordinates are the fallback |
| `long_press` | Implemented as a drag in place with a duration |
| `swipe` / `scroll` | |
| `type_text` | Hides escaping of spaces and non-ASCII characters |
| `press_key` | Back, home, recents, wake |

### Reading

| Verb | Notes |
|---|---|
| `screenshot` | |
| `read_screen` | Texts and element rectangles. **Works even when the app blocks screenshots** |
| `record_video` | A recording plus a slice into frames — for states that do not stand still |
| `device_info` | Size, density, computed width in dp, OS version |

### Waiting

| Verb | Notes |
|---|---|
| `wait_for` / `wait_until_gone` | Polling the screen until it happens, with a timeout. **Replaces `sleep`**, which is the main source of false results |

### App and environment

| Verb | Notes |
|---|---|
| `install_app` / `launch_app` / `stop_app` / `clear_app_data` | |
| `read_logs` | Catches a failure a screenshot will not show |
| `set_airplane_mode` / `set_wifi` | See §6 — recipes that need no root |
| `pull_file` / `push_file` | |

---

## 5. The device layer and the iOS seam

iOS is not being built now, but the code has to accept it without a rewrite. The seam does **not**
run along "adb versus simctl" — it runs along the device interface: enumeration, lifecycle,
installation, app control, screenshot, hierarchy read, input.

Three things worth knowing now, so as not to design into a corner:

- **`simctl` can neither tap nor dump a hierarchy.** It can do screenshots, installation and
  lifecycle. Input and tree reads need `idb` or WebDriverAgent — a heavy dependency with a
  lifecycle of its own.
- **Semantic screen reading has no cheap equivalent on iOS.** On Android it is the one capability
  that survives a screenshot block. On iOS it may not be possible at all.
- Hence D11: `read_screen` **is not a required method** of the interface. It is a declared
  capability the verb layer asks about before using it.

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

---

## 7. Scope

**In scope:** Android over adb — emulators and physical devices in debug mode treated alike. A
device pool, leases, state restoration. The verbs from §4. CLI and MCP. A host reachable over the
network: an agent on machine A borrows a device from machine B, where Rover runs (D17–D20).
Authentication by host token. **A CI gate that runs `npm run verify`** — lint, typecheck, unit
tests — on every pull request (R26); no device tests, since a CI runner has no Android device.

**Out of scope for now:** iOS (the seam only, see §5). Automated tests with assertions — CI runs
the existing unit-test suite, it does not add device-driven assertions of its own. Cloud
device farms, **more than one Rover host in a single deployment** (D18, revised 2026-08-29; §9.4),
a host catalogue, hosts registering with one another, and anything resembling a dashboard — a
client is configured with the address of its one host and that is all. Comparison against
design renders — Rover supplies screenshots and measurements; judging them against the design is
the agent's job. **Starting emulators and connecting physical devices** — that belongs to whoever
operates the host machine, not to Rover (D21).

---

## 8. What this method will not see

Worth naming out loud, because silence reads as "checked".

- **Nothing goes red on its own.** There is no assertion here; the quality of the result depends on
  the agent's attention, not on the tool.
- **Colour, typeface, weight, radius and spacing — only when the app allows itself to be
  photographed.** A screenshot block takes away the pixels and leaves the semantics.
- **Motion is only ever sampled.** Frames say something rotated; they say nothing about easing,
  duration, or stutter.
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
   filed (remote hosts, D17–D20) and sit where the dependency order puts them, not at the end of
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
| R9 | State restoration | Stop the app, airplane mode off, wifi back on, the project hook. **A test proves the teardown runs on the expiry path too**, not only on `release` (D9). Split in two: the backend's network primitives landed first (#9) so the routine has something real to drive, and §6 records why it must set both radios explicitly with **wifi last** | R8 | M |
| R10 | CLI: `list`, `acquire`, `release`, `status` | Readable by a human and scriptable. This is the interface everything above is debugged through (D4). The host is named by a flag; no flag means the local host | R8 | S |
| R11 | Verb layer foundation | Target resolution from a **fresh** read inside the verb, waiting on a condition with a timeout, returning the state after the action (D12). **There is not a single `sleep` in the repo** — enforced by a lint rule or a test. A timeout says what it waited for and what it found instead. A verb's result is serializable — the host will execute it, not the client (D19, R21) | R5, R8 | L |
| R21 | Host-side verb execution | The daemon loads the core; the CLI and MCP call verbs over the same surface as leases (D19). **No adb in a client process** — checkable by a test. This row stands ahead of the verb families deliberately: changing the execution model after they are written is a rewrite of six files instead of one | R11 | L |
| R22 | Host network listener and authentication | TCP with TLS alongside the local socket, **the same surface, a second transport** (D17). The host token authenticates, the owner string attributes — **two separate fields, and a test proves the token never becomes the owner nor reaches a log** (D20). A refusal does not reveal what the host has attached | R21 | L |
| R12 | Input verbs | `tap`, `long_press`, `swipe`, `scroll`, `type_text`, `press_key`. `long_press` as a drag in place — **not** `keyevent --longpress` (§6). `type_text` hides the escaping of spaces | R21 | M |
| R13 | Read verbs | `screenshot`, `read_screen`, `device_info`. `read_screen` works with screen capture blocked and **is a declared capability, not a required method** (§5) | R21 | M |
| R14 | `record_video` + slicing into frames | The recording must finish before it is pulled — a file pulled earlier has no `moov` atom and cannot be read at all | R13 | S |
| R15 | App verbs | `install_app`, `launch_app`, `stop_app`, `clear_app_data`, `read_logs`, `pull_file`, `push_file`. `read_logs` is to catch a failure a screenshot will not show | R21 | M |
| R16 | Environment verbs | `set_airplane_mode`, `set_wifi` through `cmd connectivity` and `cmd wifi` — **not** through `svc`, which is gone (§6). Both paths without root. The **primitives** landed with R9's first phase (#9) — `setAirplaneMode` / `setWifiEnabled` on the Android backend, behind `canControlNetwork` — so this row is the verb layer over them, not the recipes themselves | R21 | S |
| R24 | Artifact transfer across the machine boundary | Screenshots, recordings and pulled files come back as bytes; **a path returned to the agent exists on the agent's machine** (D19). In the other direction: `install_app` and `push_file` send a file to the host. The recording from R14 finishes on the host before the transfer, not during it. The size limit is explicit and named, and does not announce itself as a truncated file | R13, R14, R15 | M |
| R25 | Durable artifact archive on the host | Every verb that produces a screenshot, a recording, or a log pull additionally writes it into `<project>/<test_name>/<lease-id>/<device-serial>/…` on the host (D23, §10), alongside a `device_info.json` snapshot per lease-device pair (D14). **An absent `test_name` falls back to a single fixed directory name**, so the tree shape never varies. **The archive path is never the one returned to the agent** — R24's bytes-over-the-wire contract is unchanged by this row. Retention (a TTL or size cap, and who prunes) is explicitly out of scope here — see §9.4 | R8, R13, R14, R15, R24 | M |
| R17 | Project hooks (D13) | A Zod schema: the install command, helper services, teardown. **The core knows no application's name**, and a default value that mentions one is a bug. The schema also carries the `project` identifier consumed by R25's archive (D22), so it is set once per project instead of retyped by every caller | R9 | M |
| R18 | Per-slot helper service port allocation | No race, with recovery after an orphaned slot. The precondition for parallel work with more than two devices | R17 | S |
| R19 | MCP server | Verbs as tools, Zod schemas as their declarations. **A missing capability is a loud, agent-readable error** naming the capability and the device (D11) — never a silent degradation. Zero verb logic in this layer. Pointing at a remote host is server configuration, not a tool parameter — the agent does not know where the hardware sits | R12, R13, R15, R16 | L |
| R20 | `README.md` — quick start | The file has existed since the repo was created and describes the shape of the project; what it lacks is what could not be written before the code: how to start the daemon, take a device and wire up the MCP server, with commands that work. Separately: how to expose the host on the network and how to connect to it remotely | R10, R19, R24 | S |

### 9.4 Outside the backlog — deliberately

- **The iOS backend.** Only the seam is built (§5). Before an issue exists, the dependency on `idb`
  or WebDriverAgent has to be settled, along with accepting that `read_screen` may have no
  equivalent there at all.
- **Swarm integration (D16).** Nothing to build now; R6 and R8 only have to keep the road open —
  daemon state queryable from outside MCP, and a lease with an explicit owner.
- **A `Planning` column on the board.** Swarm maps such a status in its project configuration and
  our board does not have one (`ai/RULES.md` §5). To be settled when onboarding Rover into Swarm:
  add the column or configure that phase away. Do not add a column nobody uses in the meantime.
- **Retention policy for the artifact archive (§10, D23).** A TTL, a size cap, and who runs the
  prune — a human operator by cron, or the daemon itself — are all undecided. R25 builds the
  archive with no pruning; a follow-up row is filed once the shape of R25 has actually been used
  and it is clear what fills a disk first.
- **Multi-host addressing (R23), dropped.** The deployment this is built for has exactly one
  machine with hardware, so a device handle stays a bare serial and a client never aggregates more
  than one host (D18, revised 2026-08-29). If devices ever end up spread across more than one
  machine, R23's shape — host+serial handles, a client-side host registry that aggregates several
  hosts and names any that did not answer — is the row to revive. Nothing in D17 (the one host
  reachable over the network) or D19 (verbs execute on the host) needs to change for that; it is
  simply not being built against a need that does not exist yet.

---

## 10. Artifact retention on the host

Every verb that produces a screenshot, a recording, or a log pull writes into a fixed directory
tree on the host, **in addition to** returning bytes to the client (D19, D23) — this is a second,
host-local effect of the same call, never a substitute for it and never a path handed to the agent.

```
<rover-data-dir>/artifacts/
  <project>/
    <test_name-or-"unlabeled">/
      <lease-id>/                    # <timestamp>-<owner>-<hash>, generated by the daemon
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
- **`lease-id` needs no project or test name baked into it** — both are already the enclosing
  directories. It stays `<timestamp>-<owner>-<hash>`: chronological within its folder, and
  self-disambiguating without repeating information the path already carries.
- **The archive path is never the one returned to the agent** (D19, R24 unchanged). A client asking
  "what does the archive look like" is a different question from "what did this verb call return",
  and the two are never conflated.
- **Retention is undecided** (§9.4) — without one, this grows without bound on machines that
  usually have the least disk to spare.
