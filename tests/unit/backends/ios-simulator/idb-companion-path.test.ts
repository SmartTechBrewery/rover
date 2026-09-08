import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	IDB_COMPANION,
	IDB_COMPANION_MISSING,
	IDB_COMPANION_PATH_ENV_VAR,
	IdbCompanionNotFoundError,
	idbCompanionSearchLocations,
	resolveIdbCompanion,
} from '@/backends/ios-simulator/idb-companion-path.js';
import { InterruptionCauseSchema } from '@/core/device.js';

/**
 * Where the host looks for `idb_companion`, and what it accepts when it gets there.
 *
 * **No idb is assumed and none is read.** Every case passes `platform: 'darwin'` and an `env`
 * that replaces every variable the search consults, pointing it at trees built under `mkdtemp`,
 * so nothing here consults the machine running the suite and the whole file passes on a Linux CI
 * runner and on a Mac that has never had idb. The stub companion is deliberately **not a
 * program** — a plain text file carrying the execute bit — which is how "this module spawns no
 * process" is asserted rather than described: a search that ran its candidate would reject the
 * one every case below accepts, and a search that ran a *real* companion would leave a process
 * behind.
 */

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'rover-idb-companion-'));
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

/** Every variable the search consults, set to nothing unless a case fills it in. */
function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return { [IDB_COMPANION_PATH_ENV_VAR]: '', PATH: '', ...overrides };
}

/** A directory holding an `idb_companion` this user may execute — see this file's header. */
async function directoryWithCompanion(mode = 0o755): Promise<string> {
	const directory = await temporaryDirectory();
	const companion = join(directory, IDB_COMPANION);
	await writeFile(companion, 'this file is not a program\n');
	await chmod(companion, mode);
	return directory;
}

/** The message a person is actually shown, and the assertion that they were shown one. */
function failureMessage(environment: NodeJS.ProcessEnv): string {
	let thrown: unknown;
	try {
		resolveIdbCompanion({ env: environment, platform: 'darwin' });
	} catch (error: unknown) {
		thrown = error;
	}

	expect(thrown).toBeInstanceOf(IdbCompanionNotFoundError);
	return (thrown as IdbCompanionNotFoundError).message;
}

describe('the order the host looks in', () => {
	// The order is the whole claim, so it is one `toEqual` rather than three.
	it('is ROVER_IDB_COMPANION_PATH, then every PATH entry in order', () => {
		const locations = idbCompanionSearchLocations(
			env({
				[IDB_COMPANION_PATH_ENV_VAR]: '/named/by/the/operator/idb_companion',
				PATH: '/first:/second',
			}),
			'darwin',
		);

		expect(locations.map(({ source, path }) => [source, path])).toEqual([
			[IDB_COMPANION_PATH_ENV_VAR, '/named/by/the/operator/idb_companion'],
			['PATH', join('/first', IDB_COMPANION)],
			['PATH', join('/second', IDB_COMPANION)],
		]);
	});

	/**
	 * The override names the executable, not a directory it came from — `ROVER_ADB_PATH`'s rule,
	 * and the whole reason it is usable for a tarball unpacked under a name of the operator's
	 * choosing.
	 */
	it('takes the override verbatim, appending nothing to it', () => {
		const named = '/scratch/idb-1.5.2/companion-binary';

		expect(
			idbCompanionSearchLocations(env({ [IDB_COMPANION_PATH_ENV_VAR]: named }), 'darwin')[0]?.path,
		).toBe(named);
	});

	// Empty counts as unset, as it does for every other variable Rover reads.
	it('reads a blank ROVER_IDB_COMPANION_PATH as unset rather than as a path', () => {
		expect(idbCompanionSearchLocations(env(), 'darwin')[0]?.path).toBeNull();
	});

	/**
	 * A place that named nothing stays on the list, so *"this variable is not set"* — the
	 * actionable half of the failure — survives to the message.
	 */
	it('keeps the unset override on the list rather than dropping it', () => {
		const locations = idbCompanionSearchLocations(env({ PATH: '/first' }), 'darwin');

		expect(locations).toHaveLength(2);
		expect(locations[0]).toEqual({
			source: IDB_COMPANION_PATH_ENV_VAR,
			path: null,
			absent: 'not set',
		});
	});

	/**
	 * An empty `PATH` entry is the working directory on POSIX, and the daemon's working directory
	 * came from whichever client autostarted it (`../android/adb-locations.mjs`, D5).
	 */
	it('skips an empty PATH entry rather than searching the working directory', () => {
		const locations = idbCompanionSearchLocations(env({ PATH: '/first::/second:' }), 'darwin');

		expect(locations.map(({ path }) => path)).toEqual([
			null,
			join('/first', IDB_COMPANION),
			join('/second', IDB_COMPANION),
		]);
	});

	/**
	 * There is no companion to find off macOS, and an empty list here is what lets every suite in
	 * this folder run unchanged on a Linux CI runner.
	 */
	it('looks nowhere at all off macOS, even with the override set', () => {
		const environment = env({
			[IDB_COMPANION_PATH_ENV_VAR]: '/named/by/the/operator/idb_companion',
			PATH: '/first',
		});

		expect(idbCompanionSearchLocations(environment, 'linux')).toEqual([]);
		expect(idbCompanionSearchLocations(environment, 'win32')).toEqual([]);
	});
});

// The execute bit means nothing on Windows, and the platform under test is passed in while the
// filesystem these cases build is the host's own.
describe.skipIf(process.platform === 'win32')('what it accepts when it gets there', () => {
	it('answers with the companion the override names', async () => {
		const directory = await directoryWithCompanion();

		expect(
			resolveIdbCompanion({
				env: env({ [IDB_COMPANION_PATH_ENV_VAR]: join(directory, IDB_COMPANION) }),
				platform: 'darwin',
			}),
		).toBe(join(directory, IDB_COMPANION));
	});

	it('answers with the first PATH entry holding one', async () => {
		const empty = await temporaryDirectory();
		const holding = await directoryWithCompanion();

		expect(
			resolveIdbCompanion({ env: env({ PATH: `${empty}:${holding}` }), platform: 'darwin' }),
		).toBe(join(holding, IDB_COMPANION));
	});

	/**
	 * A broken leftover early in the order must never shadow a working binary later in it — the
	 * reason `isExecutableFile` reports *not found* rather than refusing outright.
	 */
	it('walks past a companion this user may not execute', async () => {
		const unreadable = await directoryWithCompanion(0o644);
		const holding = await directoryWithCompanion();

		expect(
			resolveIdbCompanion({
				env: env({
					[IDB_COMPANION_PATH_ENV_VAR]: join(unreadable, IDB_COMPANION),
					PATH: holding,
				}),
				platform: 'darwin',
			}),
		).toBe(join(holding, IDB_COMPANION));
	});

	it('walks past a directory named idb_companion', async () => {
		const withDirectory = await temporaryDirectory();
		await mkdir(join(withDirectory, IDB_COMPANION));
		const holding = await directoryWithCompanion();

		expect(
			resolveIdbCompanion({
				env: env({ PATH: `${withDirectory}:${holding}` }),
				platform: 'darwin',
			}),
		).toBe(join(holding, IDB_COMPANION));
	});

	/**
	 * The failure names each place in the order it was tried, the unset override included: that
	 * row is what tells an operator the one thing they can do about it.
	 */
	it('names every place in order when nothing held one, the unset override included', async () => {
		const first = await temporaryDirectory();
		const second = await temporaryDirectory();

		const message = failureMessage(env({ PATH: `${first}:${second}` }));

		expect(message).toContain(`1. ${IDB_COMPANION_PATH_ENV_VAR} — not set`);
		expect(message).toContain(`2. PATH — ${join(first, IDB_COMPANION)}`);
		expect(message).toContain(`3. PATH — ${join(second, IDB_COMPANION)}`);
		expect(message).toContain(IDB_COMPANION_PATH_ENV_VAR);
	});

	/**
	 * Off macOS the list is empty, and a failure that just printed no rows would read as though
	 * nothing had been checked — `SimctlNotFoundError`'s line, adapted.
	 */
	it('says there was nowhere to look off macOS', () => {
		let thrown: unknown;
		try {
			resolveIdbCompanion({ env: env({ PATH: '/first' }), platform: 'linux' });
		} catch (error: unknown) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(IdbCompanionNotFoundError);
		expect((thrown as Error).message).toContain('nowhere');
		expect((thrown as Error).message).toContain('not macOS');
	});
});

/**
 * The interruption a caller reports, asserted where it is decided rather than where it is
 * rendered: it has to be the `tooling-missing` cause naming this program, not a generic
 * interruption.
 */
describe('the interruption a caller reports', () => {
	it('is tooling-missing, naming idb_companion, and parses as an InterruptionCause', () => {
		expect(InterruptionCauseSchema.parse(IDB_COMPANION_MISSING)).toEqual({
			cause: 'tooling-missing',
			tool: 'idb_companion',
		});
		expect(IDB_COMPANION_MISSING.tool).toBe(IDB_COMPANION);
	});
});
