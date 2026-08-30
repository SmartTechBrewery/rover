import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FFMPEG } from '@/daemon/frames.js';
import { type DeviceGate, readDeviceGate } from '../helpers/device-gate.js';

const execFileAsync = promisify(execFile);

// Every external invocation gets a timeout (ai/CODING_STANDARDS.md) — a hung adb
// must not wedge the suite.
const ADB_TIMEOUT_MS = 10_000;

/**
 * Device-project setup (vitest.config.ts wires this into the `device` project only).
 *
 * Sets three flags, because the suites do not all need the same thing:
 *
 * - `ROVER_TEST_DEVICE` — a device is attached and can run a command (`readDeviceGate`).
 * - `ROVER_TEST_LOCAL_DEVICE` — ...and it is physically attached to **this host**, which is
 *   what a suite that changes the device's network has to have (D18).
 * - `ROVER_TEST_FRAME_EXTRACTION` — the host has the program that slices a recording into
 *   frames (`src/daemon/frames.ts`). That one is not about a device at all, and it is a gate
 *   rather than a failure for the same reason the others are: a host without it is a host
 *   that cannot run those cases, not a repository that is broken. It is warned about
 *   **loudly**, because a `record_video` case silently not running is exactly the silence
 *   ai/RULES.md §6 says reads as "checked".
 *
 * Suites gate on the one they need with `describe.skipIf(!process.env.ROVER_TEST_…)`, so a
 * machine without a device it may touch skips rather than fails (ai/TESTING.md). Starting
 * or connecting a device is the operator's job — this probe never attaches anything itself,
 * and it installs nothing either.
 */
async function probeDevices(): Promise<DeviceGate> {
	try {
		const { stdout } = await execFileAsync('adb', ['devices'], { timeout: ADB_TIMEOUT_MS });
		return readDeviceGate(stdout);
	} catch {
		// adb absent from PATH, or hung past the timeout. No device — not a failure.
		return { usable: false, local: false };
	}
}

/** Whether the frame extractor's program is on this host's `PATH` and will answer. */
async function probeFrameExtraction(): Promise<boolean> {
	try {
		await execFileAsync(FFMPEG, ['-version'], { timeout: ADB_TIMEOUT_MS });
		return true;
	} catch {
		// Absent from PATH, not executable, or hung past the timeout. Not a failure.
		return false;
	}
}

const gate = await probeDevices();
const canExtractFrames = await probeFrameExtraction();

if (!gate.usable) {
	console.warn(
		'[device] No usable device attached — skipping all device tests.\n' +
			'  Attach a device or start an emulator, then check `adb devices`.',
	);
} else if (!gate.local) {
	console.warn(
		'[device] Every attached device is reached over a network transport — skipping the\n' +
			"  suites that change a device's own network (D18). Attach a device to this host\n" +
			'  directly, or start an emulator, to run them.',
	);
}

if (!canExtractFrames) {
	console.warn(
		`[device] '${FFMPEG}' is not on this host's PATH — skipping every case that slices a\n` +
			'  recording into frames, including the whole `record_video` verb over a lease, since\n' +
			'  the verb answers with the recording and the frames or with neither. Install it and\n' +
			`  check \`${FFMPEG} -version\` to run them.`,
	);
}

process.env.ROVER_TEST_DEVICE = gate.usable ? '1' : '';
process.env.ROVER_TEST_LOCAL_DEVICE = gate.local ? '1' : '';
process.env.ROVER_TEST_FRAME_EXTRACTION = canExtractFrames ? '1' : '';
