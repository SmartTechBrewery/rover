/**
 * `scripts/check-adb.mjs`, the install-time prerequisite warning, asserted by **spawning it under
 * a doctored environment** — the only way to see what a person running `npm install` actually
 * gets.
 *
 * Spawning rather than importing follows `tests/unit/cli/launcher.test.ts` and
 * `tests/unit/mcp/entry.test.ts`: the script's whole behaviour is what it writes and what it
 * exits with, and `tsconfig.typecheck.json` has nothing to say about an imported `.mjs`.
 *
 * It is also the only way to reach `os.homedir()`, which the standard-SDK-location candidate is
 * built from and which reads the real environment rather than `process.env` (#171). A child
 * process given its own `HOME` is a machine with a different home directory, which is exactly
 * what these cases need — the operator's own SDK must never decide whether this suite passes.
 */

import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
async function stubAdb(directory: string, mode = 0o755): Promise<string> {
	await mkdir(directory, { recursive: true });
	const stub = join(directory, 'adb');
	await writeFile(stub, '#!/bin/sh\nexit 0\n');
	await chmod(stub, mode);
	return stub;
}

/** A directory holding an executable `adb`, for the case that only needs one. */
async function directoryWithAdb(mode = 0o755): Promise<string> {
	const directory = await temporaryDirectory();
	await stubAdb(directory, mode);
	return directory;
}

/**
 * The script, run against a machine this case describes in full.
 *
 * Every variable the search consults is set — to nothing unless the case says otherwise — and
 * `HOME` is a directory with nothing in it, so the last candidate in the order resolves
 * somewhere harmless instead of against the operator's own SDK.
 *
 * `process.execPath` is absolute, so the child needs no `PATH` of its own to start — which is
 * what makes `undefined` a case the script has to survive rather than one it cannot be given.
 */
async function runWith(overrides: Record<string, string | undefined>) {
	const home = await temporaryDirectory();
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		LOCALAPPDATA: join(home, 'AppData', 'Local'),
		PATH: '',
		ROVER_ADB_PATH: '',
		ANDROID_HOME: '',
		ANDROID_SDK_ROOT: '',
	};
	for (const [name, value] of Object.entries(overrides)) {
		if (value === undefined) delete env[name];
		else env[name] = value;
	}

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
		const { stdout, stderr } = await runWith({ PATH: await directoryWithAdb() });

		expect(stdout).toBe('');
		expect(stderr).toBe('');
	});

	/**
	 * The half #171 added, and the reason this file changed with it: the daemon resolves `adb`
	 * from a list of known locations rather than from `PATH` alone, so a check that still
	 * answered "is it on `PATH`" would warn about a machine Rover works on perfectly. Both read
	 * the same list, from `src/backends/android/adb-locations.mjs`.
	 */
	it.each([
		'ANDROID_HOME',
		'ANDROID_SDK_ROOT',
	])('says nothing when the SDK is named by %s rather than on PATH', {
		timeout: TEST_TIMEOUT_MS,
	}, async (variable) => {
		const sdk = await temporaryDirectory();
		await stubAdb(join(sdk, 'platform-tools'));

		const { stderr } = await runWith({ [variable]: sdk });

		expect(stderr).toBe('');
	});

	it('says nothing when the operator has named the adb to run', {
		timeout: TEST_TIMEOUT_MS,
	}, async () => {
		const stub = await stubAdb(await temporaryDirectory());

		const { stderr } = await runWith({ ROVER_ADB_PATH: stub });

		expect(stderr).toBe('');
	});

	it('says nothing when the SDK is in the standard place for this platform', {
		timeout: TEST_TIMEOUT_MS,
	}, async () => {
		const home = await temporaryDirectory();
		const platformTools =
			process.platform === 'darwin'
				? join(home, 'Library', 'Android', 'sdk', 'platform-tools')
				: join(home, 'Android', 'Sdk', 'platform-tools');
		await stubAdb(platformTools);

		const { stderr } = await runWith({ HOME: home, USERPROFILE: home });

		expect(stderr).toBe('');
	});

	it('names every place it looked, why it matters and where to look', {
		timeout: TEST_TIMEOUT_MS,
	}, async () => {
		const looked = await temporaryDirectory();

		const { stderr } = await runWith({ PATH: looked });

		expect(stderr).toContain('adb');
		expect(stderr).toContain(`2. PATH — ${looked}`);
		expect(stderr).toContain('3. ANDROID_HOME — not set');
		expect(stderr).toContain('4. ANDROID_SDK_ROOT — not set');
		expect(stderr).toContain('ROVER_ADB_PATH');
		expect(stderr).toContain('README.md');
		expect(stderr).toContain('Nothing on this machine was changed');
	});

	// `execFile`'s promise rejects on a non-zero exit, so resolving is the assertion here.
	it('never fails the install it is warning during', {
		timeout: TEST_TIMEOUT_MS,
	}, async () => {
		const { stdout, stderr } = await runWith({ PATH: await temporaryDirectory() });

		expect(stdout).toBe('');
		expect(stderr).not.toBe('');
	});

	it('warns rather than throwing when PATH is not set at all', {
		timeout: TEST_TIMEOUT_MS,
	}, async () => {
		const { stderr } = await runWith({ PATH: undefined });

		expect(stderr).toContain("no 'adb' was found");
	});

	// X_OK answers yes for every file on Windows, where PATHEXT is the test instead.
	it.skipIf(process.platform === 'win32')(
		'counts a non-executable adb as missing',
		{ timeout: TEST_TIMEOUT_MS },
		async () => {
			const { stderr } = await runWith({ PATH: await directoryWithAdb(0o644) });

			expect(stderr).toContain("no 'adb' was found");
		},
	);

	// Without this, renaming the script leaves a check that never runs and a suite that passes.
	it('is wired into npm install', async () => {
		const manifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));

		expect(manifest.scripts.postinstall).toBe('node scripts/check-adb.mjs');
		await expect(access(script)).resolves.toBeUndefined();
	});
});
