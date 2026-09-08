/**
 * The two numbers that bound what the artifact archive may keep (§9.4, D23, D24, §10).
 *
 * **A size and an age, and both because neither alone is enough.** A budget on its own lets a
 * quiet month keep everything forever; an age on its own lets a busy week fill the disk inside
 * the window. Whichever bound is reached first is the one that acts, and `./archive-sweep.ts` is
 * where that happens — this module is only the policy's two values and where they come from.
 *
 * **Host-level settings, so they are environment variables** (`ai/RULES.md` §7): the archive is
 * the host's own disk, a client never resolves either value, and no answer carries one. The names
 * follow the archive's existing family — `ROVER_ARTIFACTS_PATH` — rather than the panel's field
 * labels, because what they configure is the artifact tree.
 *
 * **A bad value is a startup failure, never a silent default.** `network-config.ts`'s shape
 * verbatim, and for its reason one step sharper: an operator who typed
 * `ROVER_ARTIFACTS_BUDGET_MB=1gb` must not get 1024 MB quietly and then discover the difference
 * as deleted runs. Zod is the source of truth for what a valid value is, the failure names the
 * variable the operator has to edit, and `./main.ts` is the one place either is read.
 *
 * **Empty counts as unset**, as it does for the socket, the archive root and the kept-tests store:
 * an exported-but-blank variable is what a shell leaves behind.
 *
 * **Zero is refused.** A zero-MB archive and a zero-day window are both *keep nothing*, which no
 * operator sets on purpose — and which the panel's own field already refuses to let one type by
 * accident (`panel/src/system/retention-settings.ts`'s `retentionValueOf`).
 *
 * **The defaults are the System screen's defaults, and a test holds them to it.**
 * {@link DEFAULT_ARTIFACTS_BUDGET_MB} and {@link DEFAULT_ARTIFACTS_MAX_AGE_DAYS} are asserted
 * equal to that module's `DEFAULT_DISK_BUDGET_MB` and `DEFAULT_MAX_AGE_DAYS` by
 * `tests/unit/daemon/archive-retention.test.ts`. The two trees cannot import each other, so
 * without that assertion "the screen and the host must not disagree about the defaults" would be
 * a comment; with it, it is a red suite.
 */

import { z } from 'zod';
import { describeIssues } from '../ipc/protocol.js';

/** Environment variable naming how many megabytes of archive this host may keep. */
export const ARTIFACTS_BUDGET_MB_ENV_VAR = 'ROVER_ARTIFACTS_BUDGET_MB';
/** Environment variable naming how old an archived test may get. */
export const ARTIFACTS_MAX_AGE_DAYS_ENV_VAR = 'ROVER_ARTIFACTS_MAX_AGE_DAYS';

/**
 * **1 GiB**, as an integer count of MB rather than a unit to parse.
 *
 * Deliberately small, which is `panel/src/system/retention-settings.ts`'s own reasoning: of the
 * two ways a default can be wrong, one is recoverable and one is not. A budget set too low
 * deletes runs an operator might have kept — fixed by raising it, and the `Keep` tick already
 * covers the runs that matter (D33) — while one set too high fills the disk the host needs in
 * order to work at all. It is the operator's number to raise.
 */
export const DEFAULT_ARTIFACTS_BUDGET_MB = 1024;

/**
 * **30 days** — long enough that a month-old investigation is still there, short enough that the
 * archive does not grow on the strength of one bound alone.
 */
export const DEFAULT_ARTIFACTS_MAX_AGE_DAYS = 30;

/** How many bytes one megabyte of budget is. MiB, matching how a disk is read on both platforms. */
const BYTES_PER_MB = 1024 * 1024;

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

/**
 * What this host is allowed to keep. Resolved once, in `./main.ts`, and carried as a value —
 * nothing re-reads the environment, so a sweep cannot disagree with the daemon it runs in.
 */
export interface RetentionPolicy {
	readonly budgetMb: number;
	readonly maxAgeDays: number;
}

/**
 * One object rather than two independent parses, so a host with both variables wrong is told
 * about both at once and edits its setup in one pass — `network-config.ts`'s `missingFrom` rule
 * in the shape a coercion needs.
 *
 * `z.coerce.number()` because an environment variable is a string; `.int().positive()` because
 * the setting *is* a count. `1.5`, `-30`, `0` and `1gb` all fail here, naming the variable.
 */
const RetentionPolicySchema = z
	.object({
		budgetMb: z.coerce.number().int().positive(),
		maxAgeDays: z.coerce.number().int().positive(),
	})
	.strict();

/** Which variable a schema field came from, so a failure names what the operator has to edit. */
const ENV_VAR_BY_FIELD: Record<keyof RetentionPolicy, string> = {
	budgetMb: ARTIFACTS_BUDGET_MB_ENV_VAR,
	maxAgeDays: ARTIFACTS_MAX_AGE_DAYS_ENV_VAR,
};

/**
 * Resolve what this host may keep, or throw naming the variable that cannot be read as a number.
 *
 * Unlike the network listener there is no opt-in switch: retention always has a policy, because
 * an archive with no bound is the state §9.4 exists to end. Both variables are therefore optional
 * and both have a default; what is not optional is that a value somebody *did* set means what it
 * says.
 */
export function resolveRetentionPolicy(env: NodeJS.ProcessEnv = process.env): RetentionPolicy {
	const parsed = RetentionPolicySchema.safeParse({
		budgetMb: optional(env[ARTIFACTS_BUDGET_MB_ENV_VAR]) ?? DEFAULT_ARTIFACTS_BUDGET_MB,
		maxAgeDays: optional(env[ARTIFACTS_MAX_AGE_DAYS_ENV_VAR]) ?? DEFAULT_ARTIFACTS_MAX_AGE_DAYS,
	});
	if (!parsed.success) {
		throw new Error(
			`${describeIssues(withEnvVarNames(parsed.error, ENV_VAR_BY_FIELD))}. Both are whole ` +
				`counts above zero — megabytes of archive, and days a test may get — and an empty ` +
				`value counts as unset. This host will not start until one of them is edited: a ` +
				`retention policy it had to guess at is one that would delete by a number nobody ` +
				`chose.`,
		);
	}
	return parsed.data;
}

/** The budget in bytes, which is what a walk of the tree measures. */
export function budgetBytesOf(policy: RetentionPolicy): number {
	return policy.budgetMb * BYTES_PER_MB;
}

/**
 * The instant a test has to be older than to go by age: `nowMs` less the window.
 *
 * A plain instant rather than a duration because that is what the age rule compares against —
 * `./archive-path.ts`'s `runDirectoryPrecedes` formats it with the same function that named the
 * run directory, so nothing ever parses a name (D22).
 */
export function ageCutoffMs(policy: RetentionPolicy, nowMs: number): number {
	return nowMs - policy.maxAgeDays * MS_PER_DAY;
}

/** An exported-but-blank variable is not a setting. `network-config.ts`'s own rule. */
function optional(value: string | undefined): string | undefined {
	return value === undefined || value === '' ? undefined : value;
}

/**
 * Re-labels each issue's path with the variable it came from, so the message names what the
 * operator edits — `network-config.ts`'s own helper, for its own reason. The *message* is never
 * touched, so no rejected value is interpolated into it.
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
