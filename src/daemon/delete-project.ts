/**
 * The `delete_project` handler — one operator action taking a registration and everything the
 * host holds for it (D42, #271).
 *
 * **This is D31's write half, and the write is a *removal*.** D31 refused a hook-file write for
 * two reasons and only one of them transfers. The **code-execution** reason does not: a write is
 * arbitrary code execution as the daemon's user because `install`, every `services[].start`/`stop`
 * and `teardown` are programs the host spawns (`./hook-command.ts`), while a delete makes the host
 * run strictly **less** and names no program at all — the request carries an identifier and the
 * host composes the path from its own root. The **privilege** reason does transfer, and it is
 * answered by the shape of the request rather than by D27's deferred role model: the line that
 * keeps `sweep_archive` off the panel is that a sweep is *untargeted*, a policy deciding what goes
 * across every project on the host, and this is **named and bounded** — the operator names one
 * project and nothing outside that project's own subtree is touched. An operator who may end
 * anyone's lease and untick anyone's `Keep` (D27, D33) may name one finished project. What has
 * **not** opened: no method creates, edits or renames a hook file, `rover init` is still the only
 * way one is written, and none of them takes a path into the projects directory.
 *
 * **Three halves, and the order is load-bearing.** The registration goes first, so a project stops
 * starting services and running teardown even if the archive half then fails — a `partial` where
 * the registration went is the direction that leaves the host doing less. Then this project's own
 * subtree of the archive, through `./archive-sweep.ts`'s `removeProject`: a **third trigger on the
 * deletion path that already exists** rather than a second place the archive is removed, so it
 * inherits that module's per-root serialisation, its `settle()` (which keeps a `process.exit` out
 * of the middle of an `rm`) and its shared `sizeOfTree`. Then the kept-tests store, through
 * `./kept-tests.ts`'s `withKeptTestsLock` — the **same** lock `set_kept_tests` writes under, not a
 * second one, because two chains on one path would serialise each writer against itself and
 * neither against the other.
 *
 * **An explicit delete overrides `Keep`.** D35 makes a kept test exempt from the two retention
 * *bounds*, absolutely; an operator naming one project is not one of those bounds, and the same
 * authority that set the tick is the one removing the project. So the subtree goes whole, kept
 * tests included, every entry naming this project goes with it — no tick outliving the directory
 * it names — and the answer says **how many** went, so a client can say it rather than surprise
 * somebody with it.
 *
 * **A live lease on this project is refused, as data, and nothing at all is touched.** The hook
 * file being deleted is where that lease's `teardown` and its services live, and D9 runs teardown
 * on release **and** on expiry — deleting it under a live lease would remove the teardown before
 * the lease that needs it has ended, which is the teardown-on-the-happy-path-only `ai/RULES.md` §2
 * forbids. And the archive subtree is the directory that lease is filing into right now, which D35
 * exempts absolutely. So the answer is `refused`/`lease-live` in `AcquireDeviceResultSchema`'s
 * idiom, with an obvious next move: wait, or force-release first.
 *
 * **Which leases count: the union of both spellings.** A registration is looked up by exact string
 * (`projectHooksPath`) while the archive subtree is `pathSegment(lease.project)`, so both matter.
 * For a registered identifier the two collapse — `pathSegment` is the identity on a project
 * identifier — and they come apart only for a caller string `pathSegment` rewrote into something
 * that happens to read as one, which is exactly the case a single-sided check would miss.
 *
 * **The residual window is the one the sweep already lives with**: a lease granted between the
 * check and the removal. `liveLeases` is a callback resolved at the moment of the call, exactly as
 * `ArchiveSweeperOptions.liveLeases` is and for its reason, and the gap after it is documented
 * rather than defended with machinery — the sweep resolves the same question inside its own walk.
 *
 * **No host path, no `errno` and no `message` is on any answer, structurally** (D19).
 * `DeleteProjectResultSchema` has no field one would fit in, and `src/ipc/server.ts` parses every
 * handler's return value against that `.strict()` schema, so a path smuggled onto a result is
 * `invalid_result` on the host rather than a disclosure. The diagnosis goes where the path already
 * belongs: a warning here, on the host, as `./list-projects.ts` and `./archive-sweep.ts` warn.
 *
 * **One audit line, in `force_release_device`'s key** (D28), naming the actor, the project and the
 * counts — and saying plainly what did *not* go on the two answers where something did not. Every
 * caller value through `JSON.stringify`, `./kept-tests-handlers.ts`'s reason: a newline would
 * otherwise end the line and start a fabricated one in the daemon's own record. No token is in
 * scope on this path at all (D20).
 */

import { unlink } from 'node:fs/promises';
import type {
	DeletedPart,
	DeleteProjectParams,
	DeleteProjectResult,
	IpcHandlers,
} from '../ipc/methods.js';
import { pathSegment } from './archive-path.js';
import type { ArchiveSweeper } from './archive-sweep.js';
import {
	type KeptTest,
	readKeptTests,
	withKeptTestsLock,
	withoutProject,
	writeKeptTests,
} from './kept-tests.js';
import type { Lease } from './leases.js';
import { projectHooksPath } from './project-hooks.js';

export interface DeleteProjectOptions {
	/** The projects root — the same one the restoration, the install and the listing resolve against. */
	readonly projectsRoot: string;
	/** The kept-tests store, read fresh and cached nowhere (D6). */
	readonly keptTestsPath: string;
	/** The one sweeper, whose per-root serialisation this delete's `rm` runs inside. */
	readonly sweeper: ArchiveSweeper;
	/**
	 * Every live lease, **as a callback rather than a snapshot** — `ArchiveSweeperOptions`' own
	 * reason: the question is answered at the moment of the call, because a lease granted since
	 * construction is exactly the one this must refuse for.
	 */
	readonly liveLeases: () => readonly Lease[];
	/**
	 * Where the record of a delete is written. Defaults to `console.warn`, the daemon's own stderr
	 * — `./kept-tests-handlers.ts`'s `audit`, for its reasons.
	 */
	readonly audit?: (message: string) => void;
	/**
	 * Where something the host could not remove is reported. Defaults to `console.warn`. This is
	 * the **only** place a path and a reason are said, for the reason the module header gives.
	 */
	readonly warn?: (message: string) => void;
}

export type DeleteProjectHandler = Pick<IpcHandlers, 'delete_project'>;

export function createDeleteProjectHandler(options: DeleteProjectOptions): DeleteProjectHandler {
	const audit = options.audit ?? ((message: string) => console.warn(message));
	const warn = options.warn ?? ((message: string) => console.warn(message));

	return {
		async delete_project(params: DeleteProjectParams): Promise<DeleteProjectResult> {
			if (holdsALiveLease(options.liveLeases(), params.project)) {
				// Nothing is touched, and no audit line claims otherwise — the record says
				// explicitly that this delete did not happen.
				audit(refusalLine(params));
				return { outcome: 'refused' as const, reason: 'lease-live' as const };
			}

			const registration = await removeRegistration(options.projectsRoot, params.project, warn);
			const archive = await options.sweeper.removeProject(params.project);
			const keptTests = await pruneKeptTests(options.keptTestsPath, params.project, warn);

			const report = {
				registration,
				archive: archive.outcome === 'removed' ? ('removed' as const) : archive.outcome,
				keptTests: keptTests.part,
				freedBytes: archive.outcome === 'removed' ? archive.bytes : 0,
				keptTestsRemoved: keptTests.removed,
			};

			// `not-registered` before `partial`, because all three `absent` cannot be a failure:
			// nothing was reached, so nothing could have refused to go.
			if (
				report.registration === 'absent' &&
				report.archive === 'absent' &&
				report.keptTests === 'absent'
			) {
				audit(nothingReachedLine(params));
				return { outcome: 'not-registered' as const };
			}
			const outcome =
				report.registration === 'failed' ||
				report.archive === 'failed' ||
				report.keptTests === 'failed'
					? ('partial' as const)
					: ('deleted' as const);
			audit(auditLine(params, outcome, report));
			return { outcome, ...report };
		},
	};
}

/**
 * Whether any live lease names this project, **under either spelling** — see the module header.
 *
 * `pathSegment` is applied to the *lease's* string rather than to the caller's, because that is
 * the direction the archive filed it in: the rewrite is not reversible, so the only question that
 * can be asked is whether a live lease's project lands in the subtree being deleted.
 */
function holdsALiveLease(leases: readonly Lease[], project: string): boolean {
	return leases.some(
		(lease) => lease.project === project || pathSegment(lease.project) === project,
	);
}

/**
 * Unlink the hook file, or say why it did not go.
 *
 * A string that is not an identifier names no hook file at all (`projectHooksPath` answers `null`,
 * which is D22's reading and the traversal guard), so it is `absent` rather than a refusal: the
 * archive subtree and the kept entries may still be there under a name a lease invented.
 */
async function removeRegistration(
	root: string,
	project: string,
	warn: (message: string) => void,
): Promise<DeletedPart> {
	const path = projectHooksPath(root, project);
	if (path === null) {
		return 'absent';
	}
	try {
		await unlink(path);
		return 'removed';
	} catch (error) {
		if (codeOf(error) === 'ENOENT') {
			return 'absent';
		}
		warn(unremovedRegistrationWarning(path, error));
		return 'failed';
	}
}

/**
 * Take every entry naming this project out of the store, inside the lock `set_kept_tests` writes
 * under.
 *
 * **A store that will not read is `failed` and is never overwritten**, which is `set_kept_tests`'
 * own promise for its own reason: resetting the file would delete every exemption on the host to
 * make one call succeed. A store with no entry for this project is `absent` and is not rewritten
 * either — there is nothing to write, and rewriting it would touch a document this delete has no
 * business in.
 */
async function pruneKeptTests(
	path: string,
	project: string,
	warn: (message: string) => void,
): Promise<{ readonly part: DeletedPart; readonly removed: number }> {
	return withKeptTestsLock(path, async () => {
		let held: KeptTest[];
		try {
			held = await readKeptTests(path);
		} catch (error) {
			warn(unremovedKeptTestsWarning(path, error));
			return { part: 'failed' as const, removed: 0 };
		}

		const next = withoutProject(held, project);
		if (next.removed === 0) {
			return { part: 'absent' as const, removed: 0 };
		}
		try {
			await writeKeptTests(path, next.tests);
		} catch (error) {
			warn(unremovedKeptTestsWarning(path, error));
			return { part: 'failed' as const, removed: 0 };
		}
		return { part: 'removed' as const, removed: next.removed };
	});
}

/** What one half's fate reads as in a sentence a person is meant to act on. */
function phrase(part: DeletedPart, noun: string): string {
	if (part === 'removed') {
		return `${noun} removed`;
	}
	return part === 'absent' ? `no ${noun}` : `${noun} NOT removed`;
}

/**
 * The kept-tests half, as a fate **and** a count.
 *
 * The count alone would hide this half's one failure: a store the host could not read is left
 * untouched and removes nothing, which reads identically in a count to a project that had no kept
 * tests at all — and the record has to distinguish them, since one of the two needs an operator.
 */
function keptTestsPhrase(part: DeletedPart, removed: number): string {
	if (part === 'removed') {
		return `${removed} kept ${removed === 1 ? 'test' : 'tests'} removed`;
	}
	return part === 'absent' ? 'no kept tests' : 'kept tests NOT removed';
}

/**
 * The record D28 requires: what went, what it came to, who asked, and when.
 *
 * A `partial` says in as many words that some of it is still there, because that is the one answer
 * whose next move is *look at this host's log* rather than *done*.
 */
function auditLine(
	params: DeleteProjectParams,
	outcome: 'deleted' | 'partial',
	report: {
		readonly registration: DeletedPart;
		readonly archive: DeletedPart;
		readonly keptTests: DeletedPart;
		readonly freedBytes: number;
		readonly keptTestsRemoved: number;
	},
): string {
	const halves = [
		phrase(report.registration, 'registration'),
		`${phrase(report.archive, 'archive')} (${report.freedBytes} bytes)`,
		keptTestsPhrase(report.keptTests, report.keptTestsRemoved),
	].join(', ');
	const headline =
		outcome === 'deleted'
			? `Deleted project ${JSON.stringify(params.project)}`
			: `Partly deleted project ${JSON.stringify(params.project)}`;
	const tail =
		outcome === 'partial'
			? ` Some of it is still on this host — the warning above names what and why.`
			: '';
	return (
		`${headline} — ${halves} — asked for by ${JSON.stringify(params.actor)} at ` +
		`${new Date().toISOString()}.${tail}`
	);
}

/** The record for a delete that reached nothing: no file, no subtree, no entries. */
function nothingReachedLine(params: DeleteProjectParams): string {
	return (
		`Nothing was deleted for project ${JSON.stringify(params.project)} — it has no hook file, ` +
		`nothing filed in the artifact archive and no kept tests on this host — asked for by ` +
		`${JSON.stringify(params.actor)} at ${new Date().toISOString()}.`
	);
}

/** The record for the one branch that touches nothing on purpose. */
function refusalLine(params: DeleteProjectParams): string {
	return (
		`Refused to delete project ${JSON.stringify(params.project)}: a lease on it is live, so ` +
		`nothing was touched — not the hook file, which carries the teardown that lease is still ` +
		`owed, and not what it is filing into right now. Asked for by ` +
		`${JSON.stringify(params.actor)} at ${new Date().toISOString()}.`
	);
}

/**
 * What the operator is told, on the host, about a hook file this delete could not remove.
 *
 * Names the path and the errno, which is exactly what the answer may not carry: the wire says only
 * which half did not go, and this is where the diagnosis lives instead (D19). The path goes
 * through `JSON.stringify` for `./list-archive.ts`'s reason.
 */
function unremovedRegistrationWarning(path: string, error: unknown): string {
	return (
		`The project hook file at ${JSON.stringify(path)} was not deleted: ` +
		`${codeOf(error) ?? 'unknown error'}. The project is still registered on this host, and ` +
		`the answer said only that this half did not go — no path and no reason leaves it.`
	);
}

/** The same, for the store the exemptions live in. A store that will not read is never reset. */
function unremovedKeptTestsWarning(path: string, error: unknown): string {
	return (
		`The kept-tests store at ${JSON.stringify(path)} was not pruned: ${messageOf(error)} ` +
		`It was left exactly as it is — a store this host cannot read is never overwritten to ` +
		`make one call succeed — and no path and no reason leaves this host.`
	);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The errno of a filesystem failure, or `null` for anything that is not one. */
function codeOf(error: unknown): string | null {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return typeof code === 'string' ? code : null;
}
