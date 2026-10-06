import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	CRASH_FRAMES_IN_MESSAGE,
	parseCrashReport,
	unifiedLogTimestampOf,
} from '@/backends/ios-simulator/parsers/crash-report.js';

/**
 * The `.ips` parser over two **captures** — Settings crashed from the host on two simulators of
 * one host, macOS 26.6.2 (25G83) / Xcode 27.0 (27A266a) / iOS 26.5 (23F77), 2026-10-06
 * (`tests/fixtures/ios-simulator/README.md`). The second is the attribution negative case for
 * `../crash-reports.test.ts`; here it is a second shape of the same format.
 */
function capture(name: string): string {
	return readFileSync(
		new URL(`../../../../fixtures/ios-simulator/${name}`, import.meta.url),
		'utf8',
	);
}

const SEGV = capture('crash-report.sigsegv.xcode27.0-ios26.5.ips');
const ABRT = capture('crash-report.sigabrt-other-device.xcode27.0-ios26.5.ips');

describe('parseCrashReport', () => {
	it('maps a crash onto one fatal entry for the report’s pid, with no tag', () => {
		const report = parseCrashReport(SEGV);

		expect(report?.entry).toMatchObject({
			timestamp: '2026-10-06 15:27:47.112300+0200',
			level: 'fatal',
			tag: '',
			pid: 82924,
		});
	});

	it('carries the field that names the device, verbatim', () => {
		expect(parseCrashReport(SEGV)?.coalitionName).toBe(
			'com.apple.CoreSimulator.SimDevice.88D8476E-F4A4-4A18-A89B-0C47E077CC8B',
		);
		expect(parseCrashReport(ABRT)?.coalitionName).toBe(
			'com.apple.CoreSimulator.SimDevice.D85C3449-4D0C-4E93-B8EC-77FD0E5A8F3F',
		);
	});

	/**
	 * The process, the exception, the termination and the head of the faulting thread — and no
	 * more frames than the bound, though the thread has sixteen.
	 */
	it('summarises what died, how, and where, bounded in frames', () => {
		const message = parseCrashReport(SEGV)?.entry.message ?? '';
		const lines = message.split('\n');

		expect(lines.slice(0, 5)).toEqual([
			'Preferences (com.apple.Preferences), pid 82924',
			'exception: EXC_CRASH (SIGSEGV), codes 0x0000000000000000, 0x0000000000000000',
			'termination: SIGNAL 11, Segmentation fault: 11, by zsh',
			`thread 0 (com.apple.main-thread), ${CRASH_FRAMES_IN_MESSAGE} of 16 frames:`,
			'  0 libsystem_kernel.dylib mach_msg2_trap + 8',
		]);
		expect(lines).toHaveLength(4 + CRASH_FRAMES_IN_MESSAGE);
	});

	it('reads the second capture’s signal and its thread with no queue', () => {
		const message = parseCrashReport(ABRT)?.entry.message ?? '';

		expect(message).toContain('exception: EXC_CRASH (SIGABRT)');
		expect(message).toContain('termination: SIGNAL 6, Abort trap: 6, by zsh');
		expect(message).toContain(`thread 0, ${CRASH_FRAMES_IN_MESSAGE} of 17 frames:`);
	});

	it('names an unsymbolicated frame by its image and offset', () => {
		const [header, ...body] = SEGV.split('\n');
		const parsed = JSON.parse(body.join('\n'));
		parsed.threads[0].frames[0] = { imageIndex: 13, imageOffset: 2928 };
		const report = parseCrashReport(`${header}\n${JSON.stringify(parsed)}`);

		expect(report?.entry.message).toContain('  0 libsystem_kernel.dylib + 0xb70');
	});

	/**
	 * Rejected, not kept as an unparseable entry: a report that did not parse names no device, and
	 * answering it would be answering what may be a neighbour's crash (#323).
	 */
	it.each([
		['an empty file', ''],
		['a header with no body', SEGV.split('\n')[0] ?? ''],
		['a body that is not JSON', `${SEGV.split('\n')[0]}\n{ "pid": `],
		['a header that is not JSON', `not json\n${SEGV.slice(SEGV.indexOf('\n') + 1)}`],
	])('rejects %s', (_, text) => {
		expect(parseCrashReport(text)).toBeUndefined();
	});

	it('rejects a report that is not a crash', () => {
		expect(parseCrashReport(SEGV.replace('"bug_type":"309"', '"bug_type":"298"'))).toBeUndefined();
	});

	it('rejects a report whose capture time is not in the measured shape', () => {
		const shifted = SEGV.replace(
			'"captureTime" : "2026-10-06 15:27:47.1123 +0200"',
			'"captureTime" : "yesterday"',
		);
		expect(shifted).not.toBe(SEGV);
		expect(parseCrashReport(shifted)).toBeUndefined();
	});
});

describe('unifiedLogTimestampOf', () => {
	it('re-spells a capture time in the unified log’s own shape', () => {
		expect(unifiedLogTimestampOf('2026-10-06 15:27:47.1123 +0200')).toBe(
			'2026-10-06 15:27:47.112300+0200',
		);
		expect(unifiedLogTimestampOf('2026-01-02 03:04:05.1234567 -0500')).toBe(
			'2026-01-02 03:04:05.123456-0500',
		);
	});

	it('refuses anything else', () => {
		expect(unifiedLogTimestampOf('2026-10-06 15:27:47 +0200')).toBeUndefined();
		expect(unifiedLogTimestampOf('2026-10-06 15:27:47.1123+0200')).toBeUndefined();
	});
});
