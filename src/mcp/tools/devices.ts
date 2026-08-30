/**
 * The four device and lease tools: `status`, `list_devices`, `acquire_device`,
 * `release_device`.
 *
 * **The schemas from `src/ipc/methods.ts` *are* the tool declarations** (ai/CODING_STANDARDS.md,
 * boundary #1). Each `inputSchema` below is the exact `*ParamsSchema` the daemon parses the
 * request with, handed to `registerTool` whole — so the JSON Schema an agent reads and the
 * parse the host performs are one object, and there is no second, hand-written copy to drift.
 * The SDK validates incoming arguments against it too, which is why each handler receives the
 * branded `IpcParams` the client wants and no boundary parse is written here.
 *
 * **The names are the `IPC_METHODS` keys**, unchanged and with no platform suffix (D10) — a
 * tool that renamed a row would be a second vocabulary for the same operation.
 *
 * **Zero verb logic.** Every handler is one {@link callHost} and one answer. Whether a device
 * is free, when a lease ends and what a refusal means are the host's to decide (D16); a second
 * opinion living in a client is how two answers start disagreeing. `status` and `list_devices`
 * in particular go through the same rows `rover status` and `rover list` use, so nothing
 * device-shaped exists only inside this layer (ai/RULES.md §1).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HostName } from '../../daemon/host.js';
import {
	AcquireDeviceParamsSchema,
	ListDevicesParamsSchema,
	ReleaseDeviceParamsSchema,
	StatusParamsSchema,
} from '../../ipc/methods.js';
import { guarded, toolAnswer, toolRefusal } from '../_shared/answer.js';
import { callHost } from '../_shared/call.js';

export function registerDeviceTools(server: McpServer, host: HostName): void {
	server.registerTool(
		'status',
		{
			title: 'Rover host status',
			description:
				'Ask the Rover host this server is configured for whether it is up, and what it is: ' +
				'its pid, how long it has been running and the IPC protocol version it speaks. ' +
				'Which host that is comes from this server’s own configuration and is not something ' +
				'a tool can choose. Answering at all is the smallest check that the host is reachable.',
			inputSchema: StatusParamsSchema,
		},
		async () => guarded('status', async () => toolAnswer(await callHost(host, 'status', {}))),
	);

	server.registerTool(
		'list_devices',
		{
			title: 'List devices',
			description:
				'Every device attached to the Rover host, what the host knows about each, and who ' +
				'holds it: `heldBy` is null for a free device, and otherwise names the owner, the ' +
				'project and how much longer the lease runs. Only hardware physically attached to ' +
				'the host is ever listed. `stale: true` means the host is not in a position to know ' +
				'what is attached — with it set, an empty list means *no view*, not *no devices*, so ' +
				'do not read it as "nothing is connected".',
			inputSchema: ListDevicesParamsSchema,
		},
		async () =>
			guarded('list_devices', async () => toolAnswer(await callHost(host, 'list_devices', {}))),
	);

	server.registerTool(
		'acquire_device',
		{
			title: 'Acquire a device',
			description:
				'Take a lease on one device by serial, so no other agent drives it while you do. ' +
				'The returned `lease.leaseId` is the credential every later call carries and the only ' +
				'thing that releases the lease — keep it. `owner`, `project` and the optional ' +
				'`testName` are attribution you supply and Rover never derives from a branch, a ' +
				'process or whoever authenticated: say who this lease is for. They authorize nothing. ' +
				'A device someone else holds is refused rather than queued, and the refusal names the ' +
				'holder and how much longer they have; a device that is gone, not attached to this ' +
				'host, or not in a state a verb could run against is refused by name too. The device ' +
				'is re-verified at grant time, so a granted lease is a device that was there a moment ' +
				'ago rather than one that was cached.',
			inputSchema: AcquireDeviceParamsSchema,
		},
		async (params) =>
			guarded('acquire_device', async () => {
				const result = await callHost(host, 'acquire_device', params);
				// A refusal is data on the wire and an error to the agent: not getting the device
				// you asked for must never read as having got it.
				return result.outcome === 'refused'
					? toolRefusal(result.message, result)
					: toolAnswer(result);
			}),
	);

	server.registerTool(
		'release_device',
		{
			title: 'Release a device',
			description:
				'Hand a lease back by its `leaseId`, freeing the device for the next agent. The lease ' +
				'id is the credential; the owner string is not, so this is the only way to end one. ' +
				'The host restores the device state it changed as part of the release. `released: ' +
				'false` is a true answer, not a failure: an id that never existed, one released a ' +
				'moment ago and one whose lease had already expired are indistinguishable to the ' +
				'host, and either way no lease is live on it now.',
			inputSchema: ReleaseDeviceParamsSchema,
		},
		async (params) =>
			guarded('release_device', async () =>
				toolAnswer(await callHost(host, 'release_device', params)),
			),
	);
}
