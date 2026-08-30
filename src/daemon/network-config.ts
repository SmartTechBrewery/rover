/**
 * Both ends of the network transport, configured from the environment: whether this host
 * listens, and which host a client asks.
 *
 * The two resolvers sit together because they share a secret and a shape. Each is an
 * **opt-in** with one switch variable, and with that switch unset nothing else is read,
 * validated or required: `ROVER_LISTEN_PORT` for the listener (D17, D20), so the zero-config
 * local socket keeps working with no token and no certificate, and `ROVER_HOST_ADDRESS` for
 * the client, so a plain `rover list` never looks for a remote host it was not told about.
 * Set a switch and the rest of that half becomes required *together* — a port with no token
 * is a listener that lets strangers in, and an address with no token is a client that cannot
 * be let in — and the failure is loud, naming every variable still missing rather than
 * half-configuring anything.
 *
 * **`ROVER_HOST_TOKEN` is deliberately one variable for both halves.** A machine that hosts
 * devices *and* borrows one from somewhere else is holding one secret, not two that drift
 * apart.
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

/** The client's opt-in switch. Unset or empty ⇒ this client has no remote host at all. */
export const HOST_ADDRESS_ENV_VAR = 'ROVER_HOST_ADDRESS';
/** The port that host listens on — its `ROVER_LISTEN_PORT`, named from the other side. */
export const HOST_PORT_ENV_VAR = 'ROVER_HOST_PORT';
/**
 * The certificate to trust, for a host whose own certificate signs it (the ordinary case for
 * a private deployment). Unset means the system trust store. There is deliberately no
 * variable that turns verification off: a self-signed host is trusted by naming it here.
 */
export const HOST_CA_ENV_VAR = 'ROVER_HOST_CA';

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
const ENV_VAR_BY_LISTENER_FIELD: Record<keyof NetworkListenerConfig, string> = {
	address: LISTEN_ADDRESS_ENV_VAR,
	port: LISTEN_PORT_ENV_VAR,
	token: HOST_TOKEN_ENV_VAR,
	certPath: TLS_CERT_ENV_VAR,
	keyPath: TLS_KEY_ENV_VAR,
};

/**
 * The one remote host this client may ask (D18 — exactly one host per deployment, so there is
 * no catalogue here and no second entry to pick between).
 *
 * The same rule as the listener schema above binds this one: **no message may interpolate the
 * token**, so `token` carries a plain `.min()` and nothing that would quote what it rejected.
 */
export const RemoteHostSchema = z
	.object({
		address: z.string().min(1),
		port: z.coerce.number().int().min(1).max(65535),
		token: z.string().min(MIN_HOST_TOKEN_LENGTH),
		caPath: z.string().min(1).optional(),
	})
	.strict();
export type RemoteHostConfig = z.infer<typeof RemoteHostSchema>;

const ENV_VAR_BY_REMOTE_FIELD: Record<keyof RemoteHostConfig, string> = {
	address: HOST_ADDRESS_ENV_VAR,
	port: HOST_PORT_ENV_VAR,
	token: HOST_TOKEN_ENV_VAR,
	caPath: HOST_CA_ENV_VAR,
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
	const missing = missingFrom({
		[HOST_TOKEN_ENV_VAR]: token,
		[TLS_CERT_ENV_VAR]: certPath,
		[TLS_KEY_ENV_VAR]: keyPath,
	});
	if (missing.length > 0) {
		throw new Error(
			`${LISTEN_PORT_ENV_VAR} is set, so this host would listen on the network, but ` +
				`${nameThem(missing)} not set. Set ${missing.length === 1 ? 'it' : 'them'}, or unset ` +
				`${LISTEN_PORT_ENV_VAR} to serve the local socket only. An unauthenticated listener ` +
				`is never started.`,
		);
	}

	const parsed = NetworkListenerSchema.safeParse({
		address: optional(env[LISTEN_ADDRESS_ENV_VAR]) ?? DEFAULT_LISTEN_ADDRESS,
		port,
		token,
		certPath,
		keyPath,
	});
	if (!parsed.success) {
		throw new Error(describeIssues(withEnvVarNames(parsed.error, ENV_VAR_BY_LISTENER_FIELD)));
	}
	return parsed.data;
}

/**
 * Resolve the remote host this client asks for `--host remote`, or `undefined` when none is
 * configured and `local` is the only host it has.
 *
 * `undefined` rather than a throw is what keeps a plain `rover list` free of any of this: an
 * unconfigured client is the default, not a mistake. What *is* a mistake — and throws, naming
 * every missing variable at once — is a half-configured one, because an address with no port
 * or no token cannot be guessed at and a client that tried would be reporting a connection
 * failure for a setup problem.
 *
 * Empty counts as unset for every variable here, exactly as it does for the listener.
 */
export function resolveRemoteHost(
	env: NodeJS.ProcessEnv = process.env,
): RemoteHostConfig | undefined {
	const address = optional(env[HOST_ADDRESS_ENV_VAR]);
	if (address === undefined) {
		// The switch is off. Nothing else is read, so a stray `ROVER_HOST_PORT` in a shell
		// cannot make a client believe it has somewhere to go.
		return undefined;
	}

	const port = optional(env[HOST_PORT_ENV_VAR]);
	const token = optional(env[HOST_TOKEN_ENV_VAR]);
	const missing = missingFrom({ [HOST_PORT_ENV_VAR]: port, [HOST_TOKEN_ENV_VAR]: token });
	if (missing.length > 0) {
		throw new Error(
			`${HOST_ADDRESS_ENV_VAR} is set, so this client would ask a remote host, but ` +
				`${nameThem(missing)} not set. Set ${missing.length === 1 ? 'it' : 'them'}, or unset ` +
				`${HOST_ADDRESS_ENV_VAR} and use the local host. A client never guesses a port or a ` +
				`token.`,
		);
	}

	const parsed = RemoteHostSchema.safeParse({
		address,
		port,
		token,
		caPath: optional(env[HOST_CA_ENV_VAR]),
	});
	if (!parsed.success) {
		throw new Error(describeIssues(withEnvVarNames(parsed.error, ENV_VAR_BY_REMOTE_FIELD)));
	}
	return parsed.data;
}

/** An exported-but-blank variable is not a setting. */
function optional(value: string | undefined): string | undefined {
	return value === undefined || value === '' ? undefined : value;
}

/**
 * **Every** variable of a set that is not set, so a failure lists them all and the operator
 * fixes their setup in one pass instead of restarting three times to be told about the next
 * one. Shared by both halves, which is the only reason they cannot drift on this.
 */
function missingFrom(required: Record<string, string | undefined>): string[] {
	return Object.entries(required)
		.filter(([, value]) => value === undefined)
		.map(([name]) => name);
}

/** `A is` / `A, B are` — the list and the verb that agrees with it. */
function nameThem(missing: string[]): string {
	return `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'}`;
}

/**
 * Re-labels each issue's path with the variable it came from. The operator edits an
 * environment, not an object, so `ROVER_LISTEN_PORT: Expected number…` is the actionable
 * form of `port: Expected number…`. The *message* is never touched — see the schema above.
 *
 * The map is passed in rather than looked up globally because the two halves disagree on
 * every shared field name: `address` is `ROVER_LISTEN_ADDRESS` for a listener and
 * `ROVER_HOST_ADDRESS` for a client, and naming the wrong one sends the operator to edit a
 * variable that is not the problem.
 */
function withEnvVarNames(
	error: z.ZodError,
	envVars: Readonly<Record<string, string | undefined>>,
): z.ZodError {
	return new z.ZodError(
		error.issues.map((issue) => ({
			...issue,
			path: issue.path.map((segment) =>
				typeof segment === 'string' ? (envVars[segment] ?? segment) : segment,
			),
		})),
	);
}
