/**
 * `scripts/check-adb.mjs`, the install-time prerequisite warning, asserted by **spawning it under
 * a doctored `PATH`** — the only way to see what a person running `npm install` actually gets.
 *
 * Spawning rather than importing follows `tests/unit/cli/launcher.test.ts` and
 * `tests/unit/mcp/entry.test.ts`: the script's whole behaviour is what it writes and what it
 * exits with, and `tsconfig.typecheck.json` has nothing to say about an imported `.mjs`.
 */

import { execFile } from 'node:child_process';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);

/** Generous for a script that imports nothing but node builtins, but every spawn gets one. */
const TEST_TIMEOUT_MS = 10_000;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const script = join(repoRoot, 'scripts/check-adb.mjs');

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'rover-check-adb-'));
	temporaryDirectories.push(directory);
	return directory;
}

/** A file named `adb` that is never executed — only stat'd — but carries a real mode. */
async function stubAdb(mode: number): Promise<string> {
	const directory = await temporaryDirectory();
	const stub = join(directory, 'adb');
	await writeFile(stub, '#!/bin/sh\nexit 0\n');
	await chmod(stub, mode);
	return directory;
}

/**
 * `process.execPath` is absolute, so the child needs no `PATH` of its own to start — which is
 * what makes `undefined` a case the script has to survive rather than one it cannot be given.
 */
async function runWith(pathValue: string | undefined) {
	const env = { ...process.env };
	if (pathValue === undefined) delete env.PATH;
	else env.PATH = pathValue;

	return await run(process.execPath, [script], { env, timeout: TEST_TIMEOUT_MS });
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe('the adb prerequisite check', () => {
	it('says nothing at all when adb is on PATH', { timeout: TEST_TIMEOUT_MS }, async () => {
		const { stdout, stderr } = await runWith(await stubAdb(0o755));

		expect(stdout).toBe('');
		expect(stderr).toBe('');
	});

	it('names what is missing, why it matters and where to look', {
		timeout: TEST_TIMEOUT_MS,
	}, async () => {
		const { stderr } = await runWith(await temporaryDirectory());

		expect(stderr).toContain('adb');
		expect(stderr).toContain('PATH');
		expect(stderr).toContain('README.md');
		expect(stderr).toContain('Nothing on this machine was changed');
	});

	// `execFile`'s promise rejects on a non-zero exit, so resolving is the assertion here.
	it('never fails the install it is warning during', {
		timeout: TEST_TIMEOUT_MS,
	}, async () => {
		const { stdout, stderr } = await runWith(await temporaryDirectory());

		expect(stdout).toBe('');
		expect(stderr).not.toBe('');
	});

	it('warns rather than throwing when PATH is not set at all', {
		timeout: TEST_TIMEOUT_MS,
	}, async () => {
		const { stderr } = await runWith(undefined);

		expect(stderr).toContain("'adb' was not found on PATH");
	});

	// X_OK answers yes for every file on Windows, where PATHEXT is the test instead.
	it.skipIf(process.platform === 'win32')(
		'counts a non-executable adb as missing',
		{ timeout: TEST_TIMEOUT_MS },
		async () => {
			const { stderr } = await runWith(await stubAdb(0o644));

			expect(stderr).toContain("'adb' was not found on PATH");
		},
	);

	// Without this, renaming the script leaves a check that never runs and a suite that passes.
	it('is wired into npm install', async () => {
		const manifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));

		expect(manifest.scripts.postinstall).toBe('node scripts/check-adb.mjs');
		await expect(access(script)).resolves.toBeUndefined();
	});
});
