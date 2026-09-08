import { describe, expect, it } from 'vitest';
import { toDevices } from '@/backends/ios-simulator/devices.js';
import {
	parseSimctlDevices,
	parseSimctlRuntimes,
} from '@/backends/ios-simulator/parsers/simctl-list.js';
import {
	runSimctl,
	runSimctlOnDevice,
	SimctlCommandError,
} from '@/backends/ios-simulator/simctl.js';
import { parseDeviceSerial } from '@/core/ids.js';

/**
 * The half of the runner no mock can answer: whether the recipe reaches a real `simctl` at all.
 *
 * Gated on `ROVER_TEST_SIMULATOR`, set by `tests/device/setup.ts` when a simulator is booted, so
 * a host without one **skips rather than fails** (ai/TESTING.md). What the mocked suite next to
 * it proves is the argv and the error; what this proves is that the argv works — executed
 * directly out of the developer directory `developer-dir.ts` verified, with no `xcrun` anywhere
 * in the path.
 *
 * **It changes no device state**: it boots nothing, shuts nothing down, and the one failure it
 * provokes is a terminate of an app that is not installed. That restraint is the fixtures
 * README's rule and `docs/IOS.md` §8 trap 4's reason — quitting or driving `Simulator.app` shuts
 * down every device it owns, so a suite that boots its own subject takes the operator's session
 * with it.
 *
 * It takes no lease, and **not under the exemption `ai/TESTING.md` grants the six Android
 * suites** — that one is a conversion gap over an enumerated list this suite is not on, and it
 * is deleted once those six convert. This is the backend-under-construction case beside it: the
 * backend has no class and is registered nowhere yet, so there is no daemon that could lend one
 * of these devices and nothing to take a lease from. That bound expires by itself when the
 * manifest registers, rather than when somebody does conversion work.
 */
describe.skipIf(!process.env.ROVER_TEST_SIMULATOR)('simctl against a real simulator', () => {
	/** Both listings in one invocation, because `toDevices` needs both (`devices.ts`). */
	const listing = async (): Promise<string> =>
		(await runSimctl(['list', '-j', 'devices', 'runtimes'])).stdout;

	it('runs the listing directly out of the verified developer directory', async () => {
		const stdout = await listing();

		// Exit 0 is implied: anything else would have rejected with a SimctlCommandError.
		expect(parseSimctlDevices(stdout).devices).not.toEqual({});
		expect(parseSimctlRuntimes(stdout).runtimes.length).toBeGreaterThan(0);
	});

	/**
	 * The enumeration and the runner agreeing about what a serial is — the property the rest of
	 * this backend's phases will address devices through.
	 */
	it('names at least one ready device whose serial the core accepts', async () => {
		const stdout = await listing();
		const devices = toDevices(parseSimctlDevices(stdout), parseSimctlRuntimes(stdout));

		expect(devices.length).toBeGreaterThan(0);
		expect(devices.some((device) => device.state === 'ready')).toBe(true);
		for (const device of devices) {
			expect(() => parseDeviceSerial(device.serial)).not.toThrow();
		}
	});

	/**
	 * A failure off the real tool, which is what keeps the module's "the exit code carries no
	 * meaning" honest against an Xcode upgrade: `terminate` of an app that is not there exited
	 * **3** on Xcode 26.4.1 while an invalid device exits 148 and an unknown subcommand exits 1.
	 * Nothing is asserted about *which* number it is, only that both halves of the failure came
	 * back — asserting 3 would be building the mapping the module refuses to build.
	 */
	it('carries the exit code and stderr of a failure the tool really produced', async () => {
		const stdout = await listing();
		const ready = toDevices(parseSimctlDevices(stdout), parseSimctlRuntimes(stdout)).find(
			(device) => device.state === 'ready',
		);
		if (ready === undefined) throw new Error('the gate said a device was booted');

		const error = await runSimctlOnDevice(parseDeviceSerial(ready.serial), 'terminate', [
			'com.rover.nope',
		]).then(
			() => null,
			(thrown: unknown) => thrown,
		);

		expect(error).toBeInstanceOf(SimctlCommandError);
		const failure = error as SimctlCommandError;
		expect(failure.exitCode).not.toBe(0);
		expect(failure.exitCode).not.toBeNull();
		expect(failure.timedOut).toBe(false);
		expect(failure.stderr).not.toBe('');
		expect(failure.argv[0]).toBe('terminate');
		expect(failure.argv[1]).toBe(ready.serial);
	});
});
