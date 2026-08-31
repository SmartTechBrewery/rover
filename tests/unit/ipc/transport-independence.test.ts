import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The headline acceptance criterion of issue #6, as an executable gate: **nothing under
 * `src/ipc/` may touch a transport, a filesystem or a process.**
 *
 * D17 makes the network listener (R22) an added transport rather than a rewrite — and D29 makes
 * the HTTP surface a browser reaches (R32) a third one on the same terms — and that only holds
 * while the message surface cannot tell what it is speaking over. The way it
 * stops holding is not a redesign — it is one convenience import: a socket path resolved
 * "just for the default case", a `process.spawn` for autostart, a peer uid read off the
 * connection. Each is a line of code and each silently assumes the client stands on the
 * host's machine. Phase 2 owns all of them, in the transport module, not here.
 *
 * Mirrors `tests/unit/no-platform-names.test.ts`, which gates D10 the same way.
 */
const FORBIDDEN_MODULES = [
	'node:net',
	'node:fs',
	'node:child_process',
	'node:os',
	'node:tls',
	// The HTTP surface's two, added with it (R32): a `createServer` reached for "just to answer a
	// health check" is the same one convenience import as the others, and it would put a status
	// code — a second error vocabulary — inside the module that owns the only one.
	'node:http',
	'node:https',
];

const IPC_ROOT = fileURLToPath(new URL('../../../src/ipc', import.meta.url));

function ipcSourceFiles(): string[] {
	return readdirSync(IPC_ROOT, { withFileTypes: true, recursive: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
		.map((entry) => path.join(entry.parentPath, entry.name));
}

describe('the IPC surface is transport-agnostic', () => {
	it('imports no transport, filesystem or process module', () => {
		const offences: string[] = [];

		for (const file of ipcSourceFiles()) {
			const source = readFileSync(file, 'utf8');
			for (const forbidden of FORBIDDEN_MODULES) {
				if (source.includes(`'${forbidden}'`)) {
					offences.push(`src/ipc/${path.relative(IPC_ROOT, file)} imports ${forbidden}`);
				}
			}
		}

		expect(offences).toEqual([]);
	});

	it('scans something, so a broken walk cannot pass silently', () => {
		expect(ipcSourceFiles().length).toBeGreaterThan(0);
	});
});
