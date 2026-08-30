/**
 * `rover install` — install an application package **from this machine** onto the device.
 *
 * `push`'s shape with one path instead of two, and for the reason `install_app` has no
 * device path in its schema at all: the package is on the caller's disk, the install happens
 * on the host, and a path sent along would name a file on the wrong machine — or, worse, one
 * that is on both (D19). What travels is the bytes; the host writes them to a file of its
 * own, installs it pinned to the leased device, and deletes the file in a `finally`.
 *
 * No app id, because the core knows no application's name (D13): what gets installed is the
 * package you sent, and which application that is is a fact about the bytes.
 *
 * **Say the uncomfortable part in the usage rather than let it be discovered:** a real
 * application package is routinely tens of megabytes and the cap on one call is 4 MiB, so
 * this installs a small package today and refuses a large one **by name** — here, before
 * anything is sent. Never a package cut to fit, which would install as a corrupt file or,
 * worse, as a plausible one. Moving a large one means chunked transfer, which lands
 * underneath this verb rather than changing what it promises.
 */

import { parseLeaseId } from '../../core/ids.js';
import { MAX_TRANSFER_BYTES } from '../../ipc/methods.js';
import { expectPositionals, GLOBAL_OPTIONS, parseCommandArgs } from '../_shared/flags.js';
import { connectToHost, resolveHost } from '../_shared/host.js';
import * as out from '../_shared/output.js';
import { deliverTransfer, readPayload, resolveSource } from '../_shared/upload.js';

export const USAGE = `rover install — install a package from this machine onto the device

Usage: rover install <lease-id> <local-path> [--host <name>] [--json]

  <local-path>  The application package, on the machine running this command. It is read
                here and travels as bytes; the host writes it to a file of its own,
                installs it onto the leased device and deletes that file afterwards.

There is no path on the device and no application id: what gets installed is the package you
sent, and Rover never learns its name.

One call carries one whole package, up to ${MAX_TRANSFER_BYTES} bytes. A real application package
is routinely larger than that, so this installs a small one today and refuses a large one by
name, here, before anything is sent — never a package cut to fit, which would install as a
corrupt file or as a plausible one. A source that is missing, cannot be read, or is not a
regular file — a directory, a named pipe, a device — is refused the same way, and in every one
of those cases the host is never asked at all. A pipe is refused rather than sent because its
size says nothing about how much it would send.

--json reports what the host answered — the device, the state after the install — and never
echoes the bytes back.`;

export async function run(argv: string[]): Promise<number> {
	const { values, positionals } = parseCommandArgs('install', argv, GLOBAL_OPTIONS);
	if (values.help === true) {
		out.info(USAGE);
		return 0;
	}
	const [leaseId, localPath] = expectPositionals('install', positionals, [
		'<lease-id>',
		'<local-path>',
	]);
	// Bound and read before `connectToHost`, for `push`'s reason: an over-sized package is
	// refused having sent nothing, rather than after several megabytes are on a socket.
	const source = await resolveSource('install', localPath ?? '');
	const packageBase64 = await readPayload('install', source);
	const host = resolveHost(values.host);

	const client = await connectToHost(host);
	try {
		const answer = await client.request('install_app', {
			leaseId: parseLeaseId(leaseId ?? ''),
			packageBase64,
		});
		return deliverTransfer({
			host,
			answer,
			json: values.json === true,
			// The source path is this machine's own and is printed as typed, the way `--out` is:
			// it is the one path in the sentence that means something where it is read.
			describe: (result) =>
				`Installed ${Buffer.byteLength(packageBase64, 'base64')} bytes from ${source} ` +
				`onto ${result.device.serial}`,
		});
	} finally {
		await client.close();
	}
}
