import { act, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/panel/test-description.json';

/**
 * The host, scripted per file — `device-info.test.tsx`'s shape, because this is the same read of a
 * second file. `useSession` is mocked rather than driven through the real `SessionProvider` because
 * what is in question here is only what this hook asks for and how it folds the answer.
 */
const { host } = vi.hoisted(() => ({ host: { readArtifactText: vi.fn() } }));
vi.mock('@panel/session/session-provider.js', () => ({
	useSession: () => ({ readArtifactText: host.readArtifactText }),
}));

import {
	type ArchivedTestDescription,
	TestDescriptionFileSchema,
	useArchivedTestDescription,
} from './test-description.js';

/** The archive's own file, as the daemon writes it. */
const FILED = TestDescriptionFileSchema.parse(fixture.files[0]);

describe("the panel's mirror of test_description.json", () => {
	it('reads the one field the file carries, under the wire own name', () => {
		expect(FILED.testDescription).toContain('login form');
	});

	// Not `.strict()`, for `device-info.ts`'s reason: a newer daemon adding a key must not turn a
	// readable file into an unreadable one.
	it('ignores a key a newer daemon adds rather than rejecting the file', () => {
		const parsed = TestDescriptionFileSchema.safeParse({ ...FILED, filedAt: 'whenever' });

		expect(parsed.success).toBe(true);
		expect(parsed.success && 'filedAt' in parsed.data).toBe(false);
	});
});

/** The run's `<serial>` level, as a listing answered it. */
const LEVEL = [
	'checkout-app',
	'login-flow',
	'20260830T170501Z-issue-112-9f1c2ab4',
	'emulator-5554',
] as const;

function read(text: unknown) {
	return { ok: true as const, value: { outcome: 'read' as const, text: JSON.stringify(text) } };
}

/** Renders the hook's state as text, so one line is one assertion. */
function Card({ level }: { readonly level: readonly string[] | null }) {
	return <span data-testid="state">{textFor(useArchivedTestDescription(level))}</span>;
}

function textFor(state: ArchivedTestDescription): string {
	return state.status === 'read' ? `read:${state.description}` : state.status;
}

async function showing(level: readonly string[] | null = LEVEL) {
	const rendered = render(<Card level={level} />);
	// The answer settles a microtask turn after the effect fires.
	await act(async () => undefined);
	return rendered;
}

function state(): string {
	return screen.getByTestId('state').textContent ?? '';
}

describe("reading one run's test_description.json", () => {
	beforeEach(() => {
		host.readArtifactText.mockResolvedValue(read(fixture.files[0]));
	});

	// The address is the level a listing answered plus the archive's own file name — never a path
	// this browser composed, and never anything resembling a host filesystem path (D19).
	it('asks for the file inside the level it was given', async () => {
		await showing();

		expect(host.readArtifactText).toHaveBeenCalledWith([...LEVEL, 'test_description.json']);
		await waitFor(() => expect(state()).toBe(`read:${FILED.testDescription}`));
	});

	// React 19's StrictMode runs an effect twice on mount — the guard is a ref for that reason
	// (`archived-file.ts`), and this is the assertion that proves it for this file too.
	it('asks once under StrictMode, not twice', async () => {
		render(
			<StrictMode>
				<Card level={LEVEL} />
			</StrictMode>,
		);

		await waitFor(() => expect(host.readArtifactText).toHaveBeenCalledTimes(1));
	});

	// There is no address until the level above answers, so nothing is asked and nothing comes back.
	it('asks for nothing at all when there is no level to read it in', async () => {
		await showing(null);

		expect(host.readArtifactText).not.toHaveBeenCalled();
		expect(state()).toBe('reading');
	});
});

/**
 * **The pair that must never be folded together.** *No description was written for this run* and
 * *the host will not read the file* are different answers, and the field says them in words that
 * share no phrase — the same distinction the archive's empty and unreadable levels draw one
 * directory up (D6).
 */
describe('what the host answered about the file', () => {
	it('says a file that is not there is missing — the ordinary case', async () => {
		host.readArtifactText.mockResolvedValue({ ok: true, value: { outcome: 'missing' } });

		await showing();

		await waitFor(() => expect(state()).toBe('missing'));
	});

	it('says a file the host will not serve cannot be read', async () => {
		host.readArtifactText.mockResolvedValue({ ok: true, value: { outcome: 'unreadable' } });

		await showing();

		await waitFor(() => expect(state()).toBe('unreadable'));
	});

	it('folds a body that is not JSON into cannot-be-read', async () => {
		host.readArtifactText.mockResolvedValue({
			ok: true,
			value: { outcome: 'read', text: 'not json at all' },
		});

		await showing();

		await waitFor(() => expect(state()).toBe('unreadable'));
	});

	it('folds a request nothing answered into cannot-be-read', async () => {
		host.readArtifactText.mockResolvedValue({ ok: false, refusal: 'unanswered' });

		await showing();

		await waitFor(() => expect(state()).toBe('unreadable'));
	});

	/*
	 * A `refused` sets nothing: `Session.readArtifactText` has already fired `onRefusal` and the
	 * router is coming down, so *not readable* would be the panel's last word being the wrong one.
	 */
	it('says nothing new when the host refused the session', async () => {
		host.readArtifactText.mockResolvedValue({ ok: false, refusal: 'refused' });

		await showing();

		expect(state()).toBe('reading');
	});

	/*
	 * **The one fold that is not `device_info.json`'s**, and the reason is in `test-description.ts`:
	 * this field's states are about the *description*, not about the file. A body the host read
	 * happily and that says nothing about the run is *none filed* — calling it *not readable* would
	 * claim the host failed at something it did.
	 */
	it('reads a readable file with no description in it as none filed', async () => {
		host.readArtifactText.mockResolvedValue(read({ filedAt: 'whenever' }));

		await showing();

		await waitFor(() => expect(state()).toBe('missing'));
	});

	it('reads a blank description as none filed, for the reason the wire refuses one', async () => {
		host.readArtifactText.mockResolvedValue(read({ testDescription: '   ' }));

		await showing();

		await waitFor(() => expect(state()).toBe('missing'));
	});

	// A `null` where a string was expected is the same answer as no key at all, not a failure.
	it('reads a null description as none filed', async () => {
		host.readArtifactText.mockResolvedValue(read({ testDescription: null }));

		await showing();

		await waitFor(() => expect(state()).toBe('missing'));
	});
});
