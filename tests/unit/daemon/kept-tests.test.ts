/**
 * The host's record of which archived tests are kept, against a real file (D33).
 *
 * Real files rather than a mocked `fs`, for `user-store.test.ts`'s reason: what is asserted here
 * is the atomic replace, the fixed order and — above all — that a store which will not parse is
 * left byte-identical, and a mock cannot be wrong about any of those. Every one lives inside a
 * per-test `mkdtemp`, never `~/.rover/kept-tests.json`, which belongs to whoever is running the
 * tests.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	applyKeep,
	defaultKeptTestsPath,
	KEPT_TESTS_PATH_ENV_VAR,
	type KeptTest,
	keptTestKey,
	MAX_KEPT_TESTS,
	pruneKeptTests,
	readKeptTests,
	resolveKeptTestsPath,
	temporaryKeptTestsPath,
	withKeptTestsLock,
	withoutProject,
	withoutTest,
	writeKeptTests,
} from '@/daemon/kept-tests.js';
import {
	createTempSocket,
	removeTempSocket,
	type TempSocket,
} from '../../helpers/daemon-socket.js';
import { createGate } from '../../helpers/timing.js';

let temp: TempSocket;
let path: string;

const AT = '2026-09-08T10:00:00.000Z';

function kept(project: string, testName: string, overrides: Partial<KeptTest> = {}): KeptTest {
	return { project, testName, keptBy: 'an-operator', keptAt: AT, ...overrides };
}

function pairsOf(tests: readonly KeptTest[]): string[] {
	return tests.map((test) => `${test.project}/${test.testName}`);
}

beforeEach(async () => {
	temp = await createTempSocket();
	path = temp.keptTestsPath;
});

afterEach(async () => {
	await removeTempSocket(temp);
});

describe('resolveKeptTestsPath', () => {
	it('falls back to ~/.rover/kept-tests.json, beside the socket and the user store', () => {
		expect(resolveKeptTestsPath({})).toBe(join(homedir(), '.rover', 'kept-tests.json'));
		expect(defaultKeptTestsPath()).toBe(join(homedir(), '.rover', 'kept-tests.json'));
	});

	it('prefers the configured path and reads process.env when passed nothing', () => {
		expect(resolveKeptTestsPath({ [KEPT_TESTS_PATH_ENV_VAR]: '/tmp/rover-kept.json' })).toBe(
			'/tmp/rover-kept.json',
		);

		vi.stubEnv(KEPT_TESTS_PATH_ENV_VAR, '/tmp/rover-kept-from-env.json');
		expect(resolveKeptTestsPath()).toBe('/tmp/rover-kept-from-env.json');
	});

	it('treats an exported-but-empty variable as unset, as the socket does', () => {
		expect(resolveKeptTestsPath({ [KEPT_TESTS_PATH_ENV_VAR]: '' })).toBe(defaultKeptTestsPath());
	});
});

describe('readKeptTests', () => {
	it('answers [] for a store that does not exist — a host keeping nothing is ordinary', async () => {
		await expect(readKeptTests(path)).resolves.toEqual([]);
	});

	it('throws naming the path on a store that is not JSON, and leaves it byte-identical', async () => {
		await writeFile(path, '{ not json', 'utf8');

		await expect(readKeptTests(path)).rejects.toThrow(path);
		// The whole promise of the throw: rewriting it as empty would delete every exemption on
		// the host to make one call succeed (`user-store.ts`'s reason).
		await expect(readFile(path, 'utf8')).resolves.toBe('{ not json');
	});

	it('throws on a document that will not match the schema, and leaves it byte-identical', async () => {
		const raw = JSON.stringify({ tests: [{ project: 'rover' }] });
		await writeFile(path, raw, 'utf8');

		await expect(readKeptTests(path)).rejects.toThrow(path);
		await expect(readFile(path, 'utf8')).resolves.toBe(raw);
	});

	it('throws on a component the archive could never have filed', async () => {
		// `..` is one of the things `ArchivePathSegmentSchema` refuses outright, so a store
		// carrying one is a store that was edited by something other than this host.
		await writeFile(path, JSON.stringify({ tests: [kept('..', 'x')] }), 'utf8');

		await expect(readKeptTests(path)).rejects.toThrow(path);
	});

	it('throws naming the path on a store hand-edited past the cap', async () => {
		// The bound is on the store's own schema, not only in the handler that refuses a write
		// over it: `list_kept_tests`' result is bounded too, so an over-cap store has to fail
		// somewhere, and failing here is a message that names the path — which both handlers turn
		// into `unreadable`/`unwritable` — rather than an `invalid_result` no client can act on.
		const tests = Array.from({ length: MAX_KEPT_TESTS + 1 }, (_, index) =>
			kept('rover', `test-${String(index).padStart(5, '0')}`),
		);
		await writeFile(path, JSON.stringify({ tests }), 'utf8');

		await expect(readKeptTests(path)).rejects.toThrow(path);
	});

	it('answers one record per test when a hand-edited store holds a pair twice', async () => {
		// Nothing this module writes can hold a duplicate (`applyKeep`'s Map), but the header
		// promises an operator editing the file by hand is obeyed — so a duplicate is collapsed on
		// the way in rather than answered twice and then quietly collapsed by the next write.
		const first = kept('rover', 'checkout flow', { keptBy: 'alice' });
		const second = kept('rover', 'checkout flow', { keptBy: 'bob' });
		await writeFile(path, JSON.stringify({ tests: [first, second] }), 'utf8');

		// The first in the file wins: the order is fixed and `sort` is stable, so every host makes
		// the same choice.
		await expect(readKeptTests(path)).resolves.toEqual([first]);
	});
});

describe('writeKeptTests', () => {
	it('round-trips the whole document', async () => {
		await writeKeptTests(path, [kept('rover', 'checkout flow')]);

		await expect(readKeptTests(path)).resolves.toEqual([kept('rover', 'checkout flow')]);
	});

	it('leaves no temporary file behind a successful write', async () => {
		await writeKeptTests(path, [kept('rover', 'checkout flow')]);

		// Write-then-`rename`, so a reader sees the old file or the new one and never half of
		// either — and never a `.tmp` sitting beside it afterwards.
		const names = await readdir(temp.dir);
		expect(names.filter((name) => name.endsWith('.tmp'))).toEqual([]);
	});

	it('orders by project then test name, by code unit, and stably across a rewrite', async () => {
		await writeKeptTests(path, [
			kept('rover', 'zebra'),
			kept('Rover', 'apple'),
			kept('rover', 'apple'),
		]);

		// Code-unit order rather than `localeCompare`, so one host cannot answer in a different
		// order from another: 'R' (0x52) sorts before 'r' (0x72).
		const first = await readKeptTests(path);
		expect(pairsOf(first)).toEqual(['Rover/apple', 'rover/apple', 'rover/zebra']);

		await writeKeptTests(path, first);
		expect(pairsOf(await readKeptTests(path))).toEqual(pairsOf(first));
	});

	it('creates the directory holding the store', async () => {
		const nested = join(temp.dir, 'deeper', 'kept-tests.json');

		await writeKeptTests(nested, [kept('rover', 'checkout flow')]);

		await expect(readKeptTests(nested)).resolves.toHaveLength(1);
	});

	it('holds no credential, so no 0o600 is implied about it', async () => {
		await writeKeptTests(path, [kept('rover', 'checkout flow')]);

		// The one property worth asserting about the bytes: what a project name, a test name and
		// an attribution string are, and nothing that reads like a secret.
		const raw = await readFile(path, 'utf8');
		expect(raw).toContain('"keptBy": "an-operator"');
		expect(raw).not.toContain('token');
	});
});

describe('two writes at once', () => {
	it('never gives two writers the same temporary, and keeps it beside the store', () => {
		// A wire call sets this store (D33), so two writers really do overlap — and two of them
		// sharing one `<path>.tmp` would each truncate it, write from offset 0 and then rename the
		// interleaved bytes over the store, leaving a document nobody can read again.
		expect(temporaryKeptTestsPath(path)).not.toBe(temporaryKeptTestsPath(path));
		// Same directory, because that is what keeps the `rename` atomic, and still a `.tmp`.
		expect(dirname(temporaryKeptTestsPath(path))).toBe(temp.dir);
		expect(temporaryKeptTestsPath(path).endsWith('.tmp')).toBe(true);
	});

	it('leaves one writer’s document whole when several overlap, and never half of each', async () => {
		// Big enough documents that a shared temporary could not fail to interleave: what is
		// asserted is that exactly one of the eight won the store whole.
		const documents = Array.from({ length: 8 }, (_, writer) =>
			Array.from({ length: 500 }, (_, index) =>
				kept('rover', `writer-${writer}-test-${String(index).padStart(4, '0')}`),
			),
		);

		await Promise.all(documents.map((document) => writeKeptTests(path, document)));

		const stored = await readKeptTests(path);
		expect(stored).toHaveLength(500);
		const writers = new Set(stored.map((test) => test.testName.split('-test-')[0]));
		expect(writers.size).toBe(1);
		const names = await readdir(temp.dir);
		expect(names.filter((name) => name.endsWith('.tmp'))).toEqual([]);
	});

	it('removes the temporary of a write that could not be renamed into place', async () => {
		// A unique name is never reused, so a failed write that left its temporary would leave one
		// per failure sitting beside the store.
		const nested = join(temp.dir, 'as-a-directory');
		await writeKeptTests(join(nested, 'kept-tests.json'), [kept('rover', 'alpha')]);

		// `rename` onto a path that is a non-empty directory fails, whatever the platform calls it.
		await expect(writeKeptTests(nested, [kept('rover', 'beta')])).rejects.toThrow();

		const names = await readdir(temp.dir);
		expect(names.filter((name) => name.endsWith('.tmp'))).toEqual([]);
	});
});

describe('applyKeep', () => {
	it('adds a test that was not kept', () => {
		const next = applyKeep([], [{ project: 'rover', testName: 'checkout flow' }], true, {
			actor: 'alice',
			at: AT,
		});

		expect(next).toEqual([kept('rover', 'checkout flow', { keptBy: 'alice' })]);
	});

	it('is idempotent, and leaves the original keptBy/keptAt of an already-kept test', () => {
		const held = [kept('rover', 'checkout flow', { keptBy: 'alice', keptAt: AT })];

		const next = applyKeep(held, [{ project: 'rover', testName: 'checkout flow' }], true, {
			actor: 'bob',
			at: '2026-09-09T10:00:00.000Z',
		});

		// Re-ticking a test a group's press already covers is the ordinary case, and rewriting the
		// attribution would replace who *first* said to keep it with whoever pressed last.
		expect(next).toEqual(held);
	});

	it('removes a test, and removing one that was never kept changes nothing', () => {
		const held = [kept('rover', 'checkout flow'), kept('rover', 'sign in')];

		expect(
			pairsOf(
				applyKeep(held, [{ project: 'rover', testName: 'checkout flow' }], false, {
					actor: 'alice',
					at: AT,
				}),
			),
		).toEqual(['rover/sign in']);
		expect(
			pairsOf(
				applyKeep(held, [{ project: 'rover', testName: 'never kept' }], false, {
					actor: 'alice',
					at: AT,
				}),
			),
		).toEqual(pairsOf(held));
	});

	it('keeps a whole group in one call, and unticking one leaves the rest', () => {
		const group = Array.from({ length: 9 }, (_, index) => ({
			project: 'rover',
			testName: `test-${index}`,
		}));

		const all = applyKeep([], group, true, { actor: 'alice', at: AT });
		expect(all).toHaveLength(9);

		const remaining = applyKeep(all, [{ project: 'rover', testName: 'test-4' }], false, {
			actor: 'alice',
			at: AT,
		});
		// The group's part-kept state has real state underneath it: eight of nine.
		expect(pairsOf(remaining)).not.toContain('rover/test-4');
		expect(remaining).toHaveLength(8);
	});

	it('holds two projects reusing one test name as two entries', () => {
		const next = applyKeep(
			[],
			[
				{ project: 'rover', testName: 'checkout flow' },
				{ project: 'swarm', testName: 'checkout flow' },
			],
			true,
			{ actor: 'alice', at: AT },
		);

		// `project` is in the identity because `test_name` alone is not one — the archive's top
		// level partitions precisely so two projects may reuse a name (`PROJECT.md` §10).
		expect(pairsOf(next)).toEqual(['rover/checkout flow', 'swarm/checkout flow']);
	});
});

describe('withoutProject', () => {
	it('takes exactly one project’s entries and counts them', () => {
		const next = withoutProject(
			[
				kept('rover', 'alpha'),
				kept('rover', 'beta'),
				kept('storefront', 'alpha'),
				kept('storefront-2', 'alpha'),
			],
			'rover',
		);

		// Exact string equality and nothing prefix-shaped: `storefront-2` is a different project
		// from `storefront`, and the store is keyed on the archive's own components (D33).
		expect(pairsOf(next.tests)).toEqual(['storefront/alpha', 'storefront-2/alpha']);
		expect(next.removed).toBe(2);
	});

	it('removes nothing, and says so, for a project it does not hold', () => {
		const held = [kept('rover', 'alpha')];

		const next = withoutProject(held, 'storefront');

		expect(pairsOf(next.tests)).toEqual(['rover/alpha']);
		// `0` is what lets the handler answer `absent` rather than rewriting a document it has no
		// business in.
		expect(next.removed).toBe(0);
	});

	it('leaves the other projects’ attribution untouched', () => {
		const next = withoutProject(
			[kept('rover', 'alpha'), kept('storefront', 'alpha', { keptBy: 'bob', keptAt: AT })],
			'rover',
		);

		expect(next.tests).toEqual([
			{ project: 'storefront', testName: 'alpha', keptBy: 'bob', keptAt: AT },
		]);
	});
});

describe('withoutTest', () => {
	it('takes exactly the one pair and counts it', () => {
		const next = withoutTest(
			[kept('rover', 'alpha'), kept('rover', 'beta'), kept('storefront', 'alpha')],
			'rover',
			'alpha',
		);

		// Both fields, on the same entry: `test_name` alone is not an identity (D22), so the same
		// test name under another project keeps its exemption and a sibling test keeps its own.
		expect(pairsOf(next.tests)).toEqual(['rover/beta', 'storefront/alpha']);
		expect(next.removed).toBe(1);
	});

	it('removes nothing, and says so, for a pair it does not hold', () => {
		const held = [kept('rover', 'alpha')];

		expect(withoutTest(held, 'rover', 'beta')).toEqual({ tests: held, removed: 0 });
		expect(withoutTest(held, 'storefront', 'alpha')).toEqual({ tests: held, removed: 0 });
	});

	it('matches the component exactly, with nothing prefix-shaped and no rewriting', () => {
		// The entries were written from what `list_archive` answered, so the string in the store is
		// the directory's own name — `pathSegment` near either side would be a second idea of
		// identity in the one place the store's whole meaning is the directory's name (D33).
		const held = [kept('rover', 'checkout flow'), kept('rover', 'checkout flow-2')];

		expect(pairsOf(withoutTest(held, 'rover', 'checkout flow').tests)).toEqual([
			'rover/checkout flow-2',
		]);
	});
});

describe('pruneKeptTests, the one routine both deletes run', () => {
	it('removes what the predicate drops and reports removed with the count', async () => {
		await writeKeptTests(path, [kept('rover', 'alpha'), kept('storefront', 'alpha')]);

		const pruned = await pruneKeptTests(
			path,
			(tests) => withoutTest(tests, 'rover', 'alpha'),
			() => {
				throw new Error('nothing should have been warned about');
			},
		);

		expect(pruned).toEqual({ part: 'removed', removed: 1 });
		expect(pairsOf(await readKeptTests(path))).toEqual(['storefront/alpha']);
	});

	it('answers absent and does not rewrite a store with nothing to remove', async () => {
		await writeKeptTests(path, [kept('rover', 'alpha')]);
		const before = await readFile(path, 'utf8');

		const pruned = await pruneKeptTests(
			path,
			(tests) => withoutTest(tests, 'rover', 'never-kept'),
			() => undefined,
		);

		// Not a rewrite of an unchanged document: this delete has no business touching a file it
		// removed nothing from.
		expect(pruned).toEqual({ part: 'absent', removed: 0 });
		expect(await readFile(path, 'utf8')).toBe(before);
	});

	it('answers failed and leaves a store it cannot read byte-identical', async () => {
		await writeFile(path, '{ not json', 'utf8');
		const warned: string[] = [];

		const pruned = await pruneKeptTests(
			path,
			(tests) => withoutTest(tests, 'rover', 'alpha'),
			(line) => warned.push(line),
		);

		// `set_kept_tests`' own promise: resetting the file would delete every exemption on the
		// host to make one call succeed.
		expect(pruned).toEqual({ part: 'failed', removed: 0 });
		expect(await readFile(path, 'utf8')).toBe('{ not json');
		// And the path is said on the host, which is the one place it may be (D19).
		expect(warned).toHaveLength(1);
		expect(warned[0]).toContain(path);
	});

	it('answers absent for a store that is not there at all', async () => {
		expect(
			await pruneKeptTests(
				path,
				(tests) => withoutTest(tests, 'rover', 'alpha'),
				() => undefined,
			),
		).toEqual({ part: 'absent', removed: 0 });
	});

	/*
	 * **It runs inside the lock `set_kept_tests` writes under**, which is the whole reason it lives
	 * in this module: a prune and a press that interleaved would each write a document the other
	 * had not seen, with both callers answered success.
	 */
	it('does not interleave with another read-modify-write of the same store', async () => {
		await writeKeptTests(path, [kept('rover', 'alpha'), kept('storefront', 'alpha')]);

		const adding = withKeptTestsLock(path, async () => {
			const held = await readKeptTests(path);
			await Promise.resolve();
			await writeKeptTests(
				path,
				applyKeep(held, [{ project: 'rover', testName: 'beta' }], true, {
					actor: 'alice',
					at: AT,
				}),
			);
		});
		const pruning = pruneKeptTests(
			path,
			(tests) => withoutTest(tests, 'storefront', 'alpha'),
			() => undefined,
		);
		await Promise.all([adding, pruning]);

		expect(pairsOf(await readKeptTests(path))).toEqual(['rover/alpha', 'rover/beta']);
	});
});

describe('the write lock two writers share', () => {
	/*
	 * **This is the test that would fail if the lock were not shared.** `set_kept_tests` and
	 * `delete_project` are two read-modify-writes of one document (D42, #271); two chains keyed on
	 * one path would serialise each writer against itself and neither against the other, so the
	 * later read would not see the earlier write and one of the two would be silently dropped with
	 * both callers answered success.
	 */
	it('keeps two overlapping read-modify-writes from dropping each other', async () => {
		await writeKeptTests(path, [kept('rover', 'alpha'), kept('storefront', 'alpha')]);

		// One writer adds a test; the other takes a project. Each reads, yields, then writes —
		// which is precisely the interleaving the lock exists to prevent.
		const adding = withKeptTestsLock(path, async () => {
			const held = await readKeptTests(path);
			await Promise.resolve();
			await writeKeptTests(
				path,
				applyKeep(held, [{ project: 'rover', testName: 'beta' }], true, {
					actor: 'alice',
					at: AT,
				}),
			);
		});
		const deleting = withKeptTestsLock(path, async () => {
			const held = await readKeptTests(path);
			await Promise.resolve();
			await writeKeptTests(path, withoutProject(held, 'storefront').tests);
		});
		await Promise.all([adding, deleting]);

		// Both landed: the addition is there and the deleted project is gone. Either write alone
		// winning would leave one of those two false.
		expect(pairsOf(await readKeptTests(path))).toEqual(['rover/alpha', 'rover/beta']);
	});

	it('does not make two different stores wait on each other', async () => {
		const other = join(temp.dir, 'other-kept-tests.json');
		const order: string[] = [];
		const gate = createGate();

		const first = withKeptTestsLock(path, async () => {
			await gate.reached;
			order.push('first');
		});
		const second = withKeptTestsLock(other, async () => {
			order.push('second');
			gate.reach();
		});
		await Promise.all([first, second]);

		// Keyed by the path: the store nobody is holding is not queued behind the one that is.
		expect(order).toEqual(['second', 'first']);
	});
});

describe('keptTestKey', () => {
	it('joins on the one character a component may not hold, so no two tests collide', () => {
		// NUL is one of the characters `ArchivePathSegmentSchema` refuses, so no component can
		// contain one and no two different tests can share a key — the argument the panel's own
		// `keyOf` records. A `/` join would collide `a/b` + `c` with `a` + `b/c`.
		expect(keptTestKey({ project: 'a', testName: 'b' })).toBe('a\u0000b');
		expect(keptTestKey({ project: 'a/b', testName: 'c' })).not.toBe(
			keptTestKey({ project: 'a', testName: 'b/c' }),
		);
	});
});
