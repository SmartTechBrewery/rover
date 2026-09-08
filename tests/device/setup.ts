import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { adbExecutable } from '@/backends/android/adb-path.js';
import { toDevices } from '@/backends/ios-simulator/devices.js';
import {
	parseSimctlDevices,
	parseSimctlRuntimes,
} from '@/backends/ios-simulator/parsers/simctl-list.js';
import { runSimctl } from '@/backends/ios-simulator/simctl.js';
import { FFMPEG } from '@/daemon/frames.js';
import { type DeviceGate, readDeviceGate } from '../helpers/device-gate.js';

const execFileAsync = promisify(execFile);

// Every external invocation gets a timeout (ai/CODING_STANDARDS.md) — a hung adb
// must not wedge the suite.
const ADB_TIMEOUT_MS = 10_000;

/**
 * Device-project setup (vitest.config.ts wires this into the `device` project only).
 *
 * Sets four flags, because the suites do not all need the same thing:
 *
 * - `ROVER_TEST_DEVICE` — a device is attached and can run a command (`readDeviceGate`).
 * - `ROVER_TEST_LOCAL_DEVICE` — ...and it is physically attached to **this host**, which is
 *   what a suite that changes the device's network has to have (D18).
 * - `ROVER_TEST_FRAME_EXTRACTION` — the host has the program that slices a recording into
 *   frames (`src/daemon/frames.ts`) **and normalises one into a file that plays**
 *   (`src/daemon/normalise.ts`). One flag rather than two, because it is the same program off
 *   the same `PATH`: a host that has it can do both, and a host that does not can do neither.
 *   That one is not about a device at all, and it is a gate rather than a failure for the same
 *   reason the others are: a host without it is a host that cannot run those cases, not a
 *   repository that is broken. It is warned about **loudly**, because a `record_video` case
 *   silently not running is exactly the silence ai/RULES.md §6 says reads as "checked".
 * - `ROVER_TEST_SIMULATOR` — a simulator this host can drive is **booted**
 *   (`probeSimulators`). The three flags above all read `adb`, so none of them says anything
 *   about this platform: on a Mac with a booted simulator and no Android device attached, every
 *   one of them is off and the iOS suites still have everything they need.
 *
 * Suites gate on the one they need with `describe.skipIf(!process.env.ROVER_TEST_…)`, so a
 * machine without a device it may touch skips rather than fails (ai/TESTING.md). Starting
 * or connecting a device is the operator's job — this probe never attaches anything itself,
 * and it installs nothing either.
 *
 * **Through the backend's own resolution, never the bare name** (#171): a suite that drove one
 * `adb` while the daemon it is testing drove another would be measuring two machines. That is
 * also why this probe holds no candidate list of its own.
 */
async function probeDevices(): Promise<DeviceGate> {
	try {
		const adb = await adbExecutable();
		const { stdout } = await execFileAsync(adb, ['devices'], { timeout: ADB_TIMEOUT_MS });
		return readDeviceGate(stdout);
	} catch {
		// No `adb` anywhere this host looks, or one that hung past the timeout. No device — not a
		// failure.
		return { usable: false, local: false };
	}
}

/** Whether the host tools' one program is on this host's `PATH` and will answer. */
async function probeFrameExtraction(): Promise<boolean> {
	try {
		await execFileAsync(FFMPEG, ['-version'], { timeout: ADB_TIMEOUT_MS });
		return true;
	} catch {
		// Absent from PATH, not executable, or hung past the timeout. Not a failure.
		return false;
	}
}

/**
 * Whether a simulator this host can drive is booted.
 *
 * **Through the backend's own runner, never a bare name**, for the reason `probeDevices` states
 * about `adb` (#171): a suite that drove one `simctl` while the backend it is testing drove
 * another would be measuring two machines. `xcrun` is not used here either, and for the sharper
 * version of the same reason — it performs its own search, which can disagree with the one
 * `developer-dir.ts` made (`src/backends/ios-simulator/simctl.ts`). So this calls `runSimctl`
 * rather than resolving and spawning itself (#231 review): the resolution, the timeout and the
 * `maxBuffer` decision then all come from the module these suites are about, and the gate cannot
 * drift from the runner it gates — a re-implementation here would have been the same argv with
 * the adb timeout constant and Node's unchosen 1 MB buffer.
 *
 * Both listings in one invocation because `toDevices` needs both, and the answer is read from
 * the mapped `Device[]` rather than from the raw JSON so the gate and the backend agree on what
 * `ready` means — `Booted` and nothing else, since a capture on a device that is merely
 * `Booting` hangs for a minute and then fails (`docs/IOS.md` §8, trap 1).
 *
 * Every failure means the same thing and none of them is a broken repository: no Xcode, no
 * macOS at all (`developerDirSearchLocations` answers `[]` off darwin, so the resolve throws),
 * output that is not the JSON the parsers expect, or a tool that hung past the timeout.
 *
 * It **boots nothing** — starting or connecting a device is the operator's job, which is this
 * file's own rule and matters more here than for `adb`: quitting `Simulator.app`, or shutting
 * down what this probe had started, takes down every device it owns (`docs/IOS.md` §8, trap 4).
 */
async function probeSimulators(): Promise<boolean> {
	try {
		const { stdout } = await runSimctl(['list', '-j', 'devices', 'runtimes']);
		const devices = toDevices(parseSimctlDevices(stdout), parseSimctlRuntimes(stdout));
		return devices.some((device) => device.state === 'ready');
	} catch {
		return false;
	}
}

const gate = await probeDevices();
const canExtractFrames = await probeFrameExtraction();
const hasBootedSimulator = await probeSimulators();

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
			'  recording into frames or normalises one into a file that plays, including the whole\n' +
			'  `record_video` verb over a lease, since the verb answers with the normalised\n' +
			'  recording and its frames or with neither. Install it and\n' +
			`  check \`${FFMPEG} -version\` to run them.`,
	);
}

if (!hasBootedSimulator) {
	console.warn(
		'[device] No booted simulator — skipping every iOS simulator test.\n' +
			'  Boot one on a condition rather than a sleep, and put it back afterwards:\n' +
			'    xcrun simctl boot <udid> && xcrun simctl bootstatus <udid> -b',
	);
}

process.env.ROVER_TEST_DEVICE = gate.usable ? '1' : '';
process.env.ROVER_TEST_LOCAL_DEVICE = gate.local ? '1' : '';
process.env.ROVER_TEST_FRAME_EXTRACTION = canExtractFrames ? '1' : '';
process.env.ROVER_TEST_SIMULATOR = hasBootedSimulator ? '1' : '';
