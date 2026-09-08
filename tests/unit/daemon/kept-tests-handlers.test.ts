/**
 * The `Keep` flag's two rows end to end: a real daemon on a temp socket, a real store on disk,
 * and a client asking over the real framing (D33, #234).
 *
 * The daemon suite's real-socket exception applies (ai/TESTING.md) — never
 * `~/.rover/rover.sock`, never `~/.rover/kept-tests.json`, and every daemon closed through its own
 * handle in `afterEach`. The filesystem is real because the whole claim of this issue is about a
 * file: **the flag survives a daemon restart**, and a mocked `fs` could only prove that the module
 * called one.
 *
 * Over the socket rather than by a direct call on the handler, because the `.strict()` result
 * parse in `src/ipc/server.ts` is half of what is asserted here: it is what makes "no host path
 * can be on an answer" structural rather than a habit (D19).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type KeptTest, readKeptTests, writeKeptTests } from '@/daemon/kept-tests.js';
import { type RunningDaemon, startDaemon } from '@/daemon/listen.js';
import type { IpcClient } from '@/ipc/client.js';
import { MAX_KEPT_TESTS } from '@/ipc/methods.js';
import {
	connectWithoutStarting,
	createTempSocket,
	removeTempSocket,
	type TempSocket,
} from '../../helpers/daemon-socket.js';

let temp: TempSocket;
const running: RunningDaemon[] = [];
const clients: IpcClient[] = [];
/** Everything the handlers said on the host. Spied rather than injected: the daemon builds them. */
let warnings: string[];

const TEST = { project: 'rover', testName: 'home-screen' } as const;

beforeEach(async () => {
	temp = await createTempSocket();
	warnings = [];
	vi.spyOn(console, 'warn').mockImplementation((line: string) => warnings.push(line));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(clients.splice(0).map((client) => client.close()));
	await Promise.all(running.splice(0).map((daemon) => daemon.close()));
	if (temp) {
		await removeTempSocket(temp);
	}
});

async function start(): Promise<RunningDaemon> {
	const result = await startDaemon({
		socketPath: temp.socketPath,
		artifactsRoot: temp.artifactsRoot,
		projectsRoot: temp.projectsRoot,
		keptTestsPath: temp.keptTestsPath,
		retention: temp.retention,
	});
	if (!result.started) {
		throw new Error('Another daemon holds the temp socket — the test cannot proceed');
	}
	running.push(result);
	return result;
}

async function connect(): Promise<IpcClient> {
	const client = await connectWithoutStarting(temp.socketPath);
	if (!client) {
		throw new Error('Nothing is serving the temp socket');
	}
	clients.push(client);
	return client;
}

/** A daemon and a client on it, which is what every test here opens with. */
async function serving(): Promise<IpcClient> {
	await start();
	return connect();
}

function keptRecord(project: string, testName: string): KeptTest {
	return { project, testName, keptBy: 'a-previous-operator', keptAt: '2026-09-01T00:00:00.000Z' };
}

describe('list_kept_tests', () => {
	it('answers listed with an empty set on a host that has kept nothing', async () => {
		const client = await serving();

		// Nothing pre-creates the store, and a store that does not exist is *nothing is kept* —
		// which is honestly `listed` with `[]`. There is deliberately no `missing` arm: unlike the
		// archive, empty and absent are the same fact about the operator's intent.
		await expect(client.request('list_kept_tests', {})).resolves.toEqual({
			outcome: 'listed',
			tests: [],
		});
		expect(warnings).toEqual([]);
	});

	it('answers the pair that names each test, and never keptBy or keptAt', async () => {
		await writeKeptTests(temp.keptTestsPath, [keptRecord('rover', 'home-screen')]);
		const client = await serving();

		const result = await client.request('list_kept_tests', {});

		// `.strict()` on the wire schema means an extra key would be `invalid_result` on the host,
		// so this is the assertion that `keptBy` stays in the file and off the answer.
		expect(result).toEqual({ outcome: 'listed', tests: [TEST] });
	});
});

describe('set_kept_tests', () => {
	it('keeps a test, and a later list sees it', async () => {
		const client = await serving();

		await expect(
			client.request('set_kept_tests', { tests: [TEST], kept: true, actor: 'alice' }),
		).resolves.toEqual({ outcome: 'set', tests: [TEST] });
		await expect(client.request('list_kept_tests', {})).resolves.toEqual({
			outcome: 'listed',
			tests: [TEST],
		});
	});

	it('stops keeping a test when kept is false', async () => {
		const client = await serving();
		await client.request('set_kept_tests', { tests: [TEST], kept: true, actor: 'alice' });

		await expect(
			client.request('set_kept_tests', { tests: [TEST], kept: false, actor: 'alice' }),
		).resolves.toEqual({ outcome: 'set', tests: [] });
		await expect(client.request('list_kept_tests', {})).resolves.toEqual({
			outcome: 'listed',
			tests: [],
		});
	});

	it('takes a whole group in one call, and answers all of it', async () => {
		const client = await serving();
		const group = Array.from({ length: 9 }, (_, index) => ({
			project: 'rover',
			testName: `test-${index}`,
		}));

		// **A group's press is one call**, not one per test: nine tests in one request, one write
		// of the whole document and one authoritative answer.
		const result = await client.request('set_kept_tests', {
			tests: group,
			kept: true,
			actor: 'alice',
		});

		expect(result).toMatchObject({ outcome: 'set' });
		expect(result.outcome === 'set' && result.tests).toHaveLength(9);
	});

	it('leaves the other eight when one of a group of nine is unticked', async () => {
		const client = await serving();
		const group = Array.from({ length: 9 }, (_, index) => ({
			project: 'rover',
			testName: `test-${index}`,
		}));
		await client.request('set_kept_tests', { tests: group, kept: true, actor: 'alice' });

		const result = await client.request('set_kept_tests', {
			tests: [{ project: 'rover', testName: 'test-4' }],
			kept: false,
			actor: 'alice',
		});

		// The group's *part-kept* tick has real state underneath it rather than a rounding.
		expect(result.outcome === 'set' && result.tests).toHaveLength(8);
		expect(result.outcome === 'set' && result.tests.map((test) => test.testName)).not.toContain(
			'test-4',
		);
	});

	it('leaves the original keptBy and keptAt of a test that is already kept', async () => {
		const original = keptRecord('rover', 'home-screen');
		await writeKeptTests(temp.keptTestsPath, [original]);
		const client = await serving();

		await client.request('set_kept_tests', { tests: [TEST], kept: true, actor: 'a-second-press' });

		// Re-ticking is the ordinary case (a group's press covers a test somebody already kept),
		// and rewriting the attribution would replace who *first* said to keep it.
		await expect(readKeptTests(temp.keptTestsPath)).resolves.toEqual([original]);
	});

	it('refuses with too-many at the cap, and writes nothing', async () => {
		const full = Array.from({ length: MAX_KEPT_TESTS }, (_, index) =>
			keptRecord('rover', `test-${String(index).padStart(5, '0')}`),
		);
		await writeKeptTests(temp.keptTestsPath, full);
		const before = await readFile(temp.keptTestsPath, 'utf8');
		const client = await serving();

		await expect(
			client.request('set_kept_tests', {
				tests: [{ project: 'rover', testName: 'one-too-many' }],
				kept: true,
				actor: 'alice',
			}),
		).resolves.toEqual({ outcome: 'refused', reason: 'too-many' });

		// Nothing written, and nothing dropped to make room — the refusal is not an eviction of
		// somebody else's exemption.
		await expect(readFile(temp.keptTestsPath, 'utf8')).resolves.toBe(before);
	});

	it('still lets a test be unticked at the cap, because that write shrinks the set', async () => {
		const full = Array.from({ length: MAX_KEPT_TESTS }, (_, index) =>
			keptRecord('rover', `test-${String(index).padStart(5, '0')}`),
		);
		await writeKeptTests(temp.keptTestsPath, full);
		const client = await serving();

		const result = await client.request('set_kept_tests', {
			tests: [{ project: 'rover', testName: 'test-00000' }],
			kept: false,
			actor: 'alice',
		});

		expect(result.outcome === 'set' && result.tests).toHaveLength(MAX_KEPT_TESTS - 1);
	});

	it('requires an actor, and a missing one is invalid_params', async () => {
		const client = await serving();

		// `as never`, the params gate's own idiom (`acquire-device.test.ts`): what is asserted is a
		// document the schema refuses, which a typed call cannot express.
		await expect(
			client.request('set_kept_tests', { tests: [TEST], kept: true } as never),
		).rejects.toMatchObject({ code: 'invalid_params' });
		// And nothing was written on the way to that refusal.
		await expect(readKeptTests(temp.keptTestsPath)).resolves.toEqual([]);
	});

	it('records one audit line naming the actor and the test', async () => {
		const client = await serving();

		await client.request('set_kept_tests', { tests: [TEST], kept: true, actor: 'alice' });

		const audit = warnings.filter((line) => line.includes('alice'));
		expect(audit).toHaveLength(1);
		expect(audit[0]).toContain('Kept 1 archived test');
		expect(audit[0]).toContain('"rover"/"home-screen"');
	});

	it('cannot have a second line forged into the audit record by a newline in the actor', async () => {
		const client = await serving();

		await client.request('set_kept_tests', {
			tests: [TEST],
			kept: true,
			actor: 'alice\nForce-released the lease on device Pixel',
		});

		// `JSON.stringify` on every caller-supplied value, `lease-handlers.ts`'s convention: a
		// record another line can be forged into is not a record.
		const audit = warnings.filter((line) => line.includes('alice'));
		expect(audit).toHaveLength(1);
		expect(audit[0]).not.toContain('\n');
		expect(audit[0]).toContain('\\n');
	});
});

describe('two presses at once', () => {
	it('lands both, and drops neither, when two different tests are kept together', async () => {
		const client = await serving();
		const alpha = { project: 'alpha', testName: 'one' };
		const beta = { project: 'beta', testName: 'two' };

		// `src/ipc/server.ts` dispatches frames without awaiting them, so these two really are in
		// the handler at once. Each is a read-modify-write of the whole document, so unserialised
		// the later read would not see the earlier press: one caller would be answered `set` for a
		// keep that was then overwritten, and the store would hold one of the two.
		const answers = await Promise.all([
			client.request('set_kept_tests', { tests: [alpha], kept: true, actor: 'alice' }),
			client.request('set_kept_tests', { tests: [beta], kept: true, actor: 'bob' }),
		]);

		expect(answers.map((answer) => answer.outcome)).toEqual(['set', 'set']);
		// Whichever ran second was answered with the set holding both — which is what the panel
		// renders, so *your tick landed, and so did the one beside it* is what it draws.
		const sizes = answers.map((answer) => (answer.outcome === 'set' ? answer.tests.length : -1));
		expect(sizes.sort()).toEqual([1, 2]);
		await expect(client.request('list_kept_tests', {})).resolves.toEqual({
			outcome: 'listed',
			tests: [alpha, beta],
		});
		// And the file still parses — two writers sharing one temporary would have left one that
		// does not (`kept-tests.ts`).
		await expect(readKeptTests(temp.keptTestsPath)).resolves.toHaveLength(2);
	});

	it('leaves one whole outcome, not a corrupt store, when one test is ticked and unticked at once', async () => {
		const client = await serving();

		const answers = await Promise.all([
			client.request('set_kept_tests', { tests: [TEST], kept: true, actor: 'alice' }),
			client.request('set_kept_tests', { tests: [TEST], kept: false, actor: 'bob' }),
		]);

		// Which of the two lands last is the operators' race and not this test's business; what is
		// asserted is that the store holds one of the two answers whole and is readable after.
		expect(answers.map((answer) => answer.outcome)).toEqual(['set', 'set']);
		const stored = await readKeptTests(temp.keptTestsPath);
		expect([0, 1]).toContain(stored.length);
		await expect(client.request('list_kept_tests', {})).resolves.toMatchObject({
			outcome: 'listed',
		});
		expect(warnings.filter((line) => line.includes('was not written'))).toEqual([]);
	});

	it('serialises two clients on one store, not just two frames on one connection', async () => {
		await start();
		const [first, second] = await Promise.all([connect(), connect()]);

		const answers = await Promise.all([
			first.request('set_kept_tests', {
				tests: [{ project: 'alpha', testName: 'one' }],
				kept: true,
				actor: 'alice',
			}),
			second.request('set_kept_tests', {
				tests: [{ project: 'beta', testName: 'two' }],
				kept: true,
				actor: 'bob',
			}),
		]);

		// Two connections are the ordinary case — the panel's tick and a `rover keep add` — and
		// the queue is keyed by the store's path precisely so it covers them too.
		expect(answers.map((answer) => answer.outcome)).toEqual(['set', 'set']);
		await expect(readKeptTests(temp.keptTestsPath)).resolves.toHaveLength(2);
	});
});

describe('a store the host cannot use', () => {
	it('answers unreadable on a read, with no path on the answer, and warns once', async () => {
		await writeFile(temp.keptTestsPath, '{ not json', 'utf8');
		const client = await serving();

		const result = await client.request('list_kept_tests', {});

		expect(result).toEqual({ outcome: 'unreadable' });
		// The diagnosis names the path and lives on the host — there is no field on either answer
		// a path would fit in (D19).
		expect(JSON.stringify(result)).not.toContain(temp.dir);
		expect(warnings.filter((line) => line.includes(temp.keptTestsPath))).toHaveLength(1);
	});

	it('answers unwritable on a write, and never overwrites the malformed store', async () => {
		await writeFile(temp.keptTestsPath, '{ not json', 'utf8');
		const client = await serving();

		const result = await client.request('set_kept_tests', {
			tests: [TEST],
			kept: true,
			actor: 'alice',
		});

		expect(result).toEqual({ outcome: 'unwritable' });
		// The same promise `readUsers` makes: resetting the file would delete every exemption on
		// the host to make one call succeed.
		await expect(readFile(temp.keptTestsPath, 'utf8')).resolves.toBe('{ not json');
		expect(JSON.stringify(result)).not.toContain(temp.dir);
		expect(warnings.filter((line) => line.includes(temp.keptTestsPath))).toHaveLength(1);
	});

	it('never turns the store\u2019s own diagnosis into an internal_error on the wire', async () => {
		await writeFile(temp.keptTestsPath, '{ not json', 'utf8');
		const client = await serving();

		// `src/ipc/server.ts` turns an escaped throw into `internal_error` carrying
		// `messageOf(error)`, and the store's messages name the path by design — so a handler that
		// let one out would put a host path on the wire. Both answer an outcome instead, which is
		// why neither call rejects at all: a rejection here is the defect.
		const answers = await Promise.all([
			client.request('list_kept_tests', {}),
			client.request('set_kept_tests', { tests: [TEST], kept: true, actor: 'alice' }),
		]);

		expect(answers).toEqual([{ outcome: 'unreadable' }, { outcome: 'unwritable' }]);
	});
});

describe('the flag survives a daemon restart', () => {
	it('is still kept by a second daemon on the same socket and the same store', async () => {
		const first = await start();
		const client = await connect();
		await client.request('set_kept_tests', { tests: [TEST], kept: true, actor: 'alice' });

		// The daemon goes away entirely: its client, then the daemon, then the socket it held.
		await client.close();
		clients.splice(clients.indexOf(client), 1);
		await first.close();
		running.splice(running.indexOf(first), 1);

		await start();
		await expect((await connect()).request('list_kept_tests', {})).resolves.toEqual({
			outcome: 'listed',
			tests: [TEST],
		});
	});

	it('is the file rather than a coincidence — a fresh reader sees the same set', async () => {
		const client = await serving();
		await client.request('set_kept_tests', { tests: [TEST], kept: true, actor: 'alice' });

		// Nothing is cached anywhere: the store is read on every call and the daemon holds none of
		// it, which is how D6 is honoured for state that cannot be re-derived (D33).
		await expect(readKeptTests(temp.keptTestsPath)).resolves.toEqual([
			{ project: 'rover', testName: 'home-screen', keptBy: 'alice', keptAt: expect.any(String) },
		]);
	});

	it('is obeyed on the next call when an operator edits the store by hand', async () => {
		const client = await serving();
		await client.request('set_kept_tests', { tests: [TEST], kept: true, actor: 'alice' });

		await writeKeptTests(temp.keptTestsPath, [keptRecord('rover', 'sign-in')]);

		await expect(client.request('list_kept_tests', {})).resolves.toEqual({
			outcome: 'listed',
			tests: [{ project: 'rover', testName: 'sign-in' }],
		});
	});
});
