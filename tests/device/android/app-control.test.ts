import { describe, expect, it } from 'vitest';
import { AndroidDeviceBackend } from '@/backends/android/backend.js';
import type { Device } from '@/core/device.js';
import { parseAppId } from '@/core/ids.js';

/**
 * The app lifecycle primitives against a real attached device. Skips rather than fails
 * when there is none (`tests/device/setup.ts`, ai/TESTING.md).
 *
 * **What this deliberately does not cover, so silence is not read as "checked":**
 *
 * - `installApp` has no case here at all. There is no APK in this repository and adding a
 *   binary to carry one is not this change's job, so the recipe was verified by hand
 *   instead — an APK installed onto an API 37 emulator, both the `Success` path and
 *   `Failure [INSTALL_FAILED_TEST_ONLY: …]`. The captured output lives in
 *   `tests/fixtures/adb/` and is what `parsers/app-control.test.ts` asserts against.
 * - `clearAppData` is exercised only on its **failure** path. Its success destroys an
 *   application's data, and there is no package on an arbitrary device whose data is safe
 *   for a test suite to destroy. The success path was verified by hand against a package
 *   with nothing to lose (`com.android.traceur`) on the same emulator, and its answer is
 *   the `pm-clear-success` fixture.
 *
 * Every app id below is a parsed {@link parseAppId}, which is not a formality: an id
 * reaches the device inside a string its own `sh` reads, so the parse is what stops one
 * from being two commands there.
 *
 * `com.android.settings` is what the rest drives, because it is present on every Android
 * device and launching and stopping it changes nothing a person would miss. Like
 * `./backend.test.ts` this drives the backend class directly rather than through a lease —
 * leases do not exist yet (R8/#8) — and hardcodes no model, size or API level.
 */
const backend = new AndroidDeviceBackend();

/** Present on every Android build, and safe to open and close under someone else's eyes. */
const SETTINGS = parseAppId('com.android.settings');

/** A package no device has. Both halves matter: it is not installed, and it never will be. */
const ABSENT = parseAppId('com.rover.no.such.package');

async function firstUsableDevice(): Promise<Device> {
	const ready = (await backend.listDevices()).filter((device) => device.state === 'ready');
	expect(ready.length).toBeGreaterThan(0);
	return ready[0] as Device;
}

describe.skipIf(!process.env.ROVER_TEST_DEVICE)('app control against a real device', () => {
	it('launches an installed app, and stops it again', async () => {
		const device = await firstUsableDevice();

		await expect(backend.launchApp(device.serial, SETTINGS)).resolves.toBeUndefined();
		await expect(backend.stopApp(device.serial, SETTINGS)).resolves.toBeUndefined();
	});

	// The app is already the top-most instance, which `am start` answers with a `Warning:`
	// line. It is a launch that succeeded, and this is what says so on a device rather than
	// against a captured string.
	it('launches an app that is already in the foreground', async () => {
		const device = await firstUsableDevice();

		await backend.launchApp(device.serial, SETTINGS);
		await expect(backend.launchApp(device.serial, SETTINGS)).resolves.toBeUndefined();

		await backend.stopApp(device.serial, SETTINGS);
	});

	it('refuses to launch a package the device does not have, naming it', async () => {
		const device = await firstUsableDevice();

		await expect(backend.launchApp(device.serial, ABSENT)).rejects.toThrow(ABSENT);
	});

	it('reports a clear that did not happen rather than swallowing it', async () => {
		const device = await firstUsableDevice();

		await expect(backend.clearAppData(device.serial, ABSENT)).rejects.toThrow(ABSENT);
	});

	/**
	 * Pins the limitation rather than the capability, and it is here so nobody discovers it
	 * in front of an agent: `am force-stop` prints nothing for a package that is not
	 * installed exactly as it prints nothing for one it stopped, and exits 0 either way. So
	 * a typo in an app id is a silent no-op at this layer (PROJECT.md §6). Whether the app
	 * is really gone is the verb layer's post-state to answer (#11), by reading the device.
	 */
	it('cannot tell a stopped app from a package that was never there', async () => {
		const device = await firstUsableDevice();

		await expect(backend.stopApp(device.serial, ABSENT)).resolves.toBeUndefined();
	});
});
