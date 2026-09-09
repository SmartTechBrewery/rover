/**
 * A simulator this host has that is **not booted** — the one thing the iOS-simulator backend
 * deliberately does not answer any more.
 *
 * `listDevices` is an inventory of what can be borrowed now (#267, `PROJECT.md` D41), so a
 * simulator that is not running is not in it, and a suite asking the backend for one gets nothing.
 * The refusals that need such a device are still worth exercising, though — a capture on a device
 * that is not booted blocks for a minute and a recording writes a zero-byte file (`docs/IOS.md`
 * §8, traps 1 and 12) — so this asks the **platform** for a device the host declines to list, and
 * hands its serial back for a suite to call a verb with.
 *
 * Read through the backend's own runner and mapping rather than through a hand-rolled `simctl`
 * call, for the reason `tests/device/setup.ts` gives about `adb`: a suite that read the platform
 * one way while the backend read it another would be measuring two machines. It is also why this
 * answers a `Device` rather than a udid — the state on it is the neutral word the backend would
 * report, which is what the refusals name.
 *
 * `null` when this host carries exactly one simulator and it is booted. A case that needs one says
 * out loud that it did not run rather than passing quietly (ai/RULES.md §6).
 */

import { toDevices } from '@/backends/ios-simulator/devices.js';
import {
	parseSimctlDevices,
	parseSimctlRuntimes,
} from '@/backends/ios-simulator/parsers/simctl-list.js';
import { runSimctl } from '@/backends/ios-simulator/simctl.js';
import type { Device } from '@/core/device.js';

export async function shutDownSimulator(): Promise<Device | null> {
	const { stdout } = await runSimctl(['list', '-j', 'devices', 'runtimes']);
	const every = toDevices(parseSimctlDevices(stdout), parseSimctlRuntimes(stdout));

	return every.find((device) => device.state !== 'ready') ?? null;
}
