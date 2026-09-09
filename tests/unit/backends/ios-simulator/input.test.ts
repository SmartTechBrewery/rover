import { describe, expect, it } from 'vitest';
import {
	buttonEvents,
	DEVICE_KEYS,
	isScreenBlanked,
	READ_SCREEN_BLANKED_ARGV,
	SCREEN_BLANKED_NOTIFICATION,
	swipeEvents,
	tapEvents,
	typeTextEvents,
	untypeableCharacters,
} from '@/backends/ios-simulator/input.js';
import { DeviceKeySchema } from '@/core/device.js';

/**
 * The pure half of the input primitives — the key table, the HID events and the text rules. No
 * process and no device (ai/TESTING.md); what a device does with any of it was measured first and
 * is recorded in `docs/IOS.md` §§2 and 5, and `tests/device/ios-simulator/input.test.ts` is the
 * half that keeps that honest.
 *
 * Every rule below is one the bench actually drove. The comments say what came back, because that
 * — not this file — is the reason each rule is the shape it is.
 */

describe('DEVICE_KEYS', () => {
	/**
	 * Pinned literally rather than derived, and worth the tedium for `../android/input.ts`'s
	 * reason in a sharper form: `hid` accepted a keycode of `9999` with an empty response and did
	 * nothing (measured), so a wrong entry in this table is a key that reports success and presses
	 * nothing. Nothing at runtime can see that.
	 */
	it('presses the two buttons this platform has and refuses the two it does not', () => {
		expect(DEVICE_KEYS.home).toEqual({ button: 'HOME', onlyWhenBlanked: false });
		expect(DEVICE_KEYS.wake).toEqual({ button: 'LOCK', onlyWhenBlanked: true });
		expect(DEVICE_KEYS.back).toHaveProperty('noEquivalent');
		expect(DEVICE_KEYS.recents).toHaveProperty('noEquivalent');
	});

	// The compile-time exhaustiveness is `satisfies Record<DeviceKey, KeyAnswer>`; this is the
	// runtime half, so a key added to the enum without an entry here is red rather than
	// `undefined` reaching a lookup.
	it('covers the whole DeviceKey vocabulary and nothing else', () => {
		expect(Object.keys(DEVICE_KEYS).sort()).toEqual([...DeviceKeySchema.options].sort());
	});

	/**
	 * **The two refusals are present rather than absent**, which is the difference between a
	 * backend that has decided about a key and one that forgot it — and the reason each is a
	 * sentence rather than a flag is that it is what the agent is told (`UnsupportedKeyError`).
	 */
	it('gives each refused key a reason a caller can act on', () => {
		for (const key of ['back', 'recents'] as const) {
			const answer = DEVICE_KEYS[key];
			expect('noEquivalent' in answer && answer.noEquivalent.length).toBeGreaterThan(40);
		}
	});

	/**
	 * `wake` must be the conditional one and `home` must not be. The button behind `wake`
	 * *toggles*, so an unconditional press puts a woken device to sleep — the verb doing the
	 * opposite of its name, silently, which is what `../android/input.ts` refuses `KEYCODE_POWER`
	 * to avoid.
	 */
	it('makes only wake conditional on the screen being off', () => {
		const conditional = Object.entries(DEVICE_KEYS)
			.filter(([, answer]) => 'button' in answer && answer.onlyWhenBlanked)
			.map(([key]) => key);

		expect(conditional).toEqual(['wake']);
	});
});

describe('the screen-blanked read', () => {
	it('asks notifyutil for the state of the name this platform publishes it under', () => {
		expect(READ_SCREEN_BLANKED_ARGV).toEqual(['notifyutil', '-g', SCREEN_BLANKED_NOTIFICATION]);
	});

	// Both lines exactly as the tool wrote them on the bench, trailing newline included.
	it('reads the two states the bench drove it through', () => {
		expect(isScreenBlanked(`${SCREEN_BLANKED_NOTIFICATION} 1\n`)).toBe(true);
		expect(isScreenBlanked(`${SCREEN_BLANKED_NOTIFICATION} 0\n`)).toBe(false);
	});

	/**
	 * **A line about something else is a failure, not a woken device**, and that is the load-bearing
	 * case: `notifyutil` echoes whatever name it was asked about, so a mismatch means this host and
	 * the tool disagree about the argv. Reading it as `false` would make `wake` a permanent no-op
	 * without anything to see.
	 */
	it('refuses a line that is not this name, rather than reading it as awake', () => {
		expect(() => isScreenBlanked('com.apple.something.else 1')).toThrow(/not the one/);
		expect(() => isScreenBlanked('')).toThrow(/not the one/);
		expect(() => isScreenBlanked(`${SCREEN_BLANKED_NOTIFICATION}`)).toThrow(/not the one/);
		expect(() => isScreenBlanked(`${SCREEN_BLANKED_NOTIFICATION} 0 extra`)).toThrow(/not the one/);
	});

	/** A state this bench never saw is not the one state that means "off". */
	it('reads anything that is not the off state as awake', () => {
		expect(isScreenBlanked(`${SCREEN_BLANKED_NOTIFICATION} 2`)).toBe(false);
	});
});

describe('tapEvents', () => {
	/**
	 * **Points straight through.** idb takes the same unit `ScreenInfo.widthDp` is in, so there is
	 * no `toDevicePixels` analogue and this case is what says so: a fractional coordinate arrives
	 * as itself rather than floored into a pixel column.
	 */
	it('passes the point through unconverted, fractions and all', () => {
		expect(tapEvents({ x: 201.5, y: 437.25 })).toEqual([
			{ press: { action: { touch: { point: { x: 201.5, y: 437.25 } } }, direction: 'DOWN' } },
			{ press: { action: { touch: { point: { x: 201.5, y: 437.25 } } }, direction: 'UP' } },
		]);
	});

	/**
	 * A `NaN` is a perfectly valid `double` on the wire: the companion accepted one, answered, and
	 * tapped nothing (measured). So it is refused here, where it is loud.
	 */
	it.each([
		['x', { x: Number.NaN, y: 1 }],
		['y', { x: 1, y: Number.POSITIVE_INFINITY }],
	])('refuses a non-finite %s before anything is sent', (_which, at) => {
		expect(() => tapEvents(at)).toThrow(/finite/);
	});

	/**
	 * And the range is deliberately **not** checked. A point a hundred thousand points off the
	 * panel was accepted in silence too, and keeping one on the screen is the job of the layer that
	 * already holds the screen it resolved the point from (D12).
	 */
	it('accepts a point past the edge of any panel', () => {
		expect(tapEvents({ x: 99_999, y: -1 })).toHaveLength(2);
	});
});

describe('swipeEvents', () => {
	/**
	 * **Milliseconds in, seconds out**, and the unit is the trap: `HIDSwipe.duration` is a `double`
	 * of seconds, so an unconverted number is a 300 ms swipe held for five minutes — accepted by
	 * the companion, and blocking the lease for all of it.
	 */
	it('converts the duration to the seconds idb takes', () => {
		expect(swipeEvents({ x: 2, y: 450 }, { x: 300, y: 450 }, 300)).toEqual([
			{ swipe: { start: { x: 2, y: 450 }, end: { x: 300, y: 450 }, duration: 0.3 } },
		]);
	});

	/** One event, not a stream of touches: the companion interpolates it. */
	it('is one event however long the gesture is', () => {
		expect(swipeEvents({ x: 0, y: 0 }, { x: 1, y: 1 }, 1_500)).toHaveLength(1);
	});

	/**
	 * **This is also the long press** — a drag from a point to the same point, held. Verified on
	 * the bench: 0.8 s of it raised an app icon's context menu on Springboard, so
	 * `src/verbs/input.ts`' composition needs nothing new here.
	 */
	it('describes a long press as the same point held', () => {
		const at = { x: 108.5, y: 183.5 };

		expect(swipeEvents(at, at, 800)).toEqual([{ swipe: { start: at, end: at, duration: 0.8 } }]);
	});

	/**
	 * Zero is allowed even though it moves nothing on this platform — measured at 3 ms with the
	 * home screen on the same page, where 0.05 s turned it. The duration is the caller's, and every
	 * verb that composes one passes its own; refusing a value the platform accepts would be this
	 * module inventing a rule rather than reporting one.
	 */
	it('allows a zero duration', () => {
		expect(swipeEvents({ x: 1, y: 1 }, { x: 2, y: 2 }, 0)[0]).toMatchObject({
			swipe: { duration: 0 },
		});
	});

	// Both were accepted in silence by the companion, so nothing downstream would report them.
	it.each([
		-1,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])('refuses a duration of %s before anything is sent', (durationMs) => {
		expect(() => swipeEvents({ x: 1, y: 1 }, { x: 2, y: 2 }, durationMs)).toThrow(/duration/);
	});

	it('refuses a non-finite coordinate at either end', () => {
		expect(() => swipeEvents({ x: Number.NaN, y: 1 }, { x: 2, y: 2 }, 100)).toThrow(/finite/);
		expect(() => swipeEvents({ x: 1, y: 1 }, { x: 2, y: Number.NaN }, 100)).toThrow(/finite/);
	});
});

describe('buttonEvents', () => {
	it('presses and releases the button, in that order', () => {
		expect(buttonEvents('HOME')).toEqual([
			{ press: { action: { button: { button: 'HOME' } }, direction: 'DOWN' } },
			{ press: { action: { button: { button: 'HOME' } }, direction: 'UP' } },
		]);
	});

	/** A `DOWN` with no `UP` leaves a finger on the glass — idb's own client builds every press as a pair. */
	it('never sends a press without its release', () => {
		expect(
			buttonEvents('LOCK').map((event) => ('press' in event ? event.press.direction : null)),
		).toEqual(['DOWN', 'UP']);
	});
});

describe('typeTextEvents', () => {
	/** Two events per unshifted character, four for a shifted one, and left shift is keycode 225. */
	it('types an unshifted character as one key down and up', () => {
		expect(typeTextEvents('a')).toEqual([
			{ press: { action: { key: { keycode: 4 } }, direction: 'DOWN' } },
			{ press: { action: { key: { keycode: 4 } }, direction: 'UP' } },
		]);
	});

	it('holds left shift over a shifted character and releases it after', () => {
		expect(typeTextEvents('A')).toEqual([
			{ press: { action: { key: { keycode: 225 } }, direction: 'DOWN' } },
			{ press: { action: { key: { keycode: 4 } }, direction: 'DOWN' } },
			{ press: { action: { key: { keycode: 4 } }, direction: 'UP' } },
			{ press: { action: { key: { keycode: 225 } }, direction: 'UP' } },
		]);
	});

	/**
	 * The whole map, pinned against the source it was transcribed from — idb's `KEY_MAP`
	 * (`idb/common/hid.py`), which is where the mapping lives in that project because the companion
	 * has no text RPC at all. All 95 of these went in one stream and came back out of a text field
	 * byte-identical (measured), so this table is verified as a whole rather than key by key.
	 */
	it.each([
		[' ', 44, false],
		['1', 30, false],
		['9', 38, false],
		['0', 39, false],
		['!', 30, true],
		[')', 39, true],
		['-', 45, false],
		['_', 45, true],
		['=', 46, false],
		['+', 46, true],
		['[', 47, false],
		['{', 47, true],
		[']', 48, false],
		['}', 48, true],
		['\\', 49, false],
		['|', 49, true],
		[';', 51, false],
		[':', 51, true],
		["'", 52, false],
		['"', 52, true],
		['`', 53, false],
		['~', 53, true],
		[',', 54, false],
		['<', 54, true],
		['.', 55, false],
		['>', 55, true],
		['/', 56, false],
		['?', 56, true],
		['z', 29, false],
		['Z', 29, true],
	])('types %s as keycode %i', (character, keycode, shifted) => {
		expect(typeTextEvents(character)).toHaveLength(shifted ? 4 : 2);
		expect(typeTextEvents(character).at(shifted ? 1 : 0)).toEqual({
			press: { action: { key: { keycode } }, direction: 'DOWN' } as const,
		});
	});

	/**
	 * **One stream for the whole string.** There is no analogue of the Android side's `%s` cut:
	 * nothing in a caller's text is read rather than typed, so a hundred characters is one call and
	 * there is no run in which half the text lands.
	 */
	it('types every printable ASCII character in one batch', () => {
		const ascii = Array.from({ length: 95 }, (_, index) => String.fromCharCode(0x20 + index)).join(
			'',
		);

		// 95 characters, 47 of which need the shift — the 26 capitals and 21 punctuation marks: two
		// events each, plus the two that hold and release the shift.
		expect(typeTextEvents(ascii)).toHaveLength(95 * 2 + 47 * 2);
	});

	/**
	 * An empty string is an empty stream rather than nothing at all, so a `typeText('')` still
	 * reaches the device — the companion accepts an empty stream in 1 ms — and a device that has
	 * gone is still reported.
	 */
	it('is an empty batch for an empty string', () => {
		expect(typeTextEvents('')).toEqual([]);
	});

	/** The refusal belongs to `untypeableCharacters`, and this is the guard behind it. */
	it('refuses to invent an event for a character with no key', () => {
		expect(() => typeTextEvents('é')).toThrow(/untypeableCharacters/);
	});
});

/**
 * The refusal, and every exclusion below was measured rather than assumed:
 *
 * - outside printable ASCII there is **no key at all** in idb's map, so nothing would be sent;
 * - a **tab** is a real key and inserts nothing — a field reading `abc` read `abc` after one;
 * - a **newline** is Return, and it *submits* — `abc\n` into Safari's address bar navigated.
 */
describe('untypeableCharacters', () => {
	it.each([
		'',
		'hello world',
		'a%sb',
		'!@#$%^&*()_+{}|:"<>?~`',
		'O\'Brien said "no"',
	])('accepts %j, which the device typed verbatim', (text) => {
		expect(untypeableCharacters(text)).toEqual([]);
	});

	it('names a tab, which the device accepts and does not type', () => {
		expect(untypeableCharacters('a\tb')).toEqual(['U+0009 ("\\t")']);
	});

	it('names a newline, which is Return on this platform rather than a character', () => {
		expect(untypeableCharacters('a\nb')).toEqual(['U+000A ("\\n")']);
	});

	it('names a character no key on this map produces', () => {
		expect(untypeableCharacters('café')).toEqual(['U+00E9 ("é")']);
	});

	/** Deduplicated and in first-seen order, so a paragraph of one wrong alphabet names each once. */
	it('names each offender once, in the order it was first seen', () => {
		expect(untypeableCharacters('日本語日本')).toEqual([
			'U+65E5 ("日")',
			'U+672C ("本")',
			'U+8A9E ("語")',
		]);
	});

	/**
	 * The **codepoint** is what makes this readable, and it is why the escape is not just
	 * `JSON.stringify`: a zero-width joiner quoted on its own is still nothing on the screen, and a
	 * caller shown its own string back learns no more than it already knew.
	 */
	it('names an invisible character by its codepoint', () => {
		expect(untypeableCharacters('a‍b')).toEqual(['U+200D ("‍")']);
	});
});
