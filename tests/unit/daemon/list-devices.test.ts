/**
 * `list_devices` end to end: a registered backend, a real daemon on a temp socket, and a
 * client asking over the real framing.
 *
 * The daemon suite's real-socket exception applies (ai/TESTING.md) — never
 * `~/.rover/rover.sock`, and every daemon closed through its own handle in `afterEach`.
 *
 * The backend goes in through `registerDeviceBackend()` rather than being injected past
 * it, because the production lookup — the inventory iterating the registry — is half of
 * what is being asserted: `list_devices` has to reach a backend nobody named in
 * `src/daemon/`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	_resetDeviceBackendRegistryForTesting,
	registerDeviceBackend,
} from '@/backends/registry.js';
import type { Device, DeviceBackend, DeviceWatch, DeviceWatcher } from '@/core/device.js';
import { parseDeviceSerial } from '@/core/ids.js';
import { type RunningDaemon, startDaemon } from '@/daemon/listen.js';
import { IpcRequestError } from '@/ipc/protocol.js';
import {
	connectWithoutStarting,
	createTempSocket,
	removeTempSocket,
	type TempSocket,
} from '../../helpers/daemon-socket.js';
import { createMockDevice, createMockDeviceBackend } from '../../helpers/factories.js';

const attached = createMockDevice({ serial: parseDeviceSerial('attached-1') });
const elsewhere = createMockDevice({
	serial: parseDeviceSerial('elsewhere-1'),
	attachment: 'another-host',
});

let temp: TempSocket;
const running: RunningDaemon[] = [];

/** Registers a backend that reports both devices, and hands back what the test asserts on. */
function registerFakeBackend(devices: Device[] = [attached, elsewhere]) {
	const stopWatch = vi.fn<DeviceWatch['stop']>(async () => {});
	const watchDevices = vi.fn<DeviceBackend['watchDevices']>((watcher: DeviceWatcher) => {
		watcher.onDevices(devices);
		return { stop: stopWatch };
	});
	registerDeviceBackend({
		manifest: {
			platform: 'test-platform',
			label: 'Test',
			capabilities: { canReadScreen: true, canInput: true, canControlNetwork: true },
		},
		backend: createMockDeviceBackend({ watchDevices }),
	});
	return { stopWatch, watchDevices };
}

async function start(): Promise<RunningDaemon> {
	const result = await startDaemon({ socketPath: temp.socketPath });
	if (!result.started) {
		throw new Error('Another daemon holds the temp socket — the test cannot proceed');
	}
	running.push(result);
	return result;
}

afterEach(async () => {
	await Promise.all(running.splice(0).map((daemon) => daemon.close()));
	_resetDeviceBackendRegistryForTesting();
	if (temp) {
		await removeTempSocket(temp);
	}
});

describe('list_devices over the socket', () => {
	it("answers with this host's devices and leaves out another host's", async () => {
		registerFakeBackend();
		temp = await createTempSocket();
		await start();

		const client = await connectWithoutStarting(temp.socketPath);
		const result = await client?.request('list_devices', {});

		expect(result).toEqual({ devices: [attached], stale: false });
		await client?.close();
	});

	it('rejects an unexpected param key as invalid_params', async () => {
		registerFakeBackend();
		temp = await createTempSocket();
		await start();

		const client = await connectWithoutStarting(temp.socketPath);
		// `.strict()` on the params schema is what makes a typo'd argument a refusal instead
		// of a silently ignored key.
		const rejection = client?.request('list_devices', { serial: 'attached-1' } as never);

		await expect(rejection).rejects.toBeInstanceOf(IpcRequestError);
		await expect(rejection).rejects.toMatchObject({ code: 'invalid_params' });
		await client?.close();
	});

	it('stops the backend watch when the daemon closes', async () => {
		const { stopWatch } = registerFakeBackend();
		temp = await createTempSocket();
		await start();
		expect(stopWatch).not.toHaveBeenCalled();

		await Promise.all(running.splice(0).map((daemon) => daemon.close()));

		// The acceptance criterion in its literal form: closing the daemon leaves no watch —
		// and so no child process — behind.
		expect(stopWatch).toHaveBeenCalledTimes(1);
	});

	it('starts exactly one inventory when two starts race for the bind', async () => {
		const { watchDevices } = registerFakeBackend();
		temp = await createTempSocket();

		const results = await Promise.all([
			startDaemon({ socketPath: temp.socketPath }),
			startDaemon({ socketPath: temp.socketPath }),
		]);
		for (const result of results) {
			if (result.started) running.push(result);
		}

		// The loser constructs an inventory and never starts it — construction subscribes to
		// nothing, so there is no watch, and no child process, left running with nobody
		// holding a handle on it.
		expect(results.filter((result) => result.started)).toHaveLength(1);
		expect(watchDevices).toHaveBeenCalledTimes(1);
	});

	it('answers an empty list when no backend is registered', async () => {
		temp = await createTempSocket();
		await start();

		const client = await connectWithoutStarting(temp.socketPath);

		// Empty and *not* stale: nothing was interrupted, this host simply has nothing to
		// report. The two are different answers and the flag is what keeps them apart.
		await expect(client?.request('list_devices', {})).resolves.toEqual({
			devices: [],
			stale: false,
		});
		await client?.close();
	});
});
