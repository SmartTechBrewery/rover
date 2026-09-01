/**
 * `bin/rover.mjs`, the entry `npm link` puts on a `PATH`, asserted by **spawning it from a
 * directory that is not this checkout**.
 *
 * That is the whole point of the file and the only way to see whether it works.
 * `tests/unit/mcp/entry.test.ts` guards the same failure for the MCP launcher and records why no
 * assertion on a string can: `node --import tsx/esm <absolute script>` resolves the loader
 * against the **caller's** working directory, so the obvious form starts in this checkout and
 * dies with `Cannot find package 'tsx'` everywhere else — and a linked `rover` is, by
 * definition, only ever run somewhere else. The temp directory has no `node_modules` above it,
 * which is what makes the run a real test of resolution rather than of luck.
 *
 * It also pins the other half of the same decision: a CLI reached this way renders its pasteable
 * lines as `rover`, because that is the form its reader just proved works (`PROJECT.md` §9.4,
 * reversed 2026-09-01).
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);

/** A whole Node process has to start, install a loader and load the CLI's module tree. */
const TEST_TIMEOUT_MS = 30_000;

const launcher = resolve(dirname(fileURLToPath(import.meta.url)), '../../../bin/rover.mjs');

let elsewhere: string | undefined;

afterEach(async () => {
	if (elsewhere) {
		await rm(elsewhere, { recursive: true, force: true });
		elsewhere = undefined;
	}
});

describe('the rover launcher', () => {
	it('runs from a directory with no node_modules above it', {
		timeout: TEST_TIMEOUT_MS,
	}, async () => {
		elsewhere = await mkdtemp(join(tmpdir(), 'rover-elsewhere-'));

		const { stdout } = await run(process.execPath, [launcher, 'init', '--help'], {
			cwd: elsewhere,
		});

		expect(stdout).toContain('rover init');
	});

	it('names itself the way its reader just typed it', { timeout: TEST_TIMEOUT_MS }, async () => {
		elsewhere = await mkdtemp(join(tmpdir(), 'rover-elsewhere-'));

		const { stdout } = await run(process.execPath, [launcher, '--help'], { cwd: elsewhere });

		// The bare form, and not once the npm one: this process came through the launcher.
		expect(stdout).toContain('`rover` below stands for `rover`');
		expect(stdout).not.toContain('npm run rover --');
	});
});
