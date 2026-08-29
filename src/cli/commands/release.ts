/**
 * `rover release` — hand a lease back.
 *
 * The lease id is the whole of the argument list because it is the credential: the owner
 * string attributes and never authorizes, so there is no `--owner` here (D20).
 */

import { parseLeaseId } from '../../core/ids.js';
import { expectPositionals, GLOBAL_OPTIONS, parseCommandArgs } from '../_shared/flags.js';
import { connectToHost, resolveHost } from '../_shared/host.js';
import * as out from '../_shared/output.js';

export const USAGE = `rover release — hand a lease back

Usage: rover release <lease-id> [--host <name>] [--json]

The lease id is the credential: it is the only thing that ends the lease, so there is no
--owner here.

A release that found no live lease exits 1, not 0. The host cannot tell 'no such id' from
'already gone', and answering success would swallow a mistyped id.`;

export function renderRelease(leaseId: string, released: boolean): string {
	return released
		? `Released lease '${leaseId}'.`
		: `No live lease '${leaseId}' to release — either nothing ever held that id, or the ` +
				`lease had already ended. The host cannot tell those apart, so this exits 1 rather ` +
				`than 0: a mistyped lease id must not read as success.`;
}

export async function run(argv: string[]): Promise<number> {
	const { values, positionals } = parseCommandArgs('release', argv, GLOBAL_OPTIONS);
	if (values.help === true) {
		out.info(USAGE);
		return 0;
	}
	const [leaseId] = expectPositionals('release', positionals, ['<lease-id>']);
	const host = resolveHost(values.host);

	const client = await connectToHost(host);
	try {
		const result = await client.request('release_device', {
			leaseId: parseLeaseId(leaseId ?? ''),
		});

		if (values.json === true) {
			out.printJson(host, result);
		} else if (result.released) {
			out.info(renderRelease(leaseId ?? '', true));
		} else {
			out.error(renderRelease(leaseId ?? '', false));
		}
		return result.released ? 0 : 1;
	} finally {
		await client.close();
	}
}
