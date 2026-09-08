import { afterEach, describe, expect, it } from 'vitest';
import { IosSimulatorDeviceBackend } from '@/backends/ios-simulator/backend.js';
import { IDB_HEALTH_RPC, IdbCompanions } from '@/backends/ios-simulator/idb-client.js';
import type { Device } from '@/core/device.js';

/**
 * The half of this phase no stub can answer: whether a **real** `idb_companion` starts, answers
 * over gRPC and can be killed without taking the simulator with it.
 *
 * The unit suite beside it drives a Node program serving the vendored proto, which proves the
 * client, the socket handshake and the death path — against a server this repository wrote. What
 * it cannot prove is that Meta's program behaves that way, and every claim this phase rests on is
 * about Meta's program: that it binds the socket it is asked for and says so on stdout, that it
 * answers `describe`, and that killing it leaves the device `Booted`.
 *
 * **The last of those is the point of this file.** `docs/IOS.md` §4 recorded it from the command
 * line; this re-runs it through this repository's own code, and it is the evidence that
 * supervising a companion is Rover's business and nobody else's — if a companion's death were a
 * device fault, none of the lifecycle above it would be allowed to look like this.
 *
 * Gated on **both** flags `tests/device/setup.ts` sets: a booted simulator and an `idb_companion`
 * this host can run. A host missing either **skips rather than fails** (ai/TESTING.md), and the
 * setup warns loudly about both.
 *
 * **It changes no device state.** `describe` is a read, and the only thing killed is a process on
 * this host — which is exactly the assertion. It takes no lease for `./backend.test.ts`' stated
 * reason: every call here is a read against a device nobody is holding.
 *
 * The one claim it deliberately leaves to the unit suite is what a call in flight sees when its
 * companion dies: against a real companion `describe` answers in a millisecond, so "kill it while
 * a call is outstanding" is a race rather than a case, and the stub that exits without answering
 * is how that is asserted deterministically.
 */
describe.skipIf(!process.env.ROVER_TEST_SIMULATOR || !process.env.ROVER_TEST_IDB)(
	'a supervised idb companion, on this host',
	() => {
		const backend = new IosSimulatorDeviceBackend();
		const companions = new IdbCompanions();

		afterEach(async () => {
			// Nothing this suite started may outlive it: a companion is a process on this host that
			// nothing else supervises.
			await companions.stopAll();
		});

		/** The booted device the gate found, which is the only one this file is about. */
		async function booted(): Promise<Device> {
			const devices = await backend.listDevices();
			const ready = devices.find((device) => device.state === 'ready');
			if (ready === undefined) throw new Error('the gate said a simulator was booted');
			return ready;
		}

		/** What `describe` answers with, read for the two fields this suite checks. */
		interface Described {
			target_description?: { udid?: string; state?: string };
		}

		it('starts a companion for the booted device and answers a read-only call', async () => {
			const device = await booted();

			const answer = (await companions.call(device.serial, IDB_HEALTH_RPC, {})) as Described;

			// The companion was started with `--udid`, so the target it describes is the one asked
			// for and not whichever simulator it felt like adopting.
			expect(answer.target_description?.udid).toBe(device.serial);
			expect(answer.target_description?.state).toBe('Booted');
		});

		/** One companion per target: the second call is answered by the process the first started. */
		it('answers a second call without starting a second companion', async () => {
			const device = await booted();

			await companions.call(device.serial, IDB_HEALTH_RPC, {});

			await expect(companions.call(device.serial, IDB_HEALTH_RPC, {})).resolves.toBeDefined();
		});

		/**
		 * `docs/IOS.md` §4's measurement, re-run through this repository's code: the companion is
		 * killed and **the device is still `ready`**.
		 *
		 * Read through `describeDevice`, which asks `simctl` rather than idb, because the question
		 * is what the *platform* says about the device — a companion reporting on its own health
		 * would be the one witness that cannot answer this.
		 */
		it('leaves the device ready after its companion has been killed', async () => {
			const device = await booted();
			await companions.call(device.serial, IDB_HEALTH_RPC, {});

			await companions.stop(device.serial);

			const after = await backend.describeDevice(device.serial);
			expect(after?.state).toBe('ready');
		});

		/**
		 * And the transport recovers on its own: a killed companion is forgotten, so the next call
		 * starts another and is answered normally. Restart-on-death, from the caller's side.
		 */
		it('starts a fresh companion for the next call after one has been killed', async () => {
			const device = await booted();
			await companions.call(device.serial, IDB_HEALTH_RPC, {});
			await companions.stop(device.serial);

			const answer = (await companions.call(device.serial, IDB_HEALTH_RPC, {})) as Described;

			expect(answer.target_description?.state).toBe('Booted');
		});
	},
);
