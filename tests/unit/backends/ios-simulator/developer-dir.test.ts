import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	DEVELOPER_DIR_ENV_VAR,
	developerDirSearchLocations,
	type ResolveDeveloperDirOptions,
	resolveDeveloperDir,
	SIMCTL_MISSING,
	SIMCTL_RELATIVE_PATH,
	SimctlNotFoundError,
} from '@/backends/ios-simulator/developer-dir.js';
import { InterruptionCauseSchema } from '@/core/device.js';

/**
 * Where the host looks for the developer directory, and what it accepts when it gets there.
 *
 * **No Xcode is assumed and none is read.** Every case passes `platform: 'darwin'` and points the
 * search at trees it built itself under `mkdtemp`, so nothing here consults the machine running
 * the suite and the whole file passes on a Linux CI runner. The stub `simctl` is deliberately not
 * a program — a plain text file carrying the execute bit — which is how "this module spawns no
 * process" is asserted rather than described: a search that ran its candidate would reject the
 * one every case below accepts.
 */

const BUNDLE_DEVELOPER_DIR = join('Contents', 'Developer');
const XCODE_DEVELOPER_DIR = join('Xcode.app', BUNDLE_DEVELOPER_DIR);

const SELECTION = 'the xcode-select selection';
const STANDARD_INSTALL = "this platform's standard Xcode install";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'rover-developer-dir-'));
	temporaryDirectories.push(directory);
	return directory;
}

/**
 * A directory that exists and holds nothing — what every candidate a case is not exercising is
 * pointed at, so an unset variable is never quietly answered by the operator's own Xcode.
 */
let nowhere = '';

beforeEach(async () => {
	nowhere = await temporaryDirectory();
});

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

/** Every place the search consults, accounted for and empty unless a case fills it in. */
function options(overrides: ResolveDeveloperDirOptions = {}): ResolveDeveloperDirOptions {
	return {
		platform: 'darwin',
		env: { [DEVELOPER_DIR_ENV_VAR]: '' },
		selectLinkPath: join(nowhere, 'xcode_select_link'),
		applicationsRoot: nowhere,
		...overrides,
	};
}

/** A developer directory at `directory`, holding a `simctl` this user may execute. */
async function withSimctl(directory: string, mode = 0o755): Promise<string> {
	const simctl = join(directory, SIMCTL_RELATIVE_PATH);
	await mkdir(dirname(simctl), { recursive: true });
	// Not a program, and never run — see this file's header.
	await writeFile(simctl, 'this file is not a program\n');
	await chmod(simctl, mode);
	return directory;
}

/** A developer directory somewhere of its own, holding a `simctl`. */
async function developerDirWithSimctl(mode = 0o755): Promise<string> {
	return await withSimctl(join(await temporaryDirectory(), 'Developer'), mode);
}

/**
 * An Xcode application bundle — the *other* form `xcrun` honours, where the developer directory is
 * `Contents/Developer` inside it and there is nothing at `usr/bin/simctl`.
 */
async function bundleWithSimctl(
	name = 'Xcode.app',
): Promise<{ bundle: string; developerDir: string }> {
	const bundle = join(await temporaryDirectory(), name);
	return { bundle, developerDir: await withSimctl(join(bundle, BUNDLE_DEVELOPER_DIR)) };
}

/**
 * The state `docs/IOS.md` §1 records, reproduced rather than described: a developer directory
 * that exists, is selectable, and holds no `simctl` at all.
 */
async function commandLineTools(): Promise<string> {
	const directory = join(await temporaryDirectory(), 'CommandLineTools');
	await mkdir(join(directory, 'usr', 'bin'), { recursive: true });
	return directory;
}

/** A `/var/db/xcode_select_link` of this suite's own, pointing wherever a case needs. */
async function selectionPointingAt(target: string): Promise<string> {
	const link = join(await temporaryDirectory(), 'xcode_select_link');
	await symlink(target, link);
	return link;
}

/** The message a person is actually shown, and the assertion that they were shown one. */
function failureMessage(searched: ResolveDeveloperDirOptions): string {
	let thrown: unknown;
	try {
		resolveDeveloperDir(searched);
	} catch (error: unknown) {
		thrown = error;
	}

	expect(thrown).toBeInstanceOf(SimctlNotFoundError);
	return (thrown as SimctlNotFoundError).message;
}

// Symlinks need a privilege on Windows that a test runner does not reliably have, and the
// execute bit means nothing there — the platform under test is passed in, but the filesystem
// these cases build is the host's own.
describe.skipIf(process.platform === 'win32')('the order the host looks in', () => {
	// The order is the whole claim, so it is one `toEqual` rather than three.
	it('is DEVELOPER_DIR, then the xcode-select selection, then the standard Xcode install', async () => {
		const locations = developerDirSearchLocations(
			options({
				env: { [DEVELOPER_DIR_ENV_VAR]: '/named/by/the/operator' },
				selectLinkPath: await selectionPointingAt('/selected/by/xcode-select'),
				applicationsRoot: '/Applications',
			}),
		);

		expect(locations.map(({ source, path }) => [source, path])).toEqual([
			[DEVELOPER_DIR_ENV_VAR, '/named/by/the/operator'],
			[SELECTION, '/selected/by/xcode-select'],
			[STANDARD_INSTALL, join('/Applications', XCODE_DEVELOPER_DIR)],
		]);
	});

	/**
	 * A place that named nothing stays on the list, so position 2 means the same place on every
	 * machine — see the interface's docblock, and `describeAdbSearch` before it.
	 */
	it('keeps a place that named nothing on the list rather than dropping it', () => {
		const locations = developerDirSearchLocations(options({ applicationsRoot: '/Applications' }));

		expect(locations.map(({ path }) => path)).toEqual([
			null,
			null,
			join('/Applications', XCODE_DEVELOPER_DIR),
		]);
	});

	// Empty counts as unset, as it does for every other variable Rover reads.
	it('reads a blank DEVELOPER_DIR as unset rather than as a path', () => {
		expect(developerDirSearchLocations(options())[0]?.path).toBeNull();
	});

	/**
	 * `/var/db/xcode_select_link` is the durable form of `xcode-select -p` rather than a
	 * documented interface, so a machine where there is nothing to read there must still search
	 * the standard install behind it.
	 */
	it('walks past a selection there is nothing to read', async () => {
		const notALink = await temporaryDirectory();

		const locations = developerDirSearchLocations(
			options({ selectLinkPath: notALink, applicationsRoot: '/Applications' }),
		);

		expect(locations[1]?.path).toBeNull();
		expect(locations[2]?.path).toBe(join('/Applications', XCODE_DEVELOPER_DIR));
	});

	it('resolves a relative selection against the link’s own directory', async () => {
		const link = await selectionPointingAt(XCODE_DEVELOPER_DIR);

		expect(developerDirSearchLocations(options({ selectLinkPath: link }))[1]?.path).toBe(
			join(dirname(link), XCODE_DEVELOPER_DIR),
		);
	});

	/**
	 * The same directory reached two ways is the ordinary case, and each row still says which
	 * place reached it — the reason this list stopped deduplicating, in the function's docblock.
	 */
	it('names the same directory from both places when DEVELOPER_DIR repeats the selection', async () => {
		const selected = join('/Applications', XCODE_DEVELOPER_DIR);

		const locations = developerDirSearchLocations(
			options({
				env: { [DEVELOPER_DIR_ENV_VAR]: selected },
				selectLinkPath: await selectionPointingAt(selected),
				applicationsRoot: '/Applications',
			}),
		);

		expect(locations.map(({ source, path }) => [source, path])).toEqual([
			[DEVELOPER_DIR_ENV_VAR, selected],
			[SELECTION, selected],
			[STANDARD_INSTALL, selected],
		]);
	});

	/**
	 * Off macOS there is no developer directory to find, whatever the environment says — which is
	 * what makes this suite portable and what makes the failure below fire on a CI runner.
	 */
	it('is empty off macOS, whatever the environment says', async () => {
		expect(
			developerDirSearchLocations(
				options({
					platform: 'linux',
					env: { [DEVELOPER_DIR_ENV_VAR]: '/named/by/the/operator' },
					selectLinkPath: await selectionPointingAt('/selected/by/xcode-select'),
				}),
			),
		).toEqual([]);
	});
});

describe.skipIf(process.platform === 'win32')('accepting a developer directory', () => {
	// The stub is a text file with the execute bit: accepting it *is* the assertion that this
	// module verifies by asking the filesystem rather than by running what it finds.
	it('answers with the DEVELOPER_DIR that holds simctl', async () => {
		const named = await developerDirWithSimctl();

		expect(resolveDeveloperDir(options({ env: { [DEVELOPER_DIR_ENV_VAR]: named } }))).toBe(named);
	});

	/**
	 * The other form `xcrun` honours — `DEVELOPER_DIR=/Applications/Xcode.app`, where `simctl`
	 * lives one `Contents/Developer` deeper and `<bundle>/usr/bin/simctl` does not exist at all.
	 */
	it('answers with the developer directory inside a DEVELOPER_DIR naming the bundle', async () => {
		const { bundle, developerDir } = await bundleWithSimctl();

		expect(resolveDeveloperDir(options({ env: { [DEVELOPER_DIR_ENV_VAR]: bundle } }))).toBe(
			developerDir,
		);
	});

	/**
	 * The escape hatch has to win, which is the whole point of it: an operator naming a second
	 * Xcode must not silently get the one in `/Applications`.
	 */
	it('keeps a bundle-shaped DEVELOPER_DIR ahead of a working standard install', async () => {
		const { bundle, developerDir } = await bundleWithSimctl('Xcode-beta.app');
		const applications = await temporaryDirectory();
		await withSimctl(join(applications, XCODE_DEVELOPER_DIR));

		expect(
			resolveDeveloperDir(
				options({ env: { [DEVELOPER_DIR_ENV_VAR]: bundle }, applicationsRoot: applications }),
			),
		).toBe(developerDir);
	});

	it('takes the xcode-select selection when DEVELOPER_DIR is unset', async () => {
		const selected = await developerDirWithSimctl();

		expect(
			resolveDeveloperDir(options({ selectLinkPath: await selectionPointingAt(selected) })),
		).toBe(selected);
	});

	// `xcode-select --switch` infers the developer directory from a bundle before storing it, so
	// this is the safety net for a link written by anything else.
	it('answers with the developer directory inside a selection naming the bundle', async () => {
		const { bundle, developerDir } = await bundleWithSimctl();

		expect(
			resolveDeveloperDir(options({ selectLinkPath: await selectionPointingAt(bundle) })),
		).toBe(developerDir);
	});

	it('takes the standard install when nothing else answers', async () => {
		const applications = await temporaryDirectory();
		const xcode = await withSimctl(join(applications, XCODE_DEVELOPER_DIR));

		expect(resolveDeveloperDir(options({ applicationsRoot: applications }))).toBe(xcode);
	});

	/**
	 * The failure `docs/IOS.md` §1 hit: `xcode-select` pointed at the Command Line Tools, which
	 * exist and hold no `simctl`. The existence of a developer directory proves nothing, so a
	 * selection that cannot answer must never shadow the Xcode behind it.
	 */
	it('walks past a developer directory that exists and holds no simctl', async () => {
		const applications = await temporaryDirectory();
		const xcode = await withSimctl(join(applications, XCODE_DEVELOPER_DIR));

		expect(
			resolveDeveloperDir(
				options({
					selectLinkPath: await selectionPointingAt(await commandLineTools()),
					applicationsRoot: applications,
				}),
			),
		).toBe(xcode);
	});

	/** A `simctl` this user cannot execute is *not found*, and the sequence continues past it. */
	it('walks past a simctl it cannot execute', async () => {
		const unrunnable = await developerDirWithSimctl(0o644);
		const working = await developerDirWithSimctl();

		expect(
			resolveDeveloperDir(
				options({
					env: { [DEVELOPER_DIR_ENV_VAR]: unrunnable },
					selectLinkPath: await selectionPointingAt(working),
				}),
			),
		).toBe(working);
	});
});

describe.skipIf(process.platform === 'win32')('the failure, told to a person', () => {
	/**
	 * Not one opaque "unable to find utility simctl" per verb: every place that was looked in, in
	 * the order it was tried, and the variable that overrides all of them.
	 */
	it('names every place it looked, in order, and the variable that overrides them', async () => {
		const selected = await commandLineTools();
		// `applicationsRoot` is left at the empty directory `options` defaults it to: pointing the
		// last candidate at the real `/Applications` would answer this case out of the Xcode of
		// whoever is running the suite.
		const message = failureMessage(
			options({
				env: { [DEVELOPER_DIR_ENV_VAR]: '/named/by/the/operator' },
				selectLinkPath: await selectionPointingAt(selected),
			}),
		);

		expect(message).toContain(
			`1. ${DEVELOPER_DIR_ENV_VAR} — ${join('/named/by/the/operator', SIMCTL_RELATIVE_PATH)}`,
		);
		expect(message).toContain(`2. ${SELECTION} — ${join(selected, SIMCTL_RELATIVE_PATH)}`);
		expect(message).toContain(
			`3. ${STANDARD_INSTALL} — ${join(nowhere, XCODE_DEVELOPER_DIR, SIMCTL_RELATIVE_PATH)}`,
		);
		expect(message).toContain(`Set ${DEVELOPER_DIR_ENV_VAR}`);
		expect(message).toContain('the Command Line Tools alone do not carry simctl');
	});

	/**
	 * The ordinary state of the machine this failure fires on: no variable, no selection to read.
	 * The three rows still number the same three places, so *nothing was set* is told rather than
	 * left for the reader to infer from a one-line list.
	 */
	it('says which places named nothing rather than leaving them off the list', () => {
		const selectLinkPath = join(nowhere, 'xcode_select_link');

		const message = failureMessage(options({ selectLinkPath }));

		expect(message).toContain(`1. ${DEVELOPER_DIR_ENV_VAR} — not set`);
		expect(message).toContain(`2. ${SELECTION} — nothing to read at ${selectLinkPath}`);
		expect(message).toContain(
			`3. ${STANDARD_INSTALL} — ${join(nowhere, XCODE_DEVELOPER_DIR, SIMCTL_RELATIVE_PATH)}`,
		);
	});

	/** The path named is the one that was really stat'd, bundle normalisation included. */
	it('names the simctl a bundle-shaped candidate was actually checked for', async () => {
		const bundle = join(await temporaryDirectory(), 'Xcode.app');
		await mkdir(join(bundle, BUNDLE_DEVELOPER_DIR, 'usr', 'bin'), { recursive: true });

		const message = failureMessage(options({ env: { [DEVELOPER_DIR_ENV_VAR]: bundle } }));

		expect(message).toContain(
			`1. ${DEVELOPER_DIR_ENV_VAR} — ${join(bundle, BUNDLE_DEVELOPER_DIR, SIMCTL_RELATIVE_PATH)}`,
		);
	});

	// Off macOS the search is empty, and a list of nothing needs saying so rather than trailing off.
	it('says there was nowhere to look off macOS', () => {
		expect(() => resolveDeveloperDir(options({ platform: 'linux' }))).toThrow(
			/this host is not macOS/,
		);
	});
});

/**
 * The cause a caller reports once this search comes up empty. Not the tautology of comparing a
 * constant with its own literal: it is checked against the shared schema, which is what makes
 * `tooling-missing` and a non-empty `tool` a claim rather than a convention.
 */
it('reports a tooling-missing interruption naming simctl', () => {
	expect(InterruptionCauseSchema.parse(SIMCTL_MISSING)).toEqual({
		cause: 'tooling-missing',
		tool: 'simctl',
	});
});
