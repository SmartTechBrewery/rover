/**
 * The remote client half: connect to a host over TCP+TLS, present the token, and hand the
 * socket to the same `createIpcClient` the local socket uses.
 *
 * **This is the second half of one transport, not a second client** (D17). Everything above
 * the stream — the framing, the id correlation, the method table, the result schemas — is
 * `src/ipc/`'s and is shared by construction with `./connect.ts`; what lives here is
 * getting a verified, authenticated stream to hand it.
 *
 * **This module starts nothing, and that is the point** (D5). There is no
 * `child_process` import here and there never may be one: autostart lives in
 * `./connect.ts`, on the unix-socket path, because a host reachable over a network is a
 * service its operator runs. So an unreachable host is a *loud failure naming the address,
 * the port and the error code* — never a hang, never an empty device list, and never a
 * process quietly started on somebody else's machine's behalf.
 * `tests/unit/daemon/remote-never-spawns.test.ts` holds that line as an executable gate.
 *
 * **Verification is never turned off.** `rejectUnauthorized` stays at its default, and a
 * host with a self-signed certificate — the ordinary case for a private deployment — is
 * trusted by naming that certificate in `ROVER_HOST_CA`. A flag that skipped the check
 * would make every one of these connections a stranger's for the price of one environment
 * variable.
 */

import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { connect, type TLSSocket } from 'node:tls';
import { createIpcClient, type IpcClient } from '../ipc/client.js';
import { encodeFrame } from '../ipc/framing.js';
import { IpcRequestError } from '../ipc/protocol.js';
import {
	HOST_ADDRESS_ENV_VAR,
	HOST_CA_ENV_VAR,
	HOST_PORT_ENV_VAR,
	HOST_TOKEN_ENV_VAR,
	type RemoteHostConfig,
} from './network-config.js';

/**
 * The error codes whose diagnosis is "this client does not trust that certificate", and for
 * which the actionable next step is {@link HOST_CA_ENV_VAR} rather than anything about the
 * network. Anything not listed still names its own code — the list only decides whether the
 * certificate sentence is appended.
 */
const CERTIFICATE_ERROR_CODES = new Set([
	'CERT_HAS_EXPIRED',
	'DEPTH_ZERO_SELF_SIGNED_CERT',
	'ERR_TLS_CERT_ALTNAME_INVALID',
	'SELF_SIGNED_CERT_IN_CHAIN',
	'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

/**
 * Connect to the remote host `config` names, authenticate, and return a client for it.
 *
 * Three failures, and they are deliberately three different messages, because they call for
 * three different next moves: the host could not be reached, the host rejected the token, or
 * the host answered something this client cannot use.
 */
export async function connectToNetworkHost(config: RemoteHostConfig): Promise<IpcClient> {
	// Before the connection, so a mistyped path is reported as a mistyped path rather than as
	// a TLS mystery mid-handshake — the same order `startNetworkListener` reads its own PEM in.
	const ca =
		config.caPath === undefined ? undefined : [await readCertificateAuthority(config.caPath)];
	const socket = await secureConnect(config, ca);

	// The greeting is **one-way**: the host answers nothing on success, consumes the line and
	// attaches the IPC surface behind it. So there is no handshake to await here, and the
	// probe below is what turns a refusal into an error rather than a silence.
	socket.write(encodeFrame({ token: config.token }));
	const client = createIpcClient(socket);

	try {
		await client.request('status', {});
	} catch (error) {
		await client.close();
		throw greetingRefused(error, config);
	}
	return client;
}

/**
 * `status` is the probe because it is the cheapest method that takes no lease, touches no
 * device and is answered by every host — and because a rejected token surfaces as this first
 * in-flight request being failed by the host's `id: null` refusal, which `createIpcClient`
 * already turns into `unauthenticated` on everything pending. No timer, no waiting to see
 * whether a refusal arrives, and no second frame shape for a client to learn.
 */
function greetingRefused(error: unknown, config: RemoteHostConfig): Error {
	if (error instanceof IpcRequestError && error.code === 'unauthenticated') {
		return new Error(
			`The Rover host at ${hostAndPort(config)} rejected ${HOST_TOKEN_ENV_VAR}. The host and ` +
				`this client have to hold the same secret; set the host's own ${HOST_TOKEN_ENV_VAR} ` +
				`here. The value itself is never printed.`,
		);
	}
	return new Error(
		`The Rover host at ${hostAndPort(config)} accepted the connection but did not answer ` +
			`'status': ${error instanceof Error ? error.message : String(error)}`,
	);
}

/**
 * One TLS connection attempt, resolving on `'secureConnect'` — the handshake **and** the
 * certificate check, not merely a TCP connection — and rejecting on the error before it.
 */
function secureConnect(config: RemoteHostConfig, ca: Buffer[] | undefined): Promise<TLSSocket> {
	return new Promise((resolve, reject) => {
		const socket = connect({
			host: config.address,
			port: config.port,
			ca,
			// SNI, but only for a name. Node **throws** `ERR_INVALID_ARG_VALUE` when `servername`
			// is an IP address (RFC 6066 does not permit one), so passing the address
			// unconditionally would make `ROVER_HOST_ADDRESS=10.0.0.4` — the ordinary way to
			// name a host on a private network — fail before a packet was sent. Left out, Node
			// verifies the certificate against `host` regardless, which is the check that matters.
			...(isIP(config.address) === 0 ? { servername: config.address } : {}),
		});

		const onError = (error: NodeJS.ErrnoException) => {
			socket.removeListener('secureConnect', onSecureConnect);
			socket.destroy();
			reject(unreachable(error, config));
		};
		const onSecureConnect = () => {
			socket.removeListener('error', onError);
			// Past the handshake, an error on this socket is one connection failing, and
			// `createIpcClient` is about to listen for it — it fails everything in flight with
			// `connection_closed` rather than leaving a caller waiting on a reply that cannot come.
			resolve(socket);
		};

		socket.once('error', onError);
		socket.once('secureConnect', onSecureConnect);
	});
}

/**
 * A pre-connect failure, named so the operator knows which of the three things is wrong: the
 * host, the network, or what this client trusts.
 *
 * The address, the port and the code are all in the message because together they *are* the
 * diagnosis — `ECONNREFUSED` on the port you meant and `ECONNREFUSED` on the port you
 * mistyped read identically without them.
 */
function unreachable(error: NodeJS.ErrnoException, config: RemoteHostConfig): Error {
	const code = error.code ?? 'unknown error';
	return new Error(
		`Cannot reach the Rover host at ${hostAndPort(config)}: ${code} — ${error.message}.` +
			nextStepFor(code),
	);
}

function nextStepFor(code: string): string {
	if (code === 'ECONNREFUSED') {
		// D5, spelled out: the local daemon starts itself and this one never will, so "nothing
		// answered" is the end of the story here rather than the beginning of an autostart.
		return (
			` Nothing is listening there. A remote host is a service its operator starts — it is ` +
			`never started from a client — so check that the daemon is running with ` +
			`ROVER_LISTEN_PORT set, and that ${HOST_ADDRESS_ENV_VAR} and ${HOST_PORT_ENV_VAR} name it.`
		);
	}
	if (CERTIFICATE_ERROR_CODES.has(code)) {
		return (
			` This client does not trust the host's certificate. Name the certificate to trust in ` +
			`${HOST_CA_ENV_VAR}; verification is never turned off.`
		);
	}
	return '';
}

async function readCertificateAuthority(caPath: string): Promise<Buffer> {
	try {
		return await readFile(caPath);
	} catch (error) {
		throw new Error(
			`Cannot read the certificate at '${caPath}' named by ${HOST_CA_ENV_VAR}: ` +
				(error instanceof Error ? error.message : String(error)),
		);
	}
}

function hostAndPort(config: RemoteHostConfig): string {
	return `${config.address}:${config.port}`;
}
