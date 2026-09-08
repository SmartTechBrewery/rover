/**
 * The `list_kept_tests` and `set_kept_tests` handlers — the two directions the `Keep` flag
 * travels on the surface (D33, #234).
 *
 * **The store is the truth and nothing here holds any of it.** Both handlers read
 * `./kept-tests.ts` on every call and cache nothing, exactly as the network gate re-reads the
 * user store on every connection (D6, D25). So a daemon restart changes nothing about what is
 * kept, an operator who edits the file by hand is obeyed on the next call, and there is no
 * second copy of this state to go stale.
 *
 * **No host path is on any answer, structurally rather than by habit.** Neither result schema
 * has a field a path would fit in — not even a `message` — and the store's own errors name its
 * path by design, so every read and every write here is inside a `try` that answers an outcome.
 * `src/ipc/server.ts` turns an escaped throw into `internal_error` carrying `messageOf(error)`,
 * which is exactly how a path would otherwise reach a client (D19). The diagnosis goes where the
 * path already belongs: a warning on the host, as `./list-archive.ts` warns.
 *
 * **A malformed store is never overwritten.** `set_kept_tests` reads before it writes, and a read
 * that throws answers `unwritable` **without writing** — the same promise `readUsers` makes, for
 * the same reason: resetting the file would delete every exemption on the host to make one call
 * succeed.
 *
 * **One write at a time per store, and that is not a cache.** `src/ipc/server.ts` dispatches
 * frames without awaiting them, and every connection is independent besides, so two presses — a
 * panel tick and a `rover keep add`, or two operators — really do arrive at once. Each is a
 * read-modify-write of the whole document, so left to interleave the later read would not see the
 * earlier press and the earlier press would be silently dropped, both callers having been
 * answered `set`. {@link keptWrites} therefore chains every `set_kept_tests` for one path behind
 * the last, so the read a write depends on is inside the same critical section. **Neither the
 * chain nor anything else holds the state** — it holds a promise, not a document, and every call
 * still reads the file (D6). Nothing serialises `list_kept_tests`: `writeKeptTests` renames a
 * complete file into place, so a read already sees the whole of one version or the whole of the
 * other, and putting reads in the queue would only make them wait behind a write.
 *
 * **Two presses that overlap both land, and both are answered `set`** with a set that includes
 * both. Not one refused as a loser: the group tick's whole contract is that a client renders the
 * set it was handed (`ListKeptTestsResultSchema`), and *your tick landed, and so did the one that
 * arrived with it* is the truth about a store where the last write holds the union.
 *
 * **One audit line per write, and it is `force_release_device`'s line in this key** (D28). Every
 * caller-supplied value goes through `JSON.stringify` — `actor` and both components of every test
 * — because a newline in one of them would otherwise end the line and start a fabricated one in
 * the daemon's own record. No token is in scope on this path at all (D20).
 *
 * **Nothing here sweeps, prunes or expires anything.** Setting the flag is the whole of what this
 * module does — what a set flag *means* is `./archive-sweep.ts`'s, where a kept test is exempt from
 * both retention bounds absolutely (D35, D36, #238). Who runs the prune unattended is still
 * undecided (`PROJECT.md` §9.4), and {@link MAX_KEPT_TESTS} bounds the document rather than the
 * archive.
 */

import type {
	IpcHandlers,
	KeptTestRef,
	ListKeptTestsResult,
	SetKeptTestsParams,
	SetKeptTestsResult,
} from '../ipc/methods.js';
import { MAX_KEPT_TESTS } from '../ipc/methods.js';
import { applyKeep, type KeptTest, readKeptTests, writeKeptTests } from './kept-tests.js';

/**
 * The in-flight write chain per store path, so a `set_kept_tests` never interleaves with another
 * one on the same file. See the module header for why the read has to be inside it.
 *
 * Keyed by path rather than held on the handler instance because the *file* is what is being
 * serialised: two `createKeptTestsHandlers` on one path — a test starting a second daemon on the
 * same store — must share the queue, and two on different paths must not wait on each other. The
 * entry is dropped once it is the settled tail, so this map does not grow with the calls a
 * long-lived daemon serves.
 */
const keptWrites = new Map<string, Promise<unknown>>();

function serialised<T>(path: string, work: () => Promise<T>): Promise<T> {
	const previous = keptWrites.get(path) ?? Promise.resolve();
	// `then(work, work)` because a rejected predecessor must not cancel the queue — nothing here
	// rejects today (both failures are answered as outcomes), and a future one that did would
	// otherwise leave the flag unwritable until a restart.
	const run = previous.then(work, work);
	const tail = run.then(
		() => undefined,
		() => undefined,
	);
	keptWrites.set(path, tail);
	void tail.then(() => {
		if (keptWrites.get(path) === tail) {
			keptWrites.delete(path);
		}
	});
	return run;
}

export interface KeptTestsHandlerOptions {
	/**
	 * The store — `./kept-tests.ts`'s `resolveKeptTestsPath`, resolved in `./main.ts`. A required
	 * option for `StartDaemonOptions.artifactsRoot`'s reason: a `startDaemon()` in a unit test
	 * must not write into the developer's own `~/.rover`.
	 */
	readonly path: string;
	/**
	 * Where the record of a write is written. Defaults to `console.warn`, which is the daemon's
	 * own stderr — `./lease-handlers.ts`'s `audit`, for its reasons: it is the record D28 requires
	 * and deliberately not a durable audit store.
	 */
	readonly audit?: (message: string) => void;
	/**
	 * Where a store the host cannot read or write is reported. Defaults to `console.warn`;
	 * injected by tests. This is the **only** place the reason and the path are said, for the
	 * reason the module header gives.
	 */
	readonly warn?: (message: string) => void;
}

export type KeptTestsHandlers = Pick<IpcHandlers, 'list_kept_tests' | 'set_kept_tests'>;

export function createKeptTestsHandlers(options: KeptTestsHandlerOptions): KeptTestsHandlers {
	const audit = options.audit ?? ((message: string) => console.warn(message));
	const warn = options.warn ?? ((message: string) => console.warn(message));

	return {
		async list_kept_tests(): Promise<ListKeptTestsResult> {
			let tests: KeptTest[];
			try {
				tests = await readKeptTests(options.path);
			} catch (error) {
				warn(unreadableWarning(options.path, error));
				return { outcome: 'unreadable' as const };
			}
			// A store that does not exist reads as `[]`, which is honestly `listed`: *this host
			// keeps nothing* is the ordinary starting state and there is no `missing` arm to
			// distinguish it into (`ListKeptTestsResultSchema`).
			return { outcome: 'listed' as const, tests: tests.map(refOf) };
		},

		set_kept_tests(params: SetKeptTestsParams): Promise<SetKeptTestsResult> {
			// The read, the cap check and the write are one critical section per store path: see
			// the module header for what interleaving them costs.
			return serialised(options.path, async () => {
				let held: KeptTest[];
				try {
					held = await readKeptTests(options.path);
				} catch (error) {
					// Read first, and refuse rather than reset: see the module header.
					warn(unwritableWarning(options.path, error));
					return { outcome: 'unwritable' as const };
				}

				const at = new Date().toISOString();
				const next = applyKeep(held, params.tests, params.kept, { actor: params.actor, at });
				if (next.length > MAX_KEPT_TESTS) {
					// Nothing is written and nothing is dropped to make room — the store is exactly
					// as it was, which is what makes this a refusal an operator acts on rather than
					// a silent eviction of somebody else's exemption.
					warn(tooManyWarning(options.path, next.length));
					return { outcome: 'refused' as const, reason: 'too-many' as const };
				}

				try {
					await writeKeptTests(options.path, next);
				} catch (error) {
					warn(unwritableWarning(options.path, error));
					return { outcome: 'unwritable' as const };
				}

				audit(auditLine(params, at));
				return { outcome: 'set' as const, tests: next.map(refOf) };
			});
		},
	};
}

/**
 * What a kept test looks like on the wire: the pair that names it, and nothing else.
 *
 * `keptBy` and `keptAt` stay in the file and in the audit line — nothing needs either to draw a
 * tick, and widening the answer later is additive (`ListKeptTestsResultSchema`).
 */
function refOf(test: KeptTest): KeptTestRef {
	return { project: test.project, testName: test.testName };
}

/**
 * The record D28 requires, in `force_release_device`'s own shape: what was decided, about which
 * tests, by whom, when.
 *
 * Every caller-supplied value is stringified for the reason the module header gives. The tests
 * are named as one array in one line, because one press is one decision however many tests it
 * stood for.
 */
function auditLine(params: SetKeptTestsParams, at: string): string {
	const named = params.tests
		.map((test) => `${JSON.stringify(test.project)}/${JSON.stringify(test.testName)}`)
		.join(', ');
	return (
		`${params.kept ? 'Kept' : 'Stopped keeping'} ${params.tests.length} archived ` +
		`${params.tests.length === 1 ? 'test' : 'tests'} — ${named} — asked for by ` +
		`${JSON.stringify(params.actor)} at ${at}.`
	);
}

/**
 * What the operator is told, on the host, about a store this read could not use.
 *
 * Names the path and the reason, which is exactly what the answer may not carry: the wire says
 * only *unreadable*, and this is where the diagnosis lives instead (D19). The path goes through
 * `JSON.stringify` for `./list-archive.ts`'s reason — it is the daemon's convention for any value
 * in a log line that a newline could forge a second line out of.
 */
function unreadableWarning(path: string, error: unknown): string {
	return (
		`The kept-tests store at ${JSON.stringify(path)} could not be read: ${messageOf(error)} ` +
		`The answer said only that it is unreadable — no path and no reason leaves this host — ` +
		`and the file was left exactly as it is.`
	);
}

/** The write's half of {@link unreadableWarning}, saying plainly that nothing was written. */
function unwritableWarning(path: string, error: unknown): string {
	return (
		`The kept-tests store at ${JSON.stringify(path)} was not written: ${messageOf(error)} ` +
		`Nothing on this host changed, and no path and no reason leaves it.`
	);
}

/** The cap, on the host, where the count may be said — the answer carries only the reason. */
function tooManyWarning(path: string, would: number): string {
	return (
		`The kept-tests store at ${JSON.stringify(path)} would hold ${would} tests, over the ` +
		`${MAX_KEPT_TESTS} one host keeps. Nothing was written and nothing was dropped.`
	);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
