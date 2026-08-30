/**
 * The entrypoint guard, asserted the only way that proves anything: by **spawning** the CLI.
 *
 * `if (import.meta.url === <argv[1] as a URL>)` is the line every `rover` invocation passes
 * through, and getting it wrong does not throw — it makes the whole CLI a silent no-op that
 * writes nothing and exits 0, so `acquire` reports success without taking a lease. No
 * in-process test can see that: `run()` is imported directly there, and the guard never
 * runs. Hence a real child process, reached through a path that breaks the naive comparison.
 *
 * Two things break it, and the spawn below carries both at once — a directory name with a
 * space in it (`import.meta.url` percent-encodes it, `argv[1]` does not) and a symlink
 * (Node hands `import.meta.url` the entry's realpath, `argv[1]` keeps the path as typed).
 */

import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { entryUrl } from '@/cli/index.js';
import {
	createTempSocket,
	removeTempSocket,
	stopDaemonAt,
	type TempSocket,
} from '../../helpers/daemon-socket.js';

const run = promisify(execFile);

/** A whole Node process has to start, load a loader and this module tree, and answer. */
const TEST_TIMEOUT_MS = 30_000;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

let temp: TempSocket | undefined;
let awkward: string | undefined;

afterEach(async () => {
	if (temp) {
		await stopDaemonAt(temp.socketPath);
		await removeTempSocket(temp);
		temp = undefined;
	}
	if (awkward) {
		await rm(awkward, { recursive: true, force: true });
		awkward = undefined;
	}
});

describe('the entrypoint guard', () => {
	it('self-runs when the entry is reached through a path with a space in it', {
		timeout: TEST_TIMEOUT_MS,
	}, async () => {
		awkward = await mkdtemp(join(tmpdir(), 'rover cli '));
		const link = join(awkward, 'checkout');
		await symlink(repoRoot, link);
		temp = await createTempSocket();

		const { stdout } = await run(
			process.execPath,
			['--import', 'tsx/esm', join(link, 'src/cli/index.ts'), 'status', '--json'],
			{ env: { ...process.env, ROVER_SOCKET_PATH: temp.socketPath } },
		);

		// Empty stdout with exit 0 is the failure this guards against: it looks like success
		// to a script and carries no diagnostic pointing at the cause.
		expect(stdout.trim()).not.toBe('');
		expect(JSON.parse(stdout)).toMatchObject({ host: 'local' });
	});

	it('percent-encodes the path rather than concatenating it behind file://', async () => {
		awkward = await mkdtemp(join(tmpdir(), 'rover cli '));
		const entry = join(awkward, 'index.ts');
		await writeFile(entry, '');

		// Both halves of the rule, on our own code: what the guard compares is a URL, and the
		// `file://${path}` form it replaced is not that URL for any path needing encoding.
		expect(entryUrl(entry)).toBe(pathToFileURL(await realpath(entry)).href);
		expect(entryUrl(entry)).toContain('rover%20cli%20');
		expect(entryUrl(entry)).not.toBe(`file://${entry}`);
	});

	it('resolves a symlinked entry to its real location, the way Node does', async () => {
		awkward = await mkdtemp(join(tmpdir(), 'rover cli '));
		const link = join(awkward, 'checkout');
		await symlink(repoRoot, link);

		expect(entryUrl(join(link, 'src/cli/index.ts'))).toBe(
			pathToFileURL(await realpath(join(repoRoot, 'src/cli/index.ts'))).href,
		);
	});

	it('is not the entry when the path resolves to nothing', () => {
		expect(entryUrl(join(tmpdir(), 'rover-no-such-entry', 'index.ts'))).toBeNull();
	});
});
