/**
 * `read_logs` — the device's own system log, as data (PROJECT.md §4, "Apps and files";
 * backlog row R15, phase 2).
 *
 * **This is the verb that sees what a screenshot cannot.** An app that crashed and vanished
 * leaves a launcher on the screen, indistinguishable from a user pressing home; the log is
 * where `FATAL EXCEPTION` is. So it is the one verb whose value is entirely in its payload,
 * and the first in this repository whose answer carries anything beyond an `ActionResult`.
 *
 * **It is still built on the spine** (`./perform.ts`), for the reasons every other verb is:
 * the log read happens *before* the after-state is captured (D12(c)), and the answer names
 * the device and its density (D14). What it adds is one field, spread onto the spine's own
 * result rather than replacing it, so the common half is an `ActionResult` field for field
 * and `src/ipc/verb-methods.ts`'s refusal branches are the same three words whatever was
 * asked. The *schema* below is `.strict()` like every other one here, so a client parses
 * with this row's own schema rather than with `ActionResultSchema` — what the two share is
 * the shape, not the parser, and an unknown key stays an error rather than silent loss.
 *
 * **`requires: []` is the honest answer, not an omission**, the same way it is for the app
 * verbs: `readLogs` is a *required* method of `DeviceBackend`, so there is no capability to
 * assert — a `canReadLogs` flag would be one that is always true, which is the noise
 * `src/core/capabilities.ts` warns against.
 *
 * **No target, and no following.** A log read addresses no element, so `target` is `null` —
 * a fact about the verb rather than a resolution that failed. And a tail that stays open is
 * a wait with no condition (ai/RULES.md §2) plus a stream over IPC (D19): this is a bounded
 * dump, and `logs.truncated` says when the device had more.
 *
 * **The read is bounded twice — in entries and in bytes** ({@link MAX_LOG_BYTES}), because
 * an entry has no fixed size and the answer travels as one frame. Both bounds report the
 * same way: the oldest go and `logs.truncated` says so.
 */

import type { z } from 'zod';
import { type LogEntry, type LogRead, LogReadSchema } from '../core/device.js';
import type { VerbContext } from './context.js';
import { performAction } from './perform.js';
import { ActionResultSchema } from './result.js';

/**
 * How many entries a caller who did not say gets.
 *
 * The default lives here rather than in a backend, so no two backends can pick different
 * ones, and it is a constant rather than configuration (ai/RULES.md §7) — nothing about it
 * is a host's choice. Two hundred is a screenful of context around whatever just happened
 * without turning every read into a quarter of a megabyte across the wire; a caller
 * chasing something older asks for more, and `truncated` is what tells them there was.
 */
export const DEFAULT_MAX_LOG_ENTRIES = 200;

/**
 * The most log **bytes** one answer may carry — 4 MiB of serialised entries.
 *
 * The entry bound above and `MAX_LOG_ENTRIES` in `src/ipc/verb-methods.ts` count entries,
 * and an entry has no fixed size: logcat's own per-entry payload limit is about 4 KB, so
 * `MAX_LOG_ENTRIES` entries of chatter is a few hundred kilobytes while `MAX_LOG_ENTRIES`
 * entries of serialised HTTP bodies is over 20 MB. An answer travels as **one frame**, and
 * `MAX_FRAME_BYTES` (8 MiB, `src/ipc/framing.ts`) is enforced on the *receiving* side —
 * so a response over it is not a refusal the caller can read, it is `malformed_frame` on
 * their decoder, every other in-flight request on that connection failed with it, and the
 * connection destroyed. A bound only on entries cannot prevent that; this one can.
 *
 * 4 MiB is derived the same way `MAX_ARTIFACT_BYTES` (`src/verbs/result.ts`) is, and for the
 * same reason: the
 * rest of the result — a screen read of a few hundred elements — travels in the same frame,
 * and JSON escaping inflates what is measured here. The relationship to the frame cap is
 * asserted in `tests/unit/verbs/logs.test.ts`, because a constant derived from another
 * constant by hand is one the other is free to drift away from.
 *
 * Going over it is **truncation, not a refusal** — the opposite of an over-sized artifact,
 * and the difference is that a log read already has a word for a partial answer. Dropping
 * the oldest entries is what a bounded read of a ring buffer does anyway, `truncated` is
 * already the flag that says it happened, and a refusal here would deny the caller the
 * newest entries — the ones they asked for the log to see.
 */
export const MAX_LOG_BYTES = 4 * 1024 * 1024;

/**
 * The newest entries that fit in {@link MAX_LOG_BYTES}, and whether any were dropped to
 * make them fit.
 *
 * Measured on `JSON.stringify` of each entry, which is what actually goes on the wire,
 * rather than on the message alone: a timestamp, a tag, a level and the JSON punctuation
 * around them are bytes in the frame too. The one-byte allowance per entry is the comma
 * between them in the encoded array.
 *
 * Walked newest-first because that is the end a log read is asked from — the same reason
 * the backend keeps the tail of an over-long dump.
 */
function withinByteBudget(read: LogRead): LogRead {
	let budget = MAX_LOG_BYTES;
	const newestFirst: LogEntry[] = [];

	for (let index = read.entries.length - 1; index >= 0; index -= 1) {
		const entry = read.entries[index];
		if (entry === undefined) continue;
		const cost = Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1;
		if (cost > budget) return { entries: newestFirst.reverse(), truncated: true };
		budget -= cost;
		newestFirst.push(entry);
	}

	return read;
}

/**
 * What `read_logs` answers with: everything every verb answers with, **plus the log**.
 *
 * `ActionResultSchema.extend(…)` rather than a shape of its own, so the common half cannot
 * drift from what the other verbs produce and a client parses one `ActionResult` whichever
 * verb it called.
 */
export const ReadLogsResultSchema = ActionResultSchema.extend({ logs: LogReadSchema }).strict();
export type ReadLogsResult = z.infer<typeof ReadLogsResultSchema>;

export interface ReadLogsVerbOptions {
	/** Defaults to {@link DEFAULT_MAX_LOG_ENTRIES}. */
	readonly maxEntries?: number;
}

/**
 * Read the device's log, most recent last.
 *
 * The read is captured into a holder inside `act` rather than returned from it: the spine
 * answers with an `ActionResult` by design — that is what makes every verb's answer one
 * shape — so the payload is spread onto the answer here instead of the spine growing a
 * generic parameter every other verb would have to carry.
 */
export async function readLogs(
	context: VerbContext,
	options: ReadLogsVerbOptions = {},
): Promise<ReadLogsResult> {
	const maxEntries = options.maxEntries ?? DEFAULT_MAX_LOG_ENTRIES;
	const read: { logs?: LogRead } = {};

	const result = await performAction(context, {
		verb: 'read_logs',
		requires: [],
		act: async () => {
			read.logs = await context.backend.readLogs(context.serial, { maxEntries });
		},
	});

	const { logs } = read;
	if (logs === undefined) {
		// Unreachable while `performAction` awaits `act` — and stated rather than asserted
		// away, because the alternative to this line is a result whose `logs` is silently
		// absent, which is the plausible-looking empty answer ai/RULES.md §2 forbids.
		throw new Error(`read_logs on device '${context.serial}' finished without reading anything`);
	}

	return ReadLogsResultSchema.parse({ ...result, logs: withinByteBudget(logs) });
}
