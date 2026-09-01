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
 * `acquire_device` has the one variation, and it is still that object: a server pointed at a
 * project hook file declares `project` optional by *deriving* the variant from
 * `AcquireDeviceParamsSchema` (D22, `src/daemon/project-hooks.ts`), never by writing a second
 * one out. It has to be the declaration that changes, because the SDK validates against it
 * before the handler runs; the handler then fills the argument in from the same file.
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
import { PROJECT_FILE_ENV_VAR } from '../../daemon/project-hooks.js';
import {
	type AcquireDeviceParams,
	AcquireDeviceParamsSchema,
	ListDevicesParamsSchema,
	ReleaseDeviceParamsSchema,
	StatusParamsSchema,
} from '../../ipc/methods.js';
import { guarded, toolAnswer, toolRefusal } from '../_shared/answer.js';
import { callHost } from '../_shared/call.js';
import { declaring } from '../_shared/declaration.js';

/**
 * What an `acquire_device` call carries once the SDK has admitted it: the params the host
 * takes, with `project` possibly left to {@link attributedProject}. Written as the wider of
 * the two declarations below rather than inferred, because the declaration is chosen at
 * runtime and a handler typed as a union of both would be typed as neither.
 */
type AcquireArgs = Omit<AcquireDeviceParams, 'project'> & {
	project?: AcquireDeviceParams['project'];
};

/**
 * The `project` this call is attributed to: the agent's own, then the server's default.
 *
 * The throw is what the declaration below makes unreachable — with no default configured the
 * advertised schema requires `project` and the SDK refuses a call without one before this ever
 * runs. It is a throw rather than an empty string because attributing a lease to nothing is
 * precisely the failure D20 and D22 exist to prevent, and `guarded` turns it into a tool error
 * naming the tool.
 */
function attributedProject(supplied: string | undefined, fallback: string | undefined): string {
	const project = supplied ?? fallback;
	if (project === undefined) {
		throw new Error(
			`no 'project' was supplied and this server has no ${PROJECT_FILE_ENV_VAR} to default ` +
				`one from — a lease names the project it belongs to.`,
		);
	}
	return project;
}

export function registerDeviceTools(
	server: McpServer,
	host: HostName,
	defaultProject?: string,
): void {
	server.registerTool(
		'status',
		declaring({
			title: 'Rover host status',
			description:
				'Ask the Rover host this server is configured for whether it is up, and what it is: ' +
				'its pid, how long it has been running and the IPC protocol version it speaks. ' +
				'Which host that is comes from this server’s own configuration and is not something ' +
				'a tool can choose. Answering at all is the smallest check that the host is reachable.',
			inputSchema: StatusParamsSchema,
		}),
		async () => guarded('status', async () => toolAnswer(await callHost(host, 'status', {}))),
	);

	server.registerTool(
		'list_devices',
		declaring({
			title: 'List devices',
			description:
				'Every device attached to the Rover host, what the host knows about each, and who ' +
				'holds it: `heldBy` is null for a free device, and otherwise names the owner, the ' +
				'project, how much longer the lease runs, and when the lease was granted, as a UTC ' +
				"instant on the host's clock — the expiry moves when activity renews the lease, " +
				'the grant time does not. Only hardware physically attached to ' +
				'the host is ever listed. `stale: true` means the host is not in a position to know ' +
				'what is attached — with it set, an empty list means *no view*, not *no devices*, so ' +
				'do not read it as "nothing is connected".',
			inputSchema: ListDevicesParamsSchema,
		}),
		async () =>
			guarded('list_devices', async () => toolAnswer(await callHost(host, 'list_devices', {}))),
	);

	/**
	 * The SDK validates a call's arguments against this **before** the handler runs, so
	 * `project` may only be left out when this server actually has one to put there — a
	 * declaration that said otherwise would refuse the call upstream, where no handler could
	 * fill anything in, and would be lying to the agent reading it either way.
	 *
	 * Derived from the source schema rather than restated: `.partial()` over the one key, so
	 * `AcquireDeviceParamsSchema` stays the single object both the tool declaration and the
	 * host's own parse come from (ai/CODING_STANDARDS.md, boundary #1).
	 */
	const acquireParams =
		defaultProject === undefined
			? AcquireDeviceParamsSchema
			: AcquireDeviceParamsSchema.partial({ project: true });

	server.registerTool(
		'acquire_device',
		declaring({
			title: 'Acquire a device',
			description:
				'Take a lease on one device by serial, so no other agent drives it while you do. ' +
				'The returned `lease.leaseId` is the credential every later call carries and the only ' +
				'thing that releases the lease — keep it. `owner`, `project` and `testName` are ' +
				'attribution you supply and they authorize nothing: say who this lease is for. ' +
				'`owner` is never derived from a branch, a process or whoever authenticated. ' +
				"`testName` is required and names this lease's directory in the host's artifact " +
				'archive; it is deliberately not unique, so two runs of one check sit side by side ' +
				'there. ' +
				(defaultProject === undefined
					? ''
					: `\`project\` may be left out here: this server was pointed at a project hook ` +
						`file (${PROJECT_FILE_ENV_VAR}) and defaults it to '${defaultProject}'. Pass ` +
						`one to attribute the lease to something else. `) +
				'A device someone else holds is refused rather than queued, and the refusal names the ' +
				'holder and how much longer they have; a device that is gone, not attached to this ' +
				'host, or not in a state a verb could run against is refused by name too. The device ' +
				'is re-verified at grant time, so a granted lease is a device that was there a moment ' +
				'ago rather than one that was cached. If the project declares helper services, the ' +
				'host starts them before answering and stops them when the lease ends; one that will ' +
				'not start is a `service-failed` refusal naming it, because a device whose helper ' +
				'services are down would fail at the first thing you tried.',
			inputSchema: acquireParams,
		}),
		async (params: AcquireArgs) =>
			guarded('acquire_device', async () => {
				const result = await callHost(host, 'acquire_device', {
					...params,
					project: attributedProject(params.project, defaultProject),
				});
				// A refusal is data on the wire and an error to the agent: not getting the device
				// you asked for must never read as having got it.
				return result.outcome === 'refused'
					? toolRefusal(result.message, result)
					: toolAnswer(result);
			}),
	);

	server.registerTool(
		'release_device',
		declaring({
			title: 'Release a device',
			description:
				'Hand a lease back by its `leaseId`, freeing the device for the next agent. The lease ' +
				'id is the credential; the owner string is not, so this is the only way to end one. ' +
				'The host restores the device state it changed as part of the release. `released: ' +
				'false` is a true answer, not a failure: an id that never existed, one released a ' +
				'moment ago and one whose lease had already expired are indistinguishable to the ' +
				'host, and either way no lease is live on it now.',
			inputSchema: ReleaseDeviceParamsSchema,
		}),
		async (params) =>
			guarded('release_device', async () =>
				toolAnswer(await callHost(host, 'release_device', params)),
			),
	);
}
