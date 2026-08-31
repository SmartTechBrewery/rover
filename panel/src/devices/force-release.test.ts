import type { HostAnswer, RpcEnvelope } from '@panel/session/host-client.js';
import { describe, expect, it, vi } from 'vitest';
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
