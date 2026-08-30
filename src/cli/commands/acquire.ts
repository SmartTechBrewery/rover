/**
 * `rover acquire` — take a lease on one device.
 *
 * `--owner` and `--project` are required and **never derived**. Nothing in this file falls
 * back to an environment variable, a repository, a branch or a process id: those strings
 * attribute a lease and authorize nothing (D16, D20, D22), and a value the CLI invented
 * would attribute a device to nobody in particular. A refusal is the host's answer, not an
 * error — it is rendered and exits 1.
 */

import { parseDeviceSerial } from '../../core/ids.js';
import type { AcquireDeviceResult, GrantedLease } from '../../ipc/methods.js';
import {
	expectPositionals,
	GLOBAL_OPTIONS,
	optionalAttribution,
	parseCommandArgs,
	requireAttribution,
} from '../_shared/flags.js';
import { connectToHost, resolveHost } from '../_shared/host.js';
import * as out from '../_shared/output.js';

export const USAGE = `rover acquire — take a lease on one device

Usage: rover acquire <serial> --owner <string> --project <string> [--test-name <string>]
                     [--host <name>] [--json]

  --owner        Who the lease is for. Required and never derived: it attributes the lease
                 and authorizes nothing, so a value guessed for you would attribute the
                 device to nobody.
  --project      Which project the lease belongs to. Required, for the same reason.
  --test-name    What is being checked. Optional, and deliberately not unique.

Both name directories in the host's artifact archive, so two runs of one test name sit
side by side there; an absent --test-name files under 'unlabeled'.

The grant's lease id is the credential — it is the only thing that releases the lease, so
it is shown to whoever was granted it and to nobody else. A busy device is a refusal
naming the holder, and exits 1.`;

const OPTIONS = {
	...GLOBAL_OPTIONS,
	owner: { type: 'string' },
	project: { type: 'string' },
	'test-name': { type: 'string' },
} as const;

type Refusal = Extract<AcquireDeviceResult, { outcome: 'refused' }>;

export function renderGrant(lease: GrantedLease): string {
	return [
		// Escaped, not because a grant is a table, but because it is three lines and the middle
		// one is meant to be pasted: an owner carrying a newline could otherwise put text of its
		// own choosing where the release command belongs.
		`Acquired '${out.escapeControlCharacters(lease.serial)}' ` +
			`for '${out.escapeControlCharacters(lease.owner)}' ` +
			`(${out.formatAttribution(lease.project, lease.testName)}).`,
		// Labelled by what it does rather than as a receipt: it is the credential, and the only
		// thing that can end this lease.
		`Release it with: ${out.INVOCATION} release ${lease.leaseId}`,
		`Expires in ${out.formatDuration(lease.expiresInMs)} unless activity renews it.`,
	].join('\n');
}

export function renderRefusal(refusal: Refusal): string {
	// The host's own sentence, but not only the host's words: a `held` refusal quotes the
	// holder's owner string back into it, so it is escaped like any other echoed input.
	const lines = [
		`Not granted (${refusal.reason}): ${out.escapeControlCharacters(refusal.message)}`,
	];
	if (refusal.heldBy !== null) {
		lines.push(`Held by ${out.formatHolder(refusal.heldBy)}.`);
	}
	return lines.join('\n');
}

export async function run(argv: string[]): Promise<number> {
	const { values, positionals } = parseCommandArgs('acquire', argv, OPTIONS);
	if (values.help === true) {
		out.info(USAGE);
		return 0;
	}
	const [serial] = expectPositionals('acquire', positionals, ['<serial>']);
	const owner = requireAttribution(
		'acquire',
		'owner',
		values.owner,
		'it attributes the lease and is never derived from your environment',
	);
	const project = requireAttribution(
		'acquire',
		'project',
		values.project,
		'a lease names the project it belongs to, and that is yours to state',
	);
	const testName = optionalAttribution('acquire', 'test-name', values['test-name']);
	const host = resolveHost(values.host);

	const client = await connectToHost(host);
	try {
		const result = await client.request('acquire_device', {
			serial: parseDeviceSerial(serial ?? ''),
			owner,
			project,
			testName,
		});

		if (values.json === true) {
			out.printJson(host, result);
		} else if (result.outcome === 'granted') {
			out.info(renderGrant(result.lease));
		} else {
			out.error(renderRefusal(result));
		}
		return result.outcome === 'granted' ? 0 : 1;
	} finally {
		await client.close();
	}
}
