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
 * **The first entry is captured and unedited**, and it was **re-captured on 2026-09-10** when
 * `screen.systemBars` joined the shape: it is the bytes of
 * `rover/system-bar-insets/20260910T114229Z-insets-fixture-capture-ff94ee9a/emulator-5554/device_info.json`
 * written by the daemon of that change for a real `screenshot` on an attached emulator, into an
 * artifacts root of its own so the operator's archive was not part of the capture. Adding the new
 * field to the *previous* capture by hand was the alternative, and it would have cost this file the
 * one property that makes it a gate: a hand-written value proves nothing about what the host
 * writes. Its `systemBars` — 156 px over a `densityScale` of 3, so **52 dp** — is the number that
 * settled the whole feature, since the documented status bar for that platform is 24 dp
 * (`PROJECT.md` §6).
 *
 * **The second is constructed, and that is the file's one bend** — the `list-devices.json`
 * precedent, stated where it can be seen. A device whose `model`, `osVersion` and `osApiLevel` are
 * all `null` is one that could not be asked — sitting on its authorization prompt is the common
 * case — and reaching that state needs a physical phone plugged into the host for the first time,
 * which the emulator that produced the first entry is not. **Its `systemBars: null` is doing a
 * second job on top of that**, and a more important one: it is the answer of a backend with **no
 * route to the fact at all** (`src/core/device.ts`), which is a state no device this host can reach
 * would produce and is exactly the state the comparison card has to draw a sentence for. The bend
 * is narrow: it is the captured entry with those four fields set to the combinations
 * `src/core/device.ts` documents, and this half parsing it with the host's own `.strict()` schema is
 * what keeps it a file the daemon could really have written.
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
		expect(captured.model).toBe('sdk_gphone16k_arm64');
		expect(captured.osVersion).toBe('17');
		expect(captured.osApiLevel).toBe(37);
		expect(captured.screen).toMatchObject({
			widthPx: 1280,
			heightPx: 2856,
			densityScale: 3,
			widthDp: 426.6666666666667,
			heightDp: 952,
			// The bars this device draws, in the same pixels as the screenshot beside this file —
			// which is what lets the comparison card set them aside without multiplying by anything.
			systemBars: { top: 156, bottom: 72, left: 0, right: 0 },
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
		/*
		 * **The one that is not about a device that could not be asked but about a backend that
		 * cannot ask**, and it has to be `null` on the wire rather than four zeros: zeros say *this
		 * device draws no bars*, which would have the card set aside nothing and call that an
		 * answer, where `null` has it say it cannot set anything aside (`docs/DESIGN.md` §9).
		 */
		expect(unanswered.screen.systemBars).toBeNull();
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
