import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { type DeviceGate, readDeviceGate } from '../helpers/device-gate.js';

const execFileAsync = promisify(execFile);

// Every external invocation gets a timeout (ai/CODING_STANDARDS.md) — a hung adb
// must not wedge the suite.
const ADB_TIMEOUT_MS = 10_000;

/**
 * Device-project setup (vitest.config.ts wires this into the `device` project only).
 *
 * Sets two flags, because the suites do not all need the same device (`readDeviceGate`):
 *
 * - `ROVER_TEST_DEVICE` — a device is attached and can run a command.
 * - `ROVER_TEST_LOCAL_DEVICE` — ...and it is physically attached to **this host**, which is
 *   what a suite that changes the device's network has to have (D18).
 *
 * Suites gate on the one they need with `describe.skipIf(!process.env.ROVER_TEST_…)`, so a
 * machine without a device it may touch skips rather than fails (ai/TESTING.md). Starting
 * or connecting a device is the operator's job — this probe never attaches anything itself.
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

const gate = await probeDevices();

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

process.env.ROVER_TEST_DEVICE = gate.usable ? '1' : '';
process.env.ROVER_TEST_LOCAL_DEVICE = gate.local ? '1' : '';
