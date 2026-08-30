/**
 * Forced state restoration (D9) — the daemon puts the device back, on both paths.
 *
 * **The expiry suite is the row's headline criterion** (PROJECT.md §9.3, R9): a teardown that
 * only runs when a well-behaved client remembers to call `release_device` is the predecessor's
 * failure with a daemon around it. So that suite calls nothing that ends a lease on purpose —
 * it moves the clock and lets the sweep notice, which is exactly what happens when the agent
 * holding the device has died.
 *
 * The handlers are driven directly rather than over a socket: what is asserted here is the
 * order of the work and who waits for whom, and a real unix socket adds nothing to that
 * (`acquire-device.test.ts` is where the wire itself is exercised). The clock is the same
 * mutable closure `leases.test.ts` uses, so nothing here waits out a lease. The one real timer
 * is the teardown hook's own bound, shortened to a few milliseconds through the restorer's
 * seam — and even there the test waits on the restoration finishing, never on a duration.
 *
 * The backend records into one shared array rather than answering with mocks, because every
 * assertion here is about **order**: which step ran before which, and whether a grant landed
 * before the restoration it was supposed to wait for.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	_resetDeviceBackendRegistryForTesting,
	registerDeviceBackend,
} from '@/backends/registry.js';
import type { Capabilities } from '@/core/capabilities.js';
import type { DeviceBackend } from '@/core/device.js';
import {
	type AppId,
	type DeviceSerial,
	type LeaseId,
	parseAppId,
	parseDeviceSerial,
} from '@/core/ids.js';
import { createDeviceInventory } from '@/daemon/inventory.js';
import { createLeaseHandlers, type LeaseHandlers } from '@/daemon/lease-handlers.js';
import { createLeaseStore, type LeaseStore } from '@/daemon/leases.js';
import { createProjectResolver } from '@/daemon/project-resolver.js';
import {
	createDeviceRestorer,
	type ProjectResolver,
	type ProjectRestoration,
} from '@/daemon/restore.js';
import { createMockDevice } from '../../helpers/factories.js';

const SERIAL = parseDeviceSerial('attached-1');
const APP = parseAppId('com.example.rover');
const OTHER_APP = parseAppId('com.example.rover.helper');
const TTL_MS = 60_000;

/** What a fully restored device looks like, in the order PROJECT.md §6 says is correct. */
const FULL_RESTORATION = [
	`stopApp ${APP}`,
	`stopApp ${OTHER_APP}`,
	'setAirplaneMode false',
	'setWifiEnabled true',
	'teardown',
];

interface Harness {
	readonly handlers: LeaseHandlers;
	readonly leases: LeaseStore;
	/** Every step the device and the project hook performed, in the order they performed it. */
	readonly performed: string[];
	readonly warnings: string[];
	settle(): Promise<void>;
	at(instant: number): void;
	acquire(owner: string): Promise<LeaseId>;
}

interface HarnessOptions {
	readonly capabilities?: Partial<Capabilities>;
	readonly backend?: (performed: string[]) => Partial<DeviceBackend>;
	/** Defaults to two apps and a hook; `null` is the "nobody has described it" answer. */
	readonly project?: (performed: string[]) => ProjectRestoration | null;
	/**
	 * The real resolver over a real hook file, replacing the fake above outright. Used by the
	 * end-to-end suite at the bottom, which is the one that proves the file reaches the device.
	 */
	readonly resolver?: ProjectResolver;
	/** The `project` string every lease this harness grants carries. */
	readonly projectName?: string;
	/** Defaults to the restorer's own ten seconds, which no unit test can wait out. */
	readonly teardownTimeoutMs?: number;
	/** Defaults to the restorer's own ten seconds, for {@link teardownTimeoutMs}'s reason. */
	readonly settleTimeoutMs?: number;
	/** Defaults to resolving at once — the restorer's own default is the same. */
	readonly settleTraffic?: (serial: DeviceSerial) => Promise<void>;
}

function createHarness(options: HarnessOptions = {}): Harness {
	const performed: string[] = [];
	const warnings: string[] = [];
	let nowMs = 1_000_000;

	registerDeviceBackend({
		manifest: {
			platform: 'test-platform',
			label: 'Test',
			capabilities: {
				canReadScreen: true,
				canInput: true,
				canControlNetwork: true,
				canRecordVideo: true,
				...options.capabilities,
			},
		},
		backend: createRecordingBackend(performed, options.backend?.(performed) ?? {}),
	});

	const inventory = createDeviceInventory({ warn: (message) => warnings.push(message) });
	const restorer = createDeviceRestorer({
		inventory,
		resolveProject:
			options.resolver ??
			(async () =>
				options.project
					? options.project(performed)
					: {
							apps: [APP, OTHER_APP],
							teardown: async () => {
								performed.push('teardown');
							},
						}),
		warn: (message) => warnings.push(message),
		...(options.teardownTimeoutMs === undefined
			? {}
			: { teardownTimeoutMs: options.teardownTimeoutMs }),
		...(options.settleTimeoutMs === undefined ? {} : { settleTimeoutMs: options.settleTimeoutMs }),
		...(options.settleTraffic === undefined ? {} : { settleTraffic: options.settleTraffic }),
	});
	const leases = createLeaseStore({
		ttlMs: TTL_MS,
		now: () => nowMs,
		onLeaseEnded: (lease, reason) => restorer.restore(lease, reason),
		warn: (message) => warnings.push(message),
	});

	return {
		handlers: createLeaseHandlers(inventory, leases, restorer),
		leases,
		performed,
		warnings,
		settle: () => restorer.settle(SERIAL),
		at: (instant: number) => {
			nowMs = instant;
		},
		async acquire(owner: string): Promise<LeaseId> {
			const result = await this.handlers.acquire_device({
				serial: SERIAL,
				owner,
				project: options.projectName ?? 'rover',
			});
			if (result.outcome !== 'granted') {
				throw new Error(`the acquire must be granted, got '${result.message}'`);
			}
			return result.lease.leaseId;
		},
	};
}

/**
 * A backend whose every relevant method appends what it did to `performed`. Plain functions
 * rather than `vi.fn()` — the assertions are about the order of the whole sequence, which one
 * shared array says far more directly than four separate call lists.
 */
function createRecordingBackend(
	performed: string[],
	overrides: Partial<DeviceBackend>,
): DeviceBackend {
	return {
		listDevices: async () => [createMockDevice({ serial: SERIAL })],
		watchDevices: () => ({ stop: async () => {} }),
		describeDevice: async (serial) => createMockDevice({ serial }),
		deviceInfo: async () => {
			throw new Error('deviceInfo is not part of a restoration');
		},
		installApp: async () => {},
		launchApp: async () => {},
		stopApp: async (_serial, appId: AppId) => {
			performed.push(`stopApp ${appId}`);
		},
		clearAppData: async () => {},
		screenshot: async () => new Uint8Array(),
		readLogs: async () => {
			throw new Error('readLogs is not part of a restoration');
		},
		pushFile: async () => {
			throw new Error('pushFile is not part of a restoration');
		},
		pullFile: async () => {
			throw new Error('pullFile is not part of a restoration');
		},
		setAirplaneMode: async (_serial, enabled: boolean) => {
			performed.push(`setAirplaneMode ${enabled}`);
		},
		setWifiEnabled: async (_serial, enabled: boolean) => {
			performed.push(`setWifiEnabled ${enabled}`);
		},
		...overrides,
	};
}

/** A promise the test resolves by hand, so nothing here waits on a duration. */
function createGate(): { reached: Promise<void>; reach: () => void } {
	let reach!: () => void;
	const reached = new Promise<void>((resolve) => {
		reach = resolve;
	});
	return { reached, reach };
}

afterEach(() => {
	_resetDeviceBackendRegistryForTesting();
});

describe('the teardown runs when a lease expires', () => {
	it('restores the device with nobody having released it', async () => {
		const harness = createHarness();
		await harness.acquire('issue-112');

		// The whole point of the row: the agent that held this device is gone. It issues no
		// further calls, and there is nothing in this test that ends its lease — the instant
		// passes, and the daemon's own sweep is what notices.
		harness.at(1_000_000 + TTL_MS);
		harness.leases.sweep();
		await harness.settle();

		expect(harness.performed).toEqual(FULL_RESTORATION);
		expect(harness.warnings).toEqual([]);
	});

	it('restores when a competing acquire is what observes the expiry', async () => {
		const harness = createHarness();
		await harness.acquire('issue-112');

		harness.at(1_000_000 + TTL_MS);
		const leaseId = await harness.acquire('pr-127-review');

		// The new lessee's own grant observed the dead one and waited out its restoration, so
		// every step above is behind it rather than racing it.
		expect(harness.performed).toEqual(FULL_RESTORATION);
		expect(leaseId).toBeTruthy();
	});
});

describe('the teardown runs when a lease is released', () => {
	it('restores the device after release_device', async () => {
		const harness = createHarness();
		const leaseId = await harness.acquire('issue-112');

		expect(harness.handlers.release_device({ leaseId })).toEqual({ released: true });
		await harness.settle();

		expect(harness.performed).toEqual(FULL_RESTORATION);
	});

	it('answers the release without waiting for the device', async () => {
		const gate = createGate();
		const harness = createHarness({
			backend: (performed) => ({
				stopApp: async (_serial, appId) => {
					await gate.reached;
					performed.push(`stopApp ${appId}`);
				},
			}),
		});
		const leaseId = await harness.acquire('issue-112');

		// The answer is "the lease is over", and that is true the moment the record is gone —
		// the device is still mid-restoration here.
		expect(harness.handlers.release_device({ leaseId })).toEqual({ released: true });
		expect(harness.performed).toEqual([]);

		gate.reach();
		await harness.settle();
		expect(harness.performed).toEqual(FULL_RESTORATION);
	});

	it('restores exactly once per lease, however many times the end is looked for', async () => {
		const harness = createHarness();
		const leaseId = await harness.acquire('issue-112');

		harness.handlers.release_device({ leaseId });
		harness.handlers.release_device({ leaseId });
		harness.at(1_000_000 + TTL_MS);
		harness.leases.sweep();
		harness.leases.sweep();
		await harness.settle();

		// `forget` fires the hook, and a record is only forgotten once. A second restoration
		// would be a device torn down under whoever acquired it in between.
		expect(harness.performed).toEqual(FULL_RESTORATION);
	});
});

describe('a step that fails does not take the rest with it', () => {
	it('runs every remaining step and says which one failed', async () => {
		const harness = createHarness({
			backend: () => ({
				setAirplaneMode: async () => {
					throw new Error('the device refused');
				},
			}),
		});
		const leaseId = await harness.acquire('issue-112');

		expect(harness.handlers.release_device({ leaseId })).toEqual({ released: true });
		await harness.settle();

		// A teardown that stops at the first error is "only runs on the happy path" in a new
		// costume: the app would be left running because a radio would not turn off.
		expect(harness.performed).toEqual([
			`stopApp ${APP}`,
			`stopApp ${OTHER_APP}`,
			'setWifiEnabled true',
			'teardown',
		]);
		expect(harness.warnings).toHaveLength(1);
		expect(harness.warnings[0]).toContain('airplane mode');
		expect(harness.warnings[0]).toContain('the device refused');
	});

	it('frees the device for the next lessee even so', async () => {
		const harness = createHarness({
			project: (performed) => ({
				apps: [APP],
				teardown: async () => {
					performed.push('teardown');
					throw new Error('the project hook broke');
				},
			}),
		});
		const leaseId = await harness.acquire('issue-112');
		harness.handlers.release_device({ leaseId });

		await expect(harness.acquire('pr-127-review')).resolves.toBeTruthy();
	});
});

describe('a backend that cannot control the network', () => {
	it('skips those two steps with one warning and still runs the rest', async () => {
		const harness = createHarness({ capabilities: { canControlNetwork: false } });
		const leaseId = await harness.acquire('issue-112');

		harness.handlers.release_device({ leaseId });
		await harness.settle();

		// An honest opt-out is not a failure (D11), and a teardown is not a verb an agent
		// called — there is nobody to hand a `MissingCapabilityError` to.
		expect(harness.performed).toEqual([`stopApp ${APP}`, `stopApp ${OTHER_APP}`, 'teardown']);
		expect(harness.warnings).toHaveLength(1);
		expect(harness.warnings[0]).toContain('canControlNetwork');
		expect(harness.warnings[0]).toContain(SERIAL);
	});
});

describe('the project seam the hook file fills', () => {
	/** The resolver reads a file per project, and a file can be missing or malformed. */
	const unreadableProject = () => ({
		project: () => {
			throw new Error('the project file is unreadable');
		},
	});

	it('still restores the device when the resolver itself throws', async () => {
		const harness = createHarness(unreadableProject());
		const leaseId = await harness.acquire('issue-112');
		harness.handlers.release_device({ leaseId });

		// `settle` is awaited inside `acquire_device`. A restoration that rejected would come
		// back to the next caller as `internal_error` about a device that is perfectly fine.
		await expect(harness.acquire('pr-127-review')).resolves.toBeTruthy();
		// And the resolver costs its own steps only. One unreadable config file that skipped
		// the radios would hand the next agent a phone in airplane mode, for every device that
		// project ever leases, with nothing left to retry it.
		expect(harness.performed).toEqual(['setAirplaneMode false', 'setWifiEnabled true']);
		expect(harness.warnings).toHaveLength(1);
		expect(harness.warnings[0]).toContain('the project file is unreadable');
	});

	it('still restores the device when the resolver throws on the expiry path', async () => {
		const harness = createHarness(unreadableProject());
		await harness.acquire('issue-112');

		// The other of the two paths D9 names, and the one with no caller left to notice: the
		// holder is gone, and the sweep is what observes it.
		harness.at(1_000_000 + TTL_MS);
		harness.leases.sweep();
		await harness.settle();

		expect(harness.performed).toEqual(['setAirplaneMode false', 'setWifiEnabled true']);
		expect(harness.warnings).toHaveLength(1);
		expect(harness.warnings[0]).toContain('the project file is unreadable');
	});

	it('restores the radios and says nothing about a project nobody has described', async () => {
		const harness = createHarness({ project: () => null });
		const leaseId = await harness.acquire('issue-112');

		harness.handlers.release_device({ leaseId });
		await harness.settle();

		// A project with no hook file leaves the app and hook steps with nothing to do. A hook
		// that does not fire is not a hook that is broken.
		expect(harness.performed).toEqual(['setAirplaneMode false', 'setWifiEnabled true']);
		expect(harness.warnings).toEqual([]);
	});
});

describe('a project teardown hook that never returns', () => {
	it('stops waiting for it, says so, and still hands the device on', async () => {
		const harness = createHarness({
			// The restorer's real bound is ten seconds; this is the same seam `ttlMs` is.
			teardownTimeoutMs: 5,
			project: () => ({
				apps: [APP],
				// A hook waiting on a helper service that never exits. `settle` is awaited
				// inside `acquire_device`, so an unbounded wait here would hang every later grant
				// for this device — with no lease id issued and no TTL to expire it.
				teardown: () => new Promise<void>(() => {}),
			}),
		});
		const leaseId = await harness.acquire('issue-112');
		harness.handlers.release_device({ leaseId });

		await expect(harness.acquire('pr-127-review')).resolves.toBeTruthy();
		expect(harness.performed).toEqual([
			`stopApp ${APP}`,
			'setAirplaneMode false',
			'setWifiEnabled true',
		]);
		expect(harness.warnings).toHaveLength(1);
		expect(harness.warnings[0]).toContain('the project teardown hook did not finish within');
		expect(harness.warnings[0]).toContain(SERIAL);
	});
});

describe('a verb call from the ending lease that never unwinds', () => {
	it('stops waiting for it, says so, and restores the device anyway', async () => {
		const harness = createHarness({
			// The restorer's real bound is ten seconds; the same seam `teardownTimeoutMs` is.
			settleTimeoutMs: 5,
			// A call the lease's end could not reach: revoking a backend stops the *next* method,
			// and a verb awaiting a host process — `install_app` running a project's install
			// command — has none to stop. Unbounded, this is worse than a teardown that hangs,
			// because it comes *first*: nothing on the device is restored either.
			settleTraffic: () => new Promise<void>(() => {}),
		});
		const leaseId = await harness.acquire('issue-112');
		harness.handlers.release_device({ leaseId });

		await expect(harness.acquire('pr-127-review')).resolves.toBeTruthy();
		expect(harness.performed).toEqual([
			`stopApp ${APP}`,
			`stopApp ${OTHER_APP}`,
			'setAirplaneMode false',
			'setWifiEnabled true',
			'teardown',
		]);
		expect(harness.warnings).toHaveLength(1);
		expect(harness.warnings[0]).toContain('had not unwound within');
		expect(harness.warnings[0]).toContain(SERIAL);
	});

	it('waits for one that does unwind, so the bound is a backstop and not the rule', async () => {
		const unwound = createGate();
		const harness = createHarness({
			settleTimeoutMs: 5_000,
			settleTraffic: () => unwound.reached,
		});
		const leaseId = await harness.acquire('issue-112');
		harness.handlers.release_device({ leaseId });

		// Nothing is undone while the previous holder's call is still in flight: the restoration
		// and that call would be two drivers of one device, which is what this wait exists for.
		await Promise.resolve();
		expect(harness.performed).toEqual([]);

		unwound.reach();
		await harness.settle();
		expect(harness.performed).toContain('teardown');
		expect(harness.warnings).toEqual([]);
	});
});

describe('a device is never granted mid-restore', () => {
	it('makes the next acquire wait for the restoration in flight rather than race it', async () => {
		const teardownGate = createGate();
		const reachedWifi = createGate();
		const harness = createHarness({
			backend: (performed) => ({
				setWifiEnabled: async (_serial, enabled) => {
					performed.push(`setWifiEnabled ${enabled}`);
					reachedWifi.reach();
				},
			}),
			project: (performed) => ({
				apps: [APP],
				teardown: async () => {
					await teardownGate.reached;
					performed.push('teardown');
				},
			}),
		});
		const leaseId = await harness.acquire('issue-112');
		harness.handlers.release_device({ leaseId });

		const acquiring = harness.acquire('pr-127-review').then((granted) => {
			harness.performed.push('granted');
			return granted;
		});

		// Waited on the condition, not on a duration: the restoration is provably past its
		// third step and stuck in the project hook.
		await reachedWifi.reached;
		expect(harness.performed).not.toContain('granted');

		teardownGate.reach();
		await acquiring;

		expect(harness.performed).toEqual([
			`stopApp ${APP}`,
			'setAirplaneMode false',
			'setWifiEnabled true',
			'teardown',
			'granted',
		]);
	});
});

/**
 * The row's headline criterion, end to end: a **real hook file** on disk, read by the **real**
 * resolver, driving a real teardown — on release and on expiry both (D9, R9).
 *
 * Everything above this point drives the seam through a fake, because what it asserts is order
 * and containment. This suite asserts the other half: that what an operator writes in
 * `~/.rover/projects/<project>.json` is what the daemon does when a lease on that project ends,
 * by whichever of the two paths ends it.
 */
describe('a project hook file, on both paths a lease can end', () => {
	const HOOK_PROJECT = 'checkout-web';
	const CHECKOUT = parseAppId('com.example.checkout');
	const HELPER = parseAppId('com.example.checkout.helper');

	let root: string;
	let marker: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'rover-restoration-'));
		marker = join(root, 'teardown-ran.txt');
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	/** Write `<root>/<HOOK_PROJECT>.json` verbatim, so a malformed file is writable too. */
	async function writeHookFile(contents: string): Promise<void> {
		await writeFile(join(root, `${HOOK_PROJECT}.json`), contents, 'utf8');
	}

	/** A hook file whose teardown is a real program that leaves proof it ran. */
	async function writeWorkingHookFile(): Promise<void> {
		await writeHookFile(
			JSON.stringify({
				project: HOOK_PROJECT,
				apps: [CHECKOUT, HELPER],
				teardown: {
					command: process.execPath,
					args: [
						'-e',
						"require('node:fs').writeFileSync(process.argv[1], process.env.ROVER_PROJECT + ' ' + process.env.ROVER_DEVICE_SERIAL)",
						marker,
					],
				},
			}),
		);
	}

	function createFileBackedHarness(hookTimeoutMs?: number): Harness {
		return createHarness({
			projectName: HOOK_PROJECT,
			resolver: createProjectResolver({
				root,
				...(hookTimeoutMs === undefined ? {} : { hookTimeoutMs }),
			}),
		});
	}

	it('stops the declared apps and runs the teardown on release', async () => {
		await writeWorkingHookFile();
		const harness = createFileBackedHarness();
		const leaseId = await harness.acquire('issue-112');

		harness.handlers.release_device({ leaseId });
		await harness.settle();

		expect(harness.performed).toEqual([
			`stopApp ${CHECKOUT}`,
			`stopApp ${HELPER}`,
			'setAirplaneMode false',
			'setWifiEnabled true',
		]);
		// The teardown ran as a real process, and it was told which project and which device —
		// a hook that cannot name the device it is undoing is the wrong shape.
		await expect(readFile(marker, 'utf8')).resolves.toBe(`${HOOK_PROJECT} ${SERIAL}`);
		expect(harness.warnings).toEqual([]);
	});

	it('stops the declared apps and runs the teardown on expiry, with nobody left to ask', async () => {
		await writeWorkingHookFile();
		const harness = createFileBackedHarness();
		await harness.acquire('issue-112');

		// The path D9 exists for: the agent holding the device is gone and issues no further
		// call. Nothing here ends the lease — the instant passes and the sweep notices.
		harness.at(1_000_000 + TTL_MS);
		harness.leases.sweep();
		await harness.settle();

		expect(harness.performed).toEqual([
			`stopApp ${CHECKOUT}`,
			`stopApp ${HELPER}`,
			'setAirplaneMode false',
			'setWifiEnabled true',
		]);
		await expect(readFile(marker, 'utf8')).resolves.toBe(`${HOOK_PROJECT} ${SERIAL}`);
		expect(harness.warnings).toEqual([]);
	});

	it('takes an edit to the file on the very next lease, with nothing restarted', async () => {
		await writeWorkingHookFile();
		const harness = createFileBackedHarness();
		harness.handlers.release_device({ leaseId: await harness.acquire('issue-112') });
		await harness.settle();

		await writeHookFile(JSON.stringify({ project: HOOK_PROJECT, apps: [CHECKOUT] }));
		harness.performed.length = 0;
		harness.handlers.release_device({ leaseId: await harness.acquire('pr-127-review') });
		await harness.settle();

		// D6: the file is re-read at every use and never cached, so the helper app is no longer
		// stopped and no teardown runs — with the daemon still up.
		expect(harness.performed).toEqual([
			`stopApp ${CHECKOUT}`,
			'setAirplaneMode false',
			'setWifiEnabled true',
		]);
	});

	it('restores the device and says nothing when the project has no hook file', async () => {
		const harness = createFileBackedHarness();
		const leaseId = await harness.acquire('issue-112');

		harness.handlers.release_device({ leaseId });
		await harness.settle();

		// A project nobody has registered is the ordinary state of a host, not a failure — and
		// no default anywhere names an application, so nothing is stopped.
		expect(harness.performed).toEqual(['setAirplaneMode false', 'setWifiEnabled true']);
		expect(harness.warnings).toEqual([]);
	});

	it('warns once and still restores the device when the file will not parse', async () => {
		await writeHookFile('{ "project": "checkout-web", ');
		const harness = createFileBackedHarness();
		const leaseId = await harness.acquire('issue-112');

		harness.handlers.release_device({ leaseId });
		await harness.settle();

		// One bad config file costs that project's own steps and nothing else. The alternative
		// hands the next agent a phone left in airplane mode, for every device that project
		// ever leases, with nothing left to retry it.
		expect(harness.performed).toEqual(['setAirplaneMode false', 'setWifiEnabled true']);
		expect(harness.warnings).toHaveLength(1);
		expect(harness.warnings[0]).toContain(HOOK_PROJECT);
		expect(harness.warnings[0]).toContain('is not valid JSON');
	});

	it('warns with the exit code when the teardown command fails, and carries on', async () => {
		await writeHookFile(
			JSON.stringify({
				project: HOOK_PROJECT,
				apps: [CHECKOUT],
				teardown: {
					command: process.execPath,
					args: [
						'-e',
						"process.stderr.write('the helper service was already gone'); process.exit(3)",
					],
				},
			}),
		);
		const harness = createFileBackedHarness();
		const leaseId = await harness.acquire('issue-112');

		harness.handlers.release_device({ leaseId });
		await harness.settle();

		// The teardown is last, so everything before it already ran; the failure is contained
		// the way every other step's is, and the device is free for the next lessee.
		expect(harness.performed).toEqual([
			`stopApp ${CHECKOUT}`,
			'setAirplaneMode false',
			'setWifiEnabled true',
		]);
		expect(harness.warnings).toHaveLength(1);
		expect(harness.warnings[0]).toContain('exited 3');
		expect(harness.warnings[0]).toContain('the helper service was already gone');
		await expect(harness.acquire('pr-127-review')).resolves.toBeTruthy();
	});

	it('does not wait on what a teardown left running after it exited', async () => {
		const orphanPid = join(root, 'orphan.pid');
		await writeHookFile(
			JSON.stringify({
				project: HOOK_PROJECT,
				apps: [CHECKOUT],
				teardown: {
					command: process.execPath,
					args: [
						'-e',
						"const orphan = require('node:child_process').spawn(process.execPath," +
							"['-e','setTimeout(() => {}, 30_000)'],{ detached: true, stdio: 'inherit' });" +
							'orphan.unref();' +
							"require('node:fs').writeFileSync(process.argv[1], String(orphan.pid));" +
							'process.exit(0)',
						orphanPid,
					],
				},
			}),
		);
		const harness = createFileBackedHarness();
		const leaseId = await harness.acquire('issue-112');

		harness.handlers.release_device({ leaseId });
		await harness.settle();

		try {
			// The ordinary shape of a teardown: `nohup … &`, `docker compose up -d`, a helper
			// restarted rather than only stopped. The hook exited 0 and it succeeded — so the
			// restorer's ten seconds must not be spent, and nothing may be reported as a hang.
			// This test cannot pass by waiting: the restorer's bound outlasts the suite's own.
			expect(harness.warnings).toEqual([]);
			expect(harness.performed).toEqual([
				`stopApp ${CHECKOUT}`,
				'setAirplaneMode false',
				'setWifiEnabled true',
			]);
		} finally {
			const pid = await readFile(orphanPid, 'utf8').catch(() => null);
			if (pid !== null) {
				try {
					process.kill(Number(pid), 'SIGKILL');
				} catch {
					// Already gone, which is the outcome this wanted either way.
				}
			}
		}
	});

	it('lets the hook run out its own budget before the restorer runs out of patience', async () => {
		await writeHookFile(
			JSON.stringify({
				project: HOOK_PROJECT,
				apps: [CHECKOUT],
				teardown: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] },
			}),
		);
		// The resolver's own seam, shortened the way `teardownTimeoutMs` is above. The restorer
		// keeps its real ten seconds here deliberately: which of the two bounds fires is the
		// thing under test, and it has to be the one that can actually end the process.
		const harness = createFileBackedHarness(25);
		const leaseId = await harness.acquire('issue-112');

		harness.handlers.release_device({ leaseId });
		await harness.settle();

		expect(harness.warnings).toHaveLength(1);
		expect(harness.warnings[0]).toContain('25ms budget');
		// Not the restorer giving up: that bound is on the *wait* and leaves the program running
		// against a device already handed on. A hook past its budget is a killed hook.
		expect(harness.warnings[0]).not.toContain('did not finish within');
		await expect(harness.acquire('pr-127-review')).resolves.toBeTruthy();
	});
});
