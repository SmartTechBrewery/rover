import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { saysNothingToTerminate } from '@/backends/ios-simulator/parsers/app-control.js';

/**
 * The one wording this backend reads, against **captured** stderr rather than a string written
 * here — the whole reason a predicate over external output lives in `parsers/`
 * (`ai/CODING_STANDARDS.md`). Both captures are `simctl terminate` failures on the same host
 * minutes apart, so the negative case is a real refusal of the same subcommand rather than an
 * imagined one.
 *
 * No process, no simulator and no Xcode: this suite is two file reads and a substring test.
 */
const fixture = (name: string): string =>
	readFileSync(new URL(`../../../../fixtures/ios-simulator/${name}`, import.meta.url), 'utf8');

/** `terminate <booted> com.rover.nope` — exit 3, the app was not running. */
const NOT_RUNNING = fixture('simctl-terminate-not-running.xcode26.4.1-ios26.4.1.txt');

/** `terminate <shutdown> com.rover.nope` — exit 149, the device cannot be asked. */
const SHUTDOWN = fixture('simctl-terminate-shutdown.xcode26.4.1-ios26.4.1.txt');

describe('saysNothingToTerminate', () => {
	it('recognises the capture of an app that was not running', () => {
		expect(saysNothingToTerminate(NOT_RUNNING)).toBe(true);
	});

	/**
	 * The shape of the capture, asserted so the substring rule is a decision rather than a
	 * coincidence: the sentence appears on three of the six lines — bare on its own, and again
	 * inside each nested error — and which of them carries it is the tool's business.
	 */
	it('does not depend on which line of the capture carries it', () => {
		const carrying = NOT_RUNNING.split('\n').filter((line) =>
			line.includes('found nothing to terminate'),
		);

		expect(carrying).toHaveLength(3);
		for (const line of carrying) expect(saysNothingToTerminate(line)).toBe(true);
	});

	// The negative half, and a real one: a device that is not booted refuses the same command
	// with a different domain, a different code and no such sentence. It stays a failure.
	it('rejects a terminate that failed because the device is not booted', () => {
		expect(SHUTDOWN).toContain('Unable to lookup in current state: Shutdown');
		expect(saysNothingToTerminate(SHUTDOWN)).toBe(false);
	});

	it('rejects silence', () => {
		expect(saysNothingToTerminate('')).toBe(false);
	});
});
