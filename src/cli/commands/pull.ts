/**
 * `rover pull` — read a file off the device and write it **on this machine**.
 *
 * The third command to receive an artifact, and it adds nothing to how: `pull_file` answers
 * on `ActionResult.artifact` exactly where `screenshot` puts a capture
 * (`src/verbs/files.ts`), so this is `screenshot` with a device path in the call and
 * `../_shared/artifact.ts` doing the same decode, the same length check and the same write.
 *
 * Two paths, on two machines, and the command's whole shape says which is which: the
 * positional is **the device's** and goes on the wire unmodified, checked there by
 * `DevicePathSchema` because nothing between here and the device interprets it; `--out` is
 * **this machine's** and is required, for the reason `screenshot --out` is — there is no
 * filename this CLI could invent that anything calling it could predict.
 *
 * A file too large for one answer, or one that did not survive the trip, exits 1 and leaves
 * no file at `--out` at all: the write is the last thing `deliverArtifact` does and only on
 * the `ok` branch.
 *
 * **`--app` turns the positional into a path inside that application's own data container**
 * and the request into `pull_app_file` (#334) — the same answer, the same write, a different
 * address. The app id is parsed here the way the lease id is; the path goes on the wire as
 * typed and `ContainerPathSchema` checks it on the host, as `DevicePathSchema` does without
 * `--app`.
 */

import { parseAppId, parseLeaseId } from '../../core/ids.js';
import { deliverArtifact, resolveDestination } from '../_shared/artifact.js';
import {
	expectPositionals,
	GLOBAL_OPTIONS,
	parseCommandArgs,
	requireOption,
} from '../_shared/flags.js';
import { connectToHost, resolveHost } from '../_shared/host.js';
import * as out from '../_shared/output.js';

export const USAGE = `rover pull — read a file off the device onto this machine

Usage: rover pull <lease-id> <device-path> --out <path> [--host <name>] [--json]
       rover pull <lease-id> <container-path> --app <app-id> --out <path> [--host <name>] [--json]

  <device-path>  The file to read, on the device. Absolute, and naming a file rather than
                 a directory — a pull is one whole file, never a recursive copy.
  --app          Read from this application's own data container instead — its databases,
                 shared preferences and files, which a device path does not reach. The
                 positional is then relative to that container (databases/app.db): no
                 leading /, no '..'. A device opens only the builds its platform allows
                 (a debuggable build, where that is the rule); any other is refused by
                 name, never read as an empty file.
  --out          Where to write those bytes, on the machine running this command.
                 Required, for the reason \`screenshot --out\` is: the read happens on the
                 host and the file comes back as bytes, so the destination is this
                 client's to choose and there is no default name it could invent.

The lease id is the credential, exactly as it is for release. The path printed is your own,
absolute; no host-local path is ever reported. A file too large for one answer, or one that
did not survive the trip, is refused by name, exits 1 and writes nothing at all — never a
file cut short.

A pull answers with the bytes of one regular file. A directory, a character device or any
other special file on the device is refused before the transfer starts rather than bounded
afterwards: asking how big a directory is answers for the directory itself, whatever the tree
under it holds, and a character device answers zero and then reads without end — so the size
bound would not hold on either.

A SQLite database in WAL mode is consistent only together with its -wal file, and each pull
is one file at its own moment. Stop the app first, then pull the database and its -wal
(and -shm) to the same directory.`;

const OPTIONS = {
	...GLOBAL_OPTIONS,
	out: { type: 'string' },
	app: { type: 'string' },
} as const;

export async function run(argv: string[]): Promise<number> {
	const { values, positionals } = parseCommandArgs('pull', argv, OPTIONS);
	if (values.help === true) {
		out.info(USAGE);
		return 0;
	}
	const [leaseId, path] = expectPositionals('pull', positionals, [
		'<lease-id>',
		values.app === undefined ? '<device-path>' : '<container-path>',
	]);
	// Resolved before the connection, so a typo'd destination costs nothing — the same
	// ordering `screenshot` keeps, and here the transfer it would waste is the device's file.
	const destination = await resolveDestination(
		'pull',
		requireOption(
			'pull',
			'out',
			values.out,
			'the file is written on this machine and there is no default name for it',
		),
	);
	// Parsed before the connection too, so a malformed id is refused without reaching a host.
	const appId = values.app === undefined ? undefined : parseAppId(values.app);
	const host = resolveHost(values.host);

	const client = await connectToHost(host);
	try {
		const lease = parseLeaseId(leaseId ?? '');
		const answer =
			appId === undefined
				? await client.request('pull_file', { leaseId: lease, devicePath: path ?? '' })
				: await client.request('pull_app_file', {
						leaseId: lease,
						appId,
						containerPath: path ?? '',
					});
		return await deliverArtifact({
			host,
			verb: appId === undefined ? 'pull_file' : 'pull_app_file',
			answer,
			destination,
			json: values.json === true,
		});
	} finally {
		await client.close();
	}
}
