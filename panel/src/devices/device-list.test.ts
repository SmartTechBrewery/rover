import { describe, expect, it } from 'vitest';
import fixture from '../../../tests/fixtures/panel/list-devices.json';
import { ListDevicesResultSchema } from './device-list.js';

/**
 * The panel's half of the drift gate `tests/unit/panel/list-devices-fixture.test.ts` opens.
 *
 * The same fixture, parsed here by the mirror and there by the daemon's own schema — two projects
 * that cannot import each other, one file between them. What this half proves is that every field
 * the card renders survives the parse; what the other half proves is that the fixture is an answer
 * the daemon could really give.
 */
describe("the panel's mirror of list_devices", () => {
	it('reads a real answer, down to the fields the card renders', () => {
		const parsed = ListDevicesResultSchema.parse(fixture);

		expect(parsed.stale).toBe(false);
		expect(parsed.devices).toHaveLength(3);

		const held = parsed.devices[0];
		expect(held?.serial).toBe('emulator-5554');
		expect(held?.platform).toBe('android');
		expect(held?.model).toBe('sdk_gphone64_arm64');
		expect(held?.osVersion).toBe('15');
		expect(held?.heldBy?.owner).toBe('issue-113');
		expect(held?.heldBy?.project).toBe('rover');
		expect(held?.heldBy?.testName).toBe('the devices grid');
		expect(held?.heldBy?.grantedAt).toBe('2026-08-31T18:48:48.247Z');
		expect(held?.heldBy?.expiresInMs).toBe(1186759);
		expect(held?.state).toBe('ready');

		expect(parsed.devices[1]?.heldBy?.testName).toBe('the checkout flow');
		expect(parsed.devices[2]?.model).toBeNull();
		expect(parsed.devices[2]?.osVersion).toBeNull();
		expect(parsed.devices[2]?.heldBy).toBeNull();
	});

	/*
	 * The field the card has to read before it may print `free`, asserted off the fixture's own
	 * third entry so dropping it from the mirror fails here rather than on a screen. A device with
	 * no lease whose state is not `ready` is one the host refuses `not-ready`.
	 */
	it('reads the device state, including the one the host would refuse', () => {
		const parsed = ListDevicesResultSchema.parse(fixture);

		expect(parsed.devices.map((device) => device.state)).toEqual([
			'ready',
			'ready',
			'unauthorized',
		]);
		expect(parsed.devices[2]?.heldBy).toBeNull();
	});

	/*
	 * Why the mirror types the state as a string rather than an enum, on the same reasoning as the
	 * test below: a fourth state on the wire must not blank a working screen. Anything that is not
	 * the word `ready` is treated as not usable, which is the safe direction to be wrong in.
	 */
	it('tolerates a device state this panel has never heard of', () => {
		const parsed = ListDevicesResultSchema.safeParse({
			devices: [
				{
					serial: 'emulator-5554',
					platform: 'android',
					model: null,
					osVersion: null,
					state: 'recovery',
					heldBy: null,
				},
			],
			stale: false,
		});

		expect(parsed.success).toBe(true);
		expect(parsed.data?.devices[0]?.state).toBe('recovery');
	});

	/*
	 * The one deliberate difference from the host's copy. A newer daemon adding a column must not
	 * blank a working screen, so the mirror is not `.strict()` — it strips what it does not know.
	 */
	it('tolerates a field a newer daemon added', () => {
		const parsed = ListDevicesResultSchema.safeParse({
			devices: [
				{
					serial: 'emulator-5554',
					platform: 'android',
					model: null,
					osVersion: null,
					state: 'ready',
					heldBy: null,
					batteryLevel: 87,
				},
			],
			stale: false,
			nextPollInMs: 5000,
		});

		expect(parsed.success).toBe(true);
		expect(parsed.data?.devices[0]?.serial).toBe('emulator-5554');
	});

	it('refuses an answer missing a field the screen needs', () => {
		const parsed = ListDevicesResultSchema.safeParse({
			devices: [
				{
					serial: 'emulator-5554',
					platform: 'android',
					model: null,
					osVersion: null,
					state: 'ready',
				},
			],
			stale: false,
		});

		expect(parsed.success).toBe(false);
	});

	// Including the state itself. Tolerating its absence would put the card back to guessing that a
	// device with no lease is free, which is the answer the host refuses.
	it('refuses an answer that does not say what state the device is in', () => {
		const parsed = ListDevicesResultSchema.safeParse({
			devices: [
				{
					serial: 'emulator-5554',
					platform: 'android',
					model: null,
					osVersion: null,
					heldBy: null,
				},
			],
			stale: false,
		});

		expect(parsed.success).toBe(false);
	});
});
