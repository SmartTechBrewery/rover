import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D19's headline criterion, as an executable gate: **no client process can reach a device
 * backend.**
 *
 * Rover is a device host and agents borrow from it across the network (D17), so the process
 * that runs the verbs is the one holding the hardware. The failure this catches is not
 * somebody typing a tool's name into a client — `tests/unit/no-platform-names.test.ts`
 * already forbids that — it is an *import*: one convenience helper pulled into a client for
 * a type or a constant, dragging the barrel and every backend behind it. At that point a
 * client can drive a device directly, two hosts can grant a lease on the same one, and both
 * report success.
 *
 * So this walks the module graph from each client entrypoint and asserts the reachable set
 * contains nothing under `src/backends/`. A static walk, self-contained, no new dependency —
 * the family `no-platform-names.test.ts` and `remote-never-spawns.test.ts` belong to.
 *
 * One consequence is worth stating rather than leaving a reader to wonder: `src/ipc/` imports
 * schemas from `src/verbs/`, so every client now has the verb layer in its graph. That is
 * intended — a client parses an `ActionResult` with the schema the host produced it from —
 * and `src/verbs/` reaches `src/core/` only. The first assertion below is what keeps that
 * true, rather than this paragraph.
 *
 * That consequence is also why this walks for a **second** thing: a module that starts a
 * process. Everything a verb might reach for outside `src/backends/` — a decoder for a
 * recording, say — is invisible to the first assertion, and lands in every client's graph
 * through the same edge. `tests/unit/daemon/remote-never-spawns.test.ts` names which files may
 * spawn; only a walk can say none of them is reachable from a client.
 */

/**
 * Every module a client process starts from.
 *
 * `src/cli/` (R10) and `src/mcp/` (R19) are added here in the change that creates them — an
 * entrypoint absent from this list is a client nothing checks, which is why the list is
 * asserted to be non-empty and every file on it asserted to exist.
 */
const CLIENT_ENTRYPOINTS = ['cli/index.ts'];

/** The only modules that may import the backend barrel: the process that hosts devices. */
const BARREL_IMPORTERS = ['daemon/main.ts'];

const SRC_ROOT = fileURLToPath(new URL('../../src', import.meta.url));
const BARREL = 'backends/index.ts';

/** The one spawning module a client is *meant* to reach: autostart lives there (D5). */
const ALLOWED_TO_SPAWN_FROM_A_CLIENT = path.normalize('daemon/connect.ts');

function sourceFiles(): string[] {
	return readdirSync(SRC_ROOT, { withFileTypes: true, recursive: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
		.map((entry) => path.relative(SRC_ROOT, path.join(entry.parentPath, entry.name)));
}

/**
 * The `src/`-relative modules `file` imports directly.
 *
 * Only relative specifiers, because those are the only ones that can reach another module in
 * this tree, and `.js` is rewritten to `.ts` — the source says the extension the emitted code
 * will have (NodeNext), and the file on disk is the TypeScript one.
 */
function importsOf(file: string): string[] {
	const source = readFileSync(path.join(SRC_ROOT, file), 'utf8');
	const found: string[] = [];
	// Covers `import x from '…'`, `import type { y } from '…'` and the bare side-effect
	// `import '…'` the barrel is pulled in with — which is the one that matters most here.
	for (const [, specifier] of source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)) {
		if (specifier === undefined || !specifier.startsWith('.')) {
			continue;
		}
		found.push(path.normalize(path.join(path.dirname(file), specifier.replace(/\.js$/, '.ts'))));
	}
	return found;
}

/**
 * Every module reachable from `entry`, each mapped to how it was reached.
 *
 * The path is kept because "a client can reach a backend" without the edge that made it true
 * is a bug report nobody can act on.
 */
function reachableFrom(entry: string): Map<string, string[]> {
	const reached = new Map<string, string[]>([[entry, [entry]]]);
	const queue = [entry];

	while (queue.length > 0) {
		const file = queue.shift();
		if (file === undefined) {
			continue;
		}
		const via = reached.get(file) ?? [file];
		for (const next of importsOf(file)) {
			if (reached.has(next) || !existsSync(path.join(SRC_ROOT, next))) {
				continue;
			}
			reached.set(next, [...via, next]);
			queue.push(next);
		}
	}

	return reached;
}

function backendsReachedFrom(entry: string): string[] {
	return [...reachableFrom(entry)]
		.filter(([file]) => file.startsWith(`backends${path.sep}`))
		.map(([, via]) => `${entry} reaches ${via[via.length - 1]} via ${via.join(' → ')}`);
}

/**
 * The same walk, for the other thing a client must not be able to do: start a process.
 *
 * `tests/unit/daemon/remote-never-spawns.test.ts` names the files that may spawn; this says
 * none of them is *reachable* from a client, which is the half a file list cannot state. The
 * two are not the same claim — every module here is outside `src/backends/`, so the first
 * assertion in this suite passes over a client that has `node:child_process` in its graph. It
 * is the walk that catches it, and what it catches is real: `src/ipc/verb-methods.ts` imports
 * the verb schemas, so a decoder or a device tool run from anywhere under `src/verbs/` puts a
 * spawn in every CLI.
 *
 * `daemon/connect.ts` is the one exception, and it is D5 itself: the local socket client
 * starts a daemon when nothing answers, which is exactly what makes `rover` usable without
 * starting anything by hand.
 */
function spawnersReachedFrom(entry: string): string[] {
	return [...reachableFrom(entry)]
		.filter(
			([file]) =>
				file !== ALLOWED_TO_SPAWN_FROM_A_CLIENT &&
				readFileSync(path.join(SRC_ROOT, file), 'utf8').includes("'node:child_process'"),
		)
		.map(([, via]) => `${entry} reaches ${via[via.length - 1]} via ${via.join(' → ')}`);
}

describe('no client process can reach a device backend', () => {
	it('finds nothing under src/backends/ in any client entrypoint’s module graph', () => {
		expect(CLIENT_ENTRYPOINTS.flatMap(backendsReachedFrom)).toEqual([]);
	});

	it('finds no module that starts a process in a client’s graph either, bar autostart', () => {
		expect(CLIENT_ENTRYPOINTS.flatMap(spawnersReachedFrom)).toEqual([]);
	});

	it('lets only the device host import the backend barrel', () => {
		const importers = sourceFiles().filter((file) => importsOf(file).includes(BARREL));

		expect(importers.sort()).toEqual([...BARREL_IMPORTERS].sort());
	});

	it('names entrypoints that exist, so a rename cannot silently empty the gate', () => {
		expect(CLIENT_ENTRYPOINTS.length).toBeGreaterThan(0);
		for (const file of [...CLIENT_ENTRYPOINTS, ...BARREL_IMPORTERS]) {
			expect(existsSync(path.join(SRC_ROOT, file))).toBe(true);
		}
	});

	it('reaches src/backends/ from the daemon entrypoint, so a green walk is not a vacuous one', () => {
		// The positive control. Without it a walker that silently resolves nothing passes the
		// first assertion by never looking at anything — the same trap `no-platform-names.test.ts`
		// guards with its "scans something" test.
		expect(backendsReachedFrom('daemon/main.ts').length).toBeGreaterThan(0);
		expect(spawnersReachedFrom('daemon/main.ts').length).toBeGreaterThan(0);
	});
});
