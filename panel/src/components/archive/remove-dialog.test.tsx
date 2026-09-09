import type { TestRemoval } from '@panel/archive/delete-archived-test.js';
import type { HostAnswer, RpcEnvelope } from '@panel/session/host-client.js';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The one read the dialog makes, scripted per test. `useSession` is mocked rather than driven
 * through the real `SessionProvider` because what is in question here is what this dialog says
 * about the answer — the credential machinery has its own suite.
 */
const { host } = vi.hoisted(() => ({
	host: {
		/** Every `call` this dialog made, method and params. */
		calls: [] as unknown[][],
		/** `measure_archive`'s answer, wrapped as a result envelope. */
		size: { outcome: 'measured', bytes: 4_180_532, truncated: false } as unknown,
		/** Accepts the request and never answers it — the state before the first answer. */
		hangs: false,
	},
}));
vi.mock('@panel/session/session-provider.js', () => ({
	useSession: () => ({
		call: async (method: string, params: unknown): Promise<HostAnswer<RpcEnvelope>> => {
			host.calls.push([method, params]);
			if (host.hangs) {
				return await new Promise(() => undefined);
			}
			return { ok: true, value: { type: 'result', result: host.size } };
		},
	}),
}));

import { RemoveTestDialog } from './remove-dialog.js';

/**
 * The asking, in the shape `docs/DESIGN.md` §7 settled for force-releasing, §10 built again for a
 * registration, and §9 records for an archived test.
 *
 * Most of what is asserted here is recorded in those sections precisely because a later pass would
 * otherwise "fix" it: that `Cancel` is the prominent control and `Remove test` the recessive one,
 * that the header is `secondary-container` and not red, and that the figures are figures rather
 * than a warning adjective. **They are asserted here as well as in
 * `delete-project-dialog.test.tsx`** and that is deliberate: one frame serves both dialogs
 * (`confirm-destructive-dialog.tsx`), and a suite per caller is what would catch a frame changed
 * to suit one of them.
 */
const TEST: TestRemoval = {
	project: 'checkout-web',
	testName: 'login-flow',
	runs: 42,
	kept: false,
	card: 'test',
};

function asking(
	overrides: {
		readonly removal?: Partial<TestRemoval>;
		readonly removing?: boolean;
		readonly unanswered?: boolean;
		readonly onCancel?: () => void;
		readonly onConfirm?: () => void;
	} = {},
) {
	return render(
		<RemoveTestDialog
			onCancel={overrides.onCancel ?? (() => undefined)}
			onConfirm={overrides.onConfirm ?? (() => undefined)}
			removal={{ ...TEST, ...overrides.removal }}
			removing={overrides.removing ?? false}
			unanswered={overrides.unanswered ?? false}
		/>,
	);
}

/** Rendered, with the one read answered — the state a reader actually looks at. */
async function answered(
	overrides: Parameters<typeof asking>[0] = {},
): Promise<ReturnType<typeof asking>> {
	const rendered = asking(overrides);
	await waitFor(() => expect(host.calls).toHaveLength(1));
	return rendered;
}

/** The value under one of the `<dl>`'s caps labels. */
function valueUnder(label: string): string {
	const dd = screen.getByText(label).nextElementSibling;
	return dd?.textContent ?? '';
}

beforeEach(() => {
	host.calls = [];
	host.size = { outcome: 'measured', bytes: 4_180_532, truncated: false };
	host.hangs = false;
});

describe('what the confirmation says', () => {
	it('names the two components it is about, verbatim and in the monospace face', async () => {
		await answered();

		expect(screen.getByText('PROJECT')).toBeDefined();
		expect(valueUnder('PROJECT')).toBe('checkout-web');
		const name = screen.getByText('login-flow');
		expect(name.className).toContain('font-code-md');
		expect(name.className).toContain('break-words');
		expect(name.className).not.toContain('truncate');
	});

	/*
	 * **The numbers are §10's departure from §7's dialog**, one level down: force-releasing needs
	 * the operator to recognise a run, and a delete needs them to know how much goes. Two of the
	 * three come off the screen and cost no request.
	 */
	it('says how many runs go, what they take on disk, and whether it is kept', async () => {
		await answered({ removal: { runs: 42, kept: true } });

		expect(valueUnder('RUNS')).toBe('42 runs');
		expect(valueUnder('ON DISK')).toBe('4.0 MB');
		expect(valueUnder('KEPT')).toBe('yes');
	});

	// The singular is not cosmetic: a test with one run is ordinary, and `1 runs` is the kind of
	// thing that makes a reader wonder what else the dialog is guessing at.
	it('counts one run as one', async () => {
		await answered({ removal: { runs: 1 } });

		expect(valueUnder('RUNS')).toBe('1 run');
	});

	/*
	 * **`null` is *the host cannot say* and never `0`** — the distinction `childCount: null` carries
	 * one level up, and the one this field must not flatten: *no runs* and *nobody has counted* are
	 * two different things to be told before confirming a permanent delete.
	 */
	it('never renders an unknown run count as none', async () => {
		await answered({ removal: { runs: null } });

		expect(valueUnder('RUNS')).toBe('the host cannot say');
		expect(valueUnder('RUNS')).not.toContain('0');
	});

	// And `0` draws the row rather than hiding it, exactly as the Projects dialog's kept count does:
	// it is a question the reader is about to act on, not a badge describing a set that is there.
	it('says none for a test with no runs filed under it', async () => {
		await answered({ removal: { runs: 0 } });

		expect(valueUnder('RUNS')).toBe('none');
	});

	/*
	 * **`no` is not the answer for a set the panel could not read** (`pinned-tests.ts`): the kept
	 * set is the host's, and *no* here would be a claim about the operator's own decision that
	 * nothing has established — the same reason no tick is drawn then.
	 */
	it('keeps a test that is not kept apart from a kept set nobody has answered', async () => {
		const { unmount } = await answered({ removal: { kept: false } });
		expect(valueUnder('KEPT')).toBe('no');
		unmount();

		host.calls = [];
		await answered({ removal: { kept: null } });

		expect(valueUnder('KEPT')).toBe('the host cannot say');
	});

	// It is not softened, and §7 says so in as many words.
	it('says in plain words what confirming does', async () => {
		const { container } = await answered();

		expect(container.textContent).toContain('removes every run of this test and everything filed');
		expect(container.textContent).toContain('permanently');
		expect(container.textContent).toContain('There is no undo');
		expect(container.textContent).toContain('Keep');
	});

	/*
	 * **Opened from a run's card it says the run on screen goes with the rest** (D43), and from a
	 * test name's card it does not — there is no run on screen there, and a clause about one would
	 * be about nothing.
	 */
	it('says the run on screen is one of them, from a run’s card only', async () => {
		const { container, unmount } = await answered({ removal: { card: 'run' } });
		expect(container.textContent).toContain('The run you are looking at is one of them.');
		unmount();

		host.calls = [];
		const fromTheTest = await answered({ removal: { card: 'test' } });

		expect(fromTheTest.container.textContent).not.toContain('The run you are looking at');
	});

	// No host path and no `errno` may appear on anything (D19) — both components are path segments
	// the host answered with, and the host composes every path from its own roots.
	it('carries no host path', async () => {
		const { container } = await answered();

		expect(container.textContent).not.toContain('/');
		expect(container.textContent).not.toContain('errno');
	});
});

/**
 * `measure_archive`'s four readings, which **must not render alike** (D6): a size, a lower bound,
 * *there is nothing at this address* and *the host could not measure it* are four different facts
 * about what this delete would take, and only the third is what `0 B` is a true claim about.
 */
describe('what the test takes on disk', () => {
	it('measures the test’s own two components and nothing wider', async () => {
		await answered();

		expect(host.calls).toEqual([['measure_archive', { path: ['checkout-web', 'login-flow'] }]]);
	});

	it.each([
		['a size', { outcome: 'measured', bytes: 4_180_532, truncated: false }, '4.0 MB'],
		[
			'a lower bound',
			{ outcome: 'measured', bytes: 4_180_532, truncated: true },
			'at least 4.0 MB',
		],
		['nothing filed', { outcome: 'missing' }, 'nothing is filed here'],
		['a host that cannot say', { outcome: 'unreadable' }, 'the host cannot say'],
	])('renders %s as itself', async (_case, answer, said) => {
		host.size = answer;
		await answered();

		expect(valueUnder('ON DISK')).toBe(said);
	});

	// Three readings, three different strings — asserted as a set so no two of them can be made to
	// agree by a later edit to one.
	it('says three different things for the three answers', async () => {
		const readings: string[] = [];
		for (const answer of [
			{ outcome: 'measured', bytes: 0, truncated: false },
			{ outcome: 'missing' },
			{ outcome: 'unreadable' },
		]) {
			host.calls = [];
			host.size = answer;
			const { unmount } = await answered();
			readings.push(valueUnder('ON DISK'));
			unmount();
		}

		expect(readings).toEqual(['0 B', 'nothing is filed here', 'the host cannot say']);
		expect(new Set(readings).size).toBe(3);
	});

	// Before the answer arrives: a quiet word, no spinner (§5), and never a figure.
	it('says it is still measuring rather than showing a number it does not have', () => {
		host.hangs = true;
		const { container } = asking();

		expect(valueUnder('ON DISK')).toBe('measuring…');
		expect(container.innerHTML).not.toContain('animate');
		expect(container.textContent).not.toContain('0 B');
	});
});

describe('which control is the prominent one', () => {
	/*
	 * Recorded in §7 so it is not "fixed" later by promoting the destructive action: the safe exit
	 * is the easier target. `Cancel` is filled with the primary colour; `Remove test` is a border
	 * and nothing else.
	 */
	it('fills Cancel and leaves Remove test recessive', async () => {
		await answered();

		const cancel = screen.getByRole('button', { name: 'Cancel' });
		const remove = screen.getByRole('button', { name: 'Remove test' });

		expect(cancel.className).toContain('bg-primary');
		expect(remove.className).not.toContain('bg-primary');
		expect(remove.className).toContain('border-outline');
	});

	/*
	 * §5: a destructive action is the closest thing to an exception to the no-red rule and it still
	 * is not one. The card's own control carries the `error` accent (§9, §10) and this surface
	 * carries none — the header is `secondary-container`, exactly as the other two dialogs' are.
	 */
	it('is nowhere red, and the header is secondary-container', async () => {
		const { container } = await answered();

		expect(container.innerHTML).not.toContain('error');
		expect(container.innerHTML).toContain('secondary-container');
	});

	// §5's pending state: a disabled control whose label changed, never a spinner.
	it('disables the control and changes its label while the ask is out', async () => {
		await answered({ removing: true });

		const remove = screen.getByRole('button', { name: 'Removing…' });
		expect(remove.getAttribute('disabled')).not.toBeNull();
		expect(screen.queryByRole('button', { name: 'Remove test' })).toBeNull();
		// Cancel stays usable: the operator can always leave.
		expect(screen.getByRole('button', { name: 'Cancel' }).getAttribute('disabled')).toBeNull();
	});
});

describe('the ways out', () => {
	it('is a labelled modal dialog', async () => {
		await answered();

		const dialog = screen.getByRole('dialog');
		expect(dialog.getAttribute('aria-modal')).toBe('true');
		expect(document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')?.textContent).toBe(
			'Confirm test deletion',
		);
	});

	// Focus lands on the safe exit rather than on the destructive control — the same choice the
	// filled/recessive pair makes with a mouse, made again for a keyboard.
	it('moves focus onto Cancel when it opens', async () => {
		await answered();

		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
	});

	it.each([
		['Cancel', () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))],
		['the header’s close control', () => fireEvent.click(screen.getByLabelText('Close'))],
		['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })],
	])('cancels on %s, and deletes nothing', async (_way, leave) => {
		const onCancel = vi.fn();
		const onConfirm = vi.fn();
		await answered({ onCancel, onConfirm });

		leave();

		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it('confirms only when the recessive control is pressed', async () => {
		const onConfirm = vi.fn();
		await answered({ onConfirm });

		fireEvent.click(screen.getByRole('button', { name: 'Remove test' }));

		expect(onConfirm).toHaveBeenCalledTimes(1);
	});

	// The backdrop is not a control: a stray click outside a destructive confirmation does nothing.
	it('does not cancel on a click outside the dialog', async () => {
		const onCancel = vi.fn();
		const { container } = await answered({ onCancel });

		fireEvent.click(container.firstElementChild as HTMLElement);

		expect(onCancel).not.toHaveBeenCalled();
	});

	/*
	 * **No focus trap**, which is §7's recorded choice rather than an omission: `aria-modal` tells
	 * assistive technology this is modal, and tabbing past it reaches a panel that genuinely still
	 * works. Asserted as the absence of the thing a trap needs — nothing here listens for `Tab`.
	 */
	it('traps nothing, and nothing outside it is hidden', async () => {
		const { container } = await answered();

		expect(container.querySelectorAll('[tabindex]')).toHaveLength(0);
		expect(document.body.getAttribute('aria-hidden')).toBeNull();
	});
});

/**
 * The fifth answer, which is not an outcome (§7's fourth case). Nothing was deleted, so the dialog
 * is still here, the control is usable again, and the line says exactly that — it does not claim a
 * removal, and it carries no colour of alarm, because nothing is wrong with the test, which is
 * exactly still filed.
 */
describe('the ask that reached nothing', () => {
	it('says nothing was deleted, in the dialog, with no colour of alarm', async () => {
		await answered({ unanswered: true });

		const said = screen.getByText(/nothing was deleted/i);
		expect(said.getAttribute('aria-live')).toBe('polite');
		expect(said.className).not.toContain('error');
		expect(said.textContent).toContain('still filed');
		expect(screen.getByRole('button', { name: 'Remove test' }).getAttribute('disabled')).toBeNull();
	});

	// The region exists before its text does, or it is announced unreliably.
	it('keeps the live region present when there is nothing to say', async () => {
		const { container } = await answered();

		const regions = container.querySelectorAll('[aria-live="polite"]');
		expect(regions).toHaveLength(1);
		expect(regions[0]?.textContent).toBe('');
	});
});

/**
 * **One host read, made when the question opens** (§9, §10's rule). The other two figures are the
 * screen's own, so a card full of rows asks the host nothing extra until somebody presses a
 * control — which is what keeps *one request on navigation* true of this screen.
 */
describe('what the dialog asks the host', () => {
	it('asks the one read it needs and nothing else', async () => {
		await answered();

		expect(host.calls.map(([method]) => method)).toEqual(['measure_archive']);
	});

	// Nothing is deleted by opening the question: the write happens on `onConfirm` and nowhere else.
	it('deletes nothing by being open', async () => {
		await answered();

		expect(host.calls.map(([method]) => method)).not.toContain('delete_archived_test');
	});

	// The run count and the `Keep` mark come in as props, so neither is a second request — §10's
	// *no host read was added for this dialog*, kept one level down.
	it('asks nothing for the run count or the Keep mark', async () => {
		await answered({ removal: { runs: 42, kept: true } });

		const methods = host.calls.map(([method]) => method);
		expect(methods).not.toContain('list_archive');
		expect(methods).not.toContain('list_kept_tests');
	});
});
