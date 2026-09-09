import { describe, expect, it } from 'vitest';
import fixture from '../../../tests/fixtures/panel/list-devices.json';
import { ListDevicesResultSchema, type ListedDevice, toDeviceListView } from './device-list.js';

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
		expect(parsed.staleReason).toBeNull();
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
	 * The optional field, both ways round (D22, as amended #148). The card and the force-release
	 * dialog draw it when it is there and draw **nothing at all** when it is not, so a mirror that
	 * dropped it would leave both silent and a mirror that turned absence into `''` would draw an
	 * empty label — which is why the absent case is asserted to be `undefined` rather than falsy.
	 */
	it('reads a holder that described its run, and one that did not', () => {
		const parsed = ListDevicesResultSchema.parse(fixture);

		expect(parsed.devices[0]?.heldBy?.testDescription).toBe(
			'Checks the Devices screen draws a held card, a free card and the counter badge that has to agree with them.',
		);
		expect(parsed.devices[1]?.heldBy?.testDescription).toBeUndefined();
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

	/*
	 * The reason a stale view will not clear on its own (#168), and the two halves the screen
	 * branches on: the program the host could not run, and the platform it therefore cannot see.
	 */
	it('reads the reason a view is stale, with the program and the platform it names', () => {
		const parsed = ListDevicesResultSchema.parse({
			devices: [],
			stale: true,
			staleReason: { cause: 'tooling-missing', tool: 'adb', platform: 'android' },
		});

		expect(parsed.staleReason).toEqual({
			cause: 'tooling-missing',
			tool: 'adb',
			platform: 'android',
		});
	});

	/*
	 * An *older* daemon sends no such key, and a browser that refused its answer would blank a
	 * working screen over a compatible difference — the mirror's own rule, read the other way
	 * round. Absent and `null` mean the same thing, so the parse folds them together.
	 */
	it('reads an answer from a daemon that has no reason to send, as no reason', () => {
		const parsed = ListDevicesResultSchema.parse({ devices: [], stale: true });

		expect(parsed.staleReason).toBeNull();
	});

	/**
	 * The order and the counts come out of the mirror's own answer, so this half of the drift gate
	 * covers the derivation too: a real `list_devices` answer, grouped the way the screen draws it.
	 */
	it('groups a real answer held first, and counts the groups it grouped', () => {
		const view = toDeviceListView(ListDevicesResultSchema.parse(fixture).devices);

		expect(view.devices.map((device) => device.serial)).toEqual([
			'emulator-5554',
			'emulator-5556',
			'emulator-5558',
		]);
		expect([view.held, view.free, view.notReady]).toEqual([2, 0, 1]);
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

/**
 * The one derivation the Devices screen makes from the host's answer: the order the grid is drawn
 * in and the numbers the counter badge says, out of one partition (#267).
 *
 * Held first because held is what the screen is read for; then free, then not ready, which is the
 * badge's own term order. What these cases are really about is that the two cannot disagree — the
 * counts are the group sizes and the order is the groups concatenated.
 */
describe('the Devices screen’s view of that answer', () => {
	const device = (overrides: Partial<ListedDevice> = {}): ListedDevice => ({
		serial: 'emulator-5554',
		platform: 'android',
		model: 'sdk_gphone64_arm64',
		osVersion: '16',
		state: 'ready',
		heldBy: null,
		...overrides,
	});

	const lease = (serial: string): NonNullable<ListedDevice['heldBy']> => ({
		serial,
		owner: 'issue-267',
		project: 'rover',
		testName: 'the devices grid',
		grantedAt: '2026-09-09T09:12:00.000Z',
		expiresInMs: 600_000,
	});

	const held = device({ serial: 'held', heldBy: lease('held') });
	const free = device({ serial: 'free' });
	const notReady = device({ serial: 'not-ready', state: 'unauthorized' });

	it('puts every held device before every free one', () => {
		const view = toDeviceListView([free, held]);

		expect(view.devices.map((entry) => entry.serial)).toEqual(['held', 'free']);
	});

	it('puts a device the host would refuse a lease on last, and keeps it in the list', () => {
		const view = toDeviceListView([notReady, free, held]);

		expect(view.devices.map((entry) => entry.serial)).toEqual(['held', 'free', 'not-ready']);
	});

	/*
	 * A lease on a device that has since gone `offline` is still a lease and still the answer to
	 * "who do I ask" (#124), so the hardware state does not move it out of the held group.
	 */
	it('sorts a held device by its lease and never by its hardware state', () => {
		const offline = device({
			serial: 'held-offline',
			state: 'offline',
			heldBy: lease('held-offline'),
		});
		const view = toDeviceListView([free, offline]);

		expect(view.devices.map((entry) => entry.serial)).toEqual(['held-offline', 'free']);
		expect([view.held, view.free, view.notReady]).toEqual([1, 1, 0]);
	});

	/*
	 * The criterion the badge exists under: the three numbers are the sizes of the three groups
	 * the cards are drawn in, so they sum to the grid and no device is counted twice or missed.
	 */
	it('counts the three groups it drew, and they sum to the list', () => {
		const devices = [notReady, free, held, device({ serial: 'free-2' })];
		const view = toDeviceListView(devices);

		expect([view.held, view.free, view.notReady]).toEqual([1, 2, 1]);
		expect(view.held + view.free + view.notReady).toBe(devices.length);
		expect(view.devices).toHaveLength(devices.length);
	});

	/* Within a group the host's own order is what is drawn — nothing here re-sorts a group. */
	it('keeps the host’s order inside a group', () => {
		const first = device({ serial: 'first', heldBy: lease('first') });
		const second = device({ serial: 'second', heldBy: lease('second') });
		const view = toDeviceListView([second, first]);

		expect(view.devices.map((entry) => entry.serial)).toEqual(['second', 'first']);
	});

	// An empty list is a state of its own on this screen and must not become a shape with holes.
	it('answers an empty list as an empty list', () => {
		expect(toDeviceListView([])).toEqual({ devices: [], held: 0, free: 0, notReady: 0 });
	});
});
