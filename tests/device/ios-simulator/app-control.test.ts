import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IosSimulatorDeviceBackend } from '@/backends/ios-simulator/backend.js';
import type { Device } from '@/core/device.js';
import { parseAppId } from '@/core/ids.js';

/**
 * The app lifecycle against a real booted simulator. Gated on `ROVER_TEST_SIMULATOR`
 * (`tests/device/setup.ts`), so a host without one **skips rather than fails**
 * (ai/TESTING.md).
 *
 * **What this deliberately does not cover, so silence is not read as "checked"**, and the shape
 * is `../android/app-control.test.ts`'s for the same reasons:
 *
 * - `installApp` has **no success case**. There is no `.app` in this repository and adding a
 *   Mach-O binary to carry one is not this change's job — a bundle without one is refused by
 *   `simctl` outright (*"Failed to re-fetch bundle during preflight"*, measured, and it leaves a
 *   half-registered container behind), so there is no toolchain-free stand-in. The recipe was
 *   verified by hand instead, against a `.app` compiled for the simulator SDK on macOS 26.6.2
 *   (25G83) / Xcode 26.4.1 (17E202), 2026-09-08: install 5.2 s cold, launch answering a pid,
 *   push, pull byte-identical, clear, and the data gone. `docs/IOS.md` §2 carries the run. What
 *   *is* here is the failure path, because that one costs nothing and is where the redaction
 *   lives.
 * - `clearAppData` is exercised only on its **failure** path. Its success uninstalls and
 *   reinstalls an application, and there is no app on an arbitrary operator's simulator whose
 *   data is safe for a test suite to destroy — least of all a system one, which cannot be
 *   reinstalled from a container copy at all. The success path is in the by-hand run above.
 *
 * **`com.apple.Preferences` is what the rest drives**: present on every iOS runtime, and opening
 * and closing it changes nothing a person would miss. Every app id is a parsed
 * {@link parseAppId} — not a formality even here, where nothing reaches a shell, because the
 * brand is what forces every caller through the parse before any backend sees the value.
 *
 * Like the suites beside it this drives the backend class directly rather than through a lease —
 * no longer because nothing is registered (#230 landed the manifest and `./verb-dispatch.test.ts`
 * takes a lease) but because what it asserts is a claim about the backend
 * (ai/TESTING.md, and `./backend.test.ts`'s header). It boots nothing and shuts nothing down —
 * `docs/IOS.md` §8 trap 4.
 */
const backend = new IosSimulatorDeviceBackend();

/** Present on every iOS runtime, and safe to open and close under someone else's eyes. */
const SETTINGS = parseAppId('com.apple.Preferences');

/** A bundle identifier no device has. Both halves matter: not installed, and never will be. */
const ABSENT = parseAppId('com.rover.no.such.app');

async function bootedDevice(): Promise<Device> {
	const ready = (await backend.listDevices()).filter((device) => device.state === 'ready');
	expect(ready.length).toBeGreaterThan(0);
	return ready[0] as Device;
}

describe.skipIf(!process.env.ROVER_TEST_SIMULATOR)(
	'the app lifecycle against a real simulator',
	() => {
		it('launches an installed app, and stops it again', async () => {
			const device = await bootedDevice();

			await expect(backend.launchApp(device.serial, SETTINGS)).resolves.toBeUndefined();
			await expect(backend.stopApp(device.serial, SETTINGS)).resolves.toBeUndefined();
		});

		// `simctl launch` answers the same pid for an app that is already running and exits 0, so
		// a second launch is a launch that succeeded rather than a case to special-case.
		it('launches an app that is already running', async () => {
			const device = await bootedDevice();

			await backend.launchApp(device.serial, SETTINGS);
			await expect(backend.launchApp(device.serial, SETTINGS)).resolves.toBeUndefined();

			await backend.stopApp(device.serial, SETTINGS);
		});

		/**
		 * The decision this phase makes, on the device rather than against a fixture: `terminate`
		 * of an app that is not running **fails** — exit 3, `found nothing to terminate` — and
		 * this backend counts it as done, because the caller asked for the app not to be running
		 * and it is not. Stopping twice in a row is the ordinary way to meet it.
		 */
		it('stops an app that is already stopped', async () => {
			const device = await bootedDevice();

			await backend.launchApp(device.serial, SETTINGS);
			await backend.stopApp(device.serial, SETTINGS);

			await expect(backend.stopApp(device.serial, SETTINGS)).resolves.toBeUndefined();
		});

		// The same answer for an app the device has never had — which is the limitation stated
		// out loud rather than discovered: this cannot tell "stopped it" from "there was nothing
		// by that name", and what answers whether the app is really gone is the verb layer's
		// post-state (#11).
		it('cannot tell a stopped app from one that was never installed', async () => {
			const device = await bootedDevice();

			await expect(backend.stopApp(device.serial, ABSENT)).resolves.toBeUndefined();
		});

		it('refuses to launch an app the device does not have, naming it', async () => {
			const device = await bootedDevice();

			await expect(backend.launchApp(device.serial, ABSENT)).rejects.toThrow(ABSENT);
		});

		it('reports a clear that did not happen rather than swallowing it', async () => {
			const device = await bootedDevice();

			await expect(backend.clearAppData(device.serial, ABSENT)).rejects.toThrow(
				/get_app_container/,
			);
		});

		/**
		 * The redaction, end to end and against the tool that does the quoting: `simctl install`
		 * writes the path it was given back into its own stderr — `lstat of <path> failed` — so
		 * this is the case that would catch a mask applied to the argv alone. The message is read
		 * on the agent's machine, where a path this host invented names nothing (D19).
		 */
		it('refuses a package that is not there, without naming the host path', async () => {
			const device = await bootedDevice();
			const scratch = await mkdtemp(join(tmpdir(), 'rover-ios-install-'));
			const missing = join(scratch, 'payload');

			try {
				const rejection = backend.installApp(device.serial, missing);

				await expect(rejection).rejects.toThrow('simctl install');
				await expect(rejection).rejects.not.toThrow(new RegExp(scratch));
				await expect(rejection).rejects.toThrow('<the file you sent>');
			} finally {
				await rm(scratch, { recursive: true, force: true });
			}
		});
	},
);
