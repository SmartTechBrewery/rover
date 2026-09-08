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
import { resolveRetentionPolicy } from './archive-retention.js';
import { resolveKeptTestsPath } from './kept-tests.js';
import { startDaemon } from './listen.js';
import { resolveHttpListener, resolveNetworkListener } from './network-config.js';
import { resolveProjectsRoot } from './project-hooks.js';
import { resolveSocketPath } from './socket-path.js';

async function main(): Promise<void> {
	const socketPath = resolveSocketPath();
	// The one place the archive root is read from the environment, for the socket path's
	// reason: `startDaemon` never consults `process.env`, so an in-process daemon in a test
	// cannot start writing into the developer's own `~/.rover/artifacts`.
	const artifactsRoot = resolveArtifactsRoot();
	// The one place the project hook directory is read from the environment, for the same
	// reason — and rather more sharply, because a hook file names a program this process runs.
	const projectsRoot = resolveProjectsRoot();
	// The one place the host's `Keep` record is read from the environment, for the same reason
	// again — and this is the one piece of host state a *call* writes, so a unit test reaching the
	// developer's own `~/.rover/kept-tests.json` would not merely read it (D33).
	const keptTestsPath = resolveKeptTestsPath();
	// The one place the retention policy is read from the environment, for the same reason again
	// and with the sharpest version of it: these two numbers are what a sweep *deletes* by, so an
	// in-process daemon in a test must not pick a budget up out of the developer's shell. A value
	// that cannot be read as a whole count above zero throws here — `main().catch` below prints it
	// and the process exits 1 — because an operator who typed `1gb` must not quietly get 1024 MB
	// and then discover the difference as deleted runs. **And this host does sweep on its own**: a
	// lease ending takes the budget (D37) and a clock takes the whole policy at local midnight and
	// again right now, as this daemon comes up (D38) — so resolving these two numbers is not merely
	// making `sweep_archive` answerable, it is choosing what this process is about to delete by.
	const retention = resolveRetentionPolicy();
	// The one place the network listener is resolved from the environment. A missing token
	// beside a set port throws here, `main().catch` below prints it and the process exits 1 —
	// a misconfigured listener is a loud startup failure, never a host that quietly serves
	// only the local socket while its operator believes otherwise.
	const network = resolveNetworkListener();
	// And the one place the HTTP surface is resolved from the environment, for the same reason
	// and with the same failure: a non-loopback address with no TLS material throws here rather
	// than putting a bearer token on a wire in the clear (D29).
	const http = resolveHttpListener();
	const daemon = await startDaemon({
		socketPath,
		artifactsRoot,
		projectsRoot,
		keptTestsPath,
		retention,
		...(network ? { network } : {}),
		...(http ? { http } : {}),
	});
	if (!daemon.started) {
		return;
	}

	if (daemon.networkPort !== null && network !== undefined) {
		// The address and the port, and nothing else: never the token, never the certificate,
		// and nothing about what is attached.
		console.log(`Rover is listening on ${network.address}:${daemon.networkPort} (TLS).`);
	}

	if (daemon.httpPort !== null && http !== undefined) {
		// The scheme, the address, the port and the one route, and nothing else: never the token,
		// never the certificate, and nothing about what is attached (D20).
		const scheme = http.certPath === undefined ? 'http' : 'https';
		// An IPv6 address needs its brackets back to be a URL somebody can paste. `network-config.ts`
		// takes them off because `listen()` treats the bracketed form as a hostname and fails with
		// `ENOTFOUND` — so this is the one place the URL notation belongs.
		const host = http.address.includes(':') ? `[${http.address}]` : http.address;
		console.log(
			`Rover is serving the panel surface on ${scheme}://${host}:${daemon.httpPort}/rpc.`,
		);
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
