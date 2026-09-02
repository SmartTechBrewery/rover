import { UNKNOWN } from '@panel/archive/file-size.js';
import type { ArchivedFile, HostAnswer } from '@panel/session/host-client.js';
import { z } from 'zod';
import { useArchivedRunFile } from './archived-file.js';

/**
 * The run's `device_info.json` — the one thing on the Archive screen that a directory listing
 * cannot answer (`docs/DESIGN.md` §9, #136).
 *
 * The file is the archive's own static snapshot of what `device_info` answered for the device the
 * lease held (D14, `src/daemon/archive.ts`, `PROJECT.md` §10). Rover writes it once per
 * lease-device pair, beside the first artifact that pair produced, and never rewrites it — so it
 * says what the device was when the run happened rather than what it is now, which is the whole
 * reason the card can exist at all for a run that ended weeks ago.
 *
 * **Deliberately re-declared rather than imported from `src/core/device.ts`**, for the reason
 * `archive-listing.ts` and `device-list.ts` both give at length: the panel is a separate tree with
 * its own `tsconfig.json` and its own `@panel` alias, precisely so one alias never means two trees,
 * and the daemon's module drags `core/capabilities.ts` and the verb schema neighbourhood into a
 * browser bundle behind it. The drift that buys is pinned rather than hoped for —
 * `tests/fixtures/panel/device-info.json` is parsed by the **host's** `DeviceInfoSchema` in
 * `tests/unit/panel/device-info-fixture.test.ts` and by the mirror below in `device-info.test.tsx`.
 *
 * **Nothing here is `.strict()` and every field is optional**, which is one step looser than the
 * other two mirrors and is the acceptance criterion rather than laziness: a field the file does not
 * carry is **named as unknown**, not dropped and not a reason to call a readable file unreadable.
 * A newer daemon adding a field must not blank this card either, and Zod's default strips what it
 * does not know.
 */

/**
 * The screen as the device reported it, in physical pixels and in dp.
 *
 * Every number is optional for the reason above: `SCREEN` and `DENSITY` are each **composed from
 * two or three of them**, and a composition must never invent a missing half — a card reading
 * `1080 x undefined px` is worse than one reading `unknown`.
 */
const ScreenSchema = z.object({
	widthPx: z.number().nullish(),
	heightPx: z.number().nullish(),
	densityScale: z.number().nullish(),
	widthDp: z.number().nullish(),
	heightDp: z.number().nullish(),
});

/**
 * As much of `device_info.json` as the card reads.
 *
 * A fact the file does not carry says {@link UNKNOWN}, imported from `file-size.ts` rather than
 * repeated: it is one word and the whole screen has to use the same one.
 *
 * `serial` is deliberately **not** read from the file. The card's serial is the `<serial>`
 * directory this file was read out of — the same string the run's identity card shows, and the one
 * fact that is true whatever the file turned out to contain (`docs/DESIGN.md` §9).
 *
 * `density`, the dots-per-inch the device reports, is likewise not read: the design's `DENSITY`
 * field is the scale and the dp size, and a field nothing draws is not a field this mirror pins.
 */
export const DeviceInfoFileSchema = z.object({
	platform: z.string().nullish(),
	model: z.string().nullish(),
	osVersion: z.string().nullish(),
	osApiLevel: z.number().nullish(),
	screen: ScreenSchema.nullish(),
});
export type DeviceInfoFile = z.infer<typeof DeviceInfoFileSchema>;

/**
 * The six values the `DEVICE — FROM device_info.json` card draws, already rendered as text.
 *
 * Every fallback is applied **here**, once, so the card's JSX has no branch in it: a `??` per field
 * in a component is how three rules that must hold together end up holding in two places out of
 * three.
 */
export interface DeviceFacts {
	readonly model: string;
	readonly platform: string;
	readonly osVersion: string;
	readonly apiLevel: string;
	readonly screen: string;
	readonly density: string;
}

/** The archive's own name for this file (`PROJECT.md` §10). Never composed and never configurable. */
const DEVICE_INFO_FILE = 'device_info.json';

/**
 * The file's facts, with `docs/DESIGN.md` §6's three fallbacks — **the same three the device card
 * already implements**, which is why they are worded the same way here.
 *
 * - **`model: null` falls back to the serial.** The card's job is to identify the device and the
 *   serial always can. The serial passed in is the `<serial>` directory's own name, so it is
 *   present whenever this card renders at all.
 * - **`osVersion: null` renders `unknown`** — a real answer for a device that could not be asked,
 *   named rather than closed up, and this row is one of a fixed six.
 * - **`platform` is passed through verbatim**, so it reads `android` and never `Android`. A display
 *   table mapping one onto the other would be a platform branch in shared code, which
 *   `ai/RULES.md` §2 exists to prevent, and the wire value is what the host said.
 *
 * `API LEVEL` follows `osVersion`'s rule for `osVersion`'s reason: it is nullable on the host for
 * the same "the device answered everything but that" case, and a platform without API levels has
 * none to report.
 */
export function deviceFactsFrom(info: DeviceInfoFile, serial: string): DeviceFacts {
	const screen = info.screen;
	return {
		model: info.model ?? serial,
		platform: info.platform ?? UNKNOWN,
		osVersion: info.osVersion ?? UNKNOWN,
		apiLevel:
			info.osApiLevel === null || info.osApiLevel === undefined ? UNKNOWN : String(info.osApiLevel),
		screen: pixelSize(screen?.widthPx, screen?.heightPx),
		density: densityText(screen?.densityScale, screen?.widthDp, screen?.heightDp),
	};
}

/** `1080 x 2400 px`, or `unknown` if either half is missing — never a half of one. */
function pixelSize(
	widthPx: number | null | undefined,
	heightPx: number | null | undefined,
): string {
	if (widthPx === null || widthPx === undefined || heightPx === null || heightPx === undefined) {
		return UNKNOWN;
	}
	return `${widthPx} x ${heightPx} px`;
}

/**
 * `2.625x — 411 x 914 dp`, or `unknown` if any of its three parts is missing.
 *
 * **The dp values are rounded here and nowhere earlier.** The host stores them as exact quotients
 * on purpose — `widthPx / densityScale`, unrounded, so nothing loses what the device actually said
 * (`ScreenInfoSchema`) — and rounding is a presentation decision, which makes this the place for
 * it. `411.42857142857144 x 914.2857142857143 dp` is the same fact and unreadable.
 */
function densityText(
	scale: number | null | undefined,
	widthDp: number | null | undefined,
	heightDp: number | null | undefined,
): string {
	if (
		scale === null ||
		scale === undefined ||
		widthDp === null ||
		widthDp === undefined ||
		heightDp === null ||
		heightDp === undefined
	) {
		return UNKNOWN;
	}
	return `${scale}x — ${Math.round(widthDp)} x ${Math.round(heightDp)} dp`;
}

/**
 * The three answers the card has about the file, and they are `list_archive`'s own three one level
 * down.
 *
 * `missing` is *Rover filed none for this run* and `unreadable` is *something is filed there and
 * this host will not read it*: the pair must never render alike, which is the same rule the
 * archive's empty and unreadable levels hold one directory up (D6, `docs/DESIGN.md` §7, §9).
 */
export type ArchivedDeviceInfo =
	| { readonly status: 'reading' }
	| { readonly status: 'read'; readonly info: DeviceInfoFile }
	| { readonly status: 'missing' }
	| { readonly status: 'unreadable' };

const READING: ArchivedDeviceInfo = { status: 'reading' };

/**
 * One run's `device_info.json`, read once when the run is opened — {@link useArchivedRunFile},
 * which owns the address, the caching and the one-request-per-run rule.
 *
 * What is this module's is what the file *means*: the name the archive gives it, the shape it is
 * parsed with, and {@link folded}'s mapping of one answer onto the card's four states.
 */
export function useArchivedDeviceInfo(level: readonly string[] | null): ArchivedDeviceInfo {
	return useArchivedRunFile(level, DEVICE_INFO_FILE, folded, READING);
}

/**
 * One answer, mapped onto {@link ArchivedDeviceInfo} — or nothing at all, for a `refused`.
 *
 * **Everything unusable folds into `unreadable`**: a `400`, a `500`, a body that is not JSON and
 * one this mirror cannot parse. That is the fold `archive-levels.ts` already makes and documents —
 * what the card has to decide is narrower than why, and it lands on the state whose sentence is
 * true either way. A **`refused`** sets nothing at all, because `Session.readArtifactText` has
 * already fired `onRefusal` and the router is coming down; *not readable* would be the panel's last
 * word being the wrong one.
 */
function folded(answer: HostAnswer<ArchivedFile>): ArchivedDeviceInfo | undefined {
	if (!answer.ok) {
		return answer.refusal === 'unanswered' ? ({ status: 'unreadable' } as const) : undefined;
	}
	return fromFile(answer.value);
}

function fromFile(file: ArchivedFile): ArchivedDeviceInfo {
	if (file.outcome === 'missing') {
		return { status: 'missing' } as const;
	}
	if (file.outcome === 'unreadable') {
		return { status: 'unreadable' } as const;
	}
	let body: unknown;
	try {
		body = JSON.parse(file.text);
	} catch {
		return { status: 'unreadable' } as const;
	}
	const parsed = DeviceInfoFileSchema.safeParse(body);
	return parsed.success
		? { status: 'read', info: parsed.data }
		: ({ status: 'unreadable' } as const);
}
