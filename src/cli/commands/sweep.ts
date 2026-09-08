/**
 * `rover sweep` — run the host's retention policy over its artifact archive (§9.4, §10).
 *
 * **The only trigger there is in this phase.** Nothing on the host sweeps on its own — no timer,
 * no per-lease check, no start-up pass — so this command is how the policy is reached, which is
 * D4's rule arriving where it matters most: a deletion routine an operator cannot run by hand,
 * watch, and ask a question of first is one nobody can debug.
 *
 * **`--dry-run` first in the usage text, and deliberately not the default.** A command somebody
 * typed does what it says, and a `sweep` that quietly asked instead of swept would be worse than
 * either: the operator would believe the archive had been cleared. So the flag leads the text,
 * every example shows it, and the plain form deletes.
 *
 * **`--actor` is required and never derived** — `force-release`'s and `keep`'s reasoning word for
 * word: it records who pointed this host's sweep at its whole archive, and a value this CLI
 * invented would attribute the decision to nobody. It authorizes nothing (D20, D28). It is
 * required on the dry run too, because the walk is real I/O on a machine somebody else may be
 * using.
 *
 * **No path is printed, because none is answered.** The host names three directory components per
 * run — the same vocabulary a `rover archive` listing uses — and the archive's own location is
 * not the client's to know (D19). Every component goes through `escapeControlCharacters`, as
 * `rover keep`'s table does.
 */

import type { SweepArchiveResult } from '../../ipc/methods.js';
import { EXIT_FAILED, EXIT_OK } from '../_shared/exit.js';
import {
	expectPositionals,
	GLOBAL_OPTIONS,
	parseCommandArgs,
	requireAttribution,
} from '../_shared/flags.js';
import { connectToHost, type HostName, resolveHost } from '../_shared/host.js';
import * as out from '../_shared/output.js';

export const USAGE = `rover sweep — delete what the host's retention policy no longer keeps

Usage:
  rover sweep --dry-run --actor <string> [--host <name>] [--json]
  rover sweep --actor <string> [--host <name>] [--json]

  --dry-run  Ask what would go and delete nothing. Not the default: a sweep you typed
             sweeps. Run it first — deletion has no undo, no trash directory and no
             confirmation prompt.
  --actor    Who is asking. Required on both forms, and never derived: it records who
             pointed this host's sweep at its whole archive.

Two bounds, and whichever is reached first is the one that acts: ROVER_ARTIFACTS_BUDGET_MB
(default 1024) is how many megabytes of archive the host may keep, and
ROVER_ARTIFACTS_MAX_AGE_DAYS (default 30) is how old a test may get. Both are the **host's**
settings, read from its own environment — this command sends neither and no answer carries
either.

The unit of deletion is one run, taken whole, and the oldest go first. A test's age is the age
of its newest run, so a test with a run from yesterday is not old however much else it holds.
A test you have marked \`rover keep add\` is exempt from both bounds, and so is a run whose
lease is live — and neither is ever taken to get under the budget. An archive that is over
budget with only those left is reported as such and nothing is deleted for it; that one only
you can resolve, by unticking a test or raising the budget.

Nothing on the host runs this on its own yet. This command is the whole of the trigger.

A run is named by the components a \`rover archive\` listing named — the project, the test name
and the run directory — never a path on the host, which is not yours to know.

Exits 1 when the host has no archive at all, or cannot walk it or read its own record of what
is kept. In that last case nothing was deleted: the list of what you asked to keep is exactly
what a deletion may not proceed without.`;

const OPTIONS = {
	...GLOBAL_OPTIONS,
	actor: { type: 'string' },
	'dry-run': { type: 'boolean', default: false },
} as const;

const HEADINGS = ['PROJECT', 'TEST', 'RUN', 'SIZE', 'BOUND'] as const;

export async function run(argv: string[]): Promise<number> {
	const { values, positionals } = parseCommandArgs('sweep', argv, OPTIONS);
	if (values.help === true) {
		out.info(USAGE);
		return EXIT_OK;
	}
	expectPositionals('sweep', positionals, []);

	const host = resolveHost(values.host);
	const dryRun = values['dry-run'] === true;
	const actor = requireAttribution(
		'sweep',
		'actor',
		values.actor,
		'it records who asked this host to sweep its archive and is never derived from your environment',
	);

	const client = await connectToHost(host);
	try {
		const result: SweepArchiveResult = await client.request('sweep_archive', { dryRun, actor });
		if (values.json === true) {
			out.printJson(host, result);
		} else if (result.outcome === 'swept') {
			out.info(renderSweep(host, result));
		} else {
			out.error(renderRefusal(host, result.outcome));
		}
		return result.outcome === 'swept' ? EXIT_OK : EXIT_FAILED;
	} finally {
		await client.close();
	}
}

/**
 * A headline saying whether anything was deleted, the totals, the table of runs, and — when the
 * budget could not be met — the one sentence only the operator can act on.
 *
 * The dry run's headline says **nothing was deleted** in as many words rather than leaving it to
 * be inferred from the flag the reader typed: the table beside it looks exactly like a real
 * sweep's, and that is the one confusion this command must not permit.
 */
export function renderSweep(
	host: HostName,
	result: Extract<SweepArchiveResult, { outcome: 'swept' }>,
): string {
	const count = result.runs.length;
	const runs = `${count} ${count === 1 ? 'run' : 'runs'}`;
	const headline = result.dryRun
		? `Host '${host}' would delete ${runs}, freeing ${result.freedBytes} bytes of ` +
			`${result.totalBytesBefore} — nothing was deleted.`
		: `Host '${host}' deleted ${runs}, freeing ${result.freedBytes} bytes: its archive went ` +
			`from ${result.totalBytesBefore} to ${result.totalBytesAfter} bytes.`;

	const lines = [headline];
	if (count > 0) {
		lines.push(
			'',
			out.renderTable(
				HEADINGS,
				result.runs.map((run) => [
					out.escapeControlCharacters(run.project),
					out.escapeControlCharacters(run.testName),
					out.escapeControlCharacters(run.run),
					String(run.sizeBytes),
					run.bound,
				]),
			),
		);
	}
	if (result.truncated) {
		lines.push(
			'',
			`At least one further run is not listed above — the answer is bounded. The host's own ` +
				`log names every one of them.`,
		);
	}
	if (result.stillOverBudget) {
		lines.push(
			'',
			`Host '${host}' is still over its disk budget, and every run left is either kept or ` +
				`held by a live lease. Nothing kept and nothing live was deleted to get under it, so ` +
				`this one is yours: untick a kept test, raise the host's budget, or wait for a lease ` +
				`to end.`,
		);
	}
	return lines.join('\n');
}

/** The two sentences a sweep that did not run gets. The reason stays on the host (D19). */
function renderRefusal(host: HostName, outcome: 'missing' | 'unreadable'): string {
	if (outcome === 'missing') {
		return (
			`Host '${host}' has no artifact archive — nothing has ever been filed there, so there ` +
			`was nothing to sweep.`
		);
	}
	return (
		`Host '${host}' did not sweep its archive: it could not walk it, or could not read its ` +
		`own record of which tests are kept. Nothing was deleted — the host's own log names ` +
		`why, and no path or reason leaves it.`
	);
}
