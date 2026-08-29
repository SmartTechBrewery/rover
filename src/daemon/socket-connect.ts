/**
 * The one place a raw connection attempt against a unix socket path is wired up.
 *
 * `connect.ts`, `listen.ts` and the test helpers each need to attempt a connection and
 * find out, without throwing, whether it succeeded, failed, or (only for the stale-socket
 * probe) timed out — and each has to swallow a second, later `'error'` a discarded socket
 * can raise out of `destroy()`, or that reaches Node as an unhandled error and crashes the
 * process. Three independent copies of that wiring is exactly the kind of duplication
 * that drifts: fix it once here.
 */

import { createConnection, type Socket } from 'node:net';

export interface ConnectAttemptConnected {
	readonly outcome: 'connected';
	readonly socket: Socket;
}

export interface ConnectAttemptError {
	readonly outcome: 'error';
	readonly error: NodeJS.ErrnoException;
}

export interface ConnectAttemptTimedOut {
	readonly outcome: 'timeout';
}

export type ConnectAttempt = ConnectAttemptConnected | ConnectAttemptError;
export type ConnectAttemptWithTimeout = ConnectAttempt | ConnectAttemptTimedOut;

/** Attempt a connection with no deadline: it can only connect or fail. */
export function attemptConnect(socketPath: string): Promise<ConnectAttempt>;
/** Attempt a connection, giving up and reporting `'timeout'` after `timeoutMs`. */
export function attemptConnect(
	socketPath: string,
	timeoutMs: number,
): Promise<ConnectAttemptWithTimeout>;
export function attemptConnect(
	socketPath: string,
	timeoutMs?: number,
): Promise<ConnectAttemptWithTimeout> {
	return new Promise((resolve) => {
		const socket = createConnection(socketPath);
		let settled = false;

		const settle = (attempt: ConnectAttemptWithTimeout) => {
			if (settled) {
				return;
			}
			settled = true;
			if (attempt.outcome !== 'connected') {
				socket.destroy();
			}
			resolve(attempt);
		};

		if (timeoutMs !== undefined) {
			socket.setTimeout(timeoutMs, () => settle({ outcome: 'timeout' }));
		}
		socket.once('connect', () => settle({ outcome: 'connected', socket }));
		// `on`, not `once`: a socket this function is discarding (the error and timeout branches
		// both `destroy()` it) can raise a second, later error, and an `'error'` event with no
		// listener is what turns a probe into a crashed process.
		socket.on('error', (error: NodeJS.ErrnoException) => settle({ outcome: 'error', error }));
	});
}
