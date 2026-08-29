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
import type { LeaseId } from '../core/ids.js';
import type {
	IpcHandlers,
	VerbCallResult,
	WaitForParams,
	WaitUntilGoneParams,
} from '../ipc/methods.js';
import type { VerbContext } from '../verbs/context.js';
import { toVerbFailure } from '../verbs/failure.js';
import type { ActionResult } from '../verbs/result.js';
import { type WaitVerbOptions, waitFor, waitUntilGone } from '../verbs/wait-for.js';
import type { DeviceInventory } from './inventory.js';
import { refusalReasonFor } from './lease-handlers.js';
import type { LeaseStore } from './leases.js';

export type VerbHandlers = Pick<IpcHandlers, 'wait_for' | 'wait_until_gone'>;

export function createVerbHandlers(inventory: DeviceInventory, leases: LeaseStore): VerbHandlers {
	/**
	 * The preamble every verb call shares: renew, re-verify, resolve the backend, run.
	 *
	 * `run` is handed a context and nothing else, which is the verb layer's contract — it
	 * never looks a device up and never learns that leases exist.
	 */
	async function runVerb(
		leaseId: LeaseId,
		run: (context: VerbContext) => Promise<ActionResult>,
	): Promise<VerbCallResult> {
		// First, and before any await: this is the renewal (D8).
		const lease = leases.use(leaseId);
		if (!lease) {
			return {
				outcome: 'refused',
				reason: 'no-lease',
				message:
					'That lease id is not live on this host — it was never granted, it was already ' +
					'released, or it expired. Acquire the device again to get a new one.',
			};
		}

		let device: Awaited<ReturnType<DeviceInventory['verifyForGrant']>>;
		try {
			device = await inventory.verifyForGrant(lease.serial);
		} catch (error) {
			const reason = refusalReasonFor(error);
			if (!reason) {
				throw error;
			}
			return { outcome: 'refused', reason, message: messageOf(error) };
		}

		if (device.state !== 'ready') {
			return {
				outcome: 'refused',
				reason: 'not-ready',
				message:
					`Device '${device.serial}' is attached to this host but its state is ` +
					`'${device.state}', so no verb could run on it`,
			};
		}

		// Throws for an unregistered platform, and rightly: the device came out of this host's
		// own enumeration, so a miss is the barrel missing an import line rather than anything
		// the caller did (`src/backends/registry.ts`). That is a host failure and travels as one.
		const { manifest, backend } = requireDeviceBackend(device.platform);
		const context: VerbContext = { serial: device.serial, backend, manifest };

		try {
			return { outcome: 'ok', result: await run(context) };
		} catch (error) {
			const failure = toVerbFailure(error);
			if (!failure) {
				// Not something a verb answers with. It is the host breaking, and dressing it up as
				// an answer about the device would send the agent looking in the wrong place.
				throw error;
			}
			return { outcome: 'failed', failure };
		}
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
	};
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

/** The error's own words: it already names the device and says what happened to it. */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
