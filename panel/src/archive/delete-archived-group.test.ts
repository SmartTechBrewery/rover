import type { HostAnswer, RpcEnvelope } from '@panel/session/host-client.js';
import { describe, expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/panel/delete-archived-group.json';
import { DeleteArchivedGroupResultSchema, deleteArchivedGroup } from './delete-archived-group.js';

/**
 * The panel's half of `delete_archived_group`: what goes on the wire, and every way one ask can come
 * back.
 *
 * The four outcomes are not four flavours of one — they are what the screen has to tell apart
 * (`docs/DESIGN.md` §9, D43). Two of them carry this row's own figure, `runsRemoved`, which is the
 * only thing that says what the operator actually took: a group has no directory whose size stands
 * for it. And the one this file exists for above all is the fifth answer, which is not an outcome: a
 * request that reached nothing deleted nothing, and it must never narrow to anything that reads as a
 * removal.
 */

const DELETED = {
	outcome: 'deleted',
	archive: 'removed',
	keptTests: 'removed',
	freedBytes: 8_451_208,
	keptTestsRemoved: 1,
	runsRemoved: 7,
};

const GROUP = {
	project: 'checkout-web',
	groupId: 'app-bar-top-space',
	actor: 'karolina',
};

/** A host that answers one envelope, and records what it was asked. */
function host(answer: HostAnswer<RpcEnvelope>) {
	return vi.fn(async () => answer);
}

function result(value: unknown): HostAnswer<RpcEnvelope> {
	return { ok: true, value: { type: 'result', result: value } };
}

describe('the ask', () => {
	it('names the method, the project component, the group id and the actor — and no path', async () => {
		const call = host(result(DELETED));

		await deleteArchivedGroup(call, GROUP);

		expect(call).toHaveBeenCalledTimes(1);
		expect(call).toHaveBeenCalledWith('delete_archived_group', GROUP);
		/*
		 * The absence is the method's own promise (D19): the host composes every path from its own
		 * roots, and the panel names one group by a component and an opaque id.
		 */
		expect(JSON.stringify(call.mock.calls[0])).not.toContain('path');
	});

	/*
	 * **A group id is content and not an address** (R41), so one carrying a separator goes on the
	 * wire verbatim: the archive has no `<group_id>/` level, and the host matches it against what
	 * each run filed. A panel that sanitised it here would be unable to delete a group a lease
	 * really named.
	 */
	it('sends a group id carrying a separator verbatim', async () => {
		const call = host(result({ outcome: 'not-found' }));

		await deleteArchivedGroup(call, { ...GROUP, groupId: '../../etc/passwd' });

		expect(call).toHaveBeenCalledWith('delete_archived_group', {
			...GROUP,
			groupId: '../../etc/passwd',
		});
	});
});

describe('the host answered', () => {
	it('reads a delete that took the group’s runs, with how many and what they came to', async () => {
		const answer = await deleteArchivedGroup(host(result(DELETED)), GROUP);

		expect(answer).toEqual(DELETED);
	});

	/*
	 * **A group that emptied no test is `deleted`** with `keptTests: 'absent'` — the ordinary case,
	 * because this delete takes runs and only removes a test the runs happened to be the last of.
	 */
	it('reads a delete that emptied no test at all', async () => {
		const value = {
			outcome: 'deleted',
			archive: 'removed',
			keptTests: 'absent',
			freedBytes: 412_306,
			keptTestsRemoved: 0,
			runsRemoved: 1,
		};

		const answer = await deleteArchivedGroup(host(result(value)), {
			...GROUP,
			groupId: 'basket-total',
		});

		expect(answer).toEqual(value);
	});

	/*
	 * **`partial` keeps the whole report**, which is what lets the screen say how much went and that
	 * the rest may still be filed. It is the answer whose next move is *ask again*, and a `partial`
	 * narrowed to a bare outcome would make that the least legible answer of the four.
	 */
	it('reads a delete that could not take all of it, with how much did go', async () => {
		const value = {
			outcome: 'partial',
			archive: 'failed',
			keptTests: 'removed',
			freedBytes: 90_114,
			keptTestsRemoved: 2,
			runsRemoved: 2,
		};

		const answer = await deleteArchivedGroup(host(result(value)), GROUP);

		expect(answer).toEqual(value);
	});

	/*
	 * **A truncated walk is that same arm with `runsRemoved: 0`**, and the panel must keep it apart
	 * from a `deleted`: nothing has established that the group is gone.
	 */
	it('reads a walk that was cut short before it reached anything', async () => {
		const value = {
			outcome: 'partial',
			archive: 'failed',
			keptTests: 'absent',
			freedBytes: 0,
			keptTestsRemoved: 0,
			runsRemoved: 0,
		};

		const answer = await deleteArchivedGroup(host(result(value)), GROUP);

		expect(answer).toEqual(value);
	});

	/*
	 * **Not a delete of zero runs**, and the shape is what keeps it from becoming one: the arm
	 * carries no report, so nothing on the screen can read a `0` off it (D42's rule two scopes down).
	 */
	it('keeps a request that reached nothing apart from a delete that freed nothing', async () => {
		const nothing = await deleteArchivedGroup(host(result({ outcome: 'not-found' })), GROUP);
		const nought = await deleteArchivedGroup(
			host(
				result({
					outcome: 'deleted',
					archive: 'removed',
					keptTests: 'absent',
					freedBytes: 0,
					keptTestsRemoved: 0,
					runsRemoved: 1,
				}),
			),
			GROUP,
		);

		expect(nothing).toEqual({ outcome: 'not-found' });
		expect(nought.outcome).toBe('deleted');
	});

	// A live lease is data, not a host that broke: the next move is obvious and is the operator's.
	it('reads a refusal, with the one reason there is', async () => {
		const answer = await deleteArchivedGroup(
			host(result({ outcome: 'refused', reason: 'lease-live' })),
			GROUP,
		);

		expect(answer).toEqual({ outcome: 'refused', reason: 'lease-live' });
	});

	/*
	 * The mirror is not `.strict()`, for `delete-archived-test.ts`'s reason: a newer daemon adding a
	 * field must not cost the operator the answer to "did that group's runs go".
	 */
	it('tolerates a field this panel has never heard of', async () => {
		const answer = await deleteArchivedGroup(host(result({ ...DELETED, testsEmptied: 3 })), GROUP);

		expect(answer).toEqual(DELETED);
	});
});

/**
 * Every way an ask can produce no answer, and the one rule they all obey: **nothing was deleted, so
 * nothing may read as a removal.**
 */
describe('nothing usable came back', () => {
	it('reports the host that answered nothing at all', async () => {
		const answer = await deleteArchivedGroup(host({ ok: false, refusal: 'unanswered' }), GROUP);

		expect(answer).toEqual({ outcome: 'unanswered' });
	});

	// An `error` envelope is a `200` with something to read, and what it says is that no run went.
	it('folds an error envelope in with it', async () => {
		const answer = await deleteArchivedGroup(
			host({
				ok: true,
				value: { type: 'error', error: { code: 'invalid_params', message: 'nope' } },
			}),
			GROUP,
		);

		expect(answer).toEqual({ outcome: 'unanswered' });
	});

	it.each([
		['a result of another shape', { deleted: true }],
		['an outcome this panel does not know', { outcome: 'swept' }],
		// The project's own vocabulary is not this row's: a group has no registration, so the arm
		// that reached nothing is `not-found` and `not-registered` is another method's answer.
		['the project method’s empty arm', { outcome: 'not-registered' }],
		['a refusal reason this panel does not know', { outcome: 'refused', reason: 'busy' }],
		['a half whose fate this panel does not know', { ...DELETED, archive: 'pending' }],
		['a delete with no report on it', { outcome: 'deleted' }],
		// The figure only this row has, missing: without it the group's line has nothing to say.
		[
			'a report with no run count on it',
			{
				outcome: 'deleted',
				archive: 'removed',
				keptTests: 'absent',
				freedBytes: 512,
				keptTestsRemoved: 0,
			},
		],
	])('folds %s in with it', async (_case, value) => {
		const answer = await deleteArchivedGroup(host(result(value)), GROUP);

		expect(answer).toEqual({ outcome: 'unanswered' });
	});

	/*
	 * The exception that is not an outcome either. `Session.call` has already fired the bounce to
	 * *access ended* and the router is coming down, so this answer exists to keep the control silent.
	 */
	it('keeps a refused session apart from a host that said nothing', async () => {
		const answer = await deleteArchivedGroup(host({ ok: false, refusal: 'refused' }), GROUP);

		expect(answer).toEqual({ outcome: 'access-ended' });
	});
});

/**
 * The panel's half of the drift gate `tests/unit/panel/delete-archived-group-fixture.test.ts`
 * opens, and `delete-archived-test.test.ts`'s reasoning applies verbatim: one file, parsed here by
 * the mirror and there by the daemon's own `.strict()` schemas, by two projects that cannot import
 * each other.
 *
 * The literals everywhere above this block are the panel's own, so on their own they pin the panel
 * against itself. This block is what ties them to `src/ipc/methods.ts`.
 */
describe("the panel's mirror of delete_archived_group", () => {
	it('reads every answer on the file, down to the fate of each half and the run count', () => {
		expect(
			fixture.answers.map((answer) => DeleteArchivedGroupResultSchema.parse(answer.result)),
		).toEqual([
			{
				outcome: 'deleted',
				archive: 'removed',
				keptTests: 'removed',
				freedBytes: 8_451_208,
				keptTestsRemoved: 1,
				runsRemoved: 7,
			},
			{
				outcome: 'deleted',
				archive: 'removed',
				keptTests: 'absent',
				freedBytes: 412_306,
				keptTestsRemoved: 0,
				runsRemoved: 1,
			},
			{
				outcome: 'partial',
				archive: 'failed',
				keptTests: 'removed',
				freedBytes: 90_114,
				keptTestsRemoved: 2,
				runsRemoved: 2,
			},
			{
				outcome: 'partial',
				archive: 'failed',
				keptTests: 'absent',
				freedBytes: 0,
				keptTestsRemoved: 0,
				runsRemoved: 0,
			},
			{ outcome: 'not-found' },
			{ outcome: 'refused', reason: 'lease-live' },
		]);
	});

	/*
	 * The whole file through `deleteArchivedGroup`, which is what proves nothing in it narrows to
	 * `unanswered` — the answer the panel gives when it cannot read a reply, and the one a silent
	 * drift would turn every real delete into.
	 */
	it.each(
		fixture.answers.map((answer, index) => [index, answer] as const),
	)('reads entry %i rather than folding it into an ask that reached nothing', async (_index, answer) => {
		const read = await deleteArchivedGroup(host(result(answer.result)), answer.params);

		expect(read.outcome).not.toBe('unanswered');
	});
});
