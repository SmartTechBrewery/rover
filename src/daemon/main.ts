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
import { resolveArtifactsRoot } from './archive-path.js';
import { startDaemon } from './listen.js';
import { resolveNetworkListener } from './network-config.js';
import { resolveSocketPath } from './socket-path.js';

async function main(): Promise<void> {
	const socketPath = resolveSocketPath();
	// The one place the archive root is read from the environment, for the socket path's
	// reason: `startDaemon` never consults `process.env`, so an in-process daemon in a test
	// cannot start writing into the developer's own `~/.rover/artifacts`.
	const artifactsRoot = resolveArtifactsRoot();
	// The one place the network listener is resolved from the environment. A missing token
	// beside a set port throws here, `main().catch` below prints it and the process exits 1 —
	// a misconfigured listener is a loud startup failure, never a host that quietly serves
	// only the local socket while its operator believes otherwise.
	const network = resolveNetworkListener();
	const daemon = await startDaemon({
		socketPath,
		artifactsRoot,
		...(network ? { network } : {}),
	});
	if (!daemon.started) {
		return;
	}

	if (daemon.networkPort !== null && network !== undefined) {
		// The address and the port, and nothing else: never the token, never the certificate,
		// and nothing about what is attached.
		console.log(`Rover is listening on ${network.address}:${daemon.networkPort} (TLS).`);
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
