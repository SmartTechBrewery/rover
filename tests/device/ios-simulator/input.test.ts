import { afterAll, describe, expect, it } from 'vitest';
import { IosSimulatorDeviceBackend } from '@/backends/ios-simulator/backend.js';
import { IdbCompanions } from '@/backends/ios-simulator/idb-client.js';
import {
	buttonEvents,
	isScreenBlanked,
	READ_SCREEN_BLANKED_ARGV,
} from '@/backends/ios-simulator/input.js';
import { runSimctlOnDevice } from '@/backends/ios-simulator/simctl.js';
import type { Device, Rect, ScreenElement } from '@/core/device.js';
import { WaitTimeoutError } from '@/core/errors.js';
import type { DeviceSerial } from '@/core/ids.js';
import { type Observation, waitForCondition } from '@/core/wait.js';

/**
 * The four input primitives against a real booted simulator, **each one verified by reading the
 * screen back** rather than by the call returning.
 *
 * That is the whole point of this suite and it is not a preference. `hid` answers an empty
 * `HIDResponse`, and on this bench it answered exactly that for a keycode of `9999`, a touch at
 * `NaN` and a touch a hundred thousand points off the panel — so a suite that asserted "the call
 * resolved" would be green on a backend that injected nothing at all. `docs/IOS.md` §2's own
 * evidence for this platform is a loop of the same shape: inject, read the screen back, check what
 * moved.
 *
 * Gated on **both** flags `tests/device/setup.ts` sets — a booted simulator and a companion this
 * host can run — so a machine missing either **skips rather than fails** (ai/TESTING.md).
 *
 * **The target is Spotlight, and it is chosen rather than settled for.** Everything below happens
 * on the home screen's own search, which needs no application installed, no toolchain and no label
 * a locale could change: the search field comes through the neutral read as the one element with a
 * **value** and a **control inside it** ({@link searchField}), so the assertions are on the string
 * this suite typed and on nothing anybody translated. It is also completely reversible —
 * `pressKey('home')` puts the device back where it was found, which is what {@link restore} does
 * after every case.
 *
 * **The tap target is deliberately tiny.** The button inside the search field is 20×19 points on
 * an iPhone 17, and this suite finds it *geometrically* — the element whose bounds sit inside the
 * field's. A point converted to physical pixels would land three times further from the origin and
 * miss it by the width of the screen, so this case is what would catch a `toDevicePixels` analogue
 * being added to `src/backends/ios-simulator/input.ts` by somebody matching the Android side
 * (`docs/IOS.md` §2).
 *
 * It takes no lease, for `./read-screen.test.ts`' reason: the refusals **over** a lease are
 * `./verb-dispatch.test.ts`'s, and what is here is the primitives underneath them. What it does
 * have to clean up is a **process** — the companion these calls start outlives them by design.
 */
const backend = new IosSimulatorDeviceBackend();

/** Generous, because each probe is a screen read and a simulator can be busy. */
const SETTLE_TIMEOUT_MS = 15_000;
const SETTLE_POLL_MS = 250;

/**
 * How long the screen is watched for going dark when it must not — the one assertion here that is
 * about something *not* happening.
 *
 * 1,861 ms is what the same press took to blank this bench's iPhone 17 (`docs/IOS.md` §5), so this
 * is two and a half times the window the thing being ruled out needs, and the poll is fine enough
 * to catch it on its way past. It is a bounded watch for a failure rather than a delay: what the
 * case asserts is that the condition never becomes true, and `waitForCondition` timing out is how
 * that is said (ai/RULES.md §2 — nothing here sleeps).
 */
const MUST_NOT_BLANK_MS = 5_000;
const BLANK_POLL_MS = 200;

/** Three strings, so the loop is a rotation rather than the same injection six times. */
const WORDS = ['rover', 'giotto', 'zzqqxx'] as const;

/** What the priming round types, which only has to be something rather than anything in particular. */
const PRIMER = 'rover';

afterAll(async () => {
	await backend.stopIdbCompanions();
	await companions.stopAll();
});

/**
 * A companion of this suite's own, and the one thing here that reaches past the backend.
 *
 * It exists for a single case: `wake` can only be proved idempotent on a device whose screen is
 * **off**, and this backend has no way to turn one off — `pressKey('wake')` presses `LOCK` only
 * when the screen is already blanked, which is exactly the property under test. So the state has
 * to come from somewhere, and the honest somewhere is the same transport and the same event
 * builder the backend uses, one layer down, rather than a stubbed reading of the flag.
 */
const companions = new IdbCompanions();

async function bootedDevice(): Promise<Device> {
	const ready = (await backend.listDevices()).filter((device) => device.state === 'ready');
	expect(
		ready.length,
		"no simulator is in state 'ready' — the gate found one when the run started",
	).toBeGreaterThan(0);
	return ready[0] as Device;
}

/** The centre of an element, which is where a caller aims (`src/verbs/target.ts`). */
function centreOf(bounds: Rect): { x: number; y: number } {
	return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

/** Every element whose bounds sit inside `host`'s — on the field, the one control in it. */
function inside(elements: readonly ScreenElement[], host: ScreenElement): ScreenElement[] {
	return elements.filter(
		(element) =>
			element.id !== host.id &&
			element.bounds.x >= host.bounds.x &&
			element.bounds.y >= host.bounds.y &&
			element.bounds.x + element.bounds.width <= host.bounds.x + host.bounds.width &&
			element.bounds.y + element.bounds.height <= host.bounds.y + host.bounds.height,
	);
}

/**
 * Spotlight's search field: the one element that has a **value** and a **control inside it**.
 *
 * Nothing here matches on a string a locale could change, which is what lets this suite run on a
 * simulator in any language — and the two halves of the rule are each doing work, measured on the
 * bench across every state this suite puts the screen through:
 *
 * - **a value** separates a field from a label, because a label is what a control is *called* and
 *   a value is what a field *holds*. Every other element of the Spotlight screen has a label and
 *   no value;
 * - **a control inside it** is what separates the field from the four elements of the *home*
 *   screen that also carry a value — two widgets, a date and the page indicator. None of them
 *   contains another element, and the field always contains exactly one: dictation while the
 *   field is empty, and the clear button once something is typed. So the same predicate answers
 *   "which element is the field" and "is this Spotlight at all" ({@link isSpringboard}).
 *
 * **The label is deliberately *not* part of the rule, and that is a correction.** It is usually
 * `null`, but iOS offers an inline completion when Spotlight reopens with a query still in it, and
 * a field carrying one comes back labelled with the query and valued `'<query>, Sugestia <…>'` —
 * measured. A rule that required no label found no field at all on precisely that screen.
 */
function searchField(elements: readonly ScreenElement[]): ScreenElement | undefined {
	return elements.find(
		(element) => element.text !== null && inside(elements, element).length === 1,
	);
}

/**
 * The control inside the field — dictation before anything is typed, and the clear button after.
 *
 * Geometric rather than named, for the reason above, and it is the tap target this suite is built
 * around: 20×19 points on an iPhone 17, so nothing but a point that arrived unconverted can hit
 * it.
 */
function insideField(elements: readonly ScreenElement[], field: ScreenElement): ScreenElement {
	const controls = inside(elements, field);
	expect(controls, 'the search field has exactly one control inside it').toHaveLength(1);
	return controls[0] as ScreenElement;
}

/**
 * The query the field holds — its value, with the inline completion iOS sometimes appends to it
 * cut back off.
 *
 * The accessibility value of a field carrying a completion is `'<query>, Sugestia <suggestion>'`
 * (measured), so what everything below compares is the part before the first `', '`. That keeps
 * every assertion in this suite an **equality** against the exact string it typed rather than a
 * prefix test, which is what makes a transposed keycode a failure: a suffix match would pass on
 * a device that typed the word and something after it.
 */
function heldQuery(field: ScreenElement | undefined): string | null {
	return field?.text?.split(', ')[0] ?? null;
}

/**
 * Read the screen until `want` is satisfied — the read-back, and the *only* kind of waiting this
 * suite does.
 *
 * A condition with a deadline rather than a duration (D12(b), ai/RULES.md §2): what every case
 * here is waiting for is the screen showing something, which is a condition, and the same read
 * that ends the wait is the assertion.
 */
async function screenShowing(
	serial: DeviceSerial,
	what: string,
	want: (elements: ScreenElement[]) => boolean,
): Promise<ScreenElement[]> {
	return waitForCondition<ScreenElement[]>({
		what,
		timeoutMs: SETTLE_TIMEOUT_MS,
		pollIntervalMs: SETTLE_POLL_MS,
		probe: async (): Promise<Observation<ScreenElement[]>> => {
			const elements = await backend.readScreen(serial);
			return want(elements)
				? { met: true, value: elements }
				: {
						met: false,
						found: `${elements.length} elements: ${elements
							.map((element) => element.label ?? element.text ?? '')
							.filter((text) => text !== '')
							.slice(0, 6)
							.join(', ')}`,
					};
		},
	});
}

/**
 * Whether this is the home screen: no search field, and the icons back.
 *
 * The same predicate that finds the field is what rules it out here, which is why
 * {@link searchField}'s second half is about the *home* screen rather than about Spotlight — four
 * elements of the home screen carry a value too, and none of them contains a control.
 */
function isSpringboard(elements: readonly ScreenElement[]): boolean {
	return searchField(elements) === undefined && elements.length > 1;
}

/**
 * Whether this device's screen is off, read the way the backend reads it.
 *
 * The same argv and the same parse rather than a second spelling of either, so a case here cannot
 * pass against a notification name the backend does not use.
 */
async function blanked(serial: DeviceSerial): Promise<boolean> {
	const { stdout } = await runSimctlOnDevice(serial, 'spawn', [...READ_SCREEN_BLANKED_ARGV]);
	return isScreenBlanked(stdout);
}

/**
 * Type `text` and read the field back until `want` accepts what it holds — the read-back, not the
 * call returning.
 */
async function type(
	serial: DeviceSerial,
	text: string,
	want: (held: string) => boolean,
): Promise<ScreenElement[]> {
	await backend.typeText(serial, text);
	return screenShowing(serial, `the search field to hold '${text}'`, (elements) =>
		want(heldQuery(searchField(elements)) ?? ''),
	);
}

/**
 * Tap the clear button inside the field and read the field back until it has stopped holding what
 * it held — the answer is what an **empty** field reads as on this device.
 *
 * Read rather than named, because it is the **placeholder**: an emptied field's value is the word
 * the keyboard prompts with, which on the bench's Polish simulator is `Szukaj` (measured). So the
 * one string in this file that a locale changes is never written down here.
 */
async function clear(serial: DeviceSerial, showing: ScreenElement[]): Promise<string | null> {
	const field = searchField(showing) as ScreenElement;
	const held = heldQuery(field);

	await backend.tap(serial, centreOf(insideField(showing, field).bounds));

	const cleared = await screenShowing(
		serial,
		'the search field to stop holding what it held',
		(elements) => heldQuery(searchField(elements)) !== held,
	);
	return heldQuery(searchField(cleared));
}

/** Home, read back — the restore every case ends with, and a `pressKey` assertion in its own right. */
async function restore(serial: DeviceSerial): Promise<void> {
	await backend.pressKey(serial, 'home');
	await screenShowing(serial, 'the home screen to come back', isSpringboard);
}

/**
 * Spotlight, opened with a swipe rather than a tap — the pull-down from the middle of the home
 * screen, which is the gesture every iOS home screen has and none of them names.
 */
async function openSpotlight(serial: DeviceSerial): Promise<ScreenElement[]> {
	const { screen } = await backend.deviceInfo(serial);
	await backend.swipe(
		serial,
		{ x: screen.widthDp / 2, y: screen.heightDp * 0.3 },
		{ x: screen.widthDp / 2, y: screen.heightDp * 0.8 },
		250,
	);
	return screenShowing(
		serial,
		'the search field to come up',
		(elements) => searchField(elements) !== undefined,
	);
}

describe.skipIf(!process.env.ROVER_TEST_SIMULATOR || !process.env.ROVER_TEST_IDB)(
	'input against a real simulator',
	() => {
		/**
		 * **The loop, `docs/IOS.md` §2's own shape**: inject, read the screen back, check what moved
		 * — six iterations over a rotation of three strings, alternating between the two primitives
		 * whose landing can be checked exactly.
		 *
		 * Each round asserts twice, and the two halves catch different things:
		 *
		 * - **typing** puts the word in the field, byte for byte, which is what says the keymap is
		 *   right — a wrong keycode types a different character rather than nothing;
		 * - **tapping** the control inside the field takes it out again, which is what says a point
		 *   arrived where it was aimed. That control is a couple of dozen points across.
		 *
		 * **The priming round is not ceremony.** Spotlight keeps the last query anybody typed on
		 * this device, so the field is not empty when it opens and this suite has no locale-free way
		 * to tell a leftover query from the placeholder. Typing something first makes the control
		 * inside the field the *clear* button rather than dictation, and tapping it is what
		 * establishes what an empty field reads as here — after which every assertion in the loop is
		 * an equality rather than a suffix.
		 */
		it('types and taps six times over, checking the screen after every one', async () => {
			const device = await bootedDevice();
			await openSpotlight(device.serial);

			try {
				const primed = await type(device.serial, PRIMER, (text) => text.endsWith(PRIMER));
				const empty = (await clear(device.serial, primed)) ?? '';

				for (const word of [...WORDS, ...WORDS]) {
					const typed = await type(device.serial, word, (text) => text === word);
					expect((await clear(device.serial, typed)) ?? '').toBe(empty);
				}
			} finally {
				await restore(device.serial);
			}
		});

		/**
		 * `pressKey('home')` on its own, verified the same way — from inside Spotlight rather than
		 * from the home screen, so what it proves is that the press *moved* something.
		 *
		 * This is the one key of the four that the device's own hardware answers, and it works on a
		 * home-buttonless iPhone: there is no home button on the glass and `HIDButtonType.HOME` is
		 * still what Springboard listens for.
		 */
		it('presses home from inside another screen and reads Springboard back', async () => {
			const device = await bootedDevice();
			const opened = await openSpotlight(device.serial);
			expect(searchField(opened)).toBeDefined();

			await backend.pressKey(device.serial, 'home');

			const home = await screenShowing(device.serial, 'the home screen', isSpringboard);
			expect(searchField(home)).toBeUndefined();
		});

		/**
		 * **`wake` is idempotent, and this is the case that proves the flag it reads is real.**
		 *
		 * `notifyutil -g` answers `<name> 0` for a name with no state at all — a woken device and a
		 * name nobody publishes read exactly alike (measured) — so nothing at run time can tell a
		 * working read from a dead one. What can is driving the flag through **both** values against
		 * the runtime in front of us, which is what this does: the screen is blanked through the
		 * transport, one `wake` brings it back, and the second must leave it alone.
		 *
		 * **The second `wake` is the whole point.** The button behind it *toggles*, so an
		 * implementation that pressed unconditionally would pass every assertion above and put the
		 * device to sleep here — the silent inversion `PROJECT.md` R46 exists to prevent. It is
		 * asserted by watching the flag for {@link MUST_NOT_BLANK_MS} and requiring that it never
		 * goes dark.
		 *
		 * The screen read is **not** what witnesses this, and that is measured rather than assumed:
		 * a blanked simulator still answers `accessibility_info` with its lock screen, and `simctl`
		 * still captures a rendered frame of it (`docs/IOS.md` §5). The notification is the only
		 * thing that moves.
		 *
		 * The device is left unlocked and on its home screen. `wake` only lights the screen — the
		 * same as Android's `KEYCODE_WAKEUP`, which leaves a device on its lock screen — so the
		 * swipe up is what dismisses that, and it is this suite's second `swipe` against something
		 * that can be read back.
		 */
		it('wakes a blanked screen and leaves an already-woken one alone', async () => {
			const device = await bootedDevice();
			const { screen } = await backend.deviceInfo(device.serial);

			try {
				if (!(await blanked(device.serial))) {
					await companions.stream(device.serial, 'hid', buttonEvents('LOCK'));
					await waitForCondition({
						what: 'the screen to go dark',
						timeoutMs: SETTLE_TIMEOUT_MS,
						pollIntervalMs: BLANK_POLL_MS,
						probe: async (): Promise<Observation<null>> =>
							(await blanked(device.serial))
								? { met: true, value: null }
								: { met: false, found: 'a screen that is still on' },
					});
				}
				expect(await blanked(device.serial), 'the screen is off before the first wake').toBe(true);

				await backend.pressKey(device.serial, 'wake');
				await waitForCondition({
					what: 'the screen to come back on',
					timeoutMs: SETTLE_TIMEOUT_MS,
					pollIntervalMs: BLANK_POLL_MS,
					probe: async (): Promise<Observation<null>> =>
						(await blanked(device.serial))
							? { met: false, found: 'a screen that is still off' }
							: { met: true, value: null },
				});

				await backend.pressKey(device.serial, 'wake');
				await expect(
					waitForCondition({
						what: 'the screen to go dark again, which a second wake must never do',
						timeoutMs: MUST_NOT_BLANK_MS,
						pollIntervalMs: BLANK_POLL_MS,
						probe: async (): Promise<Observation<null>> =>
							(await blanked(device.serial))
								? { met: true, value: null }
								: { met: false, found: 'a screen that is still on, which is the pass' },
					}),
				).rejects.toBeInstanceOf(WaitTimeoutError);
			} finally {
				// Awake but still locked, which is what `wake` promises and all it promises.
				await backend.swipe(
					device.serial,
					{ x: screen.widthDp / 2, y: screen.heightDp * 0.97 },
					{ x: screen.widthDp / 2, y: screen.heightDp * 0.35 },
					300,
				);
				await restore(device.serial);
			}
		});
	},
);
