/**
 * `~/.rover/kept-tests.json` — which tests the operator has said to keep (D33).
 *
 * One record per kept test: the `<project>/<test_name>` pair as the archive filed it, who said
 * to keep it, and when. Nothing else, and nothing derived: this file is the whole truth about
 * the flag on this host.
 *
 * **It lives beside `users.json` and deliberately outside the artifact tree** (D33,
 * `PROJECT.md` §10). Every sidecar the archive writes goes out with `flag: 'wx'` and is never
 * rewritten, because each records what was true when a run happened; a `Keep` flag is the
 * opposite — it toggles, and it is about the *test* rather than about a run. Nothing has ever
 * been written above the run level either, and the archive's whole claim is that it is what
 * past leases wrote (D24). So the flag is the host's own document, not a file in the tree.
 *
 * **The file is the truth and nothing caches it.** Every function takes the resolved path and
 * reads the filesystem, exactly as `./user-store.ts`'s {@link findUserByToken} re-reads the
 * user store on every connection. That is how D6 is honoured rather than dodged: this state
 * cannot be re-derived from the platform, or from anything else, which is precisely why the
 * daemon holds none of it in memory. A daemon restart therefore changes nothing, and that is
 * the durability claim the flag rests on.
 *
 * **A malformed store is never silently reset**, `./user-store.ts`'s promise for the same
 * reason one level over: a read that cannot be parsed throws, naming the path, because
 * rewriting it as empty would delete every exemption on the host to make one call succeed.
 *
 * **Nothing here prunes, sweeps or expires anything — and this store is what the sweep that
 * does honours.** `./archive-sweep.ts` re-reads this file on every sweep, cached nowhere (above),
 * and a test named in it is exempt from both retention bounds absolutely, not even taken to bring
 * the archive under its budget (D35, D36). A store that will not parse therefore **abandons that
 * sweep and deletes nothing at all**, which is what the throw above buys — and that now holds for
 * a sweep **nobody asked for**, since the disk budget is enforced after every lease ends (D37):
 * this file is read on a path no operator is watching, so its refusal has to be as absolute there
 * — and more so since the *whole* policy runs on a clock, at local midnight and at daemon start
 * (D38): a store that will not parse now stops a pass nobody would otherwise notice was due.
 * {@link MAX_KEPT_TESTS} bounds the *document*, not the archive.
 *
 * **There are three writers of this document now, and the lock they share lives here** (D42, D43,
 * #271, #272). `set_kept_tests` toggles the flag; `delete_project` takes every entry naming one
 * project and `delete_archived_test` takes the one entry naming one test, because an operator
 * deleting either is not one of the two retention bounds D35 exempts a kept test from, and a tick
 * that outlived the directory it names would leave the store pointing at nothing. All three are
 * read-modify-write of the whole file, so {@link withKeptTestsLock} is declared in this module
 * rather than privately in any handler: two chains keyed on one path would serialise each writer
 * against itself and neither against the other, which silently drops one of two overlapping writes
 * with both callers answered success.
 *
 * **The two deletes' pruning is one routine here too** ({@link pruneKeptTests}), and for the same
 * reason: what varies between them is *which* entries go, which is a predicate, while what a store
 * that will not read means and when the file is left untouched are promises both have to keep
 * identically.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
	ArchivePathSegmentSchema,
	AttributionStringSchema,
	type DeletedPart,
	type KeptTestRef,
	MAX_KEPT_TESTS,
} from '../ipc/methods.js';
import { describeIssues } from '../ipc/protocol.js';

/** Environment variable naming the store, for tests and for a non-default install. */
export const KEPT_TESTS_PATH_ENV_VAR = 'ROVER_KEPT_TESTS_PATH';

/**
 * The cap this store is held to, re-exported from `../ipc/methods.js` where it lives beside the
 * wire bound it also is — and carried by {@link KeptTestsFileSchema} below, which is what lets
 * `list_kept_tests`' array bound be a promise rather than a hope.
 */
export { MAX_KEPT_TESTS };

export const KeptTestSchema = z
	.object({
		project: ArchivePathSegmentSchema,
		testName: ArchivePathSegmentSchema,
		/**
		 * Who said to keep it. **Attribution only** (D20, D28) — the caller supplied it and it is
		 * never derived from whoever authenticated, exactly as `force_release_device`'s `actor` is
		 * not. It authorizes nothing and it is not a credential.
		 */
		keptBy: AttributionStringSchema,
		keptAt: z.string().datetime(),
	})
	.strict();
export type KeptTest = z.infer<typeof KeptTestSchema>;

/**
 * A top-level object rather than a bare array, `./user-store.ts`'s reason: it is what leaves
 * room for a `version` key later without a migration. Adding one before anything needs it
 * would be speculative.
 *
 * **The array carries {@link MAX_KEPT_TESTS} here, at the store**, and not only in the handler
 * that refuses a write over it. `list_kept_tests`' result schema is bounded too, so a store
 * hand-edited past the cap has to fail *somewhere*: bounded here it is a {@link readKeptTests}
 * throw naming the path, which both handlers already turn into `unreadable`/`unwritable` with the
 * diagnosis on the host's own log — inside the outcome vocabulary the two rows have. Left
 * unbounded here it would instead be `invalid_result` on every read, which names no path and
 * which no client can act on.
 */
export const KeptTestsFileSchema = z
	.object({ tests: z.array(KeptTestSchema).max(MAX_KEPT_TESTS) })
	.strict();

/** `~/.rover/kept-tests.json` — the zero-config path, beside the socket and the user store. */
export function defaultKeptTestsPath(): string {
	return join(homedir(), '.rover', 'kept-tests.json');
}

/** Resolve the store's path. An empty value counts as unset, as it does for the socket. */
export function resolveKeptTestsPath(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env[KEPT_TESTS_PATH_ENV_VAR];
	return configured === undefined || configured === '' ? defaultKeptTestsPath() : configured;
}

/**
 * The in-flight write chain per store path, so no two read-modify-writes of one store interleave.
 *
 * Keyed by path rather than held on a handler instance because the **file** is what is being
 * serialised: two handler factories on one path — a test starting a second daemon on the same
 * store — must share the queue, and two on different paths must not wait on each other. The entry
 * is dropped once it is the settled tail, so this map does not grow with the calls a long-lived
 * daemon serves.
 */
const keptWrites = new Map<string, Promise<unknown>>();

/**
 * Run `work` with no other write of this store in flight, and hand back what it answered.
 *
 * **The read has to be inside it.** `src/ipc/server.ts` dispatches frames without awaiting them
 * and every connection is independent besides, so two writes — a panel tick and a
 * `rover keep add`, or a `set_kept_tests` and a `delete_project` — really do arrive at once. Each
 * is a read-modify-write of the whole document, so left to interleave the later read would not see
 * the earlier write and the earlier write would be silently dropped, both callers having been
 * answered success.
 *
 * **This holds a promise, not a document.** Nothing is cached between calls and every call still
 * reads the file, so D6 is untouched — it is a lock on a file rather than state in the daemon.
 * Nothing serialises the *reads*: {@link writeKeptTests} renames a complete file into place, so a
 * read already sees the whole of one version or the whole of the other, and putting reads in the
 * queue would only make them wait behind a write.
 */
export function withKeptTestsLock<T>(path: string, work: () => Promise<T>): Promise<T> {
	const previous = keptWrites.get(path) ?? Promise.resolve();
	// `then(work, work)` because a rejected predecessor must not cancel the queue — nothing here
	// rejects today (every failure is answered as an outcome), and a future one that did would
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

/**
 * The key one kept test is held under, for identity and for dedupe.
 *
 * Joined on NUL, which is one of the characters `ArchivePathSegmentSchema` refuses, so no two
 * different tests can collide on one key — the argument `panel/src/archive/archive-path.ts`
 * records for its own `keyOf`. A `/` join would let `a/b` + `c` and `a` + `b/c` share a key if
 * the schema ever loosened.
 */
export function keptTestKey(test: { project: string; testName: string }): string {
	return `${test.project}\u0000${test.testName}`;
}

/**
 * Every test this host keeps, or `[]` when the store does not exist yet — a host that has kept
 * nothing is the ordinary starting state, not a failure. Every other read failure throws.
 *
 * **One record per test, whatever the file holds.** {@link applyKeep}'s `Map` means nothing this
 * module writes can hold a pair twice, but the header's own promise is that an operator editing
 * the file by hand is obeyed — so a hand-added duplicate is collapsed on the way in rather than
 * answered twice on the wire and then silently collapsed by the next write.
 */
export async function readKeptTests(path: string): Promise<KeptTest[]> {
	let raw: string;
	try {
		raw = await readFile(path, 'utf8');
	} catch (error) {
		if (isNotFound(error)) {
			return [];
		}
		throw new Error(`Could not read the kept-tests store at ${path}: ${describeError(error)}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`The kept-tests store at ${path} is not valid JSON: ${describeError(error)}. It has ` +
				`been left untouched — fix or move it rather than letting a call overwrite it.`,
		);
	}

	const result = KeptTestsFileSchema.safeParse(parsed);
	if (!result.success) {
		throw new Error(
			`The kept-tests store at ${path} is not a valid store: ${describeIssues(result.error)}. ` +
				`It has been left untouched — fix or move it rather than letting a call overwrite it.`,
		);
	}
	return deduped(sortedForStorage(result.data.tests));
}

/**
 * Write the whole store, atomically.
 *
 * Write-then-`rename` because a process killed mid-write would otherwise truncate the record of
 * every exemption on the host; `rename` within one directory is atomic, so a reader sees the old
 * file or the new one and never half of either. That is also why the whole document is written
 * rather than one file per kept test: the panel draws a screen of ticks from one answer, so one
 * read answering the whole set is what keeps *one poll, one answer* (D6, R29).
 *
 * **Every write gets its own temporary name**, and that part is not cosmetic: this store is
 * written by a wire call (D33), so two `set_kept_tests` presses really can be in here at once,
 * and two writers sharing one `${path}.tmp` both truncate it and write from offset 0 — then both
 * rename the interleaved bytes over the store, leaving a document that will not parse for anyone.
 * A per-write name makes the pair of writes a race one of them wins whole, which is the only race
 * `rename` can make safe. It is also why `./kept-tests-handlers.ts` serialises the
 * read-modify-write above this: atomic writes alone would still let the later read win with a set
 * that never saw the earlier press.
 *
 * A temporary left by a failed write is removed rather than left beside the store, since a unique
 * name is never reused and so would otherwise accumulate.
 *
 * **No `mode: 0o600`, deliberately.** `./user-store.ts` writes its store that way because it is
 * what stands between a stranger with a shell account and every credential on the host. This
 * file holds no credential — a project name, a test name and an attribution string — and copying
 * the mode across would imply it holds one.
 */
export async function writeKeptTests(path: string, tests: readonly KeptTest[]): Promise<void> {
	const ordered = sortedForStorage(tests);
	await mkdir(dirname(path), { recursive: true });
	const temporary = temporaryKeptTestsPath(path);
	try {
		await writeFile(temporary, `${JSON.stringify({ tests: ordered }, null, 2)}\n`, 'utf8');
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}

/**
 * The name one write's temporary takes: the store's own, plus this process and a fresh UUID.
 *
 * Exported so the property that matters can be asserted directly — **two calls never agree**, and
 * both sit in the store's own directory, which is what keeps the `rename` above atomic. A shared
 * name is the bug this replaces and it cannot be caught after the fact, since a temporary that was
 * renamed away leaves nothing behind to look at.
 */
export function temporaryKeptTestsPath(path: string): string {
	return `${path}.${process.pid}.${randomUUID()}.tmp`;
}

/**
 * One fixed order, unconditionally — determinism, not a sort option, and applied on both the
 * read and the write so a rewrite cannot reorder the file.
 *
 * Code-unit comparison rather than `localeCompare`, which is `./list-archive.ts`'s reason: a
 * locale-dependent fold would make one host order its answer differently from another.
 */
function sortedForStorage(tests: readonly KeptTest[]): KeptTest[] {
	return [...tests].sort(
		(left, right) => compare(left.project, right.project) || compare(left.testName, right.testName),
	);
}

/**
 * One record per {@link keptTestKey}, the first in the given order winning.
 *
 * The order is {@link sortedForStorage}'s and `Array.prototype.sort` is stable, so *first* means
 * the earlier of the two in the file — deterministic, and the same choice on every host.
 */
function deduped(tests: readonly KeptTest[]): KeptTest[] {
	const held = new Map<string, KeptTest>();
	for (const test of tests) {
		if (!held.has(keptTestKey(test))) {
			held.set(keptTestKey(test), test);
		}
	}
	return [...held.values()];
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The set after keeping — or after no longer keeping — every named test.
 *
 * **An already-kept test keeps its original `keptBy`/`keptAt`.** Re-ticking a test that a group's
 * press already covers is the ordinary case, and rewriting the attribution would replace the
 * record of who first said to keep it with whoever pressed most recently.
 *
 * The whole set comes back rather than a delta, so the one writer above sees exactly what it is
 * about to store and the cap can be checked against it.
 */
export function applyKeep(
	tests: readonly KeptTest[],
	refs: readonly KeptTestRef[],
	kept: boolean,
	by: { actor: string; at: string },
): KeptTest[] {
	const held = new Map(tests.map((test) => [keptTestKey(test), test]));
	for (const ref of refs) {
		const key = keptTestKey(ref);
		if (!kept) {
			held.delete(key);
			continue;
		}
		if (!held.has(key)) {
			held.set(key, {
				project: ref.project,
				testName: ref.testName,
				keptBy: by.actor,
				keptAt: by.at,
			});
		}
	}
	return sortedForStorage([...held.values()]);
}

/**
 * The set with every entry for one project gone, and how many that was.
 *
 * **Matched on `project` exactly, with no `pathSegment` anywhere near it.** Entries were written
 * from what `list_archive` answered, which is already the component as the archive filed it (D33),
 * so the string a caller names one project's registration by is the string its entries carry —
 * running the archive's own rewrite over it here would be a second, different idea of identity in
 * the one place the store's whole meaning is *the directory's name*.
 *
 * Pure, beside {@link applyKeep}, and the count is answered rather than left to be derived: it is
 * the number D35's amendment exists to make sayable, so the operator deleting a project is told how
 * many exemptions went with it instead of discovering it later.
 */
export function withoutProject(
	tests: readonly KeptTest[],
	project: string,
): { readonly tests: KeptTest[]; readonly removed: number } {
	const kept = tests.filter((test) => test.project !== project);
	return { tests: sortedForStorage(kept), removed: tests.length - kept.length };
}

/**
 * The set with one named test's entry gone, and how many that was (D43, #272).
 *
 * **Matched on both fields exactly, with no `pathSegment` anywhere near either** —
 * {@link withoutProject}'s recorded reason, which applies with more force to a pair: the store's
 * whole meaning is *the directory's name*, and the archive's own rewrite is not idempotent. The
 * `<project>/<test_name>` pair is the identity because `test_name` alone is not one (D22), so a
 * different project's identically-named test keeps its exemption untouched.
 *
 * The count is `0` or `1` today — {@link readKeptTests} collapses duplicates on the way in and
 * {@link applyKeep} cannot write a pair twice — and is answered as a number rather than a boolean
 * so it composes with {@link pruneKeptTests}, whose report is shared with `delete_project`'s
 * project-wide prune.
 */
export function withoutTest(
	tests: readonly KeptTest[],
	project: string,
	testName: string,
): { readonly tests: KeptTest[]; readonly removed: number } {
	const kept = tests.filter((test) => test.project !== project || test.testName !== testName);
	return { tests: sortedForStorage(kept), removed: tests.length - kept.length };
}

/**
 * Take whichever entries `select` drops out of the store, inside the lock `set_kept_tests` writes
 * under — the one pruning routine **both** deletes run (D42, D43, #271, #272).
 *
 * It lives here rather than in either handler for {@link withKeptTestsLock}'s own reason one level
 * up: the two deletes are read-modify-writes of the same document, and two implementations of that
 * would be two chances to answer differently about one file — one of them rewriting a store the
 * other would have left alone.
 *
 * **A store that will not read is `failed` and is never overwritten**, which is `set_kept_tests`'
 * own promise for its own reason: resetting the file would delete every exemption on the host to
 * make one call succeed. **A store with nothing to remove is `absent` and is not rewritten
 * either** — there is nothing to write, and rewriting it would touch a document this delete has no
 * business in.
 *
 * The one warning that names the path stays on the host, where a path belongs (D19); `warn` is the
 * caller's so each delete's own sentence says which call left the store as it is.
 */
export async function pruneKeptTests(
	path: string,
	select: (tests: readonly KeptTest[]) => { readonly tests: KeptTest[]; readonly removed: number },
	warn: (message: string) => void,
): Promise<{ readonly part: DeletedPart; readonly removed: number }> {
	return withKeptTestsLock(path, async () => {
		let held: KeptTest[];
		try {
			held = await readKeptTests(path);
		} catch (error) {
			warn(unprunedKeptTestsWarning(path, error));
			return { part: 'failed' as const, removed: 0 };
		}

		const next = select(held);
		if (next.removed === 0) {
			return { part: 'absent' as const, removed: 0 };
		}
		try {
			await writeKeptTests(path, next.tests);
		} catch (error) {
			warn(unprunedKeptTestsWarning(path, error));
			return { part: 'failed' as const, removed: 0 };
		}
		return { part: 'removed' as const, removed: next.removed };
	});
}

/**
 * What the operator is told, on the host, about a store this delete left exactly as it is.
 *
 * Names the path, which is exactly what neither delete's answer may carry: the wire says only that
 * this half did not go, and this is where the diagnosis lives instead (D19).
 */
function unprunedKeptTestsWarning(path: string, error: unknown): string {
	return (
		`The kept-tests store at ${JSON.stringify(path)} was not pruned: ${describeError(error)} ` +
		`It was left exactly as it is — a store this host cannot read is never overwritten to ` +
		`make one call succeed — and no path and no reason leaves this host.`
	);
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { code: unknown }).code === 'ENOENT'
	);
}
