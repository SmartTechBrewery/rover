/**
 * The one place a client reads a local file for a host — the inbound half of D19's transfer
 * contract, and the mirror of `./artifact.ts`.
 *
 * `install_app` and `push_file` take a file from **the caller's** machine and send its bytes
 * (`src/verbs/files.ts`), because a path would name nothing on the host or, worse, something
 * else. So the file is opened here, on the machine that named it, and what goes on the wire
 * is base64 — the same encoding an artifact comes back in.
 *
 * **Everything this module refuses, it refuses before a connection exists.** A missing path,
 * a path that is not a regular file, a file over `MAX_TRANSFER_BYTES` and a file this process
 * may not read are all facts about the caller's own disk, knowable without asking anyone; a
 * command calls {@link resolveSource} and {@link readPayload} before `connectToHost`, so a
 * refusal costs no round trip, renews no lease, and — the load-bearing part — **sends
 * nothing**. Nothing partial ever reaches a device, because nothing at all does.
 *
 * **The size is read off `stat`, never off the buffer.** That is the same reasoning
 * `src/verbs/files.ts` records for handing `MAX_ARTIFACT_BYTES` *down* to `pullFile` instead
 * of checking on the way back: a refusal issued after a 2 GB file is in this process's heap
 * has already cost what it was meant to prevent.
 *
 * **And a size read without a kind beside it is not a bound** (PROJECT.md §6) — the same
 * finding `pull_file` records on the device side, on this side of the wire. A fifo stats as
 * zero bytes and then reads until the writer stops, a character device stats as zero bytes
 * and never stops at all, and `<(gzip -c big.bin)` hands this command a fifo under
 * `/dev/fd/` without the caller thinking of it as one. So the kind is checked first and the
 * cap is only ever applied to the one shape whose reported size predicts the transfer.
 *
 * **Nothing here branches on `--host`,** for `./artifact.ts`'s reason: a local daemon and a
 * remote host take the same field of the same schema, so one module serves both.
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { describeWithoutBytes, type VerbCallOk } from '../../client/artifact.js';
import { MAX_TRANSFER_BYTES, type VerbCallResult } from '../../ipc/methods.js';
import { UsageError } from './flags.js';
import * as out from './output.js';
import { exitCodeFor, renderVerbAnswer } from './verb.js';

/**
 * What `stat` says the path *is*, in the words the refusal uses. `stat` follows symlinks, so
 * a link is never one of these — it is whatever it points at, which is the thing that would
 * actually be read.
 */
function describeKind(stats: Awaited<ReturnType<typeof stat>>): string {
	if (stats.isFIFO()) return 'named pipe';
	if (stats.isCharacterDevice()) return 'character device';
	if (stats.isBlockDevice()) return 'block device';
	if (stats.isSocket()) return 'socket';
	// Not reachable through `resolveSource` — a directory is refused before this is asked and
	// the four above are the rest of what `stat` can answer — but the sentence still has to
	// read as one for a kind a future platform invents.
	return 'special file';
}

/**
 * The file to send, absolute, checked before anything is connected to or read.
 *
 * Four shapes are refused, all as {@link UsageError} — exit 2 with the command's own usage,
 * because the caller named the wrong file and no host was asked anything. Exit 2 rather than
 * the 1 this CLI reserves for a host that said no, mirroring `boundAttribution`
 * (`./flags.ts`): the value is the caller's and decidable before any connection, so it gets
 * the usage text rather than the code that means the operation was refused.
 *
 * - a path that **is not there**, which `readFile` would fail on with `ENOENT` at exit 1
 *   after a connection and a lease renewal;
 * - a **directory**, which is `EISDIR` the same way — and recursive directory transfer is
 *   deliberately not these verbs (`src/verbs/files.ts`);
 * - anything else that is **not a regular file** — a fifo, a character or block device, a
 *   socket. This is the kind check `pull_file` makes on the device side, for the same reason
 *   and stated the same way round: only a regular file's `stat` size predicts how much a
 *   transfer would move. A fifo reports zero and then reads until its writer stops,
 *   `/dev/zero` reports zero and never stops, and the cap below would wave both through —
 *   so the cap is applied *after* this, to the one shape it can bound;
 * - a file **over {@link MAX_TRANSFER_BYTES}**, named with its real size and the limit, so
 *   the answer is actionable rather than merely a refusal. The host would refuse it too —
 *   `Base64PayloadSchema` is where the bound actually binds — but only after this process
 *   had encoded several megabytes and put them on a socket, to be told a number it could
 *   have read off the file. A real application package is routinely larger than this cap;
 *   raising it means chunking, and that lands underneath these verbs rather than here.
 *
 * Anything else `stat` says — a permission error on a parent directory, a broken symlink —
 * is refused the same way rather than crashing, because the caller's next move is the same:
 * name a different file.
 */
export async function resolveSource(command: string, localPath: string): Promise<string> {
	const source = path.resolve(localPath);

	let stats: Awaited<ReturnType<typeof stat>>;
	try {
		stats = await stat(source);
	} catch (error) {
		throw new UsageError(
			`rover ${command}: cannot read '${source}' on this machine — ` +
				`${error instanceof Error ? error.message : String(error)}. The file is read here ` +
				`and sent as bytes, so it is this machine's path that has to exist, not the host's.`,
		);
	}

	if (stats.isDirectory()) {
		throw new UsageError(
			`rover ${command}: '${source}' is a directory. Name the file to send: one call carries ` +
				`one whole file, and transferring a tree is deliberately not one of these verbs.`,
		);
	}

	// The kind before the size, because the size only means something once the kind is known:
	// a fifo and a character device both stat as zero bytes and would sail past the cap below
	// while `readPayload` loaded gigabytes — or blocked forever, on a fifo with no writer.
	if (!stats.isFile()) {
		throw new UsageError(
			`rover ${command}: '${source}' is a ${describeKind(stats)}, and one call sends the ` +
				`bytes of one regular file. A path that is not a regular file has a size that says ` +
				`nothing about how much it would send — a named pipe or a character device stats ` +
				`as zero bytes and then reads without end — so it is refused rather than bounded ` +
				`afterwards. Name a regular file.`,
		);
	}

	if (stats.size > MAX_TRANSFER_BYTES) {
		throw new UsageError(
			`rover ${command}: '${source}' is ${stats.size} bytes, over the ${MAX_TRANSFER_BYTES} ` +
				`bytes one call may carry — it travels base64-encoded, which is a third larger ` +
				`again, and the whole call has to fit one message. Nothing was sent: the file is ` +
				`refused whole rather than cut to fit, because a truncated file is not ` +
				`distinguishable from a complete one. Moving anything bigger means chunked ` +
				`transfer, which is its own piece of work.`,
		);
	}

	return source;
}

/**
 * The file's bytes, as they travel: base64, because the framing is NDJSON
 * (`src/ipc/framing.ts`) and raw bytes do not survive it.
 *
 * Read **after** {@link resolveSource} and still before any connection, so the one failure
 * left here is a file that stat'd fine and would not open — a permission this process does
 * not have, or a file that vanished in between. That is the caller's own disk answering, so
 * it is a {@link UsageError} like the others rather than the exit code that means a host
 * refused something.
 *
 * The size is not re-checked against what was read. `stat` already answered that, and the
 * one gap it leaves — a file that grew between the two calls — is closed on the host, where
 * `Base64PayloadSchema` bounds the payload for every caller rather than for the well-behaved
 * ones.
 */
export async function readPayload(command: string, source: string): Promise<string> {
	try {
		return (await readFile(source)).toString('base64');
	} catch (error) {
		throw new UsageError(
			`rover ${command}: '${source}' could not be read on this machine — ` +
				`${error instanceof Error ? error.message : String(error)}. Nothing was sent.`,
		);
	}
}

/** What {@link deliverTransfer} needs to turn one verb answer into output and an exit code. */
export interface TransferDelivery {
	/** Which host answered — the one key `--json` adds, and never a branch in this module. */
	readonly host: string;
	/** The host's answer, whichever of the three branches it is. */
	readonly answer: VerbCallResult;
	/** The one line a success prints, built from what the host said it did. */
	readonly describe: (result: VerbCallOk['result']) => string;
	readonly json: boolean;
}

/**
 * One verb answer from a transfer that carried bytes *in*, rendered. Answers the exit code.
 *
 * `deliverArtifact`'s counterpart for the direction with nothing to write here: the bytes
 * went to the device, so what a success has to say is that they arrived and where.
 *
 * **The document is built from the answer and never from the call**, which is what makes
 * "`--json` never echoes the payload back" structural rather than remembered: the several
 * megabytes of base64 this command sent are not in scope at this point, and the answer is an
 * `ActionResult`, whose `artifact` is null for both of these verbs. `describeWithoutBytes`
 * runs over it anyway, so a result that later grows a payload cannot arrive on stdout
 * unnoticed.
 */
export function deliverTransfer(delivery: TransferDelivery): number {
	const { host, answer, json, describe } = delivery;

	if (answer.outcome !== 'ok') {
		if (json) {
			out.printJson(host, answer);
		} else {
			out.error(renderVerbAnswer(answer));
		}
		return exitCodeFor(answer);
	}

	if (json) {
		out.printJson(host, describeWithoutBytes(answer));
	} else {
		out.info(describe(answer.result));
	}
	return exitCodeFor(answer);
}
