/**
 * The three transfer verbs over a backend that records what it was asked to move.
 *
 * What a correct-looking result cannot show, and what is therefore asserted here: **which
 * path went which way** — a host path to the two verbs that send, a device path to all
 * three, and never the two swapped; **order** — the transfer happens before the after-state
 * is captured, because a post-state read first would describe the device before the thing
 * that changed it; and **that nothing on the way out is a place on this host** (D19), which
 * is the one property of `pull_file` a passing round trip would still let through.
 */

import { describe, expect, it, vi } from 'vitest';
import type { DeviceBackend } from '@/core/device.js';
import { FileTooLargeError } from '@/core/errors.js';
import { HOOK_COMMAND_TIMEOUT_MS } from '@/daemon/hook-command.js';
import { LEASE_TTL_MS } from '@/daemon/leases.js';
import { SETTLE_TIMEOUT_MS } from '@/daemon/restore.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '@/ipc/client.js';
import { MAX_TRANSFER_BYTES, MAX_VERB_TIMEOUT_MS } from '@/ipc/verb-methods.js';
import { ArtifactTooLargeError, ProjectNotRegisteredError } from '@/verbs/errors.js';
import {
	INSTALL_HOOK_TIMEOUT_MS,
	installApp,
	installProjectApp,
	pullFile,
	pushFile,
} from '@/verbs/files.js';
import { ActionResultSchema, MAX_ARTIFACT_BYTES } from '@/verbs/result.js';
import {
	createMockCapabilities,
	createMockCapabilityManifest,
	createMockDeviceBackend,
	createMockDeviceInfo,
	createMockScreenElement,
	createMockVerbContext,
} from '../../helpers/factories.js';

const save = createMockScreenElement({ id: 'save', text: 'Save' });

/** A payload that is neither empty nor uniform, so a byte lost or reordered fails a compare. */
const CONTENT = Uint8Array.from([0x00, 0x01, 0xfe, 0xff, 0x7f, 0x80, 0x0a, 0x0d]);

const HOST_PATH = '/tmp/rover-transfer-abc123/payload';
const DEVICE_PATH = '/data/local/tmp/rover-probe.bin';

interface Recording {
	readonly calls: string[];
	readonly pushes: Array<{ hostPath: string; devicePath: string }>;
	readonly installs: string[];
	readonly pulls: Array<{ devicePath: string; maxBytes: number }>;
	readonly context: ReturnType<typeof createMockVerbContext>;
}

/** A context whose backend records every call on one shared log, in order. */
function recording(overrides: Partial<DeviceBackend> = {}): Recording {
	const calls: string[] = [];
	const pushes: Array<{ hostPath: string; devicePath: string }> = [];
	const installs: string[] = [];
	const pulls: Array<{ devicePath: string; maxBytes: number }> = [];

	const backend = createMockDeviceBackend({
		installApp: vi.fn<DeviceBackend['installApp']>(async (_serial, packagePath) => {
			calls.push('installApp');
			installs.push(packagePath);
		}),
		pushFile: vi.fn<DeviceBackend['pushFile']>(async (_serial, hostPath, devicePath) => {
			calls.push('pushFile');
			pushes.push({ hostPath, devicePath });
		}),
		pullFile: vi.fn<DeviceBackend['pullFile']>(async (_serial, devicePath, options) => {
			calls.push('pullFile');
			pulls.push({ devicePath, maxBytes: options.maxBytes });
			return CONTENT;
		}),
		readScreen: vi.fn<NonNullable<DeviceBackend['readScreen']>>(async () => {
			calls.push('readScreen');
			return [save];
		}),
		deviceInfo: vi.fn<DeviceBackend['deviceInfo']>(async (serial) => {
			calls.push('deviceInfo');
			return createMockDeviceInfo({ serial });
		}),
		...overrides,
	});

	return { calls, pushes, installs, pulls, context: createMockVerbContext({ backend }) };
}

describe('install_app', () => {
	it('installs the package on the host path it was handed, and answers like every verb', async () => {
		const { context, installs } = recording();

		const result = await installApp(context, HOST_PATH);

		expect(installs).toEqual([HOST_PATH]);
		expect(result).toMatchObject({
			verb: 'install_app',
			// A package addresses no element, so no screen was read to resolve one — `null` is a
			// fact about the verb rather than a resolution that failed (D12(a)).
			target: null,
			device: { serial: context.serial },
			after: { kind: 'screen' },
			// The bytes went *in*. Nothing came back, so there is nothing to attach.
			artifact: null,
		});
		expect(() => ActionResultSchema.parse(result)).not.toThrow();
	});

	it('installs before it reports what the device looks like afterwards', async () => {
		const { context, calls } = recording();

		await installApp(context, HOST_PATH);

		// The after-state has to be after the action (D12(c)); a read first would describe the
		// device without the package on it and label it the result of installing one.
		expect(calls).toEqual(['installApp', 'readScreen', 'deviceInfo']);
	});

	it('needs no capability, so a backend declaring none still installs', async () => {
		const { context, installs } = recording();

		// `installApp` is a required interface method — a `canInstallApps` flag would be one
		// that is always true, which is the noise the capability model warns against. So a
		// backend that declares nothing at all still installs; what it cannot do is *report*
		// the screen afterwards, and it says so by name instead of answering with an empty one.
		const result = await installApp(
			createMockVerbContext({
				backend: context.backend,
				manifest: createMockCapabilityManifest({
					capabilities: createMockCapabilities({
						canReadScreen: false,
						canInput: false,
						canControlNetwork: false,
					}),
				}),
			}),
			HOST_PATH,
		);

		expect(installs).toEqual([HOST_PATH]);
		expect(result).toMatchObject({
			verb: 'install_app',
			after: { kind: 'unavailable', capability: 'canReadScreen' },
		});
	});
});

/**
 * The second way into the same verb: no bytes from the caller, and the host runs what *the
 * project* declared installing to be (D13/R17). What is asserted here is that it is the same
 * verb — same name, same spine, same after-state — and that the seam is handed the device the
 * verb is running against rather than one of its own choosing.
 */
describe('install_app for the project’s own application', () => {
	it('runs the project’s install and answers like every other verb', async () => {
		const { context, calls } = recording();
		const installed: string[] = [];

		const result = await installProjectApp(context, async (serial) => {
			calls.push('projectInstall');
			installed.push(serial);
		});

		// The lease's device, handed down rather than resolved a second time further in: an
		// install landing on a neighbour's device looks like success from both sides.
		expect(installed).toEqual([context.serial]);
		expect(result).toMatchObject({
			verb: 'install_app',
			target: null,
			device: { serial: context.serial },
			after: { kind: 'screen' },
			artifact: null,
		});
		expect(() => ActionResultSchema.parse(result)).not.toThrow();
		// One `performAction`, in the order D12(c) requires: the install, then the state after it.
		expect(calls).toEqual(['projectInstall', 'readScreen', 'deviceInfo']);
	});

	it('never asks the backend to install anything of its own', async () => {
		const { context, installs } = recording();

		await installProjectApp(context, async () => {});

		// The host ran the project's command; there were no caller bytes and so no package path.
		// A backend call here would be this verb inventing a second install.
		expect(installs).toEqual([]);
	});

	it('carries no host path in its answer, whatever the command was', async () => {
		const { context } = recording();

		const result = await installProjectApp(context, async () => {});

		// The command, its arguments and where it ran are host-side configuration. The only
		// place any of it surfaces is a named failure; an `ok` answer says what happened to the
		// device and nothing about this machine (D19).
		expect(JSON.stringify(result)).not.toContain('/tmp/');
		expect(JSON.stringify(result)).not.toContain(HOST_PATH);
	});

	it('lets the three named failures out rather than swallowing them into a result', async () => {
		const { context, calls } = recording();

		const thrown = await installProjectApp(context, async (serial) => {
			throw new ProjectNotRegisteredError(serial, 'checkout-web');
		}).catch((error: unknown) => error);

		// A refusal from the host's own configuration is an answer the agent acts on, and it
		// must not arrive as an `ok` naming the device — which would report an install that
		// never happened.
		expect(thrown).toBeInstanceOf(ProjectNotRegisteredError);
		expect(calls).toEqual([]);
	});
});

describe('push_file', () => {
	it('sends the host file to the device path, in that order', async () => {
		const { context, pushes, calls } = recording();

		const result = await pushFile(context, HOST_PATH, DEVICE_PATH);

		// The one assertion the argument order exists for: a host path and a device path are
		// both strings, and swapping them is a bug nothing else in this stack would catch.
		expect(pushes).toEqual([{ hostPath: HOST_PATH, devicePath: DEVICE_PATH }]);
		expect(calls).toEqual(['pushFile', 'readScreen', 'deviceInfo']);
		expect(result).toMatchObject({ verb: 'push_file', target: null, artifact: null });
	});

	it('lets a device that refused the write surface as a failure rather than a silent success', async () => {
		const { context } = recording({
			pushFile: vi.fn<DeviceBackend['pushFile']>(async () => {
				throw new Error('remote couldn’t create file: Read-only file system');
			}),
		});

		await expect(pushFile(context, HOST_PATH, '/system/nope')).rejects.toThrow(/Read-only/);
	});
});

describe('pull_file', () => {
	it('answers with the bytes of the device path, base64 on the artifact', async () => {
		const { context, pulls } = recording();

		const result = await pullFile(context, DEVICE_PATH);

		expect(pulls.map((pull) => pull.devicePath)).toEqual([DEVICE_PATH]);
		expect(result).toMatchObject({
			verb: 'pull_file',
			target: null,
			device: { serial: context.serial },
			artifact: {
				base64: Buffer.from(CONTENT).toString('base64'),
				byteLength: CONTENT.byteLength,
			},
		});
		// Byte for byte, through the encoding the wire actually carries.
		const artifact = result.artifact;
		if (!artifact) throw new Error('the assertion above should have caught this');
		expect(Uint8Array.from(Buffer.from(artifact.base64, 'base64'))).toEqual(CONTENT);
	});

	it('carries no path of any kind in its answer (D19)', async () => {
		const { context } = recording();

		const result = await pullFile(context, DEVICE_PATH);

		// Not the host path the backend staged through, and not the device path either: the
		// answer is bytes, and the first thing a string that looks like a path is read as is a
		// place a file already is. `tests/unit/verbs/serializable.test.ts` walks the whole graph;
		// this pins the one verb that had somewhere to put one.
		expect(JSON.stringify(result)).not.toContain(DEVICE_PATH);
		expect(JSON.stringify(result)).not.toContain('/tmp/');
	});

	it('reads the device before it reports what the device looks like afterwards', async () => {
		const { context, calls } = recording();

		await pullFile(context, DEVICE_PATH);

		expect(calls).toEqual(['pullFile', 'readScreen', 'deviceInfo']);
	});

	it('refuses a file too large for one answer by name, rather than cutting it to fit', async () => {
		const { context, calls } = recording({
			pullFile: vi.fn<DeviceBackend['pullFile']>(
				async () => new Uint8Array(MAX_ARTIFACT_BYTES + 1),
			),
		});

		const failure = pullFile(context, DEVICE_PATH).catch((error: unknown) => error);

		// A truncated file is not distinguishable from a whole one, which is the whole reason
		// this is an error class and not a `slice` (R24).
		await expect(failure).resolves.toBeInstanceOf(ArtifactTooLargeError);
		// Refused where the bytes arrived, so no screen read was spent reaching it.
		expect(calls).toEqual([]);
	});

	/**
	 * The bound goes **down**, not on the way back. A backend that is only told afterwards has
	 * already copied the file onto this host and read it into the daemon's heap — a refusal
	 * that cost exactly what it was for, in the one process holding every lease on the machine
	 * (D6, D17). This is the assertion that stops it regressing to a post-hoc check.
	 */
	it('tells the backend what the answer may carry, before the backend fetches anything', async () => {
		const { context, pulls } = recording();

		await pullFile(context, DEVICE_PATH);

		expect(pulls).toEqual([{ devicePath: DEVICE_PATH, maxBytes: MAX_ARTIFACT_BYTES }]);
	});

	/**
	 * And what the backend refuses arrives as the vocabulary the agent already knows. The two
	 * ends of the transfer notice the same fact — this does not fit one answer — and it would
	 * be a worse protocol for having two names for it depending on which end noticed.
	 */
	it('turns the backend’s refusal into the same named artifact-too-large answer', async () => {
		const { context, calls } = recording({
			pullFile: vi.fn<DeviceBackend['pullFile']>(async (serial, devicePath, options) => {
				throw new FileTooLargeError(serial, devicePath, options.maxBytes + 1, options.maxBytes);
			}),
		});

		const failure = await pullFile(context, DEVICE_PATH).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(ArtifactTooLargeError);
		expect(failure).toMatchObject({
			byteLength: MAX_ARTIFACT_BYTES + 1,
			maxBytes: MAX_ARTIFACT_BYTES,
		});
		expect(calls).toEqual([]);
	});

	it('answers for an empty file rather than treating it as nothing to answer with', async () => {
		const { context } = recording({
			pullFile: vi.fn<DeviceBackend['pullFile']>(async () => new Uint8Array()),
		});

		const result = await pullFile(context, DEVICE_PATH);

		// An empty file is a file. `artifact: null` here would say the verb produced no bytes,
		// which is a different statement about the device and the wrong one.
		expect(result.artifact).toMatchObject({ base64: '', byteLength: 0 });
	});
});

describe('the two byte bounds', () => {
	/**
	 * Both are derived from the frame cap by hand, in two different modules, and a constant
	 * derived from another constant by hand is one the other is free to drift away from.
	 * `tests/unit/ipc/protocol.test.ts` ties the inbound one to `MAX_FRAME_BYTES`; what is
	 * asserted here is that the two directions agree, so a file this host will accept is one
	 * it can also hand back.
	 */
	it('lets a pushed file come back the same way it went out', () => {
		expect(MAX_TRANSFER_BYTES).toBeLessThanOrEqual(MAX_ARTIFACT_BYTES);
	});
});

/**
 * The install hook's bound, against the two numbers it has to sit under. Both are asserted
 * rather than described, because a bound whose relationships live only in a comment is one the
 * other numbers are free to drift away from — the reasoning `MAX_RECORDING_MS` and
 * `HOOK_COMMAND_TIMEOUT_MS` are already asserted with.
 */
describe('how long a project install may take', () => {
	it('cannot outlive the lease that authorised it (D8)', () => {
		// The lease is renewed when the call *arrives*, so an install allowed to run longer than
		// the TTL could have its own lease expire underneath it — and the sweep would then fire
		// restoration on a device the install is still driving.
		expect(INSTALL_HOOK_TIMEOUT_MS).toBeLessThan(LEASE_TTL_MS);
	});

	it('stays inside the bound every other long verb call is held to', () => {
		expect(INSTALL_HOOK_TIMEOUT_MS).toBeLessThanOrEqual(MAX_VERB_TIMEOUT_MS);
	});

	it('is generous enough to be a build rather than a teardown', () => {
		// The comparison that says what this number is for: a teardown's eight seconds bound a
		// hook stopping a helper service, and a project's install compiles and pushes.
		expect(INSTALL_HOOK_TIMEOUT_MS).toBeGreaterThan(HOOK_COMMAND_TIMEOUT_MS);
	});

	it('is not also how long the device is unavailable to every other agent', () => {
		// The third relationship, and the only one that is not this caller's own: an install runs
		// inside a registered verb call, a restoration waits for those calls to unwind, and
		// `acquire_device` waits on the restoration. What keeps this number off that path is the
		// restorer's own bound, so that bound has to be a fraction of this one — and inside the
		// request timeout of the client whose grant is queued behind it, or the daemon finishes
		// waiting after the caller has already given up and grants the device to nobody.
		expect(SETTLE_TIMEOUT_MS).toBeLessThan(INSTALL_HOOK_TIMEOUT_MS);
		expect(SETTLE_TIMEOUT_MS).toBeLessThan(DEFAULT_REQUEST_TIMEOUT_MS);
	});
});
