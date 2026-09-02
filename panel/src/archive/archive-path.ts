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
 * The components a `/archive/$` splat names.
 *
 * An absent or empty splat is the **root**, `[]` — the address `/archive` and the address
 * `/archive/` mean the same level. Empty segments are dropped rather than kept as a component the
 * host would refuse: `a//b` is a doubled separator, not a directory with no name.
 */
export function componentsFromSplat(splat: string | undefined): readonly string[] {
	if (splat === undefined || splat === '') {
		return [];
	}
	return splat
		.split('/')
		.filter((component) => component !== '')
		.slice(0, MAX_ARCHIVE_PATH_DEPTH);
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
