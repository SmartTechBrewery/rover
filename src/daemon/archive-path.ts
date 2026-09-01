/**
 * Where the durable artifact archive lives, and how an opaque caller string becomes one
 * path segment (D22, D23, D24; PROJECT.md §10).
 *
 * **Pure functions plus one environment lookup.** Nothing here touches a disk, so the shape
 * of the tree — the part a future read-only viewer reads directly (D24) — is testable
 * without one, and `./archive.ts` is left with only the writing.
 *
 * **Sanitising is not validating.** `project`, `test_name`, the lease's `owner` and the
 * device serial are opaque strings the core never parses (D22, ai/CODING_STANDARDS.md
 * "Never parse a serial to infer anything"), and {@link pathSegment} does not start doing
 * so: nothing branches on what a string *says*. What it does is make the string safe to be
 * one component of a path — a caller who wrote `../../etc` gets a directory, not an escape —
 * and it does that by shape rather than by a blocklist of what somebody thought of, the way
 * `USER_IDENTIFIER` in `./user-store.ts` is written.
 *
 * **A rewritten segment carries a hash of the original.** Two hostile strings that sanitise
 * to the same visible text would otherwise share one directory, and the before/after diff
 * this archive exists for would be comparing two callers' runs. The common case — a string
 * that needed no rewriting — is left exactly as the caller typed it, because a tree meant to
 * be browsed by a human must stay readable.
 *
 * **Known and accepted:** a case-insensitive filesystem (the macOS default) folds `Home` and
 * `home` into one directory. Two mechanisms for one class of collision is not worth it; the
 * hash above covers the case that is actually reachable by accident.
 */

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Lease } from './leases.js';

/** Environment variable naming the archive root, for tests and for a non-default install. */
export const ARTIFACTS_PATH_ENV_VAR = 'ROVER_ARTIFACTS_PATH';

/**
 * The longest one path component may be, before the collision suffix.
 *
 * 255 bytes is the per-component limit every filesystem this runs on has, and the strings
 * arriving here are bounded by nothing — `project` and `test_name` are opaque and
 * unvalidated (D22). 64 leaves the suffix room and keeps a directory listing readable.
 */
export const MAX_SEGMENT_LENGTH = 64;

/** How many hex characters of a SHA-256 disambiguate a rewritten segment or a lease id. */
const SHORT_HASH_CHARS = 8;

/** `~/.rover/artifacts` — beside `rover.sock` and `users.json`, the host's own data. */
export function defaultArtifactsRoot(): string {
	return join(homedir(), '.rover', 'artifacts');
}

/**
 * Resolve the root the archive writes under.
 *
 * An empty value counts as unset, exactly as it does for the socket and the user store: an
 * exported-but-blank variable is what a shell leaves behind, and reading it as a real
 * setting would start filing artifacts under the current directory.
 */
export function resolveArtifactsRoot(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env[ARTIFACTS_PATH_ENV_VAR];
	return configured === undefined || configured === '' ? defaultArtifactsRoot() : configured;
}

/**
 * Turn one opaque string into one path component.
 *
 * Five steps, in this order: everything outside `[A-Za-z0-9._-]` becomes `_`, so no
 * separator of any platform survives; leading `.` and `-` runs go, which kills `.`, `..`,
 * a hidden directory and a component that could read as a flag; the result is truncated;
 * an empty result becomes `_`; and if any of that changed the string, a short hash of the
 * **caller's original** is appended so two different inputs cannot land in one directory.
 */
export function pathSegment(raw: string): string {
	const replaced = raw.replace(/[^A-Za-z0-9._-]/g, '_');
	const stripped = replaced.replace(/^[.-]+/, '');
	const truncated = stripped.slice(0, MAX_SEGMENT_LENGTH);
	const safe = truncated === '' ? '_' : truncated;
	return safe === raw ? safe : `${safe}-${shortHash(raw)}`;
}

/**
 * The lease's own directory — `<timestamp>-<owner>-<hash>` (PROJECT.md §10), **derived from
 * the lease rather than being its id**.
 *
 * The timestamp leads because that is what makes "the two most recent runs of this named
 * check are the two sides of the diff" an `ls` rather than a query (D24): the format sorts
 * chronologically as text. The owner is there so a human reading the listing can tell whose
 * run it was (D16).
 *
 * The hash is over the **lease id**, and the id itself never appears: a lease id is the
 * credential that ends a lease (D20, `src/core/ids.ts`), and a tree shaped to be browsed by
 * a human and later served by a read-only panel (D24) must not have live credentials in its
 * path names. Hashing keeps the directory self-disambiguating without publishing one.
 */
export function leaseDirectoryName(lease: Lease): string {
	return `${archiveTimestamp(lease.createdAtMs)}-${pathSegment(lease.owner)}-${shortHash(lease.id)}`;
}

/**
 * The one directory this lease's artifacts for this device go in:
 * `<root>/<project>/<test_name>/<lease>/<device-serial>`.
 *
 * **Always four levels**, and the shape never branches on whether a field was supplied: all
 * three caller strings are required (D22, as amended #129), so there is no missing level to
 * stand in for and no fixed directory name invented for a lease that named nothing. Anything
 * walking this tree counts on that.
 *
 * Every component goes through {@link pathSegment}, which is the whole of the containment
 * guarantee — no component can be `..`, contain a separator, or start with a `.`.
 */
export function leaseArchiveDirectory(root: string, lease: Lease): string {
	return join(
		root,
		pathSegment(lease.project),
		pathSegment(lease.testName),
		leaseDirectoryName(lease),
		pathSegment(lease.serial),
	);
}

/**
 * A host-local instant as `20260830T170501Z` — ISO 8601 basic format, UTC.
 *
 * Basic rather than extended because `:` is not a path character everywhere, and seconds
 * rather than milliseconds because the directory name is read by people; two leases inside
 * one second are separated by the hash beside it, not by more digits.
 */
function archiveTimestamp(instantMs: number): string {
	return new Date(instantMs)
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d+Z$/, 'Z');
}

/** The first {@link SHORT_HASH_CHARS} hex characters of a SHA-256 — never reversible back. */
function shortHash(raw: string): string {
	return createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, SHORT_HASH_CHARS);
}
