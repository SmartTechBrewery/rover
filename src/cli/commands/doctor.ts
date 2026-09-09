/**
 * `rover doctor` — what the **host** has installed, and the one program Rover can install for it.
 *
 * **It asks a host, unlike `users` and `init`.** That is the whole point rather than an
 * implementation detail: a program a device backend drives has to be on the machine the devices
 * are on, which is the host and not necessarily this laptop (D17, D19). A doctor that inspected
 * the machine it was typed on would confidently fix the wrong computer, and it could not inspect a
 * backend at all — `tests/unit/no-backend-in-a-client.test.ts` is what stops a client reaching
 * one.
 *
 * **Report by default, install only when asked.** The plain form changes nothing on the host and
 * is safe to run against somebody else's machine; `--fix` downloads and unpacks, so it takes
 * `--actor` for `sweep`'s and `force-release`'s reason — it records who changed a host everybody
 * borrows from, authorizes nothing, and is never derived (D20, D28).
 *
 * **`--fix` installs only what the host reported as installable and missing.** Rover fetches its
 * own second-order tooling and never a platform SDK, so a program that arrives with one is
 * reported with the search's own message and left alone: a copy Rover downloaded would fight the
 * operator's own install, and each backend's own folder carries that reasoning.
 *
 * **Host paths are printed here on purpose**, which no other command does — `HostToolSchema` in
 * `src/ipc/methods.ts` carries why this method is the exception: *which* copy of a program won the
 * host's search **is** the diagnosis. They are printed as text and nothing resolves them.
 *
 * **This file names no program and no platform** (D10), which is worth stating in a command whose
 * whole subject is programs: every name it prints arrived from the host at runtime, and which of
 * them can be installed is a backend's own declaration. A list here would be the second place to
 * edit the day a backend learns to install something —
 * `tests/unit/no-platform-names.test.ts` is what keeps that true.
 */

import type { HostTool, InstallHostToolResult, ListHostToolingResult } from '../../ipc/methods.js';
import { EXIT_FAILED, EXIT_OK } from '../_shared/exit.js';
import {
	expectPositionals,
	GLOBAL_OPTIONS,
	parseCommandArgs,
	requireAttribution,
} from '../_shared/flags.js';
import { connectToHost, type HostName, resolveHost } from '../_shared/host.js';
import * as out from '../_shared/output.js';

export const USAGE = `rover doctor — the programs this host needs, and what Rover can install

Usage:
  rover doctor [--host <name>] [--json]
  rover doctor --fix --actor <string> [--host <name>] [--json]

  --fix    Install what is missing and installable, then report again. Downloads on the
           **host**, never here.
  --actor  Who is asking. Required with --fix and never derived: installing a program
           changes the host for everybody who borrows a device from it.

The plain form changes nothing. It reports one row per program a registered device backend
needs on the machine that holds the devices: where this host found it, or what is missing.

Rover installs its own second-order tooling and never a platform SDK. A program with no package
manager and no installer of its own is one --fix unpacks a pinned release of, under the host's
own ~/.rover, where that program's search looks last. A program that ships with a platform's
SDK is reported and left alone: a second copy Rover fetched would fight the one you installed.

Which programs exist, and which of them can be installed, is each backend's own declaration —
so the rows you get are whatever the host's backends need, and this command knows none of their
names.

Because the answer describes the host's own installation, this is the one command whose output
carries paths on that machine. They are printed, never opened.`;

const OPTIONS = {
	...GLOBAL_OPTIONS,
	actor: { type: 'string' },
	fix: { type: 'boolean', default: false },
} as const;

const HEADINGS = ['PLATFORM', 'PROGRAM', 'STATE', 'WHERE'] as const;

export async function run(argv: string[]): Promise<number> {
	const { values, positionals } = parseCommandArgs('doctor', argv, OPTIONS);
	if (values.help === true) {
		out.info(USAGE);
		return EXIT_OK;
	}
	expectPositionals('doctor', positionals, []);

	const host = resolveHost(values.host);
	const fix = values.fix === true;
	// Parsed before the connection, so a missing --actor is a usage error rather than a daemon
	// somebody autostarted to be told they mistyped a flag.
	const actor = fix
		? requireAttribution(
				'doctor',
				'actor',
				values.actor,
				'it records who installed a program on this host and is never derived from your environment',
			)
		: null;

	const client = await connectToHost(host);
	try {
		const before: ListHostToolingResult = await client.request('list_host_tooling', {});
		const installs: InstallHostToolResult[] = [];

		if (actor !== null) {
			for (const tool of before.tools.filter(missingAndInstallable)) {
				installs.push(await client.request('install_host_tool', { tool: tool.tool, actor }));
			}
		}

		// Re-read rather than patching the first answer with what each install claimed: the host is
		// the truth about itself, and an install that reported success while leaving nothing a
		// search accepts is exactly the case a doctor exists to catch.
		const after: ListHostToolingResult =
			actor === null ? before : await client.request('list_host_tooling', {});

		if (values.json === true) {
			out.printJson(host, { tools: after.tools, installs });
		} else {
			out.info(render(host, after.tools, installs));
		}
		return after.tools.every((tool) => tool.found !== null) ? EXIT_OK : EXIT_FAILED;
	} finally {
		await client.close();
	}
}

/** What `--fix` acts on: absent, and something a backend offered to fetch. */
function missingAndInstallable(tool: HostTool): boolean {
	return tool.found === null && tool.installable;
}

/**
 * The table, then a line per program that is missing, then what any install did.
 *
 * The detail lines go **below** the table rather than into a fifth column: a missing program's
 * detail is the search's own message and runs to several lines, which no column can hold.
 */
export function render(
	host: HostName,
	tools: readonly HostTool[],
	installs: readonly InstallHostToolResult[],
): string {
	const rows = tools.map((tool) => [
		out.escapeControlCharacters(tool.platform),
		out.escapeControlCharacters(tool.tool),
		tool.found === null ? 'missing' : 'ok',
		out.escapeControlCharacters(tool.found ?? '—'),
	]);

	const sections = [
		`host: ${host}`,
		tools.length === 0
			? 'No device backend on this host reported any program it needs.'
			: out.renderTable([...HEADINGS], rows),
		...tools.filter((tool) => tool.found === null).map((tool) => `${tool.tool}: ${detail(tool)}`),
		...installs.map(renderInstall),
	];
	return sections.join('\n\n');
}

function renderInstall(install: InstallHostToolResult): string {
	return install.outcome === 'refused'
		? `Could not install '${out.escapeControlCharacters(install.tool)}': ${lines(install.message)}`
		: lines(install.tool.detail);
}

/** A tool's detail, as a person reads it. */
function detail(tool: HostTool): string {
	return lines(tool.detail);
}

/**
 * Escape **per line**, so a message that is a numbered list stays one.
 *
 * `escapeControlCharacters` is what every command puts host-supplied text through, and it turns a
 * newline into a literal `\n` — right for a table cell, wrong here: the two searches this command
 * prints answer with a numbered place-per-line list, which is the readable half of the failure and
 * would arrive as one unbroken line. Splitting first keeps the newlines the host meant and still
 * escapes everything else in each line, so nothing in a path can move the cursor or fake a row.
 */
function lines(text: string): string {
	return text
		.split('\n')
		.map((line) => out.escapeControlCharacters(line))
		.join('\n');
}
