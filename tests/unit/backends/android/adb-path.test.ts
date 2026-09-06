import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	ADB_PATH_ENV_VAR,
	adbCandidates,
	adbSearchLocations,
	describeAdbSearch,
	findAdb,
} from '@/backends/android/adb-locations.mjs';
import { AdbNotFoundError, resolveAdb } from '@/backends/android/adb-path.js';

/**
 * Where the host looks for `adb`, and what it accepts when it gets there (#171).
 *
 * Two halves, and they are tested differently on purpose. The **order** is arithmetic over an
 * environment and needs no machine at all, so those cases pass one in — which is also the only
 * way to say what the search looks like on a platform that is not the one running the suite.
 * The **acceptance** is the opposite: its whole subject is that a file exists, is executable and
 * runs, so those cases build real stubs in a `mkdtemp` directory and let the resolver execute
 * them. Nothing here touches the operator's own SDK, and no case reads `process.env` without
 * replacing every variable the search consults.
 */

const HOME = '/home/operator';

/**
 * `os.homedir()` is stubbed rather than `$HOME`, because the unit project runs in worker
 * threads: `process.env` is a per-thread copy there, so setting `HOME` in one changes nothing
 * that libuv — and therefore `homedir()` — reads. Without this the standard-SDK-location
 * candidate would resolve against whoever is running the suite, and the two cases that need a
 * machine with no `adb` on it would pass or fail depending on the operator's own SDK.
 */
const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<() => string>() }));

vi.mock('node:os', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:os')>()),
	homedir: homedirMock,
}));

beforeEach(() => {
	homedirMock.mockReturnValue(HOME);
});

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'rover-adb-path-'));
	temporaryDirectories.push(directory);
	return directory;
}

/**
 * An `adb` that behaves: exits 0 for `version`, and records that it was run.
 *
 * Written as a shell script rather than a copy of a real binary so the suite needs no SDK, and
 * so "was this actually executed?" is a question the file itself can answer.
 */
async function workingAdb(directory: string, name = 'adb'): Promise<string> {
	const stub = join(directory, name);
	const log = `${stub}.runs`;
	await writeFile(stub, `#!/bin/sh\necho run >> '${log}'\necho 'Android Debug Bridge'\n`);
	await chmod(stub, 0o755);
	return stub;
}

/** How many times a stub built by {@link workingAdb} has been executed. */
async function runsOf(stub: string): Promise<number> {
	const log = await readFile(`${stub}.runs`, 'utf8').catch(() => '');
	return log.split('\n').filter((line) => line !== '').length;
}

/** A file named `adb` that will not run: present, executable, and exits non-zero. */
async function brokenAdb(directory: string): Promise<string> {
	const stub = join(directory, 'adb');
	await writeFile(stub, '#!/bin/sh\nexit 1\n');
	await chmod(stub, 0o755);
	return stub;
}

/** A file named `adb` that is not executable at all. */
async function unrunnableAdb(directory: string): Promise<string> {
	const stub = join(directory, 'adb');
	await writeFile(stub, '#!/bin/sh\nexit 0\n');
	await chmod(stub, 0o644);
	return stub;
}

/**
 * An environment with every variable the search consults accounted for.
 *
 * Spelling out the empty ones matters: a case that only set `PATH` would be quietly answered by
 * the `ANDROID_HOME` of whoever ran the suite.
 */
function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		ROVER_ADB_PATH: '',
		PATH: '',
		ANDROID_HOME: '',
		ANDROID_SDK_ROOT: '',
		...overrides,
	};
}

function order(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = 'linux'): string[] {
	return adbCandidates(env, platform, HOME).map((candidate) => candidate.path);
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe('the order the host looks in', () => {
	// The documented order, and the assertion the README's own list is checked against. It is
	// one `toEqual` rather than five, because the order is the whole claim.
	it('is the operator’s setting, then PATH, then the SDK variables, then the standard place', () => {
		expect(
			order(
				environment({
					ROVER_ADB_PATH: '/named/by/the/operator/adb',
					PATH: '/bin:/usr/local/bin',
					ANDROID_HOME: '/sdk/from/android-home',
					ANDROID_SDK_ROOT: '/sdk/from/android-sdk-root',
				}),
			),
		).toEqual([
			'/named/by/the/operator/adb',
			'/bin/adb',
			'/usr/local/bin/adb',
			'/sdk/from/android-home/platform-tools/adb',
			'/sdk/from/android-sdk-root/platform-tools/adb',
			'/home/operator/Android/Sdk/platform-tools/adb',
		]);
	});

	/**
	 * The setting names the executable, not the SDK it came from: an `adb` somewhere unusual is
	 * the case it exists for, and "unusual" includes a layout with no `platform-tools` in it.
	 */
	it('takes the operator’s setting as the file to run, verbatim', () => {
		expect(order(environment({ ROVER_ADB_PATH: '/opt/tools/adb-37' }))[0]).toBe(
			'/opt/tools/adb-37',
		);
	});

	it.each([
		['darwin', '/home/operator/Library/Android/sdk/platform-tools/adb'],
		['linux', '/home/operator/Android/Sdk/platform-tools/adb'],
	] as const)('ends at the standard SDK location for %s', (platform, expected) => {
		expect(order(environment(), platform)).toEqual([expected]);
	});

	// A bare name is not executable on Windows, so `PATHEXT` decides what counts as `adb` —
	// and the SDK's own directory is under `%LOCALAPPDATA%` rather than the home directory.
	it('expands PATHEXT and reads LOCALAPPDATA on Windows', () => {
		const candidates = order(
			environment({ PATH: 'C:\\tools', LOCALAPPDATA: '/local', PATHEXT: '.EXE;.BAT' }),
			'win32',
		);

		expect(candidates).toEqual([
			join('C:\\tools', 'adb.exe'),
			join('C:\\tools', 'adb.bat'),
			join('/local', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
			join('/local', 'Android', 'Sdk', 'platform-tools', 'adb.bat'),
		]);
	});

	// Empty counts as unset, as it does for every other variable in the catalogue: an
	// exported-but-blank variable is what a shell leaves behind.
	it('reads a blank variable as unset rather than as a path', () => {
		expect(order(environment({ ROVER_ADB_PATH: '', ANDROID_HOME: '' }))).toEqual([
			'/home/operator/Android/Sdk/platform-tools/adb',
		]);
	});

	/**
	 * An empty `PATH` entry means the working directory on POSIX. The daemon's working
	 * directory is inherited from whichever client autostarted it (D5), so an `adb` sitting in
	 * it is not a machine that has `adb`.
	 */
	it('never treats an empty PATH entry as the working directory', () => {
		expect(order(environment({ PATH: ':/bin:' }))).toEqual([
			'/bin/adb',
			'/home/operator/Android/Sdk/platform-tools/adb',
		]);
	});

	/**
	 * The property the issue rules out explicitly: the list is bounded and derived from the
	 * environment, so no amount of `adb` elsewhere on the disk can be picked up. A developer
	 * machine holds several at different versions, and choosing one by scanning would disrupt
	 * whichever adb server another tool is already talking to.
	 */
	it('is a bounded list, so an adb somewhere else on the disk is never a candidate', async () => {
		const home = await temporaryDirectory();
		const elsewhere = join(home, 'Downloads', 'platform-tools');
		await mkdir(elsewhere, { recursive: true });
		await workingAdb(elsewhere);

		const candidates = adbCandidates(environment(), process.platform, home);

		expect(candidates).toHaveLength(1);
		expect(findAdb(environment(), process.platform, home)).toBeNull();
	});
});

describe('the search, described for a person', () => {
	it('numbers every place in the order it was tried, and says which are unset', () => {
		const lines = describeAdbSearch(
			adbSearchLocations(environment({ PATH: '/bin', ANDROID_HOME: '/sdk' }), 'linux', HOME),
		);

		expect(lines).toEqual([
			`1. ${ADB_PATH_ENV_VAR} — not set`,
			'2. PATH — /bin',
			'3. ANDROID_HOME — /sdk/platform-tools/adb',
			'4. ANDROID_SDK_ROOT — not set',
			"5. this platform's standard Android SDK location — " +
				'/home/operator/Android/Sdk/platform-tools/adb',
		]);
	});

	// The directories, not one `…/adb` per entry: on Windows the PATHEXT expansion would
	// otherwise print the same directory four times over.
	it('shows PATH as the directories it searched', () => {
		const [, path] = describeAdbSearch(
			adbSearchLocations(environment({ PATH: 'C:\\a;C:\\b', PATHEXT: '.EXE;.BAT' }), 'win32', HOME),
		);

		expect(path).toBe('2. PATH — C:\\a, C:\\b');
	});
});

// The stubs are executed, and a shell script is not something Windows runs.
describe.skipIf(process.platform === 'win32')('accepting a candidate', () => {
	it('answers with the first candidate that actually runs', async () => {
		const directory = await temporaryDirectory();
		const stub = await workingAdb(directory);

		await expect(resolveAdb({ env: environment({ PATH: directory }), home: HOME })).resolves.toBe(
			stub,
		);
		expect(await runsOf(stub)).toBe(1);
	});

	/**
	 * A path that exists but cannot be executed is *not found*, and the sequence continues:
	 * a leftover early in the order must never shadow a working `adb` later in it.
	 */
	it('walks past a file it cannot execute', async () => {
		const first = await temporaryDirectory();
		const second = await temporaryDirectory();
		await unrunnableAdb(first);
		const stub = await workingAdb(second);

		await expect(
			resolveAdb({ env: environment({ PATH: `${first}:${second}` }), home: HOME }),
		).resolves.toBe(stub);
	});

	/**
	 * Mode bits are not the question a daemon needs answered. A binary for the wrong
	 * architecture, or a wrapper whose interpreter is gone, passes every `stat` and fails every
	 * verb afterwards — so the candidate is asked for its version and judged on the answer.
	 */
	it('walks past an executable that does not answer as an adb client', async () => {
		const first = await temporaryDirectory();
		const second = await temporaryDirectory();
		await brokenAdb(first);
		const stub = await workingAdb(second);

		await expect(
			resolveAdb({ env: environment({ PATH: `${first}:${second}` }), home: HOME }),
		).resolves.toBe(stub);
	});

	// The operator's setting is first, so it wins over an SDK that is on PATH as well.
	it('lets the operator’s setting override everything else', async () => {
		const named = await temporaryDirectory();
		const onPath = await temporaryDirectory();
		const stub = await workingAdb(named, 'adb-37');
		await workingAdb(onPath);

		await expect(
			resolveAdb({ env: environment({ [ADB_PATH_ENV_VAR]: stub, PATH: onPath }), home: HOME }),
		).resolves.toBe(stub);
	});

	/**
	 * The failure the issue is really about: not `spawn adb ENOENT` once per verb, but one
	 * message naming every place that was tried and the setting that overrides them. It is the
	 * same list `npm install` prints, from the same code.
	 */
	it('names every location it tried, and the setting that overrides them', async () => {
		const empty = await temporaryDirectory();
		const env = environment({ PATH: empty });

		const error = await resolveAdb({ env, home: HOME }).then(
			() => null,
			(thrown: unknown) => thrown,
		);

		expect(error).toBeInstanceOf(AdbNotFoundError);
		const { message } = error as AdbNotFoundError;
		expect(message).toContain(`1. ${ADB_PATH_ENV_VAR} — not set`);
		expect(message).toContain(`2. PATH — ${empty}`);
		expect(message).toContain('3. ANDROID_HOME — not set');
		expect(message).toContain('4. ANDROID_SDK_ROOT — not set');
		// Every location, including the standard one, whose path is this platform's — which is
		// why it is compared against the described search rather than written out again here.
		for (const line of describeAdbSearch(adbSearchLocations(env, process.platform, HOME))) {
			expect(message).toContain(line);
		}
		expect(message).toContain(`Set ${ADB_PATH_ENV_VAR}`);
	});
});

/**
 * The memo, which is the whole of "once per daemon lifetime, held in memory".
 *
 * Each case re-imports the module so it starts with the memo empty — the state under test is
 * module-level on purpose, because a resolved path is exactly the re-derivable state D6 forbids
 * the daemon from writing down.
 */
describe.skipIf(process.platform === 'win32')('resolving once per daemon lifetime', () => {
	async function freshResolver() {
		vi.resetModules();
		return await import('@/backends/android/adb-path.js');
	}

	function pointAt(directory: string, home: string): void {
		// The memo takes no arguments — it is the daemon's one answer — so the machine it reads
		// has to be replaced around it rather than passed to it.
		homedirMock.mockReturnValue(home);
		vi.stubEnv('PATH', directory);
		vi.stubEnv(ADB_PATH_ENV_VAR, '');
		vi.stubEnv('ANDROID_HOME', '');
		vi.stubEnv('ANDROID_SDK_ROOT', '');
	}

	it('runs the search once however many callers ask', async () => {
		const directory = await temporaryDirectory();
		const home = await temporaryDirectory();
		const stub = await workingAdb(directory);
		pointAt(directory, home);
		const { adbExecutable } = await freshResolver();

		const [first, second] = await Promise.all([adbExecutable(), adbExecutable()]);
		await adbExecutable();

		expect(first).toBe(stub);
		expect(second).toBe(stub);
		expect(await runsOf(stub)).toBe(1);
	});

	/** D6: the only durable form of the answer is the operator's own setting. */
	it('writes nothing to disk', async () => {
		const directory = await temporaryDirectory();
		const home = await temporaryDirectory();
		await workingAdb(directory);
		pointAt(directory, home);
		const { adbExecutable } = await freshResolver();

		await adbExecutable();

		expect(await readdir(home)).toEqual([]);
	});

	/**
	 * A failure is deliberately not memoised, where a success is: `./backend.ts` restarts its
	 * device tracker on a backoff precisely so an `adb` arriving on a running daemon's machine
	 * is picked up, and remembering the first answer of a daemon's life would make it the only
	 * one.
	 */
	it('looks again after a search that found nothing', async () => {
		const directory = await temporaryDirectory();
		const home = await temporaryDirectory();
		pointAt(directory, home);
		// The re-import brings a fresh class with it, so the failure is matched against that
		// module's own rather than against the one this file imported at the top.
		const { adbExecutable, AdbNotFoundError: NotFound } = await freshResolver();

		await expect(adbExecutable()).rejects.toBeInstanceOf(NotFound);
		const stub = await workingAdb(directory);

		await expect(adbExecutable()).resolves.toBe(stub);
	});
});
