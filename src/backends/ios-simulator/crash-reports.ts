/**
 * A simulator's crashes, read off **this host** — the `crash` stream of `read_logs` on this
 * platform (#323).
 *
 * **Why this is a directory and not a log query.** A simulator's process is a process of this
 * Mac, so when one dies the Mac's own crash reporter writes an `.ips` report into the operator's
 * `~/Library/Logs/DiagnosticReports` — the simulator's unified log never holds it, and `log show`
 * cannot answer it. Measured on macOS 26.6.2 (25G83) / Xcode 27.0 (27A266a) / iOS 26.5 (23F77),
 * 2026-10-06, with Settings crashed from the host by `kill -SEGV` and `kill -ABRT` on two booted
 * simulators: each report landed there as `Preferences-2026-10-06-152809.ips` (the process
 * name and the write time), 23 s and under a second after the kill, 109,128 and 10,480 bytes,
 * and nothing landed in `Retired/` (`PROJECT.md` §6).
 *
 * **Every simulator on this host writes into the one directory**, along with every crash of the
 * Mac's own apps, so a report is answered only once two things in **the report itself** place it
 * on this device and inside this lease:
 *
 * - **The device: `coalitionName`.** Both captures carry
 *   `com.apple.CoreSimulator.SimDevice.<udid>`, each naming its own simulator, and it is matched
 *   whole. The process name cannot do this — two simulators running Settings print the same one —
 *   and neither can `procPath`, the field #323's plan reached for first: the reporter redacts it
 *   to `/Volumes/VOLUME/` plus a wildcard and the bundle's own path, the same string on every
 *   device. A report
 *   with no `coalitionName` is attributed to nobody and is not answered.
 * - **The lease: `captureTime` at or after the bound.** The bound is the lease's grant time,
 *   which the daemon sets (`ReadLogsOptions.recordsSinceMs`); a report captured before it is the
 *   previous holder's crash and is never answered, even on the same device. Both are this host's
 *   clock, since a simulator has no other, so this compares two host instants (D17).
 *
 * **Cheap refusals come first.** A file whose `mtime` is older than the bound is skipped on a
 * `stat` alone — a report is written *after* its crash, so the write time bounds the capture
 * time from above — and a file over {@link MAX_CRASH_REPORT_BYTES} is skipped without being read.
 * Nothing here deletes, moves or rewrites a report: they are the operator's files, and removing
 * them is not a read.
 */

import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LogEntry } from '../../core/device.js';
import { type DeviceSerial, unwrap } from '../../core/ids.js';
import { instantOf } from './log-query.js';
import { parseCrashReport } from './parsers/crash-report.js';

/** Where the reports land, under the home directory of the user this host runs as (header). */
export const CRASH_REPORTS_RELATIVE_PATH = join('Library', 'Logs', 'DiagnosticReports');

/** The extension of a report; the directory also holds `.diag` files and a `Retired/` folder. */
const REPORT_EXTENSION = '.ips';

/** The coalition every process of one simulator runs in, followed by its udid (header). */
const DEVICE_COALITION_PREFIX = 'com.apple.CoreSimulator.SimDevice.';

/**
 * The largest report read — 2 MiB, eighteen times the larger capture (109,128 bytes).
 *
 * A report's size is its threads and loaded images, so a large app's is larger, and a report is
 * read whole to be parsed; this keeps one pathological file from costing a log read its budget.
 * A report over it is skipped, which is a stated hole rather than a silent one: it is here and in
 * `docs/IOS.md` §5.
 */
export const MAX_CRASH_REPORT_BYTES = 2 * 1024 * 1024;

/** Where to look — the home directory is the operator's in production and a temp one in tests. */
export interface ReadCrashReportsOptions {
	readonly home?: string;
}

/**
 * One fatal entry per crash report written for `serial`'s processes and captured at or after
 * `sinceMs`, oldest first.
 *
 * A missing directory is no crashes rather than a failure: a host that has never crashed
 * anything has none, and that is the honest answer. Any other failure to list it is thrown.
 */
export async function readCrashReports(
	serial: DeviceSerial,
	sinceMs: number,
	options: ReadCrashReportsOptions = {},
): Promise<LogEntry[]> {
	const directory = join(options.home ?? homedir(), CRASH_REPORTS_RELATIVE_PATH);
	const coalition = `${DEVICE_COALITION_PREFIX}${unwrap(serial)}`;

	let files: Dirent[];
	try {
		files = await readdir(directory, { withFileTypes: true });
	} catch (cause) {
		if (isMissing(cause)) return [];
		throw cause;
	}

	const entries: LogEntry[] = [];
	for (const file of files) {
		if (!file.isFile() || !file.name.endsWith(REPORT_EXTENSION)) continue;

		const entry = await crashIn(join(directory, file.name), coalition, sinceMs);
		if (entry !== undefined) entries.push(entry);
	}

	return entries.sort(
		(left, right) => (instantOf(left.timestamp) ?? 0) - (instantOf(right.timestamp) ?? 0),
	);
}

/**
 * The entry for the report at `path`, or `undefined` when it is not one to answer — gone between
 * the listing and here, written before the bound, too large to read, not a readable crash, not
 * this device's, or captured before the bound.
 */
async function crashIn(
	path: string,
	coalition: string,
	sinceMs: number,
): Promise<LogEntry | undefined> {
	const stats = await stat(path).catch(() => undefined);
	if (stats === undefined || stats.mtimeMs < sinceMs || stats.size > MAX_CRASH_REPORT_BYTES) {
		return undefined;
	}

	const text = await readFile(path, 'utf8').catch(() => undefined);
	const report = text === undefined ? undefined : parseCrashReport(text);
	if (report === undefined || report.coalitionName !== coalition) return undefined;

	const capturedAt = instantOf(report.entry.timestamp);
	return capturedAt !== null && capturedAt >= sinceMs * 1_000 ? report.entry : undefined;
}

function isMissing(cause: unknown): boolean {
	return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT';
}

/**
 * `log` and `crashes` as one stream in time order — each already oldest first, so this is a
 * merge rather than a sort.
 *
 * **A merge, because a sort would move entries that have no time.** An unparseable line of the
 * unified log carries an empty timestamp (`./parsers/unified-log.js`) and sits where the device
 * printed it; a sort would have to invent an instant for it. So the log's own order is kept
 * whole and each crash goes in after the last entry at or before its instant.
 */
export function mergeCrashes(log: readonly LogEntry[], crashes: readonly LogEntry[]): LogEntry[] {
	const merged: LogEntry[] = [];
	let next = 0;

	for (const entry of log) {
		const at = instantOf(entry.timestamp);
		while (at !== null && next < crashes.length && instantAt(crashes, next) < at) {
			merged.push(crashes[next] as LogEntry);
			next += 1;
		}
		merged.push(entry);
	}

	return merged.concat(crashes.slice(next));
}

/** The instant of `entries[index]` — always a timestamp, since only placed crashes reach here. */
function instantAt(entries: readonly LogEntry[], index: number): number {
	return instantOf(entries[index]?.timestamp ?? '') ?? 0;
}
