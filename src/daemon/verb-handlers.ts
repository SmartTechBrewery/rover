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
	IpcHandlers,
	LongPressParams,
	PressKeyParams,
	ScrollParams,
	SwipeParams,
	TapParams,
	TypeTextParams,
	VerbCallResult,
	WaitForParams,
	WaitUntilGoneParams,
} from '../ipc/methods.js';
import type { VerbContext } from '../verbs/context.js';
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
>;

/**
 * What the preamble reached: a verb that can run, or the answer the call already has.
 *
 * Two shapes rather than a nullable context, so a refusal cannot be mistaken for "nothing
 * went wrong" by whoever reads it next.
 */
type Prepared = { readonly context: VerbContext } | { readonly refusal: VerbCallResult };

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
	function runVerb(
		leaseId: LeaseId,
		run: (context: VerbContext) => Promise<ActionResult>,
	): Promise<VerbCallResult> {
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
		return traffic.run(lease, async (call) => {
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
	};
}

/**
 * Run the verb, and turn what comes back into one of the answers that mean it ran — or into
 * the one refusal that can arrive after a verb has already started.
 */
async function answer(
	context: VerbContext,
	run: (context: VerbContext) => Promise<ActionResult>,
): Promise<VerbCallResult> {
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

/** The error's own words: it already names the device and says what happened to it. */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
