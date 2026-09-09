/**
 * The HID events behind the four `canInput` primitives — the pure half of this platform's input
 * vocabulary.
 *
 * `../android/input.ts`'s sibling and deliberately its shape: arithmetic and vocabulary, no
 * process. `./idb-client.js` owns the channel, `./backend.ts` is the join, and everything here is
 * asserted in `tests/unit/backends/ios-simulator/input.test.ts` without a device — after every
 * rule below was *measured* on one (`docs/IOS.md` §2, companion v1.5.2 / Xcode 26.4.1 / iOS 26.4,
 * 2026-09-09).
 *
 * The measurement is what this module is for, because `hid` is at least as willing to accept
 * nonsense in silence as `adb shell input` is. Measured on that bench, each one accepted with an
 * empty `HIDResponse` and nothing done: a keycode of `9999`, a touch at `NaN`, a touch at
 * `(99999, 99999)`, a swipe of `NaN` seconds and a swipe of `-1` seconds. So the checks that can
 * be made before the stream is opened are made here, where they are loud.
 *
 * **Points go straight through — there is no `toDevicePixels` analogue, and its absence is the
 * subtlety.** On the Android side that conversion is the seam of the whole capability, because
 * `PointSchema` is dp and `input tap` takes physical pixels. idb takes **points**, which is the
 * same unit `ScreenInfo.widthDp`/`heightDp` are in and the same unit `./screen.ts` maps frames
 * back from (`docs/IOS.md` §2, `readScreen`'s own acceptance criterion): the `AXApplication` node
 * of an iPhone 17 measures 402×874 where the panel is 1206×2622 px at scale 3. A conversion here
 * would therefore be the bug rather than the fix, in either direction, and it is stated rather
 * than left as an absence somebody adds later.
 */

import type { DeviceKey, Point } from '../../core/device.js';

/**
 * The buttons `HIDEvent.HIDButtonType` exposes, narrowed to the two this backend presses.
 *
 * `APPLE_PAY`, `SIDE_BUTTON` and `SIRI` are on the enum and are deliberately absent: nothing in
 * `DeviceKey` asks for them, and a name in this union is a promise that {@link DEVICE_KEYS} has a
 * measured answer behind it.
 */
export type IdbButton = 'HOME' | 'LOCK';

/**
 * What this platform answers for one key of the neutral vocabulary: a button to press, or no
 * equivalent at all and the reason there is none.
 */
export type KeyAnswer =
	| {
			readonly button: IdbButton;
			/**
			 * Whether the press is conditional on the screen being blanked — the difference between
			 * a key that does one thing and a button that *toggles*. `false` for every key but
			 * `wake`; {@link SCREEN_BLANKED_NOTIFICATION} carries the whole argument.
			 */
			readonly onlyWhenBlanked: boolean;
	  }
	| { readonly noEquivalent: string };

/**
 * The button each key of the neutral vocabulary presses on this platform, and the reason the two
 * that press nothing press nothing.
 *
 * `Record<DeviceKey, KeyAnswer>` rather than a lookup with a fallback, for
 * `../android/input.ts`'s reason and a sharper version of it: a key added to `DeviceKeySchema` is
 * a compile error here instead of a runtime miss, and a runtime miss on this transport is
 * undetectable — `hid` accepted keycode `9999` with an empty response and did nothing (measured).
 * `back` and `recents` are therefore present as **explicit refusals** rather than absent, so that
 * reading this table answers "what does this device do with that key" for all four.
 *
 * - **`home` → `HOME`.** Works on a home-buttonless iPhone 17 — pressed on the bench from inside
 *   Maps, Safari and Settings, and Springboard came back every time (`docs/IOS.md` §5).
 * - **`wake` → `LOCK`, but only when the screen is blanked.** The button idb exposes *toggles*,
 *   where Android's `KEYCODE_WAKEUP` does not, so a `wake` built naively puts a woken device to
 *   sleep — the silent inversion this vocabulary exists to avoid. What makes it idempotent is
 *   reading {@link SCREEN_BLANKED_NOTIFICATION} first; the measurement behind that read, and its
 *   one weakness, are on it.
 * - **`back` has no equivalent and is refused by name.** This reverses what `docs/IOS.md` §5's
 *   table recorded — a left-edge swipe, "verified working" — and the reversal is measured rather
 *   than argued. Driven through idb on 2026-09-09, the same `2,450 → 300,450` swipe **paged the
 *   home screen** on Springboard (a different set of icons came back) and did **nothing** on a
 *   Settings sheet, and both reported success. So the gesture is silent in one direction and
 *   wrong in the other, which is precisely the substitute `src/core/device.ts` forbids
 *   `pressKey` from making. On iOS back is a control in the app's own UI, which `read_screen` +
 *   `tap` already reaches by label, so nothing is lost by refusing the key.
 * - **`recents` has no equivalent and is refused by name.** Accepted 2026-09-08: the app-switcher
 *   gesture needs Indigo's edge bits, which idb's swipe does not set, so there is nothing behind
 *   it that is the app switcher (`docs/IOS.md` §3, §5).
 *
 * Both reasons are this platform's own words, passed to `UnsupportedKeyError` by `./backend.ts` —
 * that class names no device's particulars, and the serial it also needs is the caller's rather
 * than this module's.
 */
export const DEVICE_KEYS = {
	home: { button: 'HOME', onlyWhenBlanked: false },
	wake: { button: 'LOCK', onlyWhenBlanked: true },
	back: {
		noEquivalent:
			'there is no back key on iOS and the left-edge swipe is not one — driven through idb it ' +
			'paged the home screen on Springboard and did nothing at all on a modal sheet, both at ' +
			'exit 0. Back on this platform is a control in the app, which read_screen and tap reach ' +
			'by label',
	},
	recents: {
		noEquivalent:
			'there is no app-switcher key on iOS and no gesture this tool can send is one — the ' +
			'switcher recognises a system edge gesture from the injected edge bits, which idb does ' +
			'not set, so a bottom-edge swipe of any duration does nothing',
	},
} as const satisfies Record<DeviceKey, KeyAnswer>;

/**
 * The Darwin notification whose state says whether this device's screen is off.
 *
 * Read with `simctl spawn <udid> notifyutil -g <name>`, which answers one line, `<name> <value>`,
 * in ~360 ms. Measured on the bench across a full cycle from a woken, unlocked iPhone 17: the
 * first `LOCK` press took it to `1` (and `com.apple.springboard.lockstate` to `1` with it), and
 * every press after that **toggled it** — `1, 0, 1, 0` — while the lock state stayed `1`. The
 * flag follows the press in 1,861 ms going dark and 347 ms coming back, and three guarded
 * `wake`s in a row left it at `0`, which is the idempotence `PROJECT.md` R46 asks for.
 *
 * **It is the blanked-screen flag rather than the lock state, and that correction is the whole
 * of what the bench changed here.** R46 said "reads lock state first"; lock state is the wrong
 * question, because `LOCK` does not unlock — a locked, woken simulator stays locked however many
 * times it is pressed. What the button moves is the screen, which is also what Android's `wake`
 * moves: `KEYCODE_WAKEUP` lights a device up and leaves it on its lock screen.
 *
 * **The read reports the flag and cannot prove it exists, and that is stated because it cannot be
 * fixed.** `notifyutil -g` answers `<name> 0` for a name with no state at all — measured against
 * a name invented for the purpose, which came back indistinguishable from a woken device, at exit
 * 0 and with nothing on stderr. So on a runtime that stopped publishing this key a `wake` would
 * read "already awake" and press nothing. What guards that is
 * `tests/device/ios-simulator/input.test.ts`, which drives the flag through both values against
 * the runtime under test and fails if it stops moving — the same shape as every other rule here:
 * measured on a device, pinned by a suite that needs one.
 */
export const SCREEN_BLANKED_NOTIFICATION = 'com.apple.springboard.hasBlankedScreen';

/** The argv that reads it, after the udid `runSimctlOnDevice` pins. */
export const READ_SCREEN_BLANKED_ARGV = ['notifyutil', '-g', SCREEN_BLANKED_NOTIFICATION] as const;

/** What that read answers when the screen is off. */
const SCREEN_BLANKED_STATE = '1';

/**
 * Whether that line says the screen is off.
 *
 * Inline rather than in `./parsers/`, which is where the shapes with captured fixtures behind them
 * live (`./idb-client.ts` says the same of its own handshake): this is two tokens on one line, and
 * a fixture of it would be a copy of the assertion.
 *
 * The **name is checked**, not just the value, because `notifyutil` echoes whatever name it was
 * asked about — so a line naming something else is this host and the tool disagreeing about the
 * argv rather than a device that is awake, and reading it as `false` would be a silent no-op
 * `wake`. Anything else throws for the same reason: the whole point of the read is that the press
 * is conditional on it, so a read that cannot be believed must not be turned into "no press
 * needed".
 */
export function isScreenBlanked(stdout: string): boolean {
	const [name, state, ...rest] = stdout.trim().split(/\s+/);
	if (name !== SCREEN_BLANKED_NOTIFICATION || state === undefined || rest.length > 0) {
		throw new Error(
			`Cannot tell whether the screen is off: 'notifyutil -g ${SCREEN_BLANKED_NOTIFICATION}' ` +
				`answered ${JSON.stringify(stdout)}, which is not the one '<name> <state>' line it ` +
				'answers on a booted simulator.',
		);
	}
	return state === SCREEN_BLANKED_STATE;
}

/** A point as idb's `Point` message carries it — in points, which is what {@link Point} already is. */
interface HidPoint {
	readonly x: number;
	readonly y: number;
}

/** The three arms of `HIDEvent.HIDPressAction`'s `oneof`, of which this backend sends all three. */
type HidPressAction =
	| { readonly touch: { readonly point: HidPoint } }
	| { readonly button: { readonly button: IdbButton } }
	| { readonly key: { readonly keycode: number } };

/**
 * One message of the `hid` request stream.
 *
 * Structural rather than generated, for `./idb-client.ts`' reason: this repository runs from
 * source and loads the vendored `.proto` at run time, so there is no generated type to import and
 * a hand-written shape is what the compiler can check the event builders against. Only the two
 * arms of the event `oneof` this backend uses are here — `delay`, `pinch`, `orientation` and
 * `shake` are on the message and are nothing any verb asks for.
 */
export type HidEvent =
	| {
			readonly press: {
				readonly action: HidPressAction;
				readonly direction: 'DOWN' | 'UP';
			};
	  }
	| {
			readonly swipe: {
				readonly start: HidPoint;
				readonly end: HidPoint;
				readonly duration: number;
			};
	  };

/**
 * A press: the action down, then the same action up.
 *
 * Two events rather than one, because `HIDPress` carries a direction and the companion dispatches
 * exactly what it is given — a `DOWN` with no `UP` leaves a finger on the glass. idb's own client
 * builds every press this way (`idb/common/hid.py`), and it is the shape a long press is a
 * duration inside rather than a third event.
 */
function press(action: HidPressAction): HidEvent[] {
	return [{ press: { action, direction: 'DOWN' } }, { press: { action, direction: 'UP' } }];
}

/**
 * A tap at `at`, in the points idb takes — the module header carries why nothing is converted.
 *
 * Non-finite coordinates are refused here rather than sent, `../android/input.ts`' rule and for
 * a sharper reason: a `NaN` is a perfectly valid `double` on the wire, so the companion accepts
 * it, answers, and taps nothing (measured). The **range** is deliberately not checked — a point
 * past the edge of the panel is also accepted in silence, and keeping one on the screen is the
 * job of the layer that already holds the screen it resolved the point from (D12).
 */
export function tapEvents(at: Point): HidEvent[] {
	return press({ touch: { point: finitePoint(at, 'tap') } });
}

/**
 * A drag from `from` to `to` over `durationMs` — one `HIDSwipe`, not a stream of touches.
 *
 * **`delta` is left unset on purpose.** It is the step size the companion interpolates with, and
 * every gesture this backend has driven — a page turn, a Spotlight pull-down, an interactive pop,
 * a long press — worked on whatever the companion picks for itself. A number invented here would
 * be a device-feel constant with no measurement behind it.
 *
 * **This is also the long press**, `../android/backend.ts`' composition and verified on this
 * platform: a swipe from a point to the same point held 0.8 s raised an app icon's context menu
 * on Springboard (measured, 856 ms wall). So `src/verbs/input.ts` needs nothing new here.
 *
 * **A zero duration is dispatched and moves nothing**, and that differs from the Android side,
 * where `input swipe … 0` is a flick. Measured: a `300,500 → 100,500` swipe of 0 s came back in
 * 3 ms with the home screen on the same page, while the same swipe at 0.05 s turned it in 72 ms.
 * It is allowed rather than refused, because the duration is the caller's — every verb that
 * composes one passes its own (`SWIPE_DURATION_MS`, `SCROLL_DURATION_MS`, `LONG_PRESS_DURATION_MS`,
 * none of them zero) — and refusing a value the platform accepts would be this module inventing a
 * rule rather than reporting one.
 */
export function swipeEvents(from: Point, to: Point, durationMs: number): HidEvent[] {
	return [
		{
			swipe: {
				start: finitePoint(from, 'swipe'),
				end: finitePoint(to, 'swipe'),
				duration: toSwipeSeconds(durationMs),
			},
		},
	];
}

/** A button press — {@link DEVICE_KEYS} is what decides which button, and whether to press at all. */
export function buttonEvents(button: IdbButton): HidEvent[] {
	return press({ button: { button } });
}

/**
 * The whole of `text` as key presses, in order — usually two events per character, four for one
 * that needs the shift.
 *
 * **One stream, not one call per character.** All 95 printable ASCII characters went in a single
 * `hid` stream in **114 ms** and came back out of Safari's address bar byte-identical to what was
 * asked for (measured). So there is no analogue of `../android/input.ts`' `typeTextSegments`: no
 * sequence in a caller's text is read rather than typed, and nothing has to be cut around.
 *
 * **An empty string is an empty stream, and that still reaches the device** — the companion
 * accepts one and answers in 1 ms — so a `typeText('')` against a device that has gone is still
 * reported rather than resolving here.
 *
 * What the device will not type is {@link untypeableCharacters}, checked by the caller before this
 * runs: the two are split because a refusal needs the serial and this one is a lookup.
 */
export function typeTextEvents(text: string): HidEvent[] {
	return [...text].flatMap((character) => {
		const key = KEY_CODES[character];
		if (key === undefined) {
			throw new Error(
				`No key on this device types ${JSON.stringify(character)} — untypeableCharacters is ` +
					'what refuses that, and it has to be asked before this is called',
			);
		}
		return key.shifted
			? [
					{ press: { action: SHIFT_ACTION, direction: 'DOWN' } as const },
					...press({ key: { keycode: key.keycode } }),
					{ press: { action: SHIFT_ACTION, direction: 'UP' } as const },
				]
			: press({ key: { keycode: key.keycode } });
	});
}

/**
 * What `text` carries that this device will not type, as escapes a human can read back — empty
 * for a string it will.
 *
 * `../android/input.ts`' function, and deliberately a second copy of it rather than a shared one:
 * what is typable is a fact about a device, the two platforms reach the same answer by entirely
 * different routes, and a backend importing another backend's module is how a shared helper
 * acquires a `platform` argument (`ai/RULES.md` §2). The escapes are its idea and worth keeping —
 * most of what lands here is invisible in a message.
 *
 * **The set is printable ASCII, U+0020 to U+007E, and every exclusion was measured:**
 *
 * - **Outside that range there is no key at all.** idb's keyboard map is 95 printable characters
 *   plus `\n`, and it is the whole of what a HID keyboard on this platform can be asked for; a
 *   character that is not in it produces *no events*, so the alternative to refusing would be a
 *   call that reports success and types nothing.
 * - **A tab is dropped in silence** — keycode 43 is a real key, and pressing it left a field
 *   reading `abc` exactly as it had before, at exit 0 with an empty response. Android's `input
 *   text` drops one the same way, and this is the same refusal for the same reason.
 * - **A newline is not a character on this platform, it is Return.** Keycode 40 is in idb's map
 *   and it *submits*: typing `abc\n` into Safari's address bar navigated. Inserting nothing and
 *   navigating are both "not typing the text that was asked for", so it is refused with the rest
 *   — which also keeps this backend's typable set identical to the other one's, so a caller's
 *   string does not become platform-dependent.
 *
 * Answers rather than throws, and `./backend.ts` turns a non-empty answer into an
 * `UnsupportedTextError` — the error needs the serial, which is the caller's. Deduplicated and in
 * first-seen order, so a paragraph of one wrong alphabet names each letter once.
 */
export function untypeableCharacters(text: string): string[] {
	return [...new Set([...text].filter((character) => !(character in KEY_CODES)))].map(
		(character) => {
			const code = character.codePointAt(0) ?? 0;
			return `U+${code.toString(16).toUpperCase().padStart(4, '0')} (${JSON.stringify(character)})`;
		},
	);
}

/** The words `./backend.ts` hands `UnsupportedTextError` for what this device *can* take. */
export const TYPEABLE_TEXT = 'this device has keys for printable ASCII only';

/** Left Shift, the one modifier this map needs, as its own action so both events name one object. */
const SHIFT_KEYCODE = 225;
const SHIFT_ACTION: HidPressAction = { key: { keycode: SHIFT_KEYCODE } };

/** One character's key: the USB HID usage id, and whether the shift is held over it. */
interface TypedKey {
	readonly keycode: number;
	readonly shifted: boolean;
}

/**
 * Every character this device has a key for, and the key.
 *
 * The numbers are USB HID keyboard usage ids and the table is idb's own — `idb/common/hid.py`'s
 * `KEY_MAP`, which is where the mapping lives in that project because the companion has no text
 * RPC at all: `idb ui text` is a client-side expansion into key presses, so a backend talking gRPC
 * has to carry it. Transcribed rather than reasoned about, then **verified as a whole**: all 95
 * entries were typed in one stream and read back out of a text field byte-identical (measured).
 *
 * Built rather than written out, because 95 literal rows would be 95 chances to transpose a digit
 * where three ranges and one table of punctuation are checkable by eye — and the unit suite pins
 * the resulting map entry by entry against the same source.
 *
 * `\n` and `\t` are deliberately **absent** even though idb's map has one and a key exists for the
 * other; {@link untypeableCharacters} carries the measurement that put them out.
 */
const KEY_CODES: Readonly<Record<string, TypedKey>> = buildKeyCodes();

function buildKeyCodes(): Record<string, TypedKey> {
	const codes: Record<string, TypedKey> = {};
	const add = (characters: string, first: number, shifted = false): void => {
		[...characters].forEach((character, index) => {
			codes[character] = { keycode: first + index, shifted };
		});
	};

	add('abcdefghijklmnopqrstuvwxyz', 4);
	add('ABCDEFGHIJKLMNOPQRSTUVWXYZ', 4, true);
	// `1` through `9` are 30–38 and `0` is 39, which is the order the usage table puts them in and
	// not the order they count in.
	add('1234567890', 30);
	add('!@#$%^&*()', 30, true);

	const punctuation: ReadonlyArray<readonly [unshifted: string, shifted: string, keycode: number]> =
		[
			[' ', ' ', 44],
			['-', '_', 45],
			['=', '+', 46],
			['[', '{', 47],
			[']', '}', 48],
			['\\', '|', 49],
			[';', ':', 51],
			["'", '"', 52],
			['`', '~', 53],
			[',', '<', 54],
			['.', '>', 55],
			['/', '?', 56],
		];
	for (const [unshifted, shifted, keycode] of punctuation) {
		codes[unshifted] = { keycode, shifted: false };
		if (shifted !== unshifted) codes[shifted] = { keycode, shifted: true };
	}

	return codes;
}

/**
 * The duration of a swipe, as the seconds idb's `HIDSwipe` takes.
 *
 * **Seconds, and the unit is the trap.** Every duration this repository's contract carries is
 * milliseconds and `HIDSwipe.duration` is a `double` of seconds, so an unconverted number is a
 * swipe a thousand times too long — a 300 ms swipe held for five minutes, which the companion
 * accepts and blocks the whole lease on. Measured on the bench: 0.05 s took 72 ms of wall clock,
 * 0.25 s took 345 ms, 0.3 s took 405 ms and 1.5 s took 1,660 ms, so the number is honoured with
 * about 100 ms of overhead over it.
 *
 * Not rounded, unlike the Android side's whole milliseconds: this argument is a `double` and the
 * nearest anything is the value itself.
 *
 * Negative and non-finite are programmer errors and are refused before anything is sent — both
 * were accepted in silence by the companion (measured), so nothing downstream would report them.
 */
function toSwipeSeconds(durationMs: number): number {
	if (!Number.isFinite(durationMs) || durationMs < 0) {
		throw new Error(
			`Cannot swipe for ${durationMs}ms: a duration must be a finite number of milliseconds, not negative`,
		);
	}
	return durationMs / 1_000;
}

/** A point idb will act on, or the programmer error that was about to be dispatched in silence. */
function finitePoint(at: Point, what: string): HidPoint {
	if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) {
		throw new Error(
			`Cannot ${what} at (${at.x}, ${at.y}): both coordinates must be finite numbers`,
		);
	}
	return { x: at.x, y: at.y };
}
