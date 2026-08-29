import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	findSleepViolations,
	NO_SLEEP_EXEMPT_FILES,
	NO_SLEEP_PAUSE_CALLERS,
} from '../helpers/no-sleep-scan.js';

/**
 * The headline acceptance criterion of D12(b), as an executable gate: **there is not a
 * single sleep in this repository.**
 *
 * ai/RULES.md §2 has said so since before there was anything to enforce it, and the four
 * hand-rolled delays this change consolidated are what a rule with no gate turns into. The
 * checks themselves live in `tests/helpers/no-sleep-scan.ts` and are proved against
 * deliberate violations by `no-sleep-harness.test.ts`; this file is only the walk.
 *
 * Both trees, not just `src/`: a test that waits on a duration is the flaky one somebody
 * else's machine finds, and it is where the sleeps in this repository actually were.
 */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCANNED_ROOTS = ['src', 'tests'];

function collectSourceFiles(root: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(path.join(REPO_ROOT, root), { withFileTypes: true })) {
		const relative = `${root}/${entry.name}`;
		if (entry.isDirectory()) {
			found.push(...collectSourceFiles(relative));
		} else if (entry.isFile() && entry.name.endsWith('.ts')) {
			found.push(relative);
		}
	}
	return found;
}

function scannedFiles(): string[] {
	return SCANNED_ROOTS.flatMap(collectSourceFiles).filter(
		(file) => !NO_SLEEP_EXEMPT_FILES.includes(file),
	);
}

function read(relative: string): string {
	return readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

describe('nothing in this repository sleeps', () => {
	it('finds no forbidden delay in any .ts file outside the three exempt ones', () => {
		const offences = scannedFiles().flatMap((file) => findSleepViolations(file, read(file)));

		expect(offences).toEqual([]);
	});

	it('scans something, so a broken walk cannot pass silently', () => {
		expect(scannedFiles().length).toBeGreaterThan(10);
	});

	it('exempts exactly three files, so nobody quietly adds a fourth', () => {
		expect([...NO_SLEEP_EXEMPT_FILES]).toEqual([
			'src/core/wait.ts',
			'tests/helpers/no-sleep-scan.ts',
			'tests/unit/no-sleep-harness.test.ts',
		]);
	});

	it('still finds a delay in the wait vocabulary, so its exemption outlives nothing', () => {
		// A stale allowlist entry is the failure mode a scan gate dies of: the exemption has to
		// keep being needed, or it is protecting a file that no longer earns it.
		expect(findSleepViolations('src/core/wait.ts', read('src/core/wait.ts'))).not.toEqual([]);
	});

	it('lets exactly five files call pause, so a sixth has to argue for itself', () => {
		expect([...NO_SLEEP_PAUSE_CALLERS]).toEqual([
			'src/daemon/connect.ts',
			'src/daemon/listen.ts',
			'tests/helpers/daemon-socket.ts',
			'tests/unit/daemon/restore-lifecycle.test.ts',
			'tests/unit/core/wait.test.ts',
		]);
	});

	it.each(NO_SLEEP_PAUSE_CALLERS)('%s still calls pause, so its entry outlives nothing', (file) => {
		// Same staleness check as the one above: a caller that stopped needing a gap should lose
		// its entry rather than leave the gate blind to the next pause added to that file.
		expect(read(file)).toMatch(/(?<![.\w$])pause\s*\(/);
	});
});
