/**
 * The four commands against a real daemon on a real socket.
 *
 * The daemon suite's real-socket exception applies (ai/TESTING.md) — never
 * `~/.rover/rover.sock`, and every daemon closed through its own handle in `afterEach`.
 *
 * `ROVER_SOCKET_PATH` is what points the CLI at the temp socket, which is why no `--socket`
 * flag exists: `resolveSocketPath()` already reads that variable, and the commands go
 * through `connectToLocalDaemon()` unmodified. The backend goes in through
 * `registerDeviceBackend()` rather than being injected past it, so `list` reaches a backend
 * nobody in `src/cli/` named.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	_resetDeviceBackendRegistryForTesting,
	registerDeviceBackend,
} from '@/backends/registry.js';
import { EXIT_FAILED, EXIT_OK, run } from '@/cli/index.js';
import type { DeviceBackend, DeviceWatch, DeviceWatcher } from '@/core/device.js';
import { parseDeviceSerial } from '@/core/ids.js';
import { type RunningDaemon, startDaemon } from '@/daemon/listen.js';
import {
	createTempSocket,
	removeTempSocket,
	type TempSocket,
} from '../../helpers/daemon-socket.js';
import { createMockDevice, createMockDeviceBackend } from '../../helpers/factories.js';

const attached = createMockDevice({ serial: parseDeviceSerial('attached-1') });

let temp: TempSocket;
const running: RunningDaemon[] = [];
let logged: string[];
let errored: string[];

/** Registers a backend reporting one attached device, optionally with no view of it. */
function registerFakeBackend(options: { interrupted?: boolean } = {}): void {
	const watchDevices = vi.fn<DeviceBackend['watchDevices']>((watcher: DeviceWatcher) => {
		watcher.onDevices([attached]);
		if (options.interrupted === true) {
			watcher.onInterrupted('the test asked for a host that cannot see');
		}
		return { stop: vi.fn<DeviceWatch['stop']>(async () => {}) };
	});
	registerDeviceBackend({
		manifest: {
			platform: 'test-platform',
			label: 'Test',
			capabilities: { canReadScreen: true, canInput: true, canControlNetwork: true },
		},
		backend: createMockDeviceBackend({
			watchDevices,
			describeDevice: async (serial) => createMockDevice({ serial }),
		}),
	});
}

async function start(): Promise<void> {
	const result = await startDaemon({ socketPath: temp.socketPath });
	if (!result.started) {
		throw new Error('Another daemon holds the temp socket — the test cannot proceed');
	}
	running.push(result);
}

beforeEach(async () => {
	temp = await createTempSocket();
	vi.stubEnv('ROVER_SOCKET_PATH', temp.socketPath);
	logged = [];
	errored = [];
	vi.spyOn(console, 'log').mockImplementation((line: string) => logged.push(line));
	vi.spyOn(console, 'warn').mockImplementation((line: string) => errored.push(line));
	vi.spyOn(console, 'error').mockImplementation((line: string) => errored.push(line));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(running.splice(0).map((daemon) => daemon.close()));
	_resetDeviceBackendRegistryForTesting();
	await removeTempSocket(temp);
});

/** The lease id out of a `--json` acquire, which is the only place a client is given one. */
function grantedLeaseId(document: string): string {
	const parsed: unknown = JSON.parse(document);
	const lease = (parsed as { lease?: { leaseId?: string } }).lease;
	if (lease?.leaseId === undefined) {
		throw new Error(`No granted lease in: ${document}`);
	}
	return lease.leaseId;
}

describe('rover status, over the socket', () => {
	it('reports which host answered', async () => {
		await start();

		expect(await run(['status'])).toBe(EXIT_OK);

		// An in-process daemon, so the pid it reports is this one — what matters here is that
		// the host it names is the one the answer came from.
		expect(logged.join('\n')).toContain('host: local');
		expect(logged.join('\n')).toContain(`pid: ${process.pid}`);
	});
});

describe('rover list, over the socket', () => {
	it('names the device the host has, with nobody holding it', async () => {
		registerFakeBackend();
		await start();

		expect(await run(['list'])).toBe(EXIT_OK);

		const table = logged.join('\n');
		expect(table).toContain('attached-1');
		expect(table).toContain('free');
		expect(errored).toEqual([]);
	});

	it('writes exactly one JSON document to stdout for --json', async () => {
		registerFakeBackend();
		await start();

		expect(await run(['list', '--json'])).toBe(EXIT_OK);

		expect(logged).toHaveLength(1);
		expect(JSON.parse(logged[0] ?? '')).toMatchObject({
			host: 'local',
			stale: false,
			devices: [{ serial: 'attached-1', heldBy: null }],
		});
	});

	it('warns on stderr about a view the host cannot vouch for, in --json mode too', async () => {
		registerFakeBackend({ interrupted: true });
		await start();

		expect(await run(['list', '--json'])).toBe(EXIT_OK);

		// The document still stands alone on stdout — that is the whole point of the banner
		// going to stderr — and a human piping stdout onward is still told.
		expect(logged).toHaveLength(1);
		expect(JSON.parse(logged[0] ?? '')).toMatchObject({ stale: true });
		expect(errored.join('\n')).toContain('does not know this list to be current');
	});
});

describe('acquire, list, release', () => {
	it('grants a device, shows it as held, and hands it back', async () => {
		registerFakeBackend();
		await start();

		expect(
			await run([
				'acquire',
				'attached-1',
				'--owner',
				'issue-112',
				'--project',
				'rover',
				'--test-name',
				'checkout flow',
				'--json',
			]),
		).toBe(EXIT_OK);
		const leaseId = grantedLeaseId(logged[0] ?? '');

		logged = [];
		expect(await run(['list'])).toBe(EXIT_OK);
		expect(logged.join('\n')).toContain('issue-112 (project rover, test checkout flow)');

		logged = [];
		expect(await run(['release', leaseId])).toBe(EXIT_OK);
		expect(logged.join('\n')).toContain('Released lease');

		logged = [];
		expect(await run(['list'])).toBe(EXIT_OK);
		expect(logged.join('\n')).toContain('free');
	});

	it('exits 1 and names the holder when the device is already held', async () => {
		registerFakeBackend();
		await start();

		expect(await run(['acquire', 'attached-1', '--owner', 'issue-112', '--project', 'rover'])).toBe(
			EXIT_OK,
		);

		logged = [];
		expect(
			await run(['acquire', 'attached-1', '--owner', 'pr-127-review', '--project', 'rover']),
		).toBe(EXIT_FAILED);

		// A refusal is the host's answer, not a broken CLI — so it says who has the device and
		// for how much longer, and it goes to stderr because the operation did not succeed.
		expect(errored.join('\n')).toContain('Not granted (held)');
		expect(errored.join('\n')).toContain('Held by issue-112');
		expect(logged).toEqual([]);
	});

	it('still writes the refusal document to stdout in --json mode, and still exits 1', async () => {
		registerFakeBackend();
		await start();
		await run(['acquire', 'attached-1', '--owner', 'issue-112', '--project', 'rover']);

		logged = [];
		expect(
			await run([
				'acquire',
				'attached-1',
				'--owner',
				'pr-127-review',
				'--project',
				'rover',
				'--json',
			]),
		).toBe(EXIT_FAILED);

		expect(logged).toHaveLength(1);
		expect(JSON.parse(logged[0] ?? '')).toMatchObject({
			host: 'local',
			outcome: 'refused',
			reason: 'held',
		});
	});

	it('exits 1 for a lease id nothing is holding', async () => {
		registerFakeBackend();
		await start();

		// The store cannot tell "no such id" from "already gone", so exiting 0 here would let a
		// mistyped id read as a successful release.
		expect(await run(['release', 'no-such-lease'])).toBe(EXIT_FAILED);

		expect(errored.join('\n')).toContain("No live lease 'no-such-lease'");
	});
});
