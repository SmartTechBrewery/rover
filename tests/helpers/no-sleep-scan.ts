/**
 * The no-sleep checks, as a function rather than assertions.
 *
 * The gate itself is `tests/unit/no-sleep.test.ts`, which walks `src/` and `tests/` and
 * runs this over every file. It lives here, one step away, for the same reason
 * `backend-conformance.ts` does: a check that returns violation strings can serve both the
 * repo-wide walk and `tests/unit/no-sleep-harness.test.ts`, which proves the gate against
 * one deliberate violation per rule rather than trusting a green run over a clean tree.
 *
 * **This scan is a floor, not a proof.** Comments are stripped before matching (below) and
 * the patterns are regexes over source text, so a determined re-implementation gets
 * through. What it does catch is the shape this repository keeps re-growing: a promisified
 * timer awaited *instead of* a check (ai/RULES.md §2, D12(b)).
 */

/**
 * The three files that may contain a delay, and why. Asserted to be exactly this list by
 * the gate — otherwise the next person adds a fourth entry to make their own file pass.
 */
export const NO_SLEEP_EXEMPT_FILES: readonly string[] = [
	// The wait vocabulary. The delay has to exist in exactly one place, and this is it.
	'src/core/wait.ts',
	// This file names the patterns it looks for.
	'tests/helpers/no-sleep-scan.ts',
	// Deliberate violations are its fixtures.
	'tests/unit/no-sleep-harness.test.ts',
];

interface SleepRule {
	readonly id: string;
	readonly pattern: RegExp;
	readonly why: string;
}

/**
 * A resolver passed straight to a timer, which is the only thing `setTimeout` can be doing
 * when its first argument is a bare name: `new Promise(resolve => setTimeout(resolve, ms))`.
 * A callback that *does* something — `setTimeout(() => reject(…), ms)` — is a deadline, the
 * opposite of a sleep, and deliberately not matched.
 */
const RESOLVER_NAMES = 'resolve|resolver|res|r|done|cb|callback|fulfil|fulfill';

const RULES: readonly SleepRule[] = [
	{
		id: 'promisified-timer',
		pattern: new RegExp(String.raw`(?<![.\w$])setTimeout\s*\(\s*(?:${RESOLVER_NAMES})\s*[,)]`, 'g'),
		why: 'a timer handed a bare resolver is a sleep; await the condition instead (src/core/wait.ts)',
	},
	{
		id: 'timers-promises',
		pattern: /['"](?:node:)?timers\/promises['"]/g,
		why: "'timers/promises' is the modern spelling of the same sleep; use src/core/wait.ts",
	},
	{
		id: 'scheduler-wait',
		pattern: /(?<![.\w$])scheduler\s*\.\s*wait\s*\(/g,
		why: 'scheduler.wait is a sleep by another name; use src/core/wait.ts',
	},
	{
		id: 'local-sleep-helper',
		pattern: /(?<![.\w$])(?:sleep|delay)\s*\(/g,
		why: 'a local sleep/delay helper re-grows the thing the rule forbids; use src/core/wait.ts',
	},
	{
		id: 'atomics-wait',
		pattern: /(?<![.\w$])Atomics\s*\.\s*wait\s*\(/g,
		why: 'Atomics.wait blocks the thread outright — a sleep with no timer at all',
	},
	{
		id: 'shell-sleep',
		// Comments are already gone, so what is left is a string or a template literal.
		pattern: /(?<![.\w$-])sleep\s+[\d.]/g,
		why: 'a sleep that left the process is still a sleep; wait on what the command changes',
	},
];

/**
 * Every violation in one file, empty when there are none.
 *
 * `relativePath` is repo-relative and appears in each message with the line number, so a
 * red suite is actionable without opening this file.
 */
export function findSleepViolations(relativePath: string, source: string): string[] {
	const stripped = stripComments(source);
	const violations: string[] = [];

	for (const rule of RULES) {
		rule.pattern.lastIndex = 0;
		for (const match of stripped.matchAll(rule.pattern)) {
			const line = lineOf(stripped, match.index);
			violations.push(`${relativePath}:${line}: [${rule.id}] '${match[0].trim()}' — ${rule.why}`);
		}
	}

	return violations.sort();
}

/**
 * Blank every comment, character for character, leaving newlines in place.
 *
 * Same length in, same length out, so a match offset still maps to its original line. The
 * strip is what lets this repository's comments keep *discussing* sleeping — six of them
 * do, and they are the most valuable lines in their files (`src/daemon/listen.ts`,
 * `src/daemon/connect.ts`, `src/ipc/client.ts`, and two test headers).
 *
 * Regex literals are not tracked, so a `//` inside one blanks the rest of its line. That
 * costs a missed violation, never a false one — the floor this file's header describes.
 */
export function stripComments(source: string): string {
	const out = source.split('');
	let index = 0;

	while (index < source.length) {
		const span = spanAt(source, index);
		if (span.isComment) {
			for (let at = index; at < span.end; at += 1) {
				if (out[at] !== '\n') out[at] = ' ';
			}
		}
		index = span.end;
	}

	return out.join('');
}

/** Where the construct starting at `index` ends, and whether it was a comment. */
function spanAt(
	source: string,
	index: number,
): { readonly isComment: boolean; readonly end: number } {
	const opener = source.slice(index, index + 2);
	if (opener === '//') {
		const end = source.indexOf('\n', index);
		return { isComment: true, end: end === -1 ? source.length : end };
	}
	if (opener === '/*') {
		const end = source.indexOf('*/', index + 2);
		return { isComment: true, end: end === -1 ? source.length : end + 2 };
	}
	const char = source[index];
	if (char === "'" || char === '"' || char === '`') {
		return { isComment: false, end: endOfString(source, index, char) + 1 };
	}
	return { isComment: false, end: index + 1 };
}

/** The index of the closing quote for the string opened at `start`, or the end of source. */
function endOfString(source: string, start: number, quote: string): number {
	for (let at = start + 1; at < source.length; at += 1) {
		if (source[at] === '\\') {
			at += 1;
		} else if (source[at] === quote) {
			return at;
		} else if (source[at] === '\n' && quote !== '`') {
			// An unterminated quote on one line is not a string; stop rather than swallow the file.
			return at - 1;
		}
	}
	return source.length;
}

function lineOf(source: string, offset: number): number {
	let line = 1;
	for (let at = 0; at < offset; at += 1) {
		if (source[at] === '\n') line += 1;
	}
	return line;
}
