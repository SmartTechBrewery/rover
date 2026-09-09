/**
 * The `delete_archived_test` handler — one operator action taking the archived test an address
 * names, everything filed under it, and its entry in the kept-tests store (D43, #272).
 *
 * **The same action as `./delete-project.ts`, at a finer address.** An operator who knows one test
 * is finished can say so without taking the project it lives in, and nothing else about the
 * deletion is new: the serialised deletion path, `sizeOfTree`, the kept-tests lock, the `actor`
 * attribution, the four-arm answer vocabulary and the no-path-on-the-wire rule are all #271's and
 * are **reused rather than rebuilt**. What that costs is two extractions — `ArchiveSweeper.remove`
 * takes an archive address, and `pruneKeptTests` takes a predicate — and what it buys is that a
 * project and a test cannot come to answer differently about the same two stores.
 *
 * **Two halves, and the order is load-bearing.** The directory goes first, so a `partial` where
 * the subtree went is the direction that leaves the host holding *less*: no tick can outlive the
 * directory it names, while a directory that went with its tick still in the store is recovered by
 * asking again. Both run inside machinery that already exists — the sweeper's per-root critical
 * section and its `settle()` (which keeps a `process.exit` out of the middle of an `rm`), and the
 * lock `set_kept_tests` writes under.
 *
 * **There is no third half, because there is no registration at this address.** A hook file is a
 * project's, and a test is not a project — which is exactly why a request that reached nothing
 * answers `not-found` rather than `not-registered`. It is a *different arm* rather than a delete
 * of zero bytes, which is D42's rule held one level down: never a success that removed nothing.
 *
 * **An explicit delete overrides `Keep`.** D35 makes a kept test exempt from the two retention
 * *bounds*, absolutely; an operator naming one test is not one of those bounds, exactly as an
 * operator naming one project is not (D42). So the test goes with its entry, the answer says **how
 * many** entries went so a client can report it rather than surprise somebody with it, and a test
 * that is *not* what was named keeps its exemption untouched — including the same test name under
 * a different project, the `<project>/<test_name>` pair being the identity (D22, D33).
 *
 * **A live lease filing into this test is refused, as data, and nothing at all is touched.** The
 * directory is what that lease is writing into right now, which D35 exempts absolutely. There is
 * no teardown reason here — a test has no hook file — so this arm is the archive half of
 * `./delete-project.ts`'s refusal and nothing else, in `AcquireDeviceResultSchema`'s idiom, with
 * an obvious next move: wait, or force-release first.
 *
 * **The refusal asks both spellings of the lease's strings**, {@link holdsALiveLease} and
 * `./delete-project.ts`'s reason: the address is the archive's own spelling, a lease carries the
 * caller's, and `pathSegment` is what the writer put between them. The rewrite is not reversible,
 * so it is applied to the *lease's* strings and never to the caller's — the only question that can
 * be asked of it is whether a live lease files into the directory being deleted.
 *
 * **The residual window is the one the sweep already lives with**: a lease granted between the
 * check and the removal. `liveLeases` is a callback resolved at the moment of the call, exactly as
 * `ArchiveSweeperOptions.liveLeases` is and for its reason.
 *
 * **No host path, no `errno` and no `message` is on any answer, structurally** (D19).
 * `DeleteArchivedTestResultSchema` has no field one would fit in, and `src/ipc/server.ts` parses
 * every handler's return value against that `.strict()` schema, so a path smuggled onto a result
 * is `invalid_result` on the host rather than a disclosure. The diagnosis goes where the path
 * already belongs: a warning here, on the host.
 *
 * **One audit line, in `force_release_device`'s key** (D28), naming the actor, the two components
 * and the counts — and saying plainly what did *not* go on the answers where something did not.
 * Every caller value through `JSON.stringify`, `./kept-tests-handlers.ts`'s reason: a newline would
 * otherwise end the line and start a fabricated one in the daemon's own record. No token is in
 * scope on this path at all (D20).
 */

import type {
	DeleteArchivedTestParams,
	DeleteArchivedTestResult,
	DeletedPart,
	IpcHandlers,
} from '../ipc/methods.js';
import { pathSegment } from './archive-path.js';
import type { ArchiveSweeper } from './archive-sweep.js';
import { pruneKeptTests, withoutTest } from './kept-tests.js';
import type { Lease } from './leases.js';

export interface DeleteArchivedTestOptions {
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

export type DeleteArchivedTestHandler = Pick<IpcHandlers, 'delete_archived_test'>;

export function createDeleteArchivedTestHandler(
	options: DeleteArchivedTestOptions,
): DeleteArchivedTestHandler {
	const audit = options.audit ?? ((message: string) => console.warn(message));
	const warn = options.warn ?? ((message: string) => console.warn(message));

	return {
		async delete_archived_test(
			params: DeleteArchivedTestParams,
		): Promise<DeleteArchivedTestResult> {
			if (holdsALiveLease(options.liveLeases(), params.project, params.testName)) {
				// Nothing is touched, and no audit line claims otherwise — the record says
				// explicitly that this delete did not happen.
				audit(refusalLine(params));
				return { outcome: 'refused' as const, reason: 'lease-live' as const };
			}

			const archive = await options.sweeper.remove([params.project, params.testName]);
			const keptTests = await pruneKeptTests(
				options.keptTestsPath,
				(tests) => withoutTest(tests, params.project, params.testName),
				warn,
			);

			const report = {
				archive: archive.outcome === 'removed' ? ('removed' as const) : archive.outcome,
				keptTests: keptTests.part,
				freedBytes: archive.outcome === 'removed' ? archive.bytes : 0,
				keptTestsRemoved: keptTests.removed,
			};

			// `not-found` before `partial`, because both `absent` cannot be a failure: nothing was
			// reached, so nothing could have refused to go.
			if (report.archive === 'absent' && report.keptTests === 'absent') {
				audit(nothingReachedLine(params));
				return { outcome: 'not-found' as const };
			}
			const outcome =
				report.archive === 'failed' || report.keptTests === 'failed'
					? ('partial' as const)
					: ('deleted' as const);
			audit(auditLine(params, outcome, report));
			return { outcome, ...report };
		},
	};
}

/**
 * Whether any live lease is filing into this test, **under either spelling** — see the module
 * header.
 *
 * Both components have to match, and on the same lease: a lease on another test of this project
 * is not writing into this directory, and neither is a lease on this test name under another
 * project. `pathSegment` is applied to the *lease's* strings and never to the caller's, which is
 * the direction the archive filed them in and the direction the archive half now reads them.
 */
function holdsALiveLease(leases: readonly Lease[], project: string, testName: string): boolean {
	return leases.some(
		(lease) =>
			(lease.project === project && lease.testName === testName) ||
			(pathSegment(lease.project) === project && pathSegment(lease.testName) === testName),
	);
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
 * untouched and removes nothing, which reads identically in a count to a test that was never kept
 * — and the record has to distinguish them, since one of the two needs an operator.
 */
function keptTestsPhrase(part: DeletedPart, removed: number): string {
	if (part === 'removed') {
		return `${removed} kept ${removed === 1 ? 'test' : 'tests'} removed`;
	}
	return part === 'absent' ? 'no kept tests' : 'kept tests NOT removed';
}

/** The two components as the record names them, each through `JSON.stringify` (D19, D28). */
function named(params: DeleteArchivedTestParams): string {
	return `${JSON.stringify(params.project)}/${JSON.stringify(params.testName)}`;
}

/**
 * The record D28 requires: what went, what it came to, who asked, and when.
 *
 * A `partial` says in as many words that some of it is still there, because that is the one answer
 * whose next move is *look at this host's log* rather than *done*.
 */
function auditLine(
	params: DeleteArchivedTestParams,
	outcome: 'deleted' | 'partial',
	report: {
		readonly archive: DeletedPart;
		readonly keptTests: DeletedPart;
		readonly freedBytes: number;
		readonly keptTestsRemoved: number;
	},
): string {
	const halves = [
		`${phrase(report.archive, 'archive')} (${report.freedBytes} bytes)`,
		keptTestsPhrase(report.keptTests, report.keptTestsRemoved),
	].join(', ');
	// `Deleted test`, not `Deleted archived test`: the sweeper's own line for the same subtree
	// opens with the latter, and one prefix meaning two different records is what
	// `tests/helpers/daemon-socket.ts`'s sweep filter would then swallow. It is exactly the
	// distinction `./delete-project.ts` already keeps — `Deleted project` beside the sweeper's
	// `Deleted archived project`.
	const headline =
		outcome === 'deleted'
			? `Deleted test ${named(params)}`
			: `Partly deleted test ${named(params)}`;
	const tail =
		outcome === 'partial'
			? ` Some of it is still on this host — the warning above names what and why.`
			: '';
	return (
		`${headline} — ${halves} — asked for by ${JSON.stringify(params.actor)} at ` +
		`${new Date().toISOString()}.${tail}`
	);
}

/** The record for a delete that reached nothing: no directory and no kept entry. */
function nothingReachedLine(params: DeleteArchivedTestParams): string {
	return (
		`Nothing was deleted for test ${named(params)} — this host has nothing filed ` +
		`under it and no kept entry for it — asked for by ${JSON.stringify(params.actor)} at ` +
		`${new Date().toISOString()}.`
	);
}

/** The record for the one branch that touches nothing on purpose. */
function refusalLine(params: DeleteArchivedTestParams): string {
	return (
		`Refused to delete test ${named(params)}: a lease filing into it is live, so ` +
		`nothing was touched — that directory is what the lease is writing into right now. ` +
		`Asked for by ${JSON.stringify(params.actor)} at ${new Date().toISOString()}.`
	);
}
