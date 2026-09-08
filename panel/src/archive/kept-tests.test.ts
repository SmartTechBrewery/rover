import type { HostAnswer, RpcEnvelope } from '@panel/session/host-client.js';
import { describe, expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/panel/kept-tests.json';
import {
	ListKeptTestsResultSchema,
	listKeptTests,
	SetKeptTestsResultSchema,
	setKeptTests,
} from './kept-tests.js';

/**
 * The panel's half of the `Keep` flag's two methods: what goes on the wire, and every way one ask
 * can come back.
 *
 * The four answers each method narrows to are not four flavours of one — they are what the screen
 * has to tell apart (`docs/DESIGN.md` §9). The two this file exists for above all: an ask that
 * reached nothing must never be drawn as a set, because a tick drawn from it would be the panel
 * claiming the operator's own decision; and a press the host did not make must leave the tick
 * exactly where it was.
 */

const LOGIN: { readonly project: string; readonly testName: string } = {
	project: 'checkout-app',
	testName: 'login-flow',
};

/** A host that answers one envelope, and records what it was asked. */
function host(answer: HostAnswer<RpcEnvelope>) {
	return vi.fn(async () => answer);
}

function result(value: unknown): HostAnswer<RpcEnvelope> {
	return { ok: true, value: { type: 'result', result: value } };
}

const PRESS = { tests: [LOGIN], kept: true, actor: 'karolina' };

describe('the read', () => {
	it('names the method and takes nothing', async () => {
		const call = host(result({ outcome: 'listed', tests: [] }));

		await listKeptTests(call);

		expect(call).toHaveBeenCalledTimes(1);
		expect(call).toHaveBeenCalledWith('list_kept_tests', {});
	});

	it('reads the whole set the host answered', async () => {
		const answer = await listKeptTests(host(result({ outcome: 'listed', tests: [LOGIN] })));

		expect(answer).toEqual({ outcome: 'listed', tests: [LOGIN] });
	});

	// `tests: []` is *this host keeps nothing*, which is not a failure and is not the same answer as
	// a store the host cannot read — the pair D6 forbids rendering alike.
	it('keeps a host that keeps nothing apart from one that cannot say', async () => {
		expect(await listKeptTests(host(result({ outcome: 'listed', tests: [] })))).toEqual({
			outcome: 'listed',
			tests: [],
		});
		expect(await listKeptTests(host(result({ outcome: 'unreadable' })))).toEqual({
			outcome: 'unreadable',
		});
	});

	/*
	 * The mirror is not `.strict()`, for `archive-listing.ts`'s reason: a newer daemon adding a
	 * field must not cost the operator every tick on the screen. The extra field is dropped and the
	 * set survives.
	 */
	it('tolerates a field this panel has never heard of', async () => {
		const answer = await listKeptTests(
			host(result({ outcome: 'listed', tests: [{ ...LOGIN, keptBy: 'karolina' }], note: 'hi' })),
		);

		expect(answer).toEqual({ outcome: 'listed', tests: [LOGIN] });
	});

	it.each([
		['a host that answered nothing at all', { ok: false, refusal: 'unanswered' } as const],
		[
			'an error envelope',
			{
				ok: true,
				value: { type: 'error', error: { code: 'invalid_params', message: 'nope' } },
			} as HostAnswer<RpcEnvelope>,
		],
		['a result of another shape', result({ kept: [] })],
		['an outcome this panel does not know', result({ outcome: 'missing' })],
		['a listing with no tests key', result({ outcome: 'listed' })],
	])('folds %s into nothing came back', async (_case, answer) => {
		expect(await listKeptTests(host(answer))).toEqual({ outcome: 'unanswered' });
	});

	/*
	 * The exception that is not an outcome. `Session.call` has already fired the bounce to *access
	 * ended* and the router is coming down, so this answer exists to keep the screen silent.
	 */
	it('keeps a refused session apart from a host that said nothing', async () => {
		expect(await listKeptTests(host({ ok: false, refusal: 'refused' }))).toEqual({
			outcome: 'access-ended',
		});
	});
});

describe('the press', () => {
	/*
	 * **One request for however many tests the press stood over**, which is the shape rather than a
	 * convenience: nine calls would leave a partly-written group visible between them and nine
	 * audit lines for one decision.
	 */
	it('names the method, every test it stands over, the direction and the actor', async () => {
		const call = host(result({ outcome: 'set', tests: [LOGIN] }));

		await setKeptTests(call, {
			tests: [LOGIN, { project: 'checkout-app', testName: 'basket' }],
			kept: true,
			actor: 'karolina',
		});

		expect(call).toHaveBeenCalledTimes(1);
		expect(call).toHaveBeenCalledWith('set_kept_tests', {
			tests: [LOGIN, { project: 'checkout-app', testName: 'basket' }],
			kept: true,
			actor: 'karolina',
		});
	});

	// The answer is the whole set after the write, not an acknowledgement — which is what removes
	// any need for the screen to guess what its own press produced (R29).
	it('reads the whole set back rather than an acknowledgement', async () => {
		const answer = await setKeptTests(host(result({ outcome: 'set', tests: [LOGIN] })), PRESS);

		expect(answer).toEqual({ outcome: 'set', tests: [LOGIN] });
	});

	/*
	 * **The cap and a store the host could not write are one answer here** (`kept-tests.ts`): both
	 * mean the write did not happen and the store is exactly as it was, which is the only fact a
	 * tick renders. Neither may read as a set.
	 */
	it.each([
		['the cap refusing the press', { outcome: 'refused', reason: 'too-many' }],
		['a store the host did not write', { outcome: 'unwritable' }],
	])('reads %s as a write that did not happen', async (_case, value) => {
		expect(await setKeptTests(host(result(value)), PRESS)).toEqual({ outcome: 'unwritable' });
	});

	it.each([
		['a host that answered nothing at all', { ok: false, refusal: 'unanswered' } as const],
		[
			'an error envelope',
			{
				ok: true,
				value: { type: 'error', error: { code: 'invalid_params', message: 'nope' } },
			} as HostAnswer<RpcEnvelope>,
		],
		['a result of another shape', result({ written: true })],
		['an outcome this panel does not know', result({ outcome: 'queued' })],
		['a refusal reason this panel does not know', result({ outcome: 'refused', reason: 'busy' })],
	])('folds %s into nothing came back', async (_case, answer) => {
		expect(await setKeptTests(host(answer), PRESS)).toEqual({ outcome: 'unanswered' });
	});

	it('keeps a refused session apart from a host that said nothing', async () => {
		expect(await setKeptTests(host({ ok: false, refusal: 'refused' }), PRESS)).toEqual({
			outcome: 'access-ended',
		});
	});
});

/**
 * The panel's half of the drift gate `tests/unit/panel/kept-tests-fixture.test.ts` opens, and
 * `force-release.test.ts`'s reasoning applies verbatim: one file, parsed here by the mirror and
 * there by the daemon's own `.strict()` schemas, by two projects that cannot import each other.
 *
 * The literals everywhere above this block are the panel's own, so on their own they pin the panel
 * against itself. This block is what ties them to `src/ipc/methods.ts` — and it matters here for
 * force-release's exact reason: an outcome renamed on the host narrows to `unanswered` rather than
 * failing, which would leave every tick on the screen unable to move with both suites green.
 */
describe("the panel's mirror of the Keep flag's two methods", () => {
	it('reads a real set, down to the two projects that share one test name', () => {
		const parsed = ListKeptTestsResultSchema.parse(fixture.list[0]);

		expect(parsed).toEqual({
			outcome: 'listed',
			tests: [
				{ project: 'checkout-app', testName: 'login-flow' },
				{ project: 'payments-web', testName: 'login-flow' },
			],
		});
	});

	it.each(
		fixture.list.map((answer, index) => [index, answer] as const),
	)('reads list entry %i rather than folding it into an ask that reached nothing', async (_index, answer) => {
		const read = await listKeptTests(host(result(answer)));

		expect(read.outcome).not.toBe('unanswered');
	});

	it.each(
		fixture.set.map((answer, index) => [index, answer] as const),
	)('reads set entry %i rather than folding it into an ask that reached nothing', async (_index, answer) => {
		const read = await setKeptTests(host(result(answer)), PRESS);

		expect(read.outcome).not.toBe('unanswered');
	});

	// The mirror of the result schema drops nothing the panel reads and invents nothing it does not:
	// the same file the host's `.strict()` schema accepted parses here unchanged.
	it('reads the whole file through both mirrors', () => {
		expect(fixture.list.map((answer) => ListKeptTestsResultSchema.parse(answer))).toEqual(
			fixture.list,
		);
		expect(fixture.set.map((answer) => SetKeptTestsResultSchema.parse(answer))).toEqual(
			fixture.set,
		);
	});

	/*
	 * **The press the panel makes is the press the fixture pins**, and the daemon-side half parses
	 * that same object with the host's `.strict()` params schema. A field renamed on either side of
	 * the wire fails one of the two halves instead of turning every press into an `invalid_params`
	 * the mirror folds to *nothing came back*.
	 */
	it('sends the press the daemon-side half accepted, field for field', async () => {
		const call = host(result(fixture.set[0]));

		await setKeptTests(call, fixture.press);

		expect(call).toHaveBeenCalledWith('set_kept_tests', fixture.press);
	});
});
