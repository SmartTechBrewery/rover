/**
 * The `acquire_device` and `release_device` handlers — the lease store's only surface.
 *
 * **The order of the work in {@link createLeaseHandlers} is the exclusivity guarantee**, and
 * it is the thing to preserve when editing this file. `LeaseStore.acquire` is synchronous, so
 * two concurrent grants for one device cannot interleave *inside* it; what would let four
 * callers through instead is an `await` placed between the moment a handler decides the
 * device is free and the moment it takes it. So every awaited step happens first — the
 * re-verification, and nothing else — and everything from there to the insert is straight-line
 * synchronous code.
 *
 * A second ordering rule holds for the same reason in reverse: **nothing that can throw may
 * run after a successful acquire.** A throw becomes `internal_error`, the caller never learns
 * the lease id, and the device is wedged for the full TTL with nobody able to release it. The
 * capability lookup is resolved before the insert on purpose.
 *
 * **A refusal is data.** `verifyForGrant` throws for the two cases it exists to detect — the
 * device vanished (D6), the device belongs to another host (D18) — and both are caught here
 * and turned into an answer. An agent told `internal_error` learns nothing it can act on; an
 * agent told `not-attached` stops asking.
 */

import { requireDeviceBackend } from '../backends/registry.js';
import type { Device } from '../core/device.js';
import { DeviceVanishedError, ForeignDeviceError } from '../core/errors.js';
import type {
	AcquireDeviceParams,
	AcquireDeviceResult,
	AcquireRefusalReason,
	IpcHandlers,
	LeaseHolder,
	ReleaseDeviceParams,
	ReleaseDeviceResult,
} from '../ipc/methods.js';
import type { DeviceInventory } from './inventory.js';
import type { Lease, LeaseStore } from './leases.js';

export type LeaseHandlers = Pick<IpcHandlers, 'acquire_device' | 'release_device'>;

export function createLeaseHandlers(inventory: DeviceInventory, leases: LeaseStore): LeaseHandlers {
	/** The public view of a holder — {@link LeaseHolder} carries no lease id, deliberately. */
	const holderOf = (lease: Lease): LeaseHolder => ({
		serial: lease.serial,
		owner: lease.owner,
		project: lease.project,
		testName: lease.testName,
		expiresInMs: leases.remainingMs(lease),
	});

	return {
		async acquire_device(params: AcquireDeviceParams): Promise<AcquireDeviceResult> {
			// The one await, and it is first. The inventory is a cache and the platform is the
			// truth, so the grant re-verifies rather than reading what was last seen (D6).
			let device: Device;
			try {
				device = await inventory.verifyForGrant(params.serial);
			} catch (error) {
				const reason = refusalReasonFor(error);
				if (!reason) {
					throw error;
				}
				return { outcome: 'refused', reason, message: messageOf(error), heldBy: null };
			}

			if (device.state !== 'ready') {
				// Enumerated, attached, and no verb could run on it. Granting here would hand back
				// a handle that looks like a success and fails at the first call — the
				// plausible-looking answer ai/RULES.md §2 forbids.
				return {
					outcome: 'refused',
					reason: 'not-ready',
					message:
						`Device '${device.serial}' is attached to this host but its state is ` +
						`'${device.state}', so no verb could run on it`,
					heldBy: null,
				};
			}

			// Resolved before the acquire, never after: this throws for an unregistered platform,
			// and a throw past the insert would wedge the device for the whole TTL.
			const { manifest } = requireDeviceBackend(device.platform);

			// Nothing between here and the return may await.
			const outcome = leases.acquire({
				serial: device.serial,
				owner: params.owner,
				project: params.project,
				// `undefined` does not survive JSON, so an omitted name is stored and reported as
				// `null` rather than as an absent key a client would have to special-case.
				testName: params.testName ?? null,
			});

			if (!outcome.granted) {
				return {
					outcome: 'refused',
					reason: 'held',
					message:
						`Device '${device.serial}' is held by '${outcome.heldBy.owner}' for another ` +
						`${leases.remainingMs(outcome.heldBy)}ms`,
					heldBy: holderOf(outcome.heldBy),
				};
			}

			return {
				outcome: 'granted',
				lease: {
					leaseId: outcome.lease.id,
					serial: outcome.lease.serial,
					owner: outcome.lease.owner,
					project: outcome.lease.project,
					testName: outcome.lease.testName,
					expiresInMs: leases.remainingMs(outcome.lease),
				},
				device,
				capabilities: manifest.capabilities,
			};
		},

		release_device(params: ReleaseDeviceParams): ReleaseDeviceResult {
			// R9 hangs state restoration off this call and off expiry alike (D9); today releasing
			// only frees the device.
			return { released: leases.release(params.leaseId) };
		},
	};
}

/** Which refusal an inventory error is, or `null` for one that is genuinely a host failure. */
function refusalReasonFor(error: unknown): AcquireRefusalReason | null {
	if (error instanceof ForeignDeviceError) {
		return 'not-attached';
	}
	if (error instanceof DeviceVanishedError) {
		return 'gone';
	}
	return null;
}

/** The error's own words: it already names the device and says what happened to it. */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
