import { describe, expect, it } from 'vitest';
import type { ArchiveSearchMatch } from './archive-listing.js';
import { hitTree } from './search-tree.js';

function match(path: readonly string[], kind: ArchiveSearchMatch['kind']): ArchiveSearchMatch {
	return { path: [...path], kind };
}

const RUN = '20260830T170501Z-issue-112-9f1c2ab4';

/** One node as `name(kind)`, with its children in brackets — the whole tree as one string. */
function describeTree(nodes: readonly { name: string; kind: string; children: unknown }[]): string {
	return nodes
		.map((node) => {
			const children = node.children as typeof nodes;
			return children.length === 0
				? `${node.name}(${node.kind})`
				: `${node.name}(${node.kind})[${describeTree(children)}]`;
		})
		.join(',');
}

describe('the tree one search answer makes', () => {
	it('draws a deep match with its whole ancestor chain and nothing else', () => {
		const tree = hitTree([
			match(['checkout-app', 'login-flow', RUN, 'R5CT30ABCDE', 'login-screen.png'], 'file'),
		]);

		expect(describeTree(tree)).toBe(
			`checkout-app(directory)[login-flow(directory)[${RUN}(directory)[R5CT30ABCDE(directory)[login-screen.png(file)]]]]`,
		);
	});

	// The ancestor is one node, not one per match: the address is the identity.
	it('shares one ancestor node between two matches under it', () => {
		const tree = hitTree([
			match(['checkout-app', 'login-flow'], 'directory'),
			match(['checkout-app', 'cart-abandonment'], 'directory'),
		]);

		expect(describeTree(tree)).toBe(
			'checkout-app(directory)[login-flow(directory),cart-abandonment(directory)]',
		);
	});

	// The whole of *a branch that holds no match is not drawn*: it was never on a path.
	it('leaves out a sibling with no match under it', () => {
		const tree = hitTree([match(['checkout-app', 'login-flow'], 'directory')]);

		expect(describeTree(tree)).not.toContain('payments-web');
		expect(tree).toHaveLength(1);
	});

	// The case R38's breadth-first walk makes ordinary: a directory match whose own children are
	// later hits in the same answer.
	it('draws a directory that is also an ancestor of another match once', () => {
		const tree = hitTree([
			match(['checkout-app', 'login-flow'], 'directory'),
			match(['checkout-app', 'login-flow', RUN, 'R5CT30ABCDE', 'login-error.png'], 'file'),
		]);

		expect(tree).toHaveLength(1);
		expect(tree[0]?.children).toHaveLength(1);
		expect(describeTree(tree)).toBe(
			`checkout-app(directory)[login-flow(directory)[${RUN}(directory)[R5CT30ABCDE(directory)[login-error.png(file)]]]]`,
		);
	});

	it("takes a leaf's kind from its own match and an ancestor's is always a directory", () => {
		const tree = hitTree([
			match(['checkout-app', 'login-flow', RUN, 'R5CT30ABCDE', 'latest_recording'], 'other'),
			match(['payments-web', 'device_info.json'], 'file'),
		]);

		expect(describeTree(tree)).toBe(
			`checkout-app(directory)[login-flow(directory)[${RUN}(directory)[R5CT30ABCDE(directory)[latest_recording(other)]]]],payments-web(directory)[device_info.json(file)]`,
		);
	});

	/*
	 * A directory match with nothing under it in the answer stays a `directory` — the kind is the
	 * host's answer about the address, not an inference from whether the search found anything
	 * inside it.
	 */
	it('keeps a childless directory match a directory', () => {
		const tree = hitTree([match(['checkout-app', 'sealed-test'], 'directory')]);

		expect(describeTree(tree)).toBe('checkout-app(directory)[sealed-test(directory)]');
	});

	// The order is the host's — breadth-first, code-unit ascending per level — and this module does
	// not re-sort. `level-order.ts`'s one deliberate reversal is about a *level* the host listed.
	it('keeps the order the matches arrived in', () => {
		const tree = hitTree([
			match(['payments-web'], 'directory'),
			match(['checkout-app'], 'directory'),
			match(['payments-web', 'zebra'], 'directory'),
			match(['payments-web', 'alpha'], 'directory'),
		]);

		expect(describeTree(tree)).toBe(
			'payments-web(directory)[zebra(directory),alpha(directory)],checkout-app(directory)',
		);
	});

	it('answers nothing at all for no matches', () => {
		expect(hitTree([])).toEqual([]);
	});

	// Every node carries its own whole address, because that is what a row links to.
	it('carries each node its own address', () => {
		const tree = hitTree([match(['checkout-app', 'login-flow', RUN], 'directory')]);

		expect(tree[0]?.path).toEqual(['checkout-app']);
		expect(tree[0]?.children[0]?.path).toEqual(['checkout-app', 'login-flow']);
		expect(tree[0]?.children[0]?.children[0]?.path).toEqual(['checkout-app', 'login-flow', RUN]);
	});
});
