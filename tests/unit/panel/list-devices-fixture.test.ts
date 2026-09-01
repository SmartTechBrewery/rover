import { describe, expect, it } from 'vitest';
import { ListDevicesResultSchema } from '@/ipc/methods.js';
import fixture from '../../fixtures/panel/list-devices.json' with { type: 'json' };

/**
 * The daemon's half of one drift gate.
 *
 * `panel/src/devices/device-list.ts` re-declares `list_devices`' answer instead of importing this
 * schema, and the reason is structural rather than stylistic: the panel is a separate tree with its
 * own `tsconfig.json` and its own alias, and `src/ipc/methods.ts` drags `core/device.ts`,
 * `core/capabilities.ts` and the verb schemas into a browser bundle behind it. What that buys is a
 * second copy of a wire shape, and a second copy is a thing that drifts.
 *
 * So one fixture is parsed twice, by two projects that cannot import each other: **here** by the
 * host's own schema, which is what makes the fixture an answer the daemon could really give, and in
 * `panel/src/devices/device-list.test.ts` by the panel's mirror, which is what proves the mirror
 * reads it. A field renamed on the wire fails the first; a field the panel stopped reading fails
 * the second.
 *
 * **Where it came from, exactly** (`ai/TESTING.md`, "A wire answer is a fixture too, and it is filed
 * differently" — which is where the two bends below are recorded against the rule they bend). It was
 * captured over the panel's own HTTP surface from a daemon on API 35 with an emulator attached
 * (`sdk_gphone64_arm64`), in three reads: two leases taken with a `testName` each, and the device
 * free after a `force-release`. The one machine had one device, so the second entry carries a
 * second emulator's serial rather than a second capture's.
 *
 * The second entry's `testName` is the **third bend**, and a narrow one: it was captured as `null`,
 * back when a lease could be taken without one. #129 made `test_name` required, so a `null` there
 * is no longer an answer the daemon could give and the first assertion below would fail on the
 * captured bytes. No device was attached to re-capture from, so that one field was hand-edited to
 * a second project's test name and nothing else in the entry was touched.
 *
 * The **third entry is the one part that was not captured**, and it is worth saying which: a device
 * with no `model` and no `osVersion` is one sitting on its authorization prompt, which needs a
 * physical phone being plugged in for the first time. Its shape is the free capture with those two
 * fields and `osApiLevel` set to `null` and `state` to `unauthorized` — the combination
 * `src/core/device.ts` documents, and the reason all three of those fields are nullable. The
 * assertion below is what makes the whole file trustworthy either way.
 */
describe("the panel's list_devices fixture", () => {
	it('is an answer the daemon could give', () => {
		const parsed = ListDevicesResultSchema.safeParse(fixture);

		expect(parsed.success).toBe(true);
	});

	it('carries the two nullable cases the Devices screen has to render', () => {
		const parsed = ListDevicesResultSchema.parse(fixture);

		expect(parsed.devices.some((device) => device.model === null)).toBe(true);
		expect(parsed.devices.some((device) => device.osVersion === null)).toBe(true);
	});

	it('carries no lease without a test name — the field is required (D22, as amended #129)', () => {
		const parsed = ListDevicesResultSchema.parse(fixture);
		const held = parsed.devices.flatMap((device) =>
			device.heldBy === null ? [] : [device.heldBy],
		);

		expect(held.length).toBeGreaterThan(1);
		for (const holder of held) {
			expect(holder.testName.length).toBeGreaterThan(0);
		}
	});
});
