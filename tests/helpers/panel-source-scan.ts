import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './no-sleep-scan.js';

/**
 * The panel's source tree, read once and handed to the gates in `tests/unit/panel/`.
 *
 * It lives here, one step away from them, for the same reason `no-sleep-scan.ts` and
 * `backend-conformance.ts` do: three gates walk the same tree, and the checks return
 * violation strings rather than asserting, so the walk and any harness over it share them.
 *
 * **These gates are floors, not proofs.** They are regexes over source text, so a determined
 * re-implementation gets through. What they catch is what this product keeps re-growing: a
 * hex code typed into a component, a looping animation, and test-framework vocabulary.
 */

const PANEL_SRC = fileURLToPath(new URL('../../panel/src', import.meta.url));

export interface PanelSource {
	/** Repo-relative, e.g. `panel/src/components/layout/sidebar.tsx`. */
	readonly path: string;
	readonly source: string;
	/**
	 * The same text with every comment blanked, same length in and same length out.
	 *
	 * The panel's comments have to stay free to *discuss* the words these gates forbid — the
	 * most valuable lines in `tokens.css` and `index.css` name the very traps being scanned
	 * for. `.css` files get the block-comment half of the same heuristic.
	 */
	readonly sourceWithoutComments: string;
}

function walk(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			found.push(...walk(full));
		} else if (entry.isFile()) {
			found.push(full);
		}
	}
	return found;
}

/** Blank `/* … *​/` runs in a stylesheet, preserving length and newlines. */
function stripCssComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '));
}

export function readPanelSources(): PanelSource[] {
	return walk(PANEL_SRC)
		.map((full) => {
			const source = readFileSync(full, 'utf8');
			const relative = `panel/src/${path.relative(PANEL_SRC, full).split(path.sep).join('/')}`;
			return {
				path: relative,
				source,
				sourceWithoutComments: relative.endsWith('.css')
					? stripCssComments(source)
					: stripComments(source),
			};
		})
		.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The panel's shipped sources — everything `readPanelSources` returns, minus the tests.
 *
 * A test file has to be free to *name* what its gate forbids: `sidebar.test.tsx` asserts that
 * `Analytics` and `Diagnostics` do not appear in the navigation, and would otherwise be its
 * own violation. Same reason `tests/unit/no-sleep-harness.test.ts` is exempt from the
 * no-sleep gate, and same limit: this exempts a *file*, so a gate that uses it is scanning
 * what ships rather than everything that exists.
 */
export function readShippedPanelSources(): PanelSource[] {
	return readPanelSources().filter((file) => !/\.test\.tsx?$/.test(file.path));
}

export function panelSourcePath(relative: string): string {
	return path.join(PANEL_SRC, relative);
}

/** The line a match at `offset` falls on, 1-based. */
export function lineOf(source: string, offset: number): number {
	return source.slice(0, offset).split('\n').length;
}
