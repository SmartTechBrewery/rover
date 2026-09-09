/**
 * `rover delete-group` — take the runs one testing group holds, and nothing else (D43, #277).
 *
 * The two arguments are the pair the host itself answers with — the `project` component a
 * `rover archive` listing named, and the `group-id` a lease supplied and `list_archive_groups`
 * reports — and never a path: the host composes its own paths from its own roots, and nothing on
 * this surface takes one (D19). The group id is matched against the contents of each run's
 * `group_id.json`, so a value with a slash or a newline in it is data here rather than an address.
 *
 * **The two things a reader could get wrong are in the usage text, not in a prompt.** *Only the
 * runs of this group go* — a test's other runs stay, because a test directory may hold runs of
 * other groups and of none (D22) — and *a test emptied by it is removed, kept flag and all*. Those
 * are exactly the two halves of the surgical reading D43 settled, and they are the whole of what
 * separates this command from `rover delete-test`.
 *
 * **`--actor` is required and never derived** — `force-release`'s, `keep`'s, `delete-project`'s and
 * `delete-test`'s reasoning word for word: it records who deleted somebody's artifacts, and a value
 * this CLI invented would attribute the decision to nobody. It authorizes nothing (D20, D28).
 *
 * **No confirmation prompt, no `--dry-run`, no undo and no trash directory** — the settled rule for
 * a deletion an operator typed. What this command *does* have that its siblings do not is a
 * `partial` that means *ask again*: a group's delete is a bounded walk, so a walk cut short leaves
 * runs of the group that were never reached, and the answer says so rather than claiming the group
 * is gone.
 *
 * **No path is printed, because none is answered.** Both components go through
 * `escapeControlCharacters`, as `rover keep`'s table does, and the diagnosis for a run or a half
 * that would not go stays on the host's own log where a path belongs.
 */

import type { DeleteArchivedGroupResult } from '../../ipc/methods.js';
import { EXIT_FAILED, EXIT_OK } from '../_shared/exit.js';
import {
	expectPositionals,
	GLOBAL_OPTIONS,
	parseCommandArgs,
	requireAttribution,
} from '../_shared/flags.js';
import { connectToHost, type HostName, resolveHost } from '../_shared/host.js';
import * as out from '../_shared/output.js';

export const USAGE = `rover delete-group — remove the runs one testing group holds, and nothing else

Usage: rover delete-group <project> <group-id> --actor <string> [--host <name>] [--json]

  --actor  Who is deleting it. Required and never derived: it records who removed somebody's
           artifacts, so a value guessed for you would attribute the decision to nobody.

The two arguments are names the host answers with — the project component a \`rover archive\`
listing gave you, and the group id a lease named — and never a path on the host. The group id
is matched against what each run filed, not against a directory: the archive has no level for
a group, which is why this is a walk of one project rather than one removal.

**Only the runs of this group go.** A test the group touches keeps every run of it that is not
in this group — runs of another group, and runs of none. That is deliberate: a test name is
not unique to one group, so taking the whole test would destroy runs that were never part of
what you named.

**A test this empties is removed, kept flag and all.** When the last run left under a test is
one of this group's, the test's own directory goes with it and its entry in the host's record
of which tests are kept goes too — you naming a group is not one of the host's two retention
bounds. A test still holding runs keeps its \`rover keep\` mark untouched. A project left
holding nothing is removed, and the archive root never is.

There is no undo, no trash directory, no dry run and no confirmation prompt. A command you
typed does what it says.

A live lease filing into any run of this group is refused and nothing at all is touched: that
run directory is what the lease is writing into right now. Wait for it to end, or
\`rover force-release\` the device first.

Exits 1 for anything that is not a clean delete: a group no run of this project named, a
delete the host could not finish — the runs that did go are reported, and running it again is
the next move — or a live lease.`;

const OPTIONS = {
	...GLOBAL_OPTIONS,
	actor: { type: 'string' },
} as const;

export async function run(argv: string[]): Promise<number> {
	const { values, positionals } = parseCommandArgs('delete-group', argv, OPTIONS);
	if (values.help === true) {
		out.info(USAGE);
		return EXIT_OK;
	}
	const [project, groupId] = expectPositionals('delete-group', positionals, [
		'<project>',
		'<group-id>',
	]);
	const actor = requireAttribution(
		'delete-group',
		'actor',
		values.actor,
		'it records who removed this group’s runs and is never derived from your environment',
	);
	const host = resolveHost(values.host);

	const client = await connectToHost(host);
	try {
		const result = await client.request('delete_archived_group', {
			project: project ?? '',
			groupId: groupId ?? '',
			actor,
		});
		if (values.json === true) {
			out.printJson(host, result);
		} else if (result.outcome === 'deleted') {
			out.info(renderDeleteArchivedGroup(host, project ?? '', groupId ?? '', result));
		} else {
			out.error(renderDeleteArchivedGroup(host, project ?? '', groupId ?? '', result));
		}
		return result.outcome === 'deleted' ? EXIT_OK : EXIT_FAILED;
	} finally {
		await client.close();
	}
}

/**
 * One sentence per outcome, each a different next move — which is the whole reason the host answers
 * four.
 *
 * The two that reached the disk carry **how many runs went**, the bytes and the kept-test count. The
 * run count leads, because it is the figure only this scope can state and the one nobody can
 * recover afterwards: a group has no directory whose size stands for it.
 */
export function renderDeleteArchivedGroup(
	host: HostName,
	project: string,
	groupId: string,
	result: DeleteArchivedGroupResult,
): string {
	const named = `${out.escapeControlCharacters(project)}/${out.escapeControlCharacters(groupId)}`;
	if (result.outcome === 'not-found') {
		return (
			`Host '${host}' has no run of '${named}' — no run filed under that project names that ` +
			`group. Nothing was deleted.`
		);
	}
	if (result.outcome === 'refused') {
		return (
			`Host '${host}' refused to delete '${named}': a lease filing into one of its runs is ` +
			`live, so nothing at all was touched. Wait for that lease to end, or force-release the ` +
			`device it holds first.`
		);
	}

	const halves = [
		`${runsPhrase(result.runsRemoved)} (${result.freedBytes} bytes freed)`,
		keptTestsPhrase(result.keptTests, result.keptTestsRemoved),
	].join(', ');
	if (result.outcome === 'deleted') {
		return (
			`Host '${host}' deleted the runs of '${named}' — ${halves}. Runs of the same tests that ` +
			`are not in this group are untouched.`
		);
	}
	return (
		`Host '${host}' only partly deleted '${named}' — ${halves}. Some of it may still be filed: ` +
		`the host's own log names what stopped it, and no path or reason leaves it. Fix that and ` +
		`run this again — the runs that have already gone are simply not found the second time.`
	);
}

/** How many runs went, and the singular is not cosmetic: a group of one run is ordinary. */
function runsPhrase(runsRemoved: number): string {
	return `${runsRemoved} ${runsRemoved === 1 ? 'run' : 'runs'} removed`;
}

/**
 * The kept-tests half, as a fate **and** a count — and here the `absent` reading says the thing
 * this command is most likely to be asked about.
 *
 * *No test was emptied* is the ordinary answer for a group whose tests all still hold runs, and it
 * is not the same fact as a store the host could not read. Saying which is what makes *a test still
 * standing keeps its `Keep`* visible rather than something a reader has to trust.
 */
function keptTestsPhrase(part: 'removed' | 'absent' | 'failed', removed: number): string {
	if (part === 'removed') {
		return `${removed} kept ${removed === 1 ? 'test' : 'tests'} removed`;
	}
	return part === 'absent' ? 'no emptied test was kept' : 'kept tests NOT removed';
}
