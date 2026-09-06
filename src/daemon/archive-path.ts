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
 *
 * **A label goes into an artifact's file name here and comes back out of it here** —
 * {@link labelled} and {@link filedLabelOf}, one module owning both halves of one layout (#178).
 * `./archive.ts` writes the name and `./list-archive-groups.ts` reads it, and neither one holds a
 * second account of it that could drift; `tests/unit/daemon/archive.test.ts` pins the round trip
 * against what the writer actually puts on disk. What comes back out is the label **as the archive
 * filed it**, never the caller's own string — `pathSegment` is not reversible, and nothing may
 * present its output as an input.
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

/**
 * The sequence number with the call's label after it — `001` becomes `001_before` — or the
 * sequence number exactly as it was for a call that carried none.
 *
 * **Through {@link pathSegment} like every other caller string that becomes part of a path**, so
 * a label carrying a separator, a leading dot or anything outside `[A-Za-z0-9._-]` is one
 * component and not an escape, and two labels that sanitise alike land on two names rather than
 * one (the collision hash). It is the one place a label is looked at, and it is looked at for its
 * *shape* and never for what it says (D22).
 *
 * **Absent adds nothing at all** — not an empty segment, not a placeholder — so an unlabelled
 * screenshot is still `001_screenshot.png` and the tree of a caller who never used this feature
 * is byte for byte the tree it was before (#129's lesson, applied to a file name).
 *
 * **It lives here rather than in `./archive.ts` so that one module owns a label going into a name
 * and coming back out of it** — {@link filedLabelOf} is its inverse, and a reader that lived
 * somewhere else would be a second, drifting account of the same layout.
 */
export function labelled(ordinal: string, label: string | undefined): string {
	return label === undefined ? ordinal : `${ordinal}_${pathSegment(label)}`;
}

/**
 * The fixed strings the archive writes *after* the label, one per artifact kind that has one
 * (PROJECT.md §10): `<seq>_<label>_screenshot.png`, `<seq>_<label>_read_logs.txt` and the
 * `<seq>_<label>_frames` directory beside a recording. A recording itself has none —
 * `<seq>_<label>.mp4` — which is why the empty case has to be a legal parse below.
 *
 * Split by whether the name carries an extension, and that is not tidiness. Every file the
 * archive writes gets one (`.bin` is the fallback, never nothing), and the frames *directory*
 * never does — so a recording whose filed label is exactly `frames` (`001_frames.mp4`) is read
 * as labelled rather than mistaken for a frame directory, and a frame directory whose label is
 * `frames` (`001_frames_frames`) still reads as labelled too.
 */
const SUFFIXES_AFTER_AN_EXTENSION = ['screenshot', 'read_logs'] as const;
const SUFFIXES_WITHOUT_AN_EXTENSION = ['frames'] as const;

/**
 * What one archived artifact's name says its label was, or `null` for one that carries none.
 *
 * **The inverse of {@link labelled}, and it recovers the *filed* text and nothing else.**
 * `pathSegment` ran on the way in — everything outside `[A-Za-z0-9._-]` became `_`, the result was
 * truncated at {@link MAX_SEGMENT_LENGTH}, and a rewritten string picked up a hash of the
 * caller's original — and none of that is reversible. So what comes back out is **what the archive
 * called it**, never the caller's own string, and nothing may present it as one; that is the rule
 * `docs/DESIGN.md` §9 already states for `OWNER`, applied to a file name.
 *
 * It is still an identity that behaves, which is the whole reason it is worth answering: an
 * unrewritten label is itself, and a rewritten one carries a hash of the original, so two
 * different labels essentially never arrive here as one string. *The same label is the same thing
 * at two moments* is exactly what a reader of a group needs and all a reader can honestly claim.
 *
 * Four steps, answering `null` at the first one that does not hold:
 *
 * 1. Strip an extension — a trailing `.` plus a run of alphanumerics, which is every extension
 *    this archive writes and is deliberately narrower than *everything after the last dot*: a
 *    label may itself contain a `.`, and `001_a.b_frames` is a directory with no extension at all.
 * 2. Strip a trailing `_<suffix>` from the vocabulary above, chosen by whether step 1 found an
 *    extension.
 * 3. Split what is left at its **first** `_`. No `_` at all means no label. A head that is not a
 *    non-empty run of ASCII digits is not a sequence number, so the name is not an artifact's —
 *    `device_info.json`, `group_id.json` and `test_description.json` all leave here.
 * 4. The tail is the filed label, or `null` when it is empty.
 *
 * **One narrow case it cannot recover, recorded rather than hidden.** A *recording* is the one
 * artifact written with no suffix, so a recording whose filed label is exactly `screenshot` or
 * `read_logs`, or ends in `_screenshot` or `_read_logs`, is read as though that tail were the
 * suffix — `001_home_screenshot.mp4` answers `home`. The parse cannot go the other way without
 * making an *unlabelled* screenshot (`001_screenshot.png`, which must answer `null`) ambiguous,
 * and the extension does not settle it because `.bin` is the fallback for both kinds. It is the
 * same reason every document here tells a caller to keep a label short and identifier-shaped.
 */
export function filedLabelOf(name: string): string | null {
	const extension = /\.[A-Za-z0-9]+$/.exec(name);
	const stem = extension === null ? name : name.slice(0, extension.index);
	const suffixes = extension === null ? SUFFIXES_WITHOUT_AN_EXTENSION : SUFFIXES_AFTER_AN_EXTENSION;

	let body = stem;
	for (const suffix of suffixes) {
		if (stem.endsWith(`_${suffix}`)) {
			body = stem.slice(0, -(suffix.length + 1));
			break;
		}
	}

	const separator = body.indexOf('_');
	if (separator <= 0 || !/^\d+$/.test(body.slice(0, separator))) {
		return null;
	}
	const label = body.slice(separator + 1);
	return label === '' ? null : label;
}
