/**
 * The verb handlers — where a verb call becomes a verb running against this host's own
 * device (D19, R21).
 *
 * This is the module the whole row exists to establish. Everything before a verb can run —
 * resolving the lease, renewing it, re-verifying the device, building the
 * {@link VerbContext} — is one shared preamble, so each further verb family is one
 * `IPC_METHODS` row and three lines here rather than a sixth copy of it.
 *
 * **`leases.use()` is called first, exactly once, and before any await.** That call *is* the
 * renewal (D8, PROJECT.md §2: every call pushes the lease expiry out). Renewing on arrival
 * rather than on completion is deliberate: a renewal after the fact would leave a long
 * verb's own lease expirable while it runs, and an expiry mid-verb fires restoration on a
 * device the verb is actively driving.
 *
 * **The device is re-verified, never read from the snapshot.** `verifyForGrant` is one
 * describe call per verb, next to nothing beside the several device round trips a verb makes
 * anyway, and it is the only thing that separates "the device is gone" from a stale cache
 * entry (D6). Resolving the platform out of `inventory.snapshot()` instead would answer from
 * a cache that module's own header calls never authoritative, and a device that vanished
 * would surface as a backend exception — an `internal_error`, i.e. "the host broke", for
 * something that is an ordinary answer with a name.
 *
 * **A verb never outlives the lease that authorised it.** Renewal on arrival keeps a lease
 * from expiring *because* a verb is slow; it does nothing about a lease that ends for its
 * own reasons — a `release_device` on the same connection, which the server dispatches
 * without waiting for the verb to finish. So the whole call runs registered with
 * `./verb-traffic.ts`, which revokes the backend the moment the lease ends: the next device
 * call throws {@link LeaseEndedError}, this answers `refused` / `no-lease`, and the
 * restoration that lease started waits for the call to unwind before touching the device.
 * Every further verb family inherits that by being run through {@link runVerb} — there is
 * nothing here for a verb author to remember, which is the point.
 *
 * **{@link runVerb} is generic in what the verb answers with**, because one of them carries a
 * payload beyond `ActionResult` (`read_logs`). Only the `ok` branch varies: the three refusal
 * branches are untouched by that, which is the point rather than an economy — a refusal is
 * one vocabulary whatever was asked of the device.
 *
 * **This is also where a caller's bytes become a file, and stop being one again.** Two rows
 * carry a payload *in* — `install_app` and `push_file` — and the backend methods behind them
 * take a path, because a path is how one host-side layer hands a file to another and the
 * daemon is on the host. Turning the payload into that file belongs here rather than in the
 * verb: the verb layer touches no filesystem, and D19 is about a path *crossing the machine
 * boundary*, which none does. {@link withPayloadOnDisk} writes it, hands the path down and
 * removes the directory in a `finally` — on the failure path too, since a transfer that threw
 * is exactly the one that would otherwise leave a caller's file on hardware lent out next to
 * somebody else.
 *
 * **None of `./lease-handlers.ts`'s await-ordering constraint applies here**, and that is
 * worth saying so nobody copies a rule that does not hold: nothing in this file takes
 * anything exclusive. The lease is already held, and holding it is what makes this call
 * legitimate.
 *
 * **A refusal and a failure are both data.** A lease that is not live, a device that went
 * away and a verb that timed out are all answers an agent acts on. Only a genuine host
 * failure throws out of here, and it becomes `internal_error` — which keeps that code
 * meaning what it says.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireDeviceBackend } from '../backends/registry.js';
import type { Device } from '../core/device.js';
import type { LeaseId } from '../core/ids.js';
import type {
	AppVerbParams,
	DeviceInfoParams,
	InstallAppParams,
	IpcHandlers,
	LongPressParams,
	PressKeyParams,
	PullFileParams,
	PushFileParams,
	ReadLogsCallResult,
	ReadLogsParams,
	ReadScreenParams,
	ScreenshotParams,
	ScrollParams,
	SwipeParams,
	TapParams,
	TypeTextParams,
	VerbCallRefusal,
	VerbCallResult,
	VerbCallResultOf,
	WaitForParams,
	WaitUntilGoneParams,
} from '../ipc/methods.js';
import { clearAppData, launchApp, stopApp } from '../verbs/app.js';
import type { VerbContext } from '../verbs/context.js';
import { toVerbFailure } from '../verbs/failure.js';
import { installApp, pullFile, pushFile } from '../verbs/files.js';
import {
	type GestureOptions,
	longPress,
	pressKey,
	type ScrollOptions,
	scroll,
	swipe,
	tap,
	typeText,
} from '../verbs/input.js';
import { type ReadLogsVerbOptions, readLogs } from '../verbs/logs.js';
import { deviceInfo, readScreen, screenshot } from '../verbs/read.js';
import type { ActionResult } from '../verbs/result.js';
import { type WaitVerbOptions, waitFor, waitUntilGone } from '../verbs/wait-for.js';
import type { DeviceInventory } from './inventory.js';
import { refusalReasonFor } from './lease-handlers.js';
import type { Lease, LeaseStore } from './leases.js';
import { LeaseEndedError, type VerbCall, type VerbTraffic } from './verb-traffic.js';

export type VerbHandlers = Pick<
	IpcHandlers,
	| 'wait_for'
	| 'wait_until_gone'
	| 'tap'
	| 'long_press'
	| 'swipe'
	| 'scroll'
	| 'type_text'
	| 'press_key'
	| 'read_screen'
	| 'device_info'
	| 'screenshot'
	| 'launch_app'
	| 'stop_app'
	| 'clear_app_data'
	| 'read_logs'
	| 'install_app'
	| 'push_file'
	| 'pull_file'
>;

/**
 * What a decoded payload is called inside its own directory.
 *
 * Deliberately says nothing about what the file is. A name carrying a package format would
 * be one platform's vocabulary in shared code (ai/RULES.md §2). A backend that needs a
 * particular name gives it one inside its own folder, where naming a format is what that
 * folder is for.
 */
const PAYLOAD_FILE_NAME = 'payload';

/** So a directory that somehow outlives its `finally` is attributable to this daemon. */
const PAYLOAD_PREFIX = 'rover-transfer-';

/**
 * Turn a caller's base64 payload into a file on this host, run `use` against its path, and
 * remove the directory however that ends.
 *
 * A directory rather than a bare file, so the removal is one call that cannot leave a
 * sibling behind, and `force` so a cleanup after a failure cannot itself throw and replace
 * the real error with its own.
 *
 * The payload is already bounded by `MAX_TRANSFER_BYTES` at the boundary
 * (`src/ipc/verb-methods.ts`), which is what keeps this from being an allocation a peer
 * chose: by the time anything is written, the call has been parsed and refused if it was too
 * big.
 */
async function withPayloadOnDisk<Result>(
	base64: string,
	use: (hostPath: string) => Promise<Result>,
): Promise<Result> {
	const directory = await mkdtemp(join(tmpdir(), PAYLOAD_PREFIX));
	try {
		const hostPath = join(directory, PAYLOAD_FILE_NAME);
		await writeFile(hostPath, Buffer.from(base64, 'base64'));
		return await use(hostPath);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

/**
 * What the preamble reached: a verb that can run, or the answer the call already has.
 *
 * Two shapes rather than a nullable context, so a refusal cannot be mistaken for "nothing
 * went wrong" by whoever reads it next.
 */
type Prepared = { readonly context: VerbContext } | { readonly refusal: VerbCallRefusal };

export function createVerbHandlers(
	inventory: DeviceInventory,
	leases: LeaseStore,
	traffic: VerbTraffic,
): VerbHandlers {
	/**
	 * The preamble every verb call shares: renew, register, re-verify, resolve the backend, run.
	 *
	 * `run` is handed a context and nothing else, which is the verb layer's contract — it
	 * never looks a device up and never learns that leases exist.
	 */
	function runVerb<Result extends ActionResult>(
		leaseId: LeaseId,
		run: (context: VerbContext) => Promise<Result>,
	): Promise<VerbCallResultOf<Result>> {
		// First, and before any await: this is the renewal (D8).
		const lease = leases.use(leaseId);
		if (!lease) {
			return Promise.resolve({
				outcome: 'refused',
				reason: 'no-lease',
				message:
					'That lease id is not live on this host — it was never granted, it was already ' +
					'released, or it expired. Acquire the device again to get a new one.',
			});
		}

		// Registered before the re-verification, because that is an await like any other: a call
		// registered after it would leave a window in which the lease ends, finds nothing to
		// revoke, and the verb starts driving a device the host has already handed on.
		return traffic.run<VerbCallResultOf<Result>>(lease, async (call) => {
			const prepared = await prepare(lease, call);
			return 'refusal' in prepared ? prepared.refusal : answer(prepared.context, run);
		});
	}

	/**
	 * Everything between a live lease and a running verb: the device as it is *now* (D6), the
	 * backend that owns it, and the guard that ties the two to this call.
	 */
	async function prepare(lease: Lease, call: VerbCall): Promise<Prepared> {
		let device: Device;
		try {
			device = await inventory.verifyForGrant(lease.serial);
		} catch (error) {
			const reason = refusalReasonFor(error);
			if (!reason) {
				throw error;
			}
			return { refusal: { outcome: 'refused', reason, message: messageOf(error) } };
		}

		if (device.state !== 'ready') {
			return {
				refusal: {
					outcome: 'refused',
					reason: 'not-ready',
					message:
						`Device '${device.serial}' is attached to this host but its state is ` +
						`'${device.state}', so no verb could run on it`,
				},
			};
		}

		// Throws for an unregistered platform, and rightly: the device came out of this host's
		// own enumeration, so a miss is the barrel missing an import line rather than anything
		// the caller did (`src/backends/registry.ts`). That is a host failure and travels as one.
		const { manifest, backend } = requireDeviceBackend(device.platform);
		// The one place the guard is applied. The verb receives a backend like any other, and it
		// stops being able to reach the device the moment this lease ends.
		return { context: { serial: device.serial, backend: call.guard(backend), manifest } };
	}

	return {
		wait_for(params: WaitForParams): Promise<VerbCallResult> {
			return runVerb(params.leaseId, (context) =>
				waitFor(context, params.target, waitOptions(params)),
			);
		},

		wait_until_gone(params: WaitUntilGoneParams): Promise<VerbCallResult> {
			return runVerb(params.leaseId, (context) =>
				waitUntilGone(context, params.target, waitOptions(params)),
			);
		},

		tap(params: TapParams): Promise<VerbCallResult> {
			return runVerb(params.leaseId, (context) => tap(context, params.target));
		},

		long_press(params: LongPressParams): Promise<VerbCallResult> {
			return runVerb(params.leaseId, (context) =>
				longPress(context, params.target, gestureOptions(params)),
			);
		},

		swipe(params: SwipeParams): Promise<VerbCallResult> {
			return runVerb(params.leaseId, (context) =>
				swipe(context, params.from, params.to, gestureOptions(params)),
			);
		},

		scroll(params: ScrollParams): Promise<VerbCallResult> {
			return runVerb(params.leaseId, (context) =>
				scroll(context, params.direction, {
					...gestureOptions(params),
					...(params.target === undefined ? {} : { target: params.target }),
				} satisfies ScrollOptions),
			);
		},

		// The caller's string, handed on untouched. Nothing between the wire and the backend
		// inspects or rewrites it, which is what makes `type_text` mean what it says.
		type_text(params: TypeTextParams): Promise<VerbCallResult> {
			return runVerb(params.leaseId, (context) => typeText(context, params.text));
		},

		press_key(params: PressKeyParams): Promise<VerbCallResult> {
			return runVerb(params.leaseId, (context) => pressKey(context, params.key));
		},

		// The three read rows. All take the lease id and nothing else — `screenshot` no more
		// than the other two, because a destination path is the client's own business and
		// never the host's (D19). `read_screen`'s `requires: ['canReadScreen']` is what makes
		// a backend that cannot read one say so by name instead of answering with an empty
		// screen (D11).
		read_screen(params: ReadScreenParams): Promise<VerbCallResult> {
			return runVerb(params.leaseId, (context) => readScreen(context));
		},

		device_info(params: DeviceInfoParams): Promise<VerbCallResult> {
			return runVerb(params.leaseId, (context) => deviceInfo(context));
		},

		screenshot(params: ScreenshotParams): Promise<VerbCallResult> {
			return runVerb(params.leaseId, (context) => screenshot(context));
		},

		// The three app rows. They call the *verb* of that name and never `context.backend.*`,
		// which reads identically and would skip the spine — no after-state, no device in the
		// answer. The whole family is three lines each because the preamble above is shared.
		launch_app(params: AppVerbParams): Promise<VerbCallResult> {
			return runVerb(params.leaseId, (context) => launchApp(context, params.appId));
		},

		stop_app(params: AppVerbParams): Promise<VerbCallResult> {
			return runVerb(params.leaseId, (context) => stopApp(context, params.appId));
		},

		clear_app_data(params: AppVerbParams): Promise<VerbCallResult> {
			return runVerb(params.leaseId, (context) => clearAppData(context, params.appId));
		},

		// The one row whose answer carries a payload of its own, and it goes through exactly the
		// same preamble as the rest — `runVerb` is generic in the `ActionResult` subtype the verb
		// returns, so what it answers when no verb ran is word for word a gesture's.
		read_logs(params: ReadLogsParams): Promise<ReadLogsCallResult> {
			return runVerb(params.leaseId, (context) => readLogs(context, logOptions(params)));
		},

		// The three transfer rows. Two of them decode first and the decoding is **inside**
		// `runVerb`'s callback rather than before it, so a call on a lease this host does not
		// know is refused without a file ever being written — the refusal costs nothing, which
		// is the same reason `screenshot` encodes inside its action rather than around it.
		install_app(params: InstallAppParams): Promise<VerbCallResult> {
			return runVerb(params.leaseId, (context) =>
				withPayloadOnDisk(params.packageBase64, (hostPath) => installApp(context, hostPath)),
			);
		},

		push_file(params: PushFileParams): Promise<VerbCallResult> {
			return runVerb(params.leaseId, (context) =>
				withPayloadOnDisk(params.contentBase64, (hostPath) =>
					pushFile(context, hostPath, params.devicePath),
				),
			);
		},

		// The one direction with nothing to write here: the bytes come off the device and go
		// back on `ActionResult.artifact`, so this row carries no host path at either end.
		pull_file(params: PullFileParams): Promise<VerbCallResult> {
			return runVerb(params.leaseId, (context) => pullFile(context, params.devicePath));
		},
	};
}

/**
 * Run the verb, and turn what comes back into one of the answers that mean it ran — or into
 * the one refusal that can arrive after a verb has already started.
 */
async function answer<Result extends ActionResult>(
	context: VerbContext,
	run: (context: VerbContext) => Promise<Result>,
): Promise<VerbCallResultOf<Result>> {
	try {
		return { outcome: 'ok', result: await run(context) };
	} catch (error) {
		if (error instanceof LeaseEndedError) {
			// The verb was running and the device stopped being this call's to drive part-way
			// through (`./verb-traffic.ts`). No verb result exists, so this is the same `no-lease`
			// refusal an unknown id gets — with a message that says which of the two happened.
			return {
				outcome: 'refused',
				reason: 'no-lease',
				message: `${error.message}. Acquire the device again to get a new one.`,
			};
		}
		const failure = toVerbFailure(error);
		if (!failure) {
			// Not something a verb answers with. It is the host breaking, and dressing it up as an
			// answer about the device would send the agent looking in the wrong place.
			throw error;
		}
		return { outcome: 'failed', failure };
	}
}

/**
 * The two wait knobs a call may carry, and only those.
 *
 * Each key is omitted rather than passed as `undefined`, so the verb's own defaults apply
 * to a caller that said nothing. `WaitVerbOptions`' other two fields are test seams that
 * never come off the wire, and this is where that stays true even if the params schema were
 * ever loosened.
 */
function waitOptions(params: {
	readonly timeoutMs?: number;
	readonly pollIntervalMs?: number;
}): WaitVerbOptions {
	return {
		...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
		...(params.pollIntervalMs === undefined ? {} : { pollIntervalMs: params.pollIntervalMs }),
	};
}

/**
 * The one gesture knob a call may carry, omitted rather than passed as `undefined` for the
 * same reason {@link waitOptions} omits its two: the verb's own default is what a caller who
 * said nothing asked for, and `{ durationMs: undefined }` would read as a caller who did say
 * something.
 */
function gestureOptions(params: { readonly durationMs?: number }): GestureOptions {
	return params.durationMs === undefined ? {} : { durationMs: params.durationMs };
}

/**
 * The one log knob a call may carry, omitted rather than passed as `undefined` for the
 * reason {@link waitOptions} and {@link gestureOptions} omit theirs: the verb's own default
 * is what a caller who said nothing asked for, and the host must not be the second place
 * that number is decided.
 */
function logOptions(params: { readonly maxEntries?: number }): ReadLogsVerbOptions {
	return params.maxEntries === undefined ? {} : { maxEntries: params.maxEntries };
}

/** The error's own words: it already names the device and says what happened to it. */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
