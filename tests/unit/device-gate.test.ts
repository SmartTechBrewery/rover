import { describe, expect, it } from 'vitest';
import { readDeviceGate } from '../helpers/device-gate.js';

/**
 * The device suites' skip decision, as a unit test.
 *
 * The probe around it (`tests/device/setup.ts`) needs a real `adb`, and a suite that
 * skipped cannot assert that it skipped — so the parsing is where the decision is
 * checkable, and this is the file that checks it. The case that matters is the last one:
 * a host whose only device is paired over wireless debugging used to satisfy the single
 * flag the suites shared, and the one suite that may not touch such a device then failed
 * four times with a bare numeric comparison instead of skipping.
 */
const HEADER = 'List of devices attached\n';

describe('readDeviceGate', () => {
	it('finds nothing in an empty list', () => {
		expect(readDeviceGate(`${HEADER}\n`)).toEqual({ usable: false, local: false });
	});

	it('counts an emulator as usable and local', () => {
		expect(readDeviceGate(`${HEADER}emulator-5554\tdevice\n`)).toEqual({
			usable: true,
			local: true,
		});
	});

	it('counts a device attached over loopback as local', () => {
		expect(readDeviceGate(`${HEADER}localhost:5555\tdevice\n`)).toEqual({
			usable: true,
			local: true,
		});
	});

	it('reports a device paired over wireless debugging as usable but not local', () => {
		expect(readDeviceGate(`${HEADER}192.168.1.5:37000\tdevice\n`)).toEqual({
			usable: true,
			local: false,
		});
	});

	it('is local when any one of several attached devices is', () => {
		const listing = `${HEADER}192.168.1.5:37000\tdevice\nemulator-5554\tdevice\n`;

		expect(readDeviceGate(listing)).toEqual({ usable: true, local: true });
	});

	// `offline`, `unauthorized` and `bootloader` cannot run a verb, so neither flag may be
	// set by one — including the local flag, which a physically attached serial would
	// otherwise satisfy on its own.
	it('ignores a device that is attached but cannot run a command', () => {
		const listing = `${HEADER}emulator-5554\toffline\nR58M123\tunauthorized\n`;

		expect(readDeviceGate(listing)).toEqual({ usable: false, local: false });
	});

	// The header line is dropped by position, not by wording, and adb's daemon banner is
	// printed before it — so a listing that carries one must not lose its first device.
	it("reads the listing under adb's startup banner", () => {
		const listing = `* daemon started successfully\n${HEADER}emulator-5554\tdevice\n`;

		expect(readDeviceGate(listing)).toEqual({ usable: true, local: true });
	});
});
