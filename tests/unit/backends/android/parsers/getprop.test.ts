import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isEmulatorFromProps, parseGetprop } from '@/backends/android/parsers/getprop.js';

// The filename records what the device answered; the assertions below check the parser
// against it, so a re-captured fixture that disagrees with its own name fails here.
const FIXTURE = 'getprop.api37-sdk-gphone16k-arm64.txt';
const GETPROP = readFileSync(
	new URL(`../../../../fixtures/adb/${FIXTURE}`, import.meta.url),
	'utf8',
);

describe('parseGetprop', () => {
	it('reads the API level and model the fixture is named after', () => {
		const props = parseGetprop(GETPROP);
		expect(FIXTURE).toContain(`api${props.apiLevel}-`);
		expect(props.apiLevel).toBe(37);
		expect(props.model).toBe('sdk_gphone16k_arm64');
		expect(props.manufacturer).toBe('Google');
		expect(props.androidRelease).toBe('17');
	});

	it('returns exactly the agreed shape', () => {
		expect(Object.keys(parseGetprop(GETPROP)).sort()).toEqual([
			'all',
			'androidRelease',
			'apiLevel',
			'isEmulator',
			'manufacturer',
			'model',
		]);
	});

	it('collects every property line', () => {
		expect(Object.keys(parseGetprop(GETPROP).all).length).toBeGreaterThan(100);
	});

	it('round-trips a value containing brackets, colons and spaces', () => {
		const { all } = parseGetprop(GETPROP);
		expect(all['ro.build.fingerprint']).toBe(
			'google/sdk_gphone16k_arm64/emu64a16k:17/CP21.260330.012/15545953:user/dev-keys',
		);
		expect(all['ro.build.date']).toBe('Tue Jun  2 11:20:52 PDT 2026');
		expect(all['debug.tracing.device_state']).toBe('0:DEFAULT');
	});

	// The key stops at the *first* `]` and the value at the last one on the line, so a
	// value is free to carry `]` of its own. Pinned here rather than left to the regex's
	// own comment.
	it('ends the key at the first bracket and the value at the last', () => {
		expect(parseGetprop('[test.key]: [left]right: text]\n').all).toEqual({
			'test.key': 'left]right: text',
		});
	});

	// `getprop` prints embedded newlines raw; this one really is four lines on the device.
	it('keeps a value that spans several lines', () => {
		expect(parseGetprop(GETPROP).all['persist.sys.boot.reason.history']).toBe(
			[
				'reboot,1787981883',
				'reboot,1783163973',
				'reboot,1783150305',
				'reboot,factory_reset,1781115638',
			].join('\n'),
		);
	});

	it('drops an unclosed value instead of swallowing the properties after it', () => {
		expect(parseGetprop('[a]: [oops\n[b]: [ok]\n').all).toEqual({ b: 'ok' });
	});

	it('returns null rather than throwing for a property the device does not have', () => {
		const props = parseGetprop('[ro.product.model]: [Pixel 9]\n');
		expect(props.apiLevel).toBeNull();
		expect(props.androidRelease).toBeNull();
		expect(props.manufacturer).toBeNull();
		expect(props.model).toBe('Pixel 9');
	});

	it('skips lines that are not [key]: [value]', () => {
		expect(parseGetprop('noise\n[ro.product.model]: [Pixel 9]\n').all).toEqual({
			'ro.product.model': 'Pixel 9',
		});
	});
});

describe('isEmulatorFromProps', () => {
	it('is true for the captured emulator', () => {
		expect(parseGetprop(GETPROP).isEmulator).toBe(true);
	});

	/**
	 * The negative case built from the *real* dump with its emulator markers deleted —
	 * not from a remembered physical-device dump. `tests/fixtures/adb/README.md` records
	 * that a physical-device fixture is still missing; until one exists this is the
	 * honest way to prove the markers are what decides, and nothing else is.
	 */
	it('is false once the markers are removed from the same dump', () => {
		const { all } = parseGetprop(GETPROP);
		for (const key of Object.keys(all)) {
			if (/^ro\.(kernel\.qemu|boot\.qemu|hardware|build\.characteristics)$/.test(key)) {
				delete all[key];
			}
		}

		// The serial still looks like an emulator's and the model still starts with `sdk_`;
		// neither may sway the answer (ai/CODING_STANDARDS.md).
		expect(all['ro.serialno']).toBe('EMULATOR36X6X11X0');
		expect(all['ro.product.model']).toBe('sdk_gphone16k_arm64');
		expect(isEmulatorFromProps(all)).toBe(false);
	});

	it.each([
		['ro.kernel.qemu', '1'],
		['ro.boot.qemu', '1'],
		['ro.hardware', 'ranchu'],
		['ro.build.characteristics', 'emulator'],
	])('is true on %s alone', (key, value) => {
		expect(isEmulatorFromProps({ [key]: value })).toBe(true);
	});

	it('ignores a marker key that holds a non-marker value', () => {
		expect(isEmulatorFromProps({ 'ro.kernel.qemu': '0', 'ro.hardware': 'qcom' })).toBe(false);
	});

	it('reads ro.build.characteristics as a comma-separated list', () => {
		expect(isEmulatorFromProps({ 'ro.build.characteristics': 'nosdcard,emulator' })).toBe(true);
		expect(isEmulatorFromProps({ 'ro.build.characteristics': 'nosdcard,default' })).toBe(false);
	});
});
