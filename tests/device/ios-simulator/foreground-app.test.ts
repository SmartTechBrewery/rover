import { afterAll, describe, expect, it } from 'vitest';
import { IosSimulatorDeviceBackend } from '@/backends/ios-simulator/backend.js';
import { parseAppPids } from '@/backends/ios-simulator/parsers/launchctl-list.js';
import { runSimctlOnDevice } from '@/backends/ios-simulator/simctl.js';
import type { Device } from '@/core/device.js';
import { type DeviceSerial, parseAppId, unwrap } from '@/core/ids.js';
import { type Observation, waitForCondition } from '@/core/wait.js';
import { shutDownSimulator } from '../../helpers/simulators.js';

/**
 * `DeviceInfo.foregroundApp` against a real booted simulator, through a real `idb_companion` (#336).
 *
 * Gated on **both** flags `tests/device/setup.ts` sets — a booted simulator and a companion this
 * host can run — so a machine missing either **skips rather than fails** (ai/TESTING.md). The
 * mocked suite beside it pins the join against a read and a listing captured in one moment; what
 * no mock can answer is whether a live read's pid and a live listing still agree, and what the
 * field says after the app in front is gone.
 *
 * **It changes device state, and only Settings'**: it launches `com.apple.Preferences`, stops it,
 * launches it again and crashes it from the host — `./logs.test.ts`' recipe, because a simulator's
 * app is a host process and the runtime ships no `kill` of its own (`PROJECT.md` §6). Settings is
 * what `./app-control.test.ts` drives for the same reason: present on every runtime, and opening
 * and closing it changes nothing a person would miss. It boots nothing and shuts nothing down
 * (`docs/IOS.md` §8, trap 4), and ends by stopping the companion the reads started.
 *
 * **Every wait is on the field, never on a timer** (D12(b)): an app that was stopped leaves the
 * front asynchronously, so each case polls `deviceInfo` until the answer has moved and then asserts
 * what it moved to.
 */
const backend = new IosSimulatorDeviceBackend();

/** Present on every iOS runtime, and safe to open and close under someone else's eyes. */
const SETTINGS = parseAppId('com.apple.Preferences');

/** Generous, because every probe is a `simctl list`, a screen read and a `launchctl list`. */
const MOVE_TIMEOUT_MS = 20_000;
const MOVE_POLL_MS = 250;

async function bootedDevice(): Promise<Device> {
	const ready = (await backend.listDevices()).filter((device) => device.state === 'ready');
	expect(ready.length).toBeGreaterThan(0);
	return ready[0] as Device;
}

/** `deviceInfo`'s `foregroundApp`, polled until `met` holds of it. */
function foregroundAppWhen(
	serial: DeviceSerial,
	what: string,
	met: (foregroundApp: string | null) => boolean,
): Promise<string | null> {
	return waitForCondition({
		what,
		timeoutMs: MOVE_TIMEOUT_MS,
		pollIntervalMs: MOVE_POLL_MS,
		probe: async (): Promise<Observation<string | null>> => {
			const { foregroundApp } = await backend.deviceInfo(serial);
			return met(foregroundApp)
				? { met: true, value: foregroundApp }
				: { met: false, found: `foregroundApp ${JSON.stringify(foregroundApp)}` };
		},
	});
}

describe.skipIf(!process.env.ROVER_TEST_SIMULATOR || !process.env.ROVER_TEST_IDB)(
	'the foreground app device_info reports, on a real simulator',
	() => {
		afterAll(async () => {
			await backend.stopIdbCompanions();
		});

		/**
		 * **The acceptance criterion, both halves.** Settings in front is named by the id
		 * `launch_app` took; stopped, it stops being named. What comes after it is the home screen,
		 * and that is `null` — SpringBoard's process is a daemon in launchd's listing, not an
		 * application, so nothing measurable names it (`PROJECT.md` §6).
		 */
		it('names the app launched into the front, and stops naming it once it is stopped', async () => {
			const device = await bootedDevice();

			await backend.launchApp(device.serial, SETTINGS);
			await foregroundAppWhen(
				device.serial,
				'Settings named as the foreground app',
				(app) => app === unwrap(SETTINGS),
			);

			await backend.stopApp(device.serial, SETTINGS);
			const after = await foregroundAppWhen(
				device.serial,
				'Settings no longer named after it was stopped',
				(app) => app !== unwrap(SETTINGS),
			);

			expect(after).toBeNull();
		});

		/**
		 * **A crash is the case the field exists for** (#331): the agent did nothing, and the next
		 * answer has to say the app is gone. `SIGSEGV` from the host, `./logs.test.ts`' recipe.
		 */
		it('stops naming an app that crashed', async () => {
			const device = await bootedDevice();

			await backend.launchApp(device.serial, SETTINGS);
			await foregroundAppWhen(
				device.serial,
				'Settings named as the foreground app',
				(app) => app === unwrap(SETTINGS),
			);
			const listing = await runSimctlOnDevice(device.serial, 'spawn', ['launchctl', 'list']);
			const [pid] = parseAppPids(listing.stdout, unwrap(SETTINGS));
			expect(pid).toBeDefined();

			process.kill(pid as number, 'SIGSEGV');
			const after = await foregroundAppWhen(
				device.serial,
				'Settings no longer named after it crashed',
				(app) => app !== unwrap(SETTINGS),
			);

			expect(after).toBeNull();
		});

		/**
		 * **`null` has to stay reachable without a new way to fail**: a simulator that is not booted
		 * is not read, so nothing is named and every other field is still answered. Skipped out loud
		 * when this host has only booted simulators (ai/RULES.md §6).
		 */
		it('answers null, and every other field, for a simulator that is not booted', async () => {
			const asleep = await shutDownSimulator();
			if (asleep === null) {
				console.warn('skipped: this host has no simulator that is not booted');
				return;
			}

			const info = await backend.deviceInfo(asleep.serial);

			expect(info.foregroundApp).toBeNull();
			expect(info.serial).toBe(asleep.serial);
			expect(info.model).toBe(asleep.model);
		});
	},
);
