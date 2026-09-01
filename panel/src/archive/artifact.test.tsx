import { act, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The host, scripted per artifact — `device-info.test.tsx`'s shape, and `useSession` is mocked for
 * its reason: what is in question here is what this hook asks for, how it folds the answer, and
 * **what it does with the object URL it creates**. The credential machinery has its own suite.
 */
const { host } = vi.hoisted(() => ({ host: { readArtifactBytes: vi.fn() } }));
vi.mock('@panel/session/session-provider.js', () => ({
	useSession: () => ({ readArtifactBytes: host.readArtifactBytes }),
}));

import { type ArchivedArtifactState, useArchivedArtifact } from './artifact.js';

const SCREENSHOT = ['checkout-app', 'login-flow', 'a-run', 'R5CT30ABCDE', '001_screenshot.png'];
const RECORDING = ['checkout-app', 'login-flow', 'a-run', 'R5CT30ABCDE', '001.mp4'];

function read(mediaType: string, body: string) {
	return {
		ok: true,
		value: { outcome: 'read', mediaType, bytes: new Blob([body], { type: mediaType }) },
	};
}

function Preview({ path }: { readonly path: readonly string[] | null }) {
	return <span data-testid="state">{textFor(useArchivedArtifact(path))}</span>;
}

/** Every state as one readable string, including the address the browser would be handed. */
function textFor(state: ArchivedArtifactState): string {
	if (state.status !== 'read') {
		return state.status;
	}
	const body = state.body;
	return body.kind === 'opaque'
		? 'read:opaque'
		: `read:${body.kind}:${body.url}${body.kind === 'text' ? `:${body.lines.length}` : ''}`;
}

async function showing(path: readonly string[] | null = SCREENSHOT) {
	const rendered = render(<Preview path={path} />);
	// The answer, and the `Blob.text()` a text body decodes, each settle a microtask turn on.
	await act(async () => undefined);
	await act(async () => undefined);
	return rendered;
}

function state(): string {
	return screen.getByTestId('state').textContent ?? '';
}

beforeEach(() => {
	host.readArtifactBytes.mockResolvedValue(read('image/png', 'the-png-bytes'));
});

describe('reading one artifact', () => {
	// The address is the components a listing answered, verbatim — never a path this browser
	// composed, and never anything resembling a host filesystem path (D19).
	it('asks for the address it was given, and hands back a URL for the bytes', async () => {
		await showing();

		expect(host.readArtifactBytes).toHaveBeenCalledWith(SCREENSHOT);
		await waitFor(() => expect(state()).toMatch(/^read:image:blob:/));
	});

	/*
	 * React 19's StrictMode runs an effect twice on mount. A guard held in state would have let one
	 * artifact be fetched twice — and a recording is megabytes, so the second `GET` is visible in the
	 * host's log and in the reader's bandwidth alike.
	 */
	it('asks once under StrictMode, not twice, and creates one URL', async () => {
		const created = vi.spyOn(URL, 'createObjectURL');

		render(
			<StrictMode>
				<Preview path={SCREENSHOT} />
			</StrictMode>,
		);
		await waitFor(() => expect(host.readArtifactBytes).toHaveBeenCalledTimes(1));
		await act(async () => undefined);

		expect(created).toHaveBeenCalledTimes(1);
	});

	// A folder is beside the run's column instead, so there is no artifact open and nothing to fetch:
	// a request is not made on a guess about what an address names.
	it('asks for nothing at all when no artifact is open', async () => {
		await showing(null);

		expect(host.readArtifactBytes).not.toHaveBeenCalled();
		expect(state()).toBe('reading');
	});

	it('reads a text file as its own lines, with an address beside them', async () => {
		host.readArtifactBytes.mockResolvedValue(
			read('text/plain; charset=utf-8', 'first\nsecond\nthird\n'),
		);

		await showing();

		await waitFor(() => expect(state()).toMatch(/^read:text:blob:.*:3$/));
	});

	it('reads a recording as a recording', async () => {
		host.readArtifactBytes.mockResolvedValue(read('video/mp4', 'the-mp4-bytes'));

		await showing(RECORDING);

		await waitFor(() => expect(state()).toMatch(/^read:recording:blob:/));
	});

	/*
	 * Bytes the host could not name. **No URL is created at all**: there is nothing a browser would
	 * display, so an address for it would only ever be an offer to download, and there is no download
	 * control anywhere in the panel (`docs/DESIGN.md` §10).
	 */
	it('names bytes it cannot show as opaque, and creates no address for them', async () => {
		const created = vi.spyOn(URL, 'createObjectURL');
		host.readArtifactBytes.mockResolvedValue(read('application/octet-stream', 'raw'));

		await showing();

		await waitFor(() => expect(state()).toBe('read:opaque'));
		expect(created).not.toHaveBeenCalled();
	});
});

/**
 * **The pair that must never be folded together** — `list_archive`'s own two words, one file down
 * (D6, `docs/DESIGN.md` §9). A refusal is neither of them.
 */
describe('what the host answered about the artifact', () => {
	it('says nothing is filed at this address', async () => {
		host.readArtifactBytes.mockResolvedValue({ ok: true, value: { outcome: 'missing' } });

		await showing();

		await waitFor(() => expect(state()).toBe('missing'));
	});

	it('says something is filed there that this host will not read', async () => {
		host.readArtifactBytes.mockResolvedValue({ ok: true, value: { outcome: 'unreadable' } });

		await showing();

		await waitFor(() => expect(state()).toBe('unreadable'));
	});

	it('folds a host that never answered into the same not-readable state', async () => {
		host.readArtifactBytes.mockResolvedValue({ ok: false, refusal: 'unanswered' });

		await showing();

		await waitFor(() => expect(state()).toBe('unreadable'));
	});

	/*
	 * `Session.readArtifactBytes` has already fired `onRefusal` and the router is coming down, so
	 * *not readable* would be the panel's last word being the wrong one.
	 */
	it('sets nothing at all on a refusal', async () => {
		host.readArtifactBytes.mockResolvedValue({ ok: false, refusal: 'refused' });

		await showing();

		expect(state()).toBe('reading');
	});
});

/**
 * **The object URL's lifetime is the state that holds it**, and this is the half of the hook that
 * can leak megabytes rather than merely render the wrong thing.
 */
describe('the address handed to the browser', () => {
	it('is revoked when the artifact opened is a different one', async () => {
		const revoked = vi.spyOn(URL, 'revokeObjectURL');
		const { rerender } = await showing();
		const first = state();

		host.readArtifactBytes.mockResolvedValue(read('video/mp4', 'the-mp4-bytes'));
		rerender(<Preview path={RECORDING} />);
		await act(async () => undefined);
		await act(async () => undefined);

		expect(revoked).toHaveBeenCalledWith(first.replace('read:image:', ''));
		await waitFor(() => expect(state()).toMatch(/^read:recording:blob:/));
	});

	it('is revoked when the preview closes', async () => {
		const revoked = vi.spyOn(URL, 'revokeObjectURL');
		const { unmount } = await showing();
		const address = state().replace('read:image:', '');

		unmount();

		expect(revoked).toHaveBeenCalledWith(address);
	});

	/*
	 * Open a file, press the back arrow, open the same file again. The URL went with the first close,
	 * so the state cannot be reused: the address has to be read again rather than rendered from a
	 * handle the browser has already forgotten.
	 */
	it('is read again for an address returned to, rather than reused after its revoke', async () => {
		const { rerender } = await showing();
		const first = state();

		rerender(<Preview path={null} />);
		await act(async () => undefined);
		expect(state()).toBe('reading');

		rerender(<Preview path={SCREENSHOT} />);
		await act(async () => undefined);
		await act(async () => undefined);

		expect(host.readArtifactBytes).toHaveBeenCalledTimes(2);
		await waitFor(() => expect(state()).toMatch(/^read:image:blob:/));
		expect(state()).not.toBe(first);
	});

	// The screen went while the bytes were in flight. Nothing is created, because the state that
	// would have revoked it is not a state anybody is rendering.
	it('is not created at all for an answer that outlived the preview', async () => {
		const created = vi.spyOn(URL, 'createObjectURL');
		let answer: (value: unknown) => void = () => undefined;
		host.readArtifactBytes.mockReturnValue(
			new Promise((resolve) => {
				answer = resolve;
			}),
		);

		const { unmount } = render(<Preview path={SCREENSHOT} />);
		unmount();
		answer(read('image/png', 'the-png-bytes'));
		await act(async () => undefined);

		expect(created).not.toHaveBeenCalled();
	});
});
