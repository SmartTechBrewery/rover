import { describe, expect, it } from 'vitest';
import { AndroidDeviceBackend } from '@/backends/android/backend.js';
import { DP_BASELINE_DPI } from '@/backends/android/parsers/wm.js';
import type { Device } from '@/core/device.js';
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
