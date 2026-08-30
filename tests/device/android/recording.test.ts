import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { AndroidDeviceBackend } from '@/backends/android/backend.js';
import { isFinishedRecording } from '@/backends/android/parsers/screenrecord.js';
import type { Device } from '@/core/device.js';

/**
 * `screenrecord` against a real attached device. Skips rather than fails when there is none
 * (`tests/device/setup.ts`, ai/TESTING.md).
 *
 * **This is the only place the `moov` claim can actually be checked.** Everything the unit
 * suites assert about ordering is asserted over a mocked runner, which cannot say whether
 * the device answers this argv at all, whether the recorder is really gone by the time its
 * adb client returns, or whether the bytes that cross the bridge are still a playable file.
 * A recording pulled early is not a shorter video — it is a file with no index, which no
 * player will open — so "the pull happened after the recorder exited" is the property, and
 * a real encoder is the only thing that can demonstrate it.
 *
 * **Read-only with respect to the screen**: it records whatever is on the device, launches
 * nothing and changes no setting, so it is safe against a device someone else is looking at.
 * **It drives the backend class directly, outside any lease** — the sixth suite on
 * ai/TESTING.md's temporary exemption list, alongside `./screenshot.test.ts`. Leases do
 * exist and a daemon will lend one; the only reason this suite does not take one is that
 * the helper that acquires and releases a lease around a suite has not been written and
 * this suite has not been converted onto it. `./verb-dispatch.test.ts` records through a
 * lease, and that is where the wire-level claim lives.
 *
 * Nothing below hardcodes a size, a model or a byte count off one device — every assertion
 * is a property of whatever is attached.
 */
const execFileAsync = promisify(execFile);
const ADB_TIMEOUT_MS = 10_000;

/** The device-side scratch path the backend owns, named here to assert it is gone after. */
const RECORDING_PATH = '/sdcard/rover-recording.mp4';

/** A short recording: long enough to have a payload, short enough for a suite to wait on. */
const DURATION_MS = 2_000;

const backend = new AndroidDeviceBackend();

async function firstUsableDevice(): Promise<Device> {
	const ready = (await backend.listDevices()).filter((device) => device.state === 'ready');
	expect(ready.length).toBeGreaterThan(0);
	return ready[0] as Device;
}

/** What `ls` says about the scratch path — the device's own words, whichever stream. */
async function listScratchFile(serial: string): Promise<string> {
	const { stdout, stderr } = await execFileAsync(
		'adb',
		['-s', serial, 'shell', 'ls', RECORDING_PATH],
		{ timeout: ADB_TIMEOUT_MS },
	).catch((error: { stdout?: string; stderr?: string }) => ({
		stdout: error.stdout ?? '',
		stderr: error.stderr ?? '',
	}));
	return `${stdout}${stderr}`;
}

describe.skipIf(!process.env.ROVER_TEST_DEVICE)('record_video against a real device', () => {
	/**
	 * The recipe proof, and the headline criterion of the whole change: what comes back is a
	 * **finished** recording, because the pull did not happen until the encoder had written
	 * its index. Nothing else about these bytes — not the length, not the exit code — can
	 * tell that from a recording pulled a moment too early.
	 */
	it('answers with a recording that is finished by the time it gets here', async () => {
		const device = await firstUsableDevice();

		const bytes = await backend.recordVideo(device.serial, { durationMs: DURATION_MS });

		expect(isFinishedRecording(bytes)).toBe(true);
		// A real encode of a real screen is kilobytes at the very least. The floor is here for
		// the shape a truncated stream takes when it happens to keep its header.
		expect(bytes.byteLength).toBeGreaterThan(4 * 1024);
	}, 60_000);

	// The cleanup, on the device rather than in the call log: a multi-megabyte file left on
	// hardware that goes to somebody else next is what the `finally` exists to prevent.
	it('leaves no scratch file behind on the device', async () => {
		const device = await firstUsableDevice();

		await backend.recordVideo(device.serial, { durationMs: DURATION_MS });

		expect(await listScratchFile(device.serial)).toMatch(/No such file or directory/);
	}, 60_000);

	// Two recordings in a row, because a path that leaks a file or a recorder process works
	// exactly once — and the second one is the case a stale scratch file would corrupt.
	it('can be called again immediately', async () => {
		const device = await firstUsableDevice();

		await backend.recordVideo(device.serial, { durationMs: DURATION_MS });
		const second = await backend.recordVideo(device.serial, { durationMs: DURATION_MS });

		expect(isFinishedRecording(second)).toBe(true);
	}, 120_000);
});
