/**
 * The client half of D19's artifact contract: `rover screenshot` and `rover record` against
 * a real daemon on a real socket, writing real files into a temp directory.
 *
 * The daemon suite's real-socket exception applies (ai/TESTING.md) — never
 * `~/.rover/rover.sock`, every daemon closed through its own handle in `afterEach`, and the
 * files land in the same `mkdtemp` directory the socket does, so cleanup is one `rm`.
 *
 * The assertion that matters most in here is a **negative** one, repeated on every failure
 * path: `existsSync(out)` is false. A transfer that failed and left a short file behind is
 * the exact thing this row exists to prevent, and it is invisible to any test that only
 * checks the exit code.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	_resetDeviceBackendRegistryForTesting,
	registerDeviceBackend,
} from '@/backends/registry.js';
import { resolveDestination, writeArtifact } from '@/cli/_shared/artifact.js';
import { UsageError } from '@/cli/_shared/flags.js';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, run } from '@/cli/index.js';
import type { DeviceBackend, DeviceWatch, DeviceWatcher } from '@/core/device.js';
import { UnfinishedRecordingError } from '@/core/errors.js';
import { parseDeviceSerial } from '@/core/ids.js';
import { type RunningDaemon, startDaemon } from '@/daemon/listen.js';
import { DEFAULT_RECORDING_MS } from '@/verbs/record.js';
import { MAX_ARTIFACT_BYTES } from '@/verbs/result.js';
import {
	createTempSocket,
	removeTempSocket,
	type TempSocket,
} from '../../helpers/daemon-socket.js';
import {
	createMockDevice,
	createMockDeviceBackend,
	createMockRecordingBytes,
} from '../../helpers/factories.js';

/**
 * The CLI artifact suite verifies the bytes received from a real daemon and deliberately does
 * not require the host's external frame decoder. Frame extraction has its own suite with a
 * mocked process; here it only needs to supply the `frames` result field.
 *
 * Two frames rather than one, so a renderer that dropped the array and a renderer that kept
 * only its first entry are told apart, and each one a different length so the document has to
 * carry both byte lengths rather than one repeated.
 */
const EXTRACTED_FRAMES = [
	Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]),
	Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02, 0x03]),
];

const extractFramesMock = vi.hoisted(() => vi.fn());

vi.mock('@/daemon/frames.js', () => ({ extractFrames: extractFramesMock }));

const attached = createMockDevice({ serial: parseDeviceSerial('attached-1') });

/** A PNG signature and then some, so the media type sniffed off the bytes is a real one. */
const CAPTURED_IMAGE = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad, 0xbe, 0xef,
]);

let temp: TempSocket;
const running: RunningDaemon[] = [];
let logged: string[];
let errored: string[];

function registerFakeBackend(overrides: Partial<DeviceBackend> = {}): void {
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
			screenshot: vi.fn<DeviceBackend['screenshot']>(async () => CAPTURED_IMAGE),
			...overrides,
		}),
	});
}

async function start(): Promise<void> {
	const result = await startDaemon({
		socketPath: temp.socketPath,
		artifactsRoot: temp.artifactsRoot,
	});
	if (!result.started) {
		throw new Error('Another daemon holds the temp socket — the test cannot proceed');
	}
	running.push(result);
}

/** A live lease on the fake device, through the CLI, because that is the only way to get one. */
async function acquireLease(): Promise<string> {
	expect(
		await run(['acquire', attached.serial, '--owner', 'issue-24', '--project', 'rover', '--json']),
	).toBe(EXIT_OK);
	const parsed = JSON.parse(logged[0] ?? '') as { lease?: { leaseId?: string } };
	const leaseId = parsed.lease?.leaseId;
	if (leaseId === undefined) {
		throw new Error(`No granted lease in: ${logged[0] ?? ''}`);
	}
	logged = [];
	return leaseId;
}

/** A destination inside the temp directory, which `afterEach` removes whole. */
function destination(name: string): string {
	return path.join(temp.dir, name);
}

beforeEach(async () => {
	temp = await createTempSocket();
	vi.stubEnv('ROVER_SOCKET_PATH', temp.socketPath);
	logged = [];
	errored = [];
	extractFramesMock.mockReset();
	extractFramesMock.mockResolvedValue(EXTRACTED_FRAMES);
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

describe('rover screenshot', () => {
	it('writes the host’s bytes, unchanged, to a path on this machine', async () => {
		registerFakeBackend();
		await start();
		const leaseId = await acquireLease();
		const out = destination('capture.png');

		expect(await run(['screenshot', leaseId, '--out', out])).toBe(EXIT_OK);

		// Byte for byte what the backend produced — the whole point of the round trip.
		expect(new Uint8Array(await readFile(out))).toEqual(CAPTURED_IMAGE);
		// The path reported is the caller's own, absolute, and on the caller's disk.
		expect(logged.join('\n')).toContain(path.resolve(out));
		expect(logged.join('\n')).toContain(`${CAPTURED_IMAGE.byteLength} bytes of image/png`);
		expect(errored).toEqual([]);
	});

	it('resolves a relative --out against this process, not against the host', async () => {
		registerFakeBackend();
		await start();
		const leaseId = await acquireLease();
		const relative = path.relative(process.cwd(), destination('relative.png'));

		expect(await run(['screenshot', leaseId, '--out', relative])).toBe(EXIT_OK);

		expect(logged.join('\n')).toContain(path.resolve(relative));
		expect(existsSync(path.resolve(relative))).toBe(true);
	});

	it('writes one --json document carrying artifactPath and no base64 anywhere', async () => {
		registerFakeBackend();
		await start();
		const leaseId = await acquireLease();
		const out = destination('capture.png');

		expect(await run(['screenshot', leaseId, '--out', out, '--json'])).toBe(EXIT_OK);

		expect(logged).toHaveLength(1);
		const document = logged[0] ?? '';
		expect(JSON.parse(document)).toMatchObject({
			host: 'local',
			outcome: 'ok',
			artifactPath: path.resolve(out),
			result: { artifact: { mediaType: 'image/png', byteLength: CAPTURED_IMAGE.byteLength } },
		});
		// The bytes are on disk and the document says where; echoing megabytes of base64 into
		// the mode most likely to be piped into a parser would undo the file entirely.
		expect(document).not.toContain('base64');
	});

	it('exits 1 and writes nothing at all when the capture is too large for one answer', async () => {
		registerFakeBackend({
			screenshot: vi.fn<DeviceBackend['screenshot']>(
				async () => new Uint8Array(MAX_ARTIFACT_BYTES + 1),
			),
		});
		await start();
		const leaseId = await acquireLease();
		const out = destination('too-large.png');

		expect(await run(['screenshot', leaseId, '--out', out])).toBe(EXIT_FAILED);

		// Never a short file: the write is the last thing that happens, and only on `ok`.
		expect(existsSync(out)).toBe(false);
		const said = errored.join('\n');
		expect(said).toContain('artifact-too-large');
		// Both numbers, which is what makes it actionable rather than merely a refusal.
		expect(said).toContain(String(MAX_ARTIFACT_BYTES + 1));
		expect(said).toContain(String(MAX_ARTIFACT_BYTES));
	});
});

describe('rover record', () => {
	it('writes the recording and leaves the verb’s own default duration in place', async () => {
		const recordVideo = vi.fn<NonNullable<DeviceBackend['recordVideo']>>(async () =>
			createMockRecordingBytes(),
		);
		registerFakeBackend({ recordVideo });
		await start();
		const leaseId = await acquireLease();
		const out = destination('recording.mp4');

		expect(await run(['record', leaseId, '--out', out])).toBe(EXIT_OK);

		expect(new Uint8Array(await readFile(out))).toEqual(createMockRecordingBytes());
		expect(logged.join('\n')).toContain('video/mp4');
		// No duration was sent, so the one the backend saw is the verb's, not a second default
		// this client invented on the way past.
		expect(recordVideo.mock.calls[0]?.[1]).toEqual({ durationMs: DEFAULT_RECORDING_MS });
	});

	it('sends --duration-ms through to the device', async () => {
		const recordVideo = vi.fn<NonNullable<DeviceBackend['recordVideo']>>(async () =>
			createMockRecordingBytes(),
		);
		registerFakeBackend({ recordVideo });
		await start();
		const leaseId = await acquireLease();

		expect(
			await run(['record', leaseId, '--out', destination('r.mp4'), '--duration-ms', '1500']),
		).toBe(EXIT_OK);

		expect(recordVideo.mock.calls[0]?.[1]).toEqual({ durationMs: 1500 });
	});

	it('sends --frames-per-second through to the host rather than to the device', async () => {
		const recordVideo = vi.fn<NonNullable<DeviceBackend['recordVideo']>>(async () =>
			createMockRecordingBytes(),
		);
		registerFakeBackend({ recordVideo });
		await start();
		const leaseId = await acquireLease();

		expect(
			await run(['record', leaseId, '--out', destination('r.mp4'), '--frames-per-second', '3']),
		).toBe(EXIT_OK);

		// The rate is the extractor's knob, not the recorder's: the device is asked for a
		// recording and nothing else, and the sampling happens on the bytes afterwards.
		expect(recordVideo.mock.calls[0]?.[1]).toEqual({ durationMs: DEFAULT_RECORDING_MS });
		expect(extractFramesMock.mock.calls[0]?.[2]).toEqual({ framesPerSecond: 3 });
	});

	/**
	 * `screenshot`'s `--json` contract, over the field this verb adds. The frames are the same
	 * kind of payload as the recording — at the byte budget, 1.5 MiB of PNG inflating to 2 MiB
	 * of base64 — so the mode most likely to be piped into a parser must not carry them either.
	 *
	 * They are *described* rather than dropped: the count and each byte length stay, because a
	 * silently absent field would be indistinguishable from a host that extracted nothing, and
	 * the frames are otherwise invisible to a CLI caller.
	 */
	it('writes one --json document naming the frames and carrying no base64 anywhere', async () => {
		registerFakeBackend({
			recordVideo: vi.fn<NonNullable<DeviceBackend['recordVideo']>>(async () =>
				createMockRecordingBytes(),
			),
		});
		await start();
		const leaseId = await acquireLease();
		const out = destination('recording.mp4');

		expect(await run(['record', leaseId, '--out', out, '--json'])).toBe(EXIT_OK);

		expect(logged).toHaveLength(1);
		const document = logged[0] ?? '';
		expect(JSON.parse(document)).toMatchObject({
			host: 'local',
			outcome: 'ok',
			artifactPath: path.resolve(out),
			result: {
				artifact: { mediaType: 'video/mp4' },
				frames: EXTRACTED_FRAMES.map((frame) => ({
					mediaType: 'image/png',
					byteLength: frame.byteLength,
				})),
			},
		});
		// Neither the recording nor the frames: the one thing `--out` plus `--json` promises is
		// that the bytes went to the file and the document says where.
		expect(document).not.toContain('base64');
	});

	it('exits 1 naming the device and writes nothing when the recording came off unfinished', async () => {
		registerFakeBackend({
			recordVideo: vi.fn<NonNullable<DeviceBackend['recordVideo']>>(async () => {
				throw new UnfinishedRecordingError(parseDeviceSerial(attached.serial), 512);
			}),
		});
		await start();
		const leaseId = await acquireLease();
		const out = destination('unfinished.mp4');

		expect(await run(['record', leaseId, '--out', out])).toBe(EXIT_FAILED);

		// #24's "the recording finishes on the host before the transfer" criterion, asserted
		// from the client's end: an unopenable file is never written here either.
		expect(existsSync(out)).toBe(false);
		const said = errored.join('\n');
		expect(said).toContain('unfinished-recording');
		expect(said).toContain(attached.serial);
	});
});

describe('the artifact module itself', () => {
	it('refuses a decoded length that disagrees with the host’s, and writes nothing', async () => {
		const out = destination('mismatched.png');

		// `Buffer.from(…, 'base64')` drops characters outside the alphabet rather than
		// failing, so a mangled payload decodes short — which is precisely the truncated file
		// that does not announce itself. The byte length the host sent is the only end-to-end
		// check either side has.
		await expect(
			writeArtifact({ mediaType: 'image/png', base64: 'AAAA', byteLength: 99 }, out),
		).rejects.toThrow(/99 bytes and 3 decoded/);
		expect(existsSync(out)).toBe(false);
	});

	it('accepts an --out whose file already exists, and overwrites it', async () => {
		registerFakeBackend();
		await start();
		const leaseId = await acquireLease();
		const out = destination('twice.png');

		expect(await run(['screenshot', leaseId, '--out', out])).toBe(EXIT_OK);
		expect(await run(['screenshot', leaseId, '--out', out])).toBe(EXIT_OK);

		expect(new Uint8Array(await readFile(out))).toEqual(CAPTURED_IMAGE);
	});

	it('rejects a directory as --out, before anything is captured', async () => {
		await expect(resolveDestination('screenshot', temp.dir)).rejects.toBeInstanceOf(UsageError);
	});

	it('rejects an --out whose parent directory does not exist', async () => {
		await expect(
			resolveDestination('record', destination('no/such/directory/out.mp4')),
		).rejects.toBeInstanceOf(UsageError);
	});

	it('resolves a destination whose parent exists but whose file does not', async () => {
		const nested = destination('nested');
		await mkdir(nested);

		await expect(resolveDestination('screenshot', path.join(nested, 'new.png'))).resolves.toBe(
			path.join(nested, 'new.png'),
		);
	});
});

describe('rover screenshot and record, before a host is asked', () => {
	it('exits 2 with the command’s usage when --out names a directory', async () => {
		expect(await run(['screenshot', 'lease-1', '--out', temp.dir])).toBe(EXIT_USAGE);

		const said = errored.join('\n');
		expect(said).toContain('is a directory');
		expect(said).toContain('Usage: rover screenshot');
	});

	it('exits 2 with the command’s usage when --out has no directory to write into', async () => {
		expect(await run(['record', 'lease-1', '--out', destination('missing/out.mp4')])).toBe(
			EXIT_USAGE,
		);

		expect(errored.join('\n')).toContain('no directory');
		expect(errored.join('\n')).toContain('Usage: rover record');
	});
});
