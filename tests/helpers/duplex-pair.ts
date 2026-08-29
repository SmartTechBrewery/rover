/**
 * Two connected in-memory duplex streams — the "transport" the IPC unit tests run over.
 *
 * The point is not convenience. `src/ipc/` binds to `Duplex` and to nothing else (D17),
 * and driving it over a stream pair that is not a socket at all is what proves that: if a
 * filesystem path, a peer uid or a socket option ever leaked into the surface, these tests
 * would stop compiling or stop passing. No mocking of a socket, because there is no socket.
 */

import { Duplex, PassThrough } from 'node:stream';

/** `[a, b]` — whatever is written to one is readable from the other. */
export function createDuplexPair(): [Duplex, Duplex] {
	const aToB = new PassThrough();
	const bToA = new PassThrough();
	return [
		Duplex.from({ writable: aToB, readable: bToA }),
		Duplex.from({ writable: bToA, readable: aToB }),
	];
}
