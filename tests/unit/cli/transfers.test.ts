/**
 * The client half of the three verbs that name a file — `rover push`, `rover pull` and
 * `rover install` — against a real daemon on a real socket, moving real bytes off and onto
 * a fake device.
 *
 * The daemon suite's real-socket exception applies (ai/TESTING.md) — never
 * `~/.rover/rover.sock`, every daemon closed through its own handle in `afterEach`, and the
 * files land in the same `mkdtemp` directory the socket does, so cleanup is one `rm`.
 *
 * Two assertions in here carry the row, and neither is an exit code:
 *
 * - **The round trip is over a payload that is not text.** A UTF-8 decode anywhere in the
 *   middle of this path corrupts silently — every byte that is not valid UTF-8 becomes
 *   U+FFFD and the file still opens — so the bytes that go in are invalid UTF-8 on purpose
 *   and what comes back is compared byte for byte.
 * - **A refused source means the backend was never reached.** `expect(pushFile).not
 *   .toHaveBeenCalled()` is what says "nothing partial was sent"; an exit code alone is
 *   equally consistent with a host that took four megabytes and then said no.
 */

import { execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	_resetDeviceBackendRegistryForTesting,
	registerDeviceBackend,
} from '@/backends/registry.js';
import { UsageError } from '@/cli/_shared/flags.js';
import { readPayload, resolveSource } from '@/cli/_shared/upload.js';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, run } from '@/cli/index.js';
import type { DeviceBackend, DeviceWatch, DeviceWatcher } from '@/core/device.js';
import { FileTooLargeError } from '@/core/errors.js';
import { parseDeviceSerial } from '@/core/ids.js';
import { type RunningDaemon, startDaemon } from '@/daemon/listen.js';
import { MAX_TRANSFER_BYTES } from '@/ipc/methods.js';
import { MAX_ARTIFACT_BYTES } from '@/verbs/result.js';
import {
	createTempSocket,
	removeTempSocket,
	type TempSocket,
} from '../../helpers/daemon-socket.js';
import { createMockDevice, createMockDeviceBackend } from '../../helpers/factories.js';

const execFile = promisify(execFileCallback);

const attached = createMockDevice({ serial: parseDeviceSerial('attached-1') });

/**
 * Deliberately not text: `0xff` and `0xfe` are not valid UTF-8 in any position, and a `0x00`
 * ends a string for most of what a byte stream passes through. A round trip that decoded
 * anywhere would come back with U+FFFD where these are, at a different length, and every
 * assertion short of comparing the bytes would still pass.
 */
const BINARY_PAYLOAD = Uint8Array.from([
	0x00, 0xff, 0xfe, 0x80, 0x01, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xc0, 0x80,
]);

const DEVICE_PATH = '/data/local/tmp/payload.bin';

/** The fake device's filesystem: what a push wrote is what a pull reads back. */
let deviceFiles: Map<string, Uint8Array>;
/** What `install_app` was handed, read off the host's temp file before it is removed. */
let installed: Uint8Array[];

let temp: TempSocket;
const running: RunningDaemon[] = [];
let logged: string[];
let errored: string[];

interface FakeBackend {
	readonly pushFile: ReturnType<typeof vi.fn<DeviceBackend['pushFile']>>;
	readonly pullFile: ReturnType<typeof vi.fn<DeviceBackend['pullFile']>>;
	readonly installApp: ReturnType<typeof vi.fn<DeviceBackend['installApp']>>;
}

/**
 * A backend whose three transfer methods are real rather than empty, so a round trip through
 * the daemon proves the bytes moved rather than that two mocks were called.
 *
 * The host writes an inbound payload to a temp file of its own and deletes it in a `finally`
 * (`src/daemon/verb-handlers.ts`), so both inbound methods read that file *while they are
 * being called* — afterwards there is nothing left to read, which is the point of it.
 */
function registerFakeBackend(overrides: Partial<DeviceBackend> = {}): FakeBackend {
	const watchDevices = vi.fn<DeviceBackend['watchDevices']>((watcher: DeviceWatcher) => {
		watcher.onDevices([attached]);
		return { stop: vi.fn<DeviceWatch['stop']>(async () => {}) };
	});
	const pushFile = vi.fn<DeviceBackend['pushFile']>(async (_serial, hostPath, devicePath) => {
		deviceFiles.set(devicePath, new Uint8Array(await readFile(hostPath)));
	});
	const pullFile = vi.fn<DeviceBackend['pullFile']>(async (_serial, devicePath) => {
		const bytes = deviceFiles.get(devicePath);
		if (bytes === undefined) {
			throw new Error(`the fake device has no file at '${devicePath}'`);
		}
		return bytes;
	});
	const installApp = vi.fn<DeviceBackend['installApp']>(async (_serial, packagePath) => {
		installed.push(new Uint8Array(await readFile(packagePath)));
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
			pushFile,
			pullFile,
			installApp,
			...overrides,
		}),
	});
	return { pushFile, pullFile, installApp };
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

/** A live lease on the fake device, through the CLI, because that is the only way to get one. */
async function acquireLease(): Promise<string> {
	expect(
		await run([
			'acquire',
			attached.serial,
			'--owner',
			'issue-85',
			'--project',
			'rover',
			'--json',
			'--test-name',
			'checkout flow',
		]),
	).toBe(EXIT_OK);
	const parsed = JSON.parse(logged[0] ?? '') as { lease?: { leaseId?: string } };
	const leaseId = parsed.lease?.leaseId;
	if (leaseId === undefined) {
		throw new Error(`No granted lease in: ${logged[0] ?? ''}`);
	}
	logged = [];
	return leaseId;
}

/** A path inside the temp directory, which `afterEach` removes whole. */
function local(name: string): string {
	return path.join(temp.dir, name);
}

/** A source file on **this** machine, which is the only kind these two commands read. */
async function writeSource(name: string, bytes: Uint8Array): Promise<string> {
	const source = local(name);
	await writeFile(source, bytes);
	return source;
}

/**
 * A named pipe in the temp directory — the shape `<(gzip -c big.bin)` hands a command without
 * the caller thinking of it as one, and the one a size bound alone cannot see (PROJECT.md §6).
 *
 * Nothing ever writes to it, deliberately: a refusal that has to wait for a writer is not a
 * refusal that landed before the file was read, which is the whole property under test. Node
 * has no `mkfifo`, so this is the system's.
 */
async function makeFifo(name: string): Promise<string> {
	const fifo = local(name);
	await execFile('mkfifo', [fifo]);
	return fifo;
}

/** A suite running as root reads a `0o000` file regardless, so those two cases sit this out. */
const asRoot = process.getuid?.() === 0;

beforeEach(async () => {
	temp = await createTempSocket();
	vi.stubEnv('ROVER_SOCKET_PATH', temp.socketPath);
	deviceFiles = new Map();
	installed = [];
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

describe('rover push and rover pull, as a round trip', () => {
	it('moves a payload that is not text onto the device and back, byte for byte', async () => {
		registerFakeBackend();
		await start();
		const leaseId = await acquireLease();
		const source = await writeSource('sent.bin', BINARY_PAYLOAD);
		const destination = local('received.bin');

		expect(await run(['push', leaseId, source, DEVICE_PATH])).toBe(EXIT_OK);
		expect(await run(['pull', leaseId, DEVICE_PATH, '--out', destination])).toBe(EXIT_OK);

		// The whole row in one assertion: what left this machine is what came back to it.
		expect(new Uint8Array(await readFile(destination))).toEqual(BINARY_PAYLOAD);
		expect(errored).toEqual([]);
	});

	it('names this machine’s path in both directions and never the host’s', async () => {
		registerFakeBackend();
		await start();
		const leaseId = await acquireLease();
		const source = await writeSource('sent.bin', BINARY_PAYLOAD);
		const destination = local('received.bin');

		expect(await run(['push', leaseId, source, DEVICE_PATH])).toBe(EXIT_OK);
		expect(await run(['pull', leaseId, DEVICE_PATH, '--out', destination])).toBe(EXIT_OK);

		const said = logged.join('\n');
		expect(said).toContain(DEVICE_PATH);
		expect(said).toContain(path.resolve(destination));
		expect(said).toContain(`${BINARY_PAYLOAD.byteLength} bytes`);
		// The daemon decodes an inbound payload into a directory of its own and removes it
		// again; that path names nothing on the machine reading this output (D19).
		expect(said).not.toContain('rover-transfer-');
	});

	it('resolves a relative --out against this process, not against the host', async () => {
		registerFakeBackend();
		await start();
		const leaseId = await acquireLease();
		await run(['push', leaseId, await writeSource('sent.bin', BINARY_PAYLOAD), DEVICE_PATH]);
		const relative = path.relative(process.cwd(), local('relative.bin'));

		expect(await run(['pull', leaseId, DEVICE_PATH, '--out', relative])).toBe(EXIT_OK);

		expect(logged.join('\n')).toContain(path.resolve(relative));
		expect(existsSync(path.resolve(relative))).toBe(true);
	});
});

describe('rover push, before the host is asked', () => {
	it('refuses a source over the transfer limit, naming it, its size and the limit', async () => {
		const backend = registerFakeBackend();
		await start();
		const leaseId = await acquireLease();
		// One byte over, and sparse: the refusal is decided off `stat` rather than off a
		// buffer, so the file never has to be materialised to be refused.
		const source = await writeSource('too-large.bin', new Uint8Array(0));
		await truncate(source, MAX_TRANSFER_BYTES + 1);

		expect(await run(['push', leaseId, source, DEVICE_PATH])).toBe(EXIT_USAGE);

		const said = errored.join('\n');
		expect(said).toContain(source);
		expect(said).toContain(String(MAX_TRANSFER_BYTES + 1));
		expect(said).toContain(String(MAX_TRANSFER_BYTES));
		expect(said).toContain('Usage: rover push');
		// The assertion the row is actually about: nothing partial was sent, because nothing
		// was sent at all.
		expect(backend.pushFile).not.toHaveBeenCalled();
	});

	it('refuses a source that is not there, with this command’s usage', async () => {
		const backend = registerFakeBackend();
		await start();
		const leaseId = await acquireLease();

		expect(await run(['push', leaseId, local('nothing-here.bin'), DEVICE_PATH])).toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain('Usage: rover push');
		expect(backend.pushFile).not.toHaveBeenCalled();
	});

	it('refuses a source that is a directory, with this command’s usage', async () => {
		const backend = registerFakeBackend();
		await start();
		const leaseId = await acquireLease();
		const directory = local('a-directory');
		await mkdir(directory);

		expect(await run(['push', leaseId, directory, DEVICE_PATH])).toBe(EXIT_USAGE);

		const said = errored.join('\n');
		expect(said).toContain('is a directory');
		expect(said).toContain('Usage: rover push');
		expect(backend.pushFile).not.toHaveBeenCalled();
	});

	it('refuses a source that is a named pipe, with this command’s usage', async () => {
		const backend = registerFakeBackend();
		await start();
		const leaseId = await acquireLease();
		// A fifo stats as zero bytes, so the size cap alone waves it through and `readFile`
		// then reads whatever a writer sends — or blocks forever when there is none, as here.
		// That this call returns at all is half the assertion.
		const fifo = await makeFifo('a-pipe');

		expect(await run(['push', leaseId, fifo, DEVICE_PATH])).toBe(EXIT_USAGE);

		const said = errored.join('\n');
		expect(said).toContain('named pipe');
		expect(said).toContain('Usage: rover push');
		expect(backend.pushFile).not.toHaveBeenCalled();
	});

	it.skipIf(asRoot)('refuses a source it cannot read, with this command’s usage', async () => {
		const backend = registerFakeBackend();
		await start();
		const leaseId = await acquireLease();
		// Readable to `stat` and not to `readFile`: the one refusal that can only come from
		// `readPayload`, and it still has to land before the host is asked.
		const source = await writeSource('unreadable.bin', BINARY_PAYLOAD);
		await chmod(source, 0o000);

		expect(await run(['push', leaseId, source, DEVICE_PATH])).toBe(EXIT_USAGE);

		const said = errored.join('\n');
		expect(said).toContain(source);
		expect(said).toContain('Usage: rover push');
		expect(backend.pushFile).not.toHaveBeenCalled();
	});

	it('writes one --json document that never echoes the payload back', async () => {
		registerFakeBackend();
		await start();
		const leaseId = await acquireLease();
		const source = await writeSource('sent.bin', BINARY_PAYLOAD);

		expect(await run(['push', leaseId, source, DEVICE_PATH, '--json'])).toBe(EXIT_OK);

		expect(logged).toHaveLength(1);
		const document = logged[0] ?? '';
		expect(JSON.parse(document)).toMatchObject({
			host: 'local',
			outcome: 'ok',
			result: { verb: 'push_file', artifact: null },
		});
		// The bytes are on the device; putting several megabytes of base64 back on stdout in
		// the mode most likely to be piped into a parser would undo the transfer entirely.
		expect(document).not.toContain('base64');
	});
});

describe('rover install', () => {
	it('sends the package from this machine and never a path', async () => {
		const backend = registerFakeBackend();
		await start();
		const leaseId = await acquireLease();
		const source = await writeSource('app.apk', BINARY_PAYLOAD);

		expect(await run(['install', leaseId, source])).toBe(EXIT_OK);

		// The backend was handed a file on the *host*, holding exactly the caller's bytes.
		expect(backend.installApp).toHaveBeenCalledTimes(1);
		expect(installed[0]).toEqual(BINARY_PAYLOAD);
		// And the path it was handed is the daemon's own, so it appears nowhere in the output.
		expect(logged.join('\n')).not.toContain('rover-transfer-');
	});

	it('refuses a package over the transfer limit before the host is asked', async () => {
		const backend = registerFakeBackend();
		await start();
		const leaseId = await acquireLease();
		const source = await writeSource('too-large.apk', new Uint8Array(0));
		await truncate(source, MAX_TRANSFER_BYTES + 1);

		expect(await run(['install', leaseId, source])).toBe(EXIT_USAGE);

		const said = errored.join('\n');
		expect(said).toContain(source);
		expect(said).toContain(String(MAX_TRANSFER_BYTES + 1));
		expect(said).toContain(String(MAX_TRANSFER_BYTES));
		expect(said).toContain('Usage: rover install');
		expect(backend.installApp).not.toHaveBeenCalled();
	});

	it('writes one --json document that never echoes the package back', async () => {
		registerFakeBackend();
		await start();
		const leaseId = await acquireLease();
		const source = await writeSource('app.apk', BINARY_PAYLOAD);

		expect(await run(['install', leaseId, source, '--json'])).toBe(EXIT_OK);

		expect(logged).toHaveLength(1);
		const document = logged[0] ?? '';
		expect(JSON.parse(document)).toMatchObject({
			host: 'local',
			outcome: 'ok',
			result: { verb: 'install_app', artifact: null },
		});
		expect(document).not.toContain('base64');
	});
});

/**
 * `rover install` with no `<local-path>` — the form that runs what the lease's project
 * declared, and the one that had no client at all until #104.
 *
 * The two assertions that carry it are both about **who decides**: the hook's own marker file
 * says the host ran the project's command rather than the caller sending anything, and the
 * refusal for a project that declares no install is still the daemon's named
 * `install-hook-undeclared` at exit 1 — not a usage error this CLI invented at exit 2, which
 * would have named the wrong machine's configuration.
 */
describe('rover install with no package, which runs the project’s own install', () => {
	/** Where the hook command leaves proof of having run, and of what it was told. */
	function markerPath(): string {
		return local('install-hook-ran');
	}

	/** A hook file for the project `acquireLease` attributes its lease to. */
	async function writeHookFile(hooks: unknown): Promise<void> {
		await mkdir(temp.projectsRoot, { recursive: true });
		await writeFile(path.join(temp.projectsRoot, 'rover.json'), JSON.stringify(hooks), 'utf8');
	}

	/** A hook file whose install is a real program recording the device it was pointed at. */
	async function writeInstallingHookFile(): Promise<void> {
		await writeHookFile({
			project: 'rover',
			install: {
				command: process.execPath,
				args: [
					'-e',
					"require('node:fs').writeFileSync(process.argv[1], process.env.ROVER_DEVICE_SERIAL)",
					markerPath(),
				],
			},
		});
	}

	it('runs the host-side command, pinned to the leased device, and sends nothing', async () => {
		const backend = registerFakeBackend();
		await start();
		const leaseId = await acquireLease();
		await writeInstallingHookFile();

		expect(await run(['install', leaseId])).toBe(EXIT_OK);

		// The marker is the whole row: the project's own command ran on the host, and it was
		// told the device the lease names rather than picking one (D13).
		expect(await readFile(markerPath(), 'utf8')).toBe(attached.serial);
		// And nothing travelled: this form never reaches the backend's own package install.
		expect(backend.installApp).not.toHaveBeenCalled();
		expect(installed).toEqual([]);
		// The line a human reads names the *form* rather than a command this machine never saw:
		// what ran is host-side configuration, and there is no byte count and no local path in it.
		expect(logged.join('\n')).toContain("the lease's project");
		expect(logged.join('\n')).not.toContain('bytes from');
	});

	it('keeps the host’s named refusal when the project declares no install', async () => {
		const backend = registerFakeBackend();
		await start();
		const leaseId = await acquireLease();
		await writeHookFile({ project: 'rover', apps: [] });

		// Exit 1 — the host answered and the operation did not succeed — and never the exit 2
		// this CLI reserves for "you typed it wrong". Whether this form is available is a fact
		// about the host's configuration, so a client that refused it up front would be
		// answering a question only the host can (D16).
		expect(await run(['install', leaseId])).toBe(EXIT_FAILED);

		const said = errored.join('\n');
		expect(said).toContain('install-hook-undeclared');
		expect(said).not.toContain('Usage: rover install');
		expect(backend.installApp).not.toHaveBeenCalled();
	});

	it('reports the refusal as one --json document naming the project and the device', async () => {
		registerFakeBackend();
		await start();
		const leaseId = await acquireLease();
		await writeHookFile({ project: 'rover', apps: [] });

		expect(await run(['install', leaseId, '--json'])).toBe(EXIT_FAILED);

		expect(logged).toHaveLength(1);
		expect(JSON.parse(logged[0] ?? '')).toMatchObject({
			host: 'local',
			outcome: 'failed',
			failure: { kind: 'install-hook-undeclared', project: 'rover', serial: attached.serial },
		});
	});

	it('still refuses a blank package argument as a usage error', async () => {
		const backend = registerFakeBackend();
		await start();
		const leaseId = await acquireLease();

		// Optional is not the same as "an empty string is fine": `rover install <id> ''` is a
		// mistake, and reading it as the project form would run a build nobody asked for.
		expect(await run(['install', leaseId, ''])).toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain('[<local-path>]');
		expect(backend.installApp).not.toHaveBeenCalled();
	});
});

describe('rover pull, when the host says no', () => {
	it('exits 1 and writes nothing at all when the file is too large for one answer', async () => {
		registerFakeBackend({
			pullFile: vi.fn<DeviceBackend['pullFile']>(async () => {
				throw new FileTooLargeError(
					parseDeviceSerial(attached.serial),
					DEVICE_PATH,
					MAX_ARTIFACT_BYTES + 1,
					MAX_ARTIFACT_BYTES,
				);
			}),
		});
		await start();
		const leaseId = await acquireLease();
		const destination = local('too-large.bin');

		expect(await run(['pull', leaseId, DEVICE_PATH, '--out', destination])).toBe(EXIT_FAILED);

		// Never a short file: the write is the last thing that happens, and only on `ok`.
		expect(existsSync(destination)).toBe(false);
		const said = errored.join('\n');
		expect(said).toContain('artifact-too-large');
		expect(said).toContain(String(MAX_ARTIFACT_BYTES + 1));
		expect(said).toContain(String(MAX_ARTIFACT_BYTES));
	});

	// Exit 1 and not 2 on purpose, and the title says so: exit 2 is what this client decides
	// before connecting, exit 1 is what a host said no to. A relative device path is the
	// second kind — `pull` sends it unmodified rather than validating it locally.
	it('exits 1 and writes nothing when the host’s boundary refuses the device path', async () => {
		registerFakeBackend();
		await start();
		const leaseId = await acquireLease();

		// A relative device path never reaches a device: `DevicePathSchema` refuses it at the
		// host's boundary, and the CLI sends it unmodified rather than second-guessing it.
		expect(await run(['pull', leaseId, 'not/absolute', '--out', local('out.bin')])).toBe(
			EXIT_FAILED,
		);

		expect(existsSync(local('out.bin'))).toBe(false);
		expect(errored.join('\n')).toContain('devicePath');
	});
});

describe('the upload module itself', () => {
	it('refuses a source that is not there', async () => {
		await expect(resolveSource('push', local('missing.bin'))).rejects.toBeInstanceOf(UsageError);
	});

	it('refuses a source that is a directory', async () => {
		await expect(resolveSource('install', temp.dir)).rejects.toBeInstanceOf(UsageError);
	});

	it('refuses a named pipe, before anything is read off it', async () => {
		// No writer is attached on purpose: the refusal has to be decided off `stat` alone.
		// If this ever regresses to reading first, the case hangs rather than fails, which is
		// exactly what the command would do to a caller.
		await expect(resolveSource('push', await makeFifo('resolve-pipe'))).rejects.toBeInstanceOf(
			UsageError,
		);
	});

	it('refuses a character device, naming the kind', async () => {
		// `/dev/zero` stats as zero bytes and reads without end — the shape the size bound
		// cannot see, and the same one `pull_file` refuses on the device by kind.
		await expect(resolveSource('push', '/dev/zero')).rejects.toThrow(/character device/);
	});

	it.skipIf(asRoot)('refuses a source it cannot read, naming it', async () => {
		const source = await writeSource('locked.bin', BINARY_PAYLOAD);
		await chmod(source, 0o000);

		// `resolveSource` passes it — `stat` needs no read permission on the file itself — so
		// this is `readPayload`'s own refusal, the one branch nothing else in the suite runs.
		await expect(resolveSource('push', source)).resolves.toBe(source);
		await expect(readPayload('push', source)).rejects.toThrow(
			new RegExp(source.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')),
		);
	});

	it('refuses a source over the limit without reading it', async () => {
		const source = await writeSource('huge.bin', new Uint8Array(0));
		await truncate(source, MAX_TRANSFER_BYTES + 1);

		await expect(resolveSource('push', source)).rejects.toThrow(
			new RegExp(`${MAX_TRANSFER_BYTES + 1} bytes`),
		);
	});

	it('resolves a relative source against this process and answers an absolute path', async () => {
		const source = await writeSource('relative-source.bin', BINARY_PAYLOAD);

		await expect(resolveSource('push', path.relative(process.cwd(), source))).resolves.toBe(source);
	});
});
