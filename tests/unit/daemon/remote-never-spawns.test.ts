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
	//
	// The second one is that tripwire working as intended (#171): finding the bridge means
	// asking a candidate for its version, which is a process. It starts no daemon either, it
	// runs bounded and once per daemon lifetime, and it is the reason the runner beside it can
	// name a file instead of a bare program name.
	'backends/android/adb-path.ts',
	'backends/android/adb.ts',
	// The fourth is the same platform's second program (#249), and it is the one entry on this
	// list whose child is **deliberately unbounded**: `idb_companion --notify` is a change stream
	// that is supposed to stay open, so a timeout there would guarantee the failure a timeout
	// exists to prevent. That is a lifetime, not a privilege — it starts no daemon, the argv is
	// its caller's, and `backends/ios-simulator/backend.ts` is what supervises the process and
	// restarts it on a backoff. Its own search needs no entry either, for the reason below.
	// The fifth is that platform's installer, and it is on this list for the one thing it runs:
	// `tar`, over a release it has just checksummed, bounded by a timeout and once per install
	// (`backends/ios-simulator/idb-companion-install.ts`). It starts no daemon and no companion,
	// and it is reached only from `install_host_tool`, which is an operator asking for it by name
	// with an actor attached (D28). Unpacking through the platform's own program rather than a
	// bundled tar library is deliberate: an archive extractor is the classic place a path-traversal
	// entry escapes the directory it was meant to land in, and macOS' `tar` is the one both this
	// project and its operators already trust with that.
	'backends/ios-simulator/idb-companion-install.ts',
	'backends/ios-simulator/idb-companion.ts',
	// The third is the second platform's runner (#214), added here deliberately as this list
	// intends: it runs one `simctl` and waits for it, bounded by a timeout, and it starts no
	// daemon. Its own search needs no entry — `backends/ios-simulator/developer-dir.ts` verifies
	// a candidate by asking the filesystem rather than by running it, which is the one deliberate
	// departure from `adb-path.ts` and the property that lets a machine with no Xcode import it —
	// and `backends/ios-simulator/idb-companion-path.ts` keeps that property for the same reason.
	'backends/ios-simulator/simctl.ts',
	// The client-side foreground start (`rover server`, `rover panel`): one process, spawned
	// because somebody typed the command, attached to their terminal and killed with it. It starts
	// no daemon *behind* anyone, which is what this gate is about — the daemon it can start is the
	// one the operator asked for, in front of them.
	'cli/_shared/foreground.ts',
	'daemon/connect.ts',
	// Slicing a recording into frames needs a decoder this tree does not contain, so the host
	// drives one. It starts no daemon either — it runs one program over bytes already in
	// memory — and it lives under `src/daemon/` rather than in the verb layer precisely so that
	// this list stays true of every client: `src/ipc/verb-methods.ts` imports the verb schemas,
	// so a spawn under `src/verbs/` would be a spawn in a CLI's module graph.
	'daemon/frames.ts',
	// A project's own teardown hook (D13) is the operator's program, run on the host where the
	// device is (D19) — a hook stranded on the client's machine could not stop the helper
	// service it started. It starts no daemon either: it runs what one hook file declares and
	// waits for it, bounded, with `shell: false`. It sits beside the frame extractor rather
	// than in `daemon/restore.ts` because `daemon/lease-handlers.ts` imports that one, and
	// beside `daemon/project-hooks.ts` rather than inside it because reading a hook file must
	// stay importable from anywhere.
	'daemon/hook-command.ts',
	// A second entry beside `daemon/frames.ts`, and the same program behind it: normalising a
	// recording into a file that plays needs an encoder this tree does not contain either
	// (#185). It is a separate file rather than a second function in that one because the two
	// runs differ in the thing this list is about — the normaliser writes a host temp file,
	// which an mp4 muxer requires and a PNG stream does not — and it lives under `src/daemon/`
	// for the identical reason: a spawn under `src/verbs/` would be a spawn in a CLI's module
	// graph.
	'daemon/normalise.ts',
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
