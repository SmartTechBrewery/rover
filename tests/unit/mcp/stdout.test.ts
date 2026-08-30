/**
 * **stdout belongs to the protocol.**
 *
 * The stdio transport writes MCP frames on stdout, so one stray `console.log` from anywhere
 * under `src/mcp/` does not appear in front of a human — it corrupts a frame, and the agent
 * sees a protocol error whose cause is nowhere near where it surfaced. That is a
 * silent-corruption failure mode, which is exactly the class ai/TESTING.md gives a source-scan
 * gate rather than a convention: `no-sleep`, `no-platform-names` and `no-backend-in-a-client`
 * are its siblings, and this is a floor under the rule rather than a proof of it.
 *
 * It scans for the two shapes the mistake actually takes: a direct `console.log`, and an import
 * of anything under `src/cli/`, whose `_shared/output.ts` prints through one.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MCP_ROOT = fileURLToPath(new URL('../../../src/mcp', import.meta.url));

function mcpSources(): string[] {
	return readdirSync(MCP_ROOT, { withFileTypes: true, recursive: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
		.map((entry) => path.relative(MCP_ROOT, path.join(entry.parentPath, entry.name)));
}

function sourceOf(file: string): string {
	return readFileSync(path.join(MCP_ROOT, file), 'utf8');
}

/** Comments are stripped first, so this file's siblings stay free to *discuss* stdout. */
function code(file: string): string {
	return sourceOf(file)
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\/\/[^\n]*/g, '');
}

describe('nothing under src/mcp/ writes to stdout', () => {
	it('scans something, so a green run is not a vacuous one', () => {
		expect(mcpSources().length).toBeGreaterThan(0);
	});

	it('calls no console.log — diagnostics go to stderr', () => {
		const offenders = mcpSources().filter((file) => code(file).includes('console.log'));

		expect(offenders).toEqual([]);
	});

	it('imports nothing from src/cli/, whose output module prints through one', () => {
		const offenders = mcpSources().filter((file) =>
			[...code(file).matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].some(([, specifier]) =>
				path
					.normalize(path.join('mcp', path.dirname(file), specifier ?? ''))
					.startsWith(`cli${path.sep}`),
			),
		);

		expect(offenders).toEqual([]);
	});
});
