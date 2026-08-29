/**
 * The flag surface all four commands share, and the error a mis-typed invocation raises.
 *
 * Node's `parseArgs` and nothing else — no CLI dependency, matching Swarm's own
 * `src/cli/`. `strict: true`, so an unknown flag is a refusal rather than a value silently
 * dropped: a caller who typed `--owener` has to be told, not handed a lease attributed to
 * nobody.
 */

import { type ParseArgsOptionsConfig, parseArgs } from 'node:util';

/**
 * The caller asked wrong — an unknown flag, a missing required option, an unsupported
 * host. Its own type so `index.ts` can answer exit code 2 with the usage text instead of
 * exit code 1 with a bare message: "you typed it wrong" and "it did not work" are
 * different next moves.
 */
export class UsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UsageError';
	}
}

/** `--json`, `--host` and `--help`, accepted by every command. */
export const GLOBAL_OPTIONS = {
	json: { type: 'boolean', default: false },
	host: { type: 'string' },
	help: { type: 'boolean', default: false },
} as const satisfies ParseArgsOptionsConfig;

/**
 * `parseArgs` with its throw translated. The message it raises already names the offending
 * token; what it cannot know is which command rejected it.
 */
export function parseCommandArgs<Options extends ParseArgsOptionsConfig>(
	command: string,
	argv: string[],
	options: Options,
) {
	try {
		return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
	} catch (error) {
		throw new UsageError(
			`rover ${command}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Exactly the positionals a command takes, named as the usage text names them.
 *
 * A blank one is rejected here rather than left to the id parser below it, so an empty
 * argument is a usage error with the command's own shape in it instead of a validation
 * failure from two layers down.
 */
export function expectPositionals(
	command: string,
	positionals: string[],
	expected: readonly string[],
): string[] {
	const shape = expected.length === 0 ? 'no arguments' : expected.join(' ');
	if (positionals.length !== expected.length) {
		const got =
			positionals.length === 0 ? 'none' : positionals.map((value) => `'${value}'`).join(' ');
		throw new UsageError(`rover ${command}: expected ${shape}, got ${got}`);
	}
	if (positionals.some((value) => value.trim().length === 0)) {
		throw new UsageError(`rover ${command}: expected ${shape}, got a blank argument`);
	}
	return positionals;
}

/**
 * A required option, with the reason it is required in the failure.
 *
 * There is deliberately no fallback anywhere below this: `--owner` and `--project` are
 * caller-supplied strings the host stores and never reads (D16, D20, D22), and a value
 * this CLI synthesized from an environment variable, a branch or a process id would
 * attribute a device to nobody in particular — the exact failure those decisions exist to
 * prevent.
 */
export function requireOption(
	command: string,
	name: string,
	value: string | undefined,
	why: string,
): string {
	if (value === undefined || value.trim().length === 0) {
		throw new UsageError(`rover ${command}: --${name} is required — ${why}`);
	}
	return value;
}
