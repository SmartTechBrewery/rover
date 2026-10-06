/**
 * How a `read_logs` selection (#303) is pushed **into** `log show` — the predicate, the level
 * flags, the `--start` anchor and the argv they assemble into.
 *
 * Pure and spawn-free, like `./input.js` and the parsers: this is the vocabulary of the query,
 * and `./backend.ts` is the only thing that runs one. Keeping it here is what lets the generated
 * predicate be pinned as an exact string without a simulator, which is the only way to check a
 * pushdown at all — a wrong predicate does not fail, it answers fewer entries.
 *
 * **A pushdown narrows; the host filter decides.** Every selection is applied twice: once here,
 * so that `simctl spawn` serialises candidates rather than the whole log (unfiltered, a 30 s
 * window on this module's bench was 4,316 entries / 5.4 MB against 1,151 / 1.4 MB for one
 * process), and once on the host with `src/core/log-filter.ts`, which is what makes the iOS
 * answer mean exactly what the Android answer means. The one invariant everything here must
 * hold to: **what is pushed down must select a superset of what the host filter keeps.** The
 * host filter can discard what a generous pushdown let through; it cannot restore what a strict
 * one dropped.
 *
 * Every form below was run against a booted simulator on macOS 27.0.1 (26A434) / Xcode 26.4.1
 * (17E202) / iOS 26.4.1 (23E254a), 2026-10-06, and the measurements are in `PROJECT.md` §6.
 */

import type { LogEntry, LogLevel } from '../../core/device.js';
import type { LogEntrySelection } from '../../core/log-filter.js';

/**
 * The two flags that decide which levels `log show` answers at all.
 *
 * **Not optional on an unselected read**, which is why they are the default rather than an
 * addition: without them the tool answers neither `Info` nor `Debug` — measured again on this
 * bench, one process over 30 s came back as `Default` 206, `Error` 20 and 10 entries with no
 * `messageType`, against `Info` 176 / `Default` 788 / `Error` 74 / `Fault` 1 / absent 122 with
 * both flags. A read that left them off would silently omit two of the five levels this platform
 * has (`./parsers/unified-log.js`).
 */
const INFO_FLAG = '--info';
const DEBUG_FLAG = '--debug';

/**
 * Apple's `messageType` words, as the *predicate* spells them — lowercase and **unquoted**.
 *
 * Measured: `--predicate '(messageType == error OR messageType == fault)'` answered 217 entries
 * carrying exactly `Error` and `Fault`, so the keyword form works and needs neither quotes nor
 * the numeric code that circulates for it. The capitalised words in `./parsers/unified-log.js`
 * are what the *output* carries; these are what the query takes.
 */
const ERROR_TYPE = 'error';
const FAULT_TYPE = 'fault';

/**
 * Which level flags a `minLevel` leaves on, and nothing more — the flags are a *lookback* over
 * levels, so dropping one can only ever narrow the answer.
 *
 * - `verbose` and `debug`: both flags stay. Every level this platform prints is at or above
 *   them, so there is nothing to drop.
 * - `info`: `--debug` goes. Measured, `--info` alone still answers `Info`, `Default`, `Error`,
 *   `Fault` and the entries carrying no `messageType` key — and those map to `info`
 *   (`./parsers/unified-log.js`), so they must survive.
 * - `warn`, `error`, `fatal`: both go, and {@link logPredicate} adds the `messageType` clause
 *   that does the real narrowing. Dropping `--info` alone would be wrong without that clause,
 *   because a no-`messageType` entry is an `info` entry rather than a severe one.
 *
 * iOS has no `warn` at all (`docs/IOS.md` §5), so `warn` and `error` select the same set — which
 * is the honest answer rather than a gap: the device never claimed a severity between the two.
 */
export function levelFlags(minLevel: LogLevel | undefined): string[] {
	if (minLevel === undefined || minLevel === 'verbose' || minLevel === 'debug') {
		return [INFO_FLAG, DEBUG_FLAG];
	}
	if (minLevel === 'info') return [INFO_FLAG];
	return [];
}

/**
 * The `--predicate` for one selection, or `undefined` when nothing in it maps to a clause.
 *
 * Clauses are joined with ` AND ` in {@link LogFilterSchema}'s own order — the app's pids, the
 * pid, the level, the tag — so two equal selections generate one string and a suite can pin it.
 * Each clause that holds an `OR` is parenthesised, because NSPredicate binds `AND` tighter and
 * an unbracketed `a OR b AND c` would widen the answer rather than narrow it.
 *
 * **`tag` is the *subsystem*, and that is a decision rather than a default.**
 * `./parsers/unified-log.js` fills `LogEntry.tag` from `subsystem` and deliberately never reads
 * `category`, so a tag copied out of an entry selects the entries that carry it. Selecting on
 * `category` instead would filter by a field the answer does not show, which is the
 * plausible-looking wrong answer ai/RULES.md §2 forbids.
 *
 * **Only the tag is caller-chosen text**, and it goes in as an NSPredicate string literal with
 * `\` and `"` escaped ({@link quoted}). Pids and level words are generated here. The predicate
 * is one argv entry handed to `execFile` (`./simctl.js`), so no shell parses it and NSPredicate's
 * own escaping is the whole of the quoting needed. Measured: `subsystem == "a\"b\\c"` is
 * accepted and matches nothing, while a malformed predicate fails loudly — exit 64, `log: Bad
 * predicate (Unable to parse the format string …)`. And even a tag that somehow left its literal
 * could not widen the answer, because the host filter re-applies the exact string.
 */
export function logPredicate(selection: LogEntrySelection): string | undefined {
	const clauses: string[] = [];

	if (selection.pids !== undefined) clauses.push(anyProcess(selection.pids));
	if (selection.pid !== undefined) clauses.push(oneProcess(selection.pid));

	const level = levelClause(selection.minLevel);
	if (level !== undefined) clauses.push(level);

	if (selection.tag !== undefined) clauses.push(`subsystem == ${quoted(selection.tag)}`);

	return clauses.length === 0 ? undefined : clauses.join(' AND ');
}

/**
 * The log read's argv, every flag load-bearing and every one measured — this is the *guest*
 * program's argv, handed to `simctl spawn` after the udid (`./backend.ts`'s header).
 *
 * - **`log show`**, never `log stream`. A tail that stays open is a wait with no condition
 *   (ai/RULES.md §2) and a stream over IPC (D19); this is a bounded read that returns.
 * - **`--style ndjson`** is the shape `./parsers/unified-log.js` is pinned against: one entry per
 *   line, plus a trailer describing the output that the parser drops.
 * - **The level flags** are {@link levelFlags}' — both of them unless `minLevel` says otherwise.
 * - **`--predicate`** is {@link logPredicate}'s, absent when nothing was selected.
 * - **The bound** is either `--last <width>`, one of `./backend.js`'s `LOG_WINDOWS`, or
 *   `--start <anchor>` when the caller gave a `since`. Never both: `--start` runs to *now*
 *   (measured — an anchor 22 s back answered entries up to the moment of the call), so a width
 *   beside it would be a second, contradictory lower bound.
 *
 * The order is fixed so that a read with no selections generates byte-identical argv to the one
 * this backend has always sent, which the unit suite pins.
 */
export function readLogsArgv(
	bound: { readonly last: string } | { readonly start: string },
	flags: readonly string[],
	predicate: string | undefined,
): string[] {
	return [
		'log',
		'show',
		'--style',
		'ndjson',
		...flags,
		...(predicate === undefined ? [] : ['--predicate', predicate]),
		...('last' in bound ? ['--last', bound.last] : ['--start', bound.start]),
	];
}

/**
 * Whether `value` is a timestamp in the shape this log's own entries carry — what a `since`
 * selection must be, since it is taken from an entry and compared against entries.
 *
 * `2026-10-06 14:54:08.135887+0200`: fixed-width date and time, a fraction of at least one
 * digit, and an offset that is always present. `../android/parsers/logcat.ts`'s
 * `isLogcatTimestamp` is the counterpart, and the two shapes are deliberately incompatible — an
 * anchor taken from an Android entry is refused here by name rather than silently ordering
 * wrongly.
 */
export function isUnifiedLogTimestamp(value: string): boolean {
	return WHOLE_TIMESTAMP.test(value);
}

/**
 * The `--start` argument for a `since` — the same instant **floored to the second**.
 *
 * **The fraction is dropped because the tool refuses it**, not as an optimisation: measured on
 * this bench, `--start '2026-10-06 14:54:08.135887+0200'` fails with *"Failed conversion of …
 * using format '%Y-%m-%d %H:%M:%S%z'"*. That format string is also where the offset's form comes
 * from — `+0200`, exactly as an entry prints it, and exactly what `%z` reads.
 *
 * Flooring is safe in the one direction that matters: it moves the device-side bound *earlier*,
 * so the read is a superset and the host comparison then drops the entries in the anchor's own
 * second that are before it. Measured: an anchor of `…:08+0200` answered from `…:08.124559`,
 * which is earlier than the `…:08.135887` entry it was taken from.
 *
 * Only ever called with a value {@link isUnifiedLogTimestamp} accepted, which is what makes the
 * slice safe rather than hopeful.
 */
export function startOf(since: string): string {
	const parts = WHOLE_TIMESTAMP.exec(since);
	if (parts === null) throw new Error(`not a timestamp this log prints: ${since}`);

	return `${parts[1]}${parts[3]}`;
}

/**
 * Whether `entry` is at or after `since` — or `since` was not asked for.
 *
 * **Compared as instants rather than as strings**, which is the one thing that cannot be copied
 * from `../android/backend.ts`: these timestamps carry a UTC offset, and an offset that changed
 * across a DST boundary makes string order disagree with time order. `01:45:00+0100` is a later
 * instant than `02:30:00+0200`, and a string comparison puts them the other way round.
 *
 * An entry whose timestamp is empty or unreadable is at no point in time, so it is not at or
 * after anything — the Android side's rule verbatim. That is an unparseable line
 * (`./parsers/unified-log.js`), and claiming a position in time for it would be inventing one.
 */
export function isAtOrAfter(entry: LogEntry, since: string | undefined): boolean {
	if (since === undefined) return true;

	const at = instantOf(entry.timestamp);
	const anchor = instantOf(since);
	return at !== null && anchor !== null && at >= anchor;
}

/**
 * One of this log's timestamps as microseconds since the epoch, or `null` when it is not one.
 *
 * Exact in a `Number`: 2026 is about 1.8 × 10^15 µs past the epoch, three orders of magnitude
 * inside `Number.MAX_SAFE_INTEGER`, so no precision is lost and no `BigInt` is needed.
 *
 * **This is not the D17 conversion that is forbidden.** Nothing converted here reaches the
 * caller — it compares two of the *device's own* timestamps against each other, and what the
 * answer carries is still the string the device printed (`LogEntry.timestamp`). Converting a
 * client's clock into a device's is the thing D17 refuses, and a `since` is an entry's own
 * timestamp rather than a clock reading.
 *
 * The fraction is read to microsecond precision: padded when a release prints fewer digits,
 * truncated when it prints more. Truncation floors, which keeps two entries in the same
 * microsecond comparing equal rather than reordering them.
 */
export function instantOf(timestamp: string): number | null {
	const parts = WHOLE_TIMESTAMP.exec(timestamp);
	if (parts === null) return null;

	const date = parts[1] ?? '';
	const fraction = parts[2] ?? '';
	const offset = parts[3] ?? '';

	// Read as if the wall clock were UTC, then moved by the offset the device printed beside it:
	// `+0200` means the instant is two hours *earlier* than the same digits read as UTC.
	const asUtcMs = Date.parse(`${date.replace(' ', 'T')}Z`);
	if (Number.isNaN(asUtcMs)) return null;

	const offsetMinutes = Number(offset.slice(1, 3)) * 60 + Number(offset.slice(3, 5));
	const sign = offset.startsWith('-') ? 1 : -1;

	return (
		(asUtcMs + sign * offsetMinutes * 60_000) * 1_000 +
		Number(`${fraction}000000`.slice(0, MICROSECOND_DIGITS))
	);
}

/** How many digits of the fraction a microsecond-precision instant keeps. */
const MICROSECOND_DIGITS = 6;

/**
 * The date and time, the fraction, and the offset — the three pieces {@link startOf},
 * {@link instantOf} and {@link isUnifiedLogTimestamp} all need, written once so the shape this
 * module accepts and the shape it takes apart cannot drift.
 *
 * The separator is the space the device prints rather than ISO 8601's `T`; `instantOf` swaps it
 * where it needs one, which keeps this pattern the shape of what was actually measured.
 */
const WHOLE_TIMESTAMP = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\.(\d+)([+-]\d{4})$/;

/** `processIdentifier == <n>`, the clause a single process selects with. */
function oneProcess(pid: number): string {
	return `processIdentifier == ${pid}`;
}

/**
 * The clause an app's processes select with — parenthesised, because it is the one that holds an
 * `OR` and `AND` binds tighter.
 *
 * Measured with two pids: `(processIdentifier == 49847 OR processIdentifier == 26209)` answered
 * 1,151 and 3 entries respectively and nothing else.
 *
 * An empty list cannot reach here — `./backend.ts` refuses an app with no running process by
 * name before any read — and this would generate `()` if it did, which `log` would reject
 * loudly rather than answer everything.
 */
function anyProcess(pids: readonly number[]): string {
	return `(${pids.map(oneProcess).join(' OR ')})`;
}

/**
 * The `messageType` clause for a `minLevel`, or `undefined` when the level flags alone carry it.
 *
 * `fatal` is `Fault` alone; `warn` and `error` are both of the words at or above `error`, since
 * this platform has no `warn`. Nothing below that needs a clause: `verbose`, `debug` and `info`
 * are reached by leaving the flags on, and an entry with no `messageType` at all is an `info`
 * entry that a clause naming words would wrongly exclude.
 */
function levelClause(minLevel: LogLevel | undefined): string | undefined {
	if (minLevel === 'fatal') return `messageType == ${FAULT_TYPE}`;
	if (minLevel === 'warn' || minLevel === 'error') {
		return `(messageType == ${ERROR_TYPE} OR messageType == ${FAULT_TYPE})`;
	}
	return undefined;
}

/**
 * `value` as an NSPredicate string literal.
 *
 * Two characters are special inside one and both are escaped with a backslash: the backslash
 * itself, first so the escapes it introduces are not re-escaped, and the double quote that would
 * otherwise end the literal.
 */
function quoted(value: string): string {
	return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}
