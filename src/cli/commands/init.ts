/**
 * `rover init` — everything a project needs before an agent working in it can reach a device,
 * done in one command.
 *
 * Onboarding was four manual steps and every one of them had a quiet failure: a hook file whose
 * `project` did not match its own name (a warning nobody sees until a lease ends), an MCP entry
 * pointing at the wrong path (`command not found`, at the agent's first tool call, days later),
 * a page of instructions written once and never updated, and an agent that was never told that
 * "manual test" means Rover — so it drives the device with the platform's own tools, outside
 * any lease, or asks a human to tap. This command
 * writes all four and reports exactly what it did to each.
 *
 * **It is the second command that asks no host**, after `rover users` (D25), and for a related
 * reason: there is nothing to ask. A hook file is host-operator configuration that is never
 * accepted over the wire (D13, `src/daemon/project-hooks.ts`), and the other three files belong
 * to the project's own directory. So init needs no daemon running, and being unable to reach a
 * host is not a reason for it to fail.
 *
 * **It guesses nothing it cannot show you.** Every detection is reported with the file it came
 * from, and a project that looks like nothing in particular is registered with no install rather
 * than with a plausible one (`../init/detect.ts`). The one thing it will not do at all is
 * overwrite a hook file that already exists — that file may carry services, a teardown and an
 * install somebody tuned by hand, and none of it is recoverable from what is on disk here.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAppId } from '../../core/ids.js';
import { HOST_ADDRESS_ENV_VAR } from '../../daemon/network-config.js';
import {
	type HookCommand,
	ProjectHooksSchema,
	projectHooksPath,
	resolveProjectsRoot,
} from '../../daemon/project-hooks.js';
import { expectPositionals, parseCommandArgs, UsageError } from '../_shared/flags.js';
import * as out from '../_shared/output.js';
import {
	describeCommand,
	detectApps,
	detectInstall,
	installFlag,
	projectIdentifierFor,
	shellInstall,
} from '../init/detect.js';
import {
	AGENT_FILES,
	agentSnippet,
	DEFAULT_AGENT_FILE,
	hasSnippet,
	pointerTarget,
	roverDocument,
	withSnippet,
} from '../init/documents.js';
import { type DocumentLocation, locateDocument } from '../init/locate.js';
import {
	MCP_CONFIG_FILE,
	mcpServerEntry,
	mergeMcpConfig,
	type WriteOutcome,
} from '../init/mcp-config.js';

export const USAGE = `rover init — set up a project so an agent working in it can drive a device

Usage: rover init [<path>] [--project <name>] [--app <id>]... [--install <shell line>]
                  [--no-install] [--write] [--force] [--json]

Writes four things, and reports what it did to each:

  <root>/<project>.json    the project's hook file, under ROVER_PROJECTS_PATH — what the
                           host stops and installs for a lease on this project (D13). An
                           existing one is never overwritten without --force
  <path>/.mcp.json         the 'rover' MCP server, merged into whatever is already there.
                           Other servers, and other keys in ours, are left alone
  <path>/ROVER.md          the page an agent reads before its first call. Generated: it is
                           rewritten by every run, so re-run init rather than editing it.
                           **Move it wherever you like** — every run looks for the page it
                           wrote last time, by a marker inside it rather than by its name,
                           and rewrites it where it now lives
  the snippet              a few lines for CLAUDE.md, AGENTS.md or GEMINI.md saying that a
                           manual test means Rover. Printed, or inserted with --write

Options:
  <path>            The project to set up. The current directory when omitted
  --project <name>  The project identifier. The directory's own name when omitted, and a
                    directory whose name cannot be one is a usage error rather than a name
                    invented by dropping characters
  --app <id>        An application this project drives, repeatable. Detected from Gradle
                    when omitted
  --install <line>  What installing this project means, as one shell line run on the host
                    with ROVER_DEVICE_SERIAL naming the leased device. Detected from a
                    Gradle wrapper when omitted — the variant's own task when the project
                    has one product flavor; with several, each variant's line is listed and
                    none is registered
  --no-install      Register no install at all, rather than the detected one
  --document <path> Where the page goes, relative to the project. Only needed to move it
                    somewhere init would not look, or to pick between two pages a project
                    somehow ended up with — a page that was simply moved is found on its
                    own. A markdown file this command did not write is never overwritten
  --write           Insert the snippet into every agent file the project already has,
                    between markers, so running init again replaces it instead of adding a
                    second copy. Creates ${DEFAULT_AGENT_FILE} only when there is no agent file at all
  --force           Overwrite an existing hook file
  --json            One JSON document on stdout, every diagnostic on stderr

No host is asked and no daemon has to be running: a hook file is the host's own configuration
and is never accepted over the wire, and the other three files are the project's. With
${HOST_ADDRESS_ENV_VAR} set, the hook file is still written here — a client reads one field out
of it — and the run says what has to be copied to the machine that holds the devices.`;

const OPTIONS = {
	json: { type: 'boolean', default: false },
	help: { type: 'boolean', default: false },
	project: { type: 'string' },
	app: { type: 'string', multiple: true },
	install: { type: 'string' },
	'no-install': { type: 'boolean', default: false },
	document: { type: 'string' },
	write: { type: 'boolean', default: false },
	force: { type: 'boolean', default: false },
} as const;

/** Where a value came from: a file init read, or the caller's own command line. */
interface Choice<Value> {
	readonly value: Value;
	/** The project-relative file it was detected in, or `undefined` when it was given. */
	readonly detectedIn: string | undefined;
}

/** One file init touched, and what it did to it. */
interface FileReport {
	readonly path: string;
	readonly outcome: WriteOutcome | 'kept';
}

/** One agent file, and why it was or was not written. */
interface AgentReport {
	readonly name: string;
	readonly outcome: 'created' | 'updated' | 'unchanged' | 'found' | 'pointer';
	/** The document a pointer file points at — where the snippet actually belongs. */
	readonly target?: string;
}

export async function run(argv: string[]): Promise<number> {
	const { values, positionals } = parseCommandArgs('init', argv, OPTIONS);
	if (values.help === true) {
		out.info(USAGE);
		return 0;
	}
	const [given] = expectPositionals('init', positionals, [], ['path']);

	const directory = await projectDirectory(given);
	const project = projectIdentifierFor(directory, values.project);
	const apps = await chooseApps(directory, values.app);
	const { chosen: install, undecided } = await chooseInstall(
		directory,
		values.install,
		values['no-install'] === true,
	);
	const remote = (process.env[HOST_ADDRESS_ENV_VAR] ?? '') !== '';
	// Before the first write: an ambiguous page, or one this command did not write, is a
	// refusal with nothing done yet rather than three files written and then a failure.
	const where = await locateDocument(directory, values.document);

	const hookFile = await writeHookFile(project, apps.value, install?.value, values.force === true);
	const mcpConfig = await writeMcpConfig(directory, hookFile.path);
	const document = await writeDocument(where, {
		project,
		apps: apps.value,
		install: install === undefined ? undefined : describeCommand(install.value),
		projectDefaulted: true,
		remote,
		invocation: out.INVOCATION,
	});
	const agentFiles = await handleAgentFiles(directory, where.relative, values.write === true);

	if (values.json === true) {
		out.printDocument({
			project,
			directory,
			hookFile,
			mcpConfig,
			document: { ...document, how: where.how },
			agentFiles,
			apps: apps.value,
			install: install === undefined ? null : describeCommand(install.value),
			installChoices:
				undecided === undefined
					? null
					: { source: undecided.source, choices: [...undecided.choices] },
			snippet: agentSnippet(where.relative),
		});
	} else {
		out.info(
			report({
				project,
				directory,
				apps,
				install,
				undecided,
				hookFile,
				mcpConfig,
				document,
				where,
				agentFiles,
			}),
		);
	}
	reportCaveats(hookFile, remote, values.write === true, agentFiles, undecided);
	return 0;
}

/** The directory to set up, absolute — and a usage error for anything that is not one. */
async function projectDirectory(given: string | undefined): Promise<string> {
	const directory = path.resolve(given ?? process.cwd());
	let entry: Awaited<ReturnType<typeof stat>>;
	try {
		entry = await stat(directory);
	} catch {
		throw new UsageError(`rover init: there is nothing at ${directory}.`);
	}
	if (!entry.isDirectory()) {
		throw new UsageError(`rover init: ${directory} is not a directory.`);
	}
	return directory;
}

async function chooseApps(
	directory: string,
	given: string[] | undefined,
): Promise<Choice<readonly string[]>> {
	if (given !== undefined && given.length > 0) {
		// Parsed here rather than left to the schema below, so a mistyped package name names
		// `--app` and the shape it expected, at exit 2, instead of a Zod path at exit 1.
		for (const app of given) {
			try {
				parseAppId(app);
			} catch (error) {
				throw new UsageError(
					`rover init: --app '${app}' — ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		return { value: given, detectedIn: undefined };
	}
	const detected = await detectApps(directory);
	return detected === undefined
		? { value: [], detectedIn: undefined }
		: { value: detected.value, detectedIn: detected.source };
}

/** A choice init could not make for the caller, and the lines it would have picked between. */
interface Undecided {
	readonly choices: readonly string[];
	readonly source: string;
}

/**
 * What the run registers as the install, and what it hands back for the operator to pick from.
 *
 * Exactly one of the two is ever set. `undecided` is a project whose build file declares product
 * flavors — one install task per variant, and no single one init could register without guessing
 * which variant agents are meant to get.
 */
interface InstallChoice {
	readonly chosen: Choice<HookCommand> | undefined;
	readonly undecided: Undecided | undefined;
}

async function chooseInstall(
	directory: string,
	given: string | undefined,
	none: boolean,
): Promise<InstallChoice> {
	if (none) {
		if (given !== undefined) {
			throw new UsageError(
				'rover init: --install and --no-install say opposite things. Pass one of them.',
			);
		}
		return { chosen: undefined, undecided: undefined };
	}
	if (given !== undefined) {
		if (given.trim() === '') {
			throw new UsageError('rover init: --install is empty. Pass a shell line, or --no-install.');
		}
		return {
			chosen: { value: shellInstall(given, directory), detectedIn: undefined },
			undecided: undefined,
		};
	}
	const detected = await detectInstall(directory);
	if (detected === undefined) {
		return { chosen: undefined, undecided: undefined };
	}
	return detected.kind === 'proposed'
		? {
				chosen: { value: detected.value, detectedIn: detected.source },
				undecided: undefined,
			}
		: { chosen: undefined, undecided: { choices: detected.choices, source: detected.source } };
}

/**
 * The hook file, written under the projects root — or kept, if one is already there.
 *
 * The document is **built as a literal and then parsed** with the daemon's own schema rather
 * than serialised out of a parsed object: the parse is what makes it impossible for init to
 * write a file the host would later refuse, and the literal is what keeps the file free of
 * `"services": []` and every other default nobody typed.
 */
async function writeHookFile(
	project: string,
	apps: readonly string[],
	install: HookCommand | undefined,
	force: boolean,
): Promise<FileReport> {
	const document: Record<string, unknown> = { project };
	if (apps.length > 0) {
		document.apps = apps;
	}
	if (install !== undefined) {
		// Written without the `env` a hook command defaults to, for the reason above.
		document.install = { command: install.command, args: install.args, cwd: install.cwd };
	}
	ProjectHooksSchema.parse(document);

	const root = resolveProjectsRoot();
	const file = projectHooksPath(root, project);
	if (file === null) {
		// Unreachable: the identifier was parsed with the same schema this lookup uses.
		throw new Error(`'${project}' is not a project identifier, so it names no hook file.`);
	}
	const existing = await readIfPresent(file);
	if (existing !== undefined && !force) {
		return { path: file, outcome: 'kept' };
	}
	const text = `${JSON.stringify(document, null, 2)}\n`;
	if (existing === text) {
		return { path: file, outcome: 'unchanged' };
	}
	await mkdir(root, { recursive: true });
	await writeFile(file, text, 'utf8');
	return { path: file, outcome: existing === undefined ? 'created' : 'updated' };
}

async function writeMcpConfig(directory: string, hookFile: string): Promise<FileReport> {
	const file = path.join(directory, MCP_CONFIG_FILE);
	const existing = await readIfPresent(file);
	const merged = mergeMcpConfig(file, existing, mcpServerEntry(mcpLauncher(), hookFile));
	if (merged.outcome !== 'unchanged') {
		await writeFile(file, merged.text, 'utf8');
	}
	return { path: file, outcome: merged.outcome };
}

/**
 * The page, written where {@link locateDocument} said it goes — which is where a previous run
 * left it, wherever somebody has since moved that to.
 *
 * The directory is created because `--document docs/ROVER.md` in a project with no `docs/` is a
 * request rather than a mistake; every other path here was found by walking a directory that
 * therefore exists.
 */
async function writeDocument(
	where: DocumentLocation,
	facts: Parameters<typeof roverDocument>[0],
): Promise<FileReport> {
	const existing = await readIfPresent(where.path);
	const text = roverDocument(facts);
	if (existing === text) {
		return { path: where.path, outcome: 'unchanged' };
	}
	await mkdir(path.dirname(where.path), { recursive: true });
	await writeFile(where.path, text, 'utf8');
	return { path: where.path, outcome: existing === undefined ? 'created' : 'updated' };
}

/**
 * The agent files, reported — and written when asked.
 *
 * Without `--write` nothing is touched and the snippet is printed for a human to place, which
 * is the default because an agent file is a project's own prose. With it, every real agent file
 * gets the block between its markers; a **pointer** file is named and skipped
 * (`../init/documents.ts`); and a project with no agent file at all gets one created, because
 * there is nothing there to be careful with.
 */
async function handleAgentFiles(
	directory: string,
	documentPath: string,
	write: boolean,
): Promise<AgentReport[]> {
	const snippet = agentSnippet(documentPath);
	const reports: AgentReport[] = [];
	for (const name of AGENT_FILES) {
		const file = path.join(directory, name);
		const existing = await readIfPresent(file);
		if (existing === undefined) {
			continue;
		}
		const target = pointerTarget(existing);
		if (target !== null) {
			reports.push({ name, outcome: 'pointer', target });
			continue;
		}
		if (!write) {
			reports.push({ name, outcome: 'found' });
			continue;
		}
		const updated = withSnippet(existing, snippet);
		if (updated === existing) {
			reports.push({ name, outcome: 'unchanged' });
			continue;
		}
		await writeFile(file, updated, 'utf8');
		reports.push({ name, outcome: hasSnippet(existing) ? 'updated' : 'created' });
	}
	if (write && reports.length === 0) {
		const file = path.join(directory, DEFAULT_AGENT_FILE);
		await writeFile(file, withSnippet(undefined, snippet), 'utf8');
		reports.push({ name: DEFAULT_AGENT_FILE, outcome: 'created' });
	}
	return reports;
}

/**
 * The MCP entry point, absolute — the launcher, never `src/mcp/index.ts`.
 *
 * `PROJECT.md` §6: `node --import tsx/esm <that module>` resolves the loader against the MCP
 * client's own working directory, so the obvious form starts in this checkout and nowhere else.
 */
function mcpLauncher(): string {
	return fileURLToPath(new URL('../../../bin/rover-mcp.mjs', import.meta.url));
}

interface Report {
	readonly project: string;
	readonly directory: string;
	readonly apps: Choice<readonly string[]>;
	readonly install: Choice<HookCommand> | undefined;
	readonly undecided: Undecided | undefined;
	readonly hookFile: FileReport;
	readonly mcpConfig: FileReport;
	readonly document: FileReport;
	readonly where: DocumentLocation;
	readonly agentFiles: readonly AgentReport[];
}

function report(what: Report): string {
	const lines = [
		`Rover is set up for '${what.project}'.`,
		'',
		field('directory', what.directory),
		field('hook file', `${what.hookFile.path}  (${what.hookFile.outcome})`),
		field('mcp server', `${what.mcpConfig.path}  (${what.mcpConfig.outcome})`),
		field(
			'document',
			`${what.document.path}  (${what.document.outcome}${
				what.where.how === 'found' ? ', found where you moved it' : ''
			})`,
		),
		field(
			'apps',
			what.apps.value.length === 0
				? 'none — pass --app <id> to name one'
				: `${what.apps.value.join(', ')}${from(what.apps.detectedIn)}`,
		),
		...installFields(what.install, what.undecided),
	];
	for (const agent of what.agentFiles) {
		lines.push(field(agent.name, describeAgentFile(agent)));
	}
	return [...lines, '', ...snippetSection(what.where.relative, what.agentFiles)].join('\n');
}

/**
 * The `install` row — one line, or the list of lines nobody has picked between yet.
 *
 * The listed form prints each variant as the whole `--install '…'` flag rather than as a task
 * name, because the next thing the reader does is run init again with one of them: a report that
 * made them assemble the flag themselves would be handing back the detection and keeping the
 * part that is easy to get wrong.
 */
function installFields(
	install: Choice<HookCommand> | undefined,
	undecided: Undecided | undefined,
): string[] {
	if (undecided === undefined) {
		return [
			field(
				'install',
				install === undefined
					? 'none — install_app will answer install-hook-undeclared'
					: `${describeCommand(install.value)}${from(install.detectedIn)}`,
			),
		];
	}
	if (undecided.choices.length === 0) {
		return [
			field(
				'install',
				`none — ${undecided.source} declares product flavors init could not read; pass ` +
					`--install with the variant's task (./gradlew :app:tasks lists them)`,
			),
		];
	}
	return [
		field(
			'install',
			`none — ${undecided.source} declares product flavors, one install per variant; ` +
				`init picked none:`,
		),
		...undecided.choices.map((line) => field('', installFlag(line))),
	];
}

function snippetSection(documentPath: string, agentFiles: readonly AgentReport[]): string[] {
	const placed = agentFiles.some(
		(agent) => agent.outcome === 'created' || agent.outcome === 'updated',
	);
	const heading = placed
		? 'The block that went into the agent files above:'
		: 'Add this to the file your agent reads, or run init again with --write:';
	return [heading, '', agentSnippet(documentPath), ''];
}

function describeAgentFile(agent: AgentReport): string {
	return agent.outcome === 'pointer'
		? `points at ${agent.target} — put the snippet there, not here`
		: `snippet ${agent.outcome}`;
}

function field(label: string, value: string): string {
	return `  ${label.padEnd(12)}${value}`;
}

function from(detectedIn: string | undefined): string {
	return detectedIn === undefined ? '' : `  (from ${detectedIn})`;
}

/**
 * Everything a run needs said on stderr, whichever mode it was in.
 *
 * On stderr and not in the document, because `--json` promises exactly one document on stdout —
 * and because every line here is something the operator has to go and do, which is a diagnostic
 * rather than a result.
 */
function reportCaveats(
	hookFile: FileReport,
	remote: boolean,
	write: boolean,
	agentFiles: readonly AgentReport[],
	undecided: Undecided | undefined,
): void {
	if (undecided !== undefined) {
		out.warn(installChoiceCaveat(undecided, hookFile.outcome === 'kept'));
	}
	if (hookFile.outcome === 'kept') {
		out.warn(
			`${hookFile.path} was already there and has been left exactly as it is. It may carry ` +
				`helper services, a teardown or an install nobody could reconstruct from this ` +
				`directory. Compare it yourself, or re-run with --force to replace it.`,
		);
	}
	if (remote) {
		out.warn(
			`${HOST_ADDRESS_ENV_VAR} is set, so the devices are on another machine. The hook file ` +
				`above was written here for the one field a client reads out of it — the host needs ` +
				`its own copy, under its own projects root, and any 'cwd' in it is a path on that ` +
				`machine rather than this one. The host's address, port and token stay in your ` +
				`environment: none of them is written into ${MCP_CONFIG_FILE}, which is a file most ` +
				`projects commit.`,
		);
	}
	for (const agent of agentFiles) {
		if (agent.outcome === 'pointer') {
			out.warn(
				`${agent.name} is a pointer at ${agent.target} rather than a document of its own, so ` +
					`nothing was written into it. The snippet belongs in ${agent.target}.`,
			);
		}
	}
	if (!write && agentFiles.every((agent) => agent.outcome !== 'created')) {
		out.warn(
			'Nothing was written into an agent file. Until the snippet is in one, an agent working ' +
				'in this project has the tools and has not been told when to reach for them.',
		);
	}
}

/**
 * What to say about a project whose install init would have had to guess.
 *
 * It is a warning and not a failure: the run wrote everything else, and exiting non-zero would
 * make every later re-run of a project with a tuned hook file fail over a field that run was
 * never going to touch. The fix named is the re-run, and it carries `--force` only when this run
 * wrote the hook file itself — a kept file is the operator's to edit, and the "kept" warning
 * below already explains the flag.
 */
function installChoiceCaveat(undecided: Undecided, kept: boolean): string {
	const why =
		`${undecided.source} declares product flavors, so this project has one install task per ` +
		`variant and no ':app:installDebug'. No install was registered: which variant agents are ` +
		`meant to be given is a choice init will not make for you.`;
	if (undecided.choices.length === 0) {
		return (
			`${why} Nor could it read the flavors out of that file — a block built in a loop or by ` +
			`'all { }' is Gradle's to evaluate and nobody else's. Run './gradlew :app:tasks' for the ` +
			`real install tasks, then ${registerWith(`--install '<the line you want>'`, kept)}`
		);
	}
	return (
		`${why} The report above lists one ready-to-paste '--install' line per variant — ` +
		`${registerWith(installFlag(undecided.choices[0] as string), kept)}`
	);
}

function registerWith(flag: string, kept: boolean): string {
	return kept
		? `add that line to the hook file as its 'install', or re-run with it: ` +
				`${out.INVOCATION} init ${flag} --force`
		: `re-run with the one you want: ${out.INVOCATION} init ${flag} --force`;
}

async function readIfPresent(file: string): Promise<string | undefined> {
	try {
		return await readFile(file, 'utf8');
	} catch {
		return undefined;
	}
}
