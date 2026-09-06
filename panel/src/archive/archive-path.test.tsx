import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Link,
	RouterProvider,
	useParams,
} from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
	archiveAddressOf,
	componentsFromSplat,
	keyOf,
	levelsOf,
	MAX_ARCHIVE_PATH_DEPTH,
	splatFromComponents,
} from './archive-path.js';

describe('the components a splat names', () => {
	it('reads an absent or empty splat as the root', () => {
		expect(componentsFromSplat(undefined)).toEqual([]);
		expect(componentsFromSplat('')).toEqual([]);
	});

	it('round-trips a path', () => {
		const components = ['checkout-app', 'login-flow', '20260830T170501Z-issue-112-9f1c2ab4'];

		expect(componentsFromSplat(splatFromComponents(components))).toEqual(components);
	});

	// `a//b` is a doubled separator, not a directory with no name — and the host would refuse the
	// empty component that keeping it would produce.
	it('drops empty segments', () => {
		expect(componentsFromSplat('/checkout-app//login-flow/')).toEqual([
			'checkout-app',
			'login-flow',
		]);
	});

	it('caps the depth where the host does, rather than sending a request to be refused', () => {
		const deep = componentsFromSplat('a/b/c/d/e/f/g/h/i/j/k');

		expect(deep).toHaveLength(MAX_ARCHIVE_PATH_DEPTH);
		expect(deep).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
	});

	/*
	 * **The cap is a bound on the *archive* path, so a view that puts a component in front of it
	 * gets that component back** (#189 review). A groups splat carries the `groupId`, which
	 * `archiveAddressOf` drops *after* this runs — capping at eight regardless would hand the
	 * screen the parent of the row that was clicked at the deepest addresses the tree can build.
	 */
	it('adds the view’s own offset to the cap, so both views reach the same archive depth', () => {
		const nine = 'checkout-app/group-1/login-flow/run-1/R5CT30ABCDE/f/g/h/i';
		const groups = componentsFromSplat(nine, 1);

		expect(groups).toHaveLength(MAX_ARCHIVE_PATH_DEPTH + 1);
		expect(archiveAddressOf(groups)).toEqual(
			componentsFromSplat('checkout-app/login-flow/run-1/R5CT30ABCDE/f/g/h/i'),
		);
	});

	// The default is the `All` view's, where a splat *is* an archive path and there is nothing in
	// front of it — so the bound is unchanged for the caller that does not pass one.
	it('defaults to no offset', () => {
		expect(componentsFromSplat('a/b/c/d/e/f/g/h/i')).toEqual(
			componentsFromSplat('a/b/c/d/e/f/g/h/i', 0),
		);
	});

	// Verbatim, always (D22): nothing here trims, lower-cases or sanitises a name.
	it('keeps a name exactly as it arrived', () => {
		const odd = 'a b%c#d\ne\\f';

		expect(componentsFromSplat(splatFromComponents([odd]))).toEqual([odd]);
	});
});

describe('the cache key', () => {
	// NUL and the separator are the two things the host refuses in a component, so joining on one
	// of them is what makes the key injective. Joining on a hyphen or a newline would not be.
	it('tells one component containing a separator apart from two components', () => {
		expect(keyOf(['a/b'])).not.toBe(keyOf(['a', 'b']));
	});

	// The root is the empty key, which is a level like any other and not a special case.
	it('keys the root', () => {
		expect(keyOf([])).toBe('');
	});
});

describe('the levels a selection needs read', () => {
	// The whole of *lazily, one readdir at a time*: the levels fetched are the prefixes of the
	// selected path and nothing else, so a walk of the archive is unrepresentable.
	it('is the root and every prefix, in order', () => {
		expect(levelsOf(['checkout-app', 'login-flow'])).toEqual([
			[],
			['checkout-app'],
			['checkout-app', 'login-flow'],
		]);
	});

	it('is the root alone at the root', () => {
		expect(levelsOf([])).toEqual([[]]);
	});
});

/*
 * The half of the URL contract this module does not own: TanStack encodes a splat on the way out
 * and decodes it on the way in, and a directory name may legally carry a space, a `%` and a `#`.
 * Asserted against a **real** router rather than the mocked `Link` the screen tests use, because
 * what is in question here is exactly the behaviour a mock would supply.
 */
describe('the round trip through the router', () => {
	function routerFor(initial: string) {
		const rootRoute = createRootRoute();
		const archiveRoute = createRoute({
			getParentRoute: () => rootRoute,
			path: '/archive/$',
			component: () => {
				const params = useParams({ strict: false });
				const components = componentsFromSplat(params._splat);
				return (
					<>
						<span data-testid="components">{JSON.stringify(components)}</span>
						<Link
							params={{ _splat: splatFromComponents([...components, 'child dir']) }}
							to="/archive/$"
						>
							deeper
						</Link>
						{/* What the tree's own open row at the root level goes to (#175). */}
						<Link params={{ _splat: splatFromComponents([]) }} to="/archive/$">
							up
						</Link>
					</>
				);
			},
		});
		return createRouter({
			routeTree: rootRoute.addChildren([archiveRoute]),
			history: createMemoryHistory({ initialEntries: [initial] }),
		});
	}

	it('gives back the components a name with a space, a % and a # went in as', async () => {
		const components = ['checkout-app', 'a b%c#d'];
		const router = routerFor(`/archive/${components.map(encodeURIComponent).join('/')}`);

		render(<RouterProvider router={router as never} />);

		await waitFor(() => {
			expect(screen.getByTestId('components').textContent).toBe(JSON.stringify(components));
		});
	});

	it('encodes a link to a deeper level so the address survives being pasted', async () => {
		const router = routerFor('/archive/checkout-app');

		render(<RouterProvider router={router as never} />);

		const link = await waitFor(() => screen.getByRole('link', { name: 'deeper' }));
		const href = link.getAttribute('href') ?? '';
		expect(href).not.toContain(' ');
		expect(componentsFromSplat(decodeURIComponent(href).replace('/archive/', ''))).toEqual([
			'checkout-app',
			'child dir',
		]);
	});

	/*
	 * **Closing a project goes to the root, and the root is an empty splat** (#175). The tree's open
	 * rows link to the node above them, and at the root level that node is the archive itself — so
	 * the one address this contract had never been asked to build is now built on every screen with
	 * a project open. Asserted against a real router, because whether `/archive/` matches the splat
	 * route and reads back as `[]` is exactly what the mocked `Link` in the screen tests supplies.
	 */
	it('builds the root as an empty splat, and reads it back as the root', async () => {
		const router = routerFor('/archive/checkout-app');

		render(<RouterProvider router={router as never} />);

		const up = await waitFor(() => screen.getByRole('link', { name: 'up' }));
		expect(up.getAttribute('href')).toBe('/archive');
		up.click();

		await waitFor(() => {
			expect(screen.getByTestId('components').textContent).toBe('[]');
		});
	});
});

/**
 * The groups view's own splat, `<project>/<groupId>/<testName>/<run>/<serial>/<…>`, and the one
 * place that knows the archive address underneath it (#181).
 */
describe('the archive address a groups splat names', () => {
	// The group id is not a directory, so it is dropped — and nothing else about the address is
	// touched, which is what keeps every read below a group on the archive's one path vocabulary.
	it('drops the group id and keeps every other component in place', () => {
		expect(
			archiveAddressOf([
				'checkout-app',
				'app-bar-top-space',
				'login-flow',
				'20260830T170501Z-issue-112-9f1c2ab4',
				'R5CT30ABCDE',
				'screenshots',
				'001.png',
			]),
		).toEqual([
			'checkout-app',
			'login-flow',
			'20260830T170501Z-issue-112-9f1c2ab4',
			'R5CT30ABCDE',
			'screenshots',
			'001.png',
		]);
	});

	// A drop by position, never a parse: a group id spelled exactly like a test name is still the
	// component at index 1 and nothing reads either of them (D22).
	it('drops by position, whatever the components say', () => {
		expect(archiveAddressOf(['a', 'a', 'a'])).toEqual(['a', 'a']);
	});

	it('leaves the root and a project alone, which is what nothing below them asks about', () => {
		expect(archiveAddressOf([])).toEqual([]);
		expect(archiveAddressOf(['checkout-app'])).toEqual(['checkout-app']);
	});

	// A group with nothing selected under it names its project's level, which is exactly what the
	// card beside the tree draws its row shapes from.
	it('gives a group’s own address as its project’s', () => {
		expect(archiveAddressOf(['checkout-app', 'app-bar-top-space'])).toEqual(['checkout-app']);
	});
});

/**
 * The groups view's half of the URL contract, against a **real** router for the reason above: what
 * is in question is exactly what a mocked `Link` would supply.
 */
describe('the groups view’s round trip through the router', () => {
	/*
	 * What `routes/archive.tsx` passes as `OFFSET.groups`: the one component this view puts in
	 * front of the archive's own path. Repeated rather than imported, because importing the route
	 * module here would build the panel's whole route tree to read one number.
	 */
	const GROUPS_OFFSET = 1;

	function routerFor(initial: string) {
		const rootRoute = createRootRoute();
		const groupsRoute = createRoute({
			getParentRoute: () => rootRoute,
			path: '/groups/$',
			component: () => {
				const params = useParams({ strict: false });
				const components = componentsFromSplat(params._splat, GROUPS_OFFSET);
				return (
					<>
						<span data-testid="components">{JSON.stringify(components)}</span>
						<span data-testid="address">{JSON.stringify(archiveAddressOf(components))}</span>
						<Link
							params={{ _splat: splatFromComponents([...components, 'a b%c#d']) }}
							to="/groups/$"
						>
							deeper
						</Link>
					</>
				);
			},
		});
		return createRouter({
			routeTree: rootRoute.addChildren([groupsRoute]),
			history: createMemoryHistory({ initialEntries: [initial] }),
		});
	}

	// A shared link lands on the selection, and the group id survives being a component like any
	// other — including one carrying the characters a directory name may legally carry.
	it('gives back a deep group selection, and the archive address under it', async () => {
		const components = ['checkout-app', 'a b%c#d', 'login-flow', 'run-1', 'R5CT30ABCDE'];
		const router = routerFor(`/groups/${components.map(encodeURIComponent).join('/')}`);

		render(<RouterProvider router={router as never} />);

		await waitFor(() => {
			expect(screen.getByTestId('components').textContent).toBe(JSON.stringify(components));
		});
		expect(screen.getByTestId('address').textContent).toBe(
			JSON.stringify(['checkout-app', 'login-flow', 'run-1', 'R5CT30ABCDE']),
		);
	});

	it('encodes a link deeper into the groups view so the address survives being pasted', async () => {
		const router = routerFor('/groups/checkout-app');

		render(<RouterProvider router={router as never} />);

		const link = await waitFor(() => screen.getByRole('link', { name: 'deeper' }));
		const href = link.getAttribute('href') ?? '';
		expect(href).not.toContain(' ');
		expect(componentsFromSplat(decodeURIComponent(href).replace('/groups/', ''))).toEqual([
			'checkout-app',
			'a b%c#d',
		]);
	});

	/*
	 * **The deepest groups address the tree can build survives the trip through the URL** (#189
	 * review). The `All` view reaches eight archive components; the groups view names the same
	 * entry in nine, because the `groupId` sits in front of them. Asserted as a pair, because what
	 * is in question is that the two arrive at the *same* archive address rather than that either
	 * one is a particular length.
	 */
	it('lands on the entry a nine-component groups splat names, not on its parent', async () => {
		const groups = [
			'checkout-app',
			'group-1',
			'login-flow',
			'run-1',
			'R5CT30ABCDE',
			'f',
			'g',
			'h',
			'i',
		];
		const router = routerFor(`/groups/${groups.map(encodeURIComponent).join('/')}`);

		render(<RouterProvider router={router as never} />);

		await waitFor(() => {
			expect(screen.getByTestId('address').textContent).toBe(
				JSON.stringify(componentsFromSplat('checkout-app/login-flow/run-1/R5CT30ABCDE/f/g/h/i')),
			);
		});
	});
});

/**
 * **Which route a bare family address actually matches** (#189 review).
 *
 * `routes/archive.tsx` declares `/archive` and `/groups` alongside their splat routes, and the
 * reason recorded there used to be that a splat route does not match the bare address. It does:
 * the bare routes are declarations that make `/archive` and `/groups` valid `to` values for a
 * `Link`, and the splat route is what renders. Pinned against a real router so the comment and
 * `docs/DESIGN.md` §9 cannot drift back to the other claim on a router upgrade.
 */
describe('the route a bare family address resolves to', () => {
	async function matchedIds(initial: string) {
		const rootRoute = createRootRoute();
		const bare = createRoute({
			getParentRoute: () => rootRoute,
			path: '/groups',
			component: () => null,
		});
		const splat = createRoute({
			getParentRoute: () => rootRoute,
			path: '/groups/$',
			component: () => null,
		});
		const router = createRouter({
			routeTree: rootRoute.addChildren([bare, splat]),
			history: createMemoryHistory({ initialEntries: [initial] }),
		});
		await router.load();
		return router.state.matches.map((match) => match.routeId);
	}

	it('matches the splat route, with an empty splat, and never the bare one', async () => {
		for (const initial of ['/groups', '/groups/']) {
			const ids = await matchedIds(initial);

			expect(ids).toContain('/groups/$');
			expect(ids).not.toContain('/groups');
		}
	});

	// Which is why the bare route changes nothing a reader can see: the splat it hands the screen
	// is the root either way.
	it('reads the empty splat back as the root', () => {
		expect(componentsFromSplat('')).toEqual([]);
	});
});
