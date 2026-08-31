/**
 * Port numbers for the helper services a lease's hooks start — one block per live lease (R18).
 *
 * **A slot is the numbered parallel position a live lease occupies on this host.** It is
 * 0-based, it is allocated with the lease and released once that lease's restoration has
 * finished, and the ports follow from its index by arithmetic:
 * `portBase = SLOT_PORT_BASE + index * PORTS_PER_SLOT`. Two live leases never share a block,
 * which is the whole of what a hook may rely on.
 *
 * **Rover hands out numbers, not sockets.** Nothing here binds a port and nothing here probes
 * one: the host never listens on a slot's ports, the project's own service does. A probe would
 * also be a lie — binding a port, closing it and handing the number to a child that binds it a
 * moment later is check-then-use, and it cannot be honest about a port some unrelated program
 * takes in between. So the range is chosen to be out of the way instead (see the constants),
 * and the guarantee is bounded honestly: no two live leases are given the same numbers.
 *
 * **{@link SlotAllocator.allocate} is synchronous, for `./leases.ts`'s reason.** It is called
 * from inside the straight-line section of `./lease-handlers.ts` that makes a grant exclusive;
 * an `await` in there is the defect that file is arranged to prevent, so there is none here.
 *
 * **Nothing is persisted.** Slots are host state that dies with the daemon (D6): after a
 * restart there are no leases, so there are no slots, and there is nothing to reclaim from a
 * predecessor.
 *
 * This module imports nothing from `./leases.ts`, so `Lease` can carry a {@link Slot} without a
 * cycle, and it starts no process, so the module-graph gates are untouched.
 */

/**
 * The first port of slot 0.
 *
 * Clear of the ports a device host actually runs things on — the platform tooling's own daemons
 * and device consoles in the 5000s, the usual bundler, automation-server and inspector ports in
 * the 4000s to 9000s, and the 3000/8080 every web project reaches for — and **below every
 * operating system's ephemeral range** (32768–60999 and 49152–65535 on the two this targets),
 * so the OS cannot hand one of these to an unrelated process while a slot holds it. The specific
 * numbers a backend's tooling uses are `PROJECT.md` §5's business, not this module's.
 */
export const SLOT_PORT_BASE = 26_000;

/**
 * How many consecutive ports one slot owns: a bundler, a mock API, a proxy, an automation
 * server, and slack. A hook reads `ROVER_PORT_COUNT` (`./hook-command.ts`) rather than assuming
 * this, so the number can change without every project's hooks drifting from the daemon.
 */
export const PORTS_PER_SLOT = 8;

/**
 * How many slots there are: 26000–26511, one contiguous block an operator can reserve or
 * firewall in a single line, and far past any plausible number of devices on one host.
 */
export const SLOT_COUNT = 64;

/** One lease's numbered position on this host, and the ports that follow from it. */
export interface Slot {
	/** 0-based, and stable for the lease's whole life. Useful as a unique suffix in its own right. */
	readonly index: number;
	/** The first port of this slot's block. */
	readonly portBase: number;
	/** How many consecutive ports from {@link portBase} belong to this slot. */
	readonly portCount: number;
}

export interface SlotAllocator {
	/**
	 * The lowest free slot, or `null` when every one is taken.
	 *
	 * **Synchronous by contract** — see this module's header. A caller that took a slot and
	 * then refused the grant must give it back before its next `await`.
	 */
	allocate(): Slot | null;
	/** Give one back. Idempotent: releasing a slot that is already free changes nothing. */
	release(slot: Slot): void;
	/** How many slots are in use. A real query, so a test can assert a slot came back without
	 * consuming it by asking for another one. */
	taken(): number;
	/** How many there are in total — what an exhaustion refusal names. */
	readonly size: number;
}

export interface SlotAllocatorOptions {
	/**
	 * Test seams in the spirit of `LeaseStoreOptions.ttlMs`, not a configuration surface: a
	 * pool of 64 and a test that proves what exhaustion does cannot both be in the same run.
	 * There is deliberately no environment variable for any of them (ai/RULES.md §7) — the
	 * catalogue is what an operator *sets*, and there is nothing here to tune yet.
	 */
	readonly count?: number;
	readonly portBase?: number;
	readonly portsPerSlot?: number;
}

export function createSlotAllocator(options: SlotAllocatorOptions = {}): SlotAllocator {
	const count = options.count ?? SLOT_COUNT;
	const portBase = options.portBase ?? SLOT_PORT_BASE;
	const portsPerSlot = options.portsPerSlot ?? PORTS_PER_SLOT;

	// The indices in use, and the entirety of this module's state. A set of taken indices
	// rather than a free list, so a double release cannot put one index in the pool twice.
	const inUse = new Set<number>();

	return {
		size: count,

		allocate(): Slot | null {
			// Lowest free first, scanned rather than remembered: `count` is 64 on a path that is
			// already doing a device round trip, and a remembered cursor would be a second piece
			// of state that can disagree with the set (D6).
			for (let index = 0; index < count; index += 1) {
				if (inUse.has(index)) {
					continue;
				}
				inUse.add(index);
				return {
					index,
					portBase: portBase + index * portsPerSlot,
					portCount: portsPerSlot,
				};
			}
			return null;
		},

		release(slot: Slot): void {
			inUse.delete(slot.index);
		},

		taken(): number {
			return inUse.size;
		},
	};
}
