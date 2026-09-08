import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { IosSimulatorDeviceBackend } from '@/backends/ios-simulator/backend.js';
import { parseSimctlDevices } from '@/backends/ios-simulator/parsers/simctl-list.js';
import { runSimctl } from '@/backends/ios-simulator/simctl.js';
import type { Device } from '@/core/device.js';
import { FileTooLargeError } from '@/core/errors.js';

/**
 * The two transfers against a real booted simulator. Gated on `ROVER_TEST_SIMULATOR`
 * (`tests/device/setup.ts`), so a host without one **skips rather than fails** (ai/TESTING.md).
 *
 * What the mocked suite beside it proves is the mapping and the two refusals against a data root
 * of its own making. What this proves is the thing a fixture cannot: that
 * `simctl list -j devices` still reports a `dataPath`, that the directory it names is really
 * there on this disk, and that a file written under it lands where the mapping says and comes
 * back byte for byte — which is the whole claim this phase rests on, that a simulator's storage
 * *is* a host path.
 *
 * **Where it landed is checked against a path this file assembles itself**, out of the listing's
 * `dataPath` and the device path, rather than through `containers.ts`. Reusing the mapping to
 * check the mapping would agree with itself whatever it computed.
 *
 * **It writes into the device's own `Documents`, under a name of this suite's own, and removes
 * what it wrote.** That is a state change where the suites beside it make none, and it is the
 * smallest one that can prove a transfer happened: the alternative is asserting against a file
 * somebody else's app put there. Nothing is booted, shut down, installed or launched
 * (`docs/IOS.md` §8, trap 4).
 *
 * The confinement refusal is **not** asserted here. Its case is a path that must never reach a
 * filesystem call, so proving it by watching a device would mean a failing run had already
 * written outside the device it was lent — it belongs in the unit suite and is there
 * (`tests/unit/backends/ios-simulator/containers.test.ts`).
 *
 * No lease, for `./backend.test.ts`'s reason — which is no longer that nothing is registered
 * (#230 landed the manifest and `./verb-dispatch.test.ts` takes one) but that every call here is a
 * read against a device nobody is holding, so what it asserts is a claim about the backend.
 */
const backend = new IosSimulatorDeviceBackend();

/** Under the device's own `Documents`, named so a stray one is attributable to this suite. */
const SUITE_DIRECTORY = 'rover-transfer-suite';
const DEVICE_DIRECTORY = `/Documents/${SUITE_DIRECTORY}`;

/** Every device this run wrote to, so the `afterAll` cleans each of them once. */
const written = new Set<Device>();

/** Scratch directories on this host, standing in for the daemon's own payload staging. */
const scratches: string[] = [];

async function bootedDevice(): Promise<Device> {
	const ready = (await backend.listDevices()).filter((device) => device.state === 'ready');
	expect(ready.length).toBeGreaterThan(0);
	const device = ready[0] as Device;
	written.add(device);
	return device;
}

/** The device's own storage root, read straight off the listing — no mapping involved. */
async function dataRootOf(device: Device): Promise<string> {
	const { stdout } = await runSimctl(['list', '-j', 'devices']);
	const entry = Object.values(parseSimctlDevices(stdout).devices)
		.flat()
		.find((candidate) => candidate.udid === device.serial);
	if (entry === undefined) throw new Error(`the listing no longer names ${device.serial}`);
	return entry.dataPath;
}

/**
 * A host file holding `bytes`, in a directory removed when the suite ends.
 *
 * This is the daemon's own half of a transfer — `src/daemon/verb-handlers.ts` writes a caller's
 * payload to a temporary file exactly like this — so the backend is called with the shape it is
 * really called with, rather than with a path into the repository.
 */
async function hostFile(bytes: Uint8Array | string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'rover-ios-transfer-'));
	scratches.push(directory);
	const path = join(directory, 'payload');
	await writeFile(path, bytes);
	return path;
}

afterEach(async () => {
	for (const directory of scratches.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

// Put back what this suite put on somebody's simulator. `force` so a run that never got as far
// as writing anything does not fail here instead of where it really failed.
afterAll(async () => {
	for (const device of written) {
		const root = await dataRootOf(device).catch(() => null);
		if (root === null) continue;
		await rm(join(root, 'Documents', SUITE_DIRECTORY), { recursive: true, force: true });
	}
});

describe.skipIf(!process.env.ROVER_TEST_SIMULATOR)(
	'the two transfers against a real simulator',
	() => {
		/**
		 * The round trip, on bytes that are not text: a push followed by a pull answers the same
		 * bytes, which is the one assertion that would catch every way this could go wrong at once
		 * — the wrong data root, a copy that followed a link, a read that decoded anything. The
		 * third expectation is where it landed, and it is what makes this a test of the *mapping*
		 * rather than of a private round trip that could be anywhere.
		 */
		it('pushes a file to the device’s own storage and pulls it back byte-identical', async () => {
			const device = await bootedDevice();
			const bytes = randomBytes(4096);
			const source = await hostFile(bytes);
			const devicePath = `${DEVICE_DIRECTORY}/roundtrip.bin`;

			await backend.pushFile(device.serial, source, devicePath);
			const pulled = await backend.pullFile(device.serial, devicePath, { maxBytes: 1024 * 1024 });

			expect(Buffer.from(pulled).equals(bytes)).toBe(true);
			const landed = join(await dataRootOf(device), 'Documents', SUITE_DIRECTORY, 'roundtrip.bin');
			expect(Buffer.from(await readFile(landed)).equals(bytes)).toBe(true);
		});

		// The directories under the device path do not exist on a container nobody has written
		// to, and there is no verb that would make them — so the push makes them itself.
		it('creates the directories the device path needs', async () => {
			const device = await bootedDevice();
			const source = await hostFile('nested');
			const devicePath = `${DEVICE_DIRECTORY}/deeper/still/report.txt`;

			await backend.pushFile(device.serial, source, devicePath);

			const pulled = await backend.pullFile(device.serial, devicePath, { maxBytes: 1024 });
			expect(Buffer.from(pulled).toString('utf8')).toBe('nested');
		});

		it('overwrites a file that is already on the device', async () => {
			const device = await bootedDevice();
			const devicePath = `${DEVICE_DIRECTORY}/overwritten.txt`;

			await backend.pushFile(device.serial, await hostFile('first'), devicePath);
			await backend.pushFile(device.serial, await hostFile('second'), devicePath);

			const pulled = await backend.pullFile(device.serial, devicePath, { maxBytes: 1024 });
			expect(Buffer.from(pulled).toString('utf8')).toBe('second');
		});

		// The contract's own rule, against a directory the device really has: a push into one
		// would land under a basename this host invented and report success.
		it('refuses to push onto a directory the device already has', async () => {
			const device = await bootedDevice();
			const source = await hostFile('x');

			await expect(backend.pushFile(device.serial, source, '/Documents')).rejects.toThrow(
				/is a directory on device/,
			);
		});

		it('refuses to pull a directory rather than answering for the inode', async () => {
			const device = await bootedDevice();

			await expect(
				backend.pullFile(device.serial, '/Documents', { maxBytes: 1024 * 1024 }),
			).rejects.toThrow(/one regular file/);
		});

		it('refuses a file over the bound', async () => {
			const device = await bootedDevice();
			const devicePath = `${DEVICE_DIRECTORY}/too-big.bin`;
			await backend.pushFile(device.serial, await hostFile(randomBytes(2048)), devicePath);

			await expect(backend.pullFile(device.serial, devicePath, { maxBytes: 1024 })).rejects.toThrow(
				FileTooLargeError,
			);
		});

		/**
		 * A missing file is a throw, never an empty answer, and the message names the **device**
		 * path and no path on this host — this is read on the agent's machine (D19).
		 */
		it('throws for a file the device does not have, naming no host path', async () => {
			const device = await bootedDevice();
			const devicePath = `${DEVICE_DIRECTORY}/never-written.bin`;

			const rejection = backend.pullFile(device.serial, devicePath, { maxBytes: 1024 });

			await expect(rejection).rejects.toThrow('ENOENT');
			await expect(rejection).rejects.toThrow(devicePath);
			await expect(rejection).rejects.not.toThrow(/CoreSimulator/);
		});
	},
);
