# iOS simulator output fixtures

Every parser under `src/backends/ios-simulator/` is pinned against output **captured from a real
simulator**, never written by hand (`ai/TESTING.md`). A hand-written fixture encodes what someone
believes `simctl` prints, so the parser passes and the tool disagrees. One capture here already
earned its keep: the device map is keyed by runtime **identifier**
(`com.apple.CoreSimulator.SimRuntime.iOS-26-4`) while the matching runtime reports
`"version": "26.4.1"`, so a parser that read the version out of the key would report `26.4` — a
version no installed runtime has. That is why `src/backends/ios-simulator/devices.ts` joins on
`identifier` and reads `version`, and why its suite asserts the difference both ways.

**This folder is named after the backend, not after one tool** — unlike `tests/fixtures/adb/`.
This backend is not one external program (`ai/ARCHITECTURE.md`, "Where the iOS seam runs"): later
phases of this split capture a device type's `profile.plist`, which `simctl` never prints, and
unified-log NDJSON, which comes through `log`. A folder named `simctl/` would be wrong by the next
capture.

Each filename carries the subject and the **versions the capture was taken on**:
`<subject>.xcode<xcode-version>-ios<runtime-version>.<ext>`, where the Xcode version comes from
`xcodebuild -version` and the runtime version from the **booted** device's entry in
`xcrun simctl list -j runtimes`. Where the adb fixtures put an API level and a model slug, these
put the Xcode/runtime pair, because **iOS has no API level** — there is nothing to record in that
position, and the version the capture was taken on is the fact that governs it.

**Where a program that is not Xcode's own governs the format, its version goes in front of that
pair** — `idb-notify.idbcompanion1.5.2-xcode26.6-ios26.5.txt` is the first, because idb is a
third-party release with a cadence of its own rather than something an Xcode update carries: v1.5.2
and v1.5.4 are eight days apart. A newer companion is a **second fixture beside this one**, not an
edit to it. This is the case the folder's name already anticipated — a folder called `simctl/` was
wrong by the second program governing a capture here and is wronger with every one since.

**The `-ios<runtime-version>` half is dropped where no runtime governs the capture**, and the
device-type profiles below are the case: a `profile.plist` ships inside CoreSimulator's own
`.simdevicetype` bundle, not inside any runtime, and describes hardware rather than an OS — the
bundle carries `minRuntimeVersion` precisely because *it* is the fixed thing and the runtime is
the variable one. Writing a runtime version into that name would claim a dependency the file does
not have and invite a needless re-capture on the next runtime update. The Xcode version stays,
because that is what installs the bundle.

Re-derive both at capture time and name the file after what was captured, not after
`docs/IOS.md`'s bench: that document was measured on Xcode 26.6 / iOS 26.5, and these were not.

Re-capture rather than hand-edit when a format changes, and add the new fixture **beside** the old
one: a parser has to keep working on the Xcode releases already in use.

## The bench

| | |
|---|---|
| Host | macOS 26.6.2 (25G83), Apple silicon |
| Xcode | 26.4.1 (17E202), `xcode-select -p` → `/Applications/Xcode.app/Contents/Developer` |
| Runtimes installed | iOS 26.4.1 (`23E254a`, identifier `…SimRuntime.iOS-26-4`) and iOS 26.1 (`23B86`, identifier `…SimRuntime.iOS-26-1`) |
| Devices | 22 — 11 under each runtime |
| Booted at capture | `iPhone 17` / `997FA43E-FF9F-4109-BEF0-53D3F46653E7`, under iOS 26.4.1. Every other device `Shutdown` |
| Captured | 2026-09-08 |

Note that this bench is **not** `docs/IOS.md`'s: that one is Xcode 26.6 / iOS 26.5 (23F77) on a
different host.

**A second bench arrived with the recording captures** (#230), and it *is* `docs/IOS.md`'s —
macOS 26.6.2 (25G83), Xcode 26.6 (17F113), iOS 26.5 (23F77), `iPhone 17`
`88D8476E-F4A4-4A18-A89B-0C47E077CC8B`, 2026-09-08. So the sentence that used to close this
paragraph — *"nothing in this folder re-verifies anything in that document"* — is **no longer
true and is corrected in place** rather than deleted, because the reason it was written still
holds for everything above: a fixture is governed by the versions it was captured on, and most of
this folder was captured on Xcode 26.4.1. The three `recordvideo*` files were not, which is why
they are named `xcode26.6` and have their own section below. Two benches in one folder is the
filename convention working, not a problem to tidy away — and it is why each capture's row names
the versions rather than the folder doing it once.

**The idb captures are that same second bench with one program added** (#216): macOS 26.6.2
(25G83), Xcode 26.6 (17F113), iOS 26.5 (23F77), `iPhone 17`
`88D8476E-F4A4-4A18-A89B-0C47E077CC8B` booted and every other device `Shutdown`, 2026-09-08 — plus
`idb_companion` **v1.5.2** (built 2026-09-01), fetched as the release's
`idb-companion.macos-arm64.tar.gz`, checksummed against the release's own `.sha256` and unpacked
into a scratch directory **outside this repository** (`docs/IOS.md` §4). Eleven simulators, all
under the one installed runtime.

**The companion's version is not something the program will tell you.** `idb_companion --version`
prints `{"build_date":"Sep 1 2026","build_time":"08:51:20"}` and no version at all, so the `1.5.2`
in that filename is the **release tag the asset was downloaded from**. Record it from the download,
not from the binary.

## Captures

| Fixture | Command | Xcode | Runtime | Captured |
|---|---|---|---|---|
| `simctl-list.xcode26.4.1-ios26.4.1.json` | `xcrun simctl list -j` | 26.4.1 | 26.4.1 | 2026-09-08 |
| `simctl-list-devices.xcode26.4.1-ios26.4.1.json` | `xcrun simctl list -j devices` | 26.4.1 | 26.4.1 | 2026-09-08 |
| `device-type-profile.iphone-17-pro.xcode26.4.1.plist` | `cp` (below) | 26.4.1 | n/a | 2026-09-08 |
| `device-type-profile.ipad-pro-13-inch-m5.xcode26.4.1.plist` | `cp` (below) | 26.4.1 | n/a | 2026-09-08 |
| `unified-log-ndjson.xcode26.4.1-ios26.4.1.json` | `log show --style ndjson` (below) | 26.4.1 | 26.4.1 | 2026-09-08 |
| `unified-log-ndjson.levels.xcode26.4.1-ios26.4.1.json` | `log show --style ndjson` (below) | 26.4.1 | 26.4.1 | 2026-09-08 |
| `simctl-terminate-not-running.xcode26.4.1-ios26.4.1.txt` | `simctl terminate` (below) | 26.4.1 | 26.4.1 | 2026-09-08 |
| `simctl-terminate-shutdown.xcode26.4.1-ios26.4.1.txt` | `simctl terminate` (below) | 26.4.1 | 26.4.1 | 2026-09-08 |
| `recordvideo.stderr.xcode26.6-ios26.5.txt` | `simctl io … recordVideo` (below) | **26.6** | **26.5** | 2026-09-08 |
| `recordvideo.finished.xcode26.6-ios26.5.mov` | `simctl io … recordVideo` (below) | **26.6** | **26.5** | 2026-09-08 |
| `recordvideo-ps.recording.xcode26.6.txt` | `ps -A -o pid=,command=` (below) | **26.6** | n/a | 2026-09-08 |
| `idb-notify.idbcompanion1.5.2-xcode26.6-ios26.5.txt` | `idb_companion --notify stdout` (below) | **26.6** | **26.5** | 2026-09-08 |
| `simctl-list.xcode26.6-ios26.5.json` | `xcrun simctl list -j` (below) | **26.6** | **26.5** | 2026-09-08 |

The all-listings capture is the primary one — there are now two, on two Xcode releases, and the
second one's reason is its own section below: `xcrun simctl list -j` with no type argument answers
all four listings at once — `devicetypes`, `runtimes`, `devices`, `pairs` — even though
`simctl list`'s own usage text says to "specify one of" them. A later phase of this split reads
`devicetypes` out of the same file. The `devices`-only capture is what pins that a single-listing
invocation parses too, so the parser cannot come to depend on which invocation form produced its
input.

**The simulator was booted before the capture and was left exactly as found.** The host's
`Simulator.app` was already open with `iPhone 17` booted, so nothing here ran `simctl boot` or
`simctl shutdown` — quitting or driving that app shuts down every device it owns
(`docs/IOS.md` §8, trap 4). On a host with nothing booted, boot on a condition rather than a sleep
and put it back afterwards:

```bash
xcrun simctl boot <udid> && xcrun simctl bootstatus <udid> -b
# … take the two captures above …
xcrun simctl shutdown <udid>
```

## The idb notify capture, and the `simctl` listing beside it

`idb_companion --notify stdout` is the change stream the iOS-simulator backend will eventually
watch instead of polling (`docs/IOS.md` §7). **The companion is what governs this format**, not
Xcode, which is why its version leads the filename.

```bash
export ROVER_IDB_COMPANION_PATH=/path/to/unpacked/idb_companion   # docs/IOS.md §4 has the install
"$ROVER_IDB_COMPANION_PATH" --notify stdout \
  > tests/fixtures/ios-simulator/idb-notify.idbcompanion1.5.2-xcode26.6-ios26.5.txt &
# … with it streaming, boot one simulator and put it back …
xcrun simctl boot D85C3449-4D0C-4E93-B8EC-77FD0E5A8F3F      # iPhone 17 Pro, Shutdown before and after
xcrun simctl bootstatus D85C3449-4D0C-4E93-B8EC-77FD0E5A8F3F -b
xcrun simctl shutdown D85C3449-4D0C-4E93-B8EC-77FD0E5A8F3F
kill %1

xcrun simctl list -j > tests/fixtures/ios-simulator/simctl-list.xcode26.6-ios26.5.json
```

**The host was left exactly as found**: `iPhone 17` was already booted and was never touched, and
the simulator that moved was `Shutdown` before the capture and `Shutdown` after it. Nothing quit or
drove `Simulator.app`, which would have shut down every device it owns (`docs/IOS.md` §8, trap 4).

| | |
|---|---|
| Frames | 5 — `Shutdown → Booting → Booted → Shutting Down → Shutdown` for the one device that moved |
| Targets per frame | 11, every time: each line is the **full** set, never a delta |
| Framing | one JSON array per line, newline-terminated; the file ends with a newline |
| Target keys | `udid`, `type`, `name`, `model`, `os_version`, `state` — in an order that varies between frames |

- **The terminating newline arrives in its own write.** The reads this capture came in as were
  `1784, 1, 1784, 1783, 1789, 1, 1785` bytes — a frame and its newline delivered separately, twice
  in five frames. That is the whole reason
  `src/backends/ios-simulator/parsers/idb-notify.ts` is a decoder rather than a `split('\n')`, and
  the suite feeds the same bytes back in 1-byte chunks to prove it.
- **`os_version` carries the platform word**: `iOS 26.5`, where the runtime in the `simctl` listing
  beside it reports a bare `26.5` for the very same runtime. That single difference is why
  `src/backends/ios-simulator/devices.ts` normalises this path's version onto `simctl`'s — two
  spellings for one device would let `list_devices` and the inventory disagree.
- **`simctl-list.xcode26.6-ios26.5.json` is here for exactly that comparison**, and it is the
  reason a second all-listings capture exists at all when there is already one on Xcode 26.4.1: it
  was taken minutes after the notify capture, on the same bench, with the same eleven simulators in
  the same states, so `toDevices` and `toNotifiedDevices` can be asserted **equal device by
  device** rather than each against a literal. Two captures from two machines could not have been
  compared that way. It also pins that the parser still reads an all-listings capture from a second
  Xcode release.
- **No physical target and no non-iOS runtime is in this capture**, because none was on the bench —
  no iPhone was paired to it and only the iOS 26.5 runtime is installed. So the allowlist in
  `devices.ts` (only a `Simulator` under an `iOS ` runtime is admitted) is pinned by **inline cases**
  in `tests/unit/backends/ios-simulator/devices.test.ts`, named as inline there, the same way
  `messageType: "None"` is above.
- Committed **verbatim**, byte for byte: the decoder's whole job is the boundary, so a re-indented
  or re-wrapped capture would test the wrong thing. It contains simulator UDIDs and device-type
  names and nothing else — no path and nothing personal.

## The two device-type profiles

A device type's screen metrics are in its own `profile.plist`, which `simctl` never prints. The
bundle holding it is named by `xcrun simctl list -j devicetypes` in each entry's `bundlePath`, and
both files were copied straight out of the paths the tool reported — no path was assembled by
hand, because **these bundles are not under `DEVELOPER_DIR`**: all 124 of them sit under
`/Library/Developer/CoreSimulator/` while Xcode is in `/Applications`, so an Xcode-relative path
finds none of them.

```bash
cp "/Library/Developer/CoreSimulator/Profiles/DeviceTypes/iPhone 17 Pro.simdevicetype/Contents/Resources/profile.plist" \
   tests/fixtures/ios-simulator/device-type-profile.iphone-17-pro.xcode26.4.1.plist
cp "/Library/Developer/CoreSimulator/Profiles/DeviceTypes/iPad Pro 13-inch (M5).simdevicetype/Contents/Resources/profile.plist" \
   tests/fixtures/ios-simulator/device-type-profile.ipad-pro-13-inch-m5.xcode26.4.1.plist
chmod 644 tests/fixtures/ios-simulator/device-type-profile.*.plist   # the originals are root:wheel
```

| Fixture | Bundle it came from | What it pins |
|---|---|---|
| `device-type-profile.iphone-17-pro.xcode26.4.1.plist` | `iPhone 17 Pro.simdevicetype` | 1206×2622 px, scale 3, 460 dpi, `iPhone18,1` — so `widthDp` is 1206/3 = 402 and `heightDp` 2622/3 = 874 |
| `device-type-profile.ipad-pro-13-inch-m5.xcode26.4.1.plist` | `iPad Pro 13-inch (M5).simdevicetype` | 2064×2752 px, scale **2**, 264 dpi, `iPad17,4` |

The iPad is here for its **scale**. With one fixture the whole conversion could be pinned on the
number 3 and nothing would notice; two device types at two scales, in two product families, is what
makes `src/backends/ios-simulator/screen.ts` a division rather than a constant.

**These are binary property lists** (`bplist00`), not XML — every one of the 124 profiles on this
bench is, so `fast-xml-parser` cannot read them and the decode takes the `bplist-parser`
dependency (that module's header carries the alternatives that were rejected). Read one at the
terminal with `plutil -p <file>`; do not "fix" one with `plutil -convert xml1`, which would make
the fixture stop being what the tool actually installs.

Committed verbatim like the JSON above, and they contain no path and nothing personal: a device
type profile is the same file on every machine with the same Xcode.

## The two unified-log captures

The device's own system log, which comes through `log` inside the simulator rather than through
`simctl` — one more reason this folder is named after the backend and not after one tool. Both were
taken against the device the host already had booted, so nothing here ran `simctl boot` or
`simctl shutdown` either.

```bash
udid=997FA43E-FF9F-4109-BEF0-53D3F46653E7

xcrun simctl spawn $udid log show --style ndjson --info --debug --last 1m \
  --predicate 'process == "SpringBoard"' \
  > tests/fixtures/ios-simulator/unified-log-ndjson.xcode26.4.1-ios26.4.1.json

xcrun simctl spawn $udid log show --style ndjson --info --debug \
  --start '2026-09-08 10:00:16' --end '2026-09-08 10:00:17' --predicate 'process == "contactsd"' \
  > tests/fixtures/ios-simulator/unified-log-ndjson.levels.xcode26.4.1-ios26.4.1.json
```

| Fixture | Lines | Entries | `messageType` spread | What it pins |
|---|---|---|---|---|
| `unified-log-ndjson.xcode26.4.1-ios26.4.1.json` | 53 | 52 | `Info` 30, `Default` 14, `Error` 1, **absent** 7 | An ordinary read: one process, one minute, the trailer, and the mapping's five fields off the first entry |
| `unified-log-ndjson.levels.xcode26.4.1-ios26.4.1.json` | 70 | 69 | `Default` 29, **absent** 19, `Info` 14, `Error` 3, `Debug` 3, `Fault` 1 | All five of the level words `messageType` prints, in one file |

- **The last line of each is a trailer, not an entry** — `{"count":52,"finished":1}`. It is the tool
  describing its own output, the exact analogue of logcat's `--------- beginning of main`, and it
  carries no `timestamp`, no `eventType` and no `eventMessage`. It is the one line
  `src/backends/ios-simulator/parsers/unified-log.ts` deliberately drops, which is why both suites
  assert the entry count is the line count *minus one*.
- **`messageType` is absent far more often than it is `"None"`.** Every entry that is not a
  `logEvent` — `activityCreateEvent`, `stateEvent`, `timesyncEvent` — carries no `messageType` key
  at all: 7 of 52 here and 19 of 69 in the levels capture. In a 30-minute unfiltered survey on this
  bench, 25,422 of 195,947 entries had none. **Not one of those 195,947 was `"None"`**, so the
  destination `docs/IOS.md` §5 left open for that value is pinned by an inline case in
  `tests/unit/backends/ios-simulator/parsers/unified-log.test.ts` rather than by a fixture, and is
  named as inline there.
- **`--info --debug` are on both captures on purpose.** Without them the tool answers neither
  level: the levels window comes back as 53 lines carrying only `Default`, `Error`, `Fault` and
  absent, and the flags are exactly what add its 14 `Info` and 3 `Debug`. A capture without them
  would leave two thirds of the level table untestable, and a log read that quietly omitted a level
  is the hole `LogEntry` exists to prevent.
- **Predicate-scoped and short, and a capture is never truncated by hand.** Unfiltered,
  `log show --last 20s` returned 92,204 entries against 268 for the same window scoped to one
  process (`docs/IOS.md` §5); on this bench a 30-minute unfiltered capture came to 195,948 lines and
  236 MB. Each entry of this output is over a kilobyte — a `formatString`, image UUIDs, and a
  `backtrace` on every fault — so the way to a small fixture is a narrower predicate or a shorter
  window, never a text editor: a hand-cut file stops being what the tool prints.
- **The levels capture is a one-second `--start`/`--end` window over `contactsd`'s launch burst**,
  and that is what made all five level words fit in tens of kilobytes. `Debug` is rare on an idle
  simulator (519 entries in that 195,947-entry survey) and `Fault` never coincides with it by luck,
  so the window was picked out of the survey rather than waited for; `contactsd` is the smallest
  process on this bench whose log carries all five at all.
- **Re-capture picks its own window rather than reusing that one.** A log archive is a ring buffer
  somebody else is also writing to: the levels command above answered 70 lines when it was captured
  and 58 fifteen minutes later, and once 0. Survey with `--predicate` and `--last`, find a window
  that carries what the fixture is for, and record it here like the one above.
- **These two do contain the capturing operator's home directory**, unlike the profiles: the one
  `Fault` in the levels capture quotes a file URL under
  `~/Library/Developer/CoreSimulator/Devices/<udid>/data/…`. Same judgement as the `dataPath`s
  below — a simulator UDID is not a credential and neither is that path. Note that `--style ndjson`
  escapes every forward slash (`file:\/\/\/Users\/…`), so `grep /Users/` over these files finds
  nothing while the path is right there.

## The two `terminate` captures

The **stderr** of two `simctl terminate` failures, and the only wording this backend reads
(`src/backends/ios-simulator/parsers/app-control.ts`). Both are the same subcommand refusing for
two different reasons, taken minutes apart on the same host, which is what makes the second a real
negative case rather than an imagined one:

```bash
udid=997FA43E-FF9F-4109-BEF0-53D3F46653E7        # booted
shutdown=1974C124-3582-4D07-89BB-B4BA3B03D32F    # Shutdown

xcrun simctl terminate $udid com.rover.nope \
  2> tests/fixtures/ios-simulator/simctl-terminate-not-running.xcode26.4.1-ios26.4.1.txt
xcrun simctl terminate $shutdown com.rover.nope \
  2> tests/fixtures/ios-simulator/simctl-terminate-shutdown.xcode26.4.1-ios26.4.1.txt
```

| Fixture | Exit | What it pins |
|---|---|---|
| `simctl-terminate-not-running…txt` | **3** | `found nothing to terminate`, on three of its six lines — the app was not running, which this backend counts as a success |
| `simctl-terminate-shutdown…txt` | **149** | `Unable to lookup in current state: Shutdown` — a real refusal of the same subcommand, which stays a failure |

- **Both are stderr only**; stdout was empty on each. They are `.txt` rather than JSON because
  that is what the tool wrote — this is prose, not a document.
- **Neither carries an exit code**, deliberately: the number is not what the predicate reads, and
  three failures on this tool answered 148, 1 and 3 (`docs/IOS.md` §2). It is recorded in the table
  above and nowhere the code can reach.
- **The wording in the first is not localized, and that is the reason it is safe to match.** On the
  capturing host — whose UI language is Polish — a failed `simctl install` in the same session came
  back as *"App installation failed: Nie można zainstalować „Rover”"* from
  `IXUserPresentableErrorDomain`, while every line of these two is English. A predicate over a
  user-presentable message would pass here and fail on the next machine (`docs/IOS.md` §8, trap 9).
  Anyone re-capturing on a differently-localized host should check that half again rather than
  assume it.
- Neither contains a path or anything personal: the bundle identifier is one this repository made
  up for the purpose, and no device is named in the text.

## The three recording captures

The only fixtures here taken on **`docs/IOS.md`'s** bench rather than on the one above — macOS
26.6.2 (25G83), Xcode 26.6 (17F113), iOS 26.5 (23F77), `iPhone 17`
`88D8476E-F4A4-4A18-A89B-0C47E077CC8B`, already booted and left exactly as found (#230). They pin
the three questions `src/backends/ios-simulator/parsers/recording.ts` answers, and each of the
three exists because a plausible shortcut would have been wrong:

```bash
udid=88D8476E-F4A4-4A18-A89B-0C47E077CC8B
simctl=/Applications/Xcode.app/Contents/Developer/usr/bin/simctl
mkdir -p /tmp/rover-rec

# 1 + 2. One recording, its stderr and its file. SIGINT, never a kill — see below.
$simctl io $udid recordVideo --codec h264 --mask ignored /tmp/rover-rec/fixture.mov \
  2> tests/fixtures/ios-simulator/recordvideo.stderr.xcode26.6-ios26.5.txt &
recorder=$!
# … wait for `Recording started` in that file, then: …
kill -INT $recorder && wait $recorder
cp /tmp/rover-rec/fixture.mov \
   tests/fixtures/ios-simulator/recordvideo.finished.xcode26.6-ios26.5.mov

# 3. The process table while that recorder ran, cut to the two lines that matter.
ps -A -o pid=,command= | grep recordVideo
```

| Fixture | What it pins |
|---|---|
| `recordvideo.stderr.xcode26.6-ios26.5.txt` | **Two lines, in the order they arrive**: `Note: No display specified. Defaulting to display: … (screenID: 1, name: LCD)` at ~0.12 s, then `Recording started` at 0.14–0.23 s. That order *is* the fixture's point — a wait on "anything on stderr" would resolve on the note, before a frame existed |
| `recordvideo.finished.xcode26.6-ios26.5.mov` | A real finished recording, 100,782 bytes for ~2 s of an idle screen: `ftyp` (brand `qt  `, 20 bytes) → `moov` (860) → `wide` (8) → `mdat` (99,894). So `moov` is **before** `mdat` on this platform, and `src/verbs/recording-container.ts`'s shared walk reads it as one sample declaring 2,042 ms |
| `recordvideo-ps.recording.xcode26.6.txt` | One real recorder **and one deliberate near miss** — a `/bin/sh` whose arguments merely quote the same command line. Two lines, and the second is the whole reason the file exists |

- **The near miss is not invented.** While these were being measured, a scan for the token sequence
  `io <udid> recordVideo` alone matched the **capturing agent's own shell**, whose arguments held a
  script discussing that command line — and it would then have been sent a `SIGINT`. So
  `recorderPids` requires the first token's basename to be `simctl` as well, and this capture is
  the negative case for it. The near-miss line was produced on purpose, with a newline inside its
  argument, which is also what pins that `ps` escapes one as `\012` rather than breaking a process
  across two lines.
- **The recorder's own line reports the CoreSimulator path, not the one that was spawned.**
  `<developer-dir>/usr/bin/simctl` is a bash shim that `exec`s
  `/Library/Developer/PrivateFrameworks/CoreSimulator.framework/…/bin/simctl`, so a path
  comparison against what the backend spawned would match nothing — the basename is what works,
  and `exec` preserves the pid. That is visible in the capture and is why it is committed rather
  than described.
- **Re-capture with `SIGINT` and never with `kill -9`.** A killed recorder leaves CoreSimulator
  holding that device's recording lock — every later recording on it fails at exit 16, *"Host
  recording is already in progress"*, until the device is shut down and booted again
  (`docs/IOS.md` §8 trap 13). Re-capturing carelessly costs the operator their session, which is
  the same class of harm as trap 4 and the reason both are stated here rather than only in code.
- **The `.mov` is committed as bytes and is the only binary fixture in this folder.** It is a
  recording of a simulator's idle home screen: no application, no personal content, and no path
  inside it. `tests/fixtures/adb/screenrecord.finished…mp4` is its counterpart on the other
  platform and is committed for the same reason — a container check written against a
  hand-assembled file checks what its author believed, not what the tool writes.
- **The stderr capture is `.txt`, and carries no exit code.** Both halves are this folder's
  existing rule: it is prose because that is what the tool wrote, and the number lives in a table
  a reader can see rather than anywhere the code can reach. This run exited **0**, and so does a
  recording that produced nothing at all — which is exactly why the container is checked on the
  bytes (`docs/IOS.md` §8 trap 12).

## Two things about the contents

- **They are committed verbatim, and they contain the capturing operator's home directory** inside
  every entry's `dataPath` and `logPath`. A simulator UDID is not a credential and neither is a
  path under `~/Library/Developer/CoreSimulator`. If a redaction is ever wanted it is named here as
  a bend, never done silently.
- **The key set of a device entry is not fixed, and that is what decided the schemas' strictness.**
  All 22 entries carry `udid`, `name`, `state`, `deviceTypeIdentifier`, `isAvailable`, `dataPath`,
  `dataPathSize` and `logPath`; only 4 carry `logPathSize` and only 3 carry `lastBootedAt`. Apple
  adds keys per Xcode release, so `src/backends/ios-simulator/parsers/simctl-list.ts` is
  deliberately non-`.strict()` where `AdbDeviceSchema` is strict — see that module's header.
