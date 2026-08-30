/**
 * What is driving a device right now — the register that keeps a verb from outliving the
 * lease that authorised it (D7, D9, D19).
 *
 * A verb call can take minutes and the server does not await its dispatch, so a
 * `release_device` — or the sweep observing an expiry — can land while a verb is still
 * polling the hardware. Without this module the lease record simply disappears underneath
 * the call: the verb keeps reading and, once the input verbs land, keeps *writing*, while
 * restoration tears the device down and the next agent is granted it. The host would be the
 * second driver in the two-agents-one-device failure it exists to prevent (PROJECT.md §2).
 *
 * **The lease is revoked, not merely marked.** {@link VerbTraffic.stop} does not ask the
 * verb to notice anything: it takes the device away by making the backend the call was
 * handed refuse every further method. The verb's next screen read throws, the throw travels
 * out of the verb layer unchanged, and `./verb-handlers.ts` answers `refused` / `no-lease`.
 * A flag the verb had to *check* would be a rule each of the five remaining verb families
 * re-derives, and the one that forgot would be the one holding a tap.
 *
 * **The wrapper is a `Proxy`, on purpose.** Enumerating `DeviceBackend`'s methods here would
 * mean a method added later silently escapes the revocation — a guard with a hole in it is
 * worse than none, because it reads as a guarantee. Every property access goes through one
 * check instead, so what is covered is "the backend", not a list somebody has to maintain.
 * The capability-gated methods keep being absent when the backend does not have them, which
 * is what `requireCapability` and the restorer's `required()` both read.
 *
 * **Revocation stops the next backend call, never the round trip already issued.** Nothing
 * here can cancel a round trip a backend has handed to the device, and pretending otherwise
 * would be the more dangerous lie. So there is a second half: {@link VerbTraffic.settle}
 * resolves once the calls on a device have actually unwound, and the restoration a lease's end
 * starts waits on it — which is in turn what `acquire_device` already waits on.
 *
 * **What that wait actually costs, stated rather than assumed.** A revoked verb reaches its
 * next backend call and stops there, so for a verb built only out of backend calls the wait is
 * one round trip long — which is already up to `INSTALL_ADB_TIMEOUT_MS` (five minutes) for the
 * transfer rows, not the small number the phrase suggests. And a verb may await something that
 * is *not* a backend call at all: `install_app` with no bytes runs a project's install command
 * as a host process, and `record_video` extracts frames as one. Revoking a backend reaches
 * neither. That is what {@link VerbCall.signal} is for — it is the half of {@link
 * VerbTraffic.stop} that can reach work the guard cannot — and why `./restore.ts` bounds its
 * own wait on {@link VerbTraffic.settle} instead of trusting it to be short.
 *
 * **A call is registered before the preamble, not before the verb.** `./verb-handlers.ts`
 * re-verifies the device between resolving the lease and running anything, and that is an
 * await like any other: a call registered after it would leave a window where a lease ends,
 * finds nothing to stop, and a verb starts driving a device that has already been handed on.
 */

import type { DeviceBackend } from '../core/device.js';
import type { DeviceSerial, LeaseId } from '../core/ids.js';
import type { Lease } from './leases.js';

/**
 * Thrown by a revoked backend, and only by one: the lease that made this call legitimate
 * ended while the call was still running.
 *
 * Not a verb failure and not a host failure — the verb was answering perfectly well, and it
 * was stopped for a reason that has nothing to do with the device. `./verb-handlers.ts`
 * turns it into the `no-lease` refusal an agent already knows how to read, which is why this
 * carries plain fields like every other error that crosses that boundary.
 */
export class LeaseEndedError extends Error {
	readonly serial: DeviceSerial;
	readonly leaseId: LeaseId;

	constructor(serial: DeviceSerial, leaseId: LeaseId) {
		super(
			`The lease on device '${serial}' ended while this call was still running — it was ` +
				`released, or it expired — so the verb was stopped rather than allowed to keep ` +
				`driving a device the host may already have handed to somebody else`,
		);
		this.name = 'LeaseEndedError';
		this.serial = serial;
		this.leaseId = leaseId;
	}
}

/** One verb call in flight, from the inside: how it reaches the device. */
export interface VerbCall {
	/**
	 * The backend this call may drive — the one it was given, wrapped so that every method
	 * throws {@link LeaseEndedError} from the moment the lease ends. Wrap once and hand the
	 * result to the verb; the verb learns nothing about leases from it.
	 */
	guard(backend: DeviceBackend): DeviceBackend;
	/**
	 * Aborted the moment the lease ends — the second half of {@link VerbTraffic.stop}, for the
	 * work {@link VerbCall.guard} cannot reach.
	 *
	 * The guard covers everything a verb does *through the backend*, which is almost all of it.
	 * What it does not cover is a verb awaiting a **host process**: `install_app` with no bytes
	 * runs a project's install command that way, and its budget is five minutes
	 * (`INSTALL_HOOK_TIMEOUT_MS`). Left alone, a released lease's build keeps running, {@link
	 * VerbTraffic.settle} keeps waiting for it, and the restoration — and therefore the next
	 * `acquire_device` on that device — parks behind it for the whole budget.
	 *
	 * So a handler that spawns hands this on and the process is killed with the lease. It is a
	 * signal rather than a second guard because a child process is not a method call: there is
	 * nothing to intercept, only something to stop.
	 */
	readonly signal: AbortSignal;
}

export interface VerbTraffic {
	/**
	 * Run one verb call on `lease`'s device, registered for as long as it takes.
	 *
	 * Whatever `work` answers or throws is passed straight through — this decides nothing
	 * about the call, it only knows that the call is happening.
	 */
	run<T>(lease: Lease, work: (call: VerbCall) => Promise<T>): Promise<T>;
	/**
	 * The lease has ended: revoke the device from every call still running under it.
	 *
	 * Synchronous, returns at once and never throws — it is called from the lease store's end
	 * hook, where a throw would abort a grant and a wait would put an `await` in the middle of
	 * one (`./leases.ts`). It stops the *next* backend call and aborts {@link VerbCall.signal},
	 * which is what reaches a host process the guard cannot; {@link settle} is the wait.
	 */
	stop(lease: Lease): void;
	/**
	 * Resolve once the verb calls now driving `serial` have unwound. Never rejects: a call
	 * that threw has still stopped, which is the only thing being asked.
	 */
	settle(serial: DeviceSerial): Promise<void>;
}

interface RegisteredCall {
	readonly leaseId: LeaseId;
	/** Flipped by {@link VerbTraffic.stop}; read by every guarded method. Never flipped back. */
	revoked: boolean;
	/** Aborted by {@link VerbTraffic.stop}, beside `revoked`. See {@link VerbCall.signal}. */
	readonly cancel: AbortController;
	/** Resolves — never rejects — when the call has stopped touching the device. */
	readonly finished: Promise<void>;
	readonly finish: () => void;
}

export function createVerbTraffic(): VerbTraffic {
	// Per serial, because the thing being made exclusive is the device (D7). A set rather than
	// one entry: nothing stops a holder firing two verbs down one connection, since the server
	// dispatches frames without awaiting them. Emptied entries are deleted, so this does not
	// grow with the number of calls the host has ever answered.
	const inFlight = new Map<DeviceSerial, Set<RegisteredCall>>();

	return {
		async run<T>(lease: Lease, work: (call: VerbCall) => Promise<T>): Promise<T> {
			const call = registerCall(inFlight, lease);
			try {
				return await work({
					guard: (backend: DeviceBackend) => revocableBackend(backend, lease, call),
					signal: call.cancel.signal,
				});
			} finally {
				forgetCall(inFlight, lease.serial, call);
			}
		},

		stop(lease: Lease): void {
			for (const call of inFlight.get(lease.serial) ?? []) {
				// By lease id, not by serial: the device may already belong to somebody else, and
				// their call is not this lease's to stop.
				if (call.leaseId === lease.id) {
					call.revoked = true;
					// Beside the flag, not instead of it: the flag stops the next backend call and
					// this stops a host process the guard never sees. Neither subsumes the other.
					call.cancel.abort();
				}
			}
		},

		async settle(serial: DeviceSerial): Promise<void> {
			// A snapshot, in the spirit of `DeviceRestorer.settleAll`: what is running now. A call
			// registered afterwards would need a live lease on this device, and there cannot be
			// one until the grant that is waiting here goes through.
			await Promise.all([...(inFlight.get(serial) ?? [])].map((call) => call.finished));
		},
	};
}

function registerCall(
	inFlight: Map<DeviceSerial, Set<RegisteredCall>>,
	lease: Lease,
): RegisteredCall {
	let finish: () => void = () => {};
	const finished = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const call: RegisteredCall = {
		leaseId: lease.id,
		revoked: false,
		cancel: new AbortController(),
		finished,
		finish,
	};

	const calls = inFlight.get(lease.serial) ?? new Set<RegisteredCall>();
	calls.add(call);
	inFlight.set(lease.serial, calls);
	return call;
}

function forgetCall(
	inFlight: Map<DeviceSerial, Set<RegisteredCall>>,
	serial: DeviceSerial,
	call: RegisteredCall,
): void {
	const calls = inFlight.get(serial);
	calls?.delete(call);
	if (calls?.size === 0) {
		inFlight.delete(serial);
	}
	// Last, so nothing waiting on this call observes it as finished while it is still listed.
	call.finish();
}

/**
 * The backend as this call may use it: every method checked against the revocation first.
 *
 * The check is on the *call* rather than on the lease store, deliberately. This has to hold
 * for a lease that expired as well as one that was released, and both reach it by the one
 * path a lease ever ends by (`./leases.ts`, `forget`) — so there is nothing here to keep in
 * step with the store, and no second definition of "still held" that can disagree with it.
 */
function revocableBackend(
	backend: DeviceBackend,
	lease: Lease,
	call: RegisteredCall,
): DeviceBackend {
	return new Proxy(backend, {
		get(target: DeviceBackend, property: string | symbol): unknown {
			const value = Reflect.get(target, property);
			if (typeof value !== 'function') {
				return value;
			}
			return (...args: readonly unknown[]): unknown => {
				if (call.revoked) {
					throw new LeaseEndedError(lease.serial, lease.id);
				}
				return Reflect.apply(value as (...rest: readonly unknown[]) => unknown, target, args);
			};
		},
	});
}
