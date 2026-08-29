/**
 * The inventory's two rules, as tests.
 *
 * The one this suite exists for is D6: `verifyForGrant` re-verifies against the backend
 * **even when the cache already holds the device**. Nothing about the return value shows
 * whether it did, so the assertion is on `describeDevice`'s call count — a version that
 * short-circuits on a cache hit would return exactly the right `Device` and still be the
 * bug the daemon exists to prevent.
 *
 * The other is D18: a device attached to another host never enters the inventory, and the
 * refusal is audible without being a flood.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RegisteredDeviceBackend } from '@/backends/manifest.js';
import type { Device, DeviceBackend, DeviceWatch, DeviceWatcher } from '@/core/device.js';
import { DeviceVanishedError, ForeignDeviceError } from '@/core/errors.js';
import { parseDeviceSerial, parsePlatformId } from '@/core/ids.js';
import { createDeviceInventory } from '@/daemon/inventory.js';
import {
	createMockCapabilityManifest,
	createMockDevice,
	createMockDeviceBackend,
} from '../../helpers/factories.js';

/**
 * A registered backend whose watch listener the test drives by hand. The real streams
 * deliver on their own schedule; holding the listener is what lets a test say "now a
 * snapshot arrives" and "now the view drops" in a definite order.
 */
function createWatchableBackend(
	platform: string,
	overrides: Partial<DeviceBackend> = {},
): {
	readonly registered: RegisteredDeviceBackend;
	readonly backend: DeviceBackend;
	readonly stopWatch: ReturnType<typeof vi.fn<DeviceWatch['stop']>>;
	deliver(devices: Device[]): void;
	interrupt(reason: string): void;
} {
	let watcher: DeviceWatcher | undefined;
	const stopWatch = vi.fn<DeviceWatch['stop']>(async () => {});
	const backend = createMockDeviceBackend({
		watchDevices: vi.fn<DeviceBackend['watchDevices']>((given) => {
			watcher = given;
			return { stop: stopWatch };
		}),
		...overrides,
	});

	const listener = (): DeviceWatcher => {
		if (!watcher) {
			throw new Error(`Nothing subscribed to '${platform}' — was start() called?`);
		}
		return watcher;
	};

	return {
		registered: {
			manifest: createMockCapabilityManifest({ platform: parsePlatformId(platform) }),
			backend,
		},
		backend,
		stopWatch,
		deliver: (devices) => listener().onDevices(devices),
		interrupt: (reason) => listener().onInterrupted(reason),
	};
}

const local = createMockDevice({ serial: parseDeviceSerial('local-1') });
const foreign = createMockDevice({
	serial: parseDeviceSerial('foreign-1'),
	attachment: 'another-host',
});

const inventories: Array<{ stop(): Promise<void> }> = [];

function inventoryOver(
	backends: readonly RegisteredDeviceBackend[],
	warn = vi.fn<(message: string) => void>(),
) {
	const inventory = createDeviceInventory({ backends, warn });
	inventories.push(inventory);
	return { inventory, warn };
}

afterEach(async () => {
	await Promise.all(inventories.splice(0).map((inventory) => inventory.stop()));
});

describe('createDeviceInventory admission', () => {
	it('keeps a snapshot a backend delivers synchronously from watchDevices', () => {
		// The contract has a backend deliver the full current set "once on subscription", and a
		// backend that already knows it does so before `watchDevices` has returned a handle.
		const backend = createMockDeviceBackend({
			watchDevices: vi.fn<DeviceBackend['watchDevices']>((watcher) => {
				watcher.onDevices([local]);
				return { stop: vi.fn<DeviceWatch['stop']>(async () => {}) };
			}),
		});
		const { inventory } = inventoryOver([{ manifest: createMockCapabilityManifest(), backend }]);

		inventory.start();

		expect(inventory.snapshot().devices).toEqual([local]);
	});

	it("keeps this host's devices and refuses another host's", () => {
		const backend = createWatchableBackend('test-platform');
		const { inventory } = inventoryOver([backend.registered]);
		inventory.start();

		backend.deliver([local, foreign]);

		expect(inventory.snapshot()).toEqual({ devices: [local], stale: false });
	});

	it('warns exactly once about a refused serial, however many snapshots repeat it', () => {
		const backend = createWatchableBackend('test-platform');
		const { inventory, warn } = inventoryOver([backend.registered]);
		inventory.start();

		// The stream re-emits the whole list on every change (PROJECT.md §6), so one device
		// attached elsewhere and staying there would otherwise warn on every frame.
		backend.deliver([local, foreign]);
		backend.deliver([local, foreign]);
		backend.deliver([local, foreign]);

		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toContain('foreign-1');
		expect(warn.mock.calls[0]?.[0]).toContain('another host');
	});

	it("keeps one backend's devices when another backend reports its own set", () => {
		const first = createWatchableBackend('platform-one');
		const second = createWatchableBackend('platform-two');
		const { inventory } = inventoryOver([first.registered, second.registered]);
		inventory.start();
		const other = createMockDevice({
			serial: parseDeviceSerial('local-2'),
			platform: parsePlatformId('platform-two'),
		});

		first.deliver([local]);
		second.deliver([other]);

		expect(inventory.snapshot().devices).toEqual([local, other]);
	});
});

describe('createDeviceInventory staleness', () => {
	it('keeps the last devices and says the view is stale when it is interrupted', () => {
		const backend = createWatchableBackend('test-platform');
		const { inventory } = inventoryOver([backend.registered]);
		inventory.start();
		backend.deliver([local]);

		backend.interrupt('the source went away');

		// Not an empty list: that would tell a lease layer every device vanished at the moment
		// the host lost the ability to know anything.
		expect(inventory.snapshot()).toEqual({ devices: [local], stale: true });
	});

	it('clears staleness on the next snapshot from the backend', () => {
		const backend = createWatchableBackend('test-platform');
		const { inventory } = inventoryOver([backend.registered]);
		inventory.start();
		backend.deliver([local]);
		backend.interrupt('the source went away');

		backend.deliver([local]);

		expect(inventory.snapshot().stale).toBe(false);
	});

	it('stays stale while any backend is still blind', () => {
		const first = createWatchableBackend('platform-one');
		const second = createWatchableBackend('platform-two');
		const { inventory } = inventoryOver([first.registered, second.registered]);
		inventory.start();

		first.interrupt('the source went away');
		second.deliver([local]);

		expect(inventory.snapshot().stale).toBe(true);
	});
});

describe('createDeviceInventory.verifyForGrant', () => {
	it('asks the backend even when the cache already holds the device', async () => {
		const backend = createWatchableBackend('test-platform', {
			describeDevice: vi.fn<DeviceBackend['describeDevice']>(async () => local),
		});
		const { inventory } = inventoryOver([backend.registered]);
		inventory.start();
		backend.deliver([local]);
		expect(inventory.snapshot().devices).toEqual([local]);

		const verified = await inventory.verifyForGrant(local.serial);

		// This is D6. A cache hit is not an answer, because the device may have gone away,
		// gone offline, or become another host's since the last frame.
		expect(backend.backend.describeDevice).toHaveBeenCalledTimes(1);
		expect(backend.backend.describeDevice).toHaveBeenCalledWith(local.serial);
		expect(verified).toEqual(local);
	});

	it('answers with what the backend says now, not with what the cache holds', async () => {
		const offline = createMockDevice({ serial: local.serial, state: 'offline' });
		const backend = createWatchableBackend('test-platform', {
			describeDevice: vi.fn<DeviceBackend['describeDevice']>(async () => offline),
		});
		const { inventory } = inventoryOver([backend.registered]);
		inventory.start();
		backend.deliver([local]);

		// Not a rejection: whether an `offline` device may be granted is the lease layer's
		// policy (#8), and this returns the fresh state for it to decide on.
		await expect(inventory.verifyForGrant(local.serial)).resolves.toEqual(offline);
	});

	it('rejects with DeviceVanishedError naming the serial when no backend has it', async () => {
		const backend = createWatchableBackend('test-platform', {
			describeDevice: vi.fn<DeviceBackend['describeDevice']>(async () => null),
		});
		const { inventory } = inventoryOver([backend.registered]);
		inventory.start();
		backend.deliver([local]);

		const rejection = inventory.verifyForGrant(local.serial);

		await expect(rejection).rejects.toBeInstanceOf(DeviceVanishedError);
		await expect(rejection).rejects.toMatchObject({ serial: local.serial });
		await expect(rejection).rejects.toThrow('local-1');
	});

	it('rejects with ForeignDeviceError when the backend now reports another host', async () => {
		const backend = createWatchableBackend('test-platform', {
			describeDevice: vi.fn<DeviceBackend['describeDevice']>(async () => foreign),
		});
		const { inventory } = inventoryOver([backend.registered]);
		inventory.start();

		const rejection = inventory.verifyForGrant(foreign.serial);

		await expect(rejection).rejects.toBeInstanceOf(ForeignDeviceError);
		await expect(rejection).rejects.toMatchObject({ serial: foreign.serial });
	});

	it('takes the first backend that has the device and does not need a started inventory', async () => {
		const absent = createWatchableBackend('platform-one', {
			describeDevice: vi.fn<DeviceBackend['describeDevice']>(async () => null),
		});
		const present = createWatchableBackend('platform-two', {
			describeDevice: vi.fn<DeviceBackend['describeDevice']>(async () => local),
		});
		const { inventory } = inventoryOver([absent.registered, present.registered]);

		await expect(inventory.verifyForGrant(local.serial)).resolves.toEqual(local);
		expect(absent.backend.describeDevice).toHaveBeenCalledTimes(1);
	});
});

describe('createDeviceInventory lifecycle', () => {
	it('stops every watch and is safe to call twice', async () => {
		const first = createWatchableBackend('platform-one');
		const second = createWatchableBackend('platform-two');
		const { inventory } = inventoryOver([first.registered, second.registered]);
		inventory.start();

		await inventory.stop();
		await inventory.stop();

		expect(first.stopWatch).toHaveBeenCalledTimes(1);
		expect(second.stopWatch).toHaveBeenCalledTimes(1);
	});

	it('stops the other watches and says so when one refuses to stop', async () => {
		const refusing = createWatchableBackend('platform-one', {});
		refusing.stopWatch.mockRejectedValueOnce(new Error('the handle was already gone'));
		const willing = createWatchableBackend('platform-two');
		const { inventory, warn } = inventoryOver([refusing.registered, willing.registered]);
		inventory.start();

		// Never rejects: the daemon calls this on its way down, and a rejection here would
		// leave the socket file behind a `close()` that failed.
		await expect(inventory.stop()).resolves.toBeUndefined();

		expect(willing.stopWatch).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls.at(-1)?.[0]).toContain('the handle was already gone');
	});

	it('subscribes once however many times it is started', () => {
		const backend = createWatchableBackend('test-platform');
		const { inventory } = inventoryOver([backend.registered]);

		inventory.start();
		inventory.start();

		expect(backend.backend.watchDevices).toHaveBeenCalledTimes(1);
	});

	it('subscribes to nothing until it is started', () => {
		const backend = createWatchableBackend('test-platform');
		const { inventory } = inventoryOver([backend.registered]);

		expect(backend.backend.watchDevices).not.toHaveBeenCalled();
		expect(inventory.snapshot()).toEqual({ devices: [], stale: false });
	});
});
