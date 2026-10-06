/**
 * The parser for one `.ips` crash report — the file this host writes when a simulator's process
 * dies — turned into the one neutral log entry `read_logs`' `crash` stream answers with (#323).
 *
 * Pure, and beside `./unified-log.js` for that module's reason: `../crash-reports.ts` finds and
 * reads the files, and what a file *is* belongs here, pinned against captures on a machine with
 * no Xcode. Its captures are `tests/fixtures/ios-simulator/crash-report.*.ips`, two crashes of
 * Settings on two simulators of one host, macOS 26.6.2 (25G83) / Xcode 27.0 (27A266a) / iOS 26.5
 * (23F77), 2026-10-06 (`PROJECT.md` §6).
 *
 * **An `.ips` file is two JSON documents, not one.** Line one is a header object
 * (`{"app_name":"Preferences","timestamp":…,"bug_type":"309",…}`) and everything after the first
 * newline is the body, pretty-printed across two thousand lines in the larger capture. Neither
 * half parses as the other, so the split is on the first newline and nothing else.
 *
 * **A report this cannot read is rejected, not kept as an unparseable entry** — the one place
 * this backend's log parsing departs from `./unified-log.js`'s keep-everything rule, and the
 * reason is attribution. A crash is only answered once the report itself names this device and
 * a time after the lease began (`../crash-reports.ts`); a file whose body did not parse names
 * neither, so keeping it would be answering a report that may well be a neighbour's. That is the
 * leak #323 exists to prevent, and it outranks a hole in the answer.
 *
 * **Only crashes are read.** `bug_type` `309` is what both captures carry, and the same directory
 * also collects reports of other kinds — hangs, resource use — whose bodies have other shapes
 * and which are not a crash. Answering one of them under `crash` would be the plausible-looking
 * wrong answer ai/RULES.md §2 forbids.
 */

import { z } from 'zod';
import { type LogEntry, LogEntrySchema } from '../../../core/device.js';

/** The `bug_type` of a crash, as both captures carry it — a string, not a number. */
const CRASH_BUG_TYPE = '309';

/**
 * How many frames of the faulting thread the message carries.
 *
 * Enough to name where the process was without carrying the whole stack: the SIGSEGV capture's
 * faulting thread has 16 frames, and its first eight already reach the run loop. The rest are
 * in the report on the host, and symbolication is out of scope (#323).
 */
export const CRASH_FRAMES_IN_MESSAGE = 8;

/** The header line: what kind of report this is, and which bundle it was written for. */
const HeaderSchema = z.object({
	bug_type: z.string(),
	bundleID: z.string().optional(),
});

/** One stack frame. `symbol` is absent on a frame the report could not name. */
const FrameSchema = z.object({
	imageIndex: z.number().int().nonnegative().optional(),
	imageOffset: z.number().int().nonnegative().optional(),
	symbol: z.string().optional(),
	symbolLocation: z.number().int().nonnegative().optional(),
});

/**
 * The keys of the body this mapping reads — a projection, non-`.strict()` for the reason
 * `./unified-log.js` gives: this is Apple's JSON, and the captures' bodies carry fifty-odd keys.
 *
 * Required are the three without which nothing can be answered honestly: `pid` (the entry's
 * process), `captureTime` (when it crashed, which is what the lease bound is compared against),
 * and `procName`. `coalitionName` is optional **here** because whether a report without one is
 * answered is `../crash-reports.ts`'s decision, and its answer is no.
 */
const BodySchema = z.object({
	pid: z.number().int().nonnegative(),
	procName: z.string(),
	/** `2026-10-06 15:27:47.1123 +0200` — a space before the offset, four fraction digits. */
	captureTime: z.string(),
	/** `com.apple.CoreSimulator.SimDevice.<udid>` on both captures — the device's own name. */
	coalitionName: z.string().optional(),
	exception: z
		.object({
			type: z.string().optional(),
			signal: z.string().optional(),
			codes: z.string().optional(),
		})
		.optional(),
	termination: z
		.object({
			namespace: z.string().optional(),
			code: z.number().int().optional(),
			indicator: z.string().optional(),
			byProc: z.string().optional(),
		})
		.optional(),
	faultingThread: z.number().int().nonnegative().optional(),
	threads: z
		.array(z.object({ queue: z.string().optional(), frames: z.array(FrameSchema).optional() }))
		.optional(),
	usedImages: z.array(z.object({ name: z.string().optional() })).optional(),
});
type Body = z.infer<typeof BodySchema>;

/** One crash report, read: the neutral entry, and the field that says which device it was. */
export interface CrashReport {
	readonly entry: LogEntry;
	/** The report's `coalitionName`, verbatim, or `undefined` when it carries none. */
	readonly coalitionName: string | undefined;
}

/**
 * One `.ips` file's text as a crash report, or `undefined` when it is not one this can read —
 * not a crash, not two JSON documents, or missing a field the entry cannot be built without.
 *
 * The entry is:
 *
 * - **`timestamp`**: the body's `captureTime` — when the process died, not the header's
 *   `timestamp`, which is when the file was written and trailed it by 23 s on the SIGSEGV
 *   capture. Reshaped into the unified log's own form ({@link unifiedLogTimestampOf}) so the
 *   two streams order together and a `since` taken from either applies to both.
 * - **`level`**: `fatal`. The process is gone.
 * - **`tag`**: `''`. A report names a process and a bundle, never a subsystem, and `tag` is the
 *   subsystem on this platform (`./unified-log.js`); putting a bundle id there would let a `tag`
 *   selection match something the unified log never prints under that name.
 * - **`pid`**: the report's own.
 * - **`message`**: {@link summaryOf}'s bounded summary.
 */
export function parseCrashReport(text: string): CrashReport | undefined {
	const newline = text.indexOf('\n');
	if (newline < 0) return undefined;

	const header = HeaderSchema.safeParse(decoded(text.slice(0, newline)));
	if (!header.success || header.data.bug_type !== CRASH_BUG_TYPE) return undefined;

	const body = BodySchema.safeParse(decoded(text.slice(newline + 1)));
	if (!body.success) return undefined;

	const timestamp = unifiedLogTimestampOf(body.data.captureTime);
	if (timestamp === undefined) return undefined;

	return {
		entry: LogEntrySchema.parse({
			timestamp,
			level: 'fatal',
			tag: '',
			pid: body.data.pid,
			message: summaryOf(body.data, header.data.bundleID),
		}),
		coalitionName: body.data.coalitionName,
	};
}

/**
 * A report's `captureTime` in the shape a unified-log entry carries, or `undefined` when it is
 * not in the shape measured.
 *
 * `2026-10-06 15:27:47.1123 +0200` becomes `2026-10-06 15:27:47.112300+0200`: the space before
 * the offset goes and the fraction is padded to the six digits the log prints. Both are the same
 * instant written two ways — the simulator's clock *is* this host's, so this is no client clock
 * (D17) and nothing is converted, only re-spelled. A fraction longer than six digits is cut,
 * which floors it, as `../log-query.js`'s `instantOf` does.
 */
export function unifiedLogTimestampOf(captureTime: string): string | undefined {
	const parts = CAPTURE_TIME.exec(captureTime);
	if (parts === null) return undefined;

	return `${parts[1]}.${`${parts[2]}000000`.slice(0, 6)}${parts[3]}`;
}

/** The date and time, the fraction and the offset of a `captureTime`, as both captures print it. */
const CAPTURE_TIME = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\.(\d+) ([+-]\d{4})$/;

/**
 * The message: what died, how, and where — one line each, bounded by
 * {@link CRASH_FRAMES_IN_MESSAGE}.
 *
 * ```
 * Preferences (com.apple.Preferences), pid 82924
 * exception: EXC_CRASH (SIGSEGV), codes 0x0000000000000000, 0x0000000000000000
 * termination: SIGNAL 11, Segmentation fault: 11, by zsh
 * thread 0 (com.apple.main-thread), 8 of 16 frames:
 *   0 libsystem_kernel.dylib mach_msg2_trap + 8
 * ```
 *
 * A line whose source is absent from the report is left out rather than printed empty, and a
 * frame with no symbol is its image and offset — what the report has, unsymbolicated.
 */
function summaryOf(body: Body, bundleId: string | undefined): string {
	return [
		`${body.procName}${bundleId === undefined ? '' : ` (${bundleId})`}, pid ${body.pid}`,
		...exceptionLines(body.exception),
		...terminationLines(body.termination),
		...threadLines(body),
	].join('\n');
}

/** `exception: EXC_CRASH (SIGSEGV), codes …`, or nothing when the report names no type. */
function exceptionLines(exception: Body['exception']): string[] {
	if (exception?.type === undefined) return [];

	const signal = exception.signal === undefined ? '' : ` (${exception.signal})`;
	const codes = exception.codes === undefined ? '' : `, codes ${exception.codes}`;
	return [`exception: ${exception.type}${signal}${codes}`];
}

/** `termination: SIGNAL 11, Segmentation fault: 11, by zsh`, from whichever parts it carries. */
function terminationLines(termination: Body['termination']): string[] {
	if (termination === undefined) return [];

	const parts = [
		[termination.namespace, termination.code].filter((part) => part !== undefined).join(' '),
		termination.indicator,
		termination.byProc === undefined ? undefined : `by ${termination.byProc}`,
	].filter((part) => part !== undefined && part !== '');
	return parts.length === 0 ? [] : [`termination: ${parts.join(', ')}`];
}

/** The faulting thread's heading and its first frames, or nothing when there is none to show. */
function threadLines(body: Body): string[] {
	const index = body.faultingThread;
	const thread = index === undefined ? undefined : body.threads?.[index];
	if (index === undefined || thread?.frames === undefined) return [];

	const { frames, queue } = thread;
	const shown = frames.slice(0, CRASH_FRAMES_IN_MESSAGE);
	return [
		`thread ${index}${queue === undefined ? '' : ` (${queue})`}, ` +
			`${shown.length} of ${frames.length} frames:`,
		...shown.map((frame, at) => `  ${at} ${frameOf(frame, body.usedImages)}`),
	];
}

/** `libsystem_kernel.dylib mach_msg2_trap + 8`, or `<image> + 0x<offset>` with no symbol. */
function frameOf(frame: z.infer<typeof FrameSchema>, images: Body['usedImages']): string {
	const image =
		(frame.imageIndex === undefined ? undefined : images?.[frame.imageIndex]?.name) ?? '???';
	if (frame.symbol !== undefined) {
		return `${image} ${frame.symbol} + ${frame.symbolLocation ?? 0}`;
	}
	return `${image} + 0x${(frame.imageOffset ?? 0).toString(16)}`;
}

/** `text` as JSON, or `undefined` when it is not. */
function decoded(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}
