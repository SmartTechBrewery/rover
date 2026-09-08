/**
 * Which developer directory this backend will drive `simctl` from, located and **verified**
 * (`docs/IOS.md` §1).
 *
 * **Verified by asking the filesystem, not by running the binary** — the one deliberate
 * departure from `../android/adb-path.ts`, which accepts a candidate only once it has answered
 * `adb version`. For this failure mode the cheaper test is also the sharper one. Every
 * measurement in `docs/IOS.md` was taken on a machine whose `xcode-select -p` pointed at
 * `/Library/Developer/CommandLineTools`, where `xcrun simctl` fails with *"unable to find utility
 * simctl"*; that directory is still present on this one — macOS 26.6.2 (25G83), 2026-09-08 — and
 * still holds no `usr/bin/simctl`. That is the state a Mac is most likely to be in while looking
 * fully equipped, so the existence of a developer directory proves nothing and the utility inside
 * it is the whole question. A version call would answer it no better and would cost this module
 * the property that makes it importable anywhere: **nothing here spawns a process**, so the
 * search is `stat`, `access` and `readlink`, and a machine that has never had Xcode can run every
 * suite over it.
 *
 * **`/var/db/xcode_select_link` is the durable form of `xcode-select -p`, not a documented
 * interface.** It is a symlink to the selected developer directory — verified on macOS 26.6.2
 * (25G83), 2026-09-08, pointing at `/Applications/Xcode.app/Contents/Developer` — which is what
 * lets the operator's own selection be read with no process at all. Should Apple move it, the
 * candidate simply stops resolving and the standard install location behind it still answers, so
 * the cost of the assumption being wrong is bounded to losing a non-default selection.
 *
 * **`DEVELOPER_DIR` is Apple's variable, not a Rover setting.** Nothing new is being configured
 * here (ai/RULES.md §7): `xcrun` already honours it, every measurement in `docs/IOS.md` was
 * taken through it, and honouring it is what makes a machine whose `xcode-select` points at the
 * Command Line Tools workable at all.
 *
 * **Both forms of that variable are honoured, because `xcrun` honours both** — `xcode-select(1)`
 * says so ("You can set the environment variable to either the actual Developer contents
 * directory, or the Xcode application directory") and this bench measured what the shims actually
 * do with it, on macOS 26.6.2 (25G83), 2026-09-08. `DEVELOPER_DIR=/Applications/Xcode.app
 * xcrun --find simctl` prints `/Applications/Xcode.app/Contents/Developer/usr/bin/simctl` while
 * `/Applications/Xcode.app/usr/bin/simctl` does not exist, so a search that only ever appended
 * `usr/bin/simctl` would walk straight past the one escape hatch this module has — and an operator
 * who set `DEVELOPER_DIR=/Applications/Xcode-beta.app` to force the beta's simulator tooling would
 * silently get a different Xcode's. **The rule is not a `.app` suffix test**: pointed at a
 * *non*-bundle directory holding `Contents/Developer`, `xcrun` reported that inner path too, and
 * pointed at a `…app` holding `usr/bin` and no `Contents/Developer` it reported the path verbatim.
 * So {@link developerDirIn} normalises a candidate to the `Contents/Developer` inside it **when
 * there is one**, exactly as measured, and does it as the candidate goes onto the list so the
 * failure below names the `simctl` that was really stat'd.
 *
 * **Unmemoised.** Holding the answer for a process's life, and the rule that a *failure* must not
 * be held, are both daemon lifecycle and belong with the backend row that starts something on a
 * backoff — not here. Re-running this search costs a handful of `stat` calls and no process.
 */

import { accessSync, constants, readlinkSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { InterruptionCause } from '../../core/device.js';

/** The one variable that overrides the whole search below — Apple's own, see the header. */
export const DEVELOPER_DIR_ENV_VAR = 'DEVELOPER_DIR';

/** Where `simctl` sits inside a developer directory, and the whole of what verifies one. */
export const SIMCTL_RELATIVE_PATH = 'usr/bin/simctl';

/** The symlink `xcode-select` writes its selection to (header). */
export const XCODE_SELECT_LINK = '/var/db/xcode_select_link';

/** Where the developer directory sits inside an Xcode application bundle (header). */
const BUNDLE_DEVELOPER_DIR = join('Contents', 'Developer');

/** Where Xcode's own installer puts it, and the only install location guessed at. */
const APPLICATIONS_ROOT = '/Applications';
const XCODE_DEVELOPER_DIR = join('Xcode.app', BUNDLE_DEVELOPER_DIR);

/**
 * The interruption a caller reports when this search comes up empty (`src/core/device.ts`).
 *
 * It names `simctl` rather than Xcode or the platform, for the reason `ADB_NOT_INSTALLED` names
 * `adb`: the program is the half a person can act on, and shared code renders the name without
 * ever learning what it is for (ai/RULES.md §2). This is the `tooling-missing` case in its purest
 * form — a Command Line Tools selection will not start carrying `simctl` on its own, so every
 * attempt fails identically forever until somebody installs Xcode or points this elsewhere.
 */
export const SIMCTL_MISSING: InterruptionCause = { cause: 'tooling-missing', tool: 'simctl' };

/**
 * One place the search consults, and the developer directory it named — or `null` when it named
 * nothing at all.
 *
 * **A place that yielded nothing stays on the list**, which is `../android/adb-locations.mjs`'
 * rule and for its reason: *"this variable is not set"* is the actionable half of the failure. It
 * also makes the numbering below mean the same thing on every machine — without it, the ordinary
 * machine this failure fires on (no `DEVELOPER_DIR`, nothing to read at the selection) gets a
 * one-line message from which a reader cannot tell whether the other two places were
 * consulted-and-empty or never consulted.
 */
export interface DeveloperDirSearchLocation {
	/** What this place is, named the way a person would name it. */
	readonly source: string;
	/** The developer directory it named, already normalised (header), or `null`. */
	readonly path: string | null;
	/**
	 * What to say in place of a path when it named nothing — *"not set"* means something for a
	 * variable and nothing for a symlink. Omitted by the standard install, which always names one.
	 */
	readonly absent?: string;
}

/**
 * Every place was looked in and none of them held a `simctl` this host can run.
 *
 * The message names **each** place, in the order it was tried, and the variable that overrides
 * all of them — the difference between a failure an operator can act on and the same opaque
 * "utility not found" once per verb. A place that named a directory contributes the `simctl` path
 * that was checked rather than the directory holding it, because a directory that exists while the
 * utility inside it does not is exactly the confusion this failure has to clear up; a place that
 * named nothing says so, so the list is the same three rows whatever the machine.
 */
export class SimctlNotFoundError extends Error {
	constructor(searched: readonly DeveloperDirSearchLocation[]) {
		super(
			[
				"'simctl' was not found under any of the developer directories this host looks in, in " +
					'this order:',
				...(searched.length === 0
					? ['  (nowhere — a developer directory is macOS-only, and this host is not macOS)']
					: searched.map(
							({ source, path, absent }, index) =>
								`  ${index + 1}. ${source} — ${path === null ? (absent ?? 'not set') : simctlIn(path)}`,
						)),
				`Set ${DEVELOPER_DIR_ENV_VAR} to the developer directory this host should use, or ` +
					'install Xcode — the Command Line Tools alone do not carry simctl.',
			].join('\n'),
		);
		this.name = 'SimctlNotFoundError';
	}
}

/** What {@link resolveDeveloperDir} reads the machine through, so a suite can describe another. */
export interface ResolveDeveloperDirOptions {
	readonly env?: NodeJS.ProcessEnv;
	readonly platform?: NodeJS.Platform;
	readonly selectLinkPath?: string;
	readonly applicationsRoot?: string;
}

/**
 * The places to look, in order, whether or not each named anything.
 *
 * The operator's `DEVELOPER_DIR`, then their `xcode-select` selection, then the one location
 * Xcode's installer uses — a bounded list rather than a walk of the disk, and one standard
 * location rather than every layout anybody has ever had, following `../android/adb-locations.mjs`
 * for both. Off macOS it is empty: there is no developer directory to find, which is also what
 * lets the suites here run unchanged on a Linux CI runner.
 *
 * **The same directory may appear twice and is no longer deduplicated.** It was, on the reasoning
 * that `DEVELOPER_DIR` naming the Xcode `xcode-select` already selects is the ordinary case and
 * reporting it twice tells nobody anything — true of a list of bare paths, and false once each row
 * carries the place it came from: dropping a row then costs the reader "your variable is not set"
 * or "there was nothing to read there", which is the half they can act on, and makes position 2
 * mean a different place on every machine. The walk pays one repeated `stat` for that.
 */
export function developerDirSearchLocations(
	options: ResolveDeveloperDirOptions = {},
): DeveloperDirSearchLocation[] {
	if ((options.platform ?? process.platform) !== 'darwin') return [];

	const env = options.env ?? process.env;
	// Empty counts as unset, as it does for every other variable Rover reads: an
	// exported-but-blank variable is what a shell leaves behind, and reading one as a real
	// selection would point the search at a relative path.
	const named = env[DEVELOPER_DIR_ENV_VAR];
	const selectLinkPath = options.selectLinkPath ?? XCODE_SELECT_LINK;

	return [
		{
			source: DEVELOPER_DIR_ENV_VAR,
			path: named === undefined || named === '' ? null : developerDirIn(named),
			absent: 'not set',
		},
		{
			source: 'the xcode-select selection',
			// Normalised like the variable above. `xcode-select --switch` is documented to infer the
			// Developer directory from a bundle before storing it — and did on this bench, where the
			// link reads `/Applications/Xcode.app/Contents/Developer` — so this is a no-op for a link
			// that tool wrote, and the safety net for one anything else did.
			path: selectedDeveloperDir(selectLinkPath),
			absent: `nothing to read at ${selectLinkPath}`,
		},
		{
			source: "this platform's standard Xcode install",
			// Constructed already normalised, so it needs no `stat` to ask what shape it is.
			path: join(options.applicationsRoot ?? APPLICATIONS_ROOT, XCODE_DEVELOPER_DIR),
		},
	];
}

/**
 * Walk that list once and answer with the first developer directory holding a usable `simctl`.
 *
 * Throws {@link SimctlNotFoundError} when every place has been tried.
 */
export function resolveDeveloperDir(options: ResolveDeveloperDirOptions = {}): string {
	const searched = developerDirSearchLocations(options);
	for (const { path } of searched) {
		if (path !== null && holdsSimctl(path)) return path;
	}
	throw new SimctlNotFoundError(searched);
}

/**
 * What `xcode-select -p` would answer, read as the symlink it is, or `null` when there is no
 * selection to read — a missing link, or a path that is not one at all.
 *
 * `resolve` against the link's own directory, so a relative target means what the filesystem
 * means by it rather than something relative to whatever directory this process was started in.
 */
function selectedDeveloperDir(link: string): string | null {
	try {
		return developerDirIn(resolve(dirname(link), readlinkSync(link)));
	} catch {
		return null;
	}
}

/**
 * The developer directory a candidate names: the `Contents/Developer` inside it when there is one,
 * and otherwise the candidate itself.
 *
 * `xcrun`'s own rule, measured rather than assumed — see the header for the three forms that were
 * tried and what each resolved to. Deliberately **not** a `.app` suffix test, because `xcrun` does
 * not apply one.
 */
function developerDirIn(candidate: string): string {
	const inside = join(candidate, BUNDLE_DEVELOPER_DIR);
	return isDirectory(inside) ? inside : candidate;
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Does this developer directory hold a `simctl` this user may execute?
 *
 * A candidate that fails is *not found* and the sequence continues past it, so a Command Line
 * Tools selection never shadows a working Xcode behind it. Windows needs none of
 * `../android/adb-locations.mjs`' `PATHEXT` care: the only platform reaching this has one name
 * for the utility and honours the execute bit.
 */
function holdsSimctl(developerDir: string): boolean {
	const simctl = simctlIn(developerDir);
	try {
		if (!statSync(simctl).isFile()) return false;
		accessSync(simctl, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function simctlIn(developerDir: string): string {
	return join(developerDir, SIMCTL_RELATIVE_PATH);
}
