import { describe, expect, it } from 'vitest';
import { KEEP_ALIVE_TIMEOUT_MS } from '@/daemon/http-listen.js';
import { readPanelSources } from '../../helpers/panel-source-scan.js';

/**
 * Two numbers in two trees that must not be the same number again (#125).
 *
 * The panel polls `list_devices` on a fixed interval over one keep-alive connection, so its next
 * request goes out `POLL_MS` after the previous one *started* — an idle window of `POLL_MS` minus
 * one response time. The listener closes an idle connection after `keepAliveTimeout`. Node's
 * default for that is 5 000 ms and `POLL_MS` is 5 000 ms, so before this the two were equal to the
 * millisecond and every single poll raced the close, with the dev proxy's own reused sockets
 * (`panel/vite.config.ts`) carrying a second copy of the race. The answer that lost the race was
 * the answer the grid never got.
 *
 * Neither side can see the collision on its own, and nothing else in the suite spans the two trees
 * at all: the panel's number is in a browser bundle and the listener's is in the daemon. So this
 * reads `POLL_MS` out of the panel's **source text**, in the idiom the other gates in this
 * directory use (`tests/helpers/panel-source-scan.ts`) — no cross-tree import, because `@panel`
 * must never mean two trees (`vitest.config.ts`).
 *
 * It is a floor, not a proof. What it catches is the one mistake that has already happened: either
 * number moved onto the other.
 */

const PROVIDER = 'panel/src/devices/device-list-provider.tsx';

/** `export const POLL_MS = 5_000;`, with the separators JavaScript allows in the literal. */
const POLL_MS_DECLARATION = /export const POLL_MS\s*=\s*([0-9_]+)/;

function panelPollMs(): number {
	const provider = readPanelSources().find((file) => file.path === PROVIDER);
	if (provider === undefined) {
		throw new Error(`${PROVIDER} is not where this gate expects the panel's poll to be declared`);
	}
	const declared = POLL_MS_DECLARATION.exec(provider.sourceWithoutComments);
	if (declared === null) {
		throw new Error(`${PROVIDER} no longer declares POLL_MS the way this gate reads it`);
	}
	return Number(declared[1].replaceAll('_', ''));
}

describe('the panel’s poll and the listener’s idle window', () => {
	it('reads the poll interval the panel actually ships', () => {
		expect(panelPollMs()).toBeGreaterThan(0);
	});

	// Comfortably clear, not merely unequal: a connection has to survive a poll that arrives late,
	// and "one millisecond longer" would pass a gate that was meant to stop exactly this.
	it('keeps the listener’s idle window well clear of it', () => {
		expect(KEEP_ALIVE_TIMEOUT_MS).toBeGreaterThan(panelPollMs() * 2);
	});
});
