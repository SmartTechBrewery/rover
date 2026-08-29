/**
 * `rover list` — what is attached to a host, what is free, and who holds the rest.
 *
 * One `list_devices` call and a table. The holder each row names is the host's answer
 * verbatim (D16, D22) and never carries the lease id (D20).
 */

import type { ListDevicesResult, ListedDevice } from '../../ipc/methods.js';
import { expectPositionals, GLOBAL_OPTIONS, parseCommandArgs } from '../_shared/flags.js';
import { connectToHost, resolveHost } from '../_shared/host.js';
import * as out from '../_shared/output.js';

export const USAGE = `rover list — what is attached to a host, and who holds it

Usage: rover list [--host <name>] [--json]

One row per attached device: serial, platform, model, state, and either 'free' or the
owner holding it, the project and test name they gave, and how long they have left. A view
the host cannot vouch for is called out on stderr in both modes; a host that cannot be
reached is a failure naming the socket, never an empty list.`;

const HEADINGS = ['SERIAL', 'PLATFORM', 'MODEL', 'STATE', 'HELD BY'] as const;

/**
 * The banner for a list the host does not know to be current (D6), printed in **both**
 * modes: `--json` already carries the `stale` flag, but a human piping the document through
 * a formatter still has to be told, and quietly showing a possibly-short list is the
 * failure this exists to prevent.
 */
export function staleWarning(host: string): string {
	return (
		`Warning: host '${host}' does not know this list to be current — it is the last thing ` +
		`the host saw, not what is attached now. An empty list here means no view, not no ` +
		`devices.`
	);
}

/** `free`, or the holder and what is left of their lease. */
export function renderHolder(device: ListedDevice): string {
	return device.heldBy === null ? 'free' : out.formatHolder(device.heldBy);
}

export function renderDeviceList(host: string, result: ListDevicesResult): string {
	if (result.devices.length === 0) {
		return `No devices are attached to host '${host}'.`;
	}
	return out.renderTable(
		HEADINGS,
		result.devices.map((device) => [
			device.serial,
			device.platform,
			device.model ?? '-',
			device.state,
			renderHolder(device),
		]),
	);
}

export async function run(argv: string[]): Promise<number> {
	const { values, positionals } = parseCommandArgs('list', argv, GLOBAL_OPTIONS);
	if (values.help === true) {
		out.info(USAGE);
		return 0;
	}
	expectPositionals('list', positionals, []);
	const host = resolveHost(values.host);

	const client = await connectToHost(host);
	try {
		const result = await client.request('list_devices', {});
		if (result.stale) {
			out.warn(staleWarning(host));
		}
		if (values.json === true) {
			out.printJson(host, result);
		} else {
			out.info(renderDeviceList(host, result));
		}
		return 0;
	} finally {
		await client.close();
	}
}
