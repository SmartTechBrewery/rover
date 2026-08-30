/**
 * One tool call is one connection: connect, one IPC request, close.
 *
 * Exactly what every CLI command does, and for the same reasons — no held connection, so no
 * reconnect state machine, no stale socket surviving a daemon restart, and no lifecycle to
 * get wrong in a server that lives as long as an agent session does. On the local host the
 * first call autostarts the daemon (D5), which is the same experience `rover status` gives.
 *
 * It adds no retry and no probe of its own. The transports' own failures already name the
 * socket or the address and port, and an unreachable host has to reach the agent as that
 * sentence rather than as an empty device list (ai/RULES.md §2).
 */

import { connectToHost, type HostName } from '../../daemon/host.js';
import type { IpcRequestOptions } from '../../ipc/client.js';
import type { IpcMethodName, IpcParams, IpcResult } from '../../ipc/methods.js';

export async function callHost<Method extends IpcMethodName>(
	host: HostName,
	method: Method,
	params: IpcParams<Method>,
	options?: IpcRequestOptions,
): Promise<IpcResult<Method>> {
	const client = await connectToHost(host);
	try {
		return await client.request(method, params, options);
	} finally {
		await client.close();
	}
}
