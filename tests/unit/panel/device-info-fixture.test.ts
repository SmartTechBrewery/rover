import { describe, expect, it } from 'vitest';
import { DeviceInfoSchema } from '@/core/device.js';
import fixture from '../../fixtures/panel/device-info.json' with { type: 'json' };

/**
 * The daemon's half of the run device card's drift gate (#136).
 *
 * `panel/src/archive/device-info.ts` re-declares the shape of `device_info.json` instead of
 * importing `DeviceInfoSchema`, for the structural reason `list-devices-fixture.test.ts` sets out:
 * the panel is a separate tree with its own `tsconfig.json` and its own alias, and `core/device.ts`
 * drags `core/capabilities.ts` and the verb schema neighbourhood into a browser bundle behind it.
 * So one fixture is parsed twice, by two projects that cannot import each other — **here** by the
 * schema the archive writes the file from, and in `panel/src/archive/device-info.test.tsx` by the
 * panel's mirror. A field renamed on the host fails this half; a field the card stopped reading
 * fails the other.
 *
 * **This file is not a wire answer, and it is the first of these that is not** (`ai/TESTING.md`,
 * "A wire answer is a fixture too"). `device_info.json` is a *file the daemon writes into the
 * archive* — `JSON.stringify(result.device)` for the first artifact a lease-device pair produces
 * (`src/daemon/archive.ts`, D14) — so what governs its shape is `DeviceInfoSchema`, which is why
 * that schema rather than a method's result schema is what parses it here. `.strict()` on the
 * host's side is what makes the parse below a real gate: an invented field fails it.
 *
 * **The first entry is captured and unedited.** It is the bytes of
 * `~/.rover/artifacts/rover/unlabeled/20260831T133741Z-issue-107-f1a3f20e/emulator-5554/device_info.json`
 * on the machine that built this change, written by the daemon for a real `screenshot` on an
 * attached emulator.
 *
 * **The second is constructed, and that is the file's one bend** — the `list-devices.json`
 * precedent, stated where it can be seen. A device whose `model`, `osVersion` and `osApiLevel` are
 * all `null` is one that could not be asked — sitting on its authorization prompt is the common
 * case — and reaching that state needs a physical phone plugged into the host for the first time,
 * which the emulator that produced the first entry is not. The bend is narrow: it is the captured
 * entry with exactly those three fields set to the combination `src/core/device.ts` documents, and
 * this half parsing it with the host's own `.strict()` schema is what keeps it a file the daemon
 * could really have written.
 */

const files = fixture.files;

describe("the panel's device_info.json fixture", () => {
	it('is a set of files the archive could really have written', () => {
		for (const file of files) {
			expect(DeviceInfoSchema.safeParse(file).success).toBe(true);
		}
	});

	// Named one by one rather than counted: this is the half that fails when a field is renamed on
	// the host, and a field the card draws has to be a field the host still sends.
	it('carries every field the run device card reads', () => {
		const captured = DeviceInfoSchema.parse(files[0]);

		expect(captured.platform).toBe('android');
		expect(captured.model).toBe('sdk_gphone64_arm64');
		expect(captured.osVersion).toBe('15');
		expect(captured.osApiLevel).toBe(35);
		expect(captured.screen).toMatchObject({
			widthPx: 1080,
			heightPx: 2400,
			densityScale: 2.625,
			widthDp: 411.42857142857144,
			heightDp: 914.2857142857143,
		});
	});

	/*
	 * The three the card has a fallback for (`docs/DESIGN.md` §6), and they have to be `null` on
	 * the wire rather than absent: the panel's mirror would say `unknown` for either, but only a
	 * `null` proves the host schema still permits the answer the fallback exists for.
	 */
	it('carries the nullable cases the card has to render as a fallback', () => {
		const unanswered = DeviceInfoSchema.parse(files[1]);

		expect(unanswered.model).toBeNull();
		expect(unanswered.osVersion).toBeNull();
		expect(unanswered.osApiLevel).toBeNull();
	});

	// The dp values are exact quotients on the host on purpose — rounding is the panel's decision,
	// and a fixture that carried rounded ones would let a rounding creep back up into the daemon.
	it('keeps the dp values unrounded, as the host stores them', () => {
		const captured = DeviceInfoSchema.parse(files[0]);

		expect(captured.screen.widthDp).not.toBe(Math.round(captured.screen.widthDp));
		expect(captured.screen.widthDp).toBeCloseTo(
			captured.screen.widthPx / captured.screen.densityScale,
			10,
		);
	});
});
