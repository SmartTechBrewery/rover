/**
 * A throwaway certificate and the raw TLS clients the network-listener suite drives the host
 * with.
 *
 * The daemon suite's real-socket exception applies here too (ai/TESTING.md): a token gate on
 * a real TLS socket cannot be asserted against a mock, for the same reason the bind race
 * cannot. So the certificate is real, generated per test into a `mkdtemp` directory that is
 * removed again, and the listener always binds `127.0.0.1:0`.
 *
 * **There is no client module yet** — `connectToNetworkHost` is phase 2 of R22. That is the
 * point of driving the host with `tls.connect` here: it proves the second transport serves
 * the same surface without a second client implementation existing to prove it with.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, type TLSSocket } from 'node:tls';
import { promisify } from 'node:util';
import { createIpcClient, type IpcClient } from '@/ipc/client.js';
import { encodeFrame } from '@/ipc/framing.js';

const run = promisify(execFile);

/** A host token that satisfies `MIN_HOST_TOKEN_LENGTH` without being a secret anywhere real. */
export const TEST_HOST_TOKEN = 'test-host-token-0123456789abcdefghij';

export interface TestCertificate {
	/** The temp directory holding both files. Removed by {@link removeTestCertificate}. */
	readonly dir: string;
	readonly certPath: string;
	readonly keyPath: string;
	/** The certificate itself, for a client that has to trust it as its own CA. */
	readonly certPem: string;
}

/**
 * A self-signed certificate for `localhost`/`127.0.0.1`, valid for one day.
 *
 * One day on purpose: a fixture certificate that cannot expire in a drawer is a fixture
 * nobody ever has to think about again.
 */
export async function createTestCertificate(): Promise<TestCertificate> {
	const dir = await mkdtemp(join(tmpdir(), 'rover-tls-'));
	const certPath = join(dir, 'cert.pem');
	const keyPath = join(dir, 'key.pem');

	try {
		await run('openssl', [
			'req',
			'-x509',
			'-newkey',
			'rsa:2048',
			'-nodes',
			'-days',
			'1',
			'-keyout',
			keyPath,
			'-out',
			certPath,
			'-subj',
			'/CN=localhost',
			'-addext',
			'subjectAltName=DNS:localhost,IP:127.0.0.1',
		]);
	} catch (error) {
		// Named explicitly so a machine without the tool reads as a missing tool rather than
		// as a TLS mystery three assertions later.
		throw new Error(
			`Could not generate a test certificate with 'openssl': ` +
				(error instanceof Error ? error.message : String(error)),
		);
	}

	return { dir, certPath, keyPath, certPem: await readFile(certPath, 'utf8') };
}

export async function removeTestCertificate(certificate: TestCertificate): Promise<void> {
	await rm(certificate.dir, { recursive: true, force: true });
}

/** A TLS socket to the host, trusting the fixture certificate and nothing else. */
export function rawTlsConnect(port: number, certPem: string): Promise<TLSSocket> {
	return new Promise((resolve, reject) => {
		const socket = connect(
			{ port, host: '127.0.0.1', ca: [certPem], servername: 'localhost' },
			() => {
				socket.removeListener('error', reject);
				resolve(socket);
			},
		);
		socket.once('error', reject);
	});
}

/** The greeting frame, exactly as a client sends it: one NDJSON line, then requests. */
export function greetingFor(token: string): string {
	return encodeFrame({ token });
}

/**
 * Greet the host with `token` and wrap the socket in the ordinary IPC client.
 *
 * The greeting is **one-way**: the host answers nothing on success, so there is no handshake
 * to await here. A bad token is discovered by the first request failing `unauthenticated`,
 * which is what keeps this out of "wait and see if a refusal arrives" territory.
 */
export async function connectWithToken(
	port: number,
	token: string,
	certPem: string,
): Promise<IpcClient> {
	const socket = await rawTlsConnect(port, certPem);
	socket.write(greetingFor(token));
	return createIpcClient(socket);
}

/**
 * Every byte the host wrote before it closed the connection.
 *
 * Used both to assert that a refusal is byte-identical whatever it was refusing, and to
 * assert that no refusal ever carries a serial, a count or a token.
 */
export function readUntilClosed(socket: TLSSocket): Promise<string> {
	return new Promise((resolve) => {
		let received = '';
		socket.setEncoding('utf8');
		socket.on('data', (chunk: string) => {
			received += chunk;
		});
		// Swallowed, not rejected: the host refuses by writing its frame and destroying the
		// connection, so an `ECONNRESET` here is the refusal working, not the test failing.
		// `'close'` follows either way and is what settles this.
		socket.on('error', () => {});
		socket.on('close', () => resolve(received));
	});
}
