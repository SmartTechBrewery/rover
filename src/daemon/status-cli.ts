/**
 * `npm run daemon:status` — daemon state, printed as JSON, with no agent involved.
 *
 * D16's obligation made real: whatever answers for the MCP layer has to answer for a human
 * and for Swarm too, so the query goes over the same IPC surface rather than through a
 * status path that only exists inside MCP. R10 folds this into the real CLI alongside
 * `list`, `acquire` and `release`; until then it is the one way to look at the daemon.
 *
 * It autostarts like any other client, so it doubles as the smallest end-to-end check that
 * the daemon comes up at all.
 */

import { connectToLocalDaemon } from './connect.js';

async function main(): Promise<void> {
	const client = await connectToLocalDaemon();
	try {
		const status = await client.request('status', {});
		console.log(JSON.stringify(status, null, 2));
	} finally {
		await client.close();
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
