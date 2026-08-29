/**
 * The no-sleep gate proved rather than trusted.
 *
 * `no-sleep.test.ts` runs `findSleepViolations` over a tree that is green, so on its own it
 * cannot tell a working scan from one whose regexes stopped matching anything — the exact
 * way a source-scan gate dies. This file runs the same checks over synthetic sources: one
 * deliberate violation per rule, and a passing sample for every timer shape the repository
 * legitimately uses.
 *
 * **This file is one of the three the gate exempts** (`NO_SLEEP_EXEMPT_FILES`), because its
 * fixtures are the violations. Same arrangement as
 * `tests/unit/backends/conformance-harness.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
	findSleepViolations,
	NO_SLEEP_PAUSE_CALLERS,
	stripComments,
} from '../helpers/no-sleep-scan.js';

/** One deliberate violation each, with the rule id the scan must report it under. */
const FORBIDDEN: ReadonlyArray<readonly [name: string, ruleId: string, source: string]> = [
	[
		'a promisified timer',
		'promisified-timer',
		'function nap(ms: number) {\n\treturn new Promise((resolve) => setTimeout(resolve, ms));\n}\n',
	],
	[
		'an import from node:timers/promises',
		'timers-promises',
		"import { setTimeout as after } from 'node:timers/promises';\n",
	],
	[
		'a scheduler wait',
		'scheduler-wait',
		'async function go() {\n\tawait scheduler.wait(500);\n}\n',
	],
	[
		'a local sleep helper call',
		'local-sleep-helper',
		'async function go() {\n\tawait sleep(500);\n}\n',
	],
	[
		'a blocking Atomics wait',
		'atomics-wait',
		'function go() {\n\tAtomics.wait(view, 0, 0, 500);\n}\n',
	],
	[
		'a shell sleep inside a string',
		'shell-sleep',
		"function go() {\n\treturn execSync('sleep 5');\n}\n",
	],
	[
		'a pause from a file that is not on the allowlist',
		'unlisted-pause',
		"import { pause } from '@/core/wait.js';\n\nasync function go() {\n\tawait pause(500);\n}\n",
	],
];

/** Every timer shape the repository legitimately uses. None of these is a sleep. */
const PERMITTED: ReadonlyArray<readonly [name: string, source: string]> = [
	[
		'a deadline timer that rejects',
		"const expiry = new Promise((_resolve, reject) => {\n\tconst timer = setTimeout(() => reject(new Error('too slow')), limitMs);\n\ttimer.unref();\n});\n",
	],
	[
		'a deadline timer that resolves a race marker',
		"const expiry = new Promise((resolve) => {\n\ttimer = setTimeout(() => resolve('timed-out'), limitMs);\n});\n",
	],
	[
		'a backoff timer that does work',
		'restart = setTimeout(() => {\n\trestart = null;\n\tif (!stopped) start();\n}, backoffMs);\n',
	],
	['a repeating sweep', 'const sweep = setInterval(() => leases.sweep(), sweepIntervalMs);\n'],
	[
		'a socket read timeout',
		"socket.setTimeout(timeoutMs, () => settle({ outcome: 'timeout' }));\n",
	],
	['an immediate yield', 'await new Promise((resolve) => setImmediate(resolve));\n'],
	[
		'a comment discussing sleeping',
		'// Not a sleep: this awaits the condition rather than sleep(500) or a shell sleep 2.\n/* Nor is it Atomics.wait(view, 0, 0, 500) — see src/core/wait.ts. */\nconst x = 1;\n',
	],
	[
		'a string that merely mentions sleeping',
		"const why = 'the daemon must never sleep while a lease is live';\n",
	],
];

describe('the no-sleep scan catches what it claims to', () => {
	it.each(FORBIDDEN)('reports %s', (_name, ruleId, source) => {
		const violations = findSleepViolations('sample.ts', source);

		expect(violations).toHaveLength(1);
		expect(violations[0]).toContain(`[${ruleId}]`);
		// The line number is what makes a red suite actionable without opening the scanner.
		expect(violations[0]).toMatch(/^sample\.ts:\d+: /);
	});

	it('names the line the violation is on, not the first line of the file', () => {
		const source = 'const a = 1;\nconst b = 2;\nawait sleep(10);\n';

		expect(findSleepViolations('sample.ts', source)).toEqual([
			expect.stringContaining('sample.ts:3: [local-sleep-helper]'),
		]);
	});

	it('reports every violation in a file, not just the first', () => {
		const source = "await sleep(10);\nAtomics.wait(view, 0, 0, 5);\nexecSync('sleep 5');\n";

		expect(findSleepViolations('sample.ts', source)).toHaveLength(3);
	});
});

describe('the no-sleep scan leaves the permitted shapes alone', () => {
	it.each(PERMITTED)('allows %s', (_name, source) => {
		expect(findSleepViolations('sample.ts', source)).toEqual([]);
	});

	it.each(NO_SLEEP_PAUSE_CALLERS)('allows a pause in %s, which says why it needs one', (file) => {
		expect(findSleepViolations(file, 'await pause(50);\n')).toEqual([]);
	});

	it('allows a pause on the allowlist without allowing that file a real sleep', () => {
		// The exemption is per rule, not per file — that is the whole difference between this
		// list and `NO_SLEEP_EXEMPT_FILES`, and a file-wide skip would silently undo the gate
		// for five files.
		const violations = findSleepViolations(
			NO_SLEEP_PAUSE_CALLERS[0],
			'await pause(50);\nawait new Promise((resolve) => setTimeout(resolve, 50));\n',
		);

		expect(violations).toEqual([expect.stringContaining('[promisified-timer]')]);
	});
});

describe('stripComments', () => {
	it('blanks comments without moving any line', () => {
		const stripped = stripComments('const a = 1; // await sleep(1)\nconst b = 2;\n');

		expect(stripped.split('\n')).toHaveLength(3);
		expect(stripped.split('\n')[0]).toBe('const a = 1;'.padEnd(30, ' '));
	});

	it('leaves a comment marker inside a string alone', () => {
		const source = "const url = 'https://example.test/x';\nawait sleep(1);\n";

		expect(findSleepViolations('sample.ts', source)).toHaveLength(1);
	});
});
