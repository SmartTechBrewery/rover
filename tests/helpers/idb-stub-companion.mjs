/**
 * A stand-in `idb_companion` that really speaks gRPC — the executable half of
 * `tests/unit/backends/ios-simulator/idb-client.test.ts`.
 *
 * The client under test is a spawn, a socket, a channel and a kill, so a mocked `@grpc/grpc-js`
 * would leave every claim in that suite asserting the mock's own behaviour — the argument
 * `idb-companion.test.ts` makes for its `sh` stubs, one layer up. This is the same idea with the
 * one thing an `sh` script cannot do: answer a call.
 *
 * It serves the **vendored proto**, so the suite proves that file loads and that the RPC the
 * client names is really on that service. `.mjs` and no `tsx`, because it is exec'd as a program
 * rather than imported.
 *
 * Two behaviours driven by the request rather than by configuration:
 *
 * - `describe` answers with a fixed target description.
 * - `describe` with `fetch_diagnostics: true` **exits 133 without answering** — the shape of the
 *   real crash this transport is built around (`docs/IOS.md` §4: `idb file push` dies with exit
 *   133 / SIGTRAP taking every in-flight call for that device with it), and the only way to test
 *   a call that is in flight when its companion dies without reaching for a pid.
 *
 * And one that cannot be: `$ROVER_STUB_NEVER_ANSWERS` binds the socket, prints the handshake and
 * then answers **nothing** — the companion that is listening but wedged. It is configuration
 * because the call it has to leave unanswered is the client's own handshake, `describe {}`, which
 * carries no field a case could put a flag in.
 *
 * Every start appends a line to `$ROVER_STUB_STARTS_FILE`, so a case can count how many
 * companions were really started.
 */

import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPackageDefinition, Server, ServerCredentials } from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';

const PROTO = fileURLToPath(
	new URL('../../src/backends/ios-simulator/idb/idb.proto', import.meta.url),
);

function argumentAfter(flag) {
	const at = process.argv.indexOf(flag);
	return at === -1 ? null : (process.argv[at + 1] ?? null);
}

const udid = argumentAfter('--udid');
const socketPath = argumentAfter('--grpc-domain-sock');
if (udid === null || socketPath === null) {
	process.stderr.write('stub companion needs --udid and --grpc-domain-sock\n');
	process.exit(2);
}

const startsFile = process.env.ROVER_STUB_STARTS_FILE;
if (startsFile !== undefined && startsFile !== '') appendFileSync(startsFile, `${udid}\n`);

const definition = loadPackageDefinition(
	loadSync(PROTO, { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true }),
);

const server = new Server();
server.addService(definition.idb.CompanionService.service, {
	describe(call, callback) {
		// Listening and wedged: no answer, no exit, so what ends the caller's wait is its own
		// deadline and nothing else.
		if (process.env.ROVER_STUB_NEVER_ANSWERS === '1') return;
		if (call.request.fetch_diagnostics === true) {
			// Dies without answering, exactly as the companion does on a file push.
			process.exit(133);
		}
		callback(null, {
			target_description: {
				udid,
				name: 'stub companion',
				state: 'Booted',
				target_type: 'simulator',
				os_version: 'iOS 26.5',
				architecture: 'arm64',
			},
		});
	},
});

server.bindAsync(`unix://${socketPath}`, ServerCredentials.createInsecure(), (error) => {
	if (error !== null) {
		process.stderr.write(`stub companion could not bind: ${error.message}\n`);
		process.exit(3);
	}
	// The handshake the real companion prints, in its own shape: one JSON line, newline-terminated
	// (measured on v1.5.2, docs/IOS.md §4).
	process.stdout.write(`${JSON.stringify({ grpc_path: socketPath })}\n`);
});
