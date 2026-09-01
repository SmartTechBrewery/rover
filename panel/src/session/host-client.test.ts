import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readArtifactText, rpc, signIn, signOut, whoAmI } from './host-client.js';

/**
 * The invariants this module exists to hold, rather than its plumbing: a credential never in a URL,
 * always in the header, never in a cookie — and a refusal that is a value a caller decides about
 * (`PROJECT.md` D20, D30).
 */

const fetchMock = vi.fn();

function answered(status: number, body: unknown): Response {
	return { status, json: async () => body } as unknown as Response;
}

/** The byte route answers a body rather than JSON, and its status is read before its `ok`. */
function served(status: number, text: string): Response {
	return {
		status,
		ok: status >= 200 && status < 300,
		text: async () => text,
	} as unknown as Response;
}

function lastRequest(): { url: string; init: RequestInit } {
	const call = fetchMock.mock.calls.at(-1) as [string, RequestInit];
	return { url: call[0], init: call[1] };
}

function headersOf(init: RequestInit): Record<string, string> {
	return (init.headers ?? {}) as Record<string, string>;
}

describe('the host client', () => {
	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal('fetch', fetchMock);
	});

	it('exchanges a token for a session over a relative URL, with the token in the body', async () => {
		fetchMock.mockResolvedValue(
			answered(200, { session: 'a-session-id', identifier: 'panel', displayName: 'Panel' }),
		);

		const answer = await signIn('the-printed-token');

		expect(answer).toEqual({
			ok: true,
			value: { session: 'a-session-id', identifier: 'panel', displayName: 'Panel' },
		});

		const { url, init } = lastRequest();
		expect(url).toBe('/session');
		expect(init.method).toBe('POST');
		expect(init.body).toBe(JSON.stringify({ token: 'the-printed-token' }));
		// The token is what is being exchanged, so it may not also be the thing that authenticates
		// the exchange — and a URL is the one place it may never be.
		expect(headersOf(init).authorization).toBeUndefined();
		expect(url).not.toContain('the-printed-token');
	});

	it('never puts a credential in a URL, and never lets the browser attach a cookie', async () => {
		fetchMock.mockResolvedValue(answered(200, { identifier: 'panel', displayName: 'Panel' }));

		await whoAmI('a-session-id');
		await rpc('a-session-id', 'list_devices', {});

		for (const call of fetchMock.mock.calls as [string, RequestInit][]) {
			expect(call[0].startsWith('/')).toBe(true);
			expect(call[0]).not.toContain('?');
			expect(call[0]).not.toContain('a-session-id');
			expect(call[1].credentials).toBe('omit');
			expect(headersOf(call[1]).authorization).toBe('Bearer a-session-id');
		}
	});

	it('reads the identity behind a session, and ends it with DELETE', async () => {
		fetchMock.mockResolvedValue(answered(200, { identifier: 'panel', displayName: 'Panel' }));
		expect(await whoAmI('a-session-id')).toEqual({
			ok: true,
			value: { identifier: 'panel', displayName: 'Panel' },
		});
		expect(lastRequest().init.method).toBe('GET');

		fetchMock.mockResolvedValue(answered(200, {}));
		expect(await signOut('a-session-id')).toEqual({ ok: true, value: null });
		expect(lastRequest().init.method).toBe('DELETE');
	});

	it('turns the host’s one refusal into a value rather than a throw', async () => {
		fetchMock.mockResolvedValue(
			answered(401, {
				type: 'error',
				protocolVersion: 1,
				id: null,
				error: { code: 'unauthenticated', message: 'Authentication failed.' },
			}),
		);

		expect(await signIn('a-token')).toEqual({ ok: false, refusal: 'refused' });
		expect(await whoAmI('a-session-id')).toEqual({ ok: false, refusal: 'refused' });
	});

	// A host that never answered has said nothing about the credential, so the two are separate:
	// the provider keeps a stored session over one of these and clears it over a refusal.
	it('separates a host that did not answer from one that refused', async () => {
		fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
		expect(await whoAmI('a-session-id')).toEqual({ ok: false, refusal: 'unanswered' });

		fetchMock.mockResolvedValue(answered(200, { identifier: 'panel' }));
		expect(await whoAmI('a-session-id')).toEqual({ ok: false, refusal: 'unanswered' });
	});

	// D29's "exactly two statuses — read the envelope": an error envelope arrives on a 200 and is
	// the surface's own vocabulary, not a refusal of the credential.
	it('hands back the envelope a dispatched method answered with, error or result', async () => {
		fetchMock.mockResolvedValue(
			answered(200, { type: 'result', protocolVersion: 1, id: '1', result: { devices: [] } }),
		);
		expect(await rpc('a-session-id', 'list_devices', {})).toEqual({
			ok: true,
			value: { type: 'result', result: { devices: [] } },
		});

		const { url, init } = lastRequest();
		expect(url).toBe('/rpc');
		expect(JSON.parse(String(init.body))).toMatchObject({
			protocolVersion: 1,
			method: 'list_devices',
			params: {},
		});

		fetchMock.mockResolvedValue(
			answered(200, {
				type: 'error',
				protocolVersion: 1,
				id: '2',
				error: { code: 'unknown_method', message: 'not served here' },
			}),
		);
		expect(await rpc('a-session-id', 'acquire_device', {})).toEqual({
			ok: true,
			value: { type: 'error', error: { code: 'unknown_method', message: 'not served here' } },
		});
	});
});

/**
 * The archive's byte route (#131, R37), and the three answers it gives about one file.
 *
 * What is in question here is the same thing as everywhere else on this surface — the credential is
 * a header and never a URL — plus the one thing that is this route's own: *missing* and *unreadable*
 * are **values**, in `list_archive`'s own words, so a file that is not there never reads as a
 * credential that was refused.
 */
describe('one archived file', () => {
	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal('fetch', fetchMock);
	});

	it('addresses the file by its components, with the session in the header', async () => {
		fetchMock.mockResolvedValue(served(200, '{"platform":"android"}'));

		const answer = await readArtifactText('a-session-id', ['checkout-app', 'device_info.json']);

		expect(answer).toEqual({
			ok: true,
			value: { outcome: 'read', text: '{"platform":"android"}' },
		});
		const { url, init } = lastRequest();
		expect(url).toBe('/artifact/checkout-app/device_info.json');
		expect(headersOf(init).authorization).toBe('Bearer a-session-id');
		expect(init.credentials).toBe('omit');
		expect(url).not.toContain('a-session-id');
	});

	/*
	 * A directory name may legally carry a space, a `#` or a `%`, and the route decodes per segment
	 * before re-validating — so a separator inside a component has to be encoded here rather than
	 * joined in raw, where it would silently become one component more.
	 */
	it('encodes each component on its own, so nothing inside one becomes a separator', async () => {
		fetchMock.mockResolvedValue(served(200, ''));

		await readArtifactText('a-session-id', ['a b#c', 'x/y']);

		expect(lastRequest().url).toBe('/artifact/a%20b%23c/x%2Fy');
	});

	it('reads a file that is not there as missing rather than as a refusal', async () => {
		fetchMock.mockResolvedValue(served(404, '{"outcome":"missing"}'));

		expect(await readArtifactText('a-session-id', ['gone.json'])).toEqual({
			ok: true,
			value: { outcome: 'missing' },
		});
	});

	// A `400` (an address no listing could have answered) and a `500` (something is filed there and
	// this host will not serve it) are one answer to the panel: it can say *that* and never why.
	it('reads every other answer the route gives as unreadable', async () => {
		for (const status of [400, 500]) {
			fetchMock.mockResolvedValue(served(status, '{"outcome":"unreadable"}'));

			expect(await readArtifactText('a-session-id', ['x.json'])).toEqual({
				ok: true,
				value: { outcome: 'unreadable' },
			});
		}
	});

	it('reads a refused session as a refusal, so the panel can bounce on it', async () => {
		fetchMock.mockResolvedValue(served(401, ''));

		expect(await readArtifactText('a-session-id', ['x.json'])).toEqual({
			ok: false,
			refusal: 'refused',
		});
	});

	it('reads a host that never answered, and a body that never arrived, as unanswered', async () => {
		fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
		expect(await readArtifactText('a-session-id', ['x.json'])).toEqual({
			ok: false,
			refusal: 'unanswered',
		});

		fetchMock.mockResolvedValue({
			status: 200,
			ok: true,
			text: async () => {
				throw new TypeError('network error');
			},
		} as unknown as Response);
		expect(await readArtifactText('a-session-id', ['x.json'])).toEqual({
			ok: false,
			refusal: 'unanswered',
		});
	});
});
