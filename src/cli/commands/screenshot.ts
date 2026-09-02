/**
 * `rover screenshot` — capture the screen and write the image **on this machine**.
 *
 * The first command in the tree to receive an artifact, and it invents nothing about how:
 * the host answers with base64 on `ActionResult.artifact` and never a path (D19), and
 * `../_shared/artifact.ts` is what turns that into a file here and reports where it landed.
 *
 * `--out` is **required**. A default name would be a naming policy this CLI made up — one
 * nothing calling it could predict and one it would then be stuck with — and the caller
 * always knows where the file belongs.
 *
 * `--label` is optional and is about the **host's** copy rather than this one (D22, as amended
 * #150): it names what was captured, so the same screen shot before and after a change is
 * recognisable as one thing in the archive. It changes nothing about the bytes, nothing about
 * `--out`, and it is refused by the host when the lease carries no `--group-id` — because a
 * label with nothing to be compared against would be a string an agent supplied and nobody
 * recorded.
 */

import { parseLeaseId } from '../../core/ids.js';
import { deliverArtifact, resolveDestination } from '../_shared/artifact.js';
import {
	expectPositionals,
	GLOBAL_OPTIONS,
	optionalLabel,
	parseCommandArgs,
	requireOption,
} from '../_shared/flags.js';
import { connectToHost, resolveHost } from '../_shared/host.js';
import * as out from '../_shared/output.js';

export const USAGE = `rover screenshot — capture the screen to a file on this machine

Usage: rover screenshot <lease-id> --out <path> [--label <string>] [--host <name>] [--json]

  --out    Where to write the image, on the machine running this command. Required:
           the capture happens on the host and comes back as bytes, so the file is
           this client's to place and there is no default name it could invent.
  --label  What this capture is, in the host's archive. Optional, and it names nothing on
           this machine: the host puts it in the archived file's name, so the same screen
           captured in two runs of one investigation reads as a pair. Keep it short and
           identifier-shaped — it is a file name, and anything outside [A-Za-z0-9._-] is
           rewritten. It requires the lease to have been acquired with --group-id; without
           one the host refuses the call by name rather than dropping the label, and no
           file is written here.

The lease id is the credential, exactly as it is for release. The path printed is your own,
absolute; no host-local path is ever reported. A capture too large for one answer is refused
by name, exits 1 and writes nothing at all — never a file cut short.

A black image is a true answer rather than a failed capture: some apps block screen capture,
and \`read_screen\` is the read that survives the block.`;

const OPTIONS = {
	...GLOBAL_OPTIONS,
	out: { type: 'string' },
	label: { type: 'string' },
} as const;

export async function run(argv: string[]): Promise<number> {
	const { values, positionals } = parseCommandArgs('screenshot', argv, OPTIONS);
	if (values.help === true) {
		out.info(USAGE);
		return 0;
	}
	const [leaseId] = expectPositionals('screenshot', positionals, ['<lease-id>']);
	// Bounded here for the reason `--out` is resolved here: a label the host would refuse costs a
	// round trip, a lease renewal and a multi-megabyte transfer to be told about.
	const label = optionalLabel('screenshot', 'label', values.label);
	// Resolved before the connection, so a typo'd destination costs nothing: the alternative
	// spends a lease-renewing round trip and a multi-megabyte transfer to report it.
	const destination = await resolveDestination(
		'screenshot',
		requireOption(
			'screenshot',
			'out',
			values.out,
			'the image is written on this machine and there is no default name for it',
		),
	);
	const host = resolveHost(values.host);

	const client = await connectToHost(host);
	try {
		const answer = await client.request('screenshot', {
			// Spread rather than passed outright: an explicit `undefined` is a key on the object,
			// and `ScreenshotParamsSchema` is strict. Omitting it is what absent means on the wire.
			leaseId: parseLeaseId(leaseId ?? ''),
			...(label === undefined ? {} : { label }),
		});
		return await deliverArtifact({
			host,
			verb: 'screenshot',
			answer,
			destination,
			json: values.json === true,
			...(label === undefined ? {} : { label }),
		});
	} finally {
		await client.close();
	}
}
