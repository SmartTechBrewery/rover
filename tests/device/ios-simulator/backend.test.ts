import { describe, expect, it } from 'vitest';
import { IosSimulatorDeviceBackend } from '@/backends/ios-simulator/backend.js';
import { IDB_COMPANION } from '@/backends/ios-simulator/idb-companion-path.js';
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

		/**
		 * Subscribe, wait for the first delivery, and stop again — whichever of the watch's two
		 * sources this host has.
		 *
		 * The gate is reached by the first `onDevices` and **not** by an interruption, so a host
		 * with no companion is not cut short by the one interruption its fallback costs; the
		 * interruptions are handed back for a case to assert rather than swallowed. The condition
		 * rather than a duration (ai/RULES.md §2), bounded by the suite's own timeout.
		 *
		 * `stop()` runs in a `finally` so a failed expectation cannot leave a companion running or
		 * a timer polling `simctl` for the rest of the run.
		 */
		async function firstDelivery(): Promise<{
			delivered: Device[];
			interruptions: string[];
		}> {
			const seen: Device[][] = [];
			const interruptions: string[] = [];
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
					},
				});

				await first.reached;
			} finally {
				await watch?.stop();
			}

			return { delivered: seen[0] ?? [], interruptions };
		}

		/** A set ordered so two sources' answers can be compared at all — the order is theirs. */
		const bySerial = (set: readonly Device[]): Device[] =>
			[...set].sort((left, right) => left.serial.localeCompare(right.serial));

		/** The devices of a set this host could actually lend. */
		const ready = (set: readonly Device[]): Device[] =>
			bySerial(set.filter((device) => device.state === 'ready'));

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
		 * One full set delivered, off whichever source this host has, and nothing asserted about
		 * timing — because what changes the device set is the operator booting something.
		 *
		 * **The interruption count is the source, stated rather than tolerated.** A host with a
		 * companion is watched through the stream and is interrupted not at all; a host without one
		 * pays exactly one interruption naming `idb_companion` and is then served by the `simctl`
		 * poll. That one message is what tells an operator why the cheaper source is not in use, so
		 * a case that shrugged at it would be hiding the only evidence there is.
		 *
		 * **What the two sources have to agree about is every device this host could lend**, and
		 * the membership assertion is deliberately one-directional. `toDevices` keeps a simulator
		 * whose runtime key does not resolve and reports it without a version, while
		 * `toNotifiedDevices` drops a target whose `os_version` does not name iOS at all — on that
		 * path the platform word is the only evidence about which platform a target belongs to
		 * (`src/backends/ios-simulator/devices.ts`). So the watch's set is a subset of the
		 * enumeration's, and the `ready` devices in it match device for device.
		 */
		it('delivers the full current set on subscription', async () => {
			const devices = await backend.listDevices();

			const { delivered, interruptions } = await firstDelivery();

			expect(interruptions).toEqual(
				process.env.ROVER_TEST_IDB ? [] : [expect.stringContaining(IDB_COMPANION)],
			);
			expect(devices.map((device) => device.serial)).toEqual(
				expect.arrayContaining(delivered.map((device) => device.serial)),
			);
			expect(ready(delivered)).toEqual(ready(devices));
		});

		/**
		 * The watch on the stream it was written for, against a real companion — gated on
		 * `ROVER_TEST_IDB` so a host with no `idb_companion` skips rather than fails
		 * (ai/TESTING.md).
		 *
		 * This is the two-paths-agree claim phase 1 could only make between its own two functions,
		 * made against the two **programs**: `simctl`'s runtime reports `26.5` where the idb target
		 * for that same device reports `iOS 26.5`, so the normalisation in `devices.ts` is checked
		 * here against what the two really print on this host rather than against what a capture
		 * said they printed on another (`docs/IOS.md` §4). Two spellings for one device would let
		 * `list_devices` and the inventory disclose two different OS versions for it.
		 *
		 * It boots nothing, so the transition sequence a second simulator produces
		 * (`Shutdown → Booting → Booted`) is not a case here — that is an operator-driven
		 * observation, for the reason this file's header gives: driving `Simulator.app` shuts down
		 * every device it owns.
		 */
		describe.skipIf(!process.env.ROVER_TEST_IDB)('watched through idb’s notify stream', () => {
			it('names the booted device listDevices names, with the same osVersion string', async () => {
				const device = await booted();

				const { delivered, interruptions } = await firstDelivery();

				expect(interruptions).toEqual([]);
				const watched = delivered.find((candidate) => candidate.serial === device.serial);
				// The whole shape, because every field of it is a place the two paths could
				// disagree — and then the one that actually needed reconciling, named.
				expect(watched).toEqual(device);
				expect(watched?.osVersion).toBe(device.osVersion);
			});
		});
	},
);
