/**
 * How an artifact reaches an agent through MCP (D19, R24) — where a file may land, and what
 * an `ok` answer that carries bytes becomes.
 *
 * **No path an agent receives here is a host path.** The capture happens on the machine
 * holding the device and the answer is read wherever the agent is, so anything this module
 * writes is written by *this* process, on the agent's own machine, and reported absolute.
 * That is the same guarantee `src/cli/_shared/artifact.ts` makes for `--out`, and the bytes
 * go through the same writer (`src/client/artifact.ts`) to get it.
 *
 * **The two verbs answer differently, because their bytes are different things.**
 *
 * - `screenshot` answers with an inline MCP `image` block and writes nothing. A screenshot
 *   exists for an agent to *look at*, and an inline image is the one form of an artifact that
 *   needs no path at all — so D19's "a path handed to the agent must exist on the agent's
 *   machine" is satisfied here by there being no path.
 * - `record_video` writes the recording to a file, because an mp4 is not something a model can
 *   read inline, and reports where it put it. Its **frames** come back as image blocks: they
 *   are the part an agent actually looks at, they are already bounded by `MAX_FRAMES_BYTES`
 *   (1.5 MiB) and `MAX_FRAMES`, and returning them inline is what makes a recording legible
 *   without a second tool call.
 *
 * **The document beside the blocks carries no base64.** `describeWithoutBytes` drops every
 * payload and keeps `{ mediaType, byteLength }`, exactly as it does for `rover screenshot
 * --json` — the bytes are already in the content blocks or already in the file, and repeating
 * several megabytes of base64 in `structuredContent` would put them in front of the model
 * twice.
 *
 * **A refusal leaves no file behind at all** — not a truncated one, not a zero-byte one. The
 * write is the last thing that happens and only on the `ok` branch, so `artifact-too-large`,
 * `unfinished-recording`, `frame-extraction-unavailable`, `frames-too-large` and a decoded
 * length that disagrees with the host's every one of them return or throw first. The
 * destination directory is not even created until the bytes are in hand.
 */

import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CallToolResult, ImageContent } from '@modelcontextprotocol/sdk/types.js';
import { describeWithoutBytes, requireArtifact, writeArtifact } from '../../client/artifact.js';
import type { RecordVideoCallResult, VerbCallResult } from '../../ipc/methods.js';
import type { Artifact } from '../../verbs/result.js';
import { toolAnswerWith } from './answer.js';
import { verbToolResult } from './verb-answer.js';

/** Environment variable naming the directory `record_video` writes into. */
export const ARTIFACT_DIR_ENV_VAR = 'ROVER_MCP_ARTIFACT_DIR';

/**
 * Where a recording lands when nobody said — a `rover-` directory under the OS temp
 * directory, on the machine running this server.
 *
 * The temp directory rather than the home directory, because these are the agent's working
 * copies rather than a durable record: the host already keeps every artifact it produced in
 * its own archive (D23, `src/daemon/archive.ts`), and that is the tree that is meant to
 * survive. What lands here is what one agent asked for, in the place an operating system
 * already cleans up.
 */
export function defaultArtifactDirectory(): string {
	return path.join(tmpdir(), 'rover-artifacts');
}

/**
 * The directory this server writes recordings into.
 *
 * **Server configuration, not a tool parameter**, for the reason the host is not one (D17):
 * an MCP client launches each server with its own `env` block, so the environment already
 * *is* per-server configuration, and where an agent's files land on the operator's disk is
 * the operator's decision rather than something a model should be offered a free-text field
 * for. An empty value counts as unset, exactly as it does for the socket, the user store and
 * the archive root — an exported-but-blank variable is what a shell leaves behind, and
 * reading it as a real setting would start writing recordings into the current directory.
 */
export function resolveArtifactDirectory(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env[ARTIFACT_DIR_ENV_VAR];
	return configured === undefined || configured === '' ? defaultArtifactDirectory() : configured;
}

/**
 * What a media type this server writes is called on disk.
 *
 * Deliberately typed to admit `undefined`, so the fallback below is visibly load-bearing rather
 * than dead code a reader has to check the compiler options to understand: the host sniffs a
 * media type off the bytes and answers `application/octet-stream` for anything it does not
 * recognise, which is a real value that reaches here.
 */
const FILE_EXTENSIONS: Readonly<Record<string, string | undefined>> = {
	'video/mp4': 'mp4',
	'image/png': 'png',
};

/** What unrecognised bytes are called — honestly unlabelled, never a guessed container. */
const UNKNOWN_EXTENSION = 'bin';

/**
 * One artifact as an MCP content block — the bytes the host already base64-encoded, handed
 * over in the encoding MCP itself uses, with the media type the host sniffed off them.
 *
 * No re-encoding and no decode: `ArtifactSchema.base64` and `ImageContent.data` are the same
 * representation of the same bytes, so anything in between would be a copy of several
 * megabytes made only to be thrown away.
 */
function imageBlock(artifact: Artifact): ImageContent {
	return { type: 'image', data: artifact.base64, mimeType: artifact.mediaType };
}

/**
 * `screenshot`'s answer: the capture as an image the agent can see, and the document with the
 * base64 dropped beside it.
 *
 * Nothing is written and no path is reported, which is the whole point — see this module's
 * header. `failed` and `refused` go through the shared mapping untouched, so a refusal reads
 * word for word the same as every other verb's.
 */
export function screenshotToolResult(answer: VerbCallResult): CallToolResult {
	if (answer.outcome !== 'ok') {
		return verbToolResult(answer);
	}

	const artifact = requireArtifact(answer.result, 'screenshot');
	return toolAnswerWith(describeWithoutBytes(answer), [imageBlock(artifact)]);
}

/**
 * `record_video`'s answer: the recording written into `directory` on this machine, its
 * absolute local path on the document, and the frames as images the agent can see.
 *
 * **The write is the last thing that happens and only on the `ok` branch**, which is the
 * ordering that makes "a refusal leaves no file behind" structural rather than a habit: every
 * refusal returns above, `requireArtifact` throws above, and `writeArtifact` checks the
 * decoded length against the host's own before it opens anything. The directory is created
 * here rather than at startup for the same reason — a server nobody ever asked to record
 * leaves nothing on the operator's disk.
 */
export async function recordVideoToolResult(
	answer: RecordVideoCallResult,
	directory: string,
): Promise<CallToolResult> {
	if (answer.outcome !== 'ok') {
		return verbToolResult(answer);
	}

	const artifact = requireArtifact(answer.result, 'record_video');
	await mkdir(directory, { recursive: true });
	const artifactPath = await writeArtifact(
		artifact,
		path.resolve(directory, artifactFileName(artifact)),
	);

	return toolAnswerWith(
		{ ...describeWithoutBytes(answer), artifactPath },
		answer.result.frames.map(imageBlock),
	);
}

/**
 * What one recording is called in the artifact directory.
 *
 * The verb, then the time, then eight random hex characters. The verb and the timestamp are
 * there so a human opening the directory can tell what a file is and which run it came from;
 * the random suffix is what makes the name unique, because two calls in the same millisecond
 * are an ordinary thing for one agent to do and a collision would silently overwrite the
 * earlier answer's file after that answer had already reported the path.
 */
function artifactFileName(artifact: Artifact): string {
	const extension = FILE_EXTENSIONS[artifact.mediaType] ?? UNKNOWN_EXTENSION;
	return `record_video-${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`;
}
