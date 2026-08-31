import type { HostAnswer, RpcEnvelope } from '@panel/session/host-client.js';
import { describe, expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/panel/force-release.json';
import { ForceReleaseDeviceResultSchema, forceReleaseDevice } from './force-release.js';

/**
 * The panel's half of `force_release_device`: what goes on the wire, and every way one ask can come
 * back.
 *
 * The four answers are not four flavours of one — they are what the screen has to tell apart
 * (`docs/DESIGN.md` §7, §8). The one this file exists for above all is the last: a request that
 * reached nothing released nothing, and it must never narrow to anything that reads as an ending.
 */

const LEASE = {
	serial: 'emulator-5554',
	owner: 'issue-113',
	project: 'rover',
	testName: 'the devices grid',
	grantedAt: '2026-08-31T18:48:48.247Z',
	expiresInMs: 1_186_759,
};

/** A host that answers one envelope, and records what it was asked. */
function host(answer: HostAnswer<RpcEnvelope>) {
	return vi.fn(async () => answer);
}

function result(value: unknown): HostAnswer<RpcEnvelope> {
	return { ok: true, value: { type: 'result', result: value } };
}

describe('the ask', () => {
	it('names the method, the serial and the actor — and no lease id', async () => {
		const call = host(result({ outcome: 'released', heldBy: LEASE }));

		await forceReleaseDevice(call, { serial: 'emulator-5554', actor: 'karolina' });

		expect(call).toHaveBeenCalledTimes(1);
		expect(call).toHaveBeenCalledWith('force_release_device', {
			serial: 'emulator-5554',
			actor: 'karolina',
		});
		/*
		 * The absence is the method (D20, D28): force-releasing ends a lease this caller never held,
		 * so there is no credential to present and no listing has to disclose one for the panel to
		 * be able to act.
		 */
		expect(JSON.stringify(call.mock.calls[0])).not.toContain('leaseId');
	});
});

describe('the host answered', () => {
	it('reads a lease that ended, with the holder the host named', async () => {
		const answer = await forceReleaseDevice(host(result({ outcome: 'released', heldBy: LEASE })), {
			serial: 'emulator-5554',
			actor: 'karolina',
		});

		expect(answer).toEqual({ outcome: 'released', heldBy: LEASE });
	});

	// Three reasons rather than one, because they are three different next moves for an operator.
	it.each([
		['not-held'],
		['gone'],
		['not-attached'],
	])('keeps the refusal reason %s as itself', async (reason) => {
		const answer = await forceReleaseDevice(
			host(result({ outcome: 'refused', reason, message: 'Nothing to release.' })),
			{ serial: 'emulator-5554', actor: 'karolina' },
		);

		expect(answer).toEqual({ outcome: 'refused', reason });
	});

	/*
	 * The mirror is not `.strict()`, for `device-list.ts`'s reason: a newer daemon adding a field
	 * must not cost the operator the answer to "did that lease end". The extra field is dropped, and
	 * the outcome survives.
	 */
	it('tolerates a field this panel has never heard of', async () => {
		const answer = await forceReleaseDevice(
			host(
				result({ outcome: 'released', heldBy: { ...LEASE, restoredIn: 'a-while' }, note: 'hi' }),
			),
			{ serial: 'emulator-5554', actor: 'karolina' },
		);

		expect(answer).toEqual({ outcome: 'released', heldBy: LEASE });
	});
});

/**
 * Every way an ask can produce no answer, and the one rule they all obey: **nothing was released,
 * so nothing may read as an ending** (§8).
 */
describe('nothing usable came back', () => {
	it('reports the host that answered nothing at all', async () => {
		const answer = await forceReleaseDevice(host({ ok: false, refusal: 'unanswered' }), {
			serial: 'emulator-5554',
			actor: 'karolina',
		});

		expect(answer).toEqual({ outcome: 'unanswered' });
	});

	// An `error` envelope is a `200` with something to read, and what it says is that no lease
	// ended. Its code is the host's vocabulary and is not this screen's news.
	it('folds an error envelope in with it', async () => {
		const answer = await forceReleaseDevice(
			host({
				ok: true,
				value: { type: 'error', error: { code: 'invalid_params', message: 'nope' } },
			}),
			{ serial: 'emulator-5554', actor: 'karolina' },
		);

		expect(answer).toEqual({ outcome: 'unanswered' });
	});

	it.each([
		['a result of another shape', { released: true }],
		['an outcome this panel does not know', { outcome: 'restored' }],
		['a refusal reason this panel does not know', { outcome: 'refused', reason: 'busy' }],
		['a released answer with no holder', { outcome: 'released' }],
	])('folds %s in with it', async (_case, value) => {
		const answer = await forceReleaseDevice(host(result(value)), {
			serial: 'emulator-5554',
			actor: 'karolina',
		});

		expect(answer).toEqual({ outcome: 'unanswered' });
	});

	/*
	 * The exception that is not an outcome either. `Session.call` has already fired the bounce to
	 * *access ended* and the router is coming down, so this answer exists to keep the control
	 * silent — the poll leaves the same silence for the same reason.
	 */
	it('keeps a refused session apart from a host that said nothing', async () => {
		const answer = await forceReleaseDevice(host({ ok: false, refusal: 'refused' }), {
			serial: 'emulator-5554',
			actor: 'karolina',
		});

		expect(answer).toEqual({ outcome: 'access-ended' });
	});
});

describe('the mirror of the result schema', () => {
	// The host sends one, and the panel says each outcome in its own words instead (§7).
	it('does not carry the host’s message into the panel', () => {
		const parsed = ForceReleaseDeviceResultSchema.parse({
			outcome: 'refused',
			reason: 'not-held',
			message: "Device 'emulator-5554' is not held by anybody.",
		});

		expect(parsed).toEqual({ outcome: 'refused', reason: 'not-held' });
	});

	// Like every other disclosure: never the id (D20). The projection is the listing's own.
	it('drops a lease id even if one ever appeared on the wire', () => {
		const parsed = ForceReleaseDeviceResultSchema.parse({
			outcome: 'released',
			heldBy: { ...LEASE, leaseId: 'lease-01JQ' },
		});

		expect(JSON.stringify(parsed)).not.toContain('lease-01JQ');
	});
});

/**
 * The panel's half of the drift gate `tests/unit/panel/force-release-fixture.test.ts` opens, and
 * `device-list.test.ts`'s reasoning applies verbatim: one file, parsed here by the mirror and there
 * by the daemon's own schema, by two projects that cannot import each other.
 *
 * The literals everywhere above this block are the panel's own, so on their own they pin the panel
 * against itself. This block is what ties them to `src/ipc/methods.ts` — and it matters more here
 * than on the listing, because a reason renamed on the host narrows to `unanswered` rather than
 * failing, which would turn every refusal in the browser into *"Nothing came back from the host"*
 * with both suites still green.
 */
describe("the panel's mirror of force_release_device", () => {
	it('reads a real released answer, down to the holder the line names', () => {
		const parsed = ForceReleaseDeviceResultSchema.parse(fixture[0]);

		expect(parsed).toEqual({
			outcome: 'released',
			heldBy: {
				serial: 'emulator-5554',
				owner: 'issue-113',
				project: 'rover',
				testName: 'the devices grid',
				grantedAt: '2026-08-31T18:48:48.247Z',
				expiresInMs: 1186759,
			},
		});
	});

	/*
	 * Each refusal by name, off the fixture rather than off a literal written here: a reason the
	 * host renames fails this assertion instead of quietly folding into `unanswered`. And the
	 * host's `message` is dropped on every one of them — the panel says each outcome in its own
	 * words (§7), so a host string reaching a screen would be a second vocabulary.
	 */
	it('reads every refusal the host can send, and none of its wording', () => {
		const refusals = fixture.slice(1).map((answer) => ForceReleaseDeviceResultSchema.parse(answer));

		expect(refusals).toEqual([
			{ outcome: 'refused', reason: 'not-held' },
			{ outcome: 'refused', reason: 'gone' },
			{ outcome: 'refused', reason: 'not-attached' },
		]);
	});

	/*
	 * The whole file through the mirror, which is what proves nothing in it narrows to `unanswered`
	 * — the answer the panel gives when it cannot read a reply, and the one a silent drift would
	 * turn every refusal into.
	 */
	it.each(
		fixture.map((answer, index) => [index, answer] as const),
	)('reads entry %i rather than folding it into an ask that reached nothing', async (_index, answer) => {
		const read = await forceReleaseDevice(host(result(answer)), {
			serial: 'emulator-5554',
			actor: 'karolina',
		});

		expect(read.outcome).not.toBe('unanswered');
	});
});
