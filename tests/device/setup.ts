import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Every external invocation gets a timeout (ai/CODING_STANDARDS.md) — a hung adb
// must not wedge the suite.
const ADB_TIMEOUT_MS = 10_000;

/**
 * Device-project setup (vitest.config.ts wires this into the `device` project only).
 *
 * Sets ROVER_TEST_DEVICE when a usable device is attached; device suites gate on it with
 * `describe.skipIf(!process.env.ROVER_TEST_DEVICE)`, so a machine with nothing attached
 * skips rather than fails (ai/TESTING.md). Starting or connecting a device is the
 * operator's job — this probe never attaches anything itself.
 */
async function hasUsableDevice(): Promise<boolean> {
	try {
		const { stdout } = await execFileAsync('adb', ['devices'], { timeout: ADB_TIMEOUT_MS });
		// `adb devices` prints "<serial>\t<state>" per device after a header line. Only
		// `device` can run a verb — `offline`, `unauthorized` and `bootloader` cannot. Nothing
		// here reads the serial itself: its shape means nothing (ai/CODING_STANDARDS.md).
		return stdout
			.split('\n')
			.slice(1)
			.some((line) => line.split('\t')[1]?.trim() === 'device');
	} catch {
		// adb absent from PATH, or hung past the timeout. No device — not a failure.
		return false;
	}
}

if (await hasUsableDevice()) {
	process.env.ROVER_TEST_DEVICE = '1';
} else {
	console.warn(
		'[device] No usable device attached — skipping all device tests.\n' +
			'  Attach a device or start an emulator, then check `adb devices`.',
	);
	process.env.ROVER_TEST_DEVICE = '';
}
