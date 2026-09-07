/**
 * The Archive screen's URL contract — the one place a path is turned into components and back.
 *
 * **Where you are is its URL, and this screen has two deliberate exceptions to that**
 * (`docs/DESIGN.md` §9, #146, #198). A reload lands where you were and a link is shareable, because
 * *where you are* is the address and nothing else carries it. The two things that are not in it are
 * the tree card's **search text** (`archive-search.ts`) and **which branches of the tree are open**
 * (`open-branches.ts`) — amended in place, because expansion used to be *derived* from the selected
 * path and is not any more (#198): it is an open set laid over the selection's own ancestors as a
 * floor. Both are component state on the same terms: a shared link lands on the address without
 * somebody else's search and without somebody else's browsing, each is seeded from that address, and
 * neither can make the tree and the address disagree about *where you are* — what an open set adds is
 * what else is on screen beside it. Selecting a hit, and clicking a row, are navigations to one of
 * these paths like any other.
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
 * **This is the *address's* half of what the screen reads** (amended in place, #198). It used to be
 * the whole of *lazily, one `readdir` at a time*; the other half is now `drawnLevels`
 * (`tree-source.ts`), a walk of the tree the reader has actually opened. What both halves share is
 * the rule that did not change — every level asked for is a level being **drawn**, so a pre-walk of
 * the archive stays unrepresentable — and what this half still buys is that a deep link is one
 * parallel batch of requests rather than one round trip per level. Every prefix it names is an
 * ancestor the floor draws anyway (`open-branches.ts`), so it is not a second source of truth.
 *
 * It is also what {@link openedBy} seeds the open set from, and — dropping the last one — what
 * `absorbing` writes into it as the selection moves.
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
