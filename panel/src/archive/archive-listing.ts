import { z } from 'zod';

/**
 * `list_archive`' answer, as much of it as the Archive screen reads.
 *
 * **Deliberately re-declared rather than imported from `src/ipc/methods.ts`**, for the reason
 * `panel/src/devices/device-list.ts` gives at length: the panel is a separate tree with its own
 * `tsconfig.json` and its own `@panel` alias, precisely so one alias never means two trees
 * (`vitest.config.ts`) — and the daemon's method table drags `core/device.ts`,
 * `core/capabilities.ts` and the whole verb schema neighbourhood into a browser bundle behind it.
 *
 * The drift that buys is pinned rather than hoped for: `tests/fixtures/panel/list-archive.json` is
 * parsed by the **daemon's** `ListArchiveResultSchema` in
 * `tests/unit/panel/list-archive-fixture.test.ts` and by the mirror below in
 * `archive-listing.test.ts`. One fixture, two projects, no cross-tree import.
 *
 * **Nothing here is `.strict()`**, and that is the same deliberate difference from the host's copy
 * the device mirror makes: a browser that blanks a working screen because a newer daemon added a
 * field is worse than one that ignores it. Zod's default strips what it does not know.
 *
 * **A name is not validated here beyond being a string.** The host has already bounded it
 * (`ArchivePathSegmentSchema`: no `.`, no `..`, no separator, no NUL) and the panel uses it
 * verbatim — nothing trims it, lower-cases it or parses it to decide what a level *is* (D22).
 */

/** A child directory: a level the tree may descend into. */
const ArchiveDirectorySchema = z.object({
	kind: z.literal('directory'),
	name: z.string(),
	/**
	 * How many entries it holds, from one `readdir` of it and no deeper. **`null` is not `0`** —
	 * it means the host could not read into it, and rendering a `0` there would say *empty* about
	 * a directory nobody can see into. The screen renders `unknown`.
	 */
	childCount: z.number().nullable(),
	/**
	 * The name of the one entry it holds, when it holds exactly one.
	 *
	 * This is what the `<serial>` level is read from: one lease is one device, so a run directory
	 * holds exactly one child, and the host publishes that as a fact about the run rather than as
	 * a level worth a round trip. The panel never treats it as a tree level.
	 */
	onlyChild: z.string().nullable(),
});
export type ArchiveDirectory = z.infer<typeof ArchiveDirectorySchema>;

/** A regular file. `sizeBytes` is `null` when the host could not `stat` it. */
const ArchiveFileSchema = z.object({
	kind: z.literal('file'),
	name: z.string(),
	sizeBytes: z.number().nullable(),
});
export type ArchiveFile = z.infer<typeof ArchiveFileSchema>;

/**
 * Neither a directory nor a regular file — a symlink, a socket, a device node. The host names it
 * rather than dropping it, and so does this screen: an omitted entry would make a listing that is
 * short look exactly like one that is complete.
 */
const ArchiveOtherSchema = z.object({ kind: z.literal('other'), name: z.string() });

export const ArchiveEntrySchema = z.discriminatedUnion('kind', [
	ArchiveDirectorySchema,
	ArchiveFileSchema,
	ArchiveOtherSchema,
]);
export type ArchiveEntry = z.infer<typeof ArchiveEntrySchema>;

/**
 * Three answers, never two.
 *
 * `listed` with no entries is *the archive is empty* and is not a failure; `unreadable` is *the
 * host cannot say what is in it*. The pair must never render alike — the same distinction `stale`
 * draws on the device list (D6, `docs/DESIGN.md` §7, §9) — which is why it arrives as a
 * discriminated union rather than as two readings of one array.
 */
export const ListArchiveResultSchema = z.discriminatedUnion('outcome', [
	z.object({ outcome: z.literal('listed'), entries: z.array(ArchiveEntrySchema) }),
	z.object({ outcome: z.literal('missing') }),
	z.object({ outcome: z.literal('unreadable') }),
]);
export type ListArchiveResult = z.infer<typeof ListArchiveResultSchema>;
