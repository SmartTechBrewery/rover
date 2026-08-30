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
 * **{@link runVerb} is generic in what the verb answers with**, because two of them now carry
 * a payload beyond `ActionResult` (`read_logs` and `record_video`, and `pull_file` after them).
 * Only the `ok` branch varies: the three refusal branches are untouched by that, which is the point rather than an
 * economy — a refusal is one vocabulary whatever was asked of the device.
 *
 * **A call that produced bytes has a second effect: the archive** (D23, `./archive.ts`).
 * Every `ok` answer goes past `ArtifactArchive.record` on its way out, which writes the
 * screenshot, the recording or the log read into the host's own durable tree. It is
 * **additive, never substitutive** — the bytes still travel to the client exactly as R24
 * settled, and no archive path is ever put on an answer — and it cannot fail the call:
 * `record` never throws, so a host that could not write still returns the verb's result. It
 * is wired here rather than in `src/verbs/` for `./frames.ts`'s reason: the verb layer sits
 * in every client's module graph, and host filesystem work under it would be host behaviour
 * inside a CLI (D19).
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

import { requireDeviceBackend } from '../backends/registry.js';
import type { Device } from '../core/device.js';
import type { LeaseId } from '../core/ids.js';
import type {
	AppVerbParams,
	DeviceInfoParams,
	EnvironmentVerbParams,
	IpcHandlers,
	LongPressParams,
	PressKeyParams,
	ReadLogsCallResult,
	ReadLogsParams,
	ReadScreenParams,
	RecordVideoCallResult,
	RecordVideoParams,
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
import { setAirplaneMode, setWifi } from '../verbs/environment.js';
import { toVerbFailure } from '../verbs/failure.js';
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
import { type RecordVideoVerbOptions, recordVideo } from '../verbs/record.js';
import { type WaitVerbOptions, waitFor, waitUntilGone } from '../verbs/wait-for.js';
import type { ArchivableResult, ArtifactArchive } from './archive.js';
import { extractFrames } from './frames.js';
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
	| 'record_video'
	| 'set_airplane_mode'
	| 'set_wifi'
>;

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
	archive: ArtifactArchive,
): VerbHandlers {
	/**
	 * The preamble every verb call shares: renew, register, re-verify, resolve the backend, run.
	 *
	 * `run` is handed a context and nothing else, which is the verb layer's contract — it
	 * never looks a device up and never learns that leases exist.
	 */
	function runVerb<Result extends ArchivableResult>(
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
			if ('refusal' in prepared) {
				return prepared.refusal;
			}
			const answered = await answer(prepared.context, run);
			if (answered.outcome === 'ok') {
				// The second effect of the call (D23) — awaited rather than fired and forgotten,
				// because the bytes are already in memory and bounded, the lease is still held, and
				// a write left running would race the restoration a `release_device` starts. It
				// cannot fail this: `record` never throws.
				await archive.record(lease, answered.result);
			}
			return answered;
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

		// The recording row — the second whose answer carries a payload of its own, and for the
		// same reason it goes through the same preamble: `runVerb` is generic in the
		// `ActionResult` subtype. The recording still rides on `ActionResult.artifact` the way
		// `screenshot`'s capture does, and what widened the `ok` branch is the frames beside it.
		// Its `requires: ['canRecordVideo']` is what makes a backend that cannot record say so
		// by name instead of answering with a null artifact that reads like a success (D11).
		record_video(params: RecordVideoParams): Promise<RecordVideoCallResult> {
			return runVerb(params.leaseId, (context) => recordVideo(context, recordOptions(params)));
		},

		// The two environment rows. Like the app rows they call the *verbs* rather than
		// `context.backend.setAirplaneMode` — which reads identically, would skip the spine, and
		// would also skip the `canControlNetwork` assertion the verbs carry, turning a device
		// that cannot do this into a `TypeError` instead of a named failure (D11). No options
		// helper: `enabled` is required, so there is no "omit rather than pass `undefined`" case.
		set_airplane_mode(params: EnvironmentVerbParams): Promise<VerbCallResult> {
			return runVerb(params.leaseId, (context) => setAirplaneMode(context, params.enabled));
		},

		set_wifi(params: EnvironmentVerbParams): Promise<VerbCallResult> {
			return runVerb(params.leaseId, (context) => setWifi(context, params.enabled));
		},
	};
}

/**
 * Run the verb, and turn what comes back into one of the answers that mean it ran — or into
 * the one refusal that can arrive after a verb has already started.
 */
async function answer<Result extends ArchivableResult>(
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

/**
 * The two recording knobs a call may carry — each omitted rather than passed as `undefined` for
 * the reason {@link waitOptions}, {@link gestureOptions} and {@link logOptions} omit theirs:
 * the verb's own default is what a caller who said nothing asked for, and the host must not be
 * the second place either number is decided — plus the one thing on a verb's options that is
 * not a caller's at all.
 */
function recordOptions(params: {
	readonly durationMs?: number;
	readonly framesPerSecond?: number;
}): RecordVideoVerbOptions {
	return {
		// The host half of the call, and the only verb option that is not a caller's number:
		// the verb layer names the shape and the daemon resolves the implementation, exactly as
		// it resolves the backend, because the implementation starts a process and nothing under
		// `src/verbs/` may (`./frames.ts`).
		extractFrames,
		...(params.durationMs === undefined ? {} : { durationMs: params.durationMs }),
		...(params.framesPerSecond === undefined ? {} : { framesPerSecond: params.framesPerSecond }),
	};
}

/** The error's own words: it already names the device and says what happened to it. */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
