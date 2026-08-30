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

/**
 * Both opt-ins, and the loud failure that replaces a half-configured one of either.
 *
 * Both resolvers take their environment as an argument, so these are ordinary pure assertions
 * over a plain object — no `vi.stubEnv`, and no chance of a leaked variable turning a later
 * suite into a network host or pointing it at one.
 */

const TOKEN = 'a-thirty-two-character-token-1234';
const complete = {
	[LISTEN_PORT_ENV_VAR]: '4711',
	[HOST_TOKEN_ENV_VAR]: TOKEN,
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
		// The zero-config local-only path: a host with no token, no certificate and no key is
		// not a misconfiguration, it is the default.
		expect(resolveNetworkListener({})).toBeUndefined();
	});

	it('resolves the whole configuration when the port is set', () => {
		expect(resolve({})).toEqual({
			address: DEFAULT_LISTEN_ADDRESS,
			port: 4711,
			token: TOKEN,
			certPath: '/tmp/cert.pem',
			keyPath: '/tmp/key.pem',
		});
	});

	it('defaults the address to every interface and honours an explicit one', () => {
		expect(resolve({})?.address).toBe('0.0.0.0');
		expect(resolve({ [LISTEN_ADDRESS_ENV_VAR]: '10.0.0.4' })?.address).toBe('10.0.0.4');
	});
});

describe('a port with no token is a startup failure', () => {
	it.each([
		['the token', HOST_TOKEN_ENV_VAR],
		['the certificate', TLS_CERT_ENV_VAR],
		['the key', TLS_KEY_ENV_VAR],
	])('refuses to resolve when %s is missing', (_what, variable) => {
		expect(() => resolve({ [variable]: undefined })).toThrow(variable);
	});

	it('names every missing variable at once, not just the first', () => {
		// One error an operator can act on in one pass, rather than three restarts each
		// naming the next thing.
		const missing = () =>
			resolve({
				[HOST_TOKEN_ENV_VAR]: undefined,
				[TLS_CERT_ENV_VAR]: undefined,
				[TLS_KEY_ENV_VAR]: undefined,
			});

		expect(missing).toThrow(HOST_TOKEN_ENV_VAR);
		expect(missing).toThrow(TLS_CERT_ENV_VAR);
		expect(missing).toThrow(TLS_KEY_ENV_VAR);
	});

	it('never resolves a listener with no token, whatever the port says', () => {
		expect(() => resolve({ [HOST_TOKEN_ENV_VAR]: '' })).toThrow();
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

	it('rejects a token under the minimum length', () => {
		expect(() => resolve({ [HOST_TOKEN_ENV_VAR]: 'too-short' })).toThrow(HOST_TOKEN_ENV_VAR);
	});

	it('does not put the rejected token in the message (D20)', () => {
		// The assertion this file exists for. A schema whose failure interpolates the value it
		// rejected is exactly how a secret reaches a log, a terminal and a support thread — so
		// the rule that says so lives on the schema, and this is what holds it there.
		const secret = 'short-but-secret';

		expect(() => resolve({ [HOST_TOKEN_ENV_VAR]: secret })).toThrow(
			expect.objectContaining({ message: expect.not.stringContaining(secret) }),
		);
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

	it('reads the same token variable the host does, so one machine holds one secret', () => {
		expect(resolveClient({})?.token).toBe(TOKEN);
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

	it('does not put the rejected token in the message (D20)', () => {
		// The same rule as the listener schema, held on the client side: a client's token is
		// exactly as much of a secret as a host's.
		const secret = 'short-but-secret';

		expect(() => resolveClient({ [HOST_TOKEN_ENV_VAR]: secret })).toThrow(
			expect.objectContaining({ message: expect.not.stringContaining(secret) }),
		);
	});
});
