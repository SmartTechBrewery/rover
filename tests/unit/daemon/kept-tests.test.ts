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
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	applyKeep,
	defaultKeptTestsPath,
	KEPT_TESTS_PATH_ENV_VAR,
	type KeptTest,
	keptTestKey,
	readKeptTests,
	resolveKeptTestsPath,
	writeKeptTests,
} from '@/daemon/kept-tests.js';
import {
	createTempSocket,
	removeTempSocket,
	type TempSocket,
} from '../../helpers/daemon-socket.js';

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
