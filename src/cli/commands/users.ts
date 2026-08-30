/**
 * `rover users` — who may use this host, managed on the machine that holds it (D25).
 *
 * The odd one out among the commands here, and deliberately so: it opens no connection,
 * makes no IPC call and takes no `--host`. It reads and writes `~/.rover/users.json`
 * directly, so it works with no daemon running and cannot be aimed at somebody else's
 * machine. `--host` is therefore an *unknown flag* rather than an ignored one — silently
 * accepting `--host remote` would contradict the one property this command has.
 *
 * The credential is printed **exactly once**. `add` and `rotate` mint a token, show it, and
 * store only its hash; nothing — not `list`, not `--json`, not an error path — can produce it
 * again. An operator who loses one runs `rotate`, which is what makes that safe to promise.
 */

import {
	addUser,
	type IssuedUser,
	MAX_DISPLAY_NAME_LENGTH,
	parseIdentifier,
	readUsers,
	resolveUsersPath,
	revokeUser,
	rotateUserToken,
	type UserRecord,
} from '../../daemon/user-store.js';
import { expectPositionals, parseCommandArgs, UsageError } from '../_shared/flags.js';
import * as out from '../_shared/output.js';

export const USAGE = `rover users — who may use this host, managed in the host's own file

Usage:
  rover users add <identifier> [--name <display name>] [--json]
  rover users list [--json]
  rover users rotate <identifier> [--json]
  rover users revoke <identifier> [--json]

  add      Create a user and mint its token. The token is printed once and stored only
           as a hash — nothing can show it again. An identifier already in the file is
           refused rather than overwritten.
  list     Identifier, display name and creation date for every user. Never a token and
           never a hash.
  rotate   Replace a user's token with a fresh one, printed once. The old one stops
           working immediately.
  revoke   Remove a user outright.

This command runs against the host's own file and never over the network, so there is no
--host and no daemon has to be running. ROVER_USERS_PATH points it somewhere other than
~/.rover/users.json. --json writes one document on stdout on success; a failure is a
message on stderr, as it is for every other command.`;

const OPTIONS = {
	json: { type: 'boolean', default: false },
	help: { type: 'boolean', default: false },
	name: { type: 'string' },
} as const;

const HEADINGS = ['IDENTIFIER', 'NAME', 'CREATED'] as const;

interface Invocation {
	readonly path: string;
	readonly positionals: string[];
	readonly json: boolean;
	readonly name: string | undefined;
}

type Subcommand = (invocation: Invocation) => Promise<number>;

/**
 * The line that makes the once-only promise legible, printed under every minted token.
 *
 * It deliberately does not repeat the token: this text is what a scrollback, a screenshot or
 * a pasted terminal session carries, and "printed exactly once" has to survive all three.
 */
const STORED_AS_A_HASH =
	'That token is stored only as a hash. It is not shown again and cannot be recovered — ' +
	'hand it over now, or mint a fresh one with `rover users rotate`.';

/** What a user looks like to anyone outside the store: no `tokenHash`, ever. */
function publicFields(
	user: UserRecord,
): Pick<UserRecord, 'identifier' | 'displayName' | 'createdAt'> {
	return {
		identifier: user.identifier,
		displayName: user.displayName,
		createdAt: user.createdAt,
	};
}

/** Sorted by creation, then identifier, so two runs of `list` diff cleanly. */
export function renderUserList(path: string, users: readonly UserRecord[]): string {
	if (users.length === 0) {
		return `No users in ${path}.`;
	}
	return out.renderTable(
		HEADINGS,
		users.map((user) => [user.identifier, user.displayName, user.createdAt]),
	);
}

function sortedForDisplay(users: readonly UserRecord[]): UserRecord[] {
	return [...users].sort(
		(left, right) =>
			left.createdAt.localeCompare(right.createdAt) ||
			left.identifier.localeCompare(right.identifier),
	);
}

/** The token on a line of its own, so copying it never picks up prose around it. */
function reportIssued(issued: IssuedUser, json: boolean, headline: string): number {
	if (json) {
		out.printDocument({ ...publicFields(issued.user), token: issued.token });
		return 0;
	}
	out.info(headline);
	out.info(issued.token);
	out.info(STORED_AS_A_HASH);
	return 0;
}

/**
 * An identifier the store would reject is a typo, not a failed operation, so it exits 2 with
 * the usage text rather than 1 with a validation message from two layers down — the same call
 * {@link expectPositionals} makes about a blank argument.
 */
function expectIdentifier(subcommand: string, raw: string): string {
	try {
		return parseIdentifier(raw);
	} catch (error) {
		throw new UsageError(
			`rover users ${subcommand}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function expectNoName(subcommand: string, name: string | undefined): void {
	if (name !== undefined) {
		throw new UsageError(`rover users ${subcommand}: --name is only accepted by 'add'`);
	}
}

function optionalDisplayName(name: string | undefined): string | undefined {
	if (name === undefined) {
		return undefined;
	}
	if (name.trim().length === 0) {
		throw new UsageError(
			'rover users add: --name was given with no value — omit the flag to use the ' +
				'identifier as the display name.',
		);
	}
	if (name.length > MAX_DISPLAY_NAME_LENGTH) {
		throw new UsageError(
			`rover users add: --name is ${name.length} characters — a display name is shown in ` +
				`a table and never parsed, so it is capped at ${MAX_DISPLAY_NAME_LENGTH}.`,
		);
	}
	return name;
}

async function add({ path, positionals, json, name }: Invocation): Promise<number> {
	const [raw] = expectPositionals('users add', positionals, ['<identifier>']);
	const identifier = expectIdentifier('add', raw ?? '');
	const displayName = optionalDisplayName(name);

	const issued = await addUser(path, { identifier, displayName });
	return reportIssued(issued, json, `Created user '${issued.user.identifier}'. Its token:`);
}

async function list({ path, positionals, json, name }: Invocation): Promise<number> {
	expectNoName('list', name);
	expectPositionals('users list', positionals, []);

	const users = sortedForDisplay(await readUsers(path));
	if (json) {
		out.printDocument({ users: users.map(publicFields) });
	} else {
		out.info(renderUserList(path, users));
	}
	return 0;
}

async function rotate({ path, positionals, json, name }: Invocation): Promise<number> {
	expectNoName('rotate', name);
	const [raw] = expectPositionals('users rotate', positionals, ['<identifier>']);
	const identifier = expectIdentifier('rotate', raw ?? '');

	const issued = await rotateUserToken(path, identifier);
	return reportIssued(
		issued,
		json,
		`Rotated the token for '${issued.user.identifier}'. The previous one no longer works. ` +
			`Its new token:`,
	);
}

async function revoke({ path, positionals, json, name }: Invocation): Promise<number> {
	expectNoName('revoke', name);
	const [raw] = expectPositionals('users revoke', positionals, ['<identifier>']);
	const identifier = expectIdentifier('revoke', raw ?? '');

	const user = await revokeUser(path, identifier);
	if (json) {
		out.printDocument({ identifier: user.identifier, revoked: true });
	} else {
		out.info(`Revoked '${user.identifier}'. Its token no longer names a user.`);
	}
	return 0;
}

/** Null-prototype, for the reason `src/cli/index.ts` gives about every table under `src/cli/`. */
const SUBCOMMANDS: Record<string, Subcommand | undefined> = Object.assign(Object.create(null), {
	add,
	list,
	rotate,
	revoke,
});

const NAMES = 'add, list, rotate, revoke';

export async function run(argv: string[]): Promise<number> {
	const { values, positionals } = parseCommandArgs('users', argv, OPTIONS);
	if (values.help === true) {
		out.info(USAGE);
		return 0;
	}

	const [subcommand, ...rest] = positionals;
	if (subcommand === undefined) {
		throw new UsageError(`rover users: a subcommand is required — one of ${NAMES}`);
	}
	const handler = SUBCOMMANDS[subcommand];
	if (!handler) {
		throw new UsageError(
			`rover users: unknown subcommand '${subcommand}' — expected one of ${NAMES}`,
		);
	}

	return handler({
		path: resolveUsersPath(),
		positionals: rest,
		json: values.json === true,
		name: values.name,
	});
}
