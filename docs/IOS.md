# iOS — what the seam can actually be filled with

The evidence document behind `ai/ARCHITECTURE.md`'s "Where the iOS seam runs". Everything below was
**run**, on this machine, on 2026-09-08, against a Compose Multiplatform app built from
`../giotto-ai-demo` (`iosApp` scheme, bundle `com.tooploox.giotto.Giotto`) — not read off a blog and
not remembered. Where something could not be run, it says so rather than implying a result
(`ai/RULES.md` §6).

**Bottom line:** every **required** method of `DeviceBackend` has a working iOS **simulator**
implementation today, and three of the five gated capabilities do too — including `canReadScreen`,
which `ai/ARCHITECTURE.md` guessed might have no iOS equivalent at all. A **physical** iPhone is a
different and much worse story: it cannot answer `screenshot`, which is a required method, so it is
not a device this contract can lend at all without a WebDriverAgent-class in-device agent.

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
| `screenshot` | `simctl io <d> screenshot` | 0.14–0.24 s, 246 KB PNG | ✅ |
| `readLogs` | `simctl spawn <d> log show --style ndjson --predicate …` | 0.95 s, 268 entries | ⚠️ must be predicate-scoped |
| `pushFile` | the device's `dataPath` + a host copy | 0.10 s, 64 KB | ✅ storage **is** a host path |
| `pullFile` | same | 0.11 s, byte-identical | ✅ |

| Capability | Gated methods | How | Measured | Verdict |
|---|---|---|---|---|
| `canReadScreen` | `readScreen` | `idb ui describe-all` | 0.16–0.22 s, labels + frames in **points** | ✅ |
| `canInput` | `tap` `swipe` `typeText` `pressKey` | `idb ui tap/swipe/text/button` | 0.11–0.16 s each | ✅ (see §5 for `pressKey`) |
| `canRecordVideo` | `recordVideo` | `simctl io recordVideo` | — | ✅ |
| `canControlRecording` | `start`/`stop`/`discardRecording` | same + SIGINT | first frame at 0.21 s, 325 KB h264 | ✅ |
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
`src/backends/android/screen.ts` already synthesizes one — `AXUniqueId` is `null` throughout, so an
ordinal is the honest choice, with the same "stable only for as long as the tree shape is" caveat
that module already documents. The one shape difference: `describe-all` answers a **flat list**,
where uiautomator answers a tree, so the id is a flat ordinal rather than a child-ordinal path.

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
  archived. The private headers in it are annotated against **Xcode 26.2**.
- It ships a **prebuilt `idb-companion.macos-arm64.tar.gz`** and an `arm64_tahoe` Homebrew bottle.
  Nothing was compiled to get the results above; the tarball was unpacked into a scratch directory
  and run in place. `brew` no longer carries `idb-companion` in core — the old `facebook/fb` tap is
  gone — so the release asset is the install path.
- The Python client is a convenience, not the interface. The companion is a **gRPC server**
  (`--grpc-port`), which is what a Node backend would speak, dropping the Python dependency and the
  ~70 ms per-call CLI startup entirely.

The lifecycle is the real cost, and it has teeth:

- **One companion process per target**, started with `--udid`, and it must be supervised. Killing it
  does **not** disturb the simulator (verified: device stayed `Booted` across companion exit), so
  the supervision is Rover's business and only Rover's.
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

**`DeviceKey` has four members and iOS answers two and a half.**

| `DeviceKey` | iOS | Notes |
|---|---|---|
| `home` | ✅ `idb ui button HOME` | Works on a home-buttonless iPhone 17 — verified, it went to Springboard |
| `wake` | ⚠️ `idb ui button LOCK` | LOCK **toggles**; Android's `KEYCODE_WAKEUP` is idempotent. A `wake` built on it must read state first or it puts a woken device to sleep |
| `back` | ⚠️ left-edge swipe | **Verified working**: drilled into Settings → General, `ui swipe 2 450 → 300 450`, and the root list came back. It is an app gesture, not a system key, so it works where the app supports interactive pop and nowhere else |
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
- **`back` needs nothing from the vocabulary.** On iOS back is normally a button in the app's own
  UI — usually the app bar — which the verb layer already reaches by label through `read_screen`
  + `tap`. The left-edge swipe measured above works where the app supports interactive pop, and
  that is a gesture rather than a key.
- **`wake` is this backend's own business.** Reading lock state first and making the press
  idempotent is an implementation question, not a vocabulary one, and only needs a failure of its
  own if that read turns out not to exist.

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

**Logs must be predicate-scoped or they are useless.** Unfiltered, `log show --last 20s` returned
**92,204 entries**; the same window with `--predicate 'process == "Giotto"'` returned 268. A
`readLogs` that does not push the process filter down into the query will spend seconds serializing
the host's own noise before `maxEntries` throws it away.

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
   regardless.
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

---

## 9. Two claims in `ai/ARCHITECTURE.md` this evidence corrects

Both are in the "Device features must stay backend-agnostic" / iOS-seam material, and both were
reasonable guesses:

- *"Semantic screen reading may have no iOS equivalent at all."* — **False for the simulator.**
  `idb ui describe-all` is a full semantic read with labels, roles, traits and point frames, and it
  works on a Compose Multiplatform app. What is true is the inversion in trap 8: on Android the tree
  is what survives a capture block; on iOS the capture is what never gets blocked.
- *"`simctl list` is a poll"* — **true of `simctl`, and not the whole platform.**
  `idb_companion --notify` is a change stream matching `DeviceWatcher`'s contract (§7). The
  interface requirement that enumeration must not be assumed cheap stands; the conclusion that iOS
  can only poll does not.

Everything else there held: `simctl` really cannot tap or dump a tree, input really does need a
second program with its own lifecycle, and `record_video` really is a simulator-only ability.

---

## 10. Recommendation

**Build `src/backends/ios/` as a simulator backend, on `simctl` + idb's gRPC, and declare
`canControlNetwork: false`.** Manifest:

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
2. **Add idb**: `readScreen`, `tap`, `swipe`, `typeText`, `pressKey`, and swap `watchDevices` onto
   `--notify`. Talk gRPC from Node, supervise one companion per target, never call `file push`,
   and classify a companion crash as an interruption rather than a device fault.
3. **Declare `canInput` and refuse `recents` by name.** The `recents`/`back` question is decided
   (§5): shared code carries the per-key refusal (#215), so what remains here is declaring the
   capability and raising `UnsupportedKeyError` for `recents` — `back` and `home` are answered, and
   `wake` reads lock state first so the press is idempotent.
4. **Leave physical iOS alone** until someone wants to pay for WebDriverAgent — and record the
   reason in `PROJECT.md` when they do, because "iOS is supported" will otherwise be read as
   covering hardware.

The conformance suite (`ai/TESTING.md`) is what makes step 1 safe to land: it already reads
`CAPABILITY_METHODS` to check that every declared capability is one the backend actually dispatches,
so a manifest that lies about `canInput` before step 2 fails a unit test rather than an agent.
