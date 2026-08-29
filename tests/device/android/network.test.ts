import { afterEach, describe, expect, it } from 'vitest';
import { AndroidDeviceBackend } from '@/backends/android/backend.js';
import type { Device } from '@/core/device.js';

/**
 * The environment primitives against a real attached device. Skips rather than fails when
 * there is none (`tests/device/setup.ts`, ai/TESTING.md).
 *
 * This is the suite that proves the recipes, because nothing about `cmd connectivity
 * airplane-mode` or `cmd wifi set-wifi-enabled` is checkable against a mock: `svc wifi
 * disable` appears in every guide on the internet and does not exist on API 37, and a
 * mocked runner would accept it as happily as the recipe that works.
 *
 * **What this deliberately does not cover, so silence is not read as "checked":**
 *
 * - **No assertion reads the radio state back.** `DeviceBackend` has no network getter and
 *   #9 does not add one, so what is proved here is that the device accepted the command —
 *   not that the radio moved. `cmd connectivity airplane-mode` with no argument and
 *   `cmd wifi status` are the reads that would say (PROJECT.md §6); using them would mean
 *   this suite asserting through an adb call of its own, outside the primitive it is
 *   testing.
 * - **Which way airplane mode drags wifi is not asserted either.** It moves it as a side
 *   effect whose direction depends on state the device remembers, observed both ways on
 *   one emulator (PROJECT.md §6). That is a finding for the restoration routine to respect,
 *   not a property to pin: a test asserting either direction would be red on half the
 *   devices it ran on.
 *
 * Unlike its siblings this suite **changes something an operator would notice**, so two
 * rules are not optional. It only ever touches a device with `attachment === 'this-host'`
 * — a device reached over a network transport would have its own transport cut by
 * `setWifiEnabled(serial, false)`, and D18 says such a device is never leased anyway — and
 * it restores the resting state in `afterEach` unconditionally, including after a failed
 * assertion. Like `./backend.test.ts` it drives the backend class directly rather than
 * through a lease, which R8 has since made possible; converting all four device suites at
 * once is its own change.
 */
const backend = new AndroidDeviceBackend();

/**
 * Ready **and physically attached**, which is stricter than the sibling suites' filter and
 * has to be: every other device suite only reads or launches, while this one can take the
 * device off the network it is being reached over.
 */
async function firstLocalDevice(): Promise<Device> {
	const usable = (await backend.listDevices()).filter(
		(device) => device.state === 'ready' && device.attachment === 'this-host',
	);
	expect(usable.length).toBeGreaterThan(0);
	return usable[0] as Device;
}

/** The state an operator expects to find the device in, and what this suite leaves behind. */
async function restore(device: Device): Promise<void> {
	// Airplane mode first, wifi last: the airplane step can move wifi underneath it, while
	// the wifi step never touches airplane mode (PROJECT.md §6). Same order R9 will use.
	await backend.setAirplaneMode(device.serial, false);
	await backend.setWifiEnabled(device.serial, true);
}

describe.skipIf(!process.env.ROVER_TEST_DEVICE)('network control against a real device', () => {
	afterEach(async () => {
		await restore(await firstLocalDevice());
	});

	it('turns airplane mode on and off again', async () => {
		const device = await firstLocalDevice();

		await expect(backend.setAirplaneMode(device.serial, true)).resolves.toBeUndefined();
		await expect(backend.setAirplaneMode(device.serial, false)).resolves.toBeUndefined();
	});

	// `disabled` is the argument PROJECT.md §6 had never vouched for before #9 — the other
	// three were recorded as working and this one was assumed to match. It does.
	it('turns wifi off and on again', async () => {
		const device = await firstLocalDevice();

		await expect(backend.setWifiEnabled(device.serial, false)).resolves.toBeUndefined();
		await expect(backend.setWifiEnabled(device.serial, true)).resolves.toBeUndefined();
	});

	/**
	 * Asking for the state the device is already in. A restoration routine sets the resting
	 * state without reading it first (there is nothing to read it with), so every call it
	 * makes is potentially this one — and a primitive that refused a no-op would fail every
	 * release of a device nobody had touched.
	 */
	it('accepts being asked for a state the device is already in', async () => {
		const device = await firstLocalDevice();

		await backend.setAirplaneMode(device.serial, false);
		await expect(backend.setAirplaneMode(device.serial, false)).resolves.toBeUndefined();
		await backend.setWifiEnabled(device.serial, true);
		await expect(backend.setWifiEnabled(device.serial, true)).resolves.toBeUndefined();
	});

	/**
	 * The order R9's restoration will run in, end to end from the state a lease could leave
	 * behind: airplane mode on and wifi off. Wifi is enabled **while airplane mode is still
	 * on** in the first half, which is the interaction §6 records as honoured — if the
	 * platform ever reverts it, this is what goes red.
	 */
	it('restores a device left with airplane mode on and wifi off', async () => {
		const device = await firstLocalDevice();

		await backend.setAirplaneMode(device.serial, true);
		await backend.setWifiEnabled(device.serial, false);

		await expect(restore(device)).resolves.toBeUndefined();
	});
});
