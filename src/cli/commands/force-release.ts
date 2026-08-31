/**
 * `rover force-release` — end the lease somebody else holds on a device.
 *
 * The argument is the **serial**, not a lease id, and that is the whole shape of the command:
 * ending a lease you do not hold cannot present that holder's credential, and handing the id
 * out so it could is the disclosure the protocol refuses (D20, `ListedDeviceSchema`). So the
 * call names a device an operator can already see in `rover list`.
 *
 * `--actor` is required and **never derived** — `acquire`'s reasoning word for word: it records
 * who ended somebody else's lease, and a value this CLI invented would attribute the action to
 * nobody. Nothing here falls back to the environment, to a project hook file or to whoever
 * authenticated to the host (D28).
 *
 * Exposed at all because D4 makes the CLI the interface everything is debugged through: an
 * operator action that only a browser can perform is one nobody can reach when the browser is
 * the thing that is broken.
 */

import { parseDeviceSerial } from '../../core/ids.js';
import type { ForceReleaseDeviceResult, LeaseHolder } from '../../ipc/methods.js';
import { EXIT_FAILED, EXIT_OK } from '../_shared/exit.js';
import {
	expectPositionals,
	GLOBAL_OPTIONS,
	parseCommandArgs,
	requireAttribution,
} from '../_shared/flags.js';
import { connectToHost, resolveHost } from '../_shared/host.js';
import * as out from '../_shared/output.js';

export const USAGE = `rover force-release — end the lease somebody else holds on a device

Usage: rover force-release <serial> --actor <string> [--host <name>] [--json]

  --actor        Who is ending it. Required and never derived: it is the record of who ended
                 somebody else's lease, so a value guessed for you would attribute the action
                 to nobody.

The argument is the device serial, not a lease id: the lease id is its holder's credential
and is never handed to anyone else, so an operator names the device instead.

The device is restored exactly as it is on a normal release — the applications, the radios,
the project's helper services, then its teardown hook — because this ends the lease through
the same path (D9).

The holder is not asked and is not warned. Its next verb call fails with 'no-lease', naming
what happened, rather than driving a device somebody else may since have acquired.

A device nobody is holding is a refusal, not an error, and exits 1: 'not-held' means the
device is here and free, 'gone' that the host can no longer see it at all, and
'not-attached' that it is visible but belongs to another machine and so was never leasable.`;

const OPTIONS = {
	...GLOBAL_OPTIONS,
	actor: { type: 'string' },
} as const;

type Refusal = Extract<ForceReleaseDeviceResult, { outcome: 'refused' }>;

export function renderForceRelease(serial: string, heldBy: LeaseHolder): string {
	return (
		`Force-released the lease on '${out.escapeControlCharacters(serial)}' — it was held by ` +
		`${out.formatHolder(heldBy)}.`
	);
}

export function renderForceReleaseRefusal(refusal: Refusal): string {
	// The host's own sentence, escaped like any echoed value: it quotes the serial the caller
	// typed back into it, and a serial carrying a newline could otherwise forge a line.
	return `Nothing force-released (${refusal.reason}): ${out.escapeControlCharacters(refusal.message)}`;
}

export async function run(argv: string[]): Promise<number> {
	const { values, positionals } = parseCommandArgs('force-release', argv, OPTIONS);
	if (values.help === true) {
		out.info(USAGE);
		return EXIT_OK;
	}
	const [serial] = expectPositionals('force-release', positionals, ['<serial>']);
	const actor = requireAttribution(
		'force-release',
		'actor',
		values.actor,
		`it records who ended somebody else's lease and is never derived from your environment`,
	);
	const host = resolveHost(values.host);

	const client = await connectToHost(host);
	try {
		const result = await client.request('force_release_device', {
			serial: parseDeviceSerial(serial ?? ''),
			actor,
		});

		if (values.json === true) {
			out.printJson(host, result);
		} else if (result.outcome === 'released') {
			out.info(renderForceRelease(serial ?? '', result.heldBy));
		} else {
			out.error(renderForceReleaseRefusal(result));
		}
		return result.outcome === 'released' ? EXIT_OK : EXIT_FAILED;
	} finally {
		await client.close();
	}
}
