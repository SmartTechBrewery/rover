/**
 * The `list_host_tooling` and `install_host_tool` handlers — what this machine has, and the one
 * thing Rover can fetch for it.
 *
 * **The registry answers, and this knows no program's name.** Both handlers are one call into
 * `src/backends/registry.ts`, which asks whoever registered a `hostTooling` provider — so a third
 * backend's programs appear here with nothing in this file changed, which is ai/RULES.md §2's rule
 * about a backend costing one import line and no shared edit. Nothing here branches on a platform
 * either, for the same reason: the rows arrive tagged.
 *
 * **A report never fails.** `describeHostTooling` turns a provider that threw into a row saying so,
 * because the missing row is the one an operator came for and a `doctor` that dies on one backend
 * has told them nothing (ai/RULES.md §6).
 *
 * **An install is refused as data, not as a transport error.** An Intel Mac, a release whose layout
 * moved, a name no backend offers: each is an answer to the question rather than a failure to
 * answer it, so the caller gets `outcome: 'refused'` with a sentence, the way `sweep_archive`
 * answers a refusal. `src/ipc/server.ts` still turns a genuine escape into `internal_error`.
 *
 * **This one method writes host paths onto the surface on purpose** — `HostToolSchema` carries why
 * this is the exception to the rule `./kept-tests-handlers.ts` and `./list-archive.ts` follow.
 *
 * **One audit line per install**, `force_release_device`'s line in this key (D28): installing a
 * program changes the host for everyone who borrows from it. The actor goes through
 * `JSON.stringify` for `./kept-tests-handlers.ts`'s reason — a newline in it would otherwise end
 * the line and start a fabricated one in the daemon's own record. No token is in scope here (D20).
 */

import type { HostTooling } from '../backends/manifest.js';
import { describeHostTooling, installHostTool } from '../backends/registry.js';
import type {
	InstallHostToolParams,
	InstallHostToolResult,
	IpcHandlers,
	ListHostToolingResult,
} from '../ipc/methods.js';

export interface ToolingHandlerOptions {
	/**
	 * Where the record of an install is written. Defaults to `console.warn`, the daemon's own
	 * stderr — `./sweep-handlers.ts`' `audit`, for its reasons.
	 */
	readonly audit?: (message: string) => void;
	/** The two registry calls, injectable so a suite can describe a host it does not have. */
	readonly describe?: typeof describeHostTooling;
	readonly install?: typeof installHostTool;
}

export type ToolingHandlers = Pick<IpcHandlers, 'list_host_tooling' | 'install_host_tool'>;

export function createToolingHandlers(options: ToolingHandlerOptions = {}): ToolingHandlers {
	const audit = options.audit ?? ((message: string) => console.warn(message));
	const describe = options.describe ?? describeHostTooling;
	const install = options.install ?? installHostTool;

	return {
		async list_host_tooling(): Promise<ListHostToolingResult> {
			return { tools: (await describe()).map(onTheWire) };
		},

		async install_host_tool(params: InstallHostToolParams): Promise<InstallHostToolResult> {
			let installed: HostTooling;
			try {
				installed = await install(params.tool);
			} catch (cause) {
				audit(refusedLine(params, messageOf(cause)));
				return { outcome: 'refused', tool: params.tool, message: messageOf(cause) };
			}

			// Whether this call is what put it there is the provider's to say, and it says it in
			// `detail` — the one place that knows whether bytes were fetched or a copy was already
			// unpacked. Reading it here rather than adding a second flag keeps the provider's answer
			// and the surface's answer from being able to disagree.
			const outcome =
				installed.found !== null && /already/i.test(installed.detail)
					? ('already-present' as const)
					: ('installed' as const);
			audit(auditLine(params, outcome, installed));
			return { outcome, tool: onTheWire(installed) };
		},
	};
}

/** The registry's row, as the schema has it — the same fields, and nothing added. */
function onTheWire(tooling: HostTooling) {
	return {
		platform: tooling.platform,
		tool: tooling.tool,
		found: tooling.found,
		detail: tooling.detail,
		installable: tooling.installable,
	};
}

function auditLine(
	params: InstallHostToolParams,
	outcome: 'installed' | 'already-present',
	tooling: HostTooling,
): string {
	const what =
		outcome === 'installed'
			? `Installed '${tooling.tool}' on this host`
			: `Was asked to install '${tooling.tool}', which this host already had`;
	return `${what} (${tooling.platform}) — asked for by ${JSON.stringify(params.actor)}.`;
}

function refusedLine(params: InstallHostToolParams, reason: string): string {
	return (
		`Refused to install '${params.tool}' on this host: ${reason} — asked for by ` +
		`${JSON.stringify(params.actor)}.`
	);
}

function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
