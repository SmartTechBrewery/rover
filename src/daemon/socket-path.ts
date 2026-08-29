/**
 * Where the local daemon listens.
 *
 * This is a host-level setting, so the Zod schema is the source of truth for what a valid
 * value is (ai/RULES.md §7) rather than a hand-rolled check in the one caller that
 * happened to think of it.
 *
 * The path is the **only** filesystem-shaped thing in the daemon's addressing, and it
 * never crosses the wire: a client on another machine shares no filesystem with the host
 * (D17), so a socket path is meaningful to the local transport and to nothing else.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { describeIssues } from '../ipc/protocol.js';

/** Environment variable naming the socket, for tests and for a non-default install. */
export const SOCKET_PATH_ENV_VAR = 'ROVER_SOCKET_PATH';

/**
 * A unix socket address is a fixed-size struct, and the path lives inside it: 104 bytes
 * on macOS, 108 on Linux, NUL included. Going over does not fail cleanly — the address is
 * silently truncated, or `bind` returns `EINVAL`, and either way the error names neither
 * the length nor the path. 103 is the smaller platform's usable budget, so a path that
 * passes here binds everywhere.
 */
export const MAX_SOCKET_PATH_BYTES = 103;

export const SocketPathSchema = z
	.string()
	.min(1, 'The socket path must not be empty')
	.refine(
		(value) => Buffer.byteLength(value, 'utf8') <= MAX_SOCKET_PATH_BYTES,
		(value) => ({
			message:
				`Socket path is ${Buffer.byteLength(value, 'utf8')} bytes, over the ` +
				`${MAX_SOCKET_PATH_BYTES}-byte limit a unix socket address can hold: ${value}`,
		}),
	);
export type SocketPath = z.infer<typeof SocketPathSchema>;

/** `~/.rover/rover.sock` — the zero-config path both halves derive independently. */
export function defaultSocketPath(): string {
	return join(homedir(), '.rover', 'rover.sock');
}

/**
 * The one place a socket path is checked against {@link SocketPathSchema}, so a path
 * supplied directly to `connectToLocalDaemon`/`startDaemon` (bypassing `resolveSocketPath`,
 * e.g. from a future CLI flag) gets the same over-the-address-limit diagnosis as the
 * default path does, instead of a bare `EINVAL` at `bind`.
 */
export function assertValidSocketPath(candidate: string): string {
	const parsed = SocketPathSchema.safeParse(candidate);
	if (!parsed.success) {
		throw new Error(describeIssues(parsed.error));
	}
	return parsed.data;
}

/**
 * Resolve the socket the daemon binds and a local client connects to.
 *
 * An empty value counts as unset, matching Swarm's `optionalEnv`: an exported-but-blank
 * variable is what a shell leaves behind, and treating it as a real setting would send
 * the daemon at the current directory.
 */
export function resolveSocketPath(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env[SOCKET_PATH_ENV_VAR];
	const candidate =
		configured === undefined || configured === '' ? defaultSocketPath() : configured;
	return assertValidSocketPath(candidate);
}
