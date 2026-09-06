/**
 * The Archive screen's URL contract — the one place a path is turned into components and back.
 *
 * **Where you are is its URL, and the tree card's search text is the one deliberate exception**
 * (`docs/DESIGN.md` §9, #146). A reload lands where you were, a link is shareable, and the tree's
 * expansion is *derived* from the selected path rather than stored beside it, so the tree and the
 * address can never disagree about *where you are*. The search text is component state and is
 * deliberately not in the address (`archive-search.ts`): a shared link lands on the address without
 * somebody else's search, and selecting a hit is a navigation to one of these paths like any other.
 *
 * A component is used **verbatim**. Nothing here trims it, lower-cases it or sanitises it: these
 * are the on-disk names a previous `list_archive` answer returned, `pathSegment` ran on the way in
 * and is not reversible, and D22 is explicit that a component is opaque.
 */

/**
 * How many levels one request may name — mirrored from `MAX_ARCHIVE_PATH_DEPTH` in
 * `src/ipc/methods.ts`, which the panel deliberately does not import from (`archive-listing.ts`
 * says why). The host answers `invalid_params` past it, so a hand-typed address that goes deeper
 * is truncated here rather than sent to be refused.
 */
export const MAX_ARCHIVE_PATH_DEPTH = 8;

/**
 * How long the tree card's search text may be — mirrored from `MAX_ARCHIVE_SEARCH_TEXT_LENGTH` in
 * `src/ipc/methods.ts`, which the panel deliberately does not import from, exactly as the depth
 * above is. The host answers `invalid_params` past it, so the field stops there rather than
 * spending a request to be refused and reporting it as a host that could not search.
 */
export const MAX_ARCHIVE_SEARCH_TEXT_LENGTH = 255;

/**
 * The components a `/archive/$` or `/groups/$` splat names.
 *
 * An absent or empty splat is the **root**, `[]` — the address `/archive` and the address
 * `/archive/` mean the same level. Empty segments are dropped rather than kept as a component the
 * host would refuse: `a//b` is a doubled separator, not a directory with no name.
 *
 * **`offset` is how many components this view puts in front of the archive's own path**, and the
 * cap is the host's plus it (#189 review). The bound above is a bound on an *archive* path, and a
 * groups splat is one component longer than the archive address it names — the `groupId`, which
 * `archiveAddressOf` drops *after* this runs. Capping at eight regardless would cut the deepest
 * groups address back to its parent on the way in, so a row the tree built and linked to would
 * select the level above the one that was clicked. It is `routes/archive.tsx`'s own `OFFSET` that
 * is passed here, so the two views reach the same archive depth by construction rather than by two
 * numbers agreeing.
 */
export function componentsFromSplat(splat: string | undefined, offset = 0): readonly string[] {
	if (splat === undefined || splat === '') {
		return [];
	}
	return splat
		.split('/')
		.filter((component) => component !== '')
		.slice(0, MAX_ARCHIVE_PATH_DEPTH + offset);
}

/** The splat naming one level. The router does the encoding; this joins. */
export function splatFromComponents(components: readonly string[]): string {
	return components.join('/');
}

/**
 * A cache key for one level, injective over the components a listing can name.
 *
 * NUL is the join character because it is one of the two things `ArchivePathSegmentSchema` refuses
 * outright — the other being the separator itself — so no component can contain one and no two
 * different paths can collide. A newline, a `\r`, an ESC and a backslash are all legal in a
 * filename and all accepted by the host on purpose, so none of them would do.
 */
export function keyOf(components: readonly string[]): string {
	return components.join('\u0000');
}

/**
 * Every level a selection needs read: the root, then one per component of the path.
 *
 * This is the whole of *lazily, one `readdir` at a time*, and it is why nothing walks the archive —
 * the levels fetched are exactly the prefixes of the selected path, each one a level actually
 * drawn. A pre-walk is not so much avoided here as unrepresentable.
 */
export function levelsOf(components: readonly string[]): readonly (readonly string[])[] {
	return [[], ...components.map((_name, index) => components.slice(0, index + 1))];
}

/**
 * The archive address a **groups-view** splat names — its components with the one at index 1
 * dropped, because the group id is not a directory (#181).
 *
 * The groups view's splat is `<project>/<groupId>/<testName>/<run>/<serial>/<…>`, and everything
 * under it that reads bytes or lists a directory — `list_archive` at and below a run's `<serial>`,
 * `device_info.json`, `test_description.json`, the byte route for an open artifact — takes the
 * archive's own `<project>/<testName>/<run>/<serial>/<…>`. **This is the only place that knows the
 * difference**, which is what keeps the group id from having to be threaded past, or filtered out
 * of, every one of those call sites.
 *
 * It is a drop rather than a parse: no component is read, trimmed or interpreted, and the one at
 * index 1 is identified by its position in an address this view composed itself (D22).
 *
 * Below the group's own depth this is the address; at or above it there is no archive address to
 * name — `[project]` alone gives back `[project]`, which is the level the `All` view would list,
 * and no caller asks it about anything shallower.
 */
export function archiveAddressOf(components: readonly string[]): readonly string[] {
	return [...components.slice(0, 1), ...components.slice(2)];
}
