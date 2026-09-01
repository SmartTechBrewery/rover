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
 *
 * **One file in `src/` is exempt, and it is exempt for that same reason rather than despite
 * it.** `src/cli/init/documents.ts` contains no logic — it is the text of `ROVER.md` and of the
 * agent-file snippet `rover init` writes into somebody else's repository, which is prose in the
 * category `PROJECT.md` and `ai/` are in and happens to be stored as string literals so it can
 * be interpolated and unit-tested. What it names the platform for is the **prohibition**: the
 * whole force of that snippet is telling an agent not to reach past the lease for the device's
 * own command-line tool, and an agent told to avoid "the platform's own tooling" routes around
 * the vagueness the first time it is in a hurry. D10 is untouched by it — no verb is named after
 * a platform there, nothing branches on one, and no capability is explained by one.
 *
 * Keep the hole this size. It is one path, not a directory: `src/cli/init/detect.ts` sits beside
 * it recognising a build system and passes this gate unchanged, which is the evidence that the
 * exemption is about prose rather than about the `init` command.
 */
const PLATFORM_NAMES =
	/\b(android|ios|iphone|ipad|adb|simctl|xcrun|uiautomator|emulator|espresso)\b/i;

const SRC_ROOT = fileURLToPath(new URL('../../src', import.meta.url));
const BACKENDS_ROOT = path.join(SRC_ROOT, 'backends');

/** The one exempt file — see this module's header. `src/`-relative, and asserted to exist. */
const PROSE = path.normalize('cli/init/documents.ts');

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
			if (relative === PROSE) {
				continue;
			}
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

	// An exemption for a file that has moved or gone is an exemption nobody is reading, and the
	// next file to want one gets there by copying this list rather than by arguing for itself.
	it('exempts a file that is really there', () => {
		expect(
			collectSharedSourceFiles(SRC_ROOT).map((file) => path.relative(SRC_ROOT, file)),
		).toContain(PROSE);
	});
});
