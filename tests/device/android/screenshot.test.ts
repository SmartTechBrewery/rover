import { describe, expect, it } from 'vitest';
import { AndroidDeviceBackend } from '@/backends/android/backend.js';
import { isPng } from '@/backends/android/parsers/screencap.js';
import type { Device } from '@/core/device.js';

/**
 * The capture against a real attached device. Skips rather than fails when there is none
 * (`tests/device/setup.ts`, ai/TESTING.md).
 *
 * **Read-only**, like `./backend.test.ts`: it captures the screen as it finds it, launches
 * nothing and changes no setting, so it is safe against a device someone else is looking
 * at. It drives the backend class directly rather than through a lease for the same reason
 * that file does — leases do not exist yet (R8/#8).
 *
 * This is the suite that proves the recipe, because nothing about `exec-out screencap -p`
 * is checkable against a mock: what a mocked runner cannot tell you is whether the device
 * answers this argv at all, and whether the bytes that come back are still an image after
 * crossing the bridge. Nothing below hardcodes a size or a model — every assertion is a
 * property of whatever device is attached.
 */
const backend = new AndroidDeviceBackend();

/** PNG 1.2 §11.2.2: the IHDR chunk opens the file, width then height, big-endian. */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return { width: view.getUint32(16), height: view.getUint32(20) };
}

async function firstUsableDevice(): Promise<Device> {
	const ready = (await backend.listDevices()).filter((device) => device.state === 'ready');
	expect(ready.length).toBeGreaterThan(0);
	return ready[0] as Device;
}

describe.skipIf(!process.env.ROVER_TEST_DEVICE)('screenshot against a real device', () => {
	it('captures a PNG that is still a PNG by the time it gets here', async () => {
		const device = await firstUsableDevice();

		const bytes = await backend.screenshot(device.serial);

		expect(isPng(bytes)).toBe(true);
		// A capture of a real screen is kilobytes at the very least. The floor is here for
		// the shape a mangled or truncated stream takes when it happens to keep its header.
		expect(bytes.byteLength).toBeGreaterThan(1024);
	});

	/**
	 * The assertion that says the bytes are a picture *of this device*, rather than merely
	 * a well-formed file: the image's own dimensions have to be the ones the device reports
	 * for its screen. Compared as an unordered pair, because `wm size` reports the panel
	 * while the capture follows the current rotation, and a device left in landscape is not
	 * a failure of this recipe.
	 */
	it('captures the whole screen at the size the device reports', async () => {
		const device = await firstUsableDevice();

		const [bytes, info] = await Promise.all([
			backend.screenshot(device.serial),
			backend.deviceInfo(device.serial),
		]);

		const { width, height } = pngSize(bytes);
		expect([width, height].sort()).toEqual([info.screen.widthPx, info.screen.heightPx].sort());
		// Below what the same screen costs uncompressed: a PNG that reached this size is
		// not a compressed image, it is a buffer that arrived expanded.
		expect(bytes.byteLength).toBeLessThan(width * height * 4);
	});

	// Two captures in a row, because a capture path that leaks a file, a handle or a
	// half-read stream on the device works exactly once.
	it('can be called again immediately', async () => {
		const device = await firstUsableDevice();

		await backend.screenshot(device.serial);
		expect(isPng(await backend.screenshot(device.serial))).toBe(true);
	});
});
