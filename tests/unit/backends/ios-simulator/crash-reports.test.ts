import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	CRASH_REPORTS_RELATIVE_PATH,
	MAX_CRASH_REPORT_BYTES,
	readCrashReports,
} from '@/backends/ios-simulator/crash-reports.js';
import { parseDeviceSerial } from '@/core/ids.js';

/**
 * The crash stream's reader over a temp home directory holding the two captures
 * (`tests/fixtures/ios-simulator/README.md`): Settings crashed on `THIS` at
 * 2026-10-06 15:27:47.1123 +0200, and on `OTHER` — a second simulator of the same host — at
 * 15:28:32.7841 +0200. Nothing here needs a simulator or Xcode.
 */
const THIS = parseDeviceSerial('88D8476E-F4A4-4A18-A89B-0C47E077CC8B');
const OTHER = parseDeviceSerial('D85C3449-4D0C-4E93-B8EC-77FD0E5A8F3F');

/** `THIS` capture's `captureTime` and the moment its file was written, as host epoch ms. */
const THIS_CAPTURED_MS = Date.parse('2026-10-06T13:27:47.112Z');
const THIS_WRITTEN_MS = Date.parse('2026-10-06T13:28:10Z');

const SEGV = 'crash-report.sigsegv.xcode27.0-ios26.5.ips';
const ABRT = 'crash-report.sigabrt-other-device.xcode27.0-ios26.5.ips';

function capture(name: string): Promise<string> {
	return readFile(new URL(`../../../fixtures/ios-simulator/${name}`, import.meta.url), 'utf8');
}

let home: string;
let reports: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), 'rover-crash-reports-'));
	reports = join(home, CRASH_REPORTS_RELATIVE_PATH);
	await mkdir(reports, { recursive: true });
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

/** One report in the directory, its `mtime` set to when the capture's file was written. */
async function place(name: string, text: string, writtenMs = THIS_WRITTEN_MS): Promise<void> {
	const path = join(reports, name);
	await writeFile(path, text);
	await utimes(path, writtenMs / 1000, writtenMs / 1000);
}

describe('readCrashReports', () => {
	it('answers this device’s crash captured after the bound', async () => {
		await place('Preferences-2026-10-06-152809.ips', await capture(SEGV));

		const entries = await readCrashReports(THIS, THIS_CAPTURED_MS - 1_000, { home });

		expect(entries).toEqual([
			expect.objectContaining({
				pid: 82924,
				level: 'fatal',
				timestamp: '2026-10-06 15:27:47.112300+0200',
			}),
		]);
	});

	/** The leak #323 exists to prevent: the same host, the same app, a different simulator. */
	it('never answers another simulator’s crash', async () => {
		await place('Preferences-2026-10-06-152833.ips', await capture(ABRT));

		expect(await readCrashReports(THIS, THIS_CAPTURED_MS - 1_000, { home })).toEqual([]);
		expect(await readCrashReports(OTHER, THIS_CAPTURED_MS - 1_000, { home })).toEqual([
			expect.objectContaining({ pid: 83679 }),
		]);
	});

	it('never answers a report with no device named in it', async () => {
		const text = (await capture(SEGV)).replace(/\s*"coalitionName" : "[^"]*",/, '');
		await place('Preferences-2026-10-06-152809.ips', text);

		expect(await readCrashReports(THIS, THIS_CAPTURED_MS - 1_000, { home })).toEqual([]);
	});

	/**
	 * The previous lease holder's crash: the file was written after the bound but the crash was
	 * captured before it, so the capture time is what refuses it.
	 */
	it('never answers a crash captured before the bound, however recently it was written', async () => {
		await place('Preferences-2026-10-06-152809.ips', await capture(SEGV));

		expect(await readCrashReports(THIS, THIS_CAPTURED_MS + 1_000, { home })).toEqual([]);
	});

	it('skips a file written before the bound without reading it', async () => {
		// The capture itself, captured after the bound: were it read, it would be answered, so the
		// `mtime` is the only thing that can have refused it.
		await place(
			'Preferences-2026-10-06-152809.ips',
			await capture(SEGV),
			THIS_CAPTURED_MS - 60_000,
		);

		expect(await readCrashReports(THIS, THIS_CAPTURED_MS - 1_000, { home })).toEqual([]);
	});

	it('skips a file over the size bound', async () => {
		const text = await capture(SEGV);
		await place(
			'Preferences-2026-10-06-152809.ips',
			`${text}${' '.repeat(MAX_CRASH_REPORT_BYTES - Buffer.byteLength(text) + 1)}`,
		);

		expect(await readCrashReports(THIS, THIS_CAPTURED_MS - 1_000, { home })).toEqual([]);
	});

	it('reads only reports, never the other files beside them', async () => {
		await place('Preferences-2026-10-06-152809.diag', await capture(SEGV));
		await mkdir(join(reports, 'Retired', 'nested.ips'), { recursive: true });

		expect(await readCrashReports(THIS, THIS_CAPTURED_MS - 1_000, { home })).toEqual([]);
	});

	it('answers several crashes oldest first', async () => {
		const text = await capture(SEGV);
		await place('b.ips', text.replace('15:27:47.1123 +0200', '15:27:40.0000 +0200'));
		await place('a.ips', text.replace('"pid" : 82924', '"pid" : 1'));

		const entries = await readCrashReports(THIS, THIS_CAPTURED_MS - 60_000, { home });

		expect(entries.map((entry) => entry.timestamp)).toEqual([
			'2026-10-06 15:27:40.000000+0200',
			'2026-10-06 15:27:47.112300+0200',
		]);
	});

	it('answers no crashes when the host has no reports directory at all', async () => {
		await rm(reports, { recursive: true });

		expect(await readCrashReports(THIS, 0, { home })).toEqual([]);
	});
});
