import { attachmentOfSerial } from '@/backends/android/attachment.js';

/**
 * What `adb devices` says about what this host may be tested against.
 *
 * Two answers rather than one, because the device suites do not all want the same thing.
 * A suite that reads, launches or captures needs *a* device; a suite that takes the
 * device off the network needs one that is **physically here**, since cutting the network
 * of a device reached over a network transport cuts the transport itself (D18). The
 * second question used to live inside the one suite that asks it, which meant the gate
 * said "run" and the suite then failed on a host where the honest answer was "skip".
 *
 * Split out of `tests/device/setup.ts` so it is assertable from the unit project:
 * `tests/unit/device-gate.test.ts` is the only place the parsing is exercised, since the
 * probe itself needs a real `adb` and the skip path cannot be asserted from inside a
 * suite that skipped.
 */
export interface DeviceGate {
	/** A device is attached and in a state that can run a command. */
	usable: boolean;
	/** ...and at least one such device is physically attached to this host. */
	local: boolean;
}

/**
 * Read the gate out of `adb devices` output.
 *
 * `adb devices` prints `"<serial>\t<state>"` per device after a header line. Only `device`
 * can run a verb — `offline`, `unauthorized` and `bootloader` cannot. The serial is read
 * for exactly one thing, transport, through the module that owns that exception
 * (`src/backends/android/attachment.ts`); nothing here infers anything else from its shape
 * (ai/CODING_STANDARDS.md).
 */
export function readDeviceGate(adbDevicesStdout: string): DeviceGate {
	const gate: DeviceGate = { usable: false, local: false };

	for (const line of adbDevicesStdout.split('\n').slice(1)) {
		const [rawSerial, rawState] = line.split('\t');
		const serial = rawSerial?.trim() ?? '';
		if (serial === '' || rawState?.trim() !== 'device') continue;

		gate.usable = true;
		if (attachmentOfSerial(serial) === 'this-host') gate.local = true;
	}

	return gate;
}
