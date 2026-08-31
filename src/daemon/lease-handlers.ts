/**
 * The `acquire_device` and `release_device` handlers — the lease store's only surface.
 *
 * **The order of the work in {@link createLeaseHandlers} is the exclusivity guarantee**, and
 * it is the thing to preserve when editing this file. `LeaseStore.acquire` is synchronous, so
 * two concurrent grants for one device cannot interleave *inside* it; what would let four
 * callers through instead is an `await` placed between the moment a handler decides the
 * device is free and the moment it takes it. So every awaited step happens first — the
 * re-verification, then waiting out any restoration still running on the device — and
 * everything from there to the insert is straight-line synchronous code. Adding an await
 * between the decision and the insert is the defect this file is arranged to prevent; adding
 * one above it is free. Exactly one await sits *below* the insert — the project's helper
 * services — and why that is safe is argued for on its own below.
 *
 * **A grant waits for the previous lessee's state to be undone** (D9). An expired holder is
 * observed here before the wait, because observing it is what starts its restoration — the
 * lease store fires its end hook from the one place a lease ends, and nothing else in this
 * process is watching that device between the moment the holder's TTL passes and the moment
 * somebody asks about it.
 *
 * A second ordering rule holds for the same reason in reverse: **nothing that can throw may
 * run after a successful acquire.** A throw becomes `internal_error`, the caller never learns
 * the lease id, and the device is wedged for the full TTL with nobody able to release it. The
 * capability lookup is resolved before the insert on purpose.
 *
 * **The project's helper services are the one awaited step below the insert** (D13, R17 phase
 * 4), and both rules survive it. Exclusivity does, because the wait is *after* the
 * decide-and-insert rather than inside it — by then this caller holds the device and no second
 * grant can be interleaved. The second rule does, because `ProjectServices.start` never
 * throws: it answers with a refusal, and this handler then **releases the lease it just took**,
 * so the device is free for the next caller instead of held by a grant that did not work out.
 * It cannot run before the insert: a caller who is about to be refused `held` would otherwise
 * start — and then stop — the services of whoever actually holds the device.
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
	ReleaseDeviceParams,
	ReleaseDeviceResult,
} from '../ipc/methods.js';
import type { DeviceInventory } from './inventory.js';
import { toLeaseHolder } from './lease-holder.js';
import type { LeaseStore } from './leases.js';
import type { ProjectServices } from './project-services.js';
import type { DeviceRestorer } from './restore.js';

export type LeaseHandlers = Pick<IpcHandlers, 'acquire_device' | 'release_device'>;

/**
 * The two ways re-verifying a device answers "no".
 *
 * Narrower than either refusal vocabulary on purpose, so it is assignable to both: a grant
 * can also be refused because somebody holds the device, and a verb call because nobody
 * does, but neither of those is something the inventory can say.
 */
export type InventoryRefusalReason = Extract<AcquireRefusalReason, 'gone' | 'not-attached'>;

export function createLeaseHandlers(
	inventory: DeviceInventory,
	leases: LeaseStore,
	restorer: DeviceRestorer,
	services: ProjectServices,
): LeaseHandlers {
	return {
		async acquire_device(params: AcquireDeviceParams): Promise<AcquireDeviceResult> {
			// The first await. The inventory is a cache and the platform is the truth, so the
			// grant re-verifies rather than reading what was last seen (D6).
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

			// A question, asked for its side effect: `holderOf` drops a record whose instant has
			// passed, and dropping it is what fires the store's end hook and starts the
			// restoration this then waits on. A live holder is left alone — the acquire below
			// refuses it with the answer a caller can act on.
			leases.holderOf(device.serial);
			// The second and last await, and it is still before the decide-and-insert. Resolves
			// immediately when nothing is being restored on this device, which is the common case.
			await restorer.settle(device.serial);

			// Resolved before the acquire, never after: this throws for an unregistered platform,
			// and a throw past the insert would wedge the device for the whole TTL.
			const { manifest } = requireDeviceBackend(device.platform);

			// Nothing between here and the insert may await, and nothing below it may throw.
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
					heldBy: toLeaseHolder(outcome.heldBy, leases),
				};
			}

			// The one await below the insert — see this module's header. Contained absolutely: a
			// refusal is data, and the lease it was taken under is handed straight back.
			const refusal = await services.start(outcome.lease);
			if (refusal !== null) {
				// Ending the lease is what puts the device back: the restoration runs on this path
				// exactly as it runs on a release (D9), so the project's own stops and teardown get
				// their turn and the next caller waits for them through `settle`. What this grant
				// had already started was stopped by `start` itself, before it answered.
				leases.release(outcome.lease.id);
				return {
					outcome: 'refused',
					reason: 'service-failed',
					message: refusal.message,
					heldBy: null,
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
			// Restoration is started by the store's end hook, not from here, and this deliberately
			// does not wait for it: the answer to `release_device` is "the lease is over", which is
			// true the moment the record is gone. What happens to the device next is the daemon's
			// business, and a caller that had to await it could also decline to (D9). The next
			// `acquire_device` on this serial is what waits.
			return { released: leases.release(params.leaseId) };
		},
	};
}

/**
 * Which refusal an inventory error is, or `null` for one that is genuinely a host failure.
 *
 * Exported for `./verb-handlers.ts`, which re-verifies the same device against the same
 * inventory and owes the caller the same two answers. Two copies of this mapping would be
 * two places a third inventory error has to be remembered.
 */
export function refusalReasonFor(error: unknown): InventoryRefusalReason | null {
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
