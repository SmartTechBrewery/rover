import { z } from 'zod';

/**
 * `list_devices`' answer, as much of it as the Devices screen reads.
 *
 * **Deliberately re-declared rather than imported from `src/ipc/methods.ts`**, for the reason
 * `host-client.ts` gives about `ResponseEnvelopeSchema`: the panel is a separate tree with its own
 * `tsconfig.json` and its own `@panel` alias, precisely so one alias never means two trees
 * (`vitest.config.ts`) — and the daemon's method table drags `core/device.ts`,
 * `core/capabilities.ts` and the whole verb schema neighbourhood into a browser bundle behind it.
 * What is duplicated is a handful of field names on a versioned wire format.
 *
 * The drift that buys is pinned rather than hoped for: `tests/fixtures/panel/list-devices.json` is
 * parsed by the **daemon's** `ListDevicesResultSchema` in `tests/unit/panel/list-devices-fixture.test.ts`
 * and by the mirror below in `device-list.test.ts`. One fixture, two projects, no cross-tree import.
 *
 * **Nothing here is `.strict()`, and that is the one deliberate difference from the host's copy.**
 * The host's `.strict()` protects the host from a handler leaking a field it never meant to
 * publish; a browser refusing an answer because a newer daemon added a column would blank a working
 * screen over a compatible change. Zod's default strips what it does not know, which is what a
 * reader wants and what a writer must not have.
 */

/**
 * Who holds a device, as a stranger is shown it — the lease id is never on this wire (D20).
 *
 * Exported because `force_release_device` answers with the same projection (`src/ipc/methods.ts`,
 * `src/daemon/lease-holder.ts` — one path on the host, so one mirror here): the lease the panel
 * ended is described in exactly the words the listing described it in, and there is no second
 * place for a field to be added to only one of them.
 */
export const LeaseHolderSchema = z.object({
	serial: z.string(),
	owner: z.string(),
	project: z.string(),
	/** Required (D22, as amended #129) — never null and never a missing key. */
	testName: z.string(),
	/**
	 * What the holder said this run is about, in its own sentences — **optional, and absent is
	 * absent** (D22, as amended #148).
	 *
	 * `.optional()` and not `.nullable()`, because that is what the host sends: a lease taken
	 * without one carries no key at all rather than a `null` or an empty string, so there is
	 * nothing here for a card to mistake for a description (`src/ipc/methods.ts`). The card and
	 * the force-release dialog draw no field when it is missing, and neither substitutes a
	 * placeholder.
	 */
	testDescription: z.string().optional(),
	/**
	 * When the lease was granted, as the host's own ISO-8601 instant.
	 *
	 * Kept as the string it arrived as. It is the *host's* clock, so the panel renders it and never
	 * differences it against `Date.now()` — that difference is the skew plus the answer. Anything
	 * relative comes from {@link LeaseHolder.expiresInMs}, which is a duration for exactly that
	 * reason (D17).
	 */
	grantedAt: z.string(),
	/** How long until this lease would expire **if nothing renews it** (D8). */
	expiresInMs: z.number(),
});
export type LeaseHolder = z.infer<typeof LeaseHolderSchema>;

/** One device in the list: what the host knows about the hardware, plus who is holding it. */
const ListedDeviceSchema = z.object({
	serial: z.string(),
	platform: z.string(),
	/** A device that could not be asked still lists — the card falls back to the serial. */
	model: z.string().nullable(),
	/** Null is a real answer, commonly for a phone waiting on its authorization prompt. */
	osVersion: z.string().nullable(),
	/**
	 * What the host can currently do with the hardware — `ready`, or `unauthorized`/`offline`,
	 * which both mean "visible to the host, but no verb can run on it" (`src/core/device.ts`).
	 *
	 * **The card must read this**, because a device that is not `ready` and holds no lease is one
	 * the daemon will refuse to lease (`not-ready`, `src/daemon/lease-handlers.ts`) — calling it
	 * *free* is the plausible-looking answer `ai/RULES.md` §2 forbids, and the CLI's own `STATE`
	 * column already says otherwise.
	 *
	 * A **string rather than an enum**, on the same non-`.strict()` reasoning as the rest of this
	 * mirror: a newer daemon adding a fourth state must not blank a working screen. Everything but
	 * the exact word `ready` is treated as not usable, which is the safe direction to be wrong in,
	 * and the word itself is what the card prints.
	 */
	state: z.string(),
	heldBy: LeaseHolderSchema.nullable(),
});
export type ListedDevice = z.infer<typeof ListedDeviceSchema>;

export const ListDevicesResultSchema = z.object({
	devices: z.array(ListedDeviceSchema),
	/**
	 * The list is **not known to be current**. An empty list with this set means *no view*, not
	 * *no devices* (D6) — the one place in this panel where two states look alike and mean the
	 * opposite, which is why the screen renders them differently on purpose.
	 */
	stale: z.boolean(),
});
export type ListDevicesResult = z.infer<typeof ListDevicesResultSchema>;
