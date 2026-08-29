# adb output fixtures

Every parser under `src/backends/android/parsers/` is pinned against output **captured from a
real device**, never written by hand (`ai/TESTING.md`). A hand-written fixture encodes what someone
believes adb prints, so the parser passes and the device disagrees — which is the exact bug these
files exist to prevent. Two of the fixtures below already earned their keep: `wm density` reports
`480` on a device whose `wm size` is `1280x2856`, and the daemon-failure capture prints an `error:`
line on the same stream as the device list.

Each filename carries the subject, the API level and the model slug:
`<subject>.api<sdk>-<model-slug>.<ext>`, where the slug is `ro.product.model` lowercased with every
run of non-alphanumerics collapsed to `-`. Captures that are not about one device (`devices-l.empty`,
`devices-l.daemon-failed`) carry no API level, because there was none to record.

Re-capture rather than hand-edit when a format changes, and add the new fixture **beside** the old
one: a parser has to keep working on the API levels already in use.

## Captures

All from an Android Emulator AVD `Pixel_10_Pro` (`sdk_gphone16k_arm64`, API 37 / Android 17) on
macOS, captured **2026-08-29**. `SERIAL` is `emulator-5554`. The enumeration, `wm` and
`uiautomator` rows were taken with `adb` 37.0.0-14910828; the app-control rows below them
(`install-success` onwards) with `adb` 37.0.1-15733141, the version that host had by then.

| Fixture | Command | Model | API | Captured |
|---|---|---|---|---|
| `getprop.api37-sdk-gphone16k-arm64.txt` | `adb -s $SERIAL shell getprop` | sdk_gphone16k_arm64 | 37 | 2026-08-29 |
| `devices-l.api37-sdk-gphone16k-arm64.txt` | `adb devices -l` | sdk_gphone16k_arm64 | 37 | 2026-08-29 |
| `wm-size.api37-sdk-gphone16k-arm64.txt` | `adb -s $SERIAL shell wm size` | sdk_gphone16k_arm64 | 37 | 2026-08-29 |
| `wm-density.api37-sdk-gphone16k-arm64.txt` | `adb -s $SERIAL shell wm density` | sdk_gphone16k_arm64 | 37 | 2026-08-29 |
| `wm-size.override.api37-sdk-gphone16k-arm64.txt` | `adb -s $SERIAL shell wm size 720x1600` then `wm size` | sdk_gphone16k_arm64 | 37 | 2026-08-29 |
| `wm-density.override.api37-sdk-gphone16k-arm64.txt` | `adb -s $SERIAL shell wm density 320` then `wm density` | sdk_gphone16k_arm64 | 37 | 2026-08-29 |
| `devices-l.daemon-start.api37-sdk-gphone16k-arm64.txt` | `adb kill-server; adb devices -l > f 2>&1` | sdk_gphone16k_arm64 | 37 | 2026-08-29 |
| `devices-l.offline.api37-sdk-gphone16k-arm64.txt` | `adb -s $SERIAL reboot` then poll `adb devices -l` | sdk_gphone16k_arm64 | 37 | 2026-08-29 |
| `devices-l.daemon-failed.txt` | `adb kill-server; adb devices -l > f 2>&1`, racing a still-shutting-down daemon | — (none attached) | — | 2026-08-29 |
| `devices-l.empty.txt` | `adb devices -l`, emulator shut down | — (none attached) | — | 2026-08-29 |
| `uiautomator.api37-sdk-gphone16k-arm64.xml` | `adb -s $SERIAL shell uiautomator dump /sdcard/window_dump.xml` then `adb -s $SERIAL exec-out cat /sdcard/window_dump.xml` | sdk_gphone16k_arm64 | 37 | 2026-08-29 |
| `install-success.api37-sdk-gphone16k-arm64.txt` | `adb -s $SERIAL install -r -t app.apk` (stdout) | sdk_gphone16k_arm64 | 37 | 2026-08-29 |
| `resolve-activity.api37-sdk-gphone16k-arm64.txt` | `adb -s $SERIAL shell cmd package resolve-activity --brief com.android.settings` | sdk_gphone16k_arm64 | 37 | 2026-08-29 |
| `resolve-activity.none.api37-sdk-gphone16k-arm64.txt` | the same for `com.rover.nope` | sdk_gphone16k_arm64 | 37 | 2026-08-29 |
| `am-start.api37-sdk-gphone16k-arm64.txt` | `adb -s $SERIAL shell am start -n com.android.settings/.Settings` (stdout) | sdk_gphone16k_arm64 | 37 | 2026-08-29 |
| `am-start.top-most.api37-sdk-gphone16k-arm64.txt` | the same again while it is on top, `> f 2>&1` | sdk_gphone16k_arm64 | 37 | 2026-08-29 |
| `am-force-stop.daemon-start.stderr.api37-sdk-gphone16k-arm64.txt` | `adb kill-server; adb -s $SERIAL wait-for-device shell am force-stop com.android.settings 2> f` | sdk_gphone16k_arm64 | 37 | 2026-08-29 |
| `pm-clear-success.api37-sdk-gphone16k-arm64.txt` | `adb -s $SERIAL shell pm clear com.android.traceur` (stdout) | sdk_gphone16k_arm64 | 37 | 2026-08-29 |
| `track-devices-l.connect-disconnect.api37-sdk-gphone16k-arm64.txt` | `adb track-devices -l > f`, then `adb connect localhost:5555` and `adb disconnect localhost:5555` | sdk_gphone16k_arm64 | 37 | 2026-08-29 |

Both `wm` overrides were reset with `wm size reset` / `wm density reset` immediately after the
capture. The `track-devices` capture leaves the host as it found it the same way: the second entry
it creates is removed by the `adb disconnect` that is part of the recipe, confirmed with
`adb devices -l` afterwards.

The hierarchy dump is **Settings → Display & touch**, unscrolled, reached with `adb shell am start
-a android.settings.DISPLAY_SETTINGS`. It was chosen over the Settings home page because it is the
one screen carrying everything the parser has to handle at once: 75 nodes 13 deep, a non-empty
`content-desc`, an entity-encoded `&` in both a `text` and a `content-desc`, two nested scrollable
containers, a checkable `Switch` whose `checked` disagrees with its `checkable`, 38 single-child
nodes, and a row clipped by the bottom of the scroll viewport. Navigate back to that screen before
re-capturing — a fixture nobody can re-create is a fixture nobody can extend.

## What the capture showed

- **The `* daemon …` banner goes to stderr, not stdout**, on `adb` 37.0.0. So the daemon-start and
  daemon-failure fixtures are **merged-stream** captures (`> f 2>&1`) — that is the situation the
  banner-skipping is actually for, and the fixture reflects it honestly rather than pretending the
  lines arrive on stdout.
- **A failing daemon prints an `error:` line above the device list.** `error: cannot connect to
  daemon at tcp:5037: Connection refused` parses as a device with the serial `error:` under any
  scheme that skips known prefixes, so `parseAdbDevices` anchors on the `List of devices attached`
  header and treats everything above it as preamble.
- **`adb shell wm …` returned LF, not CRLF, on this build.** The parsers strip CRLF anyway — an
  `adb shell` that returns it is well documented — but no fixture here proves that path, so the
  CRLF assertions in `wm.test.ts` use inline input and say so.
- **A node clipped by a scrolling container has inverted `bounds`.** The last visible row in the
  hierarchy dump is `bounds="[96,2798][399,2784]"` — its top *below* its bottom, a height of -14.
  `parseUiHierarchy` reports that subtraction as it stands rather than clamping it to zero: a
  clamped rectangle is one the device never described, and this is the rectangle every target
  resolution downstream is addressed through.
- **The dump must be fetched with `exec-out`, not `adb shell cat`.** The shell path translates
  `\n` → `\r\n` and corrupts the document. `uiautomator dump /dev/tty` is the other tempting
  shortcut and is also wrong — it interleaves adb's own `UI hierchary dumped to: …` line (adb's
  typo, not this file's) with the XML.
- **The app-control captures are per-stream, and which stream matters.** `am-start.top-most` is a
  **merged** capture because its `Warning: Activity not started, …` line comes back on stderr while
  `Starting: Intent {…}` goes to stdout, and the point of the fixture is that both together are a
  launch that succeeded. `am-force-stop.daemon-start.stderr` is a **stderr-only** capture whose
  stdout was zero bytes — that pair *is* the finding: a force-stop that worked, exiting 0, with
  adb's own banner on stderr. Anything asserting "this stream is empty" reads that as a device
  failure.
- **`adb install -r` printed two lines here, where the capture behind PROJECT.md §6 printed four.**
  adb chose the streamed path rather than the incremental one, so `Performing Streamed Install` /
  `Success` with an empty stderr. Both are real, and either one defeats `stdout.trim() ===
  'Success'` — the assertion is a `Success` **line**.
- **The install fixture was captured with `-t` added.** The only APK on the capture host is a
  test-only debug build, which `install -r` alone refuses with `INSTALL_FAILED_TEST_ONLY` (exit 1);
  the flag changes what adb agrees to install, not what a success prints. The primitive itself does
  not pass `-t`. No APK is committed here — the fixture is adb's output, not the package.
- **`pm clear` was captured against `com.android.traceur`**, a package with no user data worth
  keeping, because the success path of that command destroys whatever it is pointed at. The failure
  path (`Failed`, stderr, exit 1) comes from `com.rover.nope`, which no device has.

- **The `track-devices` capture is raw bytes, not text**, and has to be read as a `Buffer`: its
  framing is four hex digits of payload **byte** length, so a fixture decoded before it reaches the
  decoder would prove the one thing that decoder exists to get right. It carries seven frames — the
  starting list, four while the connected entry negotiated (`offline`, `authorizing`, `offline`),
  the one where both entries are `device`, and the two that end back at one device. Nothing needed
  redacting: it contains only `emulator-5554`, `localhost:5555` and the emulator's own product and
  model, confirmed on the capture host before committing.
- **The same capture is the only fixture here with more than one device in a list**, and the only
  one carrying the `authorizing` state — both of which were listed below as shapes with no fixture,
  and are not any more. It is also the D18 case in miniature: two entries, one physical emulator,
  distinguishable only by the serial.

- **The hierarchy XML has no trailing newline**, and every one of its 75 nodes carries all 19
  attributes — `index`, `text`, `resource-id`, `class`, `package`, `content-desc`, the ten booleans,
  `bounds`, `drawing-order` and `hint`. `parseUiHierarchy` maps all of those except
  **`drawing-order` and `hint`, which it drops**; anything a newer API adds is dropped the same way.
  A dropped attribute becomes visible when a fixture from a newer API level is captured, which is
  the mechanism `ai/TESTING.md` already prescribes — so add the fixture first, then the field.

## Redactions

- `ro.boot.qemu.adb.pubkey` in the `getprop` fixture holds the **host's** adb public key and the
  username it was generated under. This repository is public, so the value was replaced with
  `<redacted: host adb public key, see README.md>` — the only edit made to any fixture here. The
  emulator's own `ro.serialno` / `ro.boot.serialno` (`EMULATOR36X6X11X0`) are throwaway and are
  kept verbatim.

## Shapes with no fixture yet

Nothing may be asserted about these until one exists — no test here claims anything about them.

- **A physical device.** Everything above is an emulator, chosen deliberately: a phone's
  `ro.serialno` is not throwaway and this repository is public. So `isEmulatorFromProps` has no
  captured negative case; `getprop.test.ts` builds one by deleting the markers from this same real
  dump, and says so in a comment.
- **Any API level other than 37.** `getprop` key names in particular have moved between releases.
- **`unauthorized`, `no permissions (…)`, `bootloader`, `recovery`, `sideload`.**
  Only `device`, `offline` and `authorizing` were captured, which is why `AdbDevice.state` is an
  open string and not an enum — the full token list is longer than what is pinned here, and writing
  it from memory would be the same mistake as a hand-written fixture.
- **A `goldfish` emulator.** Only `ro.hardware=ranchu` was observed, so only `ranchu` is encoded.
- **A device attached through another machine's address.** The `track-devices` capture has
  `localhost:5555`, which is a network transport to *this* host; producing a genuine
  `another-host` entry needs a second machine, so the `another-host` cases in
  `attachment.test.ts` and `backend.test.ts` are synthetic and say so.
- **An empty device list in a frame.** A second adb server on a spare port still discovers the
  running emulator, so no capture had one; `track.test.ts` drives the `0000` frame from an inline
  string and says so.
- **A hierarchy with `rotation` other than `0`**, and one from `uiautomator dump --compressed`.
- **A hierarchy with more than one root `<node>`** — split screen, or a second display.
  `parseUiHierarchy` refuses one rather than reading the first window and answering confidently
  about a screen the caller is not looking at; supporting it needs a capture that has one.
