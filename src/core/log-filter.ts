/**
 * What `read_logs`' level, tag and process selections **mean** — one definition every backend
 * applies, so the same call selects the same entries whichever platform answers it (D10, #303).
 *
 * A predicate and nothing more: an entry is in or out. Nothing is ranked, scored or judged
 * (ai/RULES.md §1); a filter only narrows what the device said down to what was asked about.
 *
 * `since` is deliberately **not** here. How a timestamp is printed, and so how two of them
 * order, is a fact about a platform's log, and a backend is the layer that knows its own.
 */

import { type LogEntry, type LogLevel, LogLevelSchema } from './device.js';

/** The selections this module applies. Each is optional, and every present one must hold. */
export interface LogEntrySelection {
	/** The entry's process is one of these — an app's processes, resolved by the backend. */
	readonly pids?: readonly number[];
	readonly pid?: number;
	readonly minLevel?: LogLevel;
	readonly tag?: string;
}

/** Whether `selection` asks for anything this module would apply. */
export function selectsAnything(selection: LogEntrySelection): boolean {
	return (
		selection.pids !== undefined ||
		selection.pid !== undefined ||
		selection.minLevel !== undefined ||
		selection.tag !== undefined
	);
}

/**
 * Whether `entry` is one `selection` asks for.
 *
 * Levels compare by position in {@link LogLevelSchema}'s declared order, least to most severe;
 * tags by exact, case-sensitive equality — a prefix or a pattern would be a different question.
 *
 * **An entry the backend could not read a process or a tag out of matches no process and no
 * tag filter.** Such an entry carries `pid: null` and an empty tag (the parsers' one rule for an
 * unparseable line), and claiming it for a process would be attributing it to somebody on no
 * evidence. It is still a line at its level, so a level filter alone keeps it.
 */
export function selectsLogEntry(entry: LogEntry, selection: LogEntrySelection): boolean {
	if (selection.pids !== undefined && (entry.pid === null || !selection.pids.includes(entry.pid))) {
		return false;
	}
	if (selection.pid !== undefined && entry.pid !== selection.pid) return false;
	if (selection.minLevel !== undefined && severity(entry.level) < severity(selection.minLevel)) {
		return false;
	}
	if (selection.tag !== undefined && entry.tag !== selection.tag) return false;
	return true;
}

function severity(level: LogLevel): number {
	return LogLevelSchema.options.indexOf(level);
}
