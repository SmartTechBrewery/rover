/**
 * The flag surface all four commands share, and the error a mis-typed invocation raises.
 *
 * Node's `parseArgs` and nothing else — no CLI dependency, matching Swarm's own
 * `src/cli/`. `strict: true`, so an unknown flag is a refusal rather than a value silently
 * dropped: a caller who typed `--owener` has to be told, not handed a lease attributed to
 * nobody.
 */

import { type ParseArgsOptionsConfig, parseArgs } from 'node:util';
import { ATTRIBUTION_MAX_LENGTH, TEST_DESCRIPTION_MAX_LENGTH } from '../../ipc/methods.js';

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
 * The positionals a command takes, named as the usage text names them.
 *
 * A blank one is rejected here rather than left to the id parser below it, so an empty
 * argument is a usage error with the command's own shape in it instead of a validation
 * failure from two layers down.
 *
 * `optional` names **trailing** positionals a command may be called without, and it exists
 * for one call: `rover install`, whose package is optional because a call carrying no bytes
 * is the form that runs the lease's project `install` hook (D13, `src/verbs/files.ts`). Only
 * a trailing run of them, because anything else makes which argument was omitted a guess.
 * Nothing here decides what an absent one means — the command reads it as `undefined` and
 * the *host* still answers whether that form is available, which is what keeps a project
 * with no hook declared a named `install-hook-undeclared` failure rather than a usage error
 * this layer invented.
 */
export function expectPositionals(
	command: string,
	positionals: string[],
	expected: readonly string[],
	optional: readonly string[] = [],
): (string | undefined)[] {
	const shape =
		expected.length === 0 && optional.length === 0
			? 'no arguments'
			: [...expected, ...optional.map((name) => `[${name}]`)].join(' ');
	if (
		positionals.length < expected.length ||
		positionals.length > expected.length + optional.length
	) {
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
 * Nothing here ever *synthesizes* a value: `--owner` is a caller-supplied string the host
 * stores and never reads (D16, D20), and one this CLI derived from a branch, a process id
 * or whoever authenticated would attribute a device to nobody in particular — the exact
 * failure those decisions exist to prevent. {@link attributionWithDefault} is not that: it
 * takes a value a human wrote down once, in the project's own hook file, and nothing about
 * it is inferred from context.
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

/**
 * The shape of an attribution string, checked here rather than at the host.
 *
 * The bound is the host's — {@link ATTRIBUTION_MAX_LENGTH}, imported rather than restated,
 * so the two cannot drift. What the CLI adds is *where the failure lands*: the host answers
 * a bad value with Zod's own words naming `testName`, a key the caller never typed, over a
 * round trip that exits 1 — the code this CLI reserves for a refused acquire or an
 * unreachable host. A caller reading only the exit code could not then tell a mistyped flag
 * from a busy device. Rejecting it here makes every bad attribution value one thing: exit 2,
 * naming the flag as it was spelled, with the command's own usage under it.
 */
function boundAttribution(command: string, name: string, value: string): string {
	if (value.length > ATTRIBUTION_MAX_LENGTH) {
		throw new UsageError(
			`rover ${command}: --${name} is ${value.length} characters — an attribution string is ` +
				`stored and echoed back by the host, never read, so it is capped at ` +
				`${ATTRIBUTION_MAX_LENGTH}.`,
		);
	}
	return value;
}

/** A required attribution string: present ({@link requireOption}) and within the bound. */
export function requireAttribution(
	command: string,
	name: string,
	value: string | undefined,
	why: string,
): string {
	return boundAttribution(command, name, requireOption(command, name, value, why));
}

/**
 * A required attribution string that a configured file may supply instead — **the flag
 * first, then the file, then a usage error**, in one place so no command re-derives that
 * order.
 *
 * Only `--project` has a `fallback` today, out of the hook file
 * `ROVER_PROJECT_FILE` names (`src/daemon/project-hooks.ts`, D22). `--owner` deliberately
 * never gets one.
 *
 * A flag typed with an empty value falls through to {@link requireAttribution} rather than
 * to the file: `--project ''` is a mistake, and answering it with a value the caller did
 * not type would hide the mistake behind a lease that looks fine. Nor is the fallback
 * length-checked — it is a `ProjectIdentifierSchema` string, capped at 64 characters, well
 * inside {@link ATTRIBUTION_MAX_LENGTH} — because a message naming `--project` for a value
 * nobody typed would send its reader looking at their command line.
 */
export function attributionWithDefault(
	command: string,
	name: string,
	value: string | undefined,
	fallback: string | undefined,
	why: string,
): string {
	if (value === undefined && fallback !== undefined) {
		return fallback;
	}
	return requireAttribution(command, name, value, why);
}

/**
 * An **optional** free-text string: absent when the flag was not typed, and a usage error when
 * it was typed with nothing in it or with more than the host will take.
 *
 * Only `--test-description` today (D22, as amended #148). Absent is returned as `undefined` and
 * never as an empty string, because that is what the wire means by absent: no key, and nothing
 * standing in for one (`TestDescriptionSchema`). `--test-description ''` is the same mistake
 * `--project ''` is, and gets the same answer rather than a lease carrying a blank sentence —
 * the host would refuse it anyway, and exit 2 naming the flag as it was spelled is the more
 * useful of the two failures ({@link boundAttribution} gives the argument at length).
 *
 * The bound is the host's, imported rather than restated. It is deliberately **not**
 * {@link ATTRIBUTION_MAX_LENGTH}: a description is prose and is not a path segment.
 */
export function optionalDescription(
	command: string,
	name: string,
	value: string | undefined,
): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value.trim().length === 0) {
		throw new UsageError(
			`rover ${command}: --${name} was given nothing — it is optional, so leave it out ` +
				`rather than passing an empty value.`,
		);
	}
	if (value.length > TEST_DESCRIPTION_MAX_LENGTH) {
		throw new UsageError(
			`rover ${command}: --${name} is ${value.length} characters — it is prose the host ` +
				`stores and never reads, capped at ${TEST_DESCRIPTION_MAX_LENGTH}.`,
		);
	}
	return value;
}
