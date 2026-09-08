/**
 * `rover keep` — which of a host's archived tests the operator has said to keep (D33).
 *
 * Three subcommands over two methods: `list` is `list_kept_tests`, and `add` and `remove` are
 * `set_kept_tests` with `kept` true and false. A press that stands for several tests is one call
 * on the surface; this CLI names one test at a time, which is the shape a command line has.
 *
 * **Unlike `rover users`, this one does take `--host`.** The user store is the machine's own file
 * and `users` reaches it directly (D25); the `Keep` flag is a *host's* record of a *host's*
 * archive, so it is asked for over the surface like every other host question — and a remote
 * host's flag is not this machine's to edit behind its daemon's back.
 *
 * The two positionals are the components a `rover archive` listing named: `<project>` and
 * `<test-name>`, as the archive filed them, never a path on the host (D19) and never the caller's
 * own attribution strings, which `pathSegment` may have rewritten on the way in. That is what
 * makes this command and the panel's tick name the same test.
 *
 * `--actor` is required on `add` and `remove` and **never derived** — `force-release`'s reasoning
 * word for word: it records who said to keep this, and a value this CLI invented would attribute
 * the decision to nobody. Nothing here falls back to the environment, to a project hook file or to
 * whoever authenticated to the host (D20, D28).
 *
 * Exposed at all because D4 makes the CLI the interface everything is debugged through: an
 * operator action that only a browser can perform is one nobody can reach when the browser is the
 * thing that is broken.
 *
 * **Nothing here prunes anything — and what this exempts a test from now exists.** `rover sweep`
 * runs the host's retention policy, and a test named here is exempt from both of its bounds
 * absolutely, not even taken to bring the archive under its budget (D35, D36, #238). What is still
 * undecided is who runs that sweep unattended (`PROJECT.md` §9.4): nothing on the host calls it on
 * its own.
 */

import {
	ArchivePathSegmentSchema,
	type KeptTestRef,
	type ListKeptTestsResult,
	type SetKeptTestsResult,
} from '../../ipc/methods.js';
import { EXIT_FAILED, EXIT_OK } from '../_shared/exit.js';
import {
	expectPositionals,
	GLOBAL_OPTIONS,
	parseCommandArgs,
	requireAttribution,
	UsageError,
} from '../_shared/flags.js';
import { connectToHost, type HostName, resolveHost } from '../_shared/host.js';
import * as out from '../_shared/output.js';

export const USAGE = `rover keep — which of a host's archived tests are kept

Usage:
  rover keep list [--host <name>] [--json]
  rover keep add <project> <test-name> --actor <string> [--host <name>] [--json]
  rover keep remove <project> <test-name> --actor <string> [--host <name>] [--json]

  list     Every test this host keeps, as the pair that names it. An empty answer is a host
           that keeps nothing, and exits 0.
  add      Keep one test. Keeping a test that is already kept changes nothing and is not an
           error — the record of who first kept it is left as it is.
  remove   Stop keeping one test. A test that was not kept is not an error either.

  --actor  Who is keeping it. Required on add and remove, and never derived: it records who
           said to keep this, so a value guessed for you would attribute the decision to
           nobody.

The two arguments are the components a \`rover archive\` listing named — the project and the
test name as the archive filed them, never a path on the host, which is not yours to know.
The flag is per test rather than per run: a test's runs are kept or not together.

The flag lives in the host's own file, outside the artifact tree, so it survives a daemon
restart. It is what a sweep exempts: a kept test is never taken by the host's disk budget
or its age limit, not even to bring the archive under budget. That holds for the sweep the host
runs itself after every lease ends — the disk budget, unasked — as much as for \`rover sweep\`,
which is still the only thing that runs the age limit.

A refusal exits 1: the host keeps as many tests as it will hold, or it could not read or
write its own record. Which it was is in the host's own log, never in the answer.`;

const OPTIONS = {
	...GLOBAL_OPTIONS,
	actor: { type: 'string' },
} as const;

const HEADINGS = ['PROJECT', 'TEST'] as const;

interface Invocation {
	readonly host: HostName;
	readonly positionals: string[];
	readonly json: boolean;
	readonly actor: string | undefined;
}

type Subcommand = (invocation: Invocation) => Promise<number>;

export function renderKeptTests(host: HostName, tests: readonly KeptTestRef[]): string {
	if (tests.length === 0) {
		return `Host '${host}' keeps no archived tests.`;
	}
	return out.renderTable(
		HEADINGS,
		tests.map((test) => [test.project, test.testName]),
	);
}

/** The sentence for a read the host could not answer. The reason stays on the host (D19). */
function renderUnreadable(host: HostName): string {
	return (
		`Host '${host}' cannot say which tests it keeps — its own record is there and could not ` +
		`be read. The host's own log names why, and the file was left exactly as it is.`
	);
}

/** The two sentences a write that did not happen gets, each a different thing to do next. */
function renderRefusal(host: HostName, result: SetKeptTestsResult): string {
	if (result.outcome === 'refused') {
		return (
			`Host '${host}' refused (${result.reason}): it already keeps as many tests as it will ` +
			`hold. Nothing was written, and nothing it keeps was dropped to make room.`
		);
	}
	return (
		`Host '${host}' did not write its record of kept tests — it could not be read or could ` +
		`not be written, so nothing changed. The host's own log names why.`
	);
}

/**
 * The components, validated **here** rather than at the host — `rover archive`'s reasoning
 * verbatim: the host would otherwise answer Zod's own words about a key the caller never typed,
 * over a round trip that exits 1, the code reserved for "the host said no". Importing the schema
 * rather than restating the rule is what keeps the two from drifting.
 */
function testRefOf(subcommand: string, project: string, testName: string): KeptTestRef {
	return {
		project: componentOf(subcommand, '<project>', project),
		testName: componentOf(subcommand, '<test-name>', testName),
	};
}

function componentOf(subcommand: string, name: string, raw: string): string {
	const parsed = ArchivePathSegmentSchema.safeParse(raw);
	if (!parsed.success) {
		throw new UsageError(
			`rover keep ${subcommand}: '${out.escapeControlCharacters(raw)}' is not an archive path ` +
				`component — ${name} is a single directory name, exactly as a \`rover archive\` ` +
				`listing named it, and never a path.`,
		);
	}
	return parsed.data;
}

function requireActor(subcommand: string, actor: string | undefined): string {
	return requireAttribution(
		`keep ${subcommand}`,
		'actor',
		actor,
		'it records who said to keep this test and is never derived from your environment',
	);
}

function expectNoActor(subcommand: string, actor: string | undefined): void {
	if (actor !== undefined) {
		throw new UsageError(
			`rover keep ${subcommand}: --actor is only accepted by 'add' and 'remove' — a read ` +
				`attributes nothing`,
		);
	}
}

async function list({ host, positionals, json, actor }: Invocation): Promise<number> {
	expectNoActor('list', actor);
	expectPositionals('keep list', positionals, []);

	const client = await connectToHost(host);
	try {
		const result: ListKeptTestsResult = await client.request('list_kept_tests', {});
		if (json) {
			out.printJson(host, result);
		} else if (result.outcome === 'listed') {
			out.info(renderKeptTests(host, result.tests));
		} else {
			out.error(renderUnreadable(host));
		}
		return result.outcome === 'listed' ? EXIT_OK : EXIT_FAILED;
	} finally {
		await client.close();
	}
}

/** `add` and `remove` are one call with `kept` flipped, so they are one function. */
function setter(subcommand: 'add' | 'remove', kept: boolean): Subcommand {
	return async ({ host, positionals, json, actor }: Invocation): Promise<number> => {
		const [project, testName] = expectPositionals(`keep ${subcommand}`, positionals, [
			'<project>',
			'<test-name>',
		]);
		const test = testRefOf(subcommand, project ?? '', testName ?? '');
		const resolved = requireActor(subcommand, actor);

		const client = await connectToHost(host);
		try {
			const result: SetKeptTestsResult = await client.request('set_kept_tests', {
				tests: [test],
				kept,
				actor: resolved,
			});
			if (json) {
				out.printJson(host, result);
			} else if (result.outcome === 'set') {
				out.info(renderSet(host, test, kept, result.tests));
			} else {
				out.error(renderRefusal(host, result));
			}
			return result.outcome === 'set' ? EXIT_OK : EXIT_FAILED;
		} finally {
			await client.close();
		}
	};
}

/**
 * What a write that landed says: the test it was about, and how many the host now keeps —
 * because the answer carries the whole set, so saying so costs no second request.
 */
export function renderSet(
	host: HostName,
	test: KeptTestRef,
	kept: boolean,
	tests: readonly KeptTestRef[],
): string {
	const named = `${out.escapeControlCharacters(test.project)} > ${out.escapeControlCharacters(
		test.testName,
	)}`;
	return (
		`${kept ? 'Keeping' : 'No longer keeping'} '${named}' on host '${host}'. It now keeps ` +
		`${tests.length} ${tests.length === 1 ? 'test' : 'tests'}.`
	);
}

/** Null-prototype, for the reason `src/cli/index.ts` gives about every table under `src/cli/`. */
const SUBCOMMANDS: Record<string, Subcommand | undefined> = Object.assign(Object.create(null), {
	list,
	add: setter('add', true),
	remove: setter('remove', false),
});

const NAMES = 'list, add, remove';

export async function run(argv: string[]): Promise<number> {
	const { values, positionals } = parseCommandArgs('keep', argv, OPTIONS);
	if (values.help === true) {
		out.info(USAGE);
		return EXIT_OK;
	}

	const [subcommand, ...rest] = positionals;
	if (subcommand === undefined) {
		throw new UsageError(`rover keep: a subcommand is required — one of ${NAMES}`);
	}
	const handler = SUBCOMMANDS[subcommand];
	if (!handler) {
		throw new UsageError(
			`rover keep: unknown subcommand '${subcommand}' — expected one of ${NAMES}`,
		);
	}

	return handler({
		host: resolveHost(values.host),
		positionals: rest,
		json: values.json === true,
		actor: values.actor,
	});
}
