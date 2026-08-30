/**
 * Whether this host also listens on the network, and with what.
 *
 * The listener is an **opt-in** (D17, D20): `ROVER_LISTEN_PORT` is the switch, and with it
 * unset nothing here reads, validates or requires anything else — the zero-config local
 * socket keeps working with no token and no certificate. Set it, and the token and the TLS
 * material become required *together*, because a port with no token is a listener that lets
 * strangers in. That failure is loud at startup and names every variable still missing,
 * rather than half-configuring a host.
 *
 * **These are environment variables, not project config.** `ai/RULES.md` §7 splits the two:
 * the per-project file carries project hooks, the environment carries host-level settings. A
 * network listener and its shared secret are host-level, and a token in a file the repository
 * tracks is the accident this placement exists to prevent.
 *
 * Zod is the source of truth for what a valid value is, as it is for the socket path.
 */

import { z } from 'zod';
import { describeIssues } from '../ipc/protocol.js';

/** The opt-in switch. Unset or empty ⇒ no network listener at all. */
export const LISTEN_PORT_ENV_VAR = 'ROVER_LISTEN_PORT';
/** Which interface to bind, so an operator can narrow the listener to a VPN interface. */
export const LISTEN_ADDRESS_ENV_VAR = 'ROVER_LISTEN_ADDRESS';
/** The shared secret every network caller presents. Deliberately the same name a client reads. */
export const HOST_TOKEN_ENV_VAR = 'ROVER_HOST_TOKEN';
export const TLS_CERT_ENV_VAR = 'ROVER_TLS_CERT';
export const TLS_KEY_ENV_VAR = 'ROVER_TLS_KEY';

/**
 * The floor on a host token. It is a bearer secret on an open port, so the only thing that
 * makes guessing hopeless is length; 32 characters is the shortest value that stays out of
 * reach of an attacker who can try as fast as the network allows.
 */
export const MIN_HOST_TOKEN_LENGTH = 32;

/** Every interface. Narrowed with {@link LISTEN_ADDRESS_ENV_VAR} where an operator wants that. */
export const DEFAULT_LISTEN_ADDRESS = '0.0.0.0';

/**
 * **No rule here may interpolate the value it rejected.** `SocketPathSchema` does exactly
 * that — a path in the message is the whole diagnosis — and copying its shape onto `token`
 * is precisely how a secret reaches a log or a support thread (D20: never let a token reach
 * a log or a report). Zod's own messages are path-and-rule only, and `describeIssues` prints
 * exactly those, so the failure below says `token: String must contain at least 32
 * character(s)` and never what was sent.
 */
export const NetworkListenerSchema = z
	.object({
		address: z.string().min(1),
		port: z.coerce.number().int().min(1).max(65535),
		token: z.string().min(MIN_HOST_TOKEN_LENGTH),
		certPath: z.string().min(1),
		keyPath: z.string().min(1),
	})
	.strict();
export type NetworkListenerConfig = z.infer<typeof NetworkListenerSchema>;

/** Which variable a schema field came from, so a failure names what the operator has to edit. */
const ENV_VAR_BY_FIELD: Record<keyof NetworkListenerConfig, string> = {
	address: LISTEN_ADDRESS_ENV_VAR,
	port: LISTEN_PORT_ENV_VAR,
	token: HOST_TOKEN_ENV_VAR,
	certPath: TLS_CERT_ENV_VAR,
	keyPath: TLS_KEY_ENV_VAR,
};

/**
 * Resolve the network listener, or `undefined` when this host serves the local socket only.
 *
 * An empty value counts as unset for every variable, matching `resolveSocketPath`: an
 * exported-but-blank variable is what a shell leaves behind, and it is also how
 * `spawnDaemon` tells an autostarted child it is not a network host.
 */
export function resolveNetworkListener(
	env: NodeJS.ProcessEnv = process.env,
): NetworkListenerConfig | undefined {
	const port = optional(env[LISTEN_PORT_ENV_VAR]);
	if (port === undefined) {
		// The switch is off, so nothing else is read and nothing else is required. This is the
		// zero-config local-only path, and it has to stay reachable with none of the rest set.
		return undefined;
	}

	const token = optional(env[HOST_TOKEN_ENV_VAR]);
	const certPath = optional(env[TLS_CERT_ENV_VAR]);
	const keyPath = optional(env[TLS_KEY_ENV_VAR]);
	requireAll({
		[HOST_TOKEN_ENV_VAR]: token,
		[TLS_CERT_ENV_VAR]: certPath,
		[TLS_KEY_ENV_VAR]: keyPath,
	});

	const parsed = NetworkListenerSchema.safeParse({
		address: optional(env[LISTEN_ADDRESS_ENV_VAR]) ?? DEFAULT_LISTEN_ADDRESS,
		port,
		token,
		certPath,
		keyPath,
	});
	if (!parsed.success) {
		throw new Error(describeIssues(withEnvVarNames(parsed.error)));
	}
	return parsed.data;
}

/** An exported-but-blank variable is not a setting. */
function optional(value: string | undefined): string | undefined {
	return value === undefined || value === '' ? undefined : value;
}

/**
 * One error naming **every** missing variable, so an operator fixes their setup in one pass
 * instead of restarting three times to be told about the next one.
 */
function requireAll(required: Record<string, string | undefined>): void {
	const missing = Object.entries(required)
		.filter(([, value]) => value === undefined)
		.map(([name]) => name);
	if (missing.length === 0) {
		return;
	}
	throw new Error(
		`${LISTEN_PORT_ENV_VAR} is set, so this host would listen on the network, but ` +
			`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. Set ` +
			`${missing.length === 1 ? 'it' : 'them'}, or unset ${LISTEN_PORT_ENV_VAR} to serve ` +
			`the local socket only. An unauthenticated listener is never started.`,
	);
}

/**
 * Re-labels each issue's path with the variable it came from. The operator edits an
 * environment, not an object, so `ROVER_LISTEN_PORT: Expected number…` is the actionable
 * form of `port: Expected number…`. The *message* is never touched — see the schema above.
 */
function withEnvVarNames(error: z.ZodError): z.ZodError {
	return new z.ZodError(
		error.issues.map((issue) => ({
			...issue,
			path: issue.path.map((segment) => envVarFor(segment) ?? segment),
		})),
	);
}

function envVarFor(segment: string | number): string | undefined {
	return typeof segment === 'string' && segment in ENV_VAR_BY_FIELD
		? ENV_VAR_BY_FIELD[segment as keyof NetworkListenerConfig]
		: undefined;
}
