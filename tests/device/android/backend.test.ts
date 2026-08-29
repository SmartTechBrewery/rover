import { describe, expect, it } from 'vitest';
import { AndroidDeviceBackend } from '@/backends/android/backend.js';
import { DP_BASELINE_DPI } from '@/backends/android/parsers/wm.js';
import type { Device, DeviceWatch } from '@/core/device.js';
import { parseDeviceSerial } from '@/core/ids.js';

/**
 * The backend against a real attached device. Skips rather than fails when there is
 * none (`tests/device/setup.ts`, ai/TESTING.md).
 *
 * **Read-only.** It enumerates, describes and measures; it installs nothing, launches
 * nothing and changes no setting, so it is safe to run against a device someone else is
 * looking at. That matters more than usual right now, because of the next paragraph.
 *
 * ai/TESTING.md says a device test takes a lease like any other client, and this one does
 * not: leases do not exist yet (R8/#8). Until they do it drives the backend class
 * directly, which is the honest description of what it does rather than a gap worth
 * papering over. Every assertion below is a property of whatever device is attached — no
 * model, size or API level is hardcoded, because the machine running this has a different
 * device from the machine that wrote it.
 */
const backend = new AndroidDeviceBackend();

/**
 * How long a first snapshot may take. A bound on a condition, never a sleep (D12): the
 * tracker delivers the current set as soon as it is subscribed, and the only reason to
 * wait at all is that adb may have to start its server first.
 */
const FIRST_SNAPSHOT_TIMEOUT_MS = 15_000;

async function firstUsableDevice(): Promise<Device> {
	const ready = (await backend.listDevices()).filter((device) => device.state === 'ready');
	expect(ready.length).toBeGreaterThan(0);
	return ready[0] as Device;
}

describe.skipIf(!process.env.ROVER_TEST_DEVICE)('the backend against a real device', () => {
	it('enumerates at least one attached device, and at least one that is usable', async () => {
		const devices = await backend.listDevices();

		expect(devices.length).toBeGreaterThan(0);
		expect(devices.every((device) => device.platform === 'android')).toBe(true);
		expect(devices.some((device) => device.state === 'ready')).toBe(true);
	});

	it('describes a device it just enumerated', async () => {
		const device = await firstUsableDevice();

		expect(await backend.describeDevice(device.serial)).toEqual(device);
	});

	it('answers null for a serial no device has', async () => {
		expect(await backend.describeDevice(parseDeviceSerial('rover-no-such-device'))).toBeNull();
	});

	/**
	 * The watch against the real tracker: it has to deliver the attached set on subscription
	 * and agree with the enumeration, since both read the same long format.
	 *
	 * Read-only, like the rest of this file, and it deliberately does **not** run
	 * `adb connect` to produce a second entry for the same device. That mutates the host's
	 * adb state and would race any other suite on the machine; the D18 case is covered by
	 * the captured fixture in `tests/unit/backends/android/` instead.
	 */
	it('is handed the attached set on subscription, and agrees with the enumeration', async () => {
		const device = await firstUsableDevice();
		let watch: DeviceWatch | undefined;

		try {
			const snapshot = await new Promise<Device[]>((resolve, reject) => {
				const expired = setTimeout(
					() => reject(new Error(`no snapshot within ${FIRST_SNAPSHOT_TIMEOUT_MS}ms`)),
					FIRST_SNAPSHOT_TIMEOUT_MS,
				);
				watch = backend.watchDevices({
					onDevices(devices) {
						clearTimeout(expired);
						resolve(devices);
					},
					onInterrupted(reason) {
						clearTimeout(expired);
						reject(new Error(reason));
					},
				});
			});

			expect(snapshot.find((entry) => entry.serial === device.serial)).toEqual(device);
			// This device is attached to this machine, which is what makes it this host's to
			// lend (D18).
			expect(device.attachment).toBe('this-host');
		} finally {
			await watch?.stop();
		}
	});

	it('measures the screen, and derives dp from the density the device reports', async () => {
		const device = await firstUsableDevice();

		const info = await backend.deviceInfo(device.serial);

		// D14: the measurement travels with the device it was taken on.
		expect(info.serial).toBe(device.serial);
		expect(info.platform).toBe('android');
		expect(info.screen.widthPx).toBeGreaterThan(0);
		expect(info.screen.heightPx).toBeGreaterThan(0);
		expect(info.screen.density).toBeGreaterThan(0);
		expect(info.screen.densityScale).toBeCloseTo(info.screen.density / DP_BASELINE_DPI, 10);
		expect(info.screen.widthDp).toBeCloseTo(info.screen.widthPx / info.screen.densityScale, 10);
		expect(info.screen.heightDp).toBeCloseTo(info.screen.heightPx / info.screen.densityScale, 10);
		expect(info.osVersion).toBeTruthy();
	});
});
