/**
 * The sixteen verb tools — every `IPC_METHODS` verb row whose answer is plain data.
 *
 * **The schemas from `src/ipc/methods.ts` *are* the tool declarations**, exactly as
 * `./devices.ts` says for the four device rows (ai/CODING_STANDARDS.md, boundary #1): each
 * `inputSchema` is the `*ParamsSchema` the host parses the request with, taken off the
 * `IPC_METHODS` table by name rather than restated, so there is no second copy to drift and no
 * row can declare a shape the host would refuse. Three of these tools share one params schema
 * and two share another, because the underlying calls are identical — a near-copy per row is a
 * copy that drifts.
 *
 * **The names are the `IPC_METHODS` keys**, with no platform suffix anywhere (D10): `tap`, not
 * `tap_android`. `tests/unit/mcp/verb-declarations.test.ts` holds both halves of that, and its
 * completeness gate is what stops a verb row landing later with no tool and no deliberate
 * entry saying why.
 *
 * **Zero verb logic.** Every handler is one {@link callHost} and one shared answer mapping
 * (`../_shared/verb-answer.ts`). Nothing here resolves a target, applies a default the host
 * does not already own, or branches on what a verb means — the host decided all of it and said
 * so in words that name the device (D16). That is why this is a table rather than sixteen
 * hand-written blocks: the only thing that differs between rows is what the tool *says about
 * itself*, and a verb that later needs something of its own gets a field on its row.
 *
 * **A missing capability is a loud, agent-readable error** (D11). `read_screen` on a backend
 * that does not declare `canReadScreen`, and the two environment rows on one without
 * `canControlNetwork`, come back as a `missing-capability` failure carrying the capability, the
 * serial, the platform and the backend's label. The descriptions below say so, because an agent
 * that reads "requires `canReadScreen`" before it calls can check the capability list
 * `acquire_device` handed it instead of discovering the asymmetry through a failure.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HostName } from '../../daemon/host.js';
import { DEFAULT_REQUEST_TIMEOUT_MS, type IpcRequestOptions } from '../../ipc/client.js';
import {
	IPC_METHODS,
	type IpcMethodName,
	type IpcParams,
	type IpcResult,
	type VerbCallResultOf,
} from '../../ipc/methods.js';
import {
	LONG_PRESS_DURATION_MS,
	SCROLL_DURATION_MS,
	SWIPE_DURATION_MS,
} from '../../verbs/input.js';
import type { ActionResult } from '../../verbs/result.js';
import { DEFAULT_WAIT_TIMEOUT_MS } from '../../verbs/wait-for.js';
import { guarded } from '../_shared/answer.js';
import { callHost } from '../_shared/call.js';
import { verbToolResult } from '../_shared/verb-answer.js';

/**
 * Which `IPC_METHODS` rows are verb rows — **derived from what they answer with**, not listed.
 *
 * A verb row is exactly a row whose result is one of `verbCallResultOf`'s three branches, and
 * asking the table that is what keeps the set from becoming a second list to maintain: a lease
 * row cannot end up in the table below, and a verb row added later needs nothing changed here.
 */
type VerbMethodName = {
	[Method in IpcMethodName]: IpcResult<Method> extends VerbCallResultOf<ActionResult>
		? Method
		: never;
}[IpcMethodName];

/**
 * One row of the table: which verb this tool is, how it introduces itself, and — for the few
 * calls that can outlast the client's own deadline — how long to wait.
 *
 * A mapped type distributed over the method names, so every row is checked against **its own**
 * params: `requestTimeoutMs` on the `tap` row would be handed a `TapParams` and find no knob to
 * read, which makes a row naming a field the wrong verb owns a compile error where the table is
 * written rather than a timeout silently derived from `undefined` at runtime.
 */
type VerbToolRow<Method extends VerbMethodName = VerbMethodName> = {
	[Row in Method]: {
		readonly method: Row;
		readonly title: string;
		readonly description: string;
		/**
		 * How long this client waits for the answer, from the call's own knob. Absent for a row
		 * that cannot outrun {@link DEFAULT_REQUEST_TIMEOUT_MS} — see {@link requestOptionsFor}.
		 */
		readonly requestTimeoutMs?: (params: IpcParams<Row>) => number;
	};
}[Method];

/**
 * The budget a call that spends time on the device gets: the time it was asked to spend, plus
 * the budget every other call gets for the round trip.
 *
 * `rover record`'s pattern exactly (`src/cli/commands/record.ts`, `requestTimeoutFor`), and for
 * its reason: `MAX_VERB_TIMEOUT_MS` is five minutes while a request defaults to thirty seconds,
 * so a wait or a gesture a caller asked to be long can reach the client's own deadline first —
 * and be reported as a hang, with no answer and no name, while the host was still working and
 * about to say exactly what happened.
 *
 * `verbDefaultMs` stands in for a knob the caller did not send and is **imported** from the
 * module that owns it rather than restated. It sizes this timeout and is never put on the
 * request: a second default on the wire is a second number free to disagree with the verb's
 * own, which is exactly what those params schemas leave the field optional to prevent.
 */
function waitedOut(askedMs: number | undefined, verbDefaultMs: number): number {
	return (askedMs ?? verbDefaultMs) + DEFAULT_REQUEST_TIMEOUT_MS;
}

/**
 * The table. One row per verb, in `IPC_METHODS` order.
 *
 * The descriptions are the tools' whole documentation, so each says what the verb does, what it
 * addresses, which capability it needs and what a caller most often gets wrong — the same facts
 * `PROJECT.md` §4 records for a human reader, in the place an agent will actually read them.
 */
const VERB_TOOLS: readonly VerbToolRow[] = [
	{
		method: 'wait_for',
		title: 'Wait for something on screen',
		description:
			'Wait until a target is on the screen and can be acted on, then answer with the state. ' +
			'This is what replaces sleeping, which is the single largest source of a false green: it ' +
			'polls a screen read taken inside the call until the target resolves or `timeoutMs` runs ' +
			'out. Omit `timeoutMs` and the host applies the verb’s own default. A wait that runs out ' +
			'is a `wait-timeout` failure naming what it waited for and what was on the screen ' +
			'instead, not a hang. Requires `canReadScreen`.',
		requestTimeoutMs: (params) => waitedOut(params.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS),
	},
	{
		method: 'wait_until_gone',
		title: 'Wait for something to go away',
		description:
			'Wait until nothing on the screen matches the target any more — a spinner, a toast, a ' +
			'dialog — then answer with the state. Gone means absent from a read taken **now**, never ' +
			'absent from a read you already had. A text target takes no `index` here, deliberately: ' +
			'picking one of several matches is not something an absence can be asked about. Requires ' +
			'`canReadScreen`.',
		requestTimeoutMs: (params) => waitedOut(params.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS),
	},
	{
		method: 'tap',
		title: 'Tap a target',
		description:
			'Tap one target: by visible text, by the element id `read_screen` reported, or at a ' +
			'coordinate as the documented fallback. The point is resolved from a screen read taken ' +
			'**inside this call** — never pass a coordinate worked out on an earlier turn — and the ' +
			'answer says which of the two it was, plus the state after the tap. A target nothing ' +
			'matches is a `target-not-found` failure describing what was on the screen; two matches ' +
			'are `ambiguous-target` carrying the candidates, and `index` on a text target is how you ' +
			'choose between them.',
	},
	{
		method: 'long_press',
		title: 'Press and hold a target',
		description:
			'Press and hold one target — the same three ways of addressing one that `tap` takes. ' +
			'`durationMs` is how long the **device** holds; omit it for the verb’s own default. Raise ' +
			'it on a device configured with a slower long-press threshold: too short a hold is an ' +
			'ordinary tap with a successful-looking result behind it.',
		requestTimeoutMs: (params) => waitedOut(params.durationMs, LONG_PRESS_DURATION_MS),
	},
	{
		method: 'swipe',
		title: 'Swipe between two targets',
		description:
			'Drag from one target to another — two of them, because a drag has two ends, each by ' +
			'text, element id or coordinate. `durationMs` is how long the device takes over it, and ' +
			'zero is a flick; omit it for the verb’s own default. `from` is the target the answer ' +
			'reports.',
		requestTimeoutMs: (params) => waitedOut(params.durationMs, SWIPE_DURATION_MS),
	},
	{
		method: 'scroll',
		title: 'Scroll a list or a pane',
		description:
			'Scroll the screen or one scrollable region. **`direction` is where the content goes, ' +
			'not where the finger goes**: `down` reveals what is further down the list, the sense a ' +
			'scrollbar and a wheel already have. `target` names the region to scroll within and is ' +
			'omitted for the screen as a whole. `durationMs` defaults slower than a flick on ' +
			'purpose, so the state the answer reports is a screen that has stopped moving.',
		requestTimeoutMs: (params) => waitedOut(params.durationMs, SCROLL_DURATION_MS),
	},
	{
		method: 'type_text',
		title: 'Type text',
		description:
			'Type text into whatever currently holds focus. **It addresses no element, so tap the ' +
			'field first.** The device shell’s quoting is hidden — a space, an apostrophe and a ' +
			'metacharacter all arrive verbatim — and text the device cannot type at all comes back ' +
			'as an `unsupported-text` failure naming the offending characters as escapes, never as a ' +
			'silent drop. Leading and trailing spaces are content and are kept.',
	},
	{
		method: 'press_key',
		title: 'Press a device key',
		description:
			'Press one hardware or system key: `back`, `home`, `recents` or `wake`. Addresses ' +
			'nothing on the screen, so it needs no screen read to aim and works on a device that ' +
			'cannot read its screen at all.',
	},
	{
		method: 'read_screen',
		title: 'Read the screen',
		description:
			'Read what is on the screen: the texts, the element rectangles and the element ids the ' +
			'target-taking verbs address. It survives an application that blocks screen capture, ' +
			'which is why it is the read to reach for when a capture comes back blank. **Requires ' +
			'`canReadScreen`** — a device whose backend does not declare it answers with a ' +
			'`missing-capability` failure naming the capability and the device, never with an empty ' +
			'screen.',
	},
	{
		method: 'device_info',
		title: 'Describe the device',
		description:
			'What the leased device is: screen size in pixels, density, the computed width and ' +
			'height in dp, model and OS version. Needs no capability and addresses nothing on the ' +
			'screen — it asks on its own for the device half that every other answer already ' +
			'carries.',
	},
	{
		method: 'launch_app',
		title: 'Launch an application',
		description:
			'Start an application on the leased device by its package id (reverse-DNS, checked at ' +
			'the boundary). Addresses a package rather than anything on the screen, so it resolves ' +
			'no target and needs no capability. The state after the action is what says whether the ' +
			'application actually came up.',
	},
	{
		method: 'stop_app',
		title: 'Stop an application',
		description:
			'Force-stop an application by its package id. It cannot tell an application it stopped ' +
			'from a package that was never installed — the state after the action is what answers ' +
			'that. Addresses a package, so it resolves no target and needs no capability.',
	},
	{
		method: 'clear_app_data',
		title: 'Clear an application’s data',
		description:
			'Clear an application’s data and cache by its package id, putting it back to a ' +
			'first-run state. Addresses a package, so it resolves no target and needs no capability.',
	},
	{
		method: 'read_logs',
		title: 'Read the device log',
		description:
			'Read the most recent device log entries, including the buffer the platform records ' +
			'crashes in — the failure a screenshot will not show. A bounded read: `maxEntries` caps ' +
			'it and is omitted for the host’s own default, and `logs.truncated` is what tells a read ' +
			'that was cut short from a genuinely quiet device. There is deliberately no following ' +
			'and no filter — a tail that stays open is a wait with no condition.',
	},
	{
		method: 'set_airplane_mode',
		title: 'Set airplane mode',
		description:
			'Turn airplane mode on or off on the leased device. `enabled` is required: an omitted ' +
			'toggle would leave the verb inventing a default nobody asked for. **Requires ' +
			'`canControlNetwork`** — a backend that does not declare it answers with a ' +
			'`missing-capability` failure naming the capability and the device, never with a toggle ' +
			'that quietly did nothing. The host puts this back when the lease ends, so there is ' +
			'nothing to undo by hand.',
	},
	{
		method: 'set_wifi',
		title: 'Set wifi',
		description:
			'Turn wifi on or off on the leased device. `enabled` is required, for the reason ' +
			'`set_airplane_mode` gives. **Requires `canControlNetwork`** — a backend that does not ' +
			'declare it answers with a `missing-capability` failure naming the capability and the ' +
			'device, never with a toggle that quietly did nothing. The host puts this back when the ' +
			'lease ends. Note that airplane mode moves wifi underneath it, which is why the host ' +
			'restores both explicitly and in order.',
	},
];

/**
 * How long this client waits for `row`'s answer, or `undefined` to leave
 * {@link DEFAULT_REQUEST_TIMEOUT_MS} in place.
 */
function requestOptionsFor(row: VerbToolRow, params: never): IpcRequestOptions | undefined {
	const timeoutMs = row.requestTimeoutMs?.(params);
	return timeoutMs === undefined ? undefined : { timeoutMs };
}

/** One row, registered: the params schema as the declaration, one call, one answer. */
function registerVerbTool(server: McpServer, host: HostName, row: VerbToolRow): void {
	const { method, title, description } = row;
	server.registerTool(
		method,
		{ title, description, inputSchema: IPC_METHODS[method].params },
		async (received: unknown) => {
			// The one cast this table costs, and the only one in it. Each row's `method` and its
			// `requestTimeoutMs` are checked against each other where the table is written;
			// iterating over the whole table erases that pairing again, because a union of sixteen
			// signatures asks for one argument satisfying all sixteen at once. What arrives here has
			// already been parsed against *this* row's own schema by the SDK — that is what handing
			// it the `IPC_METHODS` params schema buys — and nothing below reads a field of it, so
			// the cast reaches one call and no answer depends on it.
			const params = received as never;
			return guarded(method, async () =>
				verbToolResult(await callHost(host, method, params, requestOptionsFor(row, params))),
			);
		},
	);
}

export function registerVerbTools(server: McpServer, host: HostName): void {
	for (const row of VERB_TOOLS) {
		registerVerbTool(server, host, row);
	}
}
