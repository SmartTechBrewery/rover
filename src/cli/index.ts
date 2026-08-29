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

import { UsageError } from './_shared/flags.js';
import * as out from './_shared/output.js';
import * as acquire from './commands/acquire.js';
import * as list from './commands/list.js';
import * as release from './commands/release.js';
import * as status from './commands/status.js';

interface Command {
	/** The command's own usage text, printed when it rejects an invocation. */
	readonly USAGE: string;
	run(argv: string[]): Promise<number>;
}

const COMMANDS: Record<string, Command> = { list, acquire, release, status };

/** Success. */
export const EXIT_OK = 0;
/** The operation did not succeed — see the usage text below for what counts. */
export const EXIT_FAILED = 1;
/** The caller asked wrong. Always paired with the usage text. */
export const EXIT_USAGE = 2;

export function usage(): string {
	return `rover — one device at a time, shared between whoever is working

Usage: rover <command> [options]

Commands:
  list                     What is attached to the host, what is free, and who holds it
  acquire <serial>         Take a lease on one device (--owner and --project required)
  release <lease-id>       Hand a lease back
  status                   Which host answered, its pid, uptime and protocol version

Global options:
  --host <name>   Which host to ask. Default 'local'; nothing else is reachable until the
                  host network listener lands (PROJECT.md R22)
  --json          One JSON document on stdout, every diagnostic on stderr
  --help          This text, or a command's own when given after one

Exit codes:
  0   success
  1   the operation did not succeed — a refused acquire, a release that found no live
      lease, an unreachable host, or a request the host rejected
  2   usage error — unknown command, unknown flag, a missing required option, or a
      --host nothing can reach yet

The daemon starts itself on the first call, so nothing here needs starting by hand.
Set ROVER_SOCKET_PATH to point at a socket other than ~/.rover/rover.sock.`;
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

// Entrypoint guard: self-run only when invoked directly, never when a test imports `run`.
// `process.exitCode` rather than `process.exit()`, so a document written to a pipe is
// flushed instead of truncated at whatever byte the exit landed on.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	process.exitCode = await run(process.argv.slice(2));
}
