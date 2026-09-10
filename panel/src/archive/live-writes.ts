import type { DeviceListState } from '@panel/devices/device-list-provider.js';

/**
 * **Whether anything is being written into the archive** — the one gate the Archive screen's clock
 * runs behind (#287, `docs/DESIGN.md` §9).
 *
 * A run directory is written **while a lease is live and only then** (`src/daemon/archive.ts`), so
 * *is a lease live* is the whole of the question, and it is already answered on this page: the
 * device poll runs above the router (`device-list-provider.tsx`), so this costs no request of the
 * Archive screen's own and no new host method. A **type-only** import, so no archive module drags
 * the provider into its graph — and a plain function rather than a hook, because the one caller
 * reads `useDeviceList()` itself and this stays testable without a provider.
 *
 * **Any live lease anywhere, and deliberately not the lease on this reader's project.** A lease
 * carries both a `project` and a `testName` (D22), so narrowing was available and was rejected: the
 * refresh re-reads *what is drawn* wholesale rather than one address, so matching would save a
 * handful of `readdir`s and would buy a second address vocabulary — plus the bug where a reader
 * browsing the project a lease is *not* in gets no refresh at all, which is exactly the staleness
 * this exists to end.
 *
 * **`loading` is *not writing*, and so is `unreachable`.** Nothing is known yet in the first case
 * and the screen is not mounted at all in the second (`app.tsx` renders the unreachable page in
 * place of the router). Either way the idle cost is nothing: no lease, no interval, no requests.
 *
 * **A `stale: true` answer opens the gate like any other** (D6). `stale` is about the host's view of
 * the *hardware* — that it could not be re-derived from `adb devices` just now — and a lease is
 * host state that has no view to be stale: the leases such an answer names are named exactly.
 */
export function archiveIsBeingWritten(state: DeviceListState): boolean {
	return state.status === 'ready' && state.devices.some((device) => device.heldBy !== null);
}
