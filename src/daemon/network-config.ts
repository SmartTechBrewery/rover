/**
 * Every end of every network transport, configured from the environment: whether this host
 * listens for Rover clients, whether it listens for a browser, and which host a client asks.
 *
 * The two resolvers sit together because they share a shape. Each is an **opt-in** with one
 * switch variable, and with that switch unset nothing else is read, validated or required:
 * `ROVER_LISTEN_PORT` for the listener (D17, D20), so the zero-config local socket keeps
 * working with no certificate at all, and `ROVER_HOST_ADDRESS` for the client, so a plain
 * `rover list` never looks for a remote host it was not told about. Set a switch and the rest
 * of that half becomes required *together* — a port with no TLS material is a listener that
 * cannot be trusted, and an address with no token is a client that cannot be let in — and the
 * failure is loud, naming every variable still missing rather than half-configuring anything.
 *
 * **The two halves are no longer symmetrical, and that is the point (D25).** The listener
 * holds **no secret at all**: it names the user store, `~/.rover/users.json`, and every
 * credential it accepts is one `rover users add` issued and `rover users revoke` can take
 * away. The client half holds exactly one thing — its own token, in `ROVER_HOST_TOKEN` — the
 * value a host printed for it once. There is deliberately no shared secret left to configure
 * on the host side; a second way in that no `rover users` command could revoke is precisely
 * what the user store exists to retire.
 *
 * **The HTTP listener is a third resolver, and it is separate from the TCP one on purpose**
 * (D29). It shares the shape — one switch, `ROVER_HTTP_PORT`, and nothing else read while it is
 * unset — and shares the TLS material and the user store, because it is the same host serving
 * the same surface. What it does not share is the *exposure question*: a Rover client is on
 * another machine by definition, so the TCP listener defaults to every interface, while the
 * ordinary first use of the panel is an operator's own browser on the host, so this one defaults
 * to loopback and refuses to start off loopback without TLS. Folding the two onto one switch
 * would mean an operator who exposed the host to their team also exposed a browser surface they
 * never asked for, and one who wanted the panel locally had to open a TCP port for it.
 *
 * **These are environment variables, not project config.** `ai/RULES.md` §7 splits the two:
 * the per-project file carries project hooks, the environment carries host-level settings. A
 * network listener and a client's credential are host-level, and a token in a file the
 * repository tracks is the accident this placement exists to prevent.
 *
 * Zod is the source of truth for what a valid value is, as it is for the socket path.
 */

import { z } from 'zod';
import { describeIssues } from '../ipc/protocol.js';
import { resolveUsersPath, USERS_PATH_ENV_VAR } from './user-store.js';

/** The opt-in switch. Unset or empty ⇒ no network listener at all. */
export const LISTEN_PORT_ENV_VAR = 'ROVER_LISTEN_PORT';
/** Which interface to bind, so an operator can narrow the listener to a VPN interface. */
export const LISTEN_ADDRESS_ENV_VAR = 'ROVER_LISTEN_ADDRESS';
export const TLS_CERT_ENV_VAR = 'ROVER_TLS_CERT';
export const TLS_KEY_ENV_VAR = 'ROVER_TLS_KEY';

/**
 * The HTTP surface's own opt-in switch. Unset or empty ⇒ no HTTP listener at all (D29).
 *
 * Deliberately **not** {@link LISTEN_PORT_ENV_VAR}: upgrading a daemon must not start listening
 * for browsers on a developer's machine, and an operator who exposed this host to their team's
 * Rover clients did not thereby ask for a browser surface. A change in exposure is a choice
 * somebody makes, never a consequence of a version.
 */
export const HTTP_PORT_ENV_VAR = 'ROVER_HTTP_PORT';
/**
 * Which interface the HTTP listener binds. Only read when {@link HTTP_PORT_ENV_VAR} is set.
 *
 * A non-loopback value **requires** the TLS pair below: a bearer token in a request header
 * crossing a LAN in the clear is exactly what D20 and D25 exist to prevent.
 */
export const HTTP_ADDRESS_ENV_VAR = 'ROVER_HTTP_ADDRESS';

/** The client's opt-in switch. Unset or empty ⇒ this client has no remote host at all. */
export const HOST_ADDRESS_ENV_VAR = 'ROVER_HOST_ADDRESS';
/**
 * **A client-side credential, and only that.** The value the host's own `rover users add` (or
 * `rover users rotate`) printed once, pasted on the machine that borrows a device. The host no
 * longer reads this variable at all: it authenticates against its user store, so a token is
 * revocable and rotatable on the host that issued it rather than being a secret both machines
 * hold forever (D25).
 *
 * It still authenticates only — a lease's owner is a separate, caller-supplied string and is
 * never derived from whoever authenticated (D20).
 */
export const HOST_TOKEN_ENV_VAR = 'ROVER_HOST_TOKEN';
/** The port that host listens on — its `ROVER_LISTEN_PORT`, named from the other side. */
export const HOST_PORT_ENV_VAR = 'ROVER_HOST_PORT';
/**
 * The certificate to trust, for a host whose own certificate signs it (the ordinary case for
 * a private deployment). Unset means the system trust store. There is deliberately no
 * variable that turns verification off: a self-signed host is trusted by naming it here.
 */
export const HOST_CA_ENV_VAR = 'ROVER_HOST_CA';

/**
 * The floor on the token a **client** presents. It is a bearer secret travelling to an open
 * port, so the only thing that makes guessing hopeless is length; 32 characters is the
 * shortest value that stays out of reach of an attacker who can try as fast as the network
 * allows, and `generateUserToken()` clears it at 43.
 *
 * No listener field uses it any more — the host validates nothing about a length, it looks a
 * token up in its store. What survives here is a **local** guard on the borrowing machine, so
 * a truncated paste fails on this side, naming the variable, instead of travelling and coming
 * back as an opaque `unauthenticated` that says nothing about which end is wrong.
 */
export const MIN_HOST_TOKEN_LENGTH = 32;

/** Every interface. Narrowed with {@link LISTEN_ADDRESS_ENV_VAR} where an operator wants that. */
export const DEFAULT_LISTEN_ADDRESS = '0.0.0.0';

/**
 * **Loopback**, and deliberately not {@link DEFAULT_LISTEN_ADDRESS}.
 *
 * A Rover client is on another machine by definition (D17), so every interface is the right
 * default there. A browser is not: the ordinary first use of the panel is the operator's own
 * browser on the host, so the default that needs no further thought is the one that reaches
 * nobody else. Widening it is one variable and it brings the TLS requirement with it.
 */
export const DEFAULT_HTTP_ADDRESS = '127.0.0.1';

/**
 * **The listener holds no secret.** `usersPath` names the store the gate authenticates
 * against, re-read at every connection attempt (D6, D25) — so there is nothing in this
 * object a log, an error or a crash dump could leak, and revoking a user takes effect with
 * the daemon still running.
 */
export const NetworkListenerSchema = z
	.object({
		address: z.string().min(1),
		port: z.coerce.number().int().min(1).max(65535),
		certPath: z.string().min(1),
		keyPath: z.string().min(1),
		usersPath: z.string().min(1),
	})
	.strict();
export type NetworkListenerConfig = z.infer<typeof NetworkListenerSchema>;

/** Which variable a schema field came from, so a failure names what the operator has to edit. */
const ENV_VAR_BY_LISTENER_FIELD: Record<keyof NetworkListenerConfig, string> = {
	address: LISTEN_ADDRESS_ENV_VAR,
	port: LISTEN_PORT_ENV_VAR,
	certPath: TLS_CERT_ENV_VAR,
	keyPath: TLS_KEY_ENV_VAR,
	usersPath: USERS_PATH_ENV_VAR,
};

/**
 * The HTTP surface's listener (D29). It holds no secret either, for {@link NetworkListenerSchema}'s
 * reason: `usersPath` names the store the per-request gate authenticates against.
 *
 * `certPath` and `keyPath` are **optional here and required there**, which is the one real
 * difference between the two listeners' configuration. Plain HTTP is a legitimate configuration
 * for this surface and only for this surface — on loopback, where there is no network for a
 * bearer token to cross — and {@link resolveHttpListener} is what refuses the combination that
 * is not: no TLS material and an address somebody else can reach.
 */
export const HttpListenerSchema = z
	.object({
		address: z.string().min(1),
		port: z.coerce.number().int().min(1).max(65535),
		certPath: z.string().min(1).optional(),
		keyPath: z.string().min(1).optional(),
		usersPath: z.string().min(1),
	})
	.strict();
export type HttpListenerConfig = z.infer<typeof HttpListenerSchema>;

const ENV_VAR_BY_HTTP_FIELD: Record<keyof HttpListenerConfig, string> = {
	address: HTTP_ADDRESS_ENV_VAR,
	port: HTTP_PORT_ENV_VAR,
	certPath: TLS_CERT_ENV_VAR,
	keyPath: TLS_KEY_ENV_VAR,
	usersPath: USERS_PATH_ENV_VAR,
};

/**
 * The one remote host this client may ask (D18 — exactly one host per deployment, so there is
 * no catalogue here and no second entry to pick between).
 *
 * **No rule here may interpolate the value it rejected.** `SocketPathSchema` does exactly
 * that — a path in the message is the whole diagnosis — and copying its shape onto `token` is
 * precisely how a secret reaches a log or a support thread (D20: never let a token reach a log
 * or a report). Zod's own messages are path-and-rule only, and `describeIssues` prints exactly
 * those, so a short token fails as `ROVER_HOST_TOKEN: String must contain at least 32
 * character(s)` and never quotes what was sent.
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

	const certPath = optional(env[TLS_CERT_ENV_VAR]);
	const keyPath = optional(env[TLS_KEY_ENV_VAR]);
	// `usersPath` is deliberately not in this set: it always resolves, to `~/.rover/users.json`
	// when nothing names it otherwise, so it can never be "missing". A host with no users yet
	// starts and refuses everyone, which is the correct state for one — not a startup failure.
	const missing = missingFrom({
		[TLS_CERT_ENV_VAR]: certPath,
		[TLS_KEY_ENV_VAR]: keyPath,
	});
	if (missing.length > 0) {
		throw new Error(
			`${LISTEN_PORT_ENV_VAR} is set, so this host would listen on the network, but ` +
				`${nameThem(missing)} not set. Set ${missing.length === 1 ? 'it' : 'them'}, or unset ` +
				`${LISTEN_PORT_ENV_VAR} to serve the local socket only. An unencrypted listener is ` +
				`never started, and an unauthenticated one is never started either: every network ` +
				`caller is checked against the user store that ${USERS_PATH_ENV_VAR} names.`,
		);
	}

	const parsed = NetworkListenerSchema.safeParse({
		address: optional(env[LISTEN_ADDRESS_ENV_VAR]) ?? DEFAULT_LISTEN_ADDRESS,
		port,
		certPath,
		keyPath,
		usersPath: resolveUsersPath(env),
	});
	if (!parsed.success) {
		throw new Error(describeIssues(withEnvVarNames(parsed.error, ENV_VAR_BY_LISTENER_FIELD)));
	}
	return parsed.data;
}

/**
 * Resolve the HTTP surface's listener, or `undefined` when this host serves no browser (D29).
 *
 * Empty counts as unset exactly as it does above, and for the same three reasons — a blank
 * exported variable is what a shell leaves behind, `spawnDaemon` blanks this one in an
 * autostarted child, and an upgrade that started listening for HTTP because nobody set the
 * switch would be a change in exposure nobody chose.
 *
 * There are exactly two ways this throws, and both are configurations that would be worse than
 * a startup failure:
 *
 * - **One of the TLS pair without the other.** Half-configured TLS is not a serving decision
 *   anybody made; it is a typo, and guessing which half was meant is how a host ends up plain
 *   when its operator believes it is encrypted.
 * - **No TLS material, on an address that is not loopback.** Then the bearer token every request
 *   carries would cross a network in the clear, which is precisely what the user store's hashed
 *   records and D20's "never let a token reach a log" exist to protect. The message names both
 *   ways out rather than picking one: set the TLS pair, or bind loopback and put whatever
 *   terminates TLS on this machine in front.
 *
 * Plain HTTP on loopback is not one of them. It needs no certificate to be safe from the
 * network, and demanding one there would mean nobody could look at the panel on their own
 * machine without first generating a certificate for it.
 */
export function resolveHttpListener(
	env: NodeJS.ProcessEnv = process.env,
): HttpListenerConfig | undefined {
	const port = optional(env[HTTP_PORT_ENV_VAR]);
	if (port === undefined) {
		// The switch is off, so nothing else is read and nothing else is required — not the
		// address, not the TLS material. This is the default for every daemon that was not asked
		// to serve a browser, which is every daemon until somebody sets this variable.
		return undefined;
	}

	const address = optional(env[HTTP_ADDRESS_ENV_VAR]) ?? DEFAULT_HTTP_ADDRESS;
	const certPath = optional(env[TLS_CERT_ENV_VAR]);
	const keyPath = optional(env[TLS_KEY_ENV_VAR]);

	const missing = missingFrom({
		[TLS_CERT_ENV_VAR]: certPath,
		[TLS_KEY_ENV_VAR]: keyPath,
	});
	// Either both or neither. One alone is the typo case above; neither is the loopback case,
	// which is legitimate and checked immediately below.
	if (missing.length === 1) {
		throw new Error(
			`${HTTP_PORT_ENV_VAR} is set, so this host would serve the panel over HTTPS, but ` +
				`${nameThem(missing)} not set. Set it, or unset both to serve plain HTTP on a ` +
				`loopback ${HTTP_ADDRESS_ENV_VAR}. A half-configured certificate is never guessed at.`,
		);
	}
	if (missing.length === 2 && !isLoopbackAddress(address)) {
		throw new Error(
			`${HTTP_PORT_ENV_VAR} is set with ${HTTP_ADDRESS_ENV_VAR}='${address}', which is not a ` +
				`loopback address, and neither ${TLS_CERT_ENV_VAR} nor ${TLS_KEY_ENV_VAR} is set. ` +
				`Every request to this surface carries a bearer token in a header, and an ` +
				`unencrypted listener off loopback would put it on the wire in the clear. Set both ` +
				`TLS variables, or bind ${HTTP_ADDRESS_ENV_VAR} to a loopback address and put ` +
				`whatever terminates TLS on this machine in front of it.`,
		);
	}

	const parsed = HttpListenerSchema.safeParse({
		address,
		port,
		...(certPath === undefined ? {} : { certPath }),
		...(keyPath === undefined ? {} : { keyPath }),
		// Always resolves, for `resolveNetworkListener`'s reason: a host with no users yet starts
		// and refuses everyone, which is the correct state for one.
		usersPath: resolveUsersPath(env),
	});
	if (!parsed.success) {
		throw new Error(describeIssues(withEnvVarNames(parsed.error, ENV_VAR_BY_HTTP_FIELD)));
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

/**
 * Whether `address` names an interface only this machine can reach.
 *
 * Deliberately conservative: it matches the loopback forms an operator actually writes —
 * `localhost`, the whole `127.0.0.0/8` block, and IPv6's `::1` with or without brackets — and
 * calls everything else reachable. Being wrong in that direction costs a startup failure with
 * two named ways out; being wrong in the other would put a bearer token on a wire.
 */
function isLoopbackAddress(address: string): boolean {
	const normalised = address.trim().toLowerCase();
	return (
		normalised === 'localhost' ||
		normalised === '::1' ||
		normalised === '[::1]' ||
		normalised === '127.0.0.1' ||
		normalised.startsWith('127.')
	);
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
