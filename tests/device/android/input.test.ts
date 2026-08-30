import { afterEach, describe, expect, it } from 'vitest';
import { AndroidDeviceBackend } from '@/backends/android/backend.js';
import { KEY_CODES } from '@/backends/android/input.js';
import type { Device, DeviceKey } from '@/core/device.js';

/**
 * The four input primitives against a real attached device. Skips rather than fails when
 * there is none (`tests/device/setup.ts`, ai/TESTING.md).
 *
 * This is the suite that proves the recipes, because nothing about `input` is checkable
 * against a mock. A mocked runner accepts `input keyevent KEYCODE_NOPE` and `input text
 * 日本語` as happily as the forms that work — and so, it turns out, does the device for the
 * first of those: `input keyevent NOT_A_KEY` exits 0 with zero bytes on both streams
 * (PROJECT.md §6). What this suite adds over the unit pin is that the *shape* of every call
 * is one a real `input` accepts.
 *
 * It gates on `ROVER_TEST_DEVICE` rather than `ROVER_TEST_LOCAL_DEVICE`: input touches no
 * radio and cannot cut the transport it arrives over, so a device reached over a network
 * transport is a perfectly good subject here. Like `./backend.test.ts` it drives the backend
 * class directly rather than through a lease — no longer because there is no verb to take one
 * around, since #60 put `tap` and `swipe` behind lease-carrying rows and
 * `./verb-dispatch.test.ts` taps through one, but because this suite asserts the primitives
 * *underneath* those verbs and has not been converted onto the shared lease helper
 * (ai/TESTING.md, "The exemption", which also records what ends it).
 *
 * **What this deliberately does not cover, so silence is not read as "checked":**
 *
 * - **No assertion reads the screen back**, and that is now a choice rather than a limit:
 *   the backend has declared `canReadScreen: true` since #13, so `readScreen` *could* be
 *   called here. It is not, because these are the primitives underneath the verbs and
 *   asserting one primitive through another turns a failure in either into a failure that
 *   names the wrong one — the same reason `./network.test.ts` refuses to check a radio
 *   through a second adb call. So what is proved here is still that the device **accepted**
 *   the injection, not that a button was pressed or that text arrived in a field; the verb
 *   layer's own post-state is what asserts the latter, in `./verb-dispatch.test.ts`.
 * - **That a long press produces a long press, and that the measured text lands in a
 *   field, are observed by hand** in the session behind PROJECT.md §6 and recorded there —
 *   including the 400 ms threshold, which is a device setting rather than a constant.
 * - **Nothing here proves the keycode table is right**, only that all four keycodes are
 *   accepted. A wrong one is accepted too. The table is pinned in
 *   `tests/unit/backends/android/input.test.ts` and exhaustive over `DeviceKey` at compile
 *   time; those are the only two things that can catch it.
 *
 * The device is left on its home screen in `afterEach`, unconditionally, including after a
 * failed assertion — this suite taps and types on whatever happens to be in front of it.
 */
const backend = new AndroidDeviceBackend();

async function firstDevice(): Promise<Device> {
	const ready = (await backend.listDevices()).filter((device) => device.state === 'ready');
	expect(
		ready.length,
		"no device is in state 'ready' — the gate found one when the run started",
	).toBeGreaterThan(0);
	return ready[0] as Device;
}

describe.skipIf(!process.env.ROVER_TEST_DEVICE)('input against a real device', () => {
	afterEach(async () => {
		// The one key that leaves any screen somewhere predictable.
		await backend.pressKey((await firstDevice()).serial, 'home');
	});

	it('taps a point the verb layer could have resolved', async () => {
		const device = await firstDevice();
		const { screen } = await backend.deviceInfo(device.serial);

		await expect(
			backend.tap(device.serial, { x: screen.widthDp / 2, y: screen.heightDp / 2 }),
		).resolves.toBeUndefined();
	});

	/**
	 * The floor invariant against a real `wm density` rather than an assumed scale: the last
	 * dp column of the panel has to convert to a pixel the device accepts. It accepts one
	 * past the edge too, in silence — which is why this asserts the call rather than the
	 * landing, and why the conversion is pinned in the unit suite.
	 */
	it('accepts a point at the far edge of the screen', async () => {
		const device = await firstDevice();
		const { screen } = await backend.deviceInfo(device.serial);
		const lastColumn = (screen.widthPx - 0.5) / screen.densityScale;
		const lastRow = (screen.heightPx - 0.5) / screen.densityScale;

		await expect(
			backend.tap(device.serial, { x: lastColumn, y: lastRow }),
		).resolves.toBeUndefined();
	});

	it('swipes between two points', async () => {
		const device = await firstDevice();
		const { screen } = await backend.deviceInfo(device.serial);
		const x = screen.widthDp / 2;

		await expect(
			backend.swipe(
				device.serial,
				{ x, y: screen.heightDp * 0.7 },
				{ x, y: screen.heightDp * 0.3 },
				300,
			),
		).resolves.toBeUndefined();
	});

	/**
	 * A drag in place, held past the long-press timeout — the shape phase 2's `long_press`
	 * composes. 600 ms rather than the 400 ms this device's `settings get secure
	 * long_press_timeout` reports, because the threshold is a device setting and a duration
	 * sitting on it is a test that goes red on a device configured differently.
	 */
	it('accepts a drag in place, which is how a long press is done', async () => {
		const device = await firstDevice();
		const { screen } = await backend.deviceInfo(device.serial);
		const at = { x: screen.widthDp / 2, y: screen.heightDp / 2 };

		await expect(backend.swipe(device.serial, at, at, 600)).resolves.toBeUndefined();
	});

	/**
	 * Every key of the vocabulary, pressed. This proves the four keycodes are shapes `input
	 * keyevent` accepts and nothing more — an unknown one is accepted identically, which is
	 * the finding that made the unit pin the load-bearing check.
	 */
	it.each(Object.keys(KEY_CODES) as DeviceKey[])('presses %s', async (key) => {
		const device = await firstDevice();

		await expect(backend.pressKey(device.serial, key)).resolves.toBeUndefined();
	});

	/**
	 * The text cases §6 records, typed at whatever has focus. The apostrophe is the one
	 * `shellArg` refuses and `shellText` splices; the metacharacters are the injection that
	 * quoting exists to stop; the `%s` is the string that costs two calls.
	 */
	it.each([
		['plain text', 'hello'],
		['a space, which needs no %s once quoted', 'hello world'],
		['an apostrophe', "don't"],
		['shell metacharacters', 'a&b|c;d $e `f` "g" (h) *?[i]'],
		['a lone percent', '100%'],
		['a literal %s, which costs two calls', 'a%sb'],
		['nothing at all', ''],
	])('types %s', async (_what, text) => {
		const device = await firstDevice();

		await expect(backend.typeText(device.serial, text)).resolves.toBeUndefined();
	});

	/**
	 * The refusals, and they never reach the device. A tab is dropped in silence by `input
	 * text` and a non-ASCII character throws `NullPointerException` inside it at exit 255
	 * with nothing typed at all (PROJECT.md §6) — so both are refused here by name, before
	 * the call, and the message says which character.
	 */
	it.each([
		['a tab', 'a\tb'],
		['a newline', 'a\nb'],
		['a non-ASCII character', 'café'],
	])('refuses to type %s, naming what it cannot type', async (_what, text) => {
		const device = await firstDevice();

		await expect(backend.typeText(device.serial, text)).rejects.toThrow(/printable ASCII/);
	});
});
