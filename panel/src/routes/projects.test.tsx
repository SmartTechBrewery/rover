import { act, render, screen } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * `archive.test.tsx`'s shape: a `Link` is a plain anchor, and `createRoute` is here because this
 * module builds one at import — as does `__root.tsx`, which it hangs off.
 */
vi.mock('@tanstack/react-router', () => ({
	Link: ({
		to,
		children,
		...rest
	}: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
		<a href={to} {...rest}>
			{children}
		</a>
	),
	createRoute: (options: unknown) => ({ options }),
	createRootRoute: (options: unknown) => ({ options }),
	Outlet: () => null,
	useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => string }) =>
		select({ location: { pathname: '/projects' } }),
}));

/**
 * The host, one answer for the one request. Driven through the real `useRegisteredProjects` rather
 * than a stub of it, because half of what this screen does is ask once and never again.
 */
const { host } = vi.hoisted(() => ({
	host: {
		/** Every `call` this screen made, method and params — one entry, or the test has failed. */
		calls: [] as unknown[][],
		/** What the host answers. Whatever a test sets, wrapped as a result envelope by default. */
		answer: { outcome: 'listed', projects: [] } as unknown,
		/** Answer the raw `HostAnswer` instead of wrapping — for a refusal or an error envelope. */
		raw: undefined as unknown,
		/** Accepts the request and never answers it — the state before the first answer. */
		hangs: false,
	},
}));
vi.mock('@panel/session/session-provider.js', () => ({
	useSession: () => ({
		call: async (method: string, params: unknown) => {
			host.calls.push([method, params]);
			if (host.hangs) {
				return await new Promise(() => undefined);
			}
			return host.raw ?? { ok: true, value: { type: 'result', result: host.answer } };
		},
	}),
}));

import { ProjectsScreen } from './projects.js';

function registered(project: string, overrides: Record<string, unknown> = {}) {
	return {
		kind: 'registered',
		project,
		apps: [],
		hasInstall: false,
		services: [],
		hasTeardown: false,
		...overrides,
	};
}

const CHECKOUT_WEB = registered('checkout-web', {
	apps: ['com.example.checkout', 'com.example.checkout.debug'],
	hasInstall: true,
	services: ['mock-payments', 'api'],
	hasTeardown: true,
});
const NOT_READABLE = { kind: 'unreadable', project: 'legacy-kiosk' };
const DECLARES_NOTHING = registered('rover-sandbox');

/**
 * The completion test's own root, and it is the host's own capture: one good registration, one
 * that declares nothing at all, and one whose hook file will not parse — with the broken one **in
 * the middle**, where the host's code-unit order puts it.
 */
const THREE = { outcome: 'listed', projects: [CHECKOUT_WEB, NOT_READABLE, DECLARES_NOTHING] };

async function showing(answer: unknown) {
	host.answer = answer;
	const rendered = render(<ProjectsScreen />);
	await act(async () => undefined);
	return rendered;
}

beforeEach(() => {
	host.calls = [];
	host.raw = undefined;
	host.hangs = false;
});

/**
 * **The acceptance criteria's completion test, verbatim.** Against a projects root holding one good
 * registration, one that declares nothing at all, and one whose hook file will not parse, the
 * screen draws three cards a reader can tell apart.
 */
describe('what is registered on this host', () => {
	it('draws one card per registration, each one identifiable', async () => {
		const { container } = await showing(THREE);

		expect(container.querySelectorAll('article')).toHaveLength(3);
		expect(screen.getByText('checkout-web')).toBeDefined();
		expect(screen.getByText('legacy-kiosk')).toBeDefined();
		expect(screen.getByText('rover-sandbox')).toBeDefined();
	});

	it('carries the identifier, the apps, the services and both hooks for a full registration', async () => {
		await showing(THREE);

		expect(screen.getByText('com.example.checkout')).toBeDefined();
		expect(screen.getByText('com.example.checkout.debug')).toBeDefined();
		expect(screen.getByText('mock-payments')).toBeDefined();
		expect(screen.getByText('api')).toBeDefined();
		expect(screen.getAllByText('declared')).toHaveLength(2);
	});

	it('says where you are and describes the screen', async () => {
		await showing(THREE);

		expect(document.querySelector('nav[aria-label="Breadcrumb"]')?.textContent).toBe('Projects');
		expect(screen.getByText('Projects registered on this host.')).toBeDefined();
	});

	/*
	 * **The card order is the host's own** — code-unit ascending, from `src/daemon/list-projects.ts`
	 * — so a registration that will not parse sorts among the others. The panel does not re-sort,
	 * and `list_projects` takes no parameter, so there is no other ordering to ask for.
	 */
	it('keeps the host’s order, with the broken registration in the middle and not last', async () => {
		const { container } = await showing(THREE);

		const identifiers = Array.from(container.querySelectorAll('article')).map(
			(card) => card.querySelector('div > span:last-child')?.textContent,
		);
		expect(identifiers).toEqual(['checkout-web', 'legacy-kiosk', 'rover-sandbox']);
		expect(identifiers.at(-1)).not.toBe('legacy-kiosk');
	});

	/*
	 * **D6 on the card**, built like `archive.test.tsx`'s *the two states with nothing to browse*:
	 * a project that asks the host to do nothing is the common, correct case, and a registration
	 * the host cannot read must never render as one.
	 */
	it('does not let the two arms of a registration say the same thing', async () => {
		const { container } = await showing(THREE);
		const [, broken, nothing] = Array.from(container.querySelectorAll('article'));

		expect(nothing?.textContent).toContain('none declared');
		expect(nothing?.textContent).not.toContain('Configuration not readable');
		expect(broken?.textContent).toContain('Configuration not readable');
		expect(broken?.textContent).toContain('the file is there and the host cannot read it');
		expect(broken?.textContent).not.toContain('none declared');
	});

	// The five fields are everything the host answers, and `env` values and host paths are
	// structurally absent from the wire (D19) — so a sixth cannot appear without changing it first.
	it('draws exactly the five fields and no sixth', async () => {
		const { container } = await showing(THREE);
		const card = container.querySelector('article');

		expect(card?.querySelector('span')?.textContent).toBe('Project');
		expect(Array.from(card?.querySelectorAll('dt') ?? []).map((dt) => dt.textContent)).toEqual([
			'Apps',
			'Services',
			'Install',
			'Teardown',
		]);
		expect(container.textContent).not.toContain('cwd');
		expect(container.textContent).not.toContain('env');
		expect(container.textContent).not.toContain('npm');
	});
});

describe('the badge', () => {
	// It counts every registration the host answered, an unreadable one included: the file is
	// there, so it is a registration, and leaving it out would disagree with the cards below.
	it('counts every registration, the one that will not parse included', async () => {
		await showing(THREE);

		expect(screen.getByText('3 registered')).toBeDefined();
	});

	// `registered` does not pluralise, so there is no singular branch to get wrong.
	it('reads the same for one registration as for three', async () => {
		await showing({ outcome: 'listed', projects: [DECLARES_NOTHING] });

		expect(screen.getByText('1 registered')).toBeDefined();
	});

	/*
	 * Absent rather than `0 registered`, which would describe a set — `archive.tsx`'s rule and §7's
	 * for the held/free counter.
	 */
	it('goes rather than reading zero', async () => {
		for (const answer of [
			{ outcome: 'listed', projects: [] },
			{ outcome: 'missing' },
			{ outcome: 'unreadable' },
		]) {
			const { container, unmount } = await showing(answer);

			expect(container.textContent).not.toMatch(/\d+ registered/);
			unmount();
		}
	});
});

describe('nothing registered', () => {
	it('says what would change it, with no card and no badge', async () => {
		const { container } = await showing({ outcome: 'listed', projects: [] });

		expect(screen.getByText('No projects registered')).toBeDefined();
		expect(screen.getByText(/in its own directory on this host/)).toBeDefined();
		expect(container.querySelectorAll('article')).toHaveLength(0);
		expect(container.querySelectorAll('button')).toHaveLength(0);
		expect(container.innerHTML).not.toContain('error');
	});

	// §10's deliberate fold: a root that is not there is the ordinary state of a host whose
	// operator has not done a thing yet, and a reader has the same next step either way.
	it('says exactly the same for a root that is not there at all', async () => {
		const { container: empty, unmount } = await showing({ outcome: 'listed', projects: [] });
		const listedText = empty.textContent;
		unmount();

		const { container: missing } = await showing({ outcome: 'missing' });

		expect(missing.textContent).toBe(listedText);
	});

	it("takes §7's quiet panel rather than the banner's surface", async () => {
		const { container } = await showing({ outcome: 'listed', projects: [] });

		expect(container.querySelector('section > div')?.className).toContain(
			'bg-surface-container-lowest',
		);
	});
});

describe('the projects root cannot be read', () => {
	it('says so, and that it is not the same as nothing being registered', async () => {
		const { container } = await showing({ outcome: 'unreadable' });

		expect(screen.getByText('PROJECTS ROOT NOT READABLE')).toBeDefined();
		expect(screen.getByText(/registrations may well be here/)).toBeDefined();
		expect(container.querySelectorAll('article')).toHaveLength(0);
		expect(container.querySelectorAll('button')).toHaveLength(0);
		expect(container.innerHTML).not.toContain('error');
	});

	it("takes the banner's surface rather than the quiet panel's", async () => {
		const { container } = await showing({ outcome: 'unreadable' });

		expect(container.querySelector('section')?.className).toContain('bg-surface-variant');
	});

	/*
	 * The fold `device-list-provider.tsx` and `archive-levels.ts` both make: a daemon that answered
	 * something this panel cannot read has told it as much as one that answered nothing.
	 */
	it('says the same for an answer the panel cannot parse', async () => {
		await showing({ outcome: 'partially listed' });

		expect(screen.getByText('PROJECTS ROOT NOT READABLE')).toBeDefined();
	});

	it('says the same for a request nothing answered', async () => {
		host.raw = { ok: false, refusal: 'unanswered' };
		await showing({ outcome: 'listed', projects: [] });

		expect(screen.getByText('PROJECTS ROOT NOT READABLE')).toBeDefined();
	});
});

/**
 * **D6 at the root**, the pair `stale` draws on the device list and the Archive draws at its own
 * root: *nothing registered* and *the root cannot be read* must never render alike.
 */
describe('the two states with nothing to list', () => {
	it('do not say the same thing', async () => {
		const { unmount } = await showing({ outcome: 'listed', projects: [] });
		const empty = document.body.textContent ?? '';
		unmount();

		await showing({ outcome: 'unreadable' });
		const unreadable = document.body.textContent ?? '';

		expect(empty).toContain('No projects registered');
		expect(empty).not.toContain('PROJECTS ROOT NOT READABLE');
		expect(empty).not.toContain('registrations may well be here');
		expect(unreadable).toContain('PROJECTS ROOT NOT READABLE');
		expect(unreadable).not.toContain('No projects registered');
	});
});

describe('before the host has answered', () => {
	it('says it is reading, in one line and with no spinner', () => {
		host.hangs = true;
		const { container } = render(<ProjectsScreen />);

		expect(screen.getByText('Reading what is registered on this host.')).toBeDefined();
		expect(container.innerHTML).not.toContain('animate');
		expect(container.querySelectorAll('article')).toHaveLength(0);
		// It is not an empty projects root and must not read as one.
		expect(container.textContent).not.toContain('No projects registered');
	});
});

describe('what this screen asks the host, and what it never does', () => {
	/*
	 * One request, and only one — which pins the StrictMode guard, that the params are empty, and
	 * that nothing polls. `list_projects` takes no parameter at all, so there is no filter, no sort
	 * and no page for a control to set.
	 */
	it('asks `list_projects` once, with nothing in it', async () => {
		await showing(THREE);

		expect(host.calls).toEqual([['list_projects', {}]]);
	});

	/*
	 * D31: no `Add`, no `Edit`, no `Delete`, no overflow menu — and not a disabled one either,
	 * which would promise a permission tier that does not exist. The cards are not links.
	 */
	it('writes nothing and navigates nowhere, in every state', async () => {
		for (const answer of [
			THREE,
			{ outcome: 'listed', projects: [] },
			{ outcome: 'missing' },
			{ outcome: 'unreadable' },
		]) {
			const { container, unmount } = await showing(answer);

			expect(container.querySelectorAll('button')).toHaveLength(0);
			expect(container.querySelectorAll('[role="button"]')).toHaveLength(0);
			expect(container.querySelectorAll('input, select, textarea')).toHaveLength(0);
			expect(container.querySelectorAll('[disabled]')).toHaveLength(0);
			// The breadcrumb's one segment is where you are, so it is not a link either (§3).
			expect(container.querySelectorAll('a')).toHaveLength(0);
			unmount();
		}
	});

	// No refresh control and no retry: a registration changes when a person edits a file on the
	// host, and this screen makes no claim to see that happen (§10).
	it('offers no refresh and no retry anywhere', async () => {
		for (const answer of [THREE, { outcome: 'unreadable' }]) {
			const { container, unmount } = await showing(answer);

			expect(container.textContent?.toLowerCase()).not.toContain('refresh');
			expect(container.textContent?.toLowerCase()).not.toContain('retry');
			unmount();
		}
	});

	// The texture is confined to the navigation chrome (§5), which `app-shell.test.tsx` asserts for
	// the whole of `<main>`; the design's markup layers one in the badge and in every card header.
	it('carries no scanline inside the content', async () => {
		const { container } = await showing(THREE);

		expect(container.querySelectorAll('.scanline')).toHaveLength(0);
	});

	it('carries no looping animation in any state', async () => {
		for (const answer of [THREE, { outcome: 'listed', projects: [] }, { outcome: 'unreadable' }]) {
			const { container, unmount } = await showing(answer);

			expect(container.innerHTML).not.toContain('animate');
			unmount();
		}
	});
});
