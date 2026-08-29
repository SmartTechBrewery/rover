/**
 * The `list_devices` handler — the inventory's view of the hardware joined to the lease
 * store's view of who is holding it.
 *
 * The join has to happen here rather than in a client: the host owns the lease store and a
 * client owns nothing, so "what is connected, what is free and who holds what" is not
 * information any caller can compute for itself. It is answered in the protocol rather than
 * inside one client's layer because daemon state has to be answerable to something that is
 * not an agent (ai/RULES.md §1, D16) — whatever answers this for one client answers it for
 * all of them.
 *
 * **Still the cached view, deliberately.** `list_devices` is a question about what the host
 * has seen, and answering it by re-enumerating every device on every call would put a
 * process launch per backend behind a call a client may make in a loop. The one place that
 * must not read a cache is the grant (D6), and that is `DeviceInventory.verifyForGrant`, not
 * this.
 *
 * **`holderOf` is a question with a side effect, and that is wanted.** Every read of the
 * store drops a record whose instant has passed, and dropping it is what fires the store's
 * end hook and starts the restoration (D9). So a list can be the thing that *observes* a
 * dead agent's expiry, exactly as `acquire_device` already is. Nothing here waits on that
 * restoration — a list is a question, not a grant.
 *
 * The handler stays **synchronous** because `snapshot()` and `holderOf()` both are. That is
 * not the exclusivity ordering rule from `lease-handlers.ts` — nothing is being taken here —
 * but keeping it await-free costs nothing and means a list can never interleave with a grant.
 */

import type { IpcHandlers, ListDevicesResult } from '../ipc/methods.js';
import type { DeviceInventory } from './inventory.js';
import { toLeaseHolder } from './lease-holder.js';
import type { LeaseStore } from './leases.js';

export type ListDevicesHandler = Pick<IpcHandlers, 'list_devices'>;

export function createListDevicesHandler(
	inventory: DeviceInventory,
	leases: LeaseStore,
): ListDevicesHandler {
	return {
		list_devices(): ListDevicesResult {
			const snapshot = inventory.snapshot();
			return {
				devices: snapshot.devices.map((device) => {
					const holder = leases.holderOf(device.serial);
					// `null`, never an absent key: `undefined` does not survive JSON, so a free
					// device would arrive as a shape a client has to special-case.
					return { ...device, heldBy: holder ? toLeaseHolder(holder, leases) : null };
				}),
				// Passed through untouched. A device list gaining a column must not change what
				// "not known to be current" means: it is still about the host's view of the
				// hardware, and a lease is host state that has no view to be stale.
				stale: snapshot.stale,
			};
		},
	};
}
