/**
 * What an agent is told the verb tools are — `tools/list`, read through a real MCP client.
 *
 * The claim under test is the one this layer rests on: **the Zod schemas in
 * `src/ipc/methods.ts` are the tool declarations** (ai/CODING_STANDARDS.md, boundary #1). So
 * every expectation here is *derived* — from the `IPC_METHODS` table, and through the SDK's own
 * schema conversion, the same call `registerTool`'s advertisement goes through. A test that
 * spelled the properties out again would be the second hand-written copy this design exists to
 * avoid, and it would go green on the day the two drifted together.
 *
 * `./declarations.test.ts` is the same suite for the four device and lease rows; the
 * completeness gate at the bottom of this file is what covers the whole table at once.
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { afterEach, describe, expect, it } from 'vitest';
import { InstallAppParamsSchema, IPC_METHODS, type IpcMethodName } from '@/ipc/methods.js';
import { connectMcpAgent } from '../../helpers/mcp-agent.js';

/** The twenty-one verb rows exposed as tools, in `IPC_METHODS` order. */
const VERB_METHODS = [
	'wait_for',
	'wait_until_gone',
	'tap',
	'long_press',
	'swipe',
	'scroll',
	'type_text',
	'press_key',
	'read_screen',
	'device_info',
	'screenshot',
	'launch_app',
	'stop_app',
	'clear_app_data',
	'read_logs',
	'install_app',
	'record_video',
	'start_recording',
	'stop_recording',
	'set_airplane_mode',
	'set_wifi',
] as const satisfies readonly IpcMethodName[];

/**
 * The one row whose declaration is **not** its params schema whole.
 *
 * `install_app` advertises `InstallAppParamsSchema` minus `packageBase64`, so the tool is the
 * byte-less form — the one that runs the lease's project `install` hook (D13) — and there is no
 * way to paste megabytes of base64 into a tool argument. It is still that schema: the assertion
 * below derives the expectation with the same `.omit()` the declaration uses, so a hand-written
 * second shape cannot creep in here either.
 */
const NARROWED_METHODS = ['install_app'] as const satisfies readonly IpcMethodName[];

/** The device and lease rows `./declarations.test.ts` owns. Not verbs, and not this suite's subject. */
const DEVICE_METHODS = ['status', 'list_devices', 'acquire_device', 'release_device'] as const;

/**
 * The rows deliberately **not** exposed — the two file transfers and the operator action, for
 * two unrelated reasons.
 *
 * For the transfers the reason is that **a whole file as a tool argument is the thing that has
 * not been settled**, not that they carry bytes at all.
 *
 * `force_release_device` is here for a reason that will not expire: **an agent must not be able
 * to end another agent's lease.** The whole point of the row is authority over the shared pool
 * rather than a step in one caller's own work, which is what makes it an operator action (D27,
 * D28) reached from the CLI and, later, the panel. Exposing it as a tool would hand every agent
 * on every machine the power to take a device out from under a peer mid-run — and it would do
 * it by way of the surface whose refusals are supposed to *tell* an agent that a device is
 * busy. It is recorded here as a decision rather than left as a row that quietly has no tool.
 *
 * `screenshot`, `record_video` and `stop_recording` answer *with* bytes, and R19 phase 3 settled
 * what a tool does with those: an inline image, or a file this server writes on the agent's own
 * machine (`src/mcp/_shared/artifact.ts`). `install_app` used to sit here beside these two and no
 * longer does, which is the distinction: it has a **second form that carries no bytes** — the
 * lease's project runs its own install (D13) — so the tool is that form and the payload is
 * simply not in the declaration. `push_file` has no such form. Its whole subject is a file
 * from the agent's machine, capped at 4 MiB, which an agent would have to produce as several
 * megabytes of base64 in a tool argument; and `pull_file` is the same question in the other
 * direction, whose answer is a destination on the agent's disk that R19 phase 3 settled only
 * for the two artifact rows. Both wait for R24 phase 2, which is a mechanism underneath these
 * verbs rather than a decision one adapter can take in passing.
 *
 * `list_archive` is here for a reason of the same kind as `force_release_device`'s: it is not
 * about a device at all. It reads the **host's** artifact archive (D24, R36), which is the
 * operator's and the panel's surface — while an agent already receives its own artifacts as bytes
 * in the verb's own answer (D19), so there is nothing here it needs and could not already have.
 * Advertising it would hand every agent a listing of every other agent's runs on the host.
 *
 * `search_archive` is here for `list_archive`'s reason **with more force** (R38). It reads the same
 * host archive, so an agent already has everything of its own as bytes in the verb's own answer
 * (D19) and needs nothing here — but where `list_archive` at least made an agent walk to another
 * agent's runs one level at a time, one `search_archive` call hands over the run names of every
 * other agent on the host in a single answer. It is on `PANEL_METHODS` instead, which is the
 * operator's own browser (D27, D29).
 *
 * `list_archive_groups` is here on `search_archive`'s exact terms (R41, #178): it is the archive's
 * third read, and one call answers which runs share a group and which of their artifacts share a
 * label across every project on the host — which is every other agent's run names, handed over
 * without a walk. An agent already knows its own group and its own labels: it chose them, and the
 * bytes came back in the verb's own answer (D19). The arrangement is the operator's browser's
 * (D27, D29).
 *
 * `measure_archive` and `measure_archive_groups` are here on `list_archive`'s exact terms (R49,
 * #259, #262) — the two rows that answer *how much* rather than *what*, one over an address and one
 * over the **grouped** runs of everything, of one project or of one group. How much disk the
 * operator's archive takes is that operator's browser's question, and an agent that could ask
 * either could size every other agent's project — or every other agent's grouped work — on the
 * host. An agent needs neither: its own artifacts came back as bytes in the verb's own answer
 * (D19), and it already knows its own group, having chosen it. Both are on `PANEL_METHODS` instead
 * (D27, D29).
 *
 * `list_projects` is here for a reason of the same kind and not the same one: it is not about a
 * device at all, and it is not about the archive either — it answers what the **host operator**
 * configured this machine to run around a lease (R39, D31). An agent already gets everything its
 * own lease implies without asking, and enumerating every other project registered on the host is
 * an operator's question. It is on `PANEL_METHODS` instead (D27, D29).
 *
 * `list_kept_tests` and `set_kept_tests` are here for `force_release_device`'s reason rather than
 * for the archive's, and it is the sharper of the two (D33, #234). The archive reads are the
 * operator's because they are about the host's disk; **what the operator keeps is not an agent's to
 * decide at all** — it is authority over a shared resource, and an agent that could untick a test
 * would be clearing the exemption on somebody else's run. The read is not advertised either, on
 * `list_archive`'s terms: an agent already knows its own project and test name, having supplied
 * them, and enumerating what every other agent on the host has kept is an operator's question. Both
 * are on `PANEL_METHODS` instead, which is the operator's own browser (D27, D29).
 *
 * `sweep_archive` is here for `force_release_device`'s reason with the stakes raised (§9.4, #238).
 * That row ends somebody else's lease; this one **deletes an operator's data** on a shared host —
 * whole run directories, permanently, with no undo and no trash directory. It is authority over
 * the host's own disk rather than a step in any agent's work, so it is an operator's press reached
 * from the CLI, and it is not on `PANEL_METHODS` either: a browser is not where an irreversible
 * deletion of somebody else's runs belongs while D27's role model is still deferred. An agent
 * needs nothing here in any case — its own artifacts came back as bytes in the verb's own answer
 * (D19).
 *
 * The list is short and named so the gate below can be exact: a verb row added later is either
 * a registered tool or a deliberate entry here, never a row that quietly has no tool.
 */
const NOT_YET_EXPOSED = [
	'push_file',
	'pull_file',
	'force_release_device',
	'list_archive',
	'search_archive',
	'list_archive_groups',
	'measure_archive',
	'measure_archive_groups',
	'list_projects',
	'list_kept_tests',
	'set_kept_tests',
	'sweep_archive',
] as const satisfies readonly IpcMethodName[];

/** The platform vocabulary `tests/unit/no-platform-names.test.ts` keeps out of `src/` (D10). */
const PLATFORM_NAMES = /android|ios|iphone|ipad|adb|simctl|xcrun|uiautomator|emulator|espresso/i;

interface AdvertisedTool {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
}

const clients: Client[] = [];

async function advertisedTools(): Promise<AdvertisedTool[]> {
	const client = await connectMcpAgent('local');
	clients.push(client);
	return (await client.listTools()).tools as unknown as AdvertisedTool[];
}

/** One advertised tool, or a failed test naming what was missing. */
function toolNamed(tools: AdvertisedTool[], name: string): AdvertisedTool {
	const found = tools.find((tool) => tool.name === name);
	if (!found) {
		throw new Error(`No tool is advertised under '${name}'`);
	}
	return found;
}

/**
 * The JSON Schema an `IPC_METHODS` row's params schema converts to, through the SDK's own
 * converter with the SDK's own options — which is what `registerTool` puts on the wire.
 *
 * Derived this way rather than written out so the comparison below is the whole object: not
 * "the same properties", but the same schema, `anyOf` branches and bounds and all.
 */
function declarationOf(method: IpcMethodName): Record<string, unknown> {
	return toJsonSchemaCompat(IPC_METHODS[method].params, {
		strictUnions: true,
		pipeStrategy: 'input',
	});
}

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe('what tools/list advertises for the verbs', () => {
	it('names the nineteen verb rows, spelled exactly as IPC_METHODS spells them', async () => {
		const tools = await advertisedTools();

		const device: readonly string[] = DEVICE_METHODS;
		const verbs = tools.map((tool) => tool.name).filter((name) => !device.includes(name));
		// The `IPC_METHODS` keys verbatim. A renamed tool would be a second vocabulary for the same
		// operation, and there is one set of verbs — no `_android`, no platform suffix (D10).
		expect(verbs.sort()).toEqual([...VERB_METHODS].sort());
	});

	it('puts no platform name in any tool name', async () => {
		const tools = await advertisedTools();

		for (const tool of tools) {
			expect(tool.name).not.toMatch(PLATFORM_NAMES);
		}
	});

	it('declares each verb from its own params schema, whole', async () => {
		const tools = await advertisedTools();

		const narrowed: readonly string[] = NARROWED_METHODS;
		for (const method of VERB_METHODS.filter((name) => !narrowed.includes(name))) {
			expect(toolNamed(tools, method).inputSchema).toEqual(declarationOf(method));
		}
	});

	it('declares install_app as that same schema with the payload taken off it', async () => {
		const tools = await advertisedTools();

		// Derived with the `.omit()` the declaration itself uses, so this is "the host's object,
		// narrowed" rather than a second shape written out beside it. The property assertion under
		// it is the part that would notice a widening: a `packageBase64` back on this tool is an
		// agent being invited to paste an APK into a JSON argument.
		expect(toolNamed(tools, 'install_app').inputSchema).toEqual(
			toJsonSchemaCompat(InstallAppParamsSchema.omit({ packageBase64: true }), {
				strictUnions: true,
				pipeStrategy: 'input',
			}),
		);
		expect(Object.keys(toolNamed(tools, 'install_app').inputSchema.properties as object)).toEqual([
			'leaseId',
		]);
	});

	it('shares one declaration between the rows that share one params schema', async () => {
		const tools = await advertisedTools();

		// Three app rows on `AppVerbParamsSchema` and two environment rows on
		// `EnvironmentVerbParamsSchema`: the calls are identical, so a near-copy per row would be
		// a copy that drifts. Asserted on the advertised schemas, which is where a fork would show.
		const app = ['launch_app', 'stop_app', 'clear_app_data'].map(
			(name) => toolNamed(tools, name).inputSchema,
		);
		expect(app).toEqual([app[0], app[0], app[0]]);
		expect(toolNamed(tools, 'set_wifi').inputSchema).toEqual(
			toolNamed(tools, 'set_airplane_mode').inputSchema,
		);
	});

	it('asks every verb for the lease id and never for a serial or a host', async () => {
		const tools = await advertisedTools();

		for (const method of VERB_METHODS) {
			const schema = toolNamed(tools, method).inputSchema;
			// The lease id is the credential and the host derives the device from it (D20); a
			// serial accepted beside it is the one field that would let the holder of one lease
			// drive another device. And where the hardware sits is server configuration (D17), so
			// no tool may offer an agent a host, an address, a port or a token to choose.
			expect(schema.required).toContain('leaseId');
			expect(Object.keys(schema.properties as object)).not.toContain('serial');
			for (const property of Object.keys(schema.properties as object)) {
				expect(property.toLowerCase()).not.toMatch(/host|address|port|token/);
			}
		}
	});

	it('offers the three byte-carrying rows no destination and no format', async () => {
		const tools = await advertisedTools();

		// D19, stated as a declaration rather than as prose: the capture happens on the host,
		// which may be another machine, so a path sent there would name nothing or name the wrong
		// disk — and the format is what the device recorder produced rather than something a
		// caller picks. Where the recording lands on *this* machine is server configuration
		// (`ROVER_MCP_ARTIFACT_DIR`), which is why there is nothing here to offer a model.
		for (const method of ['screenshot', 'record_video', 'stop_recording']) {
			const properties = Object.keys(toolNamed(tools, method).inputSchema.properties as object);
			for (const property of properties) {
				expect(property.toLowerCase()).not.toMatch(/out|path|dest|dir|file|format|codec/);
			}
		}
	});

	it('gives every verb a description, and names the capability on the rows that need one', async () => {
		const tools = await advertisedTools();

		for (const method of VERB_METHODS) {
			expect(toolNamed(tools, method).description ?? '').not.toHaveLength(0);
		}
		// D11 legibility *before* the call: an agent that reads the capability in the declaration
		// can check it against the list `acquire_device` handed it, rather than discovering the
		// asymmetry from a failure.
		expect(toolNamed(tools, 'read_screen').description).toContain('canReadScreen');
		for (const method of ['set_wifi', 'set_airplane_mode']) {
			expect(toolNamed(tools, method).description).toContain('canControlNetwork');
		}
	});

	/**
	 * The same legibility-before-the-call argument, applied to the one answer that is easy to
	 * mistake for a broken tool (#183). An agent that reads the declaration knows a recording of
	 * a still screen exists as a case *before* it records one, rather than working it out from a
	 * one-frame answer and an `ffprobe` run — which is how it was worked out the first time, and
	 * the conclusion was that Rover does not record video.
	 */
	it('tells an agent what a recording of a still screen looks like, before it takes one', async () => {
		const description = (await advertisedTools()).find(
			(tool) => tool.name === 'record_video',
		)?.description;

		expect(description).toContain('still-screen');
		expect(description).toMatch(/did not change/i);
		expect(description).toMatch(/virtual display/i);
		expect(description).toMatch(/rather than a fault/i);
	});
});

describe('the completeness gate over IPC_METHODS', () => {
	it('leaves no row without either a tool or a deliberate entry saying why not', async () => {
		const advertised = new Set((await advertisedTools()).map((tool) => tool.name));

		// The gate: a verb row added later cannot land with no MCP tool and no decision. Without
		// it, "the tools are the method table" quietly becomes "the tools are whatever somebody
		// remembered to register".
		const unexposed = Object.keys(IPC_METHODS).filter((method) => !advertised.has(method));
		expect(unexposed.sort()).toEqual([...NOT_YET_EXPOSED].sort());
	});

	it('advertises nothing that is not a row of the table', async () => {
		const advertised = (await advertisedTools()).map((tool) => tool.name);

		// The other direction, which the first assertion cannot see: a tool this layer invented
		// would be a device operation living only in the MCP server (ai/RULES.md §1).
		expect(advertised.filter((name) => !Object.hasOwn(IPC_METHODS, name))).toEqual([]);
	});
});
