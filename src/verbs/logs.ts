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
 */

import type { z } from 'zod';
import { type LogRead, LogReadSchema } from '../core/device.js';
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

	return ReadLogsResultSchema.parse({ ...result, logs });
}
