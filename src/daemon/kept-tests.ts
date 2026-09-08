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
 * **Nothing here prunes, sweeps or expires anything.** There is no retention policy yet — a
 * TTL, a size cap and who runs the prune are all still open (`PROJECT.md` §9.4) — and this
 * module must not read as deciding one. {@link MAX_KEPT_TESTS} bounds the *document*, not the
 * archive.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
	ArchivePathSegmentSchema,
	AttributionStringSchema,
	type KeptTestRef,
} from '../ipc/methods.js';
import { describeIssues } from '../ipc/protocol.js';

/** Environment variable naming the store, for tests and for a non-default install. */
export const KEPT_TESTS_PATH_ENV_VAR = 'ROVER_KEPT_TESTS_PATH';

/**
 * The cap this store is held to, re-exported from `../ipc/methods.js` where it lives beside the
 * wire bound it also is — the store is the only writer, and that is what lets the read promise
 * `list_kept_tests`' array bound (`MAX_KEPT_TESTS`).
 */
export { MAX_KEPT_TESTS } from '../ipc/methods.js';

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
 */
export const KeptTestsFileSchema = z.object({ tests: z.array(KeptTestSchema) }).strict();

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
	return sortedForStorage(result.data.tests);
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
 * **No `mode: 0o600`, deliberately.** `./user-store.ts` writes its store that way because it is
 * what stands between a stranger with a shell account and every credential on the host. This
 * file holds no credential — a project name, a test name and an attribution string — and copying
 * the mode across would imply it holds one.
 */
export async function writeKeptTests(path: string, tests: readonly KeptTest[]): Promise<void> {
	const ordered = sortedForStorage(tests);
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.tmp`;
	await writeFile(temporary, `${JSON.stringify({ tests: ordered }, null, 2)}\n`, 'utf8');
	await rename(temporary, path);
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
