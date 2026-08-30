/**
 * `rover push` — send a file **from this machine** onto the device.
 *
 * The first command to carry bytes the other way, and the two paths in its argument list are
 * the whole subject: `<local-path>` is read here, on the machine that named it, and
 * `<device-path>` is where the host writes it. A path never crosses (D19), which is why the
 * file goes as base64 — `../_shared/upload.ts` reads it and encodes it.
 *
 * **Every refusal this command can issue itself happens before the connection.** A missing
 * file, a directory, one over the transfer cap or one this process may not read exits 2 with
 * the usage, having sent nothing — the assertion behind that is that the host was never
 * asked. Only once the bytes are in hand is a host connected to at all.
 *
 * A device path that is already a directory is the *host's* refusal and comes back as one:
 * the platforms' own transfer tools copy the file inside it under a name the host invented
 * and report a success, so `DeviceBackend.pushFile` asks the device first. This end does not
 * re-derive that — it prints the refusal.
 */

import { parseLeaseId } from '../../core/ids.js';
import { expectPositionals, GLOBAL_OPTIONS, parseCommandArgs } from '../_shared/flags.js';
import { connectToHost, resolveHost } from '../_shared/host.js';
import * as out from '../_shared/output.js';
import { deliverTransfer, readPayload, resolveSource } from '../_shared/upload.js';

export const USAGE = `rover push — send a file from this machine onto the device

Usage: rover push <lease-id> <local-path> <device-path> [--host <name>] [--json]

  <local-path>   The file to send, on the machine running this command. It is read here
                 and travels as bytes: the host never sees a path of yours, and a path of
                 the host's would name nothing on your disk.
  <device-path>  Where to write those bytes, on the device. Absolute, and naming the file
                 to write rather than a directory to write it into — a push to a directory
                 is refused rather than filed under a name this tool chose for you.

One call carries one whole file. A source over the transfer cap is refused here, before
anything is sent, naming the file, its size and the limit — never a file cut to fit, because
a truncated file is not distinguishable from a complete one. A source that is missing, is a
directory, or cannot be read is refused the same way, and in every one of those cases the
host is never asked at all.

--json reports what the host answered — the device, the state after the push — and never
echoes the bytes back.`;

export async function run(argv: string[]): Promise<number> {
	const { values, positionals } = parseCommandArgs('push', argv, GLOBAL_OPTIONS);
	if (values.help === true) {
		out.info(USAGE);
		return 0;
	}
	const [leaseId, localPath, devicePath] = expectPositionals('push', positionals, [
		'<lease-id>',
		'<local-path>',
		'<device-path>',
	]);
	// Bound and read before `connectToHost`, so an over-sized or unreadable source spends no
	// round trip and — the part that matters — puts nothing on a socket.
	const source = await resolveSource('push', localPath ?? '');
	const contentBase64 = await readPayload('push', source);
	const host = resolveHost(values.host);

	const client = await connectToHost(host);
	try {
		const answer = await client.request('push_file', {
			leaseId: parseLeaseId(leaseId ?? ''),
			devicePath: devicePath ?? '',
			contentBase64,
		});
		return deliverTransfer({
			host,
			answer,
			json: values.json === true,
			// The size is read back off the encoded payload rather than stat'd a second time,
			// so the number printed is the number that actually travelled. The device path is
			// the caller's own string coming back through a line-structured renderer, so it is
			// escaped like every other echoed input.
			describe: (result) =>
				`Pushed ${Buffer.byteLength(contentBase64, 'base64')} bytes to ` +
				`${out.escapeControlCharacters(devicePath ?? '')} on ${result.device.serial}`,
		});
	} finally {
		await client.close();
	}
}
