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
different host. Nothing in this folder re-verifies anything in that document.

## Captures

| Fixture | Command | Xcode | Runtime | Captured |
|---|---|---|---|---|
| `simctl-list.xcode26.4.1-ios26.4.1.json` | `xcrun simctl list -j` | 26.4.1 | 26.4.1 | 2026-09-08 |
| `simctl-list-devices.xcode26.4.1-ios26.4.1.json` | `xcrun simctl list -j devices` | 26.4.1 | 26.4.1 | 2026-09-08 |
| `device-type-profile.iphone-17-pro.xcode26.4.1.plist` | `cp` (below) | 26.4.1 | n/a | 2026-09-08 |
| `device-type-profile.ipad-pro-13-inch-m5.xcode26.4.1.plist` | `cp` (below) | 26.4.1 | n/a | 2026-09-08 |

The all-listings capture is the primary one: `xcrun simctl list -j` with no type argument answers
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
