/**
 * `rover status` — which host answered, and what it is.
 *
 * Also the smallest end-to-end check there is: it autostarts like every other client (D5),
 * so an answer here means the daemon came up and is serving the IPC surface.
 *
 * `uptimeMs` is a duration rather than a start instant because the caller may be on another
 * machine and shares no clock with the host (D17); the line below reports it as one.
 */

import type { StatusResult } from '../../ipc/methods.js';
import { expectPositionals, GLOBAL_OPTIONS, parseCommandArgs } from '../_shared/flags.js';
import { connectToHost, resolveHost } from '../_shared/host.js';
import * as out from '../_shared/output.js';

export const USAGE = `rover status — which host answered, its pid, uptime and protocol version

Usage: rover status [--host <name>] [--json]

Starts the local daemon if none is running, so this is also the smallest check that it
comes up at all.`;

export function renderStatus(host: string, status: StatusResult): string {
	return [
		`host: ${host}`,
		`pid: ${status.pid}`,
		`uptime: ${out.formatDuration(status.uptimeMs)}`,
		`protocol version: ${status.protocolVersion}`,
	].join('\n');
}

export async function run(argv: string[]): Promise<number> {
	const { values, positionals } = parseCommandArgs('status', argv, GLOBAL_OPTIONS);
	if (values.help === true) {
		out.info(USAGE);
		return 0;
	}
	expectPositionals('status', positionals, []);
	const host = resolveHost(values.host);

	const client = await connectToHost(host);
	try {
		const result = await client.request('status', {});
		if (values.json === true) {
			out.printJson(host, result);
		} else {
			out.info(renderStatus(host, result));
		}
		return 0;
	} finally {
		await client.close();
	}
}
