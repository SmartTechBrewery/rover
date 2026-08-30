/**
 * `rover --host remote`, from the flag to a real host on a real port.
 *
 * The daemon suite's real-socket exception applies (ai/TESTING.md): the daemon is real, the
 * TLS listener is real, and the CLI is the shipping one — a mocked client would leave the
 * wiring this file exists to check (`--host` → `resolveHost` → `connectToHost` →
 * `connectToNetworkHost`) asserted against nothing.
 *
 * `ROVER_SOCKET_PATH` is stubbed at a temp directory nobody serves and `afterEach` fails if
 * anything turned up on it. That is not housekeeping: **a `--host remote` command must never
 * touch the local socket**, and a daemon appearing there would mean the remote arm had fallen
 * back to autostarting one (D5).
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	_resetDeviceBackendRegistryForTesting,
	registerDeviceBackend,
} from '@/backends/registry.js';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, run } from '@/cli/index.js';
import type { DeviceBackend, DeviceWatch, DeviceWatcher } from '@/core/device.js';
import { parseDeviceSerial } from '@/core/ids.js';
import { type RunningDaemon, startDaemon } from '@/daemon/listen.js';
import {
	HOST_ADDRESS_ENV_VAR,
	HOST_CA_ENV_VAR,
	HOST_PORT_ENV_VAR,
	HOST_TOKEN_ENV_VAR,
} from '@/daemon/network-config.js';
import {
	connectWithoutStarting,
	createTempSocket,
	removeTempSocket,
	stopDaemonAt,
	type TempSocket,
} from '../../helpers/daemon-socket.js';
import { createMockDevice, createMockDeviceBackend } from '../../helpers/factories.js';
import {
	createTestCertificate,
	removeTestCertificate,
	type TestCertificate,
	UNISSUED_TOKEN,
} from '../../helpers/tls-fixtures.js';
import { createTestUserStore, type TestUserStore } from '../../helpers/user-store.js';

const attached = createMockDevice({ serial: parseDeviceSerial('attached-1') });

/** What the host's backend captures — distinctive, so "these bytes" means these bytes. */
const REMOTE_CAPTURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x2a]);

let certificate: TestCertificate;
let temp: TempSocket;
/** The host's user store and the one user in it — what the host authenticates against. */
let store: TestUserStore;
let logged: string[];
let errored: string[];
const running: RunningDaemon[] = [];

beforeAll(async () => {
	certificate = await createTestCertificate();
});

afterAll(async () => {
	await removeTestCertificate(certificate);
});

beforeEach(async () => {
	temp = await createTempSocket();
	store = await createTestUserStore(temp.dir);
	vi.stubEnv('ROVER_SOCKET_PATH', temp.socketPath);
	// Empty rather than deleted, which is both how a shell leaves a variable behind and the
	// rule the resolver states: an exported-but-blank value is not a setting. Stubbed for
	// every test so nothing here depends on what the developer happened to export.
	for (const variable of [HOST_ADDRESS_ENV_VAR, HOST_PORT_ENV_VAR, HOST_TOKEN_ENV_VAR]) {
		vi.stubEnv(variable, '');
	}
	logged = [];
	errored = [];
	vi.spyOn(console, 'log').mockImplementation((line: string) => logged.push(line));
	vi.spyOn(console, 'warn').mockImplementation((line: string) => errored.push(line));
	vi.spyOn(console, 'error').mockImplementation((line: string) => errored.push(line));
});

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await Promise.all(running.splice(0).map((daemon) => daemon.close()));
	const stray = await connectWithoutStarting(temp.socketPath);
	if (stray) {
		await stray.close();
		await stopDaemonAt(temp.socketPath);
	}
	_resetDeviceBackendRegistryForTesting();
	await removeTempSocket(temp);
	expect(stray).toBeNull();
});

function registerFakeBackend(): void {
	const watchDevices = vi.fn<DeviceBackend['watchDevices']>((watcher: DeviceWatcher) => {
		watcher.onDevices([attached]);
		return { stop: vi.fn<DeviceWatch['stop']>(async () => {}) };
	});
	registerDeviceBackend({
		manifest: {
			platform: 'test-platform',
			label: 'Test',
			capabilities: {
				canReadScreen: true,
				canInput: true,
				canControlNetwork: true,
				canRecordVideo: true,
			},
		},
		backend: createMockDeviceBackend({
			watchDevices,
			describeDevice: async (serial) => createMockDevice({ serial }),
			screenshot: async () => REMOTE_CAPTURE,
		}),
	});
}

/**
 * A host on a kernel-picked port, with the environment pointing this client at it — which is
 * the whole client-side configuration surface, exercised the way an operator would set it.
 */
async function startHostAndPointAtIt(): Promise<RunningDaemon> {
	registerFakeBackend();
	const daemon = await startDaemon({
		socketPath: temp.socketPath,
		artifactsRoot: temp.artifactsRoot,
		projectsRoot: temp.projectsRoot,
		network: {
			address: '127.0.0.1',
			port: 0,
			certPath: certificate.certPath,
			keyPath: certificate.keyPath,
			usersPath: store.path,
		},
	});
	if (!daemon.started || daemon.networkPort === null) {
		throw new Error('The daemon did not come up with a network listener');
	}
	running.push(daemon);

	vi.stubEnv(HOST_ADDRESS_ENV_VAR, '127.0.0.1');
	vi.stubEnv(HOST_PORT_ENV_VAR, String(daemon.networkPort));
	// The token this client presents is the one `rover users add` issued on the host side.
	vi.stubEnv(HOST_TOKEN_ENV_VAR, store.token);
	vi.stubEnv(HOST_CA_ENV_VAR, certificate.certPath);
	return daemon;
}

describe('rover --host remote, before it talks to anything', () => {
	it('exits 2 with the command’s usage when nothing configures a remote host', async () => {
		expect(await run(['list', '--host', 'remote'])).toBe(EXIT_USAGE);

		const said = errored.join('\n');
		// A caller error, not a failed operation: no host was asked anything, so this is the
		// same answer a missing --owner gets, with the same next step attached.
		expect(said).toContain(HOST_ADDRESS_ENV_VAR);
		expect(said).toContain('Usage: rover list');
		expect(logged).toEqual([]);
	});

	it('exits 2 naming every missing variable when the configuration is half there', async () => {
		vi.stubEnv(HOST_ADDRESS_ENV_VAR, '127.0.0.1');

		expect(await run(['status', '--host', 'remote'])).toBe(EXIT_USAGE);

		// One pass, not three: an operator who set the address and neither of the rest is told
		// about both rather than being sent round the loop again.
		const said = errored.join('\n');
		expect(said).toContain(HOST_PORT_ENV_VAR);
		expect(said).toContain(HOST_TOKEN_ENV_VAR);
	});

	it('still exits 2 for a host that is neither local nor remote', async () => {
		expect(await run(['list', '--host', 'bogus'])).toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain("Unknown host 'bogus'");
	});

	it('exits 1, naming the address and the port, when nothing is listening', async () => {
		// The D5 line as the CLI shows it: a refused connection is a refused connection, and
		// never an empty device list. This one *is* a failed operation — exit 1, not 2.
		vi.stubEnv(HOST_ADDRESS_ENV_VAR, '127.0.0.1');
		// Port 1 needs no free-port dance: it is privileged, so nothing this suite could
		// collide with is ever listening on it.
		vi.stubEnv(HOST_PORT_ENV_VAR, '1');
		vi.stubEnv(HOST_TOKEN_ENV_VAR, UNISSUED_TOKEN);

		expect(await run(['list', '--host', 'remote'])).toBe(EXIT_FAILED);

		expect(errored.join('\n')).toContain('127.0.0.1:1');
		expect(logged).toEqual([]);
	});
});

describe('rover --host remote, against a live host', () => {
	it('lists the devices attached to it', async () => {
		await startHostAndPointAtIt();

		expect(await run(['list', '--host', 'remote'])).toBe(EXIT_OK);

		expect(logged.join('\n')).toContain(attached.serial);
	});

	it('answers status from the host, not from this process', async () => {
		await startHostAndPointAtIt();

		expect(await run(['status', '--host', 'remote'])).toBe(EXIT_OK);

		expect(logged.join('\n')).toContain('host: remote');
	});

	it('acquires and releases a lease over the network', async () => {
		await startHostAndPointAtIt();

		expect(
			await run([
				'acquire',
				attached.serial,
				'--host',
				'remote',
				'--owner',
				'issue-62',
				'--project',
				'rover',
				'--json',
			]),
		).toBe(EXIT_OK);
		const acquired = JSON.parse(logged[0] ?? '') as { lease: { leaseId: string } };
		logged.length = 0;

		expect(await run(['release', acquired.lease.leaseId, '--host', 'remote'])).toBe(EXIT_OK);
		// The owner is the caller's string, carried across the network and back — never the
		// token, which authenticated and attributed nothing (D20).
		expect(acquired).toMatchObject({ lease: { owner: 'issue-62' } });
	});

	it('writes a screenshot to this machine, through the same module the local host uses', async () => {
		// Criterion 5 of #24, asserted end to end rather than by inspection: `--host remote` and
		// `--host local` reach `src/cli/_shared/artifact.ts` by the same route and neither the
		// module nor either command branches on which. What proves it is not that the code has
		// no `if` in it — it is that the bytes land on *this* disk, at a path resolved here,
		// when the verb ran on a host reached over TLS.
		await startHostAndPointAtIt();
		const out = join(temp.dir, 'remote-capture.bin');

		expect(
			await run([
				'acquire',
				attached.serial,
				'--host',
				'remote',
				'--owner',
				'issue-24',
				'--project',
				'rover',
				'--json',
			]),
		).toBe(EXIT_OK);
		const leaseId = (JSON.parse(logged[0] ?? '') as { lease: { leaseId: string } }).lease.leaseId;
		logged.length = 0;

		expect(await run(['screenshot', leaseId, '--host', 'remote', '--out', out])).toBe(EXIT_OK);

		// The backend across the wire produced these; they arrived base64 and were decoded here.
		expect(new Uint8Array(await readFile(out))).toEqual(REMOTE_CAPTURE);
		// A path on the client's own disk, absolute, and never one belonging to the host.
		expect(logged.join('\n')).toContain(resolve(out));
		expect(errored).toEqual([]);
	});

	it('names the host in the --json document and never the token', async () => {
		await startHostAndPointAtIt();

		expect(await run(['list', '--host', 'remote', '--json'])).toBe(EXIT_OK);

		const document = logged.join('\n');
		expect(JSON.parse(document)).toMatchObject({ host: 'remote' });
		// The whole document, not one field: the token has no business anywhere in a machine
		// -readable answer, and a deep scan is what keeps that true as fields are added.
		expect(document).not.toContain(store.token);
		expect(errored.join('\n')).not.toContain(store.token);
	});

	it('exits 1 with a rejected-token message when the host does not accept ours', async () => {
		await startHostAndPointAtIt();
		vi.stubEnv(HOST_TOKEN_ENV_VAR, UNISSUED_TOKEN);

		expect(await run(['list', '--host', 'remote'])).toBe(EXIT_FAILED);

		const said = errored.join('\n');
		expect(said).toContain(HOST_TOKEN_ENV_VAR);
		expect(said).not.toContain(UNISSUED_TOKEN);
		// Never an empty list dressed up as an answer.
		expect(logged).toEqual([]);
	});
});
