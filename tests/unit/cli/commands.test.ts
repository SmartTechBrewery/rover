/**
 * The commands against a real daemon on a real socket.
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

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	_resetDeviceBackendRegistryForTesting,
	registerDeviceBackend,
} from '@/backends/registry.js';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, run } from '@/cli/index.js';
import type { DeviceBackend, DeviceWatch, DeviceWatcher } from '@/core/device.js';
import { parseDeviceSerial } from '@/core/ids.js';
import { type RunningDaemon, startDaemon } from '@/daemon/listen.js';
import { PROJECT_FILE_ENV_VAR } from '@/daemon/project-hooks.js';
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
		}),
	});
}

async function start(): Promise<void> {
	const result = await startDaemon({
		socketPath: temp.socketPath,
		artifactsRoot: temp.artifactsRoot,
		projectsRoot: temp.projectsRoot,
	});
	if (!result.started) {
		throw new Error('Another daemon holds the temp socket — the test cannot proceed');
	}
	running.push(result);
}

beforeEach(async () => {
	temp = await createTempSocket();
	vi.stubEnv('ROVER_SOCKET_PATH', temp.socketPath);
	// Stubbed empty for every test so a developer's own exported hook file cannot decide what
	// a lease taken in here is attributed to.
	vi.stubEnv(PROJECT_FILE_ENV_VAR, '');
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

	it('takes --project from the configured hook file, and says where it came from', async () => {
		registerFakeBackend();
		await start();
		const path = join(temp.dir, 'checkout-web.json');
		await writeFile(path, JSON.stringify({ project: 'checkout-web' }), 'utf8');
		vi.stubEnv(PROJECT_FILE_ENV_VAR, path);

		expect(
			await run(['acquire', 'attached-1', '--owner', 'issue-112', '--test-name', 'checkout flow']),
		).toBe(EXIT_OK);

		// The lease is attributed to the file's identifier — and the grant says so, because a
		// caller who never typed a project would otherwise have to guess what it names.
		expect(logged.join('\n')).toContain('project checkout-web');
		expect(logged.join('\n')).toContain(path);
		logged = [];
		expect(await run(['list'])).toBe(EXIT_OK);
		expect(logged.join('\n')).toContain('issue-112 (project checkout-web, test checkout flow)');
	});

	it('lets --project override the file, and then says nothing about the file', async () => {
		registerFakeBackend();
		await start();
		const path = join(temp.dir, 'checkout-web.json');
		await writeFile(path, JSON.stringify({ project: 'checkout-web' }), 'utf8');
		vi.stubEnv(PROJECT_FILE_ENV_VAR, path);

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
			]),
		).toBe(EXIT_OK);

		expect(logged.join('\n')).toContain('project rover');
		expect(logged.join('\n')).not.toContain(path);
	});

	it('keeps the --json document the host’s answer, with no key about this machine in it', async () => {
		registerFakeBackend();
		await start();
		const path = join(temp.dir, 'checkout-web.json');
		await writeFile(path, JSON.stringify({ project: 'checkout-web' }), 'utf8');
		vi.stubEnv(PROJECT_FILE_ENV_VAR, path);

		expect(
			await run([
				'acquire',
				'attached-1',
				'--owner',
				'issue-112',
				'--json',
				'--test-name',
				'checkout flow',
			]),
		).toBe(EXIT_OK);

		// The wire is untouched by any of this: the grant carries `project` as the plain string
		// it always was, and where this client read it is not part of what a script parses.
		expect(JSON.parse(logged[0] ?? '')).toMatchObject({
			host: 'local',
			lease: { owner: 'issue-112', project: 'checkout-web' },
		});
		expect(logged.join('\n')).not.toContain(path);
	});

	/*
	 * The optional string, end to end (D22, as amended #148): typed on the command line, carried on
	 * the wire, echoed on the grant's own line, and in `--json`. It is deliberately **not** in
	 * `rover list`'s `HELD BY` column — that cell is measured, and the reason is in
	 * `src/cli/_shared/output.ts` — so the listing below asserts the summary is unchanged while the
	 * `--json` document carries it.
	 */
	it('carries --test-description to the host, shows it on the grant, and keeps it out of the table', async () => {
		registerFakeBackend();
		await start();
		const description = 'Checks the checkout flow survives the second app bar row.';

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
				'--test-description',
				description,
			]),
		).toBe(EXIT_OK);

		expect(logged.join('\n')).toContain(`Description: ${description}`);

		logged = [];
		expect(await run(['list'])).toBe(EXIT_OK);
		expect(logged.join('\n')).toContain('issue-112 (project rover, test checkout flow)');
		expect(logged.join('\n')).not.toContain(description);

		logged = [];
		expect(await run(['list', '--json'])).toBe(EXIT_OK);
		expect(JSON.parse(logged[0] ?? '')).toMatchObject({
			devices: [{ heldBy: { testDescription: description } }],
		});
	});

	// No flag, no key, no line — nothing here invents one for a caller who said nothing.
	it('carries no description at all when the flag is not typed', async () => {
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

		expect(logged[0] ?? '').not.toContain('testDescription');
	});

	it('exits 1 and names the holder when the device is already held', async () => {
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
			]),
		).toBe(EXIT_OK);

		logged = [];
		expect(
			await run([
				'acquire',
				'attached-1',
				'--owner',
				'pr-127-review',
				'--project',
				'rover',
				'--test-name',
				'checkout flow',
			]),
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
		await run([
			'acquire',
			'attached-1',
			'--owner',
			'issue-112',
			'--project',
			'rover',
			'--test-name',
			'checkout flow',
		]);

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
				'--test-name',
				'checkout flow',
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

describe('rover force-release, over the socket', () => {
	it('ends a lease it never took, naming the device rather than a credential', async () => {
		registerFakeBackend();
		await start();
		expect(
			await run([
				'acquire',
				'attached-1',
				'--owner',
				'stuck-agent',
				'--project',
				'rover',
				'--test-name',
				'checkout flow',
			]),
		).toBe(EXIT_OK);

		logged = [];
		// No lease id anywhere in the invocation: this caller was never handed one, which is the
		// whole reason the row is keyed on the serial (D20, D28).
		expect(await run(['force-release', 'attached-1', '--actor', 'karolina'])).toBe(EXIT_OK);

		expect(logged.join('\n')).toContain('Force-released the lease');
		expect(logged.join('\n')).toContain('stuck-agent');

		logged = [];
		expect(await run(['list'])).toBe(EXIT_OK);
		expect(logged.join('\n')).toContain('free');
	});

	it('exits 1 and says not-held for a device nobody is holding', async () => {
		registerFakeBackend();
		await start();

		expect(await run(['force-release', 'attached-1', '--actor', 'karolina'])).toBe(EXIT_FAILED);

		// A refusal is the host's answer, so it goes to stderr and names which "nothing to do"
		// this is — the operator's next move differs between the three.
		expect(errored.join('\n')).toContain('Nothing force-released (not-held)');
		expect(logged).toEqual([]);
	});

	it('writes the refusal document to stdout in --json mode, and still exits 1', async () => {
		registerFakeBackend();
		await start();

		expect(await run(['force-release', 'attached-1', '--actor', 'karolina', '--json'])).toBe(
			EXIT_FAILED,
		);

		expect(logged).toHaveLength(1);
		expect(JSON.parse(logged[0] ?? '')).toMatchObject({
			host: 'local',
			outcome: 'refused',
			reason: 'not-held',
		});
	});

	it('never puts the ended lease’s id in the answer', async () => {
		registerFakeBackend();
		await start();
		expect(
			await run([
				'acquire',
				'attached-1',
				'--owner',
				'stuck-agent',
				'--project',
				'rover',
				'--json',
				'--test-name',
				'checkout flow',
			]),
		).toBe(EXIT_OK);
		const leaseId = grantedLeaseId(logged[0] ?? '');

		logged = [];
		expect(await run(['force-release', 'attached-1', '--actor', 'karolina', '--json'])).toBe(
			EXIT_OK,
		);

		// The host's own answer, straight out of the socket: force-releasing a device must not be
		// a way to come by the credential for the next one.
		expect(logged.join('\n')).not.toContain(leaseId);
		expect(logged.join('\n')).not.toContain('leaseId');
	});
});

describe('rover archive, over the socket', () => {
	/** One project with one named check under it, which is two levels of the tree (§10). */
	async function archiveOneRun(): Promise<void> {
		await mkdir(join(temp.artifactsRoot, 'checkout-app', 'login-flow'), { recursive: true });
	}

	it('says the archive is empty rather than printing an empty table', async () => {
		await mkdir(temp.artifactsRoot, { recursive: true });
		await start();

		expect(await run(['archive'])).toBe(EXIT_OK);

		// Empty is a success: nothing is filed yet, and the host said so.
		expect(logged.join('\n')).toContain('Nothing is filed under the top of the archive');
		expect(errored).toEqual([]);
	});

	it('names each entry and what one look at it can say', async () => {
		await archiveOneRun();
		await start();

		expect(await run(['archive'])).toBe(EXIT_OK);

		const table = logged.join('\n');
		expect(table).toContain('checkout-app');
		expect(table).toContain('directory');
		expect(table).toContain('1 entry (login-flow)');
	});

	it('takes the components a previous listing named, one level at a time', async () => {
		await archiveOneRun();
		await start();

		expect(await run(['archive', 'checkout-app'])).toBe(EXIT_OK);

		expect(logged.join('\n')).toContain('login-flow');
		// No path on the answer and none in the output — the host's layout is not the caller's
		// to know (D19).
		expect(logged.join('\n')).not.toContain(temp.artifactsRoot);
	});

	it('writes one document in --json mode, carrying the outcome and the host', async () => {
		await archiveOneRun();
		await start();

		expect(await run(['archive', '--json'])).toBe(EXIT_OK);

		expect(logged).toHaveLength(1);
		expect(JSON.parse(logged[0] ?? '')).toMatchObject({ host: 'local', outcome: 'listed' });
	});

	it('exits 1 for a level that is not there, on stderr', async () => {
		await archiveOneRun();
		await start();

		expect(await run(['archive', 'no-such-project'])).toBe(EXIT_FAILED);

		expect(errored.join('\n')).toContain('Nothing is at no-such-project');
		expect(logged).toEqual([]);
	});

	it('refuses .. as a component with exit 2, before any host is asked', async () => {
		// No daemon started, deliberately: a request that got as far as connecting would have
		// autostarted one and come back with the host's answer at exit 1.
		expect(await run(['archive', '..'])).toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain('is not an archive path component');
		expect(errored.join('\n')).toContain('rover archive —');
		expect(logged).toEqual([]);
	});

	it('passes a component that is only whitespace to the host, which is the rule that governs', async () => {
		// `ArchivePathSegmentSchema` accepts `' '` on purpose — it is a legal directory name, and a
		// name the host answered with has to be addressable on the next request. So this command
		// refuses the *empty* argument and nothing more: a second, stricter local rule would make
		// such a directory un-listable through the CLI and is exactly the drift `componentsOf`
		// imports the schema to avoid.
		await archiveOneRun();
		await start();

		expect(await run(['archive', ' '])).toBe(EXIT_FAILED);

		expect(errored.join('\n')).not.toContain('blank argument');
		expect(errored.join('\n')).toContain('Nothing is at');
	});

	it('still refuses an empty argument with exit 2', async () => {
		expect(await run(['archive', ''])).toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain('blank argument');
		expect(logged).toEqual([]);
	});
});
