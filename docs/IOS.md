# iOS — what the seam can actually be filled with

The evidence document behind `ai/ARCHITECTURE.md`'s "Where the iOS seam runs". Everything below was
**run**, on this machine, on 2026-09-08, against a Compose Multiplatform app built from
`../giotto-ai-demo` (`iosApp` scheme, bundle `com.tooploox.giotto.Giotto`) — not read off a blog and
not remembered. Where something could not be run, it says so rather than implying a result
(`ai/RULES.md` §6).

**Bottom line:** every **required** method of `DeviceBackend` has a working iOS **simulator**
implementation today, and **four of the five** gated capabilities do too — including
`canReadScreen`, which `ai/ARCHITECTURE.md` guessed might have no iOS equivalent at all, and
`canInput`, whose two unanswerable keys are refused by name rather than substituted for (§5). The
fifth is `canControlNetwork`, which is `false` for good. A **physical** iPhone is a
different and much worse story: it cannot answer `screenshot`, which is a required method, so it is
not a device this contract can lend at all without a WebDriverAgent-class in-device agent.

**And it is built.** `src/backends/ios-simulator/` is the repository's **second registered
backend** as of #230 — every required method plus `canRecordVideo` and `canControlRecording`, on
`simctl` alone with no third-party dependency, which is §10 step 1. `canReadScreen` and `canInput`
were declared **`false`** there and steps 2 and 3 have since flipped both (#251, #252), so
`canControlNetwork` is the one flag left `false` and it is `false` for good (§5). Where a section
below still reads as a proposal, the block naming the phase that delivered it says what actually
shipped.

---

## Contents

1. [The bench](#1-the-bench)
2. [Contract fit, measured](#2-contract-fit-measured)
3. [The tooling landscape](#3-the-tooling-landscape)
4. [What idb actually is, and what it costs](#4-what-idb-actually-is-and-what-it-costs)
5. [Where the vocabulary does not line up](#5-where-the-vocabulary-does-not-line-up)
6. [Physical devices: the required-method wall](#6-physical-devices-the-required-method-wall)
7. [Attachment, leases and enumeration](#7-attachment-leases-and-enumeration)
8. [Traps, each one hit here](#8-traps-each-one-hit-here)
9. [Two claims in `ai/ARCHITECTURE.md` this evidence corrects](#9-two-claims-in-aiarchitecturemd-this-evidence-corrects)
10. [Recommendation](#10-recommendation)

---

## 1. The bench

| | |
|---|---|
| Host | macOS 26.6.2 (25G83), Apple silicon |
| Xcode | 26.6 (17F113) — **full Xcode required**, see below |
| Runtime | iOS 26.5 (23F77), 11 simulator device types available |
| Device under test | iPhone 17 simulator `88D8476E-…`, 1206×2622 px, scale 3, 460 dpi |
| App under test | Giotto (Compose Multiplatform, `shared` framework + SwiftUI host) |
| idb | `idb_companion` 1.5.2 (built 2026-09-01) + `fb-idb` 1.5.2 python client |

**`xcode-select -p` on this machine pointed at `/Library/Developer/CommandLineTools`, where
`simctl` does not exist** — `xcrun simctl` fails with *"unable to find utility simctl, not a
developer tool or in PATH"*. Everything here was run with
`DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`. An iOS backend needs the same
locate-and-verify treatment `src/backends/android/adb-path.ts` gives `adb`, and its
`tooling-missing` interruption cause (`src/core/device.ts`) should name `simctl`/`Xcode`, because
"Command Line Tools are installed" is the state a developer machine is most likely to be in while
looking fully equipped.

**That treatment landed, and the runner on top of it executes `simctl` directly rather than
through `xcrun`.** Measured on a second bench — macOS 26.6.2 (25G83), Xcode 26.4.1 (17E202),
2026-09-08, `xcode-select -p` → `/Applications/Xcode.app/Contents/Developer` — `env -u
DEVELOPER_DIR /Applications/Xcode.app/Contents/Developer/usr/bin/simctl list -j devices runtimes`
answered the full JSON at exit 0 in 0.11–0.20 s across four runs, with no `DEVELOPER_DIR` in the
environment at all. So the shim buys nothing, and what it would cost is the point: `xcrun`
performs **its own** search for the utility, which can disagree with the one
`src/backends/ios-simulator/developer-dir.ts` has already made and verified — this section's own
trap, where `xcrun simctl` fails outright on a machine whose Xcode holds a perfectly good one.
`src/backends/ios-simulator/simctl.ts` is the runner, and `tests/device/setup.ts` probes for a
booted simulator through the same resolution for the same reason (#214).

---

## 2. Contract fit, measured

Every required method of `DeviceBackend`, then every gated capability. Times are wall-clock for one
call including CLI process start, median of the runs made here; the `idb` rows carry a Python client
startup of ~60–90 ms that a Node backend talking gRPC directly would not pay.

| Interface method | How | Measured | Verdict |
|---|---|---|---|
| `listDevices` | `simctl list -j devices` | 0.10–0.76 s, 11 devices | ✅ |
| `watchDevices` | `idb_companion --notify stdout` | full-set JSON per change | ✅ **a stream, not a poll** |
| `describeDevice` | `simctl list -j devices`, filter udid | 0.10 s | ✅ |
| `deviceInfo` | `profile.plist` + `simctl getenv` | <1 ms | ✅ px, dpi and scale all exact |
| `installApp` | `simctl install <path.app>` | 0.3 s reinstall, 2.7–5.2 s first | ✅ |
| `launchApp` | `simctl launch <bundle>` | 0.35 s, returns pid | ✅ |
| `stopApp` | `simctl terminate <bundle>` | 0.12 s | ✅ |
| `clearAppData` | `simctl uninstall` + `install` of a staged copy | 0.5–0.79 s | ⚠️ no `pm clear` equivalent |
| `screenshot` | `simctl io <d> screenshot --type png --mask ignored <path>` | 0.14–0.29 s, 246 KB–2.8 MB PNG | ✅ to a **file**, never stdout |
| `readLogs` | `simctl spawn <d> log show --style ndjson --info --debug --last <30s→2m→5m>` | 0.9–1.8 s per width, 2,053–34,819 entries; 113.6 MB in `30s` a minute past boot | ⚠️ must be scoped in the query; widens until the cap binds or a width outgrows the 64 MB buffer |
| `pushFile` | the device's `dataPath` + a host copy | 0.10 s, 64 KB | ✅ storage **is** a host path |
| `pullFile` | same | 0.11 s, byte-identical | ✅ |

| Capability | Gated methods | How | Measured | Verdict |
|---|---|---|---|---|
| `canReadScreen` | `readScreen` | `accessibility_info {format: LEGACY}` over gRPC — the RPC `idb ui describe-all` wraps | 34–47 ms warm on an established channel, 3.34 s for a companion's **first** read; labels + frames in **points** | ✅ **declared true** (#251) |
| `canInput` | `tap` `swipe` `typeText` `pressKey` | one client-streaming `hid` call per injection, over the same channel as the read — the RPC `idb ui tap/swipe/text/button` all wrap | through this backend: tap 106–144 ms, `typeText` 102–154 ms for a word and 219–315 ms for all 95 printable ASCII, `pressKey('home')` 104–197 ms, a 250 ms swipe 452 ms | ✅ **declared true** (#252); `back` and `recents` refused **by name**, see §5 |
| `canRecordVideo` | `recordVideo` | `simctl io <d> recordVideo --codec h264 --mask ignored <path>` | marker at 0.14–0.23 s; 100,782 bytes for ~2 s of an idle screen | ✅ **no `--time-limit` — the window is host-side** |
| `canControlRecording` | `start`/`stop`/`discardRecording` | same + `SIGINT`, and the **host's** process table for "is this device recording" | exit 0 in 20–30 ms after the signal; `ps` stops naming the recorder in 39 ms | ✅ |
| `canControlNetwork` | `setAirplaneMode` `setWifiEnabled` | — | — | ❌ **declare false** |

19 of 20 probes succeeded; the twentieth is `canControlNetwork`, which failed **on purpose** —
see §5.

`clearAppData` deserves its footnote. There is no single call that empties a container the way
`pm clear` does. Three routes were tried: `simctl uninstall` + `install` works and is what the
number above measures; deleting the contents of `Documents`, `Library` and `tmp` under
`get_app_container … data` also works and keeps the binary installed; and `simctl install_app_data`
with an empty `.xcappdata` — the one Apple documents for this — **could not be made to work**,
failing first for a missing `AppDataInfo.plist`, then "corresponds to an app that isn't currently
installed", then container-manager error 55, across three plist spellings. Not worth more time when
uninstall-and-install costs 0.8 s.

### What phase 3 added to the rows above, measured while building them

Everything in this block was run on the **second** bench — macOS 26.6.2 (25G83) / Xcode 26.4.1
(17E202), 2026-09-08, the one `tests/fixtures/ios-simulator/README.md` describes — against a
`.app` compiled for the simulator SDK for the purpose, and then driven **through
`IosSimulatorDeviceBackend` rather than through `simctl` by hand**, which is what makes it evidence
about this repository's code and not only about the tool:

```
installApp   5.2 s first ever, 0.23–0.28 s thereafter   launchApp 0.24 s
pushFile     0.10 s (64 KB)   pullFile 0.11 s, byte-identical
stopApp      0.12 s           stopApp again 0.12 s, and it succeeds
clearAppData 0.51 s           the pushed file is gone, the app still launches
```

- **`simctl install` reads the bundle's *contents*, not its file name.** The same zipped bundle
  installed at exit 0 as `Rover.ipa`, as `payload.zip` and as `payload` — which is the name the
  daemon gives a caller's payload (`src/daemon/verb-handlers.ts`). So the iOS side needs no
  analogue of `withInstallablePackage`, which exists on the Android side purely because
  `adb install` refuses a name not ending `.apk`. The name *does* matter for an unzipped `.app`
  **directory**: one copied to a name without the suffix was refused with *"The item being
  installed did not contain any installable apps"*.
- **A bundle with no Mach-O executable cannot be installed at all** — *"Failed to re-fetch bundle
  during preflight"*, exit 1, and it leaves a half-registered container behind that
  `get_app_container` will still answer for. So there is no toolchain-free stand-in for a real
  `.app`, which is why `tests/device/ios-simulator/app-control.test.ts` has no `installApp` success
  case and says so.
- **`get_app_container <device> <bundle> app` names a path *inside* the storage `uninstall`
  removes** — `<dataPath>/Containers/Bundle/Application/<uuid>/<Name>.app`. Verified by doing it:
  after the uninstall the path the tool had just printed no longer exists. `clearAppData` therefore
  copies the bundle onto this host **before** uninstalling, and the copy keeps the `.app` basename.
- **A reinstall gets a fresh data container UUID.** Measured across one `clearAppData`, and it is
  the cost of this route over emptying the container in place: anything holding the old UUID is
  looking at a container that is gone.
- **Every app-lifecycle subcommand needs the device booted, and says so in one voice.** `install`,
  `launch`, `terminate`, `uninstall` and `get_app_container` on a `Shutdown` device all exit
  **149** with `Unable to lookup in current state: Shutdown`. The two file transfers do not: a
  simulator's storage is a host path, and it is there whatever state the device is in.
- **`uninstall` of an app that is not installed exits 0 with both streams empty**, where
  `get_app_container` for the same app exits 2. That asymmetry is why `clearAppData` resolves the
  bundle first: the failure lands before anything has been touched.
- **`simctl launch` is idempotent.** A second launch of an app already running answers the same pid
  at exit 0, so there is no already-running case to special-case.
- **`simctl spawn`'s filesystem view is this Mac's.** `spawn <udid> /bin/ls /var` lists the host's
  `/var` — `folders`, `jabberd`, `msgs` — and `/bin/ls /var/mobile` answers *"No such file or
  directory"*. There is no in-simulator absolute namespace to relay a path through, which is what
  forces `pushFile`/`pullFile` to resolve under the device's own `dataPath` and rules out a
  `spawn cat` route.
- **`simctl` has no generic file-transfer subcommand**, verified against `simctl help`: `addmedia`,
  `get_app_container`, `pbcopy`/`pbpaste`/`pbsync` and `install_app_data` are everything that moves
  a byte, and each moves one particular kind to one particular place.
- **CoreSimulator itself symlinks out of the data root.** `<dataPath>/Library/Logs` points at
  `~/Library/Logs/CoreSimulator/<udid>`. That is why the confinement in
  `src/backends/ios-simulator/containers.ts` is *lexical* rather than a `realpath` comparison — the
  stricter rule would refuse an ordinary device path.

### What phase 4 added to the rows above, measured while building them

The two reads, on the same **second** bench — macOS 26.6.2 (25G83) / Xcode 26.4.1 (17E202),
2026-09-08, against the `iPhone 17` the host already had booted — and driven **through
`IosSimulatorDeviceBackend` rather than through `simctl` by hand** wherever the number is about
this repository's code rather than about the tool:

```
screenshot   0.22–0.29 s bare, 0.37–0.49 s through the backend (the state check in front of it)
             2.83 MB PNG, 1206×2622 — exactly deviceInfo()'s widthPx/heightPx
screenshot   on a Shutdown device: 60.68 s to fail bare, 0.12 s to refuse through the backend
readLogs     0.9–1.4 s, 3,384 entries in a 30 s window; on a Shutdown device it fails in 0.15 s
readLogs     the widths, re-measured for the widening (#239 review): 30s → 2,053 entries / 2.6 MB
             / 1.01 s, 2m → 8,712 / 10.9 MB / 1.13 s, 5m → 34,819 / 42.8 MB / 1.75 s
readLogs     the same widths a minute past a boot, which is what bounds the widening by bytes
             (#239 second pass): 30s → 94,154 entries / 113.6 MB, 2m → 160,587 / 191.8 MB,
             5m → 195,444 / 232.4 MB — all three past the read's own 64 MB buffer; on a second
             device type seconds after boot, 30s → 107.9 MB, 2m → 576.8 MB, 5m → 756.4 MB
readLogs     at the ceiling across that burst ageing out: it answered every time — 5,000 entries
             truncated at t+0s, then 1,047 truncated at t+73s off the 30s width while the 2m one
             was 247.9 MB and overflowed, which is the kept-narrower-answer path on a real device
```

- **The capture cannot go to stdout on this platform, and the `-` that documents it is not a
  no-op — it is a write that fails.** §8 trap 10 carries the wording; the consequence is that
  `screenshot` stages a file under `tmpdir()` and removes it, and that the path it passes is
  **absolute**, because a relative one fails the same way `-` does.
- **`--mask ignored` changes the alpha, not the geometry.** Both mask forms came back 1206×2622,
  which is what makes the dimensions worth asserting against `deviceInfo`: they agree exactly, so
  the device-type profile and the capture are describing the same screen.
- **A successful capture writes only to stderr.** `Wrote screenshot to: <path>` and the
  `No display specified. Defaulting to display: …` note both land there, with **stdout empty** —
  so the staged path has to be masked out of the captured streams as well as out of the argv
  (`RunSimctlOptions.redactArgv`), and nothing may read "wrote to stderr" as "failed".
- **`simctl spawn <device> log show` reads the *device's* log.** The processes in a capture are
  the simulator's own (`launchd_sim`, `locationd`, `gamecontrollerd`, `backboardd`, `SpringBoard`),
  and that is the device half of the pushdown §5 now describes.
- **`log show`'s window unit is not what its own help says.** `--last <num>[m|h|d]` lists no `s`,
  yet `s` is honoured — `--last 60s` and `--last 1m` answered 5,750 and 5,752 lines seconds apart
  — while a **bare number is seconds**: `--last 1` answered 93 entries where `--last 60s` answered
  3,998. Spell the unit; the default is not the minutes the list implies.
- **A log window bounds a duration, not a size, and the default `maxBuffer` is not enough for a
  generous one.** A 60-second window measured 5.0 MB (3,998 entries) on a quiet minute and
  11.3–11.9 MB (9,166–9,669 entries) while the bench was itself reading logs — past
  `SIMCTL_MAX_BUFFER_BYTES` on an *idle* simulator. The read carries its own 64 MB ceiling;
  an overflow is a killed child and a lost answer rather than a truncation.
- **`log show` has no count bound at all** — its own bounds are the window and `--predicate`
  (`log show --help`) — so there is nothing to ask `maxEntries + 1` of the way `logcat -t` is
  asked on the Android side. **One window is therefore not a substitute for that `+ 1`**, which is
  what the first cut of this phase got wrong: a window narrower than the cap makes the *lookback*
  decide the answer while `truncated: false` claims the cap did not. What stands in for it is
  widening the window until the device says more than the cap (§5) — the answer is then full
  because the cap cut it, and a short one is short because the horizon really was reached.

### What phase 5 added to the rows above, measured while building them

The recorder, and the first thing in this document measured on **this** document's own bench
rather than on the second one — macOS 26.6.2 (25G83) / Xcode 26.6 (17F113) / iOS 26.5 (23F77),
2026-09-08, against the `iPhone 17` `88D8476E-…` §1 names. The three fixtures under
`tests/fixtures/ios-simulator/recordvideo*` were cut from these runs, and are the only captures in
that folder taken here (its README says which bench each came from).

```
recordVideo  `Recording started` on **stderr** at 0.14–0.23 s, always preceded by the
             `Note: No display specified…` line at ~0.12 s — two lines, in that order
recordVideo  SIGINT → `Recording completed. Writing to disk.` then `Wrote video to: …` on
             **stdout**, then exit 0, 20–30 ms after the signal
recordVideo  ~2 s of an idle screen: 100,782 bytes (~50 KB/s), ftyp(`qt  `)/moov/wide/mdat,
             one sample declaring 2,042 ms
recordVideo  0.29 s of four full-screen repaints: 810,871 bytes — ~2.8 MB/s
stopRecording  `ps` stopped naming the recorder on the first probe, 39 ms after the signal
recordVideo  on a **Shutdown** device: marker at 0.228 s, ran the whole 12 s it was left,
             exit **0** with both success lines, and a **zero-byte** file (trap 12)
```

- **`simctl io recordVideo` has no `--time-limit`, and that is the phase's whole difficulty.**
  `simctl help io` lists `--codec`, `--display`, `--mask` and `--force` and nothing else, so
  nothing *on the device* stops a recorder: both `record_video`'s window and
  `start_recording`'s `maxDurationMs` are a deadline timer on this host whose callback sends the
  signal. **What that costs is stated rather than hidden** — a daemon that dies takes the limit
  with it, where Android's `screenrecord --time-limit` would still stop itself. The lease-end
  teardown (`discardRecording`, D9) covers every case except that one.
- **`Recording started` is the only thing that says a recording is running, and matching
  "anything on stderr" would be wrong.** The `No display specified` note lands on the same stream
  first, before any frame exists — both lines are committed verbatim as
  `recordvideo.stderr.xcode26.6-ios26.5.txt`.
- **The container is QuickTime and `moov` comes *before* `mdat`.** `ftyp` (brand `qt  `) → `moov`
  → `wide` → `mdat`, so the finished-container check and `src/verbs/recording-container.ts`'s
  shared walk both read it — `mvhd`, `trak`, `mdia`, `hdlr 'vide'` and `stsz` are all there.
  Note that `mediaTypeOf` (`src/verbs/result.ts`) sniffs the `ftyp` box and labels this
  `video/mp4` whatever the brand: accurate enough for the answer, and re-encoded by
  `src/daemon/normalise.ts` where `ffmpeg` is present.
- **An unfinished recording on this platform is a *zero-byte* file, not a headerless container.**
  `simctl` buffers and writes the whole file at the end — `Recording completed. Writing to disk.`
  is the moment it happens — so a recorder that was killed, or one that ran against a device that
  was not booted, leaves a file that is really there and holds nothing. The Android trap of an
  index written late does not arise; the same check is made anyway, because it is the honest one.
- **There is no bit rate to ask for**, so the size of a recording is whatever the screen did. At
  the driven rate above the verb layer's own `MAX_ARTIFACT_BYTES` (4 MiB) is reached in **under
  two seconds**, and a caller then gets an `artifact-too-large` refusal naming both numbers rather
  than a truncated video. `src/backends/android/backend.ts` buys its way out with
  `RECORDING_BIT_RATE_BPS`; this platform offers no equivalent, so the honest answer is that a
  recording of a busy screen is short.
- **"Is this device recording" is the *host's* process table, because the recorder is a host
  process.** `screenrecord` runs on the device, so `pidof` on the device answers it there; here
  the answer is `ps -A -o pid=,command=` matched on `io <udid> recordVideo` **and** on the program
  being `simctl` (trap 14). That is what survives a daemon restart, what sees a recorder some
  other program started, and what `discardRecording` stops a lease's abandoned recorder with.

### How a failure comes back, and why the exit code is not a vocabulary

Three subcommands made to fail on the Xcode 26.4.1 bench (2026-09-08), each run directly out of
the developer directory with no `DEVELOPER_DIR` set:

| Command | Exit | stdout | stderr |
|---|---|---|---|
| `launch <bogus-udid> com.example.nope` | **148** | *(empty)* | `Invalid device: 00000000-…` |
| `nonsense` | **1** | the whole usage text, 2931 bytes | `Unrecognized subcommand: nonsense` |
| `terminate <booted> com.rover.nope` | **3** | *(empty)* | 6 lines of `NSPOSIXErrorDomain … found nothing to terminate` |

Three different numbers for three commands, so **no meaning is attached to the number** and none
is mapped: a table built from three samples is a table that lies. Both streams are carried
instead, and the second row is why that is necessary rather than tidy — a bad subcommand puts its
useful half on *stdout*, which is "a non-zero exit is data" (`ai/CODING_STANDARDS.md`) in the same
form the Android side needs it.

**`stderr` is not silence on this platform**, so no rule may read "wrote to stderr" as "failed": a
perfectly successful `simctl io <device> screenshot <path>` prefixes its run with `Detected file
type from extension: PNG` and `Note: No display specified. Defaulting to display: … (screenID: 1,
name: LCD)`.

**The `booted` selector is matched case-insensitively**, which is why the refusal in
`src/backends/ios-simulator/simctl.ts` lowercases before comparing (#231 review). Measured on the
same bench with one device booted:

| Command | Exit | stderr |
|---|---|---|
| `terminate booted com.rover.nope` | **3** | `NSPOSIXErrorDomain … found nothing to terminate` |
| `terminate BOOTED com.rover.nope` | **3** | the same — the device was resolved |
| `terminate Booted com.rover.nope` | **3** | the same |
| `terminate bootedx com.rover.nope` | **148** | `Invalid device: bootedx` |
| `terminate notadevice com.rover.nope` | **148** | `Invalid device: notadevice` |

The near-miss is the control: `bootedx` is rejected as a device name while all three casings of
the word resolve one, so the special selector is the word and not the spelling. With **no** device
booted the three casings answer 148 and `No devices are booted.` instead (measured on the review
bench, which had none) — still a different message from `Invalid device:`, so the conclusion does
not rest on a device being up.

### Evidence for the two verbs that matter most

The whole point of a backend is the loop, so it was run as a loop: tap a card, then read the screen
back and check the tap landed. Six iterations, alternating between three cards, on the app's
"Choose your deployment method" screen:

```
iter 0: tap Cloud Access          258ms  read  221ms  selected=['Cloud Access']         OK
iter 1: tap Private Deployment    164ms  read  185ms  selected=['Private Deployment']   OK
iter 2: tap Certified Appliance   159ms  read  157ms  selected=['Certified Appliance']  OK
iter 3: tap Cloud Access          112ms  read  167ms  selected=['Cloud Access']         OK
iter 4: tap Private Deployment    143ms  read  171ms  selected=['Private Deployment']   OK
iter 5: tap Certified Appliance   138ms  read  173ms  selected=['Certified Appliance']  OK
fails=0  tap avg=162ms  read avg=179ms
```

The check is the `Selected` accessibility trait, read from the tree — not a pixel diff, and not the
tap's own return code. Confirmed independently against a screenshot: the checkmark and accent bar
moved to the tapped card.

`typeText` was verified the same way: tap the Spotlight field, `idb ui text "giotto"`, then read the
field back — `TextField 'giotto' value='giotto, Sugestia giotto'`, 138 ms, with the search results
visible in the screenshot.

**The tree is a genuine semantic read, and it works on Compose.** Compose Multiplatform draws the
whole screen into one Skia canvas, so there was every reason to expect an accessibility tree with
one opaque node in it. Instead:

```
Application  'Giotto'                                   center=(201,437)
StaticText   'Choose your deployment method'            center=(162,267)
Button       'Cloud Access, GIOTTO-HOSTED · EU-WEST …'  center=(201,355)
Button       'Private Deployment, YOUR GPUS · DC-ZRH-…' center=(201,477)
Button       'Certified Appliance, GIOTTO WORKSTATION…' center=(201,599)
StaticText   'Your documents and prompts never leave …' center=(212,694)
Button       'Connect to this node'                     center=(201,784)
```

Roles, labels, frames in points, and traits (`Button`, `Selected`, `Scrollable`). That is
`ScreenElement` with nothing missing but the id, and the id is synthesizable exactly as
`src/backends/android/screen.ts` already synthesizes one — an ordinal, with the same "stable only
for as long as the tree shape is" caveat that module already documents. The one shape difference:
`describe-all` answers a **flat list**, where uiautomator answers a tree, so the id is a flat
ordinal rather than a child-ordinal path.

**One sentence here was wrong and is corrected in place rather than deleted** (2026-09-08, #251).
It read *"`AXUniqueId` is `null` throughout, so an ordinal is the honest choice"*. The observation
was real but it was taken on this one app: all fifteen of its nodes report `AXUniqueId: null`, and
so it looked like a field iOS simply does not populate. It is not. On **Apple's own Safari** the
same read reports it on **eleven of eighteen** nodes — `BackButton`, `MoreMenuButton`,
`TabBarItemTitle` — and `favoritesItemIdentifierContent` appears on **three** of them, the three
favourites tiles. So the field exists, is absent on some apps entirely, and **is not unique within
one read** where it is present. `findOnScreen` treats two elements with one id as the backend
contradicting itself (`src/verbs/errors.ts`), so using it would make Safari's start page
unaddressable. The conclusion is unchanged and the reason for it is now stronger: the synthesised
flat ordinal is the only truthful id available. Both reads are committed —
`tests/fixtures/ios-simulator/accessibility.compose…json` and `…accessibility.uikit-textfield…json`
— so this is checkable rather than remembered.

### It is genuinely headless

`Simulator.app` was quit for this, and everything above still works:

```
Simulator.app NOT running
headless boot (simctl bootstatus -b)        5.4 s
screenshot                                  0.20 s   → full render, not a black frame
launch + tap + read-back                    selected: ['Private Deployment']
```

This matters more than it looks. Rover's host is a daemon; a backend that needed a GUI app running
in someone's session would be a backend that only works while someone is logged in and looking at
it. It does not.

---

## 3. The tooling landscape

What exists, in the order a reader is likely to reach for it.

| Tool | Ships with | Gives | Cannot |
|---|---|---|---|
| `simctl` | Xcode | boot, install, launch, terminate, screenshot, recordVideo, logs, containers, `openurl`, `push`, `privacy`, `status_bar`, `ui appearance`, `addmedia`, pasteboard | **any input**, **any tree read** |
| `devicectl` | Xcode | physical devices: enumerate, info, install, uninstall, launch, `copy` files, orientation, reboot | **no screenshot**, no input, no tree |
| `idb` | third party (Meta) | tap, multi-tap, pinch, swipe, scroll, text, key, key-sequence, button, rotate, shake, `describe-all`/`describe-point`, `set-value`, plus its own install/launch/log/video and a `--notify` target stream | edge-bit system gestures (§5) |
| WebDriverAgent / Appium | third party | everything idb does, **plus physical devices** | needs an in-device XCUITest agent, signing, a port per device |
| Host-level clicks (AppleScript / CGEvent into `Simulator.app`) | macOS | clicks and keystrokes | **TCC-gated, and not headless** |
| `SimulatorKit` private API | Xcode | the Indigo HID message layer idb is built on | nothing supported about it |

Two of those were closed off by measurement rather than by reasoning:

**Host-level UI scripting is a dead end.** `osascript` reached System Events for a process list, but
the moment it asked for UI contents it returned `-1719` — *"osascript nie ma prawa dostępu
wspomaganego"* (no accessibility access), with no prompt to grant it. That grant is a TCC
Accessibility entry for whichever binary hosts the daemon, it cannot be scripted, and it would go
stale on every update of that binary. It also requires the simulator window to exist and be
positioned, which §2's headless result makes pointless. Ruled out.

**The private path is real, and idb is already on it.** `SimulatorKit.framework` in Xcode 26.6 still
exports `SimDeviceLegacyHIDClient` (`initWithDevice:error:`, `send:freeWhenDone:completionQueue:`)
and the whole `IndigoHIDMessageFor…` builder family — button, keyboard, mouse, scroll, pressure,
trackpad, digital crown. `IndigoHIDMessageStruct` is Objective-C-visible, so a from-scratch injector
is buildable, and idb's own `PrivateHeaders/SimulatorApp/Indigo.h` documents the touch struct and
the five edge codes down to byte offsets. Building our own is therefore *possible* — and pointless
as a first move, because it is precisely what idb already maintains against each Xcode release.
Worth knowing about only for §5's `recents` gap and as the fallback if idb ever dies.

---

## 4. What idb actually is, and what it costs

`ai/ARCHITECTURE.md` calls idb "a heavy dependency with its own lifecycle". Both halves stand, but
the dependency is **alive**, which is the part worth updating:

- Release **v1.5.2 on 2026-09-01**; commits landing the day this was written (2026-09-08); repo not
  archived. The private headers in it are annotated against **Xcode 26.2**. **v1.5.4 was published
  later the same day** — which is how alive this dependency is, and why a fixture here carries the
  companion version in its filename and a newer one is a second fixture beside it rather than an
  edit to it. Everything measured below is v1.5.2.
- It ships a **prebuilt `idb-companion.macos-arm64.tar.gz`** and an `arm64_tahoe` Homebrew bottle.
  Nothing was compiled to get the results above; the tarball was unpacked into a scratch directory
  and run in place. `brew` no longer carries `idb-companion` in core — the old `facebook/fb` tap is
  gone — so the release asset is the install path. **Rover now walks that path itself**: `rover
  doctor --fix` fetches the pinned asset on the host, checks it against the release's own `.sha256`
  and unpacks it into `~/.rover/idb-companion-<version>/`, which is the third row of the search
  (`PROJECT.md` D39). Everything below still describes the same asset — what changed is who
  unpacks it, and that an operator no longer has to choose a directory and an environment variable
  to go with it.
- **That install has now been performed in this repository's own bench**, on 2026-09-08, and this
  bullet is the report of it rather than of somebody else's machine. v1.5.2's asset was fetched,
  checksummed against the release's own `.sha256`
  (`f17b718a513931705542a7fbfa9cfc11895ee191562c9ffd2343cf7f8254bc08`) and unpacked into a scratch
  directory, and `ROVER_IDB_COMPANION_PATH` was pointed at the binary in place. Nothing was
  installed into a shared prefix, and nothing from the tarball is in the repository. The unpacked
  tree is `idb_companion` and `idb-repl` beside a `Resources/` directory and three
  `swift-*.bundle`s — so the binary **cannot be moved out on its own**, which is a second reason
  the search takes the operator's path verbatim rather than appending a name to a directory.
  ```bash
  curl -LO https://github.com/facebook/idb/releases/download/v1.5.2/idb-companion.macos-arm64.tar.gz
  curl -LO https://github.com/facebook/idb/releases/download/v1.5.2/idb-companion.macos-arm64.tar.gz.sha256
  shasum -a 256 -c idb-companion.macos-arm64.tar.gz.sha256
  tar xzf idb-companion.macos-arm64.tar.gz
  export ROVER_IDB_COMPANION_PATH="$PWD/idb_companion"
  ```
- **`--version` does not print a version.** Measured here on the v1.5.2 asset: it writes
  `{"build_date":"Sep 1 2026","build_time":"08:51:20"}` to stdout and exits 0, and the build date
  is the only thing in it. So the version a capture is pinned to is the **release tag it was
  downloaded from**, not something the program can be asked for, and
  `tests/fixtures/ios-simulator/` records it that way. `--help` lists the mode flags and exits;
  neither was measured for side effects, which is why
  `src/backends/ios-simulator/idb-companion-path.ts` accepts a candidate on the filesystem rather
  than by running it.
- **`--notify stdout` writes one JSON array per line, newline-terminated**, and each line is the
  full current set — confirmed here, not only in §7. The target shape is six keys:
  `{"udid","type","name","model","os_version","state"}`, with `type` `Simulator`, `state` the same
  words `simctl` prints (`Booted`, `Booting`, `Shutting Down`, `Shutdown`) and **`os_version`
  carrying the platform word** — `iOS 26.5`, where `simctl`'s runtime reports a bare `26.5` for
  that same runtime. Key order varies between frames. The capture is committed as
  `tests/fixtures/ios-simulator/idb-notify.idbcompanion1.5.2-xcode26.6-ios26.5.txt`, and the
  spelling difference is why `src/backends/ios-simulator/devices.ts` normalises this path's
  version onto `simctl`'s rather than publishing two spellings for one device.
- The Python client is a convenience, not the interface. The companion is a **gRPC server**
  (`--grpc-port`), which is what a Node backend would speak, dropping the Python dependency and the
  ~70 ms per-call CLI startup entirely.
- **That transport is now built, and the numbers below are this repository's own** (#250,
  `src/backends/ios-simulator/idb-client.ts`): companion v1.5.2 driven from Node over
  `@grpc/grpc-js`, against the booted `iPhone 17` on this bench, 2026-09-08.

  **How the companion is reached was measured rather than assumed, and both routes work.** The
  companion reports what it bound, on stdout, as one newline-terminated JSON line — so nothing has
  to pre-bind a free port on this host to find out which one it took:

  | argv | stdout | listening on |
  | --- | --- | --- |
  | `--grpc-port 0` | `{"grpc_port":56927,"grpc_swift_port":56927}` | `Swift server started on [IPv6]::/:::56927` |
  | `--grpc-domain-sock <path>` | `{"grpc_path":"<path>"}` | `Swift server started on [UDS]<path>` |

  **Rover takes the socket**, and the port column is why. `[IPv6]::` is *every interface*, and the
  companion authenticates nothing — so an ephemeral port carrying the full companion API is a way
  round the lease layer for anybody who can reach the host, on a daemon whose whole shape is being
  reachable over the network (D17). Nothing arbitrates in this stack (below), so that lock is the
  only one there is. A socket file under the daemon's own `mkdtemp` directory is reachable by
  whoever can already read this host's filesystem, which is a much smaller set.

  **Start latency, from `spawn` to a call answered: ~420 ms.** The socket was reported at
  **+353 ms** and `describe` answered at **+423 ms**; a second `describe` on the established
  channel came back in **1 ms**, against the ~70 ms every CLI measurement in this document paid.
  Both waits are conditions with one shared deadline (`src/core/wait.ts`), never a sleep.

  **One trap, and it would have made every crash unreadable:** gRPC sees the socket close before
  Node reports the child's `close`, so a companion that dies mid-call is reported by the library as
  `14 UNAVAILABLE: Connection dropped` — a sentence about a transport, from which nobody could tell
  that the program a person can restart is what died. `UNAVAILABLE`, and only `UNAVAILABLE`, is
  therefore given a short bounded grace to be explained by the process ending.

- **The first thing built on that transport is the screen read, and its cost is not where it looks**
  (#251, `readScreen` in `src/backends/ios-simulator/backend.ts`). The call is
  `accessibility_info` in its **`LEGACY`** format — one flat JSON array of the nodes on the screen,
  which is the shape `ScreenElement[]` is and the one `idb ui describe-all` asks for. Same bench,
  same booted `iPhone 17`, driven through this repository's own client:

  ```
  companion start, spawn → socket → describe answered   350–423 ms
  first accessibility_info of that companion's life     3.34 s
  every accessibility_info after it, same companion     34–47 ms
  ```

  **The 3.34 s is the simulator loading `AccessibilityPlatformTranslation`, not idb being slow.**
  It is paid once per companion and never again, and it is two orders of magnitude inside the
  client's call timeout — but it is also the one number a caller would mistake for a hang, which is
  why `readScreen` states it rather than leaving it to be discovered. The warm figure is what
  §2's table now carries in place of the 0.16–0.22 s measured before: that number was
  `idb ui describe-all`, and ~70 ms of it was the Python CLI starting.

  **The other two formats were captured and rejected, and the reason is in the parser rather than
  in folklore.** `NESTED` answers the same nodes as a tree, so a consumer flattens one to ask the
  same question. `COMPLETE` renames every key (`AXLabel` → `label`, `AXUniqueId` → `identifier`),
  drops `role` and `AXFrame`, and wraps the tree in a provenance document — and its own proto
  comment says an older server silently serves `LEGACY` instead, so a client asking for it must be
  able to read both shapes anyway.

- **A read against a device that is not booted is refused properly, and the backend refuses first
  anyway.** Measured against a `Shutdown` iPhone 17 Pro, 2026-09-08: `accessibility_info` came back
  at gRPC `INTERNAL` in **13 ms**, *"Cannot run accessibility commands against `<udid>` | iPhone 17
  Pro | Shutdown | … as it is not booted"*. So this is not `screenshot`'s 60.68 s block (§2) and
  there is no tool timeout to pre-empt — the state check in front of `readScreen` is there for a
  **process** rather than for the answer. Reaching that refusal means starting a companion for the
  device first, and the companion then *stays running*: it announces on its own stderr that it
  "will stay alive if target goes offline". A backend that skipped the check would leave one
  supervised `idb_companion` per unbootable device anybody asked about, for the lifetime of the
  daemon, to deliver an answer `simctl list devices` already had.

- **A pooled companion survives its target's shutdown *and* answers correctly after it boots again
  — measured, 2026-09-09.** This is the one state change the companion pool cannot observe for
  itself (`src/backends/ios-simulator/idb-client.ts` runs no timer and no health check), so the
  reuse either had to be measured or the pool had to be invalidated whenever a device left `ready`;
  the measurement is what decided it. Taken on a **throwaway** `iPhone 17 Pro` created for the run
  and deleted after it (`simctl create`/`delete`, runtime iOS 26.4.1, companion v1.5.2), never on a
  device another agent might hold: read → `simctl shutdown` → read → `simctl boot` → read → read,
  all four through **one** `IdbCompanions` pool, run twice.

  ```
  read 1, fresh companion                          586 ms / 4.37 s   (14 / 3 nodes)
  read 2, warm channel                              62 ms / 42 ms
  read 3, device Shutdown, companion from before    gRPC INTERNAL in 4–6 ms, "not booted"
  read 4, device Booted again, SAME companion      163 ms / 801 ms    (3 nodes, AXApplication first)
  read 5, warm channel after the reboot             24 ms
  ```

  So the companion is genuinely target-lifecycle-independent: it neither dies with its target nor
  goes deaf to it, the refusal in between is the same well-behaved `INTERNAL` the state check
  pre-empts, and the first read after the target returns costs a fraction of a companion's own
  first read rather than another 3.34 s — the translation stays loaded in the *companion*, not in
  the simulator. `readScreen` therefore needs no pool invalidation on a state change, and the
  differing node counts are the screen differing (Springboard mid-boot against a settled one), not
  the read being wrong. **Deliberately not a case in `tests/device/ios-simulator/read-screen.test.ts`:**
  that suite is read-only by design so it is safe against a device somebody else is looking at, and
  a case that shuts a simulator down and boots it is the one thing that would take that away.

- **The four input primitives are the next thing on that transport, and every one of them is
  verified by reading the screen back rather than by the call returning** (#252,
  `src/backends/ios-simulator/input.ts`). Same bench, the booted `iPhone 17` `997FA43E-…`,
  companion v1.5.2, 2026-09-09, driven through this repository's own code. **`hid` is the only RPC
  behind all four** — there is no tap call and no text call, only `rpc hid(stream HIDEvent)`, so
  what separates a tap from a swipe from a line of text is entirely which events are built, and
  the client needed a second call shape (client-streaming) beside the unary one.

  ```
  §2's loop, re-run through this backend  6/6 typed read back exactly, 6/6 taps cleared the field
  tap                                     106–144 ms (n=7, mean 129)
  readScreen between the injections        135–368 ms (n=20, mean 219)
  typeText, one 5–6 character word        102–154 ms (n=7, mean 119)
  typeText, all 95 printable ASCII        219–315 ms through the backend, 114 ms of it the stream
  pressKey('home')                        104–197 ms (n=5, mean 164)
  pressKey('wake') on a woken device      424–557 ms (n=5) and it sends nothing — the guard read
  pressKey('back') / ('recents')          refused in under 1 ms, with no round trip at all
  swipe 250 ms asked for                  452 ms wall through the backend
  ```

  **What the loop is is the point.** `hid` answers an empty `HIDResponse` and answers it just as
  happily for nonsense: a keycode of `9999`, a touch at `NaN`, a touch at `(99999, 99999)`, a
  swipe of `NaN` seconds and a swipe of `-1` seconds were each accepted, at exit 0, with nothing
  done. So a suite asserting "the call resolved" would be green on a backend that injected
  nothing, and `tests/device/ios-simulator/input.test.ts` types a word into Spotlight, reads the
  field back, taps the 20×19-point control inside it and reads the field back again. That tiny
  target is also what would catch a `toDevicePixels` analogue being added to match the Android
  side: **idb takes points**, the same unit `ScreenInfo` and `readScreen` use, so a ×3 conversion
  would put the tap off the panel.

  **The other three things measured before the map was written:**

  - **`HIDSwipe.duration` is in seconds** where every duration in this contract is milliseconds,
    so an unconverted number is a swipe a thousand times too long that the companion accepts.
    0.05 s took 72 ms of wall clock, 0.25 s 345 ms, 0.3 s 405 ms and 1.5 s 1,660 ms — the value
    honoured with ~100 ms over it. A **zero** duration is dispatched and moves nothing (3 ms, the
    home screen on the same page), unlike Android's `input swipe … 0`, which is a flick.
  - **A swipe from a point to itself is the long press**, so `src/verbs/input.ts` needs nothing new
    here: held 0.8 s on a Springboard icon it raised the context menu (856 ms wall).
  - **idb's keyboard map is the *client's*, not the companion's** (`idb/common/hid.py`), so a
    backend speaking gRPC has to carry it. Transcribed and then verified as a whole: all 95
    printable ASCII characters in one stream came back out of a text field byte-identical.
  - **An injection against a device that is not booted is refused properly** — a tap and a `HOME`
    press against a `Shutdown` `iPhone 17 Pro` came back at gRPC `INTERNAL` in 214 ms and 3 ms,
    *"Mach port not connected, device may not be ready yet"*. As with `readScreen`, the state
    check in front of them is there for the **process** rather than for the answer.

The lifecycle is the real cost, and it has teeth:

- **One companion process per target**, started with `--udid`, and it must be supervised. Killing it
  does **not** disturb the simulator (verified: device stayed `Booted` across companion exit), so
  the supervision is Rover's business and only Rover's. **Re-run through this repository's own code
  since** (`tests/device/ios-simulator/idb.test.ts`, #250): a companion is started for the booted
  device, answers `describe`, is killed, and `describeDevice` still reports the device `ready` —
  after which the next call starts a fresh one and is answered normally. That case is the evidence
  the supervision is Rover's alone, and it is gated on `ROVER_TEST_SIMULATOR` **and**
  `ROVER_TEST_IDB` so a host without either skips rather than fails.
- **`idb file push` crashes the companion.** Reproduced twice, deterministically, on v1.5.2:
  ```
  Start of push
  push called with: []
  Receive frame of push
  NIOCore/NIOThrowingAsyncSequenceProducer.swift:868: Fatal error:
  NIOThrowingAsyncSequenceProducer allows only a single AsyncIterator to be created
  ```
  Exit 133 (SIGTRAP), the whole process, taking every other in-flight call for that device with it.
  `idb file pull` and `idb file ls` are fine. **So do not route `pushFile` through idb at all** — a
  simulator's data container is a host path (§2), and `cp` neither crashes nor needs a daemon.
  That rule now has an executable half rather than a paragraph
  (`tests/unit/backends/ios-simulator/no-idb-file-push.test.ts`, #250): the RPC name is read out of
  the vendored proto so a rename cannot make the gate pass silently, it is kept off the closed list
  the client's call surface is typed from, no file that can reach a companion names it, and exactly
  one module in `src/` is allowed to hold a channel at all.
- **Nothing arbitrates.** Two companions were started on the same UDID, on different ports, and both
  bound and both accepted commands. There is no device locking anywhere in this stack — which is
  exactly the hole Rover's lease layer exists to fill, and it means the iOS backend inherits *all*
  of the two-agents-one-device risk rather than some of it.

---

## 5. Where the vocabulary does not line up

Four asymmetries. Three are declared, and the fourth is now decided in shared code (#215).

**`canControlNetwork` is `false`, and that is the honest answer.** A simulator has no airplane mode
and no wifi toggle: it uses the host's network stack, so the only truthful implementation of
`setWifiEnabled` would be to change the *host's* networking — unacceptable on a machine lending
devices to other people. `simctl status_bar override --wifiMode failed` exists and is **cosmetic**:
it draws a different icon and changes nothing about reachability. That is precisely the
"plausible-looking result where the honest answer is *this device cannot do that*" the rules forbid
(`ai/RULES.md` §2). Declare `false`, let `MissingCapabilityError` fire, and never wire the status bar
to it.

**That is what shipped** (#230). `src/backends/ios-simulator/capabilities.ts` declares the flag
`false` and the class carries **no** `setAirplaneMode` and **no** `setWifiEnabled` at all — an
absent method beside a `false` flag is a complete backend, and a stub beside it is one under
construction. It is also the repository's first registered manifest with a capability declared
`false`, so `set_wifi` and `set_airplane_mode` over a lease on a real simulator are the first
`missing-capability` refusals in this project that come from a device rather than from a synthetic
backend — asserted as such in `tests/device/ios-simulator/verb-dispatch.test.ts`.

**`DeviceKey` has four members and iOS answers two of them.** The row that said "two and a half"
is **corrected in place with its reason rewritten** (2026-09-09, #252, `ai/RULES.md` §1): `wake`
turned out to be a whole answer rather than half of one, and `back` turned out not to be one at
all.

| `DeviceKey` | iOS | Notes |
|---|---|---|
| `home` | ✅ `HIDButtonType.HOME` | Works on a home-buttonless iPhone 17 — verified from Maps, Safari and Settings, and Springboard came back every time |
| `wake` | ✅ `HIDButtonType.LOCK`, guarded by a read | LOCK **toggles**, where Android's `KEYCODE_WAKEUP` does not — so the press is conditional on `com.apple.springboard.hasBlankedScreen`, read with `simctl spawn <udid> notifyutil -g <name>` in ~360 ms. **That read exists, which is what decides this row**: from a woken device the first press took the flag to `1` and every press after it toggled `1, 0, 1, 0`, following the press in 1,861 ms going dark and 347 ms coming back, and three guarded `wake`s in a row left it at `0` |
| `back` | ❌ | **Reversed in place.** This row read "⚠️ left-edge swipe, verified working" on the strength of one drill into Settings → General. Driven through idb on 2026-09-09 the same `2,450 → 300,450` swipe **paged the home screen** on Springboard and did **nothing** on a Settings sheet, both at exit 0 — silent in one direction and wrong in the other, which is the substitute `pressKey` must not make. Refused by name; on iOS back is a control in the app's own UI, which `read_screen` + `tap` reaches by label |
| `recents` | ❌ | No button, and the app-switcher gesture needs the Indigo *edge bits* (`Indigo.h`: the guest recognises system edge gestures "from these bits, not from the contact coordinates"). idb's swipe does not set them; a slow 1.2 s bottom-edge swipe did nothing. Unreachable without patching idb or sending our own HID messages |

`pressKey` is one method behind one capability, so a backend that declares `canInput` would
otherwise claim all four keys. **`pressKey` grew the per-key failure** (#215): a key the device has
no equivalent for is `UnsupportedKeyError`, which reaches the agent as an `unsupported-key` verb
failure carrying the serial and *the key* — `unsupported-text`'s model one argument down, and
deliberately distinct from `missing-capability`, because a backend that takes input and lacks one
key is a narrower backend rather than one without input. So this backend answers the keys it has
and refuses the ones it does not, without lying in either direction:

- **`recents` is refused by name, not implemented.** Accepted 2026-09-08. There is nothing behind
  it that is the app switcher, and answering with something else would be the silent degradation
  `ai/RULES.md` §2 forbids.
- **`back` is refused by name too, and that is this section's own reversal** (#252). It read
  "needs nothing from the vocabulary" on the strength of the left-edge swipe working where an app
  supports interactive pop — measured once, in Settings. Driven through this backend it paged
  Springboard and did nothing on a modal sheet, at exit 0 both times, so what the caller would get
  is a gesture that is sometimes some *other* navigation and sometimes silence. The rest of that
  bullet stands and is why nothing is lost: back on iOS is a control in the app's own UI, which
  `read_screen` + `tap` reaches by label.
- **`wake` is answered and idempotent, and the read it needs exists** (#252). What made it
  half an answer was `LOCK` being a toggle with nothing to condition the press on; the flag in the
  table above is that condition, and this backend reads it before every `wake` and presses only
  when the screen is off. **It is the blanked-screen flag rather than the lock state**, which is
  the correction inside the correction: `LOCK` does not unlock — a locked, woken simulator stays
  locked however many times it is pressed — so lock state is the wrong question, and the right one
  is the same one Android's `KEYCODE_WAKEUP` answers, which also lights a device up and leaves it
  on its lock screen.

  **The read reports the flag and cannot prove it exists, and that is stated because it cannot be
  fixed.** `notifyutil -g` answers `<name> 0` for a name with no state at all — measured against a
  name invented for the purpose, indistinguishable from a woken device at exit 0 with nothing on
  stderr — so on a runtime that stopped publishing this key a `wake` would read "already awake"
  and press nothing. What guards it is `tests/device/ios-simulator/input.test.ts`, which drives
  the flag through **both** values against the runtime in front of it and fails if it stops
  moving.

D11 is untouched by any of it: capabilities still name *methods*, the keys are that method's
arguments, and no per-key flag was added (`PROJECT.md` §5).

**`LogLevel` has no `warn` on iOS, and gains a value that is not a level.** The unified log's
`messageType` is `Debug | Info | Default | Error | Fault` — nothing maps onto `warn` — and entries
come through with `messageType: "None"` as well. Mapping is therefore
`Debug→debug, Info→info, Default→info, Error→error, Fault→fatal`, and **`None→info`** (#219).
`verbose` and `warn` would simply never be produced by this backend, which is fine (the enum is a
superset by design).

`None` needed a home and dropping the line was never it, so it takes `info` — and it shares that
destination with two other shapes, under one rule stated in
`src/backends/ios-simulator/parsers/unified-log.ts`: a level that could not be read is not evidence
of severity in either direction, and a dropped line puts a silent hole in the one verb whose job is
to show what a screenshot cannot. The other two are worth knowing before writing a predicate:

- **An entry with no `messageType` key at all is the ordinary case, not a corrupt line.** Every
  entry that is not a `logEvent` — `activityCreateEvent`, `stateEvent`, `timesyncEvent` — carries
  none: 25,422 of 195,947 entries in a 30-minute unfiltered capture on the Xcode 26.4.1 bench that
  produced `tests/fixtures/ios-simulator/`. An activity a process created is still something the
  device said.
- **A level word a later release invents** takes the same route, rather than being guessed at.

Two more measured facts from that bench, both pinned by fixtures: **`"None"` did not appear once**
in those 195,947 entries, so the parser's handling of it is pinned by an inline test case on this
document's evidence rather than by a capture; and **`log show` omits `Info` and `Debug` unless
`--info --debug` are passed**, so a `readLogs` that leaves them off reports a log with two of the
five levels missing.

**Logs must be scoped in the query or they are useless — and the scope `readLogs` can push down is
not a predicate.** Unfiltered, `log show --last 20s` returned **92,204 entries** here; the same
window with `--predicate 'process == "Giotto"'` returned 268. A read that filters after the fact
spends seconds serializing noise before `maxEntries` throws it away, and that rule is untouched.

What this section concluded from it — that `readLogs` pushes the **process** filter down — is
**reversed in place with its reason rewritten** (#229, `ai/RULES.md` §1). It cannot:
`ReadLogsOptions` carries `maxEntries` and nothing else (`src/core/device.ts`), so there is no
process to filter *by*, and inventing one would answer a narrower question than the caller asked.
What is pushed down instead is the **device** and a **window**, which are the other two bounds this
command has:

- **`simctl spawn` is itself the device scope.** The query runs inside the simulator rather than
  against this Mac's log: on the second bench (macOS 26.6.2 / Xcode 26.4.1, 2026-09-08) a
  20-second read came back holding `launchd_sim`, `locationd`, `backboardd` and `SpringBoard` and
  nothing of the host's — 1,958 entries against 2,766 for the same window of the host's own log.
  That bench is far quieter than the 92,204 above; what carries over from that number is the shape
  of its point rather than its size.
- **A widening window is the rest of it**, `30s → 2m → 5m`, and the widening is the part that took
  two goes. The single `--last 30s` this section first recorded was chosen against the contract's
  own 5,000-entry ceiling (`MAX_LOG_ENTRIES`) at a measured 67–160 entries per second — but 30 s at
  that rate holds 2,000–4,800 entries, which is *below* the ceiling, so a caller asking for 5,000
  was handed everything the window had together with `truncated: false`: told, by the one flag that
  exists to say otherwise, that nothing older was dropped. Corrected in place with its reason
  rewritten (#239 review). `readLogs` now re-reads at the next width while the device said no more
  than the cap, so the **cap** binds the answer the way `logcat -t` does on Android, and only the
  widest width may answer `truncated: false`. Measured on the same bench, 2026-09-08: `30s` 2,053
  entries / 2.6 MB / 1.01 s, `2m` 8,712 / 10.9 MB / 1.13 s, `5m` 34,819 / 42.8 MB / 1.75 s — the
  cost is nearly flat in the width, because a read spends `simctl spawn`'s start-up rather than the
  window. **The widening is self-limiting in *latency***: a device chatty enough to fill the cap
  fills it at `30s` and is never re-read, so the widest read only happens on a device quiet enough
  for it to be cheap. `5m` is the horizon; reaching past it is a bound the caller cannot ask for,
  and widening `ReadLogsOptions` to let them is a contract change and its own issue, not something
  a backend improvises.
- **It is not self-limiting in *bytes*, and the claim that it was is reversed in place** (#239
  second pass). This section said the widest read costs ~12,500 entries and about 15 MB at the
  ceiling, well inside the 64 MB buffer; that inferred a size from a *rate*, and a log read is
  asked **after** something happened, which is exactly where the rate is not uniform. A burst that
  has aged out of the narrowest width is still inside a wider one, so the wider read is large
  precisely when the narrow one came back quiet. Measured on the same bench on a simulator a minute
  past boot: `30s` 94,154 entries / **113.6 MB**, `2m` 160,587 / 191.8 MB, `5m` 195,444 / 232.4 MB,
  and on a second device type read seconds after boot `30s` 107.9 MB, `2m` **576.8 MB**, `5m`
  756.4 MB — every width past the buffer, and an overflow is a killed child and a lost answer
  rather than a truncation. So the escalation is bounded by bytes too: **a wider width that overflows ends the
  widening**, and the narrower width's answer stands, sliced to the cap and flagged
  `truncated: true` — an overflow being positive proof the device said far more than the cap.
  Raising the buffer instead would be chasing an *idle* device's 756 MB. An overflow at the
  **narrowest** width still fails loudly, because nothing came back to keep and the partial buffer
  holds the *oldest* bytes of the window where the newest are what was asked for; on this bench
  that is reachable for the first half-minute after a boot at any cap, and at the very peak of the
  burst the ten-second budget refuses first (§8 trap 11). What would answer it is a
  streaming read keeping a rolling tail of `maxEntries + 1` lines — Android's `logcat -t` guarantee
  — and `simctl.ts` runs `execFile` only, so that is a change of its own (PROJECT.md R45).

---

## 6. Physical devices: the required-method wall

`devicectl` is Apple's supported path to a real iPhone, and its subcommand list is: `copy`, `info`,
`install`, `notification`, `orientation`, `process`, `reboot`, `sysdiagnose`, `uninstall`. Read that
list again for what is absent — **there is no screenshot**, no tap, no tree.

`screenshot` is a **required** method of `DeviceBackend`, not a capability. A backend that cannot
answer it cannot be registered honestly. So for a physical iPhone the options are:

1. **A WebDriverAgent-class in-device agent** — an XCUITest bundle running on the device, driven over
   HTTP, giving screenshot, tree and input in one dependency. That is what Appium does, and it is
   the only path that clears the wall. It costs: a developer-signed build per device, a provisioning
   profile, a port per device, and an agent process whose crash is a device outage.
2. **Don't lend physical iPhones.** Simulators only, and say so.

No physical iOS device was attached, so **nothing in this section is measured** — it is read off the
tool's own help output and marked accordingly.

---

## 7. Attachment, leases and enumeration

**`watchDevices` gets a real stream.** `idb_companion --notify stdout` emits a **full JSON array of
every target on every change** — which is `DeviceWatcher.onDevices`'s contract to the letter ("The
full current set: once on subscription, and again on every change. Never a delta"). Booting a second
simulator produced exactly three updates, `Shutdown → Booting → Booted`, with no polling anywhere.
So iOS enumeration is *not* condemned to a poll; `simctl list` is the poll, and it is the fallback,
not the design.

The framing and the target's key set are §4's, measured on this repository's own bench and
committed as `tests/fixtures/ios-simulator/idb-notify.idbcompanion1.5.2-xcode26.6-ios26.5.txt`: one
JSON array per line, newline-terminated, each line the full set.

**`watchDevices` drives that stream now** (#249), and the poll is what a host with no companion
still watches its devices through. Three things about the arrangement, each of which is a decision
rather than an implementation detail:

- **Only one source delivers at a time.** A frame is what proves the stream is healthy, so a frame
  is what takes the watch off the poll; losing the stream hands it back. While the stream is up,
  `simctl list` is not run at all — not once per gap, not once ever.
- **A lost view is one `onInterrupted`, never an empty set**, and the view is whichever source is
  serving the caller. So the fallback costs exactly one interruption — carrying
  `IDB_COMPANION_MISSING` when there is no companion to run and `null` otherwise — and a retry
  that fails again while the poll is delivering is silent, because nothing the caller can observe
  changed.
- **The companion is restarted on a doubling backoff**, 250 ms to 5 s, reset by a frame. Mandatory
  rather than tidy: a companion is a host process nothing else supervises, `idb file push` crashes
  one outright (§4), and an `idb_companion` unpacked onto a *running* host is exactly what a
  restart picks up — the search is unmemoised for that reason.

`listDevices`, `describeDevice` and `deviceInfo` still read `simctl`, and deliberately: idb is not
a second source of truth for an enumeration a lease grant re-verifies through `simctl` (D6). What
makes the two safe to mix is that `src/backends/ios-simulator/devices.ts` normalises the notify
path's `os_version` onto `simctl`'s spelling rather than publishing both.

**Driven end to end on this bench, 2026-09-08** (companion v1.5.2, Xcode 26.6, macOS 26.6.2), with
`watchDevices` subscribed and one `iPhone 17 Pro` booted and shut down again through `simctl boot`
/ `bootstatus -b` / `simctl shutdown` — the recipe `tests/fixtures/ios-simulator/README.md`
documents, so the device was left exactly as found:

```
  +0ms     11 devices  target=offline     ← the set on subscription
  +326ms   11 devices  target=ready       ← Booted
  +3754ms  11 devices  target=offline     ← Shutdown
zero interruptions
```

Three deliveries, each the full set of eleven, with no `simctl list` run at all. **The `Booting`
frame is not missing — it is collapsed**, and that is the delivery rule rather than a dropped
event: `Booting` and `Shutdown` both map to `offline`, so the set the caller would have been handed
was the one it already had. The companion emits per change *it* sees; the watch delivers per change
a **caller** can see. Trap 15 in §8 is what had to be fixed before any of this arrived at all.

**D18 is harder on iOS than on Android, and the field that decides it is `transportType`.**
`devicectl list devices` on this machine — with no phone plugged in and none nearby — reported:

```json
{"name": "iPhone (Jacek)", "udid": "00008030-000961893E07C02E", "platform": "iOS",
 "osVersion": "26.4.2", "tunnelState": "unavailable", "transportType": null,
 "pairingState": "paired",
 "potentialHostnames": ["iPhone-Jacek.coredevice.local", …]}
```

A device that is **paired but absent** shows up in the enumeration with a name, a udid, an OS
version and a hostname. Android's equivalent trap needed someone to run `adb connect` first; iOS
serves it by default, forever, for every iPhone this Mac has ever been paired with. The
classification that follows:

| Kind | `attachment` | `state` |
|---|---|---|
| Simulator | `this-host` — it *is* this machine | from `state`: `Booted`→`ready`, everything else not-ready |
| Physical, `transportType: wired` | `this-host` | needs `tunnelState: connected` to be `ready` |
| Physical, `transportType: localNetwork` | `another-host` — reached over the network, D18's letter | — |
| Physical, `tunnelState: unavailable` | not admissible either way | never `ready` |

**A simulator can go from `Booted` to `Shutdown` without the daemon touching it.** Quitting
`Simulator.app` shuts down every device it has open — observed here, and it is the likeliest
explanation for a shutdown mid-session that nothing in the test script asked for. D6's
"re-verify at every lease grant" and "a device that vanished mid-lease is a first-class case" are
not theoretical on this platform; the `--notify` stream reports the transition, which is what makes
them recoverable.

**Lease costs, for the restore-on-release arithmetic:** warm boot 5.4 s, cold boot (`bootstatus -b`
on a shut-down device) 15.7 s, shutdown ~0.4 s, install 0.3 s warm / 2.7–3.8 s first, uninstall
0.13 s. `simctl bootstatus` blocks until the device is actually ready and is the wait-on-condition
primitive to use — there is no reason for a sleep anywhere in this backend. `simctl erase` is the
full factory reset if state restoration ever needs one.

---

## 8. Traps, each one hit here

1. **`screenshot` on a shut-down simulator hangs for 60 seconds** and then fails with *"Timeout
   waiting for screen surfaces"*. Not an error, not fast — a minute of a lease spent on a call that
   was never going to work. Check `state == Booted` first, and put a timeout on the capture
   regardless. Both halves are in `IosSimulatorDeviceBackend.screenshot` (#229), because the state
   can change between the check and the capture; re-measured at **60.68 s** on the second bench
   (macOS 26.6.2 / Xcode 26.4.1, 2026-09-08) against 0.12 s for the refusal that replaces it.
2. **`idb file push` kills the companion** (§4). Use the host path.
3. **`xcode-select -p` may point at CommandLineTools**, where `simctl` does not exist (§1).
4. **Quitting `Simulator.app` shuts down every booted device** (§7). The GUI app is not a viewer;
   it is an owner. Prefer never launching it.
5. **`--mask` on capture.** `simctl io screenshot` and `recordVideo` take `--mask ignored|alpha|black`
   for non-rectangular displays. The default gives a rounded-corner PNG with alpha; anything doing
   arithmetic on the frame wants `ignored`.
6. **The pixel/point conversion has a right answer here.** `profile.plist` carries
   `mainScreenWidth/Height` (1206×2622), `mainScreenScale` (3) and `mainScreenWidthDPI` (460), so
   `densityScale` comes from the device and never from a screenshot's width — the same error
   `../giotto-ai-demo/docs/AGENT_UI_TESTS.md` §3 records costing a day on the Android side. Note
   that idb's own `describe` reports `density: 3.0`, which is the **scale**, not dpi; `ScreenInfo`
   wants 460 for `density` and 3 for `densityScale`, and taking idb's word for it puts a
   153-times-wrong number in the field. **`profile.plist` is a *binary* property list**
   (`bplist00`) at `<bundlePath>/Contents/Resources/profile.plist`, on all 124 device types
   Xcode 26.4.1 installs — checked 2026-09-08, on the second bench of
   `tests/fixtures/ios-simulator/README.md` rather than this section's. So the XML parser this
   repository already depends on cannot read it, and the `bundlePath` comes from
   `simctl list -j devicetypes`: the bundles live under `/Library/Developer/CoreSimulator/`, not
   under `DEVELOPER_DIR`, so an Xcode-relative path finds none of them.
7. **The tree is system-wide, not app-scoped.** `describe-all` on Springboard listed every icon;
   there is no "only the app under test" mode. Fine for a simulator, worth knowing before it
   surprises someone.
8. **A screenshot on iOS cannot be blocked by the app.** The Android build of this same app sets
   `FLAG_SECURE` and photographs as a black frame — the failure mode
   `../giotto-ai-demo/docs/AGENT_UI_TESTS.md` §6 exists for. iOS has no equivalent flag, and the
   capture came back fully rendered every time. So the `canReadScreen`-as-last-resort argument for
   Android does not carry over; on iOS the tree is a convenience, not a rescue.

9. **Some of `simctl`'s failure text is localized and some is not, and only one of them is safe
   to write a predicate over.** On a host whose UI language is Polish, a failed `simctl install`
   came back as *"App installation failed: Nie można zainstalować „Rover”"* — the
   `IXUserPresentableErrorDomain` half is translated — while `simctl terminate`'s *"found nothing
   to terminate"*, captured minutes later on the same host, is English. So a check on a
   user-presentable message passes on the machine it was written on and fails on the next one, and
   the wording `src/backends/ios-simulator/parsers/app-control.ts` matches is deliberately not one
   (measured on Xcode 26.4.1, 2026-09-08). Anyone re-capturing a fixture on a differently
   localized host has to check that half again rather than assume it.

10. **`simctl io screenshot` will not write to stdout, and will not write to a relative path
    either.** `simctl help io` documents `-` for stdout. On Xcode 26.4.1 that route is broken:
    `io <udid> screenshot --type png --mask ignored -` — and a bare `screenshot -`, with stdout a
    pipe and with stdout redirected to a file alike — exits non-zero having written nothing, with
    *"An error was encountered processing the command (domain=NSCocoaErrorDomain, code=642)"* and
    *"You can’t save the file “-” because the volume “Macintosh HD” is read only"*. The `-` is
    taken as a file **name**, and resolved against a directory the caller does not choose: the
    same command with `shot.png` from a writable working directory fails identically, while an
    absolute path prints `Wrote screenshot to: …` and produces the PNG. So a capture goes to a
    file the backend stages and removes, at an absolute path, and never to a stream (measured on
    macOS 26.6.2 / Xcode 26.4.1, 2026-09-08 — the second bench).

11. **A freshly booted simulator says hundreds of megabytes in its first half-minute, so the log
    read fails there rather than answering.** Measured on the second bench, 2026-09-08, on a
    simulator with nothing installed and nothing under test: `log show --style ndjson --info
    --debug --last 30s` came back **107.9–113.6 MB** within a minute of boot, `--last 2m` up to
    **576.8 MB** and `--last 5m` up to **756.4 MB** — against the 64 MB the read gives itself,
    and against the 30 s that a *quiet* device fills with 2.6 MB. At the very peak the read exits
    on its ten-second budget before it fills the buffer at all, which is the same refusal wearing
    the other name. Two consequences worth having in advance: **a `read_logs` in the first seconds
    after a boot, an install or a launch is expected to refuse, loudly**, and it is the *narrowest*
    width that refuses, so there is nothing narrower to fall back on (the widening keeps the
    narrower answer whenever a *wider* width is the one that overflows, §5). And **the burst ages
    out**: the same read answered 5,000 cap-bound entries a minute later, so a caller that reads
    logs after waiting on a condition is in the ordinary case rather than this one. The fix that
    would remove the trap is a streaming read keeping a rolling tail of `maxEntries + 1` lines,
    which is a runner `src/backends/ios-simulator/simctl.ts` does not have (PROJECT.md R45).

12. **A recording on a simulator that is not booted reports success at every step and writes
    nothing.** This is the sharpest trap in the document, because unlike trap 1 there is no
    failure to notice: measured on this section's own bench (macOS 26.6.2 / Xcode 26.6,
    2026-09-08) against a `Shutdown` iPhone 17, `simctl io <udid> recordVideo` printed
    `Recording started` at **0.228 s** — the marker the whole start wait is built on — ran for the
    twelve seconds it was left, and on `SIGINT` exited **0** with `Recording completed. Writing to
    disk.` and `Wrote video to: …`, leaving a **zero-byte file**. Every signal the tool gives says
    it worked. Nothing downstream can catch it, so the device's state has to be checked *before*
    the recorder is started, the way trap 1 is checked — and here the check is not an optimisation
    but the only thing between a caller and a recording of nothing
    (`IosSimulatorDeviceBackend.recordVideo`, #230).

13. **`SIGKILL` on a recorder leaves CoreSimulator holding that device's recording lock, and only
    a shutdown and a re-boot clears it.** `simctl help io` says to stop a recording with `SIGINT`
    — *"simctl exits once the in-flight frames are processed and the video file is finalized"* —
    and what a kill does instead is worse than a lost recording, measured on the same bench: the
    killed process goes, the **encoder keeps writing**, and every later `simctl io <udid>
    recordVideo` on that device fails at exit **16** with *"Host recording is already in
    progress"* with no process left to signal. Nothing short of `simctl shutdown` + `boot` on the
    operator's device releases it. So `SIGINT` is the only signal this backend ever sends, on
    every path including the `finally` of a wait that timed out, and any test or script that
    cleans up a recorder must do the same — a `kill -9` breaks the *next* run rather than this
    one. Related: exit **17**, *"cannot save recorded video output into a file that already
    exists"*, is what a leftover file produces, which is why the file is removed before every
    recording rather than `--force`-d over.

14. **Matching a recorder in `ps` needs the program as well as the arguments, and the program is
    not the path that was spawned.** Two halves, both measured here. *The program:* a scan for the
    token sequence `io <udid> recordVideo` alone matched the **capturing agent's own shell**,
    whose arguments contained a script discussing that command line — and it would then have been
    sent a `SIGINT`. So the first token's basename has to be `simctl` too, and the committed
    capture `recordvideo-ps.recording.xcode26.6.txt` holds one real recorder and one deliberate
    near miss for exactly that reason. *The path:* `<developer-dir>/usr/bin/simctl` is a **bash
    shim** that `exec`s
    `/Library/Developer/PrivateFrameworks/CoreSimulator.framework/…/bin/simctl`, so the running
    process reports the CoreSimulator path even though the backend spawned the Xcode one —
    comparing against the spawned path would match nothing at all. `exec` preserves the pid, so
    the pid this host spawned *is* the pid in the table. (`ps` escapes a newline inside an argv as
    `\012`, so one process really is one line — checked against a process deliberately given one.)

15. **`idb_companion` resolves Xcode through `xcode-select`, and it does not agree with this
    backend's own search unless it is told to.** On this bench — `xcode-select` pointing at
    CommandLineTools, which §1 says is the state a developer machine is most likely to be in while
    looking fully equipped — `idb_companion --notify stdout` exited **0** having printed no frame
    at all, with *"Failed to resolve the Xcode developer directory. Ensure Xcode is installed and
    selected with xcode-select"* on stderr, while `simctl` ran perfectly through
    `developer-dir.ts`' search of the same machine (companion v1.5.2, macOS 26.6.2, 2026-09-08).
    So the whole notify stream was silently unavailable on a host that enumerates simulators
    fine, and the exit code said nothing: **0, with an empty stdout.** Exporting `DEVELOPER_DIR`
    for the child fixes it and the frames arrive immediately, which is what
    `src/backends/ios-simulator/idb-companion.ts` does. The sharper version of the trap is the one
    that has not been seen yet: on a machine where the two searches resolve to *different* Xcodes,
    `simctl` would drive one simulator set while the watch reported the other's — which is #171's
    "measuring two machines" one program further out. Do not fix this with
    `sudo xcode-select --switch`; the daemon has to work on the machine as it is found.

16. **gRPC sees a companion die before Node does, so every crash mid-call reads as a transport
    fault.** Measured while building the per-target transport (#250): when the companion goes, its
    socket closes at once and `@grpc/grpc-js` fails the outstanding call with `14 UNAVAILABLE:
    Connection dropped` — while the child's `close` event, which is what reports *how* the process
    ended, arrives one flush of two pipes later. Take the first answer and every crash on this
    platform becomes a sentence about a connection, from which nobody can tell that the thing that
    died is a program a person can restart, or that the device is fine. The fix is small and it is
    a **condition with a timeout**, not a sleep: `UNAVAILABLE`, and only `UNAVAILABLE`, is given a
    short bounded grace to be explained by the process ending
    (`src/backends/ios-simulator/idb-client.ts`). A status the companion *chose* — a deadline, a
    bad argument — is its own answer and is passed straight on, and a grace that runs out with the
    process still running stays the plain failure: reporting an interruption there would promise a
    replacement companion that nothing is going to start.

---

## 9. Two claims in `ai/ARCHITECTURE.md` this evidence corrects

Both are in the "Device features must stay backend-agnostic" / iOS-seam material, and both were
reasonable guesses:

- *"Semantic screen reading may have no iOS equivalent at all."* — **False for the simulator.**
  `idb ui describe-all` is a full semantic read with labels, roles, traits and point frames, and it
  works on a Compose Multiplatform app — and since #251 it is not only a measurement here but a
  dispatched method, `readScreen` on the registered backend. What is true is the inversion in trap
  8: on Android the tree is what survives a capture block; on iOS the capture is what never gets
  blocked.
- *"`simctl list` is a poll"* — **true of `simctl`, and not the whole platform.**
  `idb_companion --notify` is a change stream matching `DeviceWatcher`'s contract (§7). The
  interface requirement that enumeration must not be assumed cheap stands; the conclusion that iOS
  can only poll does not.

Everything else there held: `simctl` really cannot tap or dump a tree, input really does need a
second program with its own lifecycle, and `record_video` really is a simulator-only ability.

---

## 10. Recommendation

**Build `src/backends/ios-simulator/` as a simulator backend, on `simctl` + idb's gRPC, and declare
`canControlNetwork: false`.** The folder was written `src/backends/ios/` here and is corrected in
place: a backend's folder is its platform id, and the id this argues for two paragraphs down is
`ios-simulator`. Manifest, once every step below has landed:

```ts
{ platform: 'ios-simulator', label: 'iOS Simulator (simctl + idb)',
  capabilities: { canReadScreen: true, canInput: true, canControlNetwork: false,
                  canRecordVideo: true, canControlRecording: true } }
```

`platform: 'ios-simulator'` rather than `'ios'` — deliberately. A physical iPhone cannot answer a
required method of this contract (§6); it is a different backend with a different dependency, and
naming this one `ios` would promise it.

In order, and each step is independently useful:

1. **`simctl` alone**: `listDevices`, `describeDevice`, `deviceInfo`, install/launch/stop/clear,
   `screenshot`, `readLogs`, `pushFile`, `pullFile`, `recordVideo` + the recording trio, with
   `simctl list` polling for `watchDevices`. That is every required method and two capabilities,
   with **no third-party dependency at all** — and it is the version worth having even if idb is
   never adopted.

   **Done** (#213, #214, #218–#220, #227–#230, `PROJECT.md` R45), and the manifest as it actually
   shipped departs from the sketch above in one place — the **label**:

   ```ts
   { platform: 'ios-simulator', label: 'iOS Simulator (simctl)',
     capabilities: { canReadScreen: false, canInput: false, canControlNetwork: false,
                     canRecordVideo: true, canControlRecording: true } }
   ```

   `(simctl)` rather than `(simctl + idb)` on purpose: there is no idb in this backend, and a
   label naming one would promise a `readScreen` and an input vocabulary it does not have. The two
   `false` flags that are *not* `canControlNetwork` are the honest opt-outs step 2 and step 3 flip
   — until then, an absent method beside a `false` flag is a complete backend.
2. **Add idb**: `readScreen`, `tap`, `swipe`, `typeText`, `pressKey`, and swap `watchDevices` onto
   `--notify`. Talk gRPC from Node, supervise one companion per target, never call `file push`,
   and classify a companion crash as an interruption rather than a device fault. **The
   `watchDevices` half is done** (#249) — one companion per *host* in `--notify` mode, no gRPC and
   no per-target companion, with the poll kept as the fallback (§7). **The transport half is done
   too** (#250) — gRPC from Node over a unix domain socket (§4 carries the table that chose it over
   a port), one supervised companion per target started by a call and never on a schedule, `push`
   off a closed RPC list with a source scan behind it, and a companion's death classified as an
   interruption that leaves the device `ready` (§8 trap 16). **And `readScreen` is done** (#251):
   `accessibility_info` in its flat `LEGACY` format over that transport, `canReadScreen: true` in
   the manifest with the conformance suite green on it, frames passed through in **points** because
   that is already the unit `ScreenInfo` uses, and a synthesised **flat ordinal** for the id
   because `AXUniqueId` turned out not to be unique where it is populated at all (§2). **And the
   four input primitives are done** (#252): one client-streaming `hid` call behind `tap`, `swipe`,
   `typeText` and `pressKey`, each verified against a device by reading the screen back (§4). With
   them the **label** finally becomes `iOS Simulator (simctl + idb)` — it stayed `(simctl)` through
   every phase in which idb was present but `canInput` was still `false`, because naming idb in the
   one place with no flag beside it would have promised exactly the half that was missing.
3. **Declare `canInput` and refuse the keys with no equivalent by name.** **Done** (#252). Shared
   code carries the per-key refusal (#215), so what this step was is declaring the capability —
   all four methods at once, because `CAPABILITY_METHODS.canInput` names all four and a manifest
   declaring it with three of them fails the conformance suite — and raising `UnsupportedKeyError`
   for the keys this platform has none for. That is `recents` **and `back`**, which is §5's
   reversal: `home` is answered, and `wake` is answered idempotently by reading the
   blanked-screen flag before the press.
4. **Leave physical iOS alone** until someone wants to pay for WebDriverAgent — and record the
   reason in `PROJECT.md` when they do, because "iOS is supported" will otherwise be read as
   covering hardware.

The conformance suite (`ai/TESTING.md`) is what makes step 1 safe to land: it already reads
`CAPABILITY_METHODS` to check that every declared capability is one the backend actually dispatches,
so a manifest that lies about `canInput` before step 2 fails a unit test rather than an agent.
