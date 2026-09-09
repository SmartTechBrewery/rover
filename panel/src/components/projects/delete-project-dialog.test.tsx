import type { HostAnswer, RpcEnvelope } from '@panel/session/host-client.js';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The two reads the dialog makes, scripted per test. `useSession` is mocked rather than driven
 * through the real `SessionProvider` because what is in question here is what this dialog says
 * about the answers — the credential machinery has its own suite.
 */
const { host } = vi.hoisted(() => ({
	host: {
		/** Every `call` this dialog made, method and params. */
		calls: [] as unknown[][],
		/** `measure_archive`'s answer, wrapped as a result envelope. */
		size: { outcome: 'measured', bytes: 7_723_471, truncated: false } as unknown,
		/** `list_kept_tests`' answer, wrapped the same way. */
		kept: { outcome: 'listed', tests: [] } as unknown,
		/** Accepts both requests and answers neither — the state before the first answer. */
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
			const result = method === 'measure_archive' ? host.size : host.kept;
			return { ok: true, value: { type: 'result', result } };
		},
	}),
}));

import { DeleteProjectDialog } from './delete-project-dialog.js';

/**
 * The asking, in the shape `docs/DESIGN.md` §7 settled for force-releasing and §10 records for
 * this.
 *
 * Most of what is asserted here is recorded in those two sections precisely because a later pass
 * would otherwise "fix" it: that `Cancel` is the prominent control and `Delete project` the
 * recessive one, that the header is `secondary-container` and not red, and that the numbers are
 * numbers rather than a warning adjective.
 */
function asking(
	overrides: {
		readonly project?: string;
		readonly deleting?: boolean;
		readonly unanswered?: boolean;
		readonly onCancel?: () => void;
		readonly onConfirm?: () => void;
	} = {},
) {
	return render(
		<DeleteProjectDialog
			deleting={overrides.deleting ?? false}
			onCancel={overrides.onCancel ?? (() => undefined)}
			onConfirm={overrides.onConfirm ?? (() => undefined)}
			project={overrides.project ?? 'checkout-web'}
			unanswered={overrides.unanswered ?? false}
		/>,
	);
}

/** Rendered, with both reads answered — the state a reader actually looks at. */
async function answered(
	overrides: Parameters<typeof asking>[0] = {},
): Promise<ReturnType<typeof asking>> {
	const rendered = asking(overrides);
	await waitFor(() => expect(host.calls).toHaveLength(2));
	return rendered;
}

/** The value under one of the `<dl>`'s caps labels. */
function valueUnder(label: string): string {
	const dd = screen.getByText(label).nextElementSibling;
	return dd?.textContent ?? '';
}

beforeEach(() => {
	host.calls = [];
	host.size = { outcome: 'measured', bytes: 7_723_471, truncated: false };
	host.kept = { outcome: 'listed', tests: [] };
	host.hangs = false;
});

describe('what the confirmation says', () => {
	it('identifies the project it is about, verbatim and in the monospace face', async () => {
		await answered({ project: 'checkout-web' });

		expect(screen.getByText('Project')).toBeDefined();
		const identifier = screen.getByText('checkout-web');
		expect(identifier.className).toContain('font-code-md');
		expect(identifier.className).toContain('break-words');
		expect(identifier.className).not.toContain('truncate');
	});

	/*
	 * **The numbers are the departure from §7's dialog** (§10): force-releasing needs the operator
	 * to recognise a run, and a delete needs them to know how much goes. Both come off reads the
	 * panel already had.
	 */
	it('says what the archive holds and how many of its tests are kept', async () => {
		host.kept = {
			outcome: 'listed',
			tests: [
				{ project: 'checkout-web', testName: 'the checkout flow' },
				{ project: 'checkout-web', testName: 'the basket' },
				// Another project's kept test, which is not this project's business.
				{ project: 'rover-sandbox', testName: 'the checkout flow' },
			],
		};
		await answered({ project: 'checkout-web' });

		expect(valueUnder('In the archive')).toBe('7.4 MB');
		expect(valueUnder('Kept tests')).toBe('2 tests');
	});

	// The count is filtered on the identifier and the singular is not cosmetic: one kept test is
	// the common case, and `1 tests` makes a reader wonder what else the dialog is guessing at.
	it('counts one kept test as one', async () => {
		host.kept = {
			outcome: 'listed',
			tests: [{ project: 'checkout-web', testName: 'the checkout flow' }],
		};
		await answered({ project: 'checkout-web' });

		expect(valueUnder('Kept tests')).toBe('1 test');
	});

	/*
	 * **`0` draws the row** rather than hiding it, which is the one place this dialog departs from
	 * the badges' absent-rather-than-`0` rule and does so deliberately: *none of its tests are
	 * kept* is the fact that stops the sentence beside it being alarming.
	 */
	it('draws the row for a project none of whose tests are kept', async () => {
		host.kept = {
			outcome: 'listed',
			tests: [{ project: 'rover-sandbox', testName: 'the basket' }],
		};
		await answered({ project: 'checkout-web' });

		expect(screen.getByText('Kept tests')).toBeDefined();
		expect(valueUnder('Kept tests')).toBe('none');
	});

	// And a store the host could not read must not read as `0`: that would claim something about
	// the operator's own decisions that nothing has established.
	it('does not say none for a store the host could not read', async () => {
		host.kept = { outcome: 'unreadable' };
		await answered();

		expect(valueUnder('Kept tests')).toBe('the host cannot say');
	});

	// It is not softened, and §7 says so in as many words.
	it('says in plain words what confirming does', async () => {
		const { container } = await answered();

		expect(container.textContent).toContain('removes the registration and everything the archive');
		expect(container.textContent).toContain('permanently');
		expect(container.textContent).toContain('There is no undo');
		expect(container.textContent).toContain('Keep');
	});

	// No `env` value and no host path may appear on anything (D19) — the answers carry none, so
	// this is a matter of not inventing one.
	it('carries no host path and no environment value', async () => {
		const { container } = await answered();

		expect(container.textContent).not.toContain('/');
		expect(container.textContent).not.toContain('cwd');
		expect(container.textContent).not.toContain('env');
	});
});

/**
 * `measure_archive`'s three answers, which **must not render alike** (D6): a size, *there is
 * nothing at this address* and *the host could not measure it* are three different facts about
 * what this delete would take, and only the middle one is what `0 B` is true of.
 */
describe('what the archive holds', () => {
	it('measures the project’s own archive address and nothing wider', async () => {
		await answered({ project: 'checkout-web' });

		expect(host.calls).toContainEqual(['measure_archive', { path: ['checkout-web'] }]);
	});

	it.each([
		['a size', { outcome: 'measured', bytes: 7_723_471, truncated: false }, '7.4 MB'],
		[
			'a lower bound',
			{ outcome: 'measured', bytes: 7_723_471, truncated: true },
			'at least 7.4 MB',
		],
		['nothing filed', { outcome: 'missing' }, 'nothing is filed here'],
		['a host that cannot say', { outcome: 'unreadable' }, 'the host cannot say'],
	])('renders %s as itself', async (_case, answer, said) => {
		host.size = answer;
		await answered();

		expect(valueUnder('In the archive')).toBe(said);
	});

	// Three readings, three different strings — asserted as a set so no two of them can be made
	// to agree by a later edit to one.
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
			readings.push(valueUnder('In the archive'));
			unmount();
		}

		expect(readings).toEqual(['0 B', 'nothing is filed here', 'the host cannot say']);
		expect(new Set(readings).size).toBe(3);
	});

	// Before either answer arrives: a quiet word, no spinner (§5), and never a figure.
	it('says it is still asking rather than showing a number it does not have', () => {
		host.hangs = true;
		const { container } = asking();

		expect(valueUnder('In the archive')).toBe('measuring…');
		expect(valueUnder('Kept tests')).toBe('reading…');
		expect(container.innerHTML).not.toContain('animate');
		expect(container.textContent).not.toContain('0 B');
	});
});

describe('which control is the prominent one', () => {
	/*
	 * Recorded in §7 so it is not "fixed" later by promoting the destructive action: the safe exit
	 * is the easier target. `Cancel` is filled with the primary colour; `Delete project` is a
	 * border and nothing else.
	 */
	it('fills Cancel and leaves Delete project recessive', async () => {
		await answered();

		const cancel = screen.getByRole('button', { name: 'Cancel' });
		const remove = screen.getByRole('button', { name: 'Delete project' });

		expect(cancel.className).toContain('bg-primary');
		expect(remove.className).not.toContain('bg-primary');
		expect(remove.className).toContain('border-outline');
	});

	/*
	 * §5: a destructive action is the closest thing to an exception to the no-red rule and it still
	 * is not one. The card's own control carries the `error` accent (§10) and this surface carries
	 * none — the header is `secondary-container`, exactly as force-release's is.
	 */
	it('is nowhere red, and the header is secondary-container', async () => {
		const { container } = await answered();

		expect(container.innerHTML).not.toContain('error');
		expect(container.innerHTML).toContain('secondary-container');
	});

	// §5's pending state: a disabled control whose label changed, never a spinner.
	it('disables the control and changes its label while the ask is out', async () => {
		await answered({ deleting: true });

		const remove = screen.getByRole('button', { name: 'Deleting…' });
		expect(remove.getAttribute('disabled')).not.toBeNull();
		expect(screen.queryByRole('button', { name: 'Delete project' })).toBeNull();
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
			'Confirm project deletion',
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

		fireEvent.click(screen.getByRole('button', { name: 'Delete project' }));

		expect(onConfirm).toHaveBeenCalledTimes(1);
	});

	// The backdrop is not a control: a stray click outside a destructive confirmation does nothing.
	it('does not cancel on a click outside the dialog', async () => {
		const onCancel = vi.fn();
		const { container } = await answered({ onCancel });

		fireEvent.click(container.firstElementChild as HTMLElement);

		expect(onCancel).not.toHaveBeenCalled();
	});
});

/**
 * The fifth answer, which is not an outcome (§7's fourth case). Nothing was deleted, so the dialog
 * is still here, the control is usable again, and the line says exactly that — it does not claim a
 * removal, and it carries no colour of alarm, because nothing is wrong with the project.
 */
describe('the ask that reached nothing', () => {
	it('says nothing was deleted, in the dialog, with no colour of alarm', async () => {
		await answered({ unanswered: true });

		const said = screen.getByText(/nothing was deleted/i);
		expect(said.getAttribute('aria-live')).toBe('polite');
		expect(said.className).not.toContain('error');
		expect(said.textContent).toContain('still registered');
		expect(
			screen.getByRole('button', { name: 'Delete project' }).getAttribute('disabled'),
		).toBeNull();
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
 * **No host read was added for this dialog** (§10): both numbers come off methods already on
 * `PANEL_METHODS` for other screens, and each is asked exactly once.
 */
describe('what the dialog asks the host', () => {
	it('asks the two reads it needs and nothing else', async () => {
		await answered({ project: 'checkout-web' });

		expect(host.calls).toEqual([
			['measure_archive', { path: ['checkout-web'] }],
			['list_kept_tests', {}],
		]);
	});

	// Nothing is deleted by opening the question: the write happens on `onConfirm` and nowhere else.
	it('deletes nothing by being open', async () => {
		await answered();

		expect(host.calls.map(([method]) => method)).not.toContain('delete_project');
	});
});
