/**
 * The durable archive itself, driven against a real temp directory (D23, PROJECT.md §10).
 *
 * A real filesystem rather than a mocked one, for the reason the daemon suite uses a real
 * socket (ai/TESTING.md): what this row promises is files somebody can list, and a mocked
 * `fs` proves only that the module called it. Every root here is a `mkdtemp` — **no test
 * writes into `~/.rover/artifacts`**, which is the developer's own tree.
 *
 * The file names below are pinned rather than derived, because the tree's shape is a stable
 * contract a future read-only viewer reads directly (D24).
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeviceInfoSchema } from '@/core/device.js';
import { parseLeaseId } from '@/core/ids.js';
import { type ArchivableResult, createArtifactArchive } from '@/daemon/archive.js';
import { leaseArchiveDirectory } from '@/daemon/archive-path.js';
import type { Lease } from '@/daemon/leases.js';
import type { Artifact } from '@/verbs/result.js';
import {
	createMockDeviceInfo,
	createMockLease,
	createMockLogEntry,
	createMockLogRead,
} from '../../helpers/factories.js';

let root: string;
let warnings: string[];
const lease = createMockLease({ project: 'rover', testName: 'home-screen' });

beforeEach(async () => {
	root = join(await mkdtemp(join(tmpdir(), 'rover-')), 'artifacts');
	warnings = [];
});

afterEach(async () => {
	await rm(join(root, '..'), { recursive: true, force: true });
});

function archive(overrides: { root?: string } = {}) {
	return createArtifactArchive({
		root: overrides.root ?? root,
		warn: (message) => warnings.push(message),
	});
}

/** Bytes and their base64, so a test can compare what landed against what was sent. */
function artifactOf(mediaType: string, bytes: readonly number[]): Artifact {
	const buffer = Buffer.from(Uint8Array.from(bytes));
	return { mediaType, base64: buffer.toString('base64'), byteLength: buffer.byteLength };
}

const CAPTURE = artifactOf('image/png', [0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]);
const RECORDING = artifactOf('video/mp4', [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);

function resultOf(verb: string, overrides: Partial<ArchivableResult> = {}): ArchivableResult {
	return {
		verb,
		device: createMockDeviceInfo({ serial: lease.serial }),
		target: null,
		after: { kind: 'screen', elements: [] },
		artifact: null,
		...overrides,
	};
}

/** Where this lease's files land, so a test names the tree the way production builds it. */
function directoryFor(of: Lease = lease): string {
	return leaseArchiveDirectory(root, of);
}

async function read(...parts: string[]): Promise<Buffer> {
	return readFile(join(directoryFor(), ...parts));
}

describe('createArtifactArchive', () => {
	it('writes a screenshot as the exact bytes the client received', async () => {
		await archive().record(lease, resultOf('screenshot', { artifact: CAPTURE }));

		expect(await read('screenshots', '001_screenshot.png')).toEqual(
			Buffer.from(CAPTURE.base64, 'base64'),
		);
	});

	it('numbers a second screenshot on the same lease 002', async () => {
		const durable = archive();
		await durable.record(lease, resultOf('screenshot', { artifact: CAPTURE }));
		await durable.record(lease, resultOf('screenshot', { artifact: CAPTURE }));

		expect(await readdir(join(directoryFor(), 'screenshots'))).toEqual([
			'001_screenshot.png',
			'002_screenshot.png',
		]);
	});

	it('gives two concurrent calls two numbers rather than both computing 001', async () => {
		// Nothing stops a holder firing two verbs down one connection (`verb-traffic.ts`), so
		// the sequence is allocated before the first await rather than after it.
		const durable = archive();
		await Promise.all([
			durable.record(lease, resultOf('screenshot', { artifact: CAPTURE })),
			durable.record(lease, resultOf('screenshot', { artifact: CAPTURE })),
		]);

		expect(await readdir(join(directoryFor(), 'screenshots'))).toHaveLength(2);
	});

	it('writes a recording with its frames in a sibling directory, in order', async () => {
		const frames = [
			artifactOf('image/png', [0x89, 0x50, 0x4e, 0x47, 0x11]),
			artifactOf('image/png', [0x89, 0x50, 0x4e, 0x47, 0x22]),
		];

		await archive().record(lease, resultOf('record_video', { artifact: RECORDING, frames }));

		expect(await read('recordings', '001.mp4')).toEqual(Buffer.from(RECORDING.base64, 'base64'));
		expect(await readdir(join(directoryFor(), 'recordings', '001_frames'))).toEqual([
			'0001.png',
			'0002.png',
		]);
		expect(await read('recordings', '001_frames', '0001.png')).toEqual(
			Buffer.from(frames[0]?.base64 ?? '', 'base64'),
		);
		expect(await read('recordings', '001_frames', '0002.png')).toEqual(
			Buffer.from(frames[1]?.base64 ?? '', 'base64'),
		);
	});

	it('writes a log read as one text file, oldest entry first', async () => {
		const logs = createMockLogRead({
			entries: [
				createMockLogEntry({ timestamp: '01-02 03:04:05.678', message: 'older' }),
				createMockLogEntry({
					timestamp: '01-02 03:04:06.000',
					level: 'error',
					tag: 'CrashReporter',
					message: 'newer',
				}),
			],
		});

		await archive().record(lease, resultOf('read_logs', { logs }));

		expect((await read('logs', '001_read_logs.txt')).toString('utf8')).toBe(
			'01-02 03:04:05.678 INFO/TestTag(1234): older\n' +
				'01-02 03:04:06.000 ERROR/CrashReporter(1234): newer\n',
		);
	});

	it('says at the top of the file when the device had more than the read asked for', async () => {
		const logs = createMockLogRead({ truncated: true });

		await archive().record(lease, resultOf('read_logs', { logs }));

		expect((await read('logs', '001_read_logs.txt')).toString('utf8')).toMatch(
			/^# older entries were dropped/,
		);
	});

	it('omits the pid when the device named none', async () => {
		const logs = createMockLogRead({ entries: [createMockLogEntry({ pid: null })] });

		await archive().record(lease, resultOf('read_logs', { logs }));

		expect((await read('logs', '001_read_logs.txt')).toString('utf8')).toBe(
			'01-02 03:04:05.678 INFO/TestTag: a line the device printed\n',
		);
	});

	it('snapshots the device beside the artifacts, once per lease-device pair', async () => {
		const durable = archive();
		await durable.record(lease, resultOf('screenshot', { artifact: CAPTURE }));
		const first = await read('device_info.json');

		// A second artifact must not rewrite it: the snapshot is of the device as this lease
		// found it (D14), not of whatever it last answered.
		await durable.record(
			lease,
			resultOf('screenshot', {
				artifact: CAPTURE,
				device: createMockDeviceInfo({ serial: lease.serial, model: 'Something Else' }),
			}),
		);

		expect(await read('device_info.json')).toEqual(first);
		expect(DeviceInfoSchema.parse(JSON.parse(first.toString('utf8'))).serial).toBe(lease.serial);
	});

	it('writes nothing at all for a verb that produced no bytes', async () => {
		await archive().record(lease, resultOf('tap'));

		// Not an empty directory: a lease that only ever tapped leaves no scaffolding behind.
		await expect(readdir(root)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('calls bytes nothing recognised .bin rather than guessing from the verb', async () => {
		const unknown = artifactOf('application/octet-stream', [0x01, 0x02, 0x03]);

		await archive().record(lease, resultOf('screenshot', { artifact: unknown }));

		expect(await readdir(join(directoryFor(), 'screenshots'))).toEqual(['001_screenshot.bin']);
	});

	it('files two leases with one test name side by side — the before/after pair', async () => {
		const before = createMockLease({ project: 'rover', testName: 'home-screen' });
		const after = createMockLease({
			id: parseLeaseId('lease-two'),
			project: 'rover',
			testName: 'home-screen',
			createdAtMs: before.createdAtMs + 1_000,
		});
		const durable = archive();

		await durable.record(before, resultOf('screenshot', { artifact: CAPTURE }));
		await durable.record(after, resultOf('screenshot', { artifact: CAPTURE }));

		// `ls` the test-name directory and the two most recent runs are the two sides of the
		// diff — the whole reason `test_name` is deliberately not unique (D24).
		expect(await readdir(join(root, 'rover', 'home-screen'))).toHaveLength(2);
	});

	it('warns and does not throw when the write cannot succeed', async () => {
		const blocked = join(await mkdtemp(join(tmpdir(), 'rover-')), 'not-a-directory');
		await writeFile(blocked, 'a file where the root should be');

		// A full disk or an unwritable root is a host problem, and the verb still succeeded —
		// D23 makes the archive a second effect of the call, never a substitute for it.
		await expect(
			archive({ root: blocked }).record(lease, resultOf('screenshot', { artifact: CAPTURE })),
		).resolves.toBeUndefined();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(blocked);
		expect(warnings[0]).toContain('screenshot');
	});

	it('starts a forgotten lease over at 001', async () => {
		// `forget` is only ever called once a lease has ended, and a lease dies with the host
		// (D6) — so a lease directory can never be reopened and the counter is complete.
		const durable = archive();
		await durable.record(lease, resultOf('screenshot', { artifact: CAPTURE }));
		durable.forget(lease);
		await rm(join(directoryFor(), 'screenshots'), { recursive: true });
		await durable.record(lease, resultOf('screenshot', { artifact: CAPTURE }));

		expect(await readdir(join(directoryFor(), 'screenshots'))).toEqual(['001_screenshot.png']);
	});
});
