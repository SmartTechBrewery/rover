import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	IdbCompanionInstallError,
	installIdbCompanion,
} from '@/backends/ios-simulator/idb-companion-install.js';
import {
	IDB_COMPANION,
	IDB_COMPANION_VERSION,
	managedIdbCompanion,
	managedIdbCompanionDirectory,
} from '@/backends/ios-simulator/idb-companion-locations.mjs';

/**
 * What `rover doctor --fix` does on the host, with the network replaced.
 *
 * **Nothing here reaches GitHub and nothing here is 19 MB.** The download is one injected `fetch`
 * answering a tarball this file builds, so the cases assert the parts that can actually go wrong —
 * the checksum gate, the atomic rename, idempotence, and the two hosts this asset cannot run on —
 * rather than re-testing `tar`. The archive is real, built by `tar` in a temporary directory, so
 * the unpack step is exercised for real: a fixture that faked it would test nothing.
 *
 * Every case passes its own `home`, so nothing touches the runner's `~/.rover`.
 */

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'rover-idb-install-'));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

/** A gzipped tar holding an executable `idb_companion` and the `Resources/` it needs beside it. */
async function releaseTarball(): Promise<Buffer> {
	const staging = await temporaryDirectory();
	const companion = join(staging, IDB_COMPANION);
	await writeFile(companion, '#!/bin/sh\necho not really a companion\n');
	await chmod(companion, 0o755);
	await mkdir(join(staging, 'Resources'));
	await writeFile(join(staging, 'Resources', 'something.txt'), 'a file the binary needs\n');

	const { execFile } = await import('node:child_process');
	const { promisify } = await import('node:util');
	const archive = join(await temporaryDirectory(), 'release.tar.gz');
	await promisify(execFile)('tar', ['czf', archive, '-C', staging, IDB_COMPANION, 'Resources']);
	return readFile(archive);
}

/**
 * A `fetch` that answers the asset and its checksum, and counts what was asked for.
 *
 * The checksum is computed from whatever bytes it is given, so a case that wants a mismatch says
 * so by handing it a different digest — the honest way round, since a hard-coded pair would drift
 * the moment the fixture changes.
 */
function fetchStub(asset: Buffer, digest?: string) {
	const calls: string[] = [];
	const checksum = digest ?? createHash('sha256').update(asset).digest('hex');
	const stub = vi.fn(async (input: string | URL | Request) => {
		const url = String(input);
		calls.push(url);
		const body = url.endsWith('.sha256')
			? Buffer.from(`${checksum}  idb-companion.macos-arm64.tar.gz\n`)
			: asset;
		// `Uint8Array` rather than the `Buffer` itself: the DOM `BodyInit` union names the former,
		// and the bytes are the same object either way.
		return new Response(new Uint8Array(body), { status: 200 });
	});
	return { stub: stub as unknown as typeof globalThis.fetch, calls };
}

describe('installing the pinned release', () => {
	it('unpacks it where the search looks last, and says it did', async () => {
		const home = await temporaryDirectory();
		const { stub } = fetchStub(await releaseTarball());

		const installation = await installIdbCompanion({
			home,
			platform: 'darwin',
			arch: 'arm64',
			fetch: stub,
		});

		expect(installation).toEqual({
			path: managedIdbCompanion(home),
			version: IDB_COMPANION_VERSION,
			installed: true,
		});
		// The whole tree, not just the binary: the companion cannot run without what unpacks beside
		// it, so an installer that kept only the executable would produce a file that fails on use.
		await expect(
			readFile(join(managedIdbCompanionDirectory(home), 'Resources', 'something.txt'), 'utf8'),
		).resolves.toContain('a file the binary needs');
	});

	/**
	 * Safe to type twice, which is what makes it safe to put in a warning an operator will paste.
	 */
	it('downloads nothing when its own copy is already unpacked', async () => {
		const home = await temporaryDirectory();
		const first = fetchStub(await releaseTarball());
		await installIdbCompanion({ home, platform: 'darwin', arch: 'arm64', fetch: first.stub });

		const second = fetchStub(await releaseTarball());
		const installation = await installIdbCompanion({
			home,
			platform: 'darwin',
			arch: 'arm64',
			fetch: second.stub,
		});

		expect(installation.installed).toBe(false);
		expect(second.calls).toEqual([]);
	});

	/**
	 * The bytes are checked before anything is unpacked, and a mismatch leaves the target absent
	 * rather than half-written — the reason the tree is assembled in a sibling and renamed.
	 */
	it('refuses bytes that do not match the checksum, and unpacks nothing', async () => {
		const home = await temporaryDirectory();
		const { stub } = fetchStub(await releaseTarball(), 'f'.repeat(64));

		await expect(
			installIdbCompanion({ home, platform: 'darwin', arch: 'arm64', fetch: stub }),
		).rejects.toBeInstanceOf(IdbCompanionInstallError);
		await expect(readFile(managedIdbCompanion(home))).rejects.toThrow();
	});

	/** A failed attempt leaves no staging directory behind for the next one to trip over. */
	it('cleans up after itself when the download fails', async () => {
		const home = await temporaryDirectory();
		const stub = vi.fn(async () => new Response('nope', { status: 404 }));

		await expect(
			installIdbCompanion({
				home,
				platform: 'darwin',
				arch: 'arm64',
				fetch: stub as unknown as typeof globalThis.fetch,
			}),
		).rejects.toThrow(/404/);
		const { readdir } = await import('node:fs/promises');
		await expect(readdir(join(home, '.rover'))).resolves.toEqual([]);
	});
});

describe('the two hosts this asset cannot run on', () => {
	/** idb is macOS-only, and so is the backend that needs it. */
	it('refuses off macOS, naming the platform', async () => {
		await expect(
			installIdbCompanion({ home: await temporaryDirectory(), platform: 'linux', arch: 'arm64' }),
		).rejects.toThrow(/macOS-only/);
	});

	/**
	 * The release publishes no Intel build, and Rosetta translates the other direction — so this
	 * has to be a sentence naming the way out, not a download that produces a binary the host
	 * cannot execute.
	 */
	it('refuses on an Intel mac, naming what to do instead', async () => {
		await expect(
			installIdbCompanion({ home: await temporaryDirectory(), platform: 'darwin', arch: 'x64' }),
		).rejects.toThrow(/ROVER_IDB_COMPANION_PATH/);
	});
});
