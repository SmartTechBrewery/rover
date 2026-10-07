import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runAsRefusal } from '@/backends/android/parsers/run-as.js';

/**
 * `run-as`'s refusals, against captures rather than against what it is remembered to print —
 * which packages it refuses, and how it words each, is the thing `pull_app_file` turns into a
 * named refusal instead of an empty file (#334).
 */
const fixture = (name: string): string =>
	readFileSync(new URL(`../../../../fixtures/adb/${name}`, import.meta.url), 'utf8');

describe('runAsRefusal', () => {
	it('reads a release build’s refusal as not-debuggable', () => {
		expect(
			runAsRefusal(fixture('run-as.not-debuggable.stderr.api37-sdk-gphone16k-arm64.txt')),
		).toBe('not-debuggable');
	});

	it('reads a package nobody installed as unknown-package', () => {
		expect(
			runAsRefusal(fixture('run-as.unknown-package.stderr.api37-sdk-gphone16k-arm64.txt')),
		).toBe('unknown-package');
	});

	it('reads a package running as a system user as not-an-application', () => {
		expect(
			runAsRefusal(fixture('run-as.not-an-application.stderr.api37-sdk-gphone16k-arm64.txt')),
		).toBe('not-an-application');
	});

	it.each([
		['the stat of a file', fixture('run-as-stat.file.api37-sdk-gphone16k-arm64.txt')],
		[
			'a missing file, read back over exec-out',
			fixture('run-as-cat.missing.api37-sdk-gphone16k-arm64.txt'),
		],
		['nothing', ''],
	])('finds no refusal in %s', (_what, stream) => {
		expect(runAsRefusal(stream)).toBeNull();
	});
});
