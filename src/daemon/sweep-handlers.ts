/**
 * The `sweep_archive` handler — the retention policy's one surface (§9.4, §10, D33).
 *
 * **One call into `./archive-sweep.ts`, one audit line, and the outcome.** Nothing is cached and
 * nothing is held: the policy is a value the daemon was constructed with, the exemption list is
 * re-read by the sweeper on every call (D6), and the archive's size is the walk rather than a
 * number kept anywhere.
 *
 * **The host's own paths never leave here.** `SweepArchiveResultSchema` answers three directory
 * *names* per run and has no field a path would fit in — not even a `message` — and the sweeper's
 * own warnings name the paths on the host's log instead, which is `./list-archive.ts`'s
 * arrangement for the same reason (D19). `src/ipc/server.ts` parses every handler's return value
 * against that `.strict()` schema, so a path smuggled onto a result is `invalid_result` on the host
 * rather than a disclosure.
 *
 * **The answer is bounded and says so.** A first sweep of a neglected archive can take thousands
 * of runs; the list is capped at `MAX_SWEEP_REPORTED_RUNS` with `truncated`, exactly as
 * `search_archive` bounds its own answer, and the totals beside it stay exact. Every run that went
 * is on the host's own log in full regardless.
 *
 * **One audit line per call, including a dry run** — `force_release_device`'s line in this key
 * (D28). Who asked, whether anything was actually deleted, and what it came to. The actor goes
 * through `JSON.stringify` for `./kept-tests-handlers.ts`'s reason: a newline in it would otherwise
 * end the line and start a fabricated one in the daemon's own record. No token is in scope on this
 * path at all (D20).
 */

import type { IpcHandlers, SweepArchiveParams, SweepArchiveResult } from '../ipc/methods.js';
import { MAX_SWEEP_REPORTED_RUNS } from '../ipc/methods.js';
import type { ArchiveSweeper, DoomedRun } from './archive-sweep.js';

export interface SweepHandlerOptions {
	readonly sweeper: ArchiveSweeper;
	/**
	 * Where the record of a sweep is written. Defaults to `console.warn`, which is the daemon's
	 * own stderr — `./kept-tests-handlers.ts`'s `audit`, for its reasons: it is the record D28
	 * requires and deliberately not a durable audit store.
	 */
	readonly audit?: (message: string) => void;
}

export type SweepArchiveHandler = Pick<IpcHandlers, 'sweep_archive'>;

export function createSweepArchiveHandler(options: SweepHandlerOptions): SweepArchiveHandler {
	const audit = options.audit ?? ((message: string) => console.warn(message));

	return {
		async sweep_archive(params: SweepArchiveParams): Promise<SweepArchiveResult> {
			// `'both'` always, here: the phase that asks for the budget alone is the phase that
			// puts a trigger on a release path, and there is no trigger in this one.
			const outcome = await options.sweeper.sweep({ dryRun: params.dryRun, bounds: 'both' });
			if (outcome.outcome !== 'swept') {
				// The path and the reason are already on the host's own log, where they belong.
				audit(refusedLine(params, outcome.outcome));
				return { outcome: outcome.outcome };
			}

			audit(auditLine(params, outcome.runs.length, outcome.freedBytes));
			return {
				outcome: 'swept' as const,
				dryRun: outcome.dryRun,
				runs: outcome.runs.slice(0, MAX_SWEEP_REPORTED_RUNS).map(reportedRunOf),
				truncated: outcome.runs.length > MAX_SWEEP_REPORTED_RUNS,
				freedBytes: outcome.freedBytes,
				totalBytesBefore: outcome.totalBytesBefore,
				totalBytesAfter: outcome.totalBytesAfter,
				stillOverBudget: outcome.stillOverBudget,
			};
		},
	};
}

/** What a swept run looks like on the wire: the three names, the bytes, the bound. No path. */
function reportedRunOf(run: DoomedRun) {
	return {
		project: run.project,
		testName: run.testName,
		run: run.run,
		sizeBytes: run.sizeBytes,
		bound: run.bound,
	};
}

/** The record D28 requires: what happened, how much of it, asked for by whom. */
function auditLine(params: SweepArchiveParams, count: number, freedBytes: number): string {
	const runs = `${count} ${count === 1 ? 'run' : 'runs'}`;
	return (
		`${params.dryRun ? 'Asked what a sweep of the artifact archive would take' : 'Swept the artifact archive'} — ` +
		`${runs}, ${freedBytes} bytes${params.dryRun ? ' (nothing was deleted)' : ''} — asked for ` +
		`by ${JSON.stringify(params.actor)}.`
	);
}

/** The same record for a sweep that could not run. Says plainly that nothing was deleted. */
function refusedLine(params: SweepArchiveParams, outcome: 'missing' | 'unreadable'): string {
	return (
		`A sweep of the artifact archive asked for by ${JSON.stringify(params.actor)} answered ` +
		`'${outcome}' and deleted nothing. The host's own log names why; no path and no reason ` +
		`leaves this host.`
	);
}
