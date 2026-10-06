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
 *
 * **Product flavors are where that rule earns its keep.** A project that declares any makes the
 * build plugin name every variant after its flavors, and the install task after the variant —
 * `:app:installFreeDebug`, never `:app:installDebug`, which simply does not exist there. So the
 * install is read out of `app/build.gradle(.kts)` rather than assumed: one variant is proposed
 * like any other detection, **several are listed and none registered** because picking one for
 * somebody would be the guess this module exists to avoid, and a flavor block that only Gradle
 * itself could evaluate — a loop, an `all { }`, or several dimensions whose order is declared
 * somewhere other than this file — yields nothing and says so. The report is where the choice is
 * handed back, as a ready-to-paste `--install` line per variant.
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
const APP_BUILD_FILES = ['app/build.gradle.kts', 'app/build.gradle'];

const GRADLE_FILES = [...APP_BUILD_FILES, 'build.gradle.kts', 'build.gradle'];

/**
 * `applicationId` is what the package on the device is called; `namespace` is what the generated
 * `R` class is called, and the two agree in most projects and not in all. Both are read, the
 * first wins, and a project where they differ gets the one the device would actually report.
 */
const APPLICATION_ID = /^\s*applicationId\s*=?\s*["']([^"']+)["']/m;
const NAMESPACE = /^\s*namespace\s*=?\s*["']([^"']+)["']/m;

/**
 * The install a Gradle project gets proposed, for one build variant.
 *
 * Three things in the line are load-bearing. `bash` is the program because the line needs a shell
 * to expand a variable and hooks are never word-split (`src/daemon/project-hooks.ts`) — an
 * operator who wants a shell makes the shell the program. The environment variable is what
 * carries the lease's device into the build's own install step, out of the `ROVER_DEVICE_SERIAL`
 * the host sets on every hook child: **without it the install task installs onto every attached
 * device**, which on a shared host is every neighbour's lease as well as this one's. And `-q`,
 * because the hook's stdout is a build log nobody reads unless it failed, and a failure reports
 * its own stderr tail.
 *
 * The task's own name is the variant's, capitalised. A variant is its flavors in declared
 * dimension order followed by the build type — `dev` and `free` under dimensions `env, tier`
 * give `devFreeDebug`, whose task is `:app:installDevFreeDebug`. A project with no flavors has
 * the plain `debug` variant and so the `:app:installDebug` this used to be a constant for.
 */
function gradleInstall(variant: string): string {
	return `ANDROID_SERIAL="$ROVER_DEVICE_SERIAL" ./gradlew :app:install${upperFirst(variant)} -q`;
}

/** The build type every proposal names: the one a project is guaranteed to have. */
const DEBUG = 'debug';

/**
 * Block heads that read like a flavor and are not one.
 *
 * Every one of them declares flavors whose names are not in the file — `all { }` configures
 * whatever the build produces, a loop produces them from a list — so a parse that took the head
 * for a flavor would invent a variant nobody declared.
 */
const NOT_A_FLAVOR = new Set([
	'all',
	'configureEach',
	'each',
	'forEach',
	'whenObjectAdded',
	'matching',
	'if',
	'else',
	'for',
	'while',
	'try',
	'catch',
	'finally',
	'do',
]);

/** `create("free")`, and the two other container calls that declare a flavor by a string. */
const CONTAINER_CALL = /^(?:create|register|maybeCreate)\s*\(\s*["']([^"']+)["']/;

/**
 * `getByName("free")` and `named("free")`: they configure a flavor declared somewhere else rather
 * than declaring one, so they add no variant — and a lookup of a name this block never declared
 * means the flavor set is not all in this file.
 */
const CONTAINER_LOOKUP = /^(?:getByName|named)\s*\(\s*["']([^"']+)["']/;

/** A Groovy block head that is nothing but a name: `free {`. */
const BARE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The dimension a flavor body names, in any of the three syntaxes that say it. */
const DIMENSION = /\bdimension\s*(?:=\s*|\(\s*)?["']([^"']+)["']/;

/** One flavor as the build file declares it. */
interface Flavor {
	readonly name: string;
	/** The dimension its body names, or `undefined` when it names none. */
	readonly dimension: string | undefined;
}

/**
 * Every debug variant an app build file declares, read statically — and the two ways that fails.
 *
 * `undefined` means the file declares no `productFlavors` at all, so the project has the plain
 * `debug` variant and nothing had to be worked out. An **empty array** means flavors are declared
 * and this function could not resolve them: a loop, an `all { }`, names coming from a variable,
 * flavors in several dimensions with no literal `flavorDimensions` in this file to order them, or
 * dimensions the flavors and that declaration disagree about. That is a
 * deliberate third answer rather than a guess, because the one thing worse than listing no
 * variant is listing a variant that does not exist.
 *
 * Exported for its own unit tests: it is the whole of the parsing, and it is pure.
 */
export function gradleDebugVariants(buildFile: string): readonly string[] | undefined {
	const text = withoutComments(buildFile);
	if (!/\bproductFlavors\b/.test(text)) {
		return undefined;
	}
	const body = blockBody(text, /\bproductFlavors\s*\{/);
	if (body === undefined) {
		return [];
	}
	const flavors = flavorsIn(body);
	if (flavors === undefined || flavors.length === 0) {
		return [];
	}
	return composeVariants(flavors, flavorDimensionsIn(text));
}

/**
 * The flavors a `productFlavors` body declares, once each and in the order first declared, or
 * `undefined` when something in it is not a flavor declaration at all.
 *
 * A name that comes back — `maybeCreate` twice, a Groovy block repeated, a `getByName` that
 * configures one already declared — is the same flavor configured again, and its dimension merges
 * into the one declared; two different dimensions for one flavor is a file this parse has not
 * understood.
 */
function flavorsIn(body: string): Flavor[] | undefined {
	const flavors = new Map<string, string | undefined>();
	for (const statement of topLevelStatements(body)) {
		const head = statement.head.trim();
		if (head === '') {
			continue;
		}
		const declared = declaredFlavor(head, statement.body);
		const name = declared ?? CONTAINER_LOOKUP.exec(head)?.[1];
		if (name === undefined || (declared === undefined && !flavors.has(name))) {
			return undefined;
		}
		const dimension = dimensionIn(statement.body);
		const known = flavors.get(name);
		if (dimension !== undefined && known !== undefined && dimension !== known) {
			return undefined;
		}
		flavors.set(name, dimension ?? known);
	}
	return [...flavors].map(([name, dimension]) => ({ name, dimension }));
}

/** The flavor a statement head declares — a container call or a bare Groovy block — if any. */
function declaredFlavor(head: string, body: string | undefined): string | undefined {
	const called = CONTAINER_CALL.exec(head)?.[1];
	if (called !== undefined) {
		return called;
	}
	return body !== undefined && BARE_NAME.test(head) && !NOT_A_FLAVOR.has(head) ? head : undefined;
}

function dimensionIn(body: string | undefined): string | undefined {
	return body === undefined ? undefined : DIMENSION.exec(body)?.[1];
}

/**
 * The variant names, or `[]` when the flavors and the dimensions do not agree.
 *
 * One effective dimension is the common case and every flavor is a variant of its own. With
 * several, the variant is the cartesian product in **declared** dimension order — which is the
 * rule that makes the order flavors happen to be written in irrelevant — and a flavor naming a
 * dimension nothing declared, or a dimension no flavor fills, means the file says something this
 * parse has not understood.
 *
 * So flavors spanning several dimensions with **no declaration in this file** resolve to nothing:
 * the order is then in a convention plugin, an applied script or a variable, and composing the
 * names in the order the flavors were written would invent tasks the project does not have.
 */
function composeVariants(flavors: readonly Flavor[], declared: readonly string[]): string[] {
	const perFlavor = flavors.map((flavor) => `${flavor.name}${upperFirst(DEBUG)}`);
	if (declared.length === 0) {
		const named = new Set(flavors.map((flavor) => flavor.dimension).filter(isNamed));
		return named.size <= 1 ? perFlavor : [];
	}
	if (
		flavors.some((flavor) => flavor.dimension !== undefined && !declared.includes(flavor.dimension))
	) {
		return [];
	}
	if (declared.length === 1) {
		return perFlavor;
	}
	if (flavors.some((flavor) => flavor.dimension === undefined)) {
		return [];
	}
	const perDimension = declared.map((dimension) =>
		flavors.filter((flavor) => flavor.dimension === dimension).map((flavor) => flavor.name),
	);
	if (perDimension.some((names) => names.length === 0)) {
		return [];
	}
	let variants = [''];
	for (const names of perDimension) {
		variants = variants.flatMap((prefix) =>
			names.map((name) => (prefix === '' ? name : `${prefix}${upperFirst(name)}`)),
		);
	}
	return variants.map((variant) => `${variant}${upperFirst(DEBUG)}`);
}

function isNamed(value: string | undefined): value is string {
	return value !== undefined;
}

/**
 * The dimensions the file declares, in order and de-duplicated.
 *
 * Every syntax that says it reads the same way — the quoted strings of the statement, which is
 * the rest of the line or, when the argument list spans lines, up to the bracket that closes it.
 */
function flavorDimensionsIn(text: string): string[] {
	const dimensions: string[] = [];
	const keyword = /\bflavorDimensions\b/g;
	let match = keyword.exec(text);
	while (match !== null) {
		for (const quoted of statementAt(text, match.index).matchAll(/["']([^"']+)["']/g)) {
			const name = quoted[1];
			if (name !== undefined && !dimensions.includes(name)) {
				dimensions.push(name);
			}
		}
		match = keyword.exec(text);
	}
	return dimensions;
}

/**
 * One statement's text, from `start` to the end of its line or of its argument list.
 *
 * A line ending in a comma is not the end of the statement: Groovy lets a bracket-less argument
 * list run on (`flavorDimensions "env",` then `"tier"`), and stopping at the first line would
 * read one dimension where the file declares two.
 */
function statementAt(text: string, start: number): string {
	let firstLine = text.indexOf('\n', start);
	firstLine = firstLine === -1 ? text.length : firstLine;
	let depth = 0;
	for (let index = start; index < text.length; index += 1) {
		const character = text[index] as string;
		const delta = bracketDelta(character);
		depth += delta;
		if (delta < 0 && depth === 0 && index >= firstLine) {
			return text.slice(start, index + 1);
		}
		if (character === '\n' && depth === 0 && !text.slice(start, index).trimEnd().endsWith(',')) {
			return text.slice(start, index);
		}
	}
	return depth === 0 ? text.slice(start) : text.slice(start, firstLine);
}

function bracketDelta(character: string): number {
	if (character === '(' || character === '[') {
		return 1;
	}
	return character === ')' || character === ']' ? -1 : 0;
}

/** One top-level statement of a block: whatever preceded its body, and the body when it had one. */
interface Statement {
	readonly head: string;
	readonly body: string | undefined;
}

/**
 * The statements at a block's own level, with every nested block consumed whole.
 *
 * A statement ends at the `{` that opens its body, or — when it has none — at the newline or `;`
 * that ends it. That second case is what catches a `val` or an assignment inside `productFlavors`
 * and turns the whole read into "could not resolve", which is the honest answer for a block whose
 * names are computed.
 */
function topLevelStatements(body: string): Statement[] {
	const statements: Statement[] = [];
	let head = '';
	let index = 0;
	while (index < body.length) {
		const character = body[index] as string;
		const literal = stringAt(body, index);
		if (literal !== undefined) {
			head += body.slice(index, literal);
			index = literal;
			continue;
		}
		if (character === '{') {
			const close = matchingBrace(body, index);
			if (close === undefined) {
				statements.push({ head, body: body.slice(index + 1) });
				return statements;
			}
			statements.push({ head, body: body.slice(index + 1, close) });
			head = '';
			index = close + 1;
			continue;
		}
		if (character === '\n' || character === ';') {
			statements.push({ head, body: undefined });
			head = '';
			index += 1;
			continue;
		}
		head += character;
		index += 1;
	}
	statements.push({ head, body: undefined });
	return statements;
}

/** The body of the first block whose head matches, or `undefined` when there is no such block. */
function blockBody(text: string, head: RegExp): string | undefined {
	const match = head.exec(text);
	if (match === null) {
		return undefined;
	}
	const open = text.indexOf('{', match.index);
	const close = matchingBrace(text, open);
	return close === undefined ? undefined : text.slice(open + 1, close);
}

/** The index of the `}` closing the `{` at `open`, skipping over string literals. */
function matchingBrace(text: string, open: number): number | undefined {
	let depth = 0;
	let index = open;
	while (index < text.length) {
		const literal = stringAt(text, index);
		if (literal !== undefined) {
			index = literal;
			continue;
		}
		const character = text[index];
		if (character === '{') {
			depth += 1;
		} else if (character === '}') {
			depth -= 1;
			if (depth === 0) {
				return index;
			}
		}
		index += 1;
	}
	return undefined;
}

/**
 * The index just past the string literal starting at `index`, or `undefined` when none does.
 *
 * Braces and brackets inside a string are not structure — `"${name}"` is one interpolation and
 * `"https://host/{id}"` is a path — so every scan here steps over a literal whole rather than
 * counting what is inside it.
 */
function stringAt(text: string, index: number): number | undefined {
	const quote = text[index];
	if (quote !== '"' && quote !== "'") {
		return undefined;
	}
	for (let at = index + 1; at < text.length; at += 1) {
		if (text[at] === '\\') {
			at += 1;
			continue;
		}
		if (text[at] === quote) {
			return at + 1;
		}
		if (text[at] === '\n') {
			return at;
		}
	}
	return text.length;
}

/**
 * The text with its comments removed.
 *
 * A `//` only starts one at the beginning of a line or after whitespace, so the `//` inside a
 * `"https://…"` survives and the URL stays one token rather than half a line.
 */
function withoutComments(text: string): string {
	return text.replaceAll(/\/\*[\s\S]*?\*\//g, ' ').replaceAll(/(^|\s)\/\/[^\n]*/gm, '$1');
}

function upperFirst(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

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
 * What init worked out about installing this project: one proposal, or a choice it will not make.
 *
 * `undecided` is not a failure. It is the module's rule — a wrong install is worse than none —
 * applied to the one case where the right answer exists and there is more than one of it. The
 * `choices` are the shell lines `--install` takes, ready to paste, and an **empty** `choices` is
 * the other undecided case: flavors that are declared and cannot be read statically at all.
 */
export type InstallDetection =
	| { readonly kind: 'proposed'; readonly value: HookCommand; readonly source: string }
	| { readonly kind: 'undecided'; readonly choices: readonly string[]; readonly source: string };

/**
 * What installing this project means, or `undefined` when init has no idea.
 *
 * Both files have to be there: `gradlew` says how the build is run and `app/` says there is an
 * `:app` module whose install task to name. A wrapper with no `app` module is a project whose
 * install task has a name only its author knows, and proposing one would be the guess this
 * module exists to avoid.
 *
 * With the module there, the app's own build file decides which task that is — see
 * {@link gradleDebugVariants}. A file that declares no flavors, and a project that has no app
 * build file to read, both keep the `:app:installDebug` this command has always proposed.
 */
export async function detectInstall(directory: string): Promise<InstallDetection | undefined> {
	const hasWrapper = await exists(join(directory, 'gradlew'));
	const hasAppModule = await exists(join(directory, 'app'));
	if (!hasWrapper || !hasAppModule) {
		return undefined;
	}
	const proposed = (line: string, source: string): InstallDetection => ({
		kind: 'proposed',
		value: shellInstall(line, directory),
		source,
	});
	for (const relative of APP_BUILD_FILES) {
		const contents = await readIfPresent(join(directory, relative));
		if (contents === undefined) {
			continue;
		}
		const variants = gradleDebugVariants(contents);
		if (variants === undefined) {
			return proposed(gradleInstall(DEBUG), 'gradlew');
		}
		const only = variants.length === 1 ? variants[0] : undefined;
		if (only !== undefined) {
			return proposed(gradleInstall(only), relative);
		}
		return { kind: 'undecided', choices: variants.map(gradleInstall), source: relative };
	}
	return proposed(gradleInstall(DEBUG), 'gradlew');
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

/**
 * One shell line as the `--install` flag that would register it.
 *
 * The report and the stderr caveat print the same form for the same reason `describeCommand`
 * quotes: what is on the screen has to be what the reader can paste, and an install line is
 * whitespace all the way through.
 */
export function installFlag(line: string): string {
	return `--install ${quoteIfNeeded(line)}`;
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
