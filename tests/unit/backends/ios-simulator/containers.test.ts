import { describe, expect, it } from 'vitest';
import { hostPathOf } from '@/backends/ios-simulator/containers.js';
import { parseDeviceSerial } from '@/core/ids.js';

/**
 * The mapping and its confinement, with **no simulator, no `simctl` and no filesystem** — the
 * property that module was extracted for. Every root below is a literal, so nothing here depends
 * on the layout of the machine it runs on and the whole suite passes on a host that has never had
 * Xcode.
 *
 * The confinement refusal is asserted **here** rather than against a device, deliberately: the
 * case it is written for is a path that must never reach a filesystem call at all, so a test that
 * proved it by watching a device would be a test that had already lost if it failed.
 */
const SERIAL = parseDeviceSerial('997FA43E-FF9F-4109-BEF0-53D3F46653E7');

/** The shape `simctl list -j devices` reports, from the committed capture. */
const ROOT = `/Users/someone/Library/Developer/CoreSimulator/Devices/${SERIAL}/data`;

describe('hostPathOf, on the paths a caller means', () => {
	it('resolves an absolute device path under the device’s own data root', () => {
		expect(hostPathOf(SERIAL, ROOT, '/Documents/report.bin')).toBe(`${ROOT}/Documents/report.bin`);
	});

	// The seven names the data root holds on the bench, so the mapping is asserted over the
	// namespace a caller actually addresses rather than over one invented directory.
	it.each([
		'Containers',
		'Documents',
		'Downloads',
		'Library',
		'Media',
		'tmp',
		'var',
	])('resolves into the data root’s own %s', (top) => {
		expect(hostPathOf(SERIAL, ROOT, `/${top}/file`)).toBe(`${ROOT}/${top}/file`);
	});

	it('normalises the harmless middles rather than refusing them', () => {
		expect(hostPathOf(SERIAL, ROOT, '/Documents/./reports/../report.bin')).toBe(
			`${ROOT}/Documents/report.bin`,
		);
		expect(hostPathOf(SERIAL, ROOT, '/Documents//report.bin')).toBe(`${ROOT}/Documents/report.bin`);
	});

	// A root the tool reported with a trailing slash, or with a `.` in it, is the same root. It
	// is `resolve`d rather than trusted, so the containment test below compares like with like.
	it('takes the data root as the tool spelled it', () => {
		expect(hostPathOf(SERIAL, `${ROOT}/`, '/Documents/x')).toBe(`${ROOT}/Documents/x`);
		expect(hostPathOf(SERIAL, `${ROOT}/./`, '/Documents/x')).toBe(`${ROOT}/Documents/x`);
	});

	/**
	 * The data root itself resolves to the data root, and is *not* refused here — it is refused
	 * by both callers, each for its own reason (a push into a directory, a pull of one). Keeping
	 * the two questions apart is what lets each refusal say the thing its caller got wrong.
	 */
	it('answers the data root for the root path', () => {
		expect(hostPathOf(SERIAL, ROOT, '/')).toBe(ROOT);
	});
});

describe('hostPathOf, on the paths that would leave the device', () => {
	/**
	 * The case this whole module exists for. `DevicePathSchema` (`src/ipc/verb-methods.ts`)
	 * requires the leading slash and forbids NUL and a trailing slash — it does **not** forbid
	 * `..`, and it never had to on a platform where the path is interpreted by the device. Here
	 * the destination is a real path on the machine lending the device, so every one of these
	 * would be a write, or a read, somewhere the caller was never lent.
	 */
	it.each([
		['/../../../../../../etc/passwd', 'straight out of the tree'],
		['/Documents/../../../../../../etc/passwd', 'out through a directory that exists'],
		['/..', 'the parent of the root itself'],
		['/Documents/../..', 'one segment past the root'],
	])('refuses %s (%s)', (devicePath) => {
		expect(() => hostPathOf(SERIAL, ROOT, devicePath)).toThrow(/resolves outside the storage/);
	});

	// The device is named because the message is read by somebody holding several of them; the
	// caller's own path is quoted because that is what they have to change.
	it('names the device and the caller’s path, and never where the walk landed', () => {
		expect(() => hostPathOf(SERIAL, ROOT, '/../../../etc/passwd')).toThrow(SERIAL);
		expect(() => hostPathOf(SERIAL, ROOT, '/../../../etc/passwd')).toThrow(
			"'/../../../etc/passwd'",
		);
		// Answering a probe with the layout of the machine being probed is the one thing a
		// message about a path escape must not do (D19).
		expect(() => hostPathOf(SERIAL, ROOT, '/../../../etc/passwd')).not.toThrow(/\/Users\//);
	});

	/**
	 * The sibling directory whose name merely *starts* with the root's. A containment test
	 * written as a bare `startsWith` passes this and should not: `…/<udid>/data-elsewhere` is
	 * not inside `…/<udid>/data`, and on this platform the difference is one device's storage
	 * against another's.
	 */
	it('refuses a sibling whose name extends the root', () => {
		expect(() => hostPathOf(SERIAL, ROOT, '/../data-elsewhere/x')).toThrow(
			/resolves outside the storage/,
		);
	});

	it('refuses a relative path rather than reading it as an absolute one', () => {
		expect(() => hostPathOf(SERIAL, ROOT, 'Documents/report.bin')).toThrow(
			/is not an absolute path/,
		);
		// The one that makes the refusal worth having: `join` would resolve this to the same
		// place as `/Documents/report.bin` and nobody would learn the slash was missing.
		expect(() => hostPathOf(SERIAL, ROOT, 'Documents/report.bin')).toThrow(
			"'/Documents/report.bin'",
		);
	});
});
