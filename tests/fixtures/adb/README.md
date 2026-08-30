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
macOS. `SERIAL` is `emulator-5554`. Everything above the `input` rows was captured
**2026-08-29**: the enumeration, `wm` and `uiautomator` rows with `adb` 37.0.0-14910828, and the
app-control rows below them (`install-success` onwards) with `adb` 37.0.1-15733141, the version
that host had by then. The three `input` rows were captured **2026-08-30** on a host back on
`adb` 37.0.0-14910828.

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
| `cmd-connectivity-airplane-mode.bad-argument.api37-sdk-gphone16k-arm64.txt` | `adb -s $SERIAL shell cmd connectivity airplane-mode nonsense > f 2>&1` | sdk_gphone16k_arm64 | 37 | 2026-08-29 |
| `cmd-wifi-set-wifi-enabled.bad-argument.api37-sdk-gphone16k-arm64.txt` | `adb -s $SERIAL shell cmd wifi set-wifi-enabled nonsense > f 2>&1` | sdk_gphone16k_arm64 | 37 | 2026-08-29 |
| `input.unknown-command.api37-sdk-gphone16k-arm64.txt` | `adb -s $SERIAL shell input frobnicate 1 2 > f 2>&1` | sdk_gphone16k_arm64 | 37 | 2026-08-30 |
| `input-tap.missing-argument.api37-sdk-gphone16k-arm64.txt` | `adb -s $SERIAL shell input tap > f 2>&1` | sdk_gphone16k_arm64 | 37 | 2026-08-30 |
| `input-text.non-ascii.api37-sdk-gphone16k-arm64.txt` | `adb -s $SERIAL shell input text 'zażółć' > f 2>&1` | sdk_gphone16k_arm64 | 37 | 2026-08-30 |
| `uiautomator-dump.api37-sdk-gphone16k-arm64.txt` | `adb -s $SERIAL shell uiautomator dump /sdcard/window_dump.xml > f 2>&1` | sdk_gphone16k_arm64 | 37 | 2026-08-30 |
| `uiautomator-dump.unwritable-path.api37-sdk-gphone16k-arm64.txt` | `adb -s $SERIAL shell uiautomator dump /data/nope/window_dump.xml > f 2>&1` | sdk_gphone16k_arm64 | 37 | 2026-08-30 |

Both `wm` overrides were reset with `wm size reset` / `wm density reset` immediately after the
capture. The `track-devices` capture leaves the host as it found it the same way: the second entry
it creates is removed by the `adb disconnect` that is part of the recipe, confirmed with
`adb devices -l` afterwards.

The two network captures come from a session that toggled the emulator's radios repeatedly, and it
ended the way it found them: `settings get global airplane_mode_on` → `0`, `settings get global
wifi_on` → `1`, `cmd wifi status` → `Wifi is enabled`.

The two `uiautomator-dump.…` captures are the dump command's **own** output, not the document —
`../../../src/backends/android/parsers/uiautomator.ts` reads them, and the XML above is what
`parsers/hierarchy.ts` reads. Both were taken with `> f 2>&1` because which stream adb uses is the
thing being recorded: the confirmation `UI hierchary dumped to: <path>` (adb's typo, not ours)
lands on **stdout**, and stderr was empty.

The `unwritable-path` capture is there because of what it proves: `uiautomator dump` printed the
same confirmation for `/data/nope/window_dump.xml`, exited 0, and wrote nothing —
`ls /data/nope/window_dump.xml` afterwards is `No such file or directory`. The line is a claim
about a path, not proof of a file, which is why the backend compares the path rather than treating
the line's presence as success.

**A dump that failed outright could not be reproduced on this emulator**, and no fixture is
invented for one. The `ERROR: could not get idle state` shape is widely reported for a screen that
is animating; three attempts to force it — a dump racing a fling, and five concurrent flings under
one dump — each returned the ordinary confirmation on 2026-08-30. Capture one beside these if a
device ever produces it.

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
- **The two network recipes have no success fixture, because their success is zero bytes.** `cmd
  connectivity airplane-mode enable|disable` and `cmd wifi set-wifi-enabled enabled|disabled` print
  nothing on either stream and exit 0 — repeating one that is already the case included. Committing
  two empty files would read as a mistake, so what is committed is the refusals, and
  `parsers/network.test.ts` takes its "silent, with adb's banner on stderr" case from the
  `am-force-stop.daemon-start.stderr` capture already here: that banner is written by the adb
  *client* before it dispatches any subcommand, so it is not per-verb output and a byte-identical
  copy under a network name would be a second thing to keep in sync (the capture was taken and
  compared — it is identical).
- **Both network refusals land on stdout with an empty stderr, at exit 255** — the opposite stream
  from `am start`'s, which is why nothing here may assume one stream carries the reason. They are
  merged captures (`> f 2>&1`) for the app-control fixtures' reason, and because stderr contributed
  nothing the file is byte-identical to a stdout-only capture. `cmd connectivity airplane-mode`
  answers a bad argument with the connectivity service's **entire help text**, which is why the
  fixture is 943 bytes of something that looks nothing like an error; `cmd wifi set-wifi-enabled`
  answers with one `Invalid args for set-wifi-enabled: java.lang.IllegalArgumentException: …` line.
- **The two commands take different words for the same boolean.** `airplane-mode` wants
  `enable`/`disable`, `set-wifi-enabled` wants `enabled`/`disabled`; `set-wifi-enabled true` is the
  refusal that was captured under a different argument to prove it. Crossing the two vocabularies is
  loud rather than silent, and the argv pinning in `backend.test.ts` is what keeps it that way.

- **The `track-devices` capture is raw bytes, not text**, and has to be read as a `Buffer`: its
  framing is four hex digits of payload **byte** length, so a fixture decoded before it reaches the
  decoder would prove the one thing that decoder exists to get right. It carries seven frames — the
  starting list, four while the connected entry negotiated (`offline`, `authorizing`, `offline`),
  the one where both entries are `device`, and the two that end back at one device. Nothing needed
  redacting: it contains only `emulator-5554`, `localhost:5555` and the emulator's own product and
  model, confirmed on the capture host before committing.
- **The same capture is the only fixture here with more than one device in a list**, and the only
  one carrying the `authorizing` state — both of which were listed below as shapes with no fixture,
  and are not any more. It is also the attachment case in miniature (D18): two entries, one
  physical emulator, distinguishable only by the serial — which is why the classification reads
  the serial at all.

- **The hierarchy XML has no trailing newline**, and every one of its 75 nodes carries all 19
  attributes — `index`, `text`, `resource-id`, `class`, `package`, `content-desc`, the ten booleans,
  `bounds`, `drawing-order` and `hint`. `parseUiHierarchy` maps all of those except
  **`drawing-order` and `hint`, which it drops**; anything a newer API adds is dropped the same way.
  A dropped attribute becomes visible when a fixture from a newer API level is captured, which is
  the mechanism `ai/TESTING.md` already prescribes — so add the fixture first, then the field.

- **The three `input` captures are all refusals, because every `input` success is zero bytes.**
  `input tap`, `input swipe`, `input text` and `input keyevent` each print nothing on either
  stream and exit 0 (PROJECT.md §6), so four empty files would read as a mistake for the reason
  the network recipes' would. `parsers/input.test.ts` takes its "silent, with adb's banner on
  stderr" case from `am-force-stop.daemon-start.stderr` for the same reason `network.test.ts`
  does: the banner is the adb *client*'s, written before any subcommand is dispatched, so a
  byte-identical copy under an input name would be a second thing to keep in sync.
- **Only one of the three is a refusal the predicate ever sees.**
  `input.unknown-command` is `Unknown command: frobnicate` on **stdout at exit 0** — the opposite
  stream from `am start`'s refusals, and the one shape that reaches `acceptedInput` at all. The
  other two exited **255**, so `runAdb` rejects them first; they are pinned anyway, because an
  exit code that agrees today is not a reason to stop reading what the device said.
- **The two exit-255 captures are Java stack traces, and which exception matters.**
  `input-tap.missing-argument` is an `IllegalArgumentException: Argument expected after "tap"` —
  the shape every malformed argv takes. `input-text.non-ascii` is a
  `NullPointerException: Attempt to get length of null array` thrown from
  `InputShellCommand.sendText`, which is what a character `KeyCharacterMap` cannot produce looks
  like: **nothing at all is typed**, not even the ASCII around it. That capture is the evidence
  behind `src/backends/android/input.ts` refusing non-ASCII before the call rather than letting
  the device answer.
- **The worst `input` failure has no capture, because it produces no bytes.**
  `input keyevent NOT_A_KEY`, `input keyevent 999999` and `input tap 99999 99999` each exit **0
  with zero bytes on both streams** and do nothing. There is no fixture that could pin that and
  no predicate that could catch it; the keycode table and the dp→px conversion are pinned in
  `tests/unit/backends/android/input.test.ts` instead, and that is the whole reason those checks
  live before the call.
- **The `input` session left the device as it found it** — Settings force-stopped, the search
  field cleared, the home screen showing, `/sdcard/*.xml` scratch dumps removed, and
  `settings get global airplane_mode_on` / `wifi_on` re-read as `0` / `1`. It typed into the
  Settings search box because that is a text field reachable with one intent and one tap on any
  build, and what was typed was read back out of `uiautomator dump` — the exit code alone cannot
  tell a character that was typed from one that was dropped.

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
- **A device reachable only through another machine's address.** The `track-devices` capture has
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
