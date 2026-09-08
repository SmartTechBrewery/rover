/**
 * The parser for `log show --style ndjson` output — the device's unified log, turned into
 * the neutral entries `src/core/device.ts` declares.
 *
 * Sibling of `./simctl-list.js` and pure for the same reason: it takes the text a runner
 * already captured and returns a shape. Nothing here spawns anything, which is what lets
 * the whole suite run on a machine with no Xcode. Its captures are
 * `tests/fixtures/ios-simulator/unified-log-ndjson.*`, taken off a booted iPhone 17
 * simulator on Xcode 26.4.1 / iOS 26.4.1.
 *
 * **This module is where the platform's vocabulary stops.** `Debug | Info | Default |
 * Error | Fault` becomes the neutral level enum here, so no platform word escapes
 * `src/backends/ios-simulator/` (`tests/unit/no-platform-names.test.ts` is the executable
 * half of that rule). Two of the neutral values are simply never produced — `verbose` and
 * `warn` have no counterpart in this vocabulary at all (`docs/IOS.md` §5) — and that is
 * fine rather than a gap: the enum is a superset by design, and the suite asserts the
 * absence so it stays a decision rather than an accident.
 *
 * **One NDJSON line is one entry, and the last line is not an entry at all.** `--style
 * ndjson` ends its output with a trailer describing that output — `{"count":52,
 * "finished":1}` — which is the exact analogue of the buffer separator
 * `../../android/parsers/logcat.ts` drops, and is dropped here for the same reason. It is
 * the one deliberate drop in this module; everything else the tool printed survives,
 * including a line this parser cannot read.
 *
 * **What is deliberately *not* read is as decided as what is.** Every entry also carries
 * `category`, and folding `subsystem:category` into one `tag` would put a name the device
 * never printed into the field that says who said this — the neutral shape has one field
 * for attribution and `subsystem` is what fills it. `formatString`, `backtrace`,
 * `senderImagePath` and the twenty-odd other keys of an entry are stripped the same way
 * `./simctl-list.js` strips the vendor keys it does not read.
 */

import { z } from 'zod';
import { type LogEntry, LogEntrySchema, type LogLevel } from '../../../core/device.js';

/**
 * The six keys of one NDJSON entry this mapping reads.
 *
 * Non-`.strict()` for the reason `./simctl-list.js`'s `SimctlDeviceSchema` gives verbatim:
 * this is **Apple's** JSON and it grows keys per release. An entry of the committed
 * captures carries twenty-two or twenty-three top-level keys and this reads six, so it is a
 * projection of the entry rather than a record of it.
 *
 * Five of the six are required and one is not, and that split is measured rather than
 * defensive: across 195,947 entries of a 30-minute all-process capture on the bench
 * (Xcode 26.4.1, 2026-09-08) every single one carried `timestamp`, `eventMessage`,
 * `processID`, `subsystem`, `category` and `eventType`, while 25,422 of them carried **no
 * `messageType` key at all** — every `activityCreateEvent`, `stateEvent` and
 * `timesyncEvent` among them. So an absent level is the ordinary shape of this output, not
 * a corrupt line, and {@link LEVELS} has to have a home for it.
 *
 * `subsystem` is an open string including `""`, which is how this output spells *the device
 * attributed the line to nothing* — the exact wording `LogEntry.tag` already carries.
 */
const UnifiedLogEventSchema = z.object({
	/** As the device reported it: `2026-09-08 10:11:34.092155+0200`. Never converted (D17). */
	timestamp: z.string(),
	/** Apple's level word. Absent on every entry that is not a `logEvent` — see this schema. */
	messageType: z.string().optional(),
	/** The subsystem the device attributed the line to, or `""` when it named none. */
	subsystem: z.string(),
	processID: z.number().int().nonnegative(),
	eventMessage: z.string(),
	/**
	 * `logEvent`, `activityCreateEvent`, `stateEvent`, `timesyncEvent`. Read only so that an
	 * entry is told from the trailer by a key rather than by its position in the output.
	 */
	eventType: z.string(),
});

/**
 * Apple's level word, mapped onto the neutral vocabulary once and in one place.
 *
 * These are the five `messageType` prints, and `Default → info` is the one that needs
 * saying: `Default` is what `os_log` emits with no level argument, so it is the platform's
 * ordinary line rather than a sixth severity, and `info` is the neutral word for that.
 * `Fault → fatal` because a fault is the platform's own name for a programming error it
 * captured a backtrace for.
 *
 * There is no key for `warn` because the vocabulary has no word that means it (`docs/IOS.md`
 * §5); inventing one out of `Error` would report a severity the device did not claim.
 *
 * The value type carries `| undefined` deliberately. An index signature makes TypeScript
 * believe every string is a key, so without it the fallback in {@link toEntry} would read as
 * dead code and be correct only by accident.
 */
const LEVELS: Readonly<Record<string, LogLevel | undefined>> = {
	Debug: 'debug',
	Info: 'info',
	Default: 'info',
	Error: 'error',
	Fault: 'fatal',
};

/**
 * The level for an entry whose own is missing or is a word this table does not know.
 *
 * **One rule, and it covers three shapes**: a `messageType` the tool spells `"None"`, an
 * absent `messageType` (the ordinary shape of every entry that is not a `logEvent`), and a
 * word a later release invents. All three become `info`, and the entry keeps every other
 * field the device gave it.
 *
 * `../../android/parsers/logcat.ts`'s own reasoning, which this follows: a line whose level
 * could not be read is not evidence of severity in either direction, and dropping it puts a
 * silent hole in the one verb whose job is to show what a screenshot cannot — a hole being
 * indistinguishable from a device that said nothing. An entry that is not a `logEvent` is
 * still something the device said. `docs/IOS.md` §5 left `None →` open; this is the answer.
 *
 * The one difference from that module is what happens to the *rest* of the line. There, an
 * unreadable level letter means the line did not match at all, so the whole line survives
 * as a message with no timestamp, tag or pid. Here the level is one key of an object whose
 * other five keys read perfectly well, and throwing away a timestamp and a pid this parser
 * is holding would be a loss with nothing behind it.
 *
 * **No capture on this bench carries `"None"`** — not one entry in 195,947, where 25,422
 * carried no `messageType` key instead (Xcode 26.4.1, 2026-09-08). It is in this rule on
 * `docs/IOS.md`'s evidence, from a different bench, and pinned by an inline case in the
 * suite rather than by a fixture, so the behaviour is decided rather than discovered on
 * someone else's machine.
 */
const UNREADABLE_LEVEL: LogLevel = 'info';

/**
 * The trailer `--style ndjson` ends its output with: `{"count":52,"finished":1}`.
 *
 * Recognised **by name** rather than by position, because "the last line" is a property of
 * a complete capture and a caller may well hand over a truncated one. It carries no
 * `eventType`, no `timestamp` and no `eventMessage`, so a `finished` key with no `eventType`
 * beside it is the whole test — narrow enough that an entry can never match it, and loose
 * enough that a release adding a third key to the trailer does not turn it into an entry.
 */
function isTrailer(decoded: unknown): boolean {
	return (
		typeof decoded === 'object' &&
		decoded !== null &&
		'finished' in decoded &&
		!('eventType' in decoded)
	);
}

/**
 * A line this parser could not read, kept rather than dropped.
 *
 * `../../android/parsers/logcat.ts`'s `unparseable()` verbatim, and it exists here for a
 * shape that module never sees: output that is not the format at all. On a host whose
 * `xcode-select` points at CommandLineTools the tool prints a sentence of English instead
 * of JSON (`docs/IOS.md` §1), and a caller that merged the two streams hands exactly that
 * text to this function. It becomes an `info` entry carrying the line, so the sentence
 * reaches whoever asked for the log instead of being swallowed on the way.
 */
function unparseable(line: string): LogEntry {
	return { timestamp: '', level: UNREADABLE_LEVEL, tag: '', pid: null, message: line };
}

function toEntry(decoded: unknown, line: string): LogEntry {
	const event = UnifiedLogEventSchema.safeParse(decoded);
	if (!event.success) return unparseable(line);

	const { timestamp, messageType, subsystem, processID, eventMessage } = event.data;
	const level = messageType === undefined ? undefined : LEVELS[messageType];

	return {
		timestamp,
		level: level ?? UNREADABLE_LEVEL,
		tag: subsystem,
		pid: processID,
		message: eventMessage,
	};
}

/**
 * Every entry in one captured unified-log dump, oldest first — the order the device printed
 * them in, which is also the order they are useful in.
 *
 * The trailer is dropped and nothing else is: blank lines carry nothing to keep, and a line
 * that is neither JSON nor an entry survives as itself ({@link unparseable}). Nothing is
 * trimmed out of a message either — a message's own leading or trailing space is the
 * device's text, not this parser's to tidy.
 *
 * **This takes whatever the query already narrowed to, and narrowing is the caller's job.**
 * Unfiltered, `log show --last 20s` answered 92,204 entries against 268 for the same window
 * scoped to one process (`docs/IOS.md` §5), so a caller that does not push a predicate down
 * hands this function seconds of the host's own noise to turn into objects. There is nothing
 * this module can do about that from here, which is exactly why it is said here.
 *
 * `LogEntrySchema.parse` on the way out is what makes "these fields, from these keys" a
 * checked claim rather than a comment.
 */
export function parseUnifiedLog(stdout: string): LogEntry[] {
	const entries: LogEntry[] = [];

	for (const line of stdout.split('\n')) {
		if (line.trim().length === 0) continue;

		let decoded: unknown;
		try {
			decoded = JSON.parse(line);
		} catch {
			entries.push(LogEntrySchema.parse(unparseable(line)));
			continue;
		}
		if (isTrailer(decoded)) continue;

		entries.push(LogEntrySchema.parse(toEntry(decoded, line)));
	}

	return entries;
}
