import type { ArchiveSearchMatch } from './archive-listing.js';

/**
 * The matched tree, built from one `search_archive` answer and nothing else (#146).
 *
 * **Pure — no React, no session, no request.** The whole tree the tree card draws for a search is
 * derivable from the one answer, which is why the answer carries whole component arrays: a searched
 * tree re-derived with a `list_archive` call per level would be the walk R38 exists to replace,
 * paid for a second time in the browser.
 *
 * **Every hit is visible and its ancestors are expanded**, because a node exists here exactly when
 * a match's path runs through it. That is also the whole of *a branch that holds no match is not
 * drawn*: an unmatched sibling was never on a path, so there is nothing to filter out.
 *
 * **A node with children is a `directory` by construction** — it is an ancestor of a match, so
 * something is filed under it. A leaf takes its own match's `kind`, which is what the host answered
 * and never what its name looks like (D22). An ancestor that is *also* a match appears once, as one
 * node: the path is the identity, so the second mention lands on the node the first one made.
 *
 * **The order is the host's and nothing here re-sorts.** `search_archive` answers breadth-first,
 * ascending by name in code-unit order within a level, and children come out in the order their
 * matches arrived — the same rule `level-order.ts` states from the browsing side, where the one
 * deliberate re-ordering (runs, most recent first) belongs to a *level* the host listed. A search
 * answers a set of addresses rather than a level, so there is no level here to reverse.
 */
export interface HitNode {
	/** The last component of the address — verbatim, as every name on this screen is. */
	readonly name: string;
	/** Its whole address, which is what a row links to. */
	readonly path: readonly string[];
	readonly kind: ArchiveSearchMatch['kind'];
	readonly children: readonly HitNode[];
}

/** Mutable while the tree is being built; `HitNode` is what leaves. */
interface Building {
	readonly name: string;
	readonly path: readonly string[];
	kind: ArchiveSearchMatch['kind'];
	/** Keyed on the child's name, so one component reached twice is one node. */
	readonly children: Map<string, Building>;
}

export function hitTree(matches: readonly ArchiveSearchMatch[]): readonly HitNode[] {
	const roots = new Map<string, Building>();

	for (const match of matches) {
		let level = roots;
		const walked: string[] = [];
		for (const name of match.path) {
			walked.push(name);
			const existing = level.get(name);
			/*
			 * An ancestor is a `directory` because something is filed under it, and only the last
			 * component of a match takes the kind the host answered. A node already made as an
			 * ancestor therefore keeps `directory` when its own match arrives later, which is the
			 * same answer: `search_archive` gave that address `directory` too.
			 */
			const node = existing ?? {
				name,
				path: [...walked],
				kind: 'directory' as const,
				children: new Map(),
			};
			if (existing === undefined) {
				level.set(name, node);
			}
			if (walked.length === match.path.length) {
				node.kind = match.kind;
			}
			level = node.children;
		}
	}

	return finish(roots);
}

/**
 * The built nodes as `HitNode`s, deepest last — and **a node with children is a `directory`
 * whatever its own match said**, which is the one place that rule is enforced rather than assumed.
 *
 * It matters for a real answer: the match cap is reached at the deepest, least specific hits (R38's
 * breadth-first walk), so a directory match whose children are the answer's later hits is ordinary
 * rather than a corner case.
 */
function finish(level: Map<string, Building>): readonly HitNode[] {
	return [...level.values()].map((node) => {
		const children = finish(node.children);
		return {
			name: node.name,
			path: node.path,
			kind: children.length > 0 ? ('directory' as const) : node.kind,
			children,
		};
	});
}
