/**
 * The two tools whose answer is bytes: `screenshot` and `record_video`.
 *
 * **The schemas from `src/ipc/methods.ts` *are* the tool declarations**, exactly as
 * `./devices.ts` and `./verbs.ts` say for the other twenty-one rows (ai/CODING_STANDARDS.md,
 * boundary #1). Which matters twice over here, because of a field those two schemas do
 * **not** have: there is no destination and no format on either. The capture happens on the
 * host (D19), so a path sent to it would name nothing or name the wrong disk, and the format
 * is what the device recorder produced rather than something a caller picks. Declaring from
 * the schema is what keeps a well-meaning `--out`-shaped parameter from appearing here.
 *
 * **Where the bytes go is `../_shared/artifact.ts`'s** — the inline image for a screenshot,
 * the local file and the frames for a recording, and the guarantee that a refusal leaves no
 * file behind. This module is the two rows and nothing else.
 *
 * **`record_video` raises its own request timeout**, the way `rover record` does: the call
 * spends up to fifteen seconds recording and then as long again on the host slicing the
 * recording into frames, before it starts transferring several megabytes. Left at the client's
 * thirty-second default, a long-but-perfectly-normal recording surfaces as a hang — no answer
 * and no name — while the host is still working and about to say exactly what happened.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HostName } from '../../daemon/host.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../../ipc/client.js';
import { IPC_METHODS, type RecordVideoParams } from '../../ipc/methods.js';
import { DEFAULT_RECORDING_MS, FRAME_EXTRACTION_TIMEOUT_MS } from '../../verbs/record.js';
import { guarded } from '../_shared/answer.js';
import {
	recordVideoToolResult,
	resolveArtifactDirectory,
	screenshotToolResult,
} from '../_shared/artifact.js';
import { callHost } from '../_shared/call.js';
import { declaring } from '../_shared/declaration.js';

/**
 * How long this client waits for a recording: the recording itself, **the host's frame
 * extraction**, and the budget every other call gets for the round trip and the transfer.
 *
 * `src/cli/commands/record.ts`'s `requestTimeoutFor`, term for term, and every term is
 * imported rather than restated — the promise only holds while this bound is larger than
 * every bound inside it, and a copied number is one the original is free to drift away from.
 * Leaving the extraction out would put this client's deadline *inside* the host's, so a slow
 * decode would be reported here as a nameless timeout.
 *
 * {@link DEFAULT_RECORDING_MS} stands in for a duration the caller did not send and is used
 * **only** to size this timeout, never put on the request: a second default on the wire is a
 * second number free to disagree with the verb's own, which is exactly what
 * `RecordVideoParamsSchema` leaves the field optional to prevent.
 */
function recordingTimeoutMs(params: RecordVideoParams): number {
	return (
		(params.durationMs ?? DEFAULT_RECORDING_MS) +
		FRAME_EXTRACTION_TIMEOUT_MS +
		DEFAULT_REQUEST_TIMEOUT_MS
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
				'comes back blank, and when you need element ids or rectangles rather than pixels.',
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
				'animation was smooth. This call can take half a minute; that is the recording and ' +
				'the slicing, not a hang.',
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
}
