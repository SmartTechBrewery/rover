/**
 * `rover record` — record the screen and write the video **on this machine**.
 *
 * The same shape as `screenshot`, over the same one field: the recording rides on
 * `ActionResult.artifact` as base64 and never as a path (D19), and `../_shared/artifact.ts`
 * writes it here. What is different is time. This call spends up to fifteen seconds
 * recording, and then as long again on the host slicing the recording into frames, *before*
 * it starts transferring several megabytes — which is the one verb that can reach the
 * client's own 30 s request timeout. So this command raises it past **both** of the host's
 * own budgets ({@link requestTimeoutFor}), and a recording that finishes normally can never
 * surface as a hang.
 *
 * The frames are the host's work and this end cannot do it: `frame-extraction-unavailable`
 * is a host that has no decoder installed, and it fails the call whole rather than writing a
 * video without them. `--help` says so, because it is the one way a command that worked
 * yesterday stops working today without the device changing.
 *
 * The host is still the only thing that decides a recording is finished: the backend waits
 * on a condition for the recorder to be gone, checks the container index on the bytes that
 * actually arrived, and refuses them as `unfinished-recording` (#14). This end does not
 * re-derive that — it prints the refusal and writes nothing.
 *
 * `--label` is `rover screenshot`'s, word for word and for the same reason (D22, as amended
 * #150): it names the host's archived copy so one flow recorded before and after a change reads
 * as a pair, it names nothing here, and it is refused when the lease has no `--group-id`.
 */

import { parseLeaseId } from '../../core/ids.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../../ipc/client.js';
import {
	DEFAULT_FRAMES_PER_SECOND,
	DEFAULT_RECORDING_MS,
	FRAME_EXTRACTION_TIMEOUT_MS,
	MAX_FRAMES_PER_SECOND,
	MAX_RECORDING_MS,
} from '../../verbs/record.js';
import { deliverArtifact, resolveDestination } from '../_shared/artifact.js';
import {
	expectPositionals,
	GLOBAL_OPTIONS,
	optionalLabel,
	parseCommandArgs,
	requireOption,
	UsageError,
} from '../_shared/flags.js';
import { connectToHost, resolveHost } from '../_shared/host.js';
import * as out from '../_shared/output.js';

export const USAGE = `rover record — record the screen to a file on this machine

Usage: rover record <lease-id> --out <path> [--duration-ms <n>] [--frames-per-second <n>]
                    [--label <string>] [--host <name>] [--json]

  --out                Where to write the video, on the machine running this command.
                       Required, for the reason \`screenshot --out\` is.
  --duration-ms        How long to record. Omit it and the host's own default applies
                       (${DEFAULT_RECORDING_MS} ms); the ceiling is ${MAX_RECORDING_MS} ms, which is a bound on what one
                       answer can carry rather than an opinion about recordings.
  --frames-per-second  How densely the host samples the recording into frames. Omit it and
                       the host's own default applies (${DEFAULT_FRAMES_PER_SECOND}); the ceiling is ${MAX_FRAMES_PER_SECOND}. Past that
                       the frames stop being a sample and start being the recording again.
  --label              What this recording is, in the host's archive. Optional, names
                       nothing on this machine, and requires the lease to carry a
                       --group-id — without one the host refuses the call by name rather
                       than dropping the label, and nothing is recorded or written.

The host also slices the recording into PNG frames, with the decoder it has rather than one
this command carries. The answer is both or neither: on a host that cannot slice — no decoder
installed on the machine holding the device — this exits 1 with \`frame-extraction-unavailable\`
and writes no video either. The frames themselves are not written to disk yet; --json reports
how many there were and how large each one is.

This command waits for the whole recording, the frame extraction and the transfer, so it
raises its own request timeout past the ${DEFAULT_REQUEST_TIMEOUT_MS} ms every other command uses — a long
recording is never a hang.

A recording that came off the device unfinished, one too large for a single answer, or frames
that will not fit beside it, is refused by name, exits 1 and leaves no file at --out at all —
never a file a player would open as damaged.`;

const OPTIONS = {
	...GLOBAL_OPTIONS,
	out: { type: 'string' },
	'duration-ms': { type: 'string' },
	'frames-per-second': { type: 'string' },
	label: { type: 'string' },
} as const;

export async function run(argv: string[]): Promise<number> {
	const { values, positionals } = parseCommandArgs('record', argv, OPTIONS);
	if (values.help === true) {
		out.info(USAGE);
		return 0;
	}
	const [leaseId] = expectPositionals('record', positionals, ['<lease-id>']);
	const durationMs = parseDurationMs(values['duration-ms']);
	const framesPerSecond = parseFramesPerSecond(values['frames-per-second']);
	// Bounded here for `parseDurationMs`'s reason: a label the host would refuse should not cost
	// a recording, a frame extraction and a multi-megabyte transfer to find out about.
	const label = optionalLabel('record', 'label', values.label);
	const destination = await resolveDestination(
		'record',
		requireOption(
			'record',
			'out',
			values.out,
			'the video is written on this machine and there is no default name for it',
		),
	);
	const host = resolveHost(values.host);

	const client = await connectToHost(host);
	try {
		const answer = await client.request(
			'record_video',
			// Spread rather than `durationMs` outright: an explicit `undefined` is a key on the
			// object, and `RecordVideoParamsSchema` is strict about a duration that is present
			// and not a number. Omitting it is also what leaves the verb's own default the only
			// default there is — the rule `recordOptions` follows on the host side.
			{
				leaseId: parseLeaseId(leaseId ?? ''),
				...(durationMs === undefined ? {} : { durationMs }),
				...(framesPerSecond === undefined ? {} : { framesPerSecond }),
				...(label === undefined ? {} : { label }),
			},
			{ timeoutMs: requestTimeoutFor(durationMs) },
		);
		return await deliverArtifact({
			host,
			verb: 'record_video',
			answer,
			destination,
			json: values.json === true,
			...(label === undefined ? {} : { label }),
		});
	} finally {
		await client.close();
	}
}

/**
 * How long this client waits: the recording, **the frame extraction**, and the budget every
 * other call gets for the round trip and the transfer.
 *
 * Every step the host spends inside this one request is a term here, because the promise this
 * module's header makes — a call that finishes normally never surfaces as a hang — is only
 * true while this bound is larger than every bound inside it. Extraction is the third step and
 * {@link FRAME_EXTRACTION_TIMEOUT_MS} is what the host allows it, so leaving it out would put
 * the client's own deadline *inside* the host's: a slow decode would be reported here as a
 * timeout, with no answer and no name, while the host was still working and about to say
 * exactly what happened.
 *
 * {@link DEFAULT_RECORDING_MS} stands in for a duration the caller did not send, and it is
 * imported rather than guessed at — but it is used *only* to size this timeout, never put on
 * the request. A second default on the wire is a second number free to disagree with the
 * verb's own, which is exactly what `RecordVideoParamsSchema` leaves the field optional to
 * prevent.
 */
function requestTimeoutFor(durationMs: number | undefined): number {
	return (
		(durationMs ?? DEFAULT_RECORDING_MS) + FRAME_EXTRACTION_TIMEOUT_MS + DEFAULT_REQUEST_TIMEOUT_MS
	);
}

/**
 * `--duration-ms` as a number, or `undefined` when it was not given.
 *
 * Both bounds are checked here rather than left to the host, for `boundAttribution`'s reason
 * (`../_shared/flags.ts`): the host answers a bad one with Zod's own words at exit 1 — the
 * code this CLI reserves for a refused verb or an unreachable host — after a connection and
 * a round trip. Rejecting it here makes a mistyped duration exit 2 with the command's usage,
 * and {@link MAX_RECORDING_MS} is imported rather than restated so the two cannot drift.
 */
function parseDurationMs(raw: string | undefined): number | undefined {
	if (raw === undefined) {
		return undefined;
	}
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new UsageError(
			`rover record: --duration-ms '${raw}' is not a whole number of milliseconds above zero.`,
		);
	}
	if (parsed > MAX_RECORDING_MS) {
		throw new UsageError(
			`rover record: --duration-ms ${parsed} is over the ${MAX_RECORDING_MS} ms a single ` +
				`answer can carry — the recording travels whole, in one message, and a longer one ` +
				`would be refused as too large rather than cut short.`,
		);
	}
	return parsed;
}

/**
 * `--frames-per-second` as a number, or `undefined` when it was not given.
 *
 * Bounded here for {@link parseDurationMs}'s reason exactly — a mistyped rate exits 2 with
 * this command's usage rather than 1 after a connection, a lease renewal and a round trip —
 * and {@link MAX_FRAMES_PER_SECOND} is imported rather than restated so the two cannot drift.
 * Omitted leaves the verb's own default the only default there is, the way an omitted
 * duration does.
 */
function parseFramesPerSecond(raw: string | undefined): number | undefined {
	if (raw === undefined) {
		return undefined;
	}
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new UsageError(
			`rover record: --frames-per-second '${raw}' is not a whole number of frames above zero.`,
		);
	}
	if (parsed > MAX_FRAMES_PER_SECOND) {
		throw new UsageError(
			`rover record: --frames-per-second ${parsed} is over the ${MAX_FRAMES_PER_SECOND} one ` +
				`answer can carry — past that rate the frames stop being a sample of the recording ` +
				`and start being the recording again, at several times its size.`,
		);
	}
	return parsed;
}
