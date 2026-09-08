import { describe, expect, it } from 'vitest';
import { IosSimulatorDeviceBackend } from '@/backends/ios-simulator/backend.js';
import type { Device, DeviceWatch } from '@/core/device.js';
import { DeviceVanishedError } from '@/core/errors.js';
import { parseDeviceSerial } from '@/core/ids.js';
import { createGate } from '../../helpers/timing.js';

/**
 * The half of this phase no mock can answer: whether the enumeration, the presence check and the
 * device facts are true of a **real** simulator on this host.
 *
 * The mocked suite beside it proves the join against captured output — the argv, the mapping and
 * the poll's delivery rules. What this proves is the two things a capture cannot: that the recipes
 * still work on whatever Xcode this machine has, and that the `profile.plist` this backend reads
 * for the screen is really where `simctl` says it is, on this disk, right now.
 *
 * Gated on `ROVER_TEST_SIMULATOR`, set by `tests/device/setup.ts` when a simulator is booted, so
 * a host without one **skips rather than fails** (ai/TESTING.md).
 *
 * **It changes no device state**: it boots nothing, shuts nothing down, installs nothing and
 * launches nothing — every call here is a listing or a file read. That restraint is
 * `docs/IOS.md` §8 trap 4's reason: quitting or driving `Simulator.app` shuts down every device it
 * owns, so a suite that booted its own subject would take the operator's session with it.
 *
 * It takes no lease, and **not under the exemption `ai/TESTING.md` grants the six Android
 * suites** — that one is a conversion gap over an enumerated list this suite is not on. It used to
 * be the backend-under-construction case beside it: nothing was registered, so no daemon could
 * lend one of these devices and there was nothing to take a lease from. **That reason expired when
 * the manifest landed** (#230), and what is left is the plainer one — every call here is a listing
 * or a file read against a device nobody is holding, which is a claim about the backend rather
 * than about a lease. `./verb-dispatch.test.ts` is where the lease lives now.
 */
describe.skipIf(!process.env.ROVER_TEST_SIMULATOR)(
	'the iOS simulator backend, on this host',
	() => {
		const backend = new IosSimulatorDeviceBackend();

		/** The booted device the gate found, which is the only one every case below is about. */
		async function booted(): Promise<Device> {
			const devices = await backend.listDevices();
			const ready = devices.find((device) => device.state === 'ready');
			if (ready === undefined) throw new Error('the gate said a simulator was booted');
			return ready;
		}

		it('names the booted simulator, with a version and this host’s attachment', async () => {
			const device = await booted();

			expect(device.platform).toBe('ios-simulator');
			expect(device.model).not.toBeNull();
			// The runtime's `version`, so a dotted number rather than the map key's `iOS-26-4`.
			expect(device.osVersion).toMatch(/^\d+\.\d+/);
			// This platform has none, and deriving one from the version would be inventing data.
			expect(device.osApiLevel).toBeNull();
			expect(device.attachment).toBe('this-host');
			expect(() => parseDeviceSerial(device.serial)).not.toThrow();
		});

		it('re-verifies one device by name, and answers null for one that is not there', async () => {
			const device = await booted();

			expect(await backend.describeDevice(device.serial)).toEqual(device);
			expect(
				await backend.describeDevice(parseDeviceSerial('00000000-0000-4000-8000-000000000000')),
			).toBeNull();
		});

		/**
		 * The acceptance criterion this phase's `deviceInfo` exists for, checked against the profile of
		 * whatever device type this host's booted simulator happens to be: the dp size is **exactly**
		 * the pixels over the scale, and `density` is a dpi rather than the scale — the field idb's own
		 * `describe` fills with 3.0 (`docs/IOS.md` §8, trap 6). The numbers themselves are not asserted
		 * here because they belong to the device somebody booted; the two relationships between them
		 * are what hold on every device type.
		 */
		it('reports a screen whose dp size is exactly the pixels over the device’s own scale', async () => {
			const device = await booted();

			const info = await backend.deviceInfo(device.serial);

			expect(info.serial).toBe(device.serial);
			expect(info.platform).toBe('ios-simulator');
			// One vocabulary across both shapes: the enumeration and the facts name the device the same.
			expect(info.model).toBe(device.model);
			expect(info.osVersion).toBe(device.osVersion);

			expect(info.screen.widthDp).toBe(info.screen.widthPx / info.screen.densityScale);
			expect(info.screen.heightDp).toBe(info.screen.heightPx / info.screen.densityScale);
			// A dpi, three digits on every device type Xcode 26.4.1 ships (40 and 80 are Watch types,
			// which this backend does not address) — and never equal to the scale beside it.
			expect(info.screen.density).toBeGreaterThanOrEqual(100);
			expect(info.screen.density).not.toBe(info.screen.densityScale);
			expect(Number.isInteger(info.screen.density)).toBe(true);
		});

		it('throws rather than answering null for a device this host does not have', async () => {
			const rejection = backend.deviceInfo(
				parseDeviceSerial('00000000-0000-4000-8000-000000000000'),
			);

			await expect(rejection).rejects.toBeInstanceOf(DeviceVanishedError);
		});

		/**
		 * The poll, subscribed to and stopped again — one full set delivered and nothing else asserted
		 * about timing, because what changes the device set is the operator plugging something in.
		 *
		 * `stop()` runs in a `finally` so a failed expectation cannot leave a timer polling `simctl`
		 * for the rest of the run.
		 */
		it('delivers the full current set on subscription', async () => {
			const devices = await backend.listDevices();
			const seen: Device[][] = [];
			const interruptions: string[] = [];
			// The condition, not a duration (ai/RULES.md §2): what this waits on is the first delivery
			// arriving, and the suite's own timeout is what bounds it.
			const first = createGate();

			let watch: DeviceWatch | null = null;
			try {
				watch = backend.watchDevices({
					onDevices: (set) => {
						seen.push(set);
						first.reach();
					},
					onInterrupted: (reason) => {
						interruptions.push(reason);
						first.reach();
					},
				});

				await first.reached;
			} finally {
				await watch?.stop();
			}

			expect(interruptions).toEqual([]);
			expect(seen[0]?.map((device) => device.serial).sort()).toEqual(
				devices.map((device) => device.serial).sort(),
			);
		});
	},
);
