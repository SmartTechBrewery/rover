/**
 * `rover delete-project` — take one project's registration and everything the host holds for it
 * (D42, #271).
 *
 * The argument is a **name the host itself answered with** — the identifier `list_projects` names a
 * registration by, or the component `rover archive` lists a project's subtree under, which are one
 * string for a registered project — and never a path: the host composes its own paths from its own
 * roots, and nothing on this surface takes one (D19). One call removes the hook file under
 * the host's projects directory, that project's own subtree of the artifact archive, and its
 * entries in the host's kept-tests record.
 *
 * **`--actor` is required and never derived** — `force-release`'s and `keep`'s reasoning word for
 * word: it records who deleted somebody's project, and a value this CLI invented would attribute
 * the decision to nobody. It authorizes nothing (D20, D28).
 *
 * **No confirmation prompt, no `--dry-run`, no undo and no trash directory.** `rover sweep`'s
 * settled rule for a deletion an operator typed: the command does what it says, and the usage text
 * carries the warning rather than a prompt carrying it. A kept test is taken too, which is the one
 * thing about this command somebody could be surprised by, so it is said in the usage text, in the
 * rendered answer's own count, and nowhere else.
 *
 * **No path is printed, because none is answered.** The identifier goes through
 * `escapeControlCharacters`, as `rover keep`'s table does, and the diagnosis for a half that would
 * not go stays on the host's own log where a path belongs.
 *
 * Exposed at all because D4 makes the CLI the interface everything is debugged through: this
 * action is deliberately not on the panel's surface until the screen that calls it lands, so today
 * the CLI is the whole of its reach.
 */

import type { DeleteProjectResult } from '../../ipc/methods.js';
import { EXIT_FAILED, EXIT_OK } from '../_shared/exit.js';
import {
	expectPositionals,
	GLOBAL_OPTIONS,
	parseCommandArgs,
	requireAttribution,
} from '../_shared/flags.js';
import { connectToHost, type HostName, resolveHost } from '../_shared/host.js';
import * as out from '../_shared/output.js';

export const USAGE = `rover delete-project — remove a project's registration and everything filed under it

Usage: rover delete-project <project> --actor <string> [--host <name>] [--json]

  --actor  Who is deleting it. Required and never derived: it records who removed somebody's
           project, so a value guessed for you would attribute the decision to nobody.

The argument is a project name the host answers with — the identifier it lists a registration
by, or the name \`rover archive\` lists a project's artifacts under — and never a path on the
host: the host builds its own paths from its own roots and this command sends none.

Three things go, in one action: the project's hook file, its own subtree of the host's artifact
archive, and its entries in the host's record of which tests are kept. Nothing outside that
subtree is touched — not another project's runs, and not another project's kept tests.

**A test you marked \`rover keep\` is taken too.** That flag exempts a test from the host's two
retention bounds, and you naming one project is not one of those bounds; the answer says how
many kept entries went with it.

There is no undo, no trash directory, no dry run and no confirmation prompt. A command you
typed does what it says.

A live lease on the project is refused and nothing at all is touched: the hook file carries the
teardown that lease is still owed, and the archive subtree is what it is filing into right now.
Wait for it to end, or \`rover force-release\` the device first.

Exits 1 for anything that is not a clean delete: a project this host has nothing at all for, a
half the host would not remove — the rest may still have gone, and the answer says which — or a
live lease.`;

const OPTIONS = {
	...GLOBAL_OPTIONS,
	actor: { type: 'string' },
} as const;

export async function run(argv: string[]): Promise<number> {
	const { values, positionals } = parseCommandArgs('delete-project', argv, OPTIONS);
	if (values.help === true) {
		out.info(USAGE);
		return EXIT_OK;
	}
	const [project] = expectPositionals('delete-project', positionals, ['<project>']);
	const actor = requireAttribution(
		'delete-project',
		'actor',
		values.actor,
		'it records who removed this project and is never derived from your environment',
	);
	const host = resolveHost(values.host);

	const client = await connectToHost(host);
	try {
		const result = await client.request('delete_project', { project: project ?? '', actor });
		if (values.json === true) {
			out.printJson(host, result);
		} else if (result.outcome === 'deleted') {
			out.info(renderDeleteProject(host, project ?? '', result));
		} else {
			out.error(renderDeleteProject(host, project ?? '', result));
		}
		return result.outcome === 'deleted' ? EXIT_OK : EXIT_FAILED;
	} finally {
		await client.close();
	}
}

/**
 * One sentence per outcome, each a different next move — which is the whole reason the host
 * answers four and not one.
 *
 * The two that reached the disk carry the byte count and the kept-test count, because *how much
 * went* and *how many exemptions went with it* are the two facts nobody can recover afterwards.
 */
export function renderDeleteProject(
	host: HostName,
	project: string,
	result: DeleteProjectResult,
): string {
	const named = out.escapeControlCharacters(project);
	if (result.outcome === 'not-registered') {
		return (
			`Host '${host}' has nothing for '${named}' — no hook file, nothing filed in its artifact ` +
			`archive and no kept tests. Nothing was deleted.`
		);
	}
	if (result.outcome === 'refused') {
		return (
			`Host '${host}' refused to delete '${named}': a lease on it is live, so nothing was ` +
			`touched. Wait for that lease to end, or force-release the device it holds first.`
		);
	}

	const halves = [
		`hook file ${describe(result.registration)}`,
		`archive subtree ${describe(result.archive)} (${result.freedBytes} bytes freed)`,
		keptTestsPhrase(result.keptTests, result.keptTestsRemoved),
	].join(', ');
	if (result.outcome === 'deleted') {
		return `Host '${host}' deleted '${named}' — ${halves}.`;
	}
	return (
		`Host '${host}' only partly deleted '${named}' — ${halves}. What did not go is still ` +
		`there; the host's own log names why, and no path or reason leaves it. Fix that and run ` +
		`this again — a half that has already gone is answered as absent the second time.`
	);
}

/** What one half's fate reads as: it went, it was never there, or the host would not remove it. */
function describe(part: 'removed' | 'absent' | 'failed'): string {
	if (part === 'removed') {
		return 'removed';
	}
	return part === 'absent' ? 'was not there' : 'NOT removed';
}

/**
 * The kept-tests half, as a fate **and** a count.
 *
 * The count alone would hide the one failure this half has: a store the host could not read is
 * left untouched and removes nothing, which reads identically to a project that had no kept tests
 * — and those are the two facts an operator does something different about.
 */
function keptTestsPhrase(part: 'removed' | 'absent' | 'failed', removed: number): string {
	if (part === 'removed') {
		return `${removed} kept ${removed === 1 ? 'test' : 'tests'} removed`;
	}
	return part === 'absent' ? 'no kept tests to remove' : 'kept tests NOT removed';
}
