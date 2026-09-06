/**
 * The three tools whose answer is bytes: `screenshot`, `record_video` and `stop_recording`.
 *
 * **The schemas from `src/ipc/methods.ts` *are* the tool declarations**, exactly as
 * `./devices.ts` and `./verbs.ts` say for the other twenty-two rows (ai/CODING_STANDARDS.md,
 * boundary #1). Which matters twice over here, because of a field none of those schemas has:
 * there is no destination and no format on any of them. The capture happens on the
 * host (D19), so a path sent to it would name nothing or name the wrong disk, and the format
 * is what the device recorder produced rather than something a caller picks. Declaring from
 * the schema is what keeps a well-meaning `--out`-shaped parameter from appearing here.
 *
 * **Where the bytes go is `../_shared/artifact.ts`'s** — the inline image for a screenshot,
 * the local file and the frames for a recording, and the guarantee that a refusal leaves no
 * file behind. Both recording rows answer in the same shape, so both go through the same
 * `recordVideoToolResult`. This module is the three rows and nothing else.
 *
 * **`record_video` raises its own request timeout**, the way `rover record` does: the call
 * spends up to fifteen seconds recording, then as long again on the host normalising the
 * recording and as long again slicing it into frames, before it starts transferring several
 * megabytes. Left at the client's thirty-second default, a long-but-perfectly-normal recording
 * surfaces as a hang — no answer and no name — while the host is still working and about to say
 * exactly what happened.
 *
 * **`stop_recording` raises its own for the same reason and with one term fewer** (#190): by the
 * time it is called the recording is over, so what is left is the host's normalisation, the
 * host's frame extraction and the transfer. Its partner `start_recording` is a plain-data row in
 * `./verbs.ts` — it produces no bytes and returns as soon as the recorder is up, so it belongs
 * with the verbs and needs no timeout of its own.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HostName } from '../../daemon/host.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../../ipc/client.js';
import { IPC_METHODS, type RecordVideoParams } from '../../ipc/methods.js';
import { DEFAULT_RECORDING_MS, FRAME_EXTRACTION_TIMEOUT_MS } from '../../verbs/record.js';
import { RECORDING_NORMALISATION_TIMEOUT_MS } from '../../verbs/recording-normalisation.js';
import { guarded } from '../_shared/answer.js';
import {
	recordVideoToolResult,
	resolveArtifactDirectory,
	screenshotToolResult,
} from '../_shared/artifact.js';
import { callHost } from '../_shared/call.js';
import { declaring } from '../_shared/declaration.js';

/**
 * How long this client waits for a recording: the recording itself, **the host's
 * normalisation**, **the host's frame extraction**, and the budget every other call gets for
 * the round trip and the transfer.
 *
 * `src/cli/commands/record.ts`'s `requestTimeoutFor`, term for term, and every term is
 * imported rather than restated — the promise only holds while this bound is larger than
 * every bound inside it, and a copied number is one the original is free to drift away from.
 * Leaving either host step out would put this client's deadline *inside* the host's, so a slow
 * re-encode or a slow decode would be reported here as a nameless timeout.
 *
 * {@link DEFAULT_RECORDING_MS} stands in for a duration the caller did not send and is used
 * **only** to size this timeout, never put on the request: a second default on the wire is a
 * second number free to disagree with the verb's own, which is exactly what
 * `RecordVideoParamsSchema` leaves the field optional to prevent.
 */
function recordingTimeoutMs(params: RecordVideoParams): number {
	return (
		(params.durationMs ?? DEFAULT_RECORDING_MS) +
		RECORDING_NORMALISATION_TIMEOUT_MS +
		FRAME_EXTRACTION_TIMEOUT_MS +
		DEFAULT_REQUEST_TIMEOUT_MS
	);
}

/**
 * How long this client waits for a recording it started separately to be stopped and handed
 * back: **the host's normalisation, the host's frame extraction and the round trip**.
 *
 * {@link recordingTimeoutMs} minus its first term, and minus it deliberately rather than by
 * oversight: the recording is already over by the time this call is made, and how long it ran is
 * not something the call knows or could have carried (#190). Every remaining term is imported
 * for that function's reason — the promise only holds while this bound is larger than every
 * bound inside it, and a copied number is one the original is free to drift away from.
 */
function stopRecordingTimeoutMs(): number {
	return (
		RECORDING_NORMALISATION_TIMEOUT_MS + FRAME_EXTRACTION_TIMEOUT_MS + DEFAULT_REQUEST_TIMEOUT_MS
	);
}

export function registerArtifactTools(server: McpServer, host: HostName): void {
	server.registerTool(
		'screenshot',
		declaring({
			title: 'Capture the screen',
			description:
				'Capture the screen of the leased device and answer with the image itself, inline — ' +
				'there is nothing to write and no path to read. It takes no destination and no ' +
				'format: the capture happens on the Rover host, which may be another machine, so a ' +
				'path you sent would name nothing there. A capture too large for one answer is ' +
				'refused by name rather than returned cut short. **A black image is a true answer ' +
				'rather than a failed capture**: some applications block screen capture, and ' +
				'`read_screen` is the read that survives the block — reach for it when a capture ' +
				'comes back blank, and when you need element ids or rectangles rather than pixels. ' +
				'`label` is optional and is about the **host’s** archived copy rather than the image you ' +
				'get back: give the same `label` to the capture of one screen in each run of a group and ' +
				'the archive files them as one thing at two moments, which is what makes a before/after ' +
				'comparison recoverable later. One label per thing being compared, and the lease’s ' +
				'`groupId` is what says which run it was. Keep it short and identifier-shaped — ' +
				'`home-screen` rather than `home screen` — because the host puts it in a file name and ' +
				'rewrites anything outside `[A-Za-z0-9._-]`. It requires a group: a `label` on a lease ' +
				'acquired without a `groupId` is refused by name, never accepted with the label dropped.',
			inputSchema: IPC_METHODS.screenshot.params,
		}),
		async (received: unknown) =>
			guarded('screenshot', async () =>
				screenshotToolResult(await callHost(host, 'screenshot', received as never)),
			),
	);

	server.registerTool(
		'record_video',
		declaring({
			title: 'Record the screen',
			description:
				'Record the screen of the leased device for a few seconds, then answer with the ' +
				'frames sliced out of the recording — inline, in order — and the path of the video ' +
				'file, written on **this** machine. `durationMs` and `framesPerSecond` are both ' +
				'optional; omit them for the host’s own defaults. It takes no destination and no ' +
				'format, for the reason `screenshot` does not. The recording is provably finished ' +
				'before it is pulled, and the answer is the video and the frames or neither: a ' +
				'recording that came off the device unfinished, one too large for a single answer, a ' +
				'host with no decoder installed, and frames that will not fit beside the recording ' +
				'are each refused by name and leave no file behind. **Frames sample motion and ' +
				'nothing finer**: they can say something moved and roughly when, never whether an ' +
				'animation was smooth. **The video file is normalised on the host so it always ' +
				'plays** — what a device recorder writes is not a constant-rate video, so the host ' +
				're-encodes it at a constant rate over a real timeline before sending it, and ' +
				'`normalisation` says which timeline you are looking at: `requested`, the window ' +
				'you asked for, when the recording declared none of its own, or `container`, the ' +
				'recorder’s own timestamps, which is a different number from `durationMs` and is ' +
				'routinely longer. A host that cannot normalise refuses by name and writes ' +
				'nothing, rather than handing you a file that will not play. `container` on the ' +
				'answer says what the recording actually holds — how many encoded samples and what duration the file declares, read off the ' +
				'file rather than from what you asked for, which is a different number. **A recording ' +
				'of a screen that did not change comes back as one encoded sample, a declared ' +
				'duration of 0 and a single frame**, reported as `container.kind: "still-screen"` ' +
				'with an explanation: a device’s virtual display produces a buffer only when the ' +
				'screen changes, so that is a true answer about the device rather than a fault, and ' +
				'not a reason to suspect this tool. Drive the screen during the capture if you ' +
				'expected motion. This call can take a couple of minutes; that is the recording, ' +
				'then the normalisation and the slicing on the host, not a hang. ' +
				'`label` is optional and is `screenshot`’s: it names the host’s ' +
				'archived copy so the same flow recorded in two runs of one group is filed as one thing ' +
				'at two moments, and it requires the lease to carry a `groupId` — without one the call is ' +
				'refused by name rather than losing its label.',
			inputSchema: IPC_METHODS.record_video.params,
		}),
		async (received: unknown) => {
			// The one cast, and it is `./verbs.ts`'s: what arrives has already been parsed against
			// this row's own schema by the SDK — that is what handing it the `IPC_METHODS` params
			// schema buys — and the only field read off it is the duration, which that schema holds
			// to a number.
			const params = received as RecordVideoParams;
			return guarded('record_video', async () =>
				recordVideoToolResult(
					await callHost(host, 'record_video', params, {
						timeoutMs: recordingTimeoutMs(params),
					}),
					resolveArtifactDirectory(),
				),
			);
		},
	);

	server.registerTool(
		'stop_recording',
		declaring({
			title: 'Stop the recording and collect it',
			description:
				'Stop the recording this device is holding open and answer with the frames sliced ' +
				'out of it — inline, in order — and the path of the video file, written on **this** ' +
				'machine. What it contains is whatever happened on the screen between ' +
				'`start_recording` and this call, so it is only as interesting as what you did in ' +
				'between. The answer is `record_video`’s exactly: the same video, the same frames, ' +
				'the same `container` saying what the recording holds, and the same ' +
				'`normalisation` saying which timeline the file you get follows. ' +
				'`framesPerSecond` is optional; omit it for the host’s own default. It takes no ' +
				'destination and no format, for the reason `screenshot` does not, and no duration ' +
				'— the length was decided by when you called this. **A recorder that already ' +
				'stopped itself is not a failure**: recordings are capped, so one left open long ' +
				'enough ends on its own and this hands you the complete file it left. Stopping ' +
				'when nothing was recording at all is `no-recording-running`, a recording that ' +
				'came off the device mid-write is `unfinished-recording`, and a host that cannot ' +
				'normalise or slice it refuses by name — each of them leaves no file behind. ' +
				'**Nothing is held across a window here**, unlike `record_video`: this call names ' +
				'no duration and nothing times the gap between the two calls, so the file follows ' +
				'the recorder’s own timeline and `normalisation.message` says so. That is why a ' +
				'recording of a screen you never touched comes back as `container.kind: ' +
				'"still-screen"` — one sample, no duration, one frame — which is a true answer ' +
				'about the device rather than a fault. Drive the device while the recording is ' +
				'open, or use `record_video` with a duration. This call can take a couple of ' +
				'minutes; that is the normalisation and the slicing on the host, not a hang. ' +
				'`label` is optional and is `screenshot`’s: it names the host’s archived copy so ' +
				'the same flow recorded in two runs of one group is filed as one thing at two ' +
				'moments, and it requires the lease to carry a `groupId` — without one the call is ' +
				'refused by name rather than losing its label.',
			inputSchema: IPC_METHODS.stop_recording.params,
		}),
		async (received: unknown) =>
			guarded('stop_recording', async () =>
				recordVideoToolResult(
					await callHost(host, 'stop_recording', received as never, {
						timeoutMs: stopRecordingTimeoutMs(),
					}),
					resolveArtifactDirectory(),
				),
			),
	);
}
