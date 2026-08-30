import { describe, expect, it } from 'vitest';
import { runAdbOnDevice } from '@/backends/android/adb.js';
import { AndroidDeviceBackend } from '@/backends/android/backend.js';
import { DP_BASELINE_DPI } from '@/backends/android/parsers/wm.js';
import type { Device, DeviceWatch, ScreenElement } from '@/core/device.js';
import { type DeviceSerial, parseDeviceSerial } from '@/core/ids.js';

/**
 * The backend against a real attached device. Skips rather than fails when there is
 * none (`tests/device/setup.ts`, ai/TESTING.md).
 *
 * **Read-only.** It enumerates, describes, measures and reads the screen; it installs
 * nothing, launches nothing, taps nothing and changes no setting, so it is safe to run
 * against a device someone else is looking at. The one thing it writes is the hierarchy
 * dump `readScreen` asks the device for, which `readScreen` itself removes — and one of the
 * assertions below is that it did. That matters more than usual right now, because of the
 * next paragraph.
 *
 * ai/TESTING.md says a device test takes a lease like any other client, and this one does
 * not: leases exist since R8/#8, but the daemon registers no backend, so there is none to
 * take (ai/TESTING.md, "The exemption"). Until that is wired it drives the backend class
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
			// This device is physically attached to this machine, which is what makes it
			// leasable at all (D18).
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

/**
 * `readScreen` against whatever is in front of the device — the half a mocked adb cannot
 * prove. `tests/unit/backends/android/backend.test.ts` pins the argv and the arithmetic
 * against captures; this proves the two-command recipe works on hardware at all, that the
 * numbers are in the space the rest of the system speaks, and that a read leaves nothing
 * behind.
 *
 * Every assertion is a property of whatever screen happens to be showing. Nothing here
 * names a control, because the machine running this has a different device on a different
 * screen from the machine that wrote it.
 */
describe.skipIf(!process.env.ROVER_TEST_DEVICE)('reading the screen of a real device', () => {
	/** Where the backend has the device write its dump — asserted to be gone afterwards. */
	const DUMP_PATH = '/sdcard/window_dump.xml';

	async function readsScreen(): Promise<{ serial: DeviceSerial; elements: ScreenElement[] }> {
		const { serial } = await firstUsableDevice();
		return { serial, elements: await backend.readScreen(serial) };
	}

	it('reads the screen as elements with an id no other element of the read has', async () => {
		const { elements } = await readsScreen();

		expect(elements.length).toBeGreaterThan(0);
		expect(new Set(elements.map((element) => element.id)).size).toBe(elements.length);
	});

	// A screen every one of whose elements carries neither a text nor a label is a screen no
	// verb could address by name, and would mean the two attributes were being dropped.
	it('finds at least one element carrying a text or a label', async () => {
		const { elements } = await readsScreen();

		expect(elements.some((element) => element.text !== null || element.label !== null)).toBe(true);
	});

	/**
	 * **The one assertion that catches a missing px→dp conversion**, which is otherwise
	 * invisible: an unconverted hierarchy is a perfectly plausible list of rectangles that
	 * happen to be three times too large, and every target resolved off it would be
	 * range-checked against a screen it does not fit.
	 *
	 * The root's rectangle is compared to `deviceInfo().screen` as an **unordered** pair.
	 * The dump's bounds follow the current surface while `wm size` reports the panel, so on a
	 * rotated device the two are each other's transpose — the same asymmetry
	 * `./screenshot.test.ts` already documents for the capture, recorded in PROJECT.md §6 and
	 * deliberately not fixed here.
	 */
	it('reports bounds in the dp space deviceInfo describes, not in device pixels', async () => {
		const { serial, elements } = await readsScreen();
		const { screen } = await backend.deviceInfo(serial);

		const root = elements[0].bounds;
		const measured = [root.width, root.height].sort((a, b) => a - b);
		const reported = [screen.widthDp, screen.heightDp].sort((a, b) => a - b);

		expect(measured[0]).toBeCloseTo(reported[0], 6);
		expect(measured[1]).toBeCloseTo(reported[1], 6);
		// The claim sharpened: had the conversion been skipped, these would be the pixels.
		expect(measured[1]).toBeLessThan(Math.max(screen.widthPx, screen.heightPx));
	});

	// A read that leaks its file on the device works exactly once in a form anyone notices;
	// the second one is what shows a stale dump being served or a cleanup that never ran.
	it('reads twice in a row, and leaves no dump behind on the device', async () => {
		const { serial } = await firstUsableDevice();

		const first = await backend.readScreen(serial);
		const second = await backend.readScreen(serial);

		expect(first.length).toBeGreaterThan(0);
		expect(second.length).toBeGreaterThan(0);

		const listing = await runAdbOnDevice(serial, ['shell', 'ls', '-a', '/sdcard/']);
		expect(listing.stdout).not.toContain(DUMP_PATH.slice('/sdcard/'.length));
	});
});
