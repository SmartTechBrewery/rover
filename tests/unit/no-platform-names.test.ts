import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The headline acceptance criterion of issue #2, as an executable gate: **no file
 * outside `src/backends/` contains a platform name.**
 *
 * Rover's value proposition is one set of verbs across platforms (PROJECT.md D10), and
 * that survives exactly as long as nobody branches on the platform outside a backend's
 * own folder (ai/RULES.md §2). The failure this catches is rarely an `if` — it is a doc
 * comment that explains a capability by naming the platform it is missing on, which
 * reads as harmless and is how the vocabulary leaks into shared code in the first place.
 * Phrase the explanation neutrally and cite PROJECT.md §5 for the specifics.
 *
 * External tool names count: naming the command a backend drives names its platform just
 * as surely, and it is also the assumption ai/ARCHITECTURE.md forbids — that a backend is
 * one external program.
 *
 * Scoped to `src/`. `PROJECT.md`, everything under `ai/`, and this file itself must name
 * platforms to say anything at all; `src/` outside `src/backends/` is the shared code the
 * rule is about.
 */
const PLATFORM_NAMES =
	/\b(android|ios|iphone|ipad|adb|simctl|xcrun|uiautomator|emulator|espresso)\b/i;

const SRC_ROOT = fileURLToPath(new URL('../../src', import.meta.url));
const BACKENDS_ROOT = path.join(SRC_ROOT, 'backends');

function collectSharedSourceFiles(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (full === BACKENDS_ROOT) continue;
			found.push(...collectSharedSourceFiles(full));
		} else if (entry.isFile() && entry.name.endsWith('.ts')) {
			found.push(full);
		}
	}
	return found;
}

describe('shared code names no platform', () => {
	it('finds no platform name in any .ts file outside src/backends/', () => {
		const offences: string[] = [];

		for (const file of collectSharedSourceFiles(SRC_ROOT)) {
			const relative = path.relative(SRC_ROOT, file);
			for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
				const match = PLATFORM_NAMES.exec(line);
				if (match) {
					offences.push(`src/${relative}:${index + 1}: '${match[1]}' in: ${line.trim()}`);
				}
			}
		}

		expect(offences).toEqual([]);
	});

	it('scans something, so a broken walk cannot pass silently', () => {
		expect(collectSharedSourceFiles(SRC_ROOT).length).toBeGreaterThan(0);
	});
});
