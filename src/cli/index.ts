/**
 * `rover` — the CLI (D4, R10): the interface everything else gets debugged through, and the
 * one a human uses with no agent anywhere in the picture.
 *
 * It holds **no verb logic**. A command parses flags, resolves a host, makes one IPC call,
 * renders the answer and picks an exit code (ai/ARCHITECTURE.md, "The adapters own
 * translation only"). Nothing here decides whether a device is free, when a lease ends or
 * what a refusal means — the host decides, and a second opinion living in a client is how
 * two answers start disagreeing.
 *
 * Dependency-free, like Swarm's own `src/cli/`: Node's `parseArgs` and a dispatch table.
 * Each command lives in `commands/<name>.ts` and exports its own `USAGE` plus
 * `run(argv): Promise<number>`, where the number is the process exit code.
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from './_shared/exit.js';
import { UsageError } from './_shared/flags.js';
import * as out from './_shared/output.js';
import * as acquire from './commands/acquire.js';
import * as install from './commands/install.js';
import * as list from './commands/list.js';
import * as pull from './commands/pull.js';
import * as push from './commands/push.js';
import * as record from './commands/record.js';
import * as release from './commands/release.js';
import * as screenshot from './commands/screenshot.js';
import * as status from './commands/status.js';
import * as users from './commands/users.js';

/**
 * The exit codes, re-exported from `./_shared/exit.js` where they live so that a shared
 * helper can name one without importing this module back.
 */
export { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from './_shared/exit.js';

interface Command {
	/** The command's own usage text, printed when it rejects an invocation. */
	readonly USAGE: string;
	run(argv: string[]): Promise<number>;
}

/**
 * Null-prototype, so a lookup answers only what was put in it.
 *
 * An object literal inherits `toString`, `valueOf`, `constructor` and `__proto__` from
 * `Object.prototype`, and every one of them is a truthy value that walks straight past the
 * `!handler` guard below and into `handler.run(...)` — turning "unknown command" (exit 2,
 * with the usage text) into an internal TypeError at exit 1, which this CLI defines as a
 * refused operation. Any table added under `src/cli/` is built this way for the same reason.
 */
const COMMANDS: Record<string, Command | undefined> = Object.assign(Object.create(null), {
	list,
	acquire,
	release,
	screenshot,
	record,
	pull,
	push,
	install,
	status,
	users,
});

export function usage(): string {
	return `rover — one device at a time, shared between whoever is working

Usage: rover <command> [options]

There is no \`bin/\` launcher yet (PROJECT.md R20), so \`rover\` below stands for
\`${out.INVOCATION}\` — \`rover status\` is typed \`${out.INVOCATION} status\`.

Commands:
  list                     What is attached to the host, what is free, and who holds it
  acquire <serial>         Take a lease on one device (--owner and --project required)
  release <lease-id>       Hand a lease back
  screenshot <lease-id>    Capture the screen to a file on this machine (--out required)
  record <lease-id>        Record the screen to a file on this machine (--out required)
  pull <lease-id> <path>   Read a file off the device onto this machine (--out required)
  push <lease-id> <local> <device>
                           Send a file from this machine onto the device
  install <lease-id> <local>
                           Install a package from this machine onto the device
  status                   Which host answered, its pid, uptime and protocol version
  users <subcommand>       Who may use this host — add, list, rotate, revoke

\`screenshot\`, \`record\` and \`pull\` write their bytes **here**: the verb runs on the host and
the answer comes back as bytes, so --out is a path on this machine and the path reported is
yours, absolute. A transfer the host refuses leaves no file at --out at all.

\`push\` and \`install\` read their file **here** and send its bytes, so the file they name is
on this machine and never on the host. A source that is missing, is a directory, or is over
the bytes one call may carry is refused before anything is sent, naming the file, its real
size and the limit — the host is never asked at all.

\`users\` is the one command that asks no host: it reads and writes this machine's own
\`~/.rover/users.json\` directly, works with no daemon running, and takes no --host.

Global options:
  --host <name>   Which host to ask: 'local' (the default) or 'remote', the machine
                  ROVER_HOST_ADDRESS, ROVER_HOST_PORT and ROVER_HOST_TOKEN name.
                  Not accepted by \`users\`, which asks no host at all
  --json          One JSON document on stdout, every diagnostic on stderr
  --help          This text, or a command's own when given after one

Exit codes:
  0   success
  1   the operation did not succeed — a refused acquire, a release that found no live
      lease, a verb the host refused or that failed, an unreachable host, or a request
      the host rejected
  2   usage error — unknown command, unknown flag, a missing required option, an
      attribution string longer than the host accepts, an --out that names a directory
      or has no directory to write into, a file to push or install that is missing,
      cannot be read, is not a regular file (a directory, a pipe, a device) or is over
      the transfer limit, or a --host that is neither 'local' nor 'remote' — or
      'remote' with nothing in the environment naming one

The local daemon starts itself on the first call, so nothing here needs starting by hand;
a remote host is a service its operator runs and is never started from a client.
Set ROVER_SOCKET_PATH to point at a socket other than ~/.rover/rover.sock,
ROVER_USERS_PATH for a user store other than ~/.rover/users.json, and
ROVER_HOST_ADDRESS, ROVER_HOST_PORT and ROVER_HOST_TOKEN (plus ROVER_HOST_CA for a
certificate to trust) to reach a remote one.`;
}

/**
 * Parse argv (already stripped of the executable and the script path) and run the matching
 * command. Returns the exit code; the process never exits from inside a command.
 */
export async function run(argv: string[]): Promise<number> {
	const [command, ...rest] = argv;

	if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
		out.info(usage());
		return EXIT_OK;
	}

	const handler = COMMANDS[command];
	if (!handler) {
		out.error(`Unknown command '${command}'.`);
		out.error(usage());
		return EXIT_USAGE;
	}

	try {
		return await handler.run(rest);
	} catch (error) {
		// The one catch. Every command throws rather than printing its own failure, so the
		// two kinds stay distinguishable in exactly one place.
		if (error instanceof UsageError) {
			out.error(error.message);
			// The command's own usage, not this dispatcher's: a caller who got `--owner` wrong
			// needs the shape of `acquire`, and the full command list buries it.
			out.error(handler.USAGE);
			return EXIT_USAGE;
		}
		out.error(error instanceof Error ? error.message : String(error));
		return EXIT_FAILED;
	}
}

/**
 * `process.argv[1]` as the URL Node would have given this module had it been the entry.
 *
 * Two normalisations, and skipping either one makes the whole CLI a silent no-op that exits
 * 0: `import.meta.url` is a URL, so it percent-encodes a space (`/My Projects/` arrives as
 * `/My%20Projects/`), and Node resolves the ESM entry through `realpath`, so a checkout
 * reached by a symlink is compared against its real location. `argv[1]` is neither — it is
 * the raw path as typed. `null` when the path cannot be resolved, which is not this module.
 */
export function entryUrl(argvPath: string): string | null {
	try {
		return pathToFileURL(realpathSync(argvPath)).href;
	} catch {
		return null;
	}
}

// Entrypoint guard: self-run only when invoked directly, never when a test imports `run`.
// `process.exitCode` rather than `process.exit()`, so a document written to a pipe is
// flushed instead of truncated at whatever byte the exit landed on.
if (process.argv[1] && import.meta.url === entryUrl(process.argv[1])) {
	process.exitCode = await run(process.argv.slice(2));
}
