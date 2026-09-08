import { describe, expect, it } from 'vitest';
import { IosSimulatorDeviceBackend } from '@/backends/ios-simulator/backend.js';
import { isPng } from '@/backends/ios-simulator/parsers/png.js';
import type { Device } from '@/core/device.js';
import { parseDeviceSerial } from '@/core/ids.js';

/**
 * The capture against a real booted simulator. Gated on `ROVER_TEST_SIMULATOR`
 * (`tests/device/setup.ts`), so a host without one **skips rather than fails** (ai/TESTING.md).
 *
 * The mocked suite beside it proves the argv, the staging and the two refusals with the tool
 * replaced. What this proves is what no mock can: that a simulator answers this argv at all, that
 * the bytes are still an image once they have been through a file this backend staged, and — the
 * criterion the phase exists for — that a device which is not booted is refused in milliseconds
 * rather than after the minute `simctl` spends waiting for a screen surface (`docs/IOS.md` §8,
 * trap 1).
 *
 * **Read-only**: it captures the screen as it finds it, boots nothing, shuts nothing down,
 * launches nothing and changes no setting, so it is safe against a device somebody else is
 * looking at (`docs/IOS.md` §8, trap 4). Nothing below hardcodes a size or a model — every
 * assertion is a property of whatever simulator this host has booted.
 *
 * No lease, for `./backend.test.ts`'s reason: nothing is registered yet, so there is no daemon
 * that could lend one of these devices.
 */
const backend = new IosSimulatorDeviceBackend();

/** PNG 1.2 §11.2.2: the IHDR chunk opens the file, width then height, big-endian. */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return { width: view.getUint32(16), height: view.getUint32(20) };
}

async function bootedDevice(): Promise<Device> {
	const ready = (await backend.listDevices()).filter((device) => device.state === 'ready');
	expect(ready.length).toBeGreaterThan(0);
	return ready[0] as Device;
}

/**
 * A simulator that is **not** booted, or `null` when this host has none.
 *
 * Every device but one is `Shutdown` on an ordinary Mac, so this is nearly always there; the
 * `null` is for a host carrying exactly one simulator, and the case that needs it says out loud
 * that it did not run rather than passing quietly (ai/RULES.md §6).
 */
async function shutDownDevice(): Promise<Device | null> {
	const down = (await backend.listDevices()).filter((device) => device.state !== 'ready');
	return down[0] ?? null;
}

describe.skipIf(!process.env.ROVER_TEST_SIMULATOR)('the capture against a real simulator', () => {
	it('captures a PNG that is still a PNG by the time it gets here', async () => {
		const device = await bootedDevice();

		const bytes = await backend.screenshot(device.serial);

		expect(isPng(bytes)).toBe(true);
		// A capture of a real screen is kilobytes at the very least. The floor is here for the
		// shape a truncated write takes when it happens to keep its header.
		expect(bytes.byteLength).toBeGreaterThan(1024);
	});

	/**
	 * The assertion that says these are the bytes of a picture *of this device*, and the one that
	 * proves `--mask ignored` and the device-type profile agree: the image's own dimensions have to
	 * be the ones `deviceInfo` reports, **exactly** rather than as an unordered pair. Where the
	 * Android suite has to allow for a rotation, this platform reports the device type's native
	 * geometry and `simctl` captures the display it belongs to.
	 */
	it('captures the whole screen at exactly the size the device reports', async () => {
		const device = await bootedDevice();

		const [bytes, info] = await Promise.all([
			backend.screenshot(device.serial),
			backend.deviceInfo(device.serial),
		]);

		const { width, height } = pngSize(bytes);
		expect({ width, height }).toEqual({
			width: info.screen.widthPx,
			height: info.screen.heightPx,
		});
		// Below what the same screen costs uncompressed: a PNG that reached this size is not a
		// compressed image, it is a buffer that arrived expanded.
		expect(bytes.byteLength).toBeLessThan(width * height * 4);
	});

	// Twice in a row, because a capture path that leaks a staged file, a directory or a handle
	// works exactly once.
	it('can be called again immediately', async () => {
		const device = await bootedDevice();

		await backend.screenshot(device.serial);
		expect(isPng(await backend.screenshot(device.serial))).toBe(true);
	});

	/**
	 * The one worth arranging deliberately. Against a `Shutdown` simulator the tool blocks for
	 * **60.68 s** and then fails with *"Timeout waiting for screen surfaces"* (measured on macOS
	 * 26.6.2 / Xcode 26.4.1, 2026-09-08) — so what is asserted is the refusal *and* its cost.
	 *
	 * The bound is five seconds against a refusal measured at 0.12 s, deliberately loose: what it
	 * is here to catch is a minute, not a slow host, and the enumeration in front of the check is
	 * the only work involved.
	 */
	it('refuses a simulator that is not booted in well under a second', async () => {
		const device = await shutDownDevice();
		if (device === null) {
			console.warn(
				'no shut-down simulator on this host: the 60-second-hang refusal was NOT exercised',
			);
			return;
		}

		const started = Date.now();
		const rejection = backend.screenshot(device.serial);

		await expect(rejection).rejects.toThrow(String(device.serial));
		await expect(rejection).rejects.toThrow(/rather than ready/);
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	// The contract's own distinction from `describeDevice`'s `null`, on the real listing.
	it('throws for a device this host does not have at all', async () => {
		const rejection = backend.screenshot(parseDeviceSerial('00000000-0000-4000-8000-000000000000'));

		await expect(rejection).rejects.toThrow(/no longer attached to this host/);
	});
});
