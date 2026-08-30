import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_LISTEN_ADDRESS,
	HOST_ADDRESS_ENV_VAR,
	HOST_CA_ENV_VAR,
	HOST_PORT_ENV_VAR,
	HOST_TOKEN_ENV_VAR,
	LISTEN_ADDRESS_ENV_VAR,
	LISTEN_PORT_ENV_VAR,
	resolveNetworkListener,
	resolveRemoteHost,
	TLS_CERT_ENV_VAR,
	TLS_KEY_ENV_VAR,
} from '@/daemon/network-config.js';
import { USERS_PATH_ENV_VAR } from '@/daemon/user-store.js';

/**
 * Both opt-ins, and the loud failure that replaces a half-configured one of either.
 *
 * Both resolvers take their environment as an argument, so these are ordinary pure assertions
 * over a plain object — no `vi.stubEnv`, and no chance of a leaked variable turning a later
 * suite into a network host or pointing it at one.
 *
 * The two halves are deliberately asymmetric since R28: the listener holds **no** secret and
 * names a user store, while `ROVER_HOST_TOKEN` is the client's own credential and nothing the
 * host reads. Several assertions below exist only to keep it that way.
 */

const TOKEN = 'a-thirty-two-character-token-1234';
const complete = {
	[LISTEN_PORT_ENV_VAR]: '4711',
	[TLS_CERT_ENV_VAR]: '/tmp/cert.pem',
	[TLS_KEY_ENV_VAR]: '/tmp/key.pem',
};

function resolve(overrides: Record<string, string | undefined>) {
	return resolveNetworkListener({ ...complete, ...overrides });
}

describe('the network listener is an opt-in', () => {
	it('resolves nothing when the port is unset, however much else is configured', () => {
		expect(resolve({ [LISTEN_PORT_ENV_VAR]: undefined })).toBeUndefined();
	});

	it('treats an exported-but-blank port as unset, like every other variable here', () => {
		expect(resolve({ [LISTEN_PORT_ENV_VAR]: '' })).toBeUndefined();
	});

	it('reads nothing else at all when the port is unset', () => {
		// The zero-config local-only path: a host with no certificate and no key is not a
		// misconfiguration, it is the default.
		expect(resolveNetworkListener({})).toBeUndefined();
	});

	it('resolves the whole configuration when the port is set, with no host token anywhere', () => {
		// The shape R28 leaves behind: a port, TLS material and the store to authenticate
		// against. There is no `token` field to configure and no shared secret to hold.
		expect(resolve({})).toEqual({
			address: DEFAULT_LISTEN_ADDRESS,
			port: 4711,
			certPath: '/tmp/cert.pem',
			keyPath: '/tmp/key.pem',
			usersPath: join(homedir(), '.rover', 'users.json'),
		});
	});

	it('follows ROVER_USERS_PATH, and never requires it — it always resolves', () => {
		expect(resolve({ [USERS_PATH_ENV_VAR]: '/tmp/rover-users.json' })?.usersPath).toBe(
			'/tmp/rover-users.json',
		);
		// A host with no users yet starts and refuses everyone. That is the correct state for
		// one, not a startup failure, so the store is never in the required-together set.
		expect(resolve({ [USERS_PATH_ENV_VAR]: '' })?.usersPath).toBe(
			join(homedir(), '.rover', 'users.json'),
		);
	});

	it('ignores ROVER_HOST_TOKEN entirely — the host half of it is gone (D25)', () => {
		// The assertion that forbids the parallel path: a shared secret set in the host's own
		// environment changes nothing about what this listener is, or what it will accept.
		expect(resolve({ [HOST_TOKEN_ENV_VAR]: TOKEN })).toEqual(resolve({}));
		expect(resolve({ [HOST_TOKEN_ENV_VAR]: 'far-too-short' })).toEqual(resolve({}));
		expect(JSON.stringify(resolve({ [HOST_TOKEN_ENV_VAR]: TOKEN }))).not.toContain(TOKEN);
	});

	it('defaults the address to every interface and honours an explicit one', () => {
		expect(resolve({})?.address).toBe('0.0.0.0');
		expect(resolve({ [LISTEN_ADDRESS_ENV_VAR]: '10.0.0.4' })?.address).toBe('10.0.0.4');
	});
});

describe('a port with no TLS material is a startup failure', () => {
	it.each([
		['the certificate', TLS_CERT_ENV_VAR],
		['the key', TLS_KEY_ENV_VAR],
	])('refuses to resolve when %s is missing', (_what, variable) => {
		expect(() => resolve({ [variable]: undefined })).toThrow(variable);
	});

	it('names every missing variable at once, and nothing that is no longer required', () => {
		// One error an operator can act on in one pass, rather than two restarts each naming
		// the next thing — and never sending them to set a host token that nothing reads.
		const missing = () => resolve({ [TLS_CERT_ENV_VAR]: undefined, [TLS_KEY_ENV_VAR]: undefined });

		expect(missing).toThrow(TLS_CERT_ENV_VAR);
		expect(missing).toThrow(TLS_KEY_ENV_VAR);
		expect(missing).toThrow(
			expect.objectContaining({ message: expect.not.stringContaining(HOST_TOKEN_ENV_VAR) }),
		);
	});
});

describe('a bad value names the variable and never quotes the value', () => {
	it.each([
		['not a number', 'not-a-number'],
		['zero', '0'],
		['past the port range', '65536'],
		['fractional', '80.5'],
	])('rejects a port that is %s, naming ROVER_LISTEN_PORT', (_what, port) => {
		expect(() => resolve({ [LISTEN_PORT_ENV_VAR]: port })).toThrow(LISTEN_PORT_ENV_VAR);
	});
});

const remote = {
	[HOST_ADDRESS_ENV_VAR]: '10.0.0.4',
	[HOST_PORT_ENV_VAR]: '4711',
	[HOST_TOKEN_ENV_VAR]: TOKEN,
};

function resolveClient(overrides: Record<string, string | undefined>) {
	return resolveRemoteHost({ ...remote, ...overrides });
}

describe('the remote host is an opt-in too', () => {
	it('resolves nothing when the address is unset, however much else is configured', () => {
		expect(resolveClient({ [HOST_ADDRESS_ENV_VAR]: undefined })).toBeUndefined();
	});

	it('treats an exported-but-blank address as unset, like every other variable here', () => {
		expect(resolveClient({ [HOST_ADDRESS_ENV_VAR]: '' })).toBeUndefined();
	});

	it('reads nothing else at all when the address is unset', () => {
		// The zero-config local-only client: no token, no port, no certificate is not a
		// misconfiguration, it is the default.
		expect(resolveRemoteHost({})).toBeUndefined();
	});

	it('resolves the whole configuration when the address is set', () => {
		expect(resolveClient({ [HOST_CA_ENV_VAR]: '/tmp/ca.pem' })).toEqual({
			address: '10.0.0.4',
			port: 4711,
			token: TOKEN,
			caPath: '/tmp/ca.pem',
		});
	});

	it('leaves the certificate optional — unset means the system trust store', () => {
		expect(resolveClient({})?.caPath).toBeUndefined();
	});

	it('reads the token the host issued it, which the host itself no longer reads (D25)', () => {
		expect(resolveClient({})?.token).toBe(TOKEN);
		// Same variable, one direction only: this is the credential `rover users add` printed
		// on the other machine, not half of a secret both machines hold.
		expect(resolve({ [HOST_TOKEN_ENV_VAR]: TOKEN })).not.toHaveProperty('token');
	});
});

describe('an address with half a configuration is a caller failure', () => {
	it.each([
		['the port', HOST_PORT_ENV_VAR],
		['the token', HOST_TOKEN_ENV_VAR],
	])('refuses to resolve when %s is missing', (_what, variable) => {
		expect(() => resolveClient({ [variable]: undefined })).toThrow(variable);
	});

	it('names every missing variable at once, not just the first', () => {
		const missing = () =>
			resolveClient({ [HOST_PORT_ENV_VAR]: undefined, [HOST_TOKEN_ENV_VAR]: undefined });

		expect(missing).toThrow(HOST_PORT_ENV_VAR);
		expect(missing).toThrow(HOST_TOKEN_ENV_VAR);
	});

	it.each([
		['not a number', 'not-a-number'],
		['zero', '0'],
		['past the port range', '65536'],
	])('rejects a port that is %s, naming ROVER_HOST_PORT', (_what, port) => {
		// The client's own variable, not the host's: an operator sent to edit ROVER_LISTEN_PORT
		// for a client-side mistake would be editing the wrong machine.
		const rejection = () => resolveClient({ [HOST_PORT_ENV_VAR]: port });

		expect(rejection).toThrow(HOST_PORT_ENV_VAR);
		expect(rejection).not.toThrow(LISTEN_PORT_ENV_VAR);
	});

	it('rejects a token under the minimum length, naming the variable', () => {
		// The floor is a **local** guard now: a truncated paste fails on the borrowing machine,
		// naming what to fix, rather than travelling and coming back as an opaque refusal.
		expect(() => resolveClient({ [HOST_TOKEN_ENV_VAR]: 'too-short' })).toThrow(HOST_TOKEN_ENV_VAR);
	});

	it('does not put the rejected token in the message (D20)', () => {
		// The assertion this file exists for. A schema whose failure interpolates the value it
		// rejected is exactly how a secret reaches a log, a terminal and a support thread — so
		// the rule that says so lives on the schema, and this is what holds it there.
		const secret = 'short-but-secret';

		expect(() => resolveClient({ [HOST_TOKEN_ENV_VAR]: secret })).toThrow(
			expect.objectContaining({ message: expect.not.stringContaining(secret) }),
		);
	});
});
