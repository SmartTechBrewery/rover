/**
 * What `rover init` can work out about a project by reading it — and, more importantly, what it
 * refuses to guess.
 *
 * Everything here answers `undefined` rather than a plausible default. D13's rule is that the
 * core knows no application's name, and an onboarding command is the one place that rule is
 * easiest to break: a wrong `install` command is worse than no `install` command, because
 * `install-hook-undeclared` is a named answer an agent can act on while a hook that builds the
 * wrong module is an install that "worked" and changed nothing on the device. So a detection is
 * a **proposal, reported with the file it came from**, and a project that looks like nothing in
 * particular is registered with no install at all.
 *
 * The detections recognise **Gradle** and nothing else so far, and that is not a platform
 * branch of the kind `ai/RULES.md` §2 forbids — nothing here is a device backend, a verb, or a
 * capability. It is one command recognising a build system in somebody else's repository, and
 * the next build system it learns is another entry beside this one rather than a branch inside
 * a verb. `tests/unit/no-platform-names.test.ts` carries the one name it cannot avoid and why.
 */

import { access, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { AppIdSchema } from '../../core/ids.js';
import { type HookCommand, ProjectIdentifierSchema } from '../../daemon/project-hooks.js';
import { UsageError } from '../_shared/flags.js';

/** Something init worked out for itself, and the file it read to work it out. */
export interface Detected<Value> {
	/** What was found. */
	readonly value: Value;
	/** The project-relative path it was found in, named in the report so it can be checked. */
	readonly source: string;
}

/**
 * The Gradle files an application id can live in, most specific first.
 *
 * `app/` before the root, because a root `build.gradle.kts` in a multi-module project configures
 * the build rather than an application, and a `namespace` found there would be a plugin's.
 */
const GRADLE_FILES = [
	'app/build.gradle.kts',
	'app/build.gradle',
	'build.gradle.kts',
	'build.gradle',
];

/**
 * `applicationId` is what the package on the device is called; `namespace` is what the generated
 * `R` class is called, and the two agree in most projects and not in all. Both are read, the
 * first wins, and a project where they differ gets the one the device would actually report.
 */
const APPLICATION_ID = /^\s*applicationId\s*=?\s*["']([^"']+)["']/m;
const NAMESPACE = /^\s*namespace\s*=?\s*["']([^"']+)["']/m;

/**
 * The install a Gradle project gets proposed.
 *
 * Three things in it are load-bearing. `bash` is the program because the line needs a shell to
 * expand a variable and hooks are never word-split (`src/daemon/project-hooks.ts`) — an operator
 * who wants a shell makes the shell the program. The environment variable is what carries the
 * lease's device into the build's own install step, out of the `ROVER_DEVICE_SERIAL` the host
 * sets on every hook child: without it, a host with two devices attached installs onto whichever
 * one the build picks for itself, which is the neighbour's. And `-q`, because the hook's stdout
 * is a build log nobody reads unless it failed, and a failure reports its own stderr tail.
 */
const GRADLE_INSTALL = 'ANDROID_SERIAL="$ROVER_DEVICE_SERIAL" ./gradlew :app:installDebug -q';

/**
 * The project identifier for a directory: what was asked for, or the directory's own name.
 *
 * The name is **taken, not sanitised**. A directory called `My App!` is refused with the
 * schema's own sentence and `--project` named as the fix, because the identifier is also the
 * hook file's name and the string every lease on this project is attributed with — deriving one
 * by dropping characters would hand somebody a project they never named and a file they will not
 * find. It is the reasoning `PROJECT_IDENTIFIER` is written with, applied one layer up.
 */
export function projectIdentifierFor(directory: string, requested: string | undefined): string {
	const candidate = requested ?? basename(directory);
	const parsed = ProjectIdentifierSchema.safeParse(candidate);
	if (parsed.success) {
		return parsed.data;
	}
	const why = parsed.error.issues[0]?.message ?? 'it is not a project identifier';
	throw new UsageError(
		requested === undefined
			? `rover init: this directory is named '${candidate}', which cannot be a project ` +
					`identifier — ${why}. Pass --project <name> to give it one.`
			: `rover init: --project '${candidate}' — ${why}.`,
	);
}

/** The applications this project builds, or `undefined` when nothing here names one. */
export async function detectApps(
	directory: string,
): Promise<Detected<readonly string[]> | undefined> {
	let fallback: Detected<readonly string[]> | undefined;
	for (const relative of GRADLE_FILES) {
		const contents = await readIfPresent(join(directory, relative));
		if (contents === undefined) {
			continue;
		}
		const applicationId = appIdIn(contents, APPLICATION_ID);
		if (applicationId !== undefined) {
			return { value: [applicationId], source: relative };
		}
		const namespace = appIdIn(contents, NAMESPACE);
		if (namespace !== undefined && fallback === undefined) {
			fallback = { value: [namespace], source: relative };
		}
	}
	return fallback;
}

/**
 * What installing this project means, or `undefined` when init has no idea.
 *
 * Both files have to be there: `gradlew` says how the build is run and `app/` says the
 * `:app:installDebug` task exists. A wrapper with no `app` module is a project whose install
 * task has a name only its author knows, and proposing one would be the guess this module exists
 * to avoid.
 */
export async function detectInstall(directory: string): Promise<Detected<HookCommand> | undefined> {
	const hasWrapper = await exists(join(directory, 'gradlew'));
	const hasAppModule = await exists(join(directory, 'app'));
	return hasWrapper && hasAppModule
		? { value: shellInstall(GRADLE_INSTALL, directory), source: 'gradlew' }
		: undefined;
}

/** One shell line as a hook command, which is the shape `--install` is given in too. */
export function shellInstall(line: string, cwd: string): HookCommand {
	return { command: 'bash', args: ['-lc', line], cwd, env: {} };
}

/**
 * A hook command as one line a human can read back.
 *
 * Arguments carrying whitespace are quoted, which matters more here than it looks: a hook is
 * spawned with `shell: false`, so `bash -lc ./gradlew installDebug -q` and
 * `bash -lc './gradlew installDebug -q'` are different commands and only the second is the one
 * that was registered. A report that printed the first would be teaching its reader the wrong
 * shape of the thing they are looking at.
 */
export function describeCommand(command: HookCommand): string {
	return [command.command, ...command.args.map(quoteIfNeeded)].join(' ');
}

function quoteIfNeeded(argument: string): string {
	return /\s/.test(argument) ? `'${argument.replaceAll("'", String.raw`'\''`)}'` : argument;
}

function appIdIn(contents: string, pattern: RegExp): string | undefined {
	const found = pattern.exec(contents)?.[1];
	if (found === undefined) {
		return undefined;
	}
	// A build file may set this from a variable or a version catalogue, in which case what was
	// captured is not a package name at all. The schema is the judge, and a miss is a project with
	// no detected app rather than a hook file the daemon would refuse.
	return AppIdSchema.safeParse(found).success ? found : undefined;
}

async function readIfPresent(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, 'utf8');
	} catch {
		return undefined;
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
