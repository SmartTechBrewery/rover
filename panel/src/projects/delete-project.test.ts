import type { HostAnswer, RpcEnvelope } from '@panel/session/host-client.js';
import { describe, expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/panel/delete-project.json';
import { DeleteProjectResultSchema, deleteProject } from './delete-project.js';

/**
 * The panel's half of `delete_project`: what goes on the wire, and every way one ask can come back.
 *
 * The four outcomes are not four flavours of one — they are what the screen has to tell apart
 * (`docs/DESIGN.md` §10, D42). The one this file exists for above all is the fifth answer, which is
 * not an outcome: a request that reached nothing deleted nothing, and it must never narrow to
 * anything that reads as a removal.
 */

const DELETED = {
	outcome: 'deleted',
	registration: 'removed',
	archive: 'removed',
	keptTests: 'removed',
	freedBytes: 7_723_471,
	keptTestsRemoved: 3,
};

/** A host that answers one envelope, and records what it was asked. */
function host(answer: HostAnswer<RpcEnvelope>) {
	return vi.fn(async () => answer);
}

function result(value: unknown): HostAnswer<RpcEnvelope> {
	return { ok: true, value: { type: 'result', result: value } };
}

describe('the ask', () => {
	it('names the method, the identifier and the actor — and no path', async () => {
		const call = host(result(DELETED));

		await deleteProject(call, { project: 'checkout-web', actor: 'karolina' });

		expect(call).toHaveBeenCalledTimes(1);
		expect(call).toHaveBeenCalledWith('delete_project', {
			project: 'checkout-web',
			actor: 'karolina',
		});
		/*
		 * The absence is the method's own promise (D19): the host composes every path from its own
		 * roots, and the panel names one project by the identifier `list_projects` answered with.
		 */
		expect(JSON.stringify(call.mock.calls[0])).not.toContain('/');
		expect(JSON.stringify(call.mock.calls[0])).not.toContain('path');
	});
});

describe('the host answered', () => {
	it('reads a delete that took all three halves, with what it came to', async () => {
		const answer = await deleteProject(host(result(DELETED)), {
			project: 'checkout-web',
			actor: 'karolina',
		});

		expect(answer).toEqual(DELETED);
	});

	/*
	 * **A hook file that was already gone but an archive subtree that was not is `deleted`** with
	 * `registration: 'absent'` — a lease may name any project string (D22), so a subtree with no
	 * registration is ordinary and taking it is a delete that did something.
	 */
	it('reads a delete of a subtree no registration named', async () => {
		const value = {
			outcome: 'deleted',
			registration: 'absent',
			archive: 'removed',
			keptTests: 'absent',
			freedBytes: 412_306,
			keptTestsRemoved: 0,
		};

		const answer = await deleteProject(host(result(value)), {
			project: 'rover-sandbox',
			actor: 'karolina',
		});

		expect(answer).toEqual(value);
	});

	/*
	 * **`partial` keeps the whole report**, which is what lets the screen name the half that stayed.
	 * A `partial` narrowed to a bare outcome would make the one answer whose next move is *look at
	 * this host's log* the least legible of the four.
	 */
	it('reads a delete that left a half behind, with which half it was', async () => {
		const value = {
			outcome: 'partial',
			registration: 'removed',
			archive: 'failed',
			keptTests: 'removed',
			freedBytes: 0,
			keptTestsRemoved: 1,
		};

		const answer = await deleteProject(host(result(value)), {
			project: 'legacy-kiosk',
			actor: 'alice',
		});

		expect(answer).toEqual(value);
	});

	/*
	 * **Not a delete of zero bytes**, and the shape is what keeps it from becoming one: the arm
	 * carries no report, so nothing on the screen can read a `0` off it (D42).
	 */
	it('keeps a request that reached nothing apart from a delete that freed nothing', async () => {
		const nothing = await deleteProject(host(result({ outcome: 'not-registered' })), {
			project: 'never-registered',
			actor: 'alice',
		});
		const nought = await deleteProject(
			host(
				result({
					outcome: 'deleted',
					registration: 'removed',
					archive: 'absent',
					keptTests: 'absent',
					freedBytes: 0,
					keptTestsRemoved: 0,
				}),
			),
			{ project: 'checkout-web', actor: 'alice' },
		);

		expect(nothing).toEqual({ outcome: 'not-registered' });
		expect(nought.outcome).toBe('deleted');
	});

	// A live lease is data, not a host that broke: the next move is obvious and is the operator's.
	it('reads a refusal, with the one reason there is', async () => {
		const answer = await deleteProject(host(result({ outcome: 'refused', reason: 'lease-live' })), {
			project: 'statistics-deliveries',
			actor: 'karolina',
		});

		expect(answer).toEqual({ outcome: 'refused', reason: 'lease-live' });
	});

	/*
	 * The mirror is not `.strict()`, for `project-list.ts`'s reason: a newer daemon adding a field
	 * must not cost the operator the answer to "did that project go". The extra field is dropped,
	 * and the outcome survives.
	 */
	it('tolerates a field this panel has never heard of', async () => {
		const answer = await deleteProject(host(result({ ...DELETED, restoredIn: 'a-while' })), {
			project: 'checkout-web',
			actor: 'karolina',
		});

		expect(answer).toEqual(DELETED);
	});
});

/**
 * Every way an ask can produce no answer, and the one rule they all obey: **nothing was deleted, so
 * nothing may read as a removal.**
 */
describe('nothing usable came back', () => {
	it('reports the host that answered nothing at all', async () => {
		const answer = await deleteProject(host({ ok: false, refusal: 'unanswered' }), {
			project: 'checkout-web',
			actor: 'karolina',
		});

		expect(answer).toEqual({ outcome: 'unanswered' });
	});

	// An `error` envelope is a `200` with something to read, and what it says is that no project
	// went. Its code is the host's vocabulary and is not this screen's news.
	it('folds an error envelope in with it', async () => {
		const answer = await deleteProject(
			host({
				ok: true,
				value: { type: 'error', error: { code: 'invalid_params', message: 'nope' } },
			}),
			{ project: 'checkout-web', actor: 'karolina' },
		);

		expect(answer).toEqual({ outcome: 'unanswered' });
	});

	it.each([
		['a result of another shape', { deleted: true }],
		['an outcome this panel does not know', { outcome: 'swept' }],
		['a refusal reason this panel does not know', { outcome: 'refused', reason: 'busy' }],
		['a half whose fate this panel does not know', { ...DELETED, archive: 'pending' }],
		['a delete with no report on it', { outcome: 'deleted' }],
	])('folds %s in with it', async (_case, value) => {
		const answer = await deleteProject(host(result(value)), {
			project: 'checkout-web',
			actor: 'karolina',
		});

		expect(answer).toEqual({ outcome: 'unanswered' });
	});

	/*
	 * The exception that is not an outcome either. `Session.call` has already fired the bounce to
	 * *access ended* and the router is coming down, so this answer exists to keep the control
	 * silent — the device poll leaves the same silence for the same reason.
	 */
	it('keeps a refused session apart from a host that said nothing', async () => {
		const answer = await deleteProject(host({ ok: false, refusal: 'refused' }), {
			project: 'checkout-web',
			actor: 'karolina',
		});

		expect(answer).toEqual({ outcome: 'access-ended' });
	});
});

/**
 * The panel's half of the drift gate `tests/unit/panel/delete-project-fixture.test.ts` opens, and
 * `force-release.test.ts`'s reasoning applies verbatim: one file, parsed here by the mirror and
 * there by the daemon's own `.strict()` schemas, by two projects that cannot import each other.
 *
 * The literals everywhere above this block are the panel's own, so on their own they pin the panel
 * against itself. This block is what ties them to `src/ipc/methods.ts` — and it matters here for
 * force-release's sharper reason, because an outcome renamed on the host narrows to `unanswered`
 * rather than failing, which would turn every real delete in the browser into *"nothing came back
 * from the host"* with both suites still green.
 */
describe("the panel's mirror of delete_project", () => {
	it('reads every answer on the file, down to the fate of each half', () => {
		expect(fixture.answers.map((answer) => DeleteProjectResultSchema.parse(answer.result))).toEqual(
			[
				{
					outcome: 'deleted',
					registration: 'removed',
					archive: 'removed',
					keptTests: 'removed',
					freedBytes: 7_723_471,
					keptTestsRemoved: 3,
				},
				{
					outcome: 'deleted',
					registration: 'absent',
					archive: 'removed',
					keptTests: 'absent',
					freedBytes: 412_306,
					keptTestsRemoved: 0,
				},
				{
					outcome: 'partial',
					registration: 'removed',
					archive: 'failed',
					keptTests: 'removed',
					freedBytes: 0,
					keptTestsRemoved: 1,
				},
				{
					outcome: 'partial',
					registration: 'failed',
					archive: 'failed',
					keptTests: 'failed',
					freedBytes: 0,
					keptTestsRemoved: 0,
				},
				{ outcome: 'not-registered' },
				{ outcome: 'refused', reason: 'lease-live' },
			],
		);
	});

	/*
	 * The whole file through `deleteProject`, which is what proves nothing in it narrows to
	 * `unanswered` — the answer the panel gives when it cannot read a reply, and the one a silent
	 * drift would turn every real delete into.
	 */
	it.each(
		fixture.answers.map((answer, index) => [index, answer] as const),
	)('reads entry %i rather than folding it into an ask that reached nothing', async (_index, answer) => {
		const read = await deleteProject(host(result(answer.result)), answer.params);

		expect(read.outcome).not.toBe('unanswered');
	});
});
