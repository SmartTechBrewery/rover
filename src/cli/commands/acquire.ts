/**
 * `rover acquire` — take a lease on one device.
 *
 * `--owner` is required and **never derived**. Nothing in this file falls back to a
 * repository, a branch, a process id or whoever authenticated: that string attributes a lease
 * and authorizes nothing (D16, D20), and a value the CLI invented would attribute a device to
 * nobody in particular.
 *
 * `--project` is required too, and the one thing that may stand in for it is a value a human
 * wrote down: the `project` identifier in the hook file `ROVER_PROJECT_FILE` names (D22,
 * `src/daemon/project-hooks.ts`). Nothing is inferred from context there either — the flag
 * wins when both are present, and with no file configured the flag is required exactly as it
 * was.
 *
 * `--test-name` is required as well, and — the distinction worth keeping — unlike `--project`
 * it has **no** file to fall back on: a lease names what it is checking, and that name is this
 * lease's directory in the host's artifact archive (D22, as amended #129). A missing one is
 * exit 2 here, with this command's usage, rather than a round trip the host refuses.
 *
 * A refusal is the host's answer, not an error — it is rendered and exits 1.
 */

import { parseDeviceSerial } from '../../core/ids.js';
import { PROJECT_FILE_ENV_VAR } from '../../daemon/project-hooks.js';
import type { AcquireDeviceResult, GrantedLease } from '../../ipc/methods.js';
import {
	attributionWithDefault,
	expectPositionals,
	GLOBAL_OPTIONS,
	parseCommandArgs,
	requireAttribution,
} from '../_shared/flags.js';
import { connectToHost, resolveHost } from '../_shared/host.js';
import * as out from '../_shared/output.js';
import { configuredProject } from '../_shared/project-file.js';

export const USAGE = `rover acquire — take a lease on one device

Usage: rover acquire <serial> --owner <string> --project <string> --test-name <string>
                     [--host <name>] [--json]

  --owner        Who the lease is for. Required and never derived: it attributes the lease
                 and authorizes nothing, so a value guessed for you would attribute the
                 device to nobody.
  --project      Which project the lease belongs to. Required, for the same reason —
                 unless ${PROJECT_FILE_ENV_VAR} names a project hook file, in which case
                 that file's own 'project' is used and this flag overrides it.
  --test-name    What is being checked. Required, and deliberately not unique. Unlike
                 --project, no file stands in for it.

Both name directories in the host's artifact archive, so two runs of one test name sit
side by side there.

${PROJECT_FILE_ENV_VAR} is read on this machine and nothing else in it reaches the host: a
lease still carries the project as a plain string. A file it names that is missing or will
not parse is refused here, naming the path, rather than quietly leaving the lease
attributed to nothing.

The grant's lease id is the credential — it is the only thing that releases the lease, so
it is shown to whoever was granted it and to nobody else. A busy device is a refusal
naming the holder, and exits 1.

If the project declares helper services in its hook file on the host, the grant starts them
before answering and the release stops them. One that will not start refuses the grant,
naming the service, and leaves the device free for the next caller.`;

const OPTIONS = {
	...GLOBAL_OPTIONS,
	owner: { type: 'string' },
	project: { type: 'string' },
	'test-name': { type: 'string' },
} as const;

type Refusal = Extract<AcquireDeviceResult, { outcome: 'refused' }>;

/**
 * `projectFile` is the path the project was **defaulted** from, and `undefined` when it was
 * typed. Saying so is the point: a lease is attributed to whatever string it carries, and a
 * caller who never typed one would otherwise have to guess which project this device now
 * belongs to — or, worse, not notice that it belongs to the wrong one.
 */
export function renderGrant(lease: GrantedLease, projectFile?: string): string {
	const lines = [
		// Escaped, not because a grant is a table, but because one of its lines is meant to be
		// pasted: an owner carrying a newline could otherwise put text of its own choosing where
		// the release command belongs. The same goes for the path below, which is read out of
		// the environment rather than written here.
		`Acquired '${out.escapeControlCharacters(lease.serial)}' ` +
			`for '${out.escapeControlCharacters(lease.owner)}' ` +
			`(${out.formatAttribution(lease.project, lease.testName)}).`,
		// Labelled by what it does rather than as a receipt: it is the credential, and the only
		// thing that can end this lease.
		`Release it with: ${out.INVOCATION} release ${lease.leaseId}`,
		`Expires in ${out.formatDuration(lease.expiresInMs)} unless activity renews it.`,
	];
	if (projectFile !== undefined) {
		lines.push(
			`Project '${out.escapeControlCharacters(lease.project)}' came from ` +
				`${out.escapeControlCharacters(projectFile)} (${PROJECT_FILE_ENV_VAR}); ` +
				`pass --project to name a different one.`,
		);
	}
	return lines.join('\n');
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
	// Before the connection, so a hook file that is missing or will not parse is exit 2 with
	// the path in it rather than a device taken and then a failure.
	const configured = await configuredProject('acquire');
	const project = attributionWithDefault(
		'acquire',
		'project',
		values.project,
		configured?.project,
		`a lease names the project it belongs to, and that is yours to state — or ` +
			`${PROJECT_FILE_ENV_VAR}'s, naming a project hook file to take it from`,
	);
	const testName = requireAttribution(
		'acquire',
		'test-name',
		values['test-name'],
		'a lease names what it is checking, and that name is its directory in the ' +
			"host's artifact archive",
	);
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
			// Nothing about the provenance goes in the document: `--json` is the host's answer
			// plus the host's name, and a key describing this machine's own configuration is not
			// part of the grant a script parses.
			out.printJson(host, result);
		} else if (result.outcome === 'granted') {
			out.info(
				renderGrant(result.lease, values.project === undefined ? configured?.path : undefined),
			);
		} else {
			out.error(renderRefusal(result));
		}
		return result.outcome === 'granted' ? 0 : 1;
	} finally {
		await client.close();
	}
}
