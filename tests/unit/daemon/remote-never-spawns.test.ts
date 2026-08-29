import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D5's local-only half, as an executable gate: **only the unix-socket client may start a
 * daemon.**
 *
 * The daemon starts itself on the first call, and that is safe precisely because the spawn
 * sits inside the connect function for a socket on this machine. R22 adds a second
 * transport onto the same `createIpcClient`, and the way this stops holding is not a
 * redesign — it is one convenience refactor that lifts "connect, and start one if nothing
 * answers" into a shared helper, at which point a client can be talked into starting a
 * host across a network. A host reachable over the network is a service its operator runs.
 *
 * Mirrors `tests/unit/ipc/transport-independence.test.ts`, which gates D17 the same way.
 */
const ALLOWED_TO_SPAWN = [
	// A backend driving the device bridge is the other legitimate reason to hold a child
	// process, and it starts no daemon: it runs one command and waits for it. Kept as an
	// explicit file list rather than a directory exemption so this stays a tripwire —
	// a second backend file reaching for a process has to be added here deliberately.
	'backends/android/adb.ts',
	'daemon/connect.ts',
];

const SRC_ROOT = fileURLToPath(new URL('../../../src', import.meta.url));

function sourceFiles(): string[] {
	return readdirSync(SRC_ROOT, { withFileTypes: true, recursive: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
		.map((entry) => path.relative(SRC_ROOT, path.join(entry.parentPath, entry.name)));
}

function filesImportingChildProcess(): string[] {
	return sourceFiles().filter((file) =>
		readFileSync(path.join(SRC_ROOT, file), 'utf8').includes("'node:child_process'"),
	);
}

describe('only the local socket client can start a daemon', () => {
	it('imports node:child_process nowhere but the local connect path', () => {
		expect(filesImportingChildProcess().sort()).toEqual(ALLOWED_TO_SPAWN);
	});

	it('scans something, so a broken walk cannot pass silently', () => {
		expect(sourceFiles().length).toBeGreaterThan(0);
	});
});
