import { act, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/panel/device-info.json';

/**
 * The host, scripted per file — `archive-levels.test.tsx`'s shape. `useSession` is mocked rather
 * than driven through the real `SessionProvider` because what is in question here is only what this
 * hook asks for and how it folds the answer; the credential machinery has its own suite.
 */
const { host } = vi.hoisted(() => ({ host: { readArtifactText: vi.fn() } }));
vi.mock('@panel/session/session-provider.js', () => ({
	useSession: () => ({ readArtifactText: host.readArtifactText }),
}));

import {
	type ArchivedDeviceInfo,
	type DeviceInfoFile,
	DeviceInfoFileSchema,
	deviceFactsFrom,
	useArchivedDeviceInfo,
} from './device-info.js';

/** The captured file — a real emulator's, off a real archive. */
const CAPTURED = DeviceInfoFileSchema.parse(fixture.files[0]);
/** The same device with the three facts it could not answer, the file's second entry. */
const UNANSWERED = DeviceInfoFileSchema.parse(fixture.files[1]);

const SERIAL = 'emulator-5554';

function facts(info: DeviceInfoFile) {
	return deviceFactsFrom(info, SERIAL);
}

describe("the panel's mirror of device_info.json", () => {
	it('reads a real capture down to every field the card renders', () => {
		expect(facts(CAPTURED)).toEqual({
			model: 'sdk_gphone64_arm64',
			platform: 'android',
			osVersion: '15',
			apiLevel: '35',
			screen: '1080 x 2400 px',
			density: '2.625x — 411 x 914 dp',
		});
	});

	// The mirror is deliberately not `.strict()`: a browser that blanked a working card because a
	// newer daemon added a field would be worse than one that ignores it.
	it('ignores a field a newer daemon adds rather than rejecting the file', () => {
		const parsed = DeviceInfoFileSchema.safeParse({ ...CAPTURED, manufacturer: 'Google' });

		expect(parsed.success).toBe(true);
		expect(parsed.success && 'manufacturer' in parsed.data).toBe(false);
	});
});

/**
 * **`docs/DESIGN.md` §6's three fallbacks**, which are the same three the device card already
 * implements — one test each, because they are the rules this card is most likely to lose.
 */
describe('a fact the device could not answer', () => {
	it('falls back to the serial for `model`, because the serial always identifies the device', () => {
		expect(facts(UNANSWERED).model).toBe(SERIAL);
	});

	it('says `unknown` for `osVersion`, which is a real answer rather than a gap to close up', () => {
		expect(facts(UNANSWERED).osVersion).toBe('unknown');
	});

	// Nullable on the host for `osVersion`'s reason, and a platform with no API levels has none.
	it('says `unknown` for an API level the file has no number for', () => {
		expect(facts(UNANSWERED).apiLevel).toBe('unknown');
	});

	/*
	 * The rule with the sharpest reason: a display table mapping `android` onto `Android` would be
	 * a platform branch in shared code, which `ai/RULES.md` §2 exists to prevent.
	 */
	it('passes `platform` through untouched, so it reads `android` and never `Android`', () => {
		expect(facts(CAPTURED).platform).toBe('android');
		expect(Object.values(facts(CAPTURED)).join(' ')).not.toContain('Android');
		expect(deviceFactsFrom({ platform: 'ios' }, SERIAL).platform).toBe('ios');
	});

	it('names a platform the file does not carry at all, rather than dropping the row', () => {
		expect(facts({}).platform).toBe('unknown');
	});
});

/**
 * `SCREEN` and `DENSITY` are the two composed fields, and a composition is where a missing half
 * turns into an invented one.
 */
describe('the two fields composed out of several numbers', () => {
	it('rounds the dp quotients here, where rounding is a presentation decision', () => {
		// The host keeps them exact on purpose (`ScreenInfoSchema`), so nothing earlier may round.
		expect(CAPTURED.screen?.widthDp).toBe(411.42857142857144);
		expect(facts(CAPTURED).density).toBe('2.625x — 411 x 914 dp');
	});

	it('says `unknown` rather than half a screen size', () => {
		const half = facts({ screen: { widthPx: 1080 } });

		expect(half.screen).toBe('unknown');
		expect(half.density).toBe('unknown');
	});

	it('says `unknown` for both when the file carries no screen at all', () => {
		expect(facts({ screen: null })).toMatchObject({ screen: 'unknown', density: 'unknown' });
	});

	it('says `unknown` for the density when the scale is there and the dp size is not', () => {
		expect(facts({ screen: { densityScale: 2.625 } }).density).toBe('unknown');
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
	return <span data-testid="state">{textFor(useArchivedDeviceInfo(level))}</span>;
}

function textFor(state: ArchivedDeviceInfo): string {
	return state.status === 'read' ? `read:${state.info.model ?? ''}` : state.status;
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

describe("reading one run's device_info.json", () => {
	beforeEach(() => {
		host.readArtifactText.mockResolvedValue(read(fixture.files[0]));
	});

	// The address is the level a listing answered plus the archive's own file name — never a path
	// this browser composed, and never anything resembling a host filesystem path (D19).
	it('asks for the file inside the level it was given', async () => {
		await showing();

		expect(host.readArtifactText).toHaveBeenCalledWith([...LEVEL, 'device_info.json']);
		await waitFor(() => expect(state()).toBe('read:sdk_gphone64_arm64'));
	});

	/*
	 * React 19's StrictMode runs an effect twice on mount, so a guard held in state would have let
	 * one file be fetched twice — the assertion `archive-levels.ts` is shaped around, one level down.
	 */
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
 * **The pair that must never be folded together.** A file nobody filed and a file this host will
 * not read are different facts, and the card says them in different words — the same distinction
 * the archive's empty and unreadable levels draw one directory up (D6).
 */
describe('what the host answered about the file', () => {
	it('says a file that is not there is missing', async () => {
		host.readArtifactText.mockResolvedValue({ ok: true, value: { outcome: 'missing' } });

		await showing();

		await waitFor(() => expect(state()).toBe('missing'));
	});

	it('says a file the host will not serve cannot be read', async () => {
		host.readArtifactText.mockResolvedValue({ ok: true, value: { outcome: 'unreadable' } });

		await showing();

		await waitFor(() => expect(state()).toBe('unreadable'));
	});

	// Everything unusable folds here: the fold `archive-levels.ts` already makes and documents.
	it('folds a body that is not JSON into cannot-be-read', async () => {
		host.readArtifactText.mockResolvedValue({
			ok: true,
			value: { outcome: 'read', text: 'not json at all' },
		});

		await showing();

		await waitFor(() => expect(state()).toBe('unreadable'));
	});

	it('folds a body this mirror cannot parse into cannot-be-read', async () => {
		host.readArtifactText.mockResolvedValue(read({ model: 42 }));

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
});
