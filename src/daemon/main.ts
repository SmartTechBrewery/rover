/**
 * The daemon entrypoint — `npm run daemon`, and what `connectToLocalDaemon` spawns.
 *
 * Losing the bind is a **success**: it means another daemon is already serving the path,
 * which is exactly what the caller wanted, so this process exits 0 and says nothing. That
 * is what makes three concurrent first calls produce one daemon rather than an error and
 * two retries.
 *
 * **This entrypoint is where the core is loaded** (D19, R21). The side-effect import below is
 * what fills the device backend registry in the process that owns the devices and executes
 * the verbs — a daemon without it answers an empty device list and refuses every acquire.
 *
 * It belongs here and not in `./listen.js`, deliberately: `tests/unit/daemon/` calls
 * `startDaemon()` in-process with a backend it registered by hand, and pulling the barrel
 * into the module that binds the socket would put a live device watch behind every one of
 * those suites. The entrypoint is the one place that unambiguously means "this process is a
 * host".
 */

// Side-effect import — see the header. Kept above the local imports and never re-ordered
// into a type-only one: what this line does is run every backend's registration.
import '../backends/index.js';
import { startDaemon } from './listen.js';
import { resolveSocketPath } from './socket-path.js';

async function main(): Promise<void> {
	const socketPath = resolveSocketPath();
	const daemon = await startDaemon({ socketPath });
	if (!daemon.started) {
		return;
	}

	let shuttingDown = false;
	const shutdown = async (): Promise<void> => {
		if (shuttingDown) {
			return;
		}
		shuttingDown = true;
		try {
			await daemon.close();
			process.exit(0);
		} catch {
			process.exit(1);
		}
	};

	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	// Nothing else to do: the listening server is an open handle, so the process stays alive
	// on it until a signal arrives. No keepalive timer, and no `process.exit` on a
	// connection error — one client's broken transport must not end the host.
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
