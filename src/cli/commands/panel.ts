/**
 * `rover panel` — where the web panel is, and what has to be up for it to answer.
 *
 * **It prints; it no longer serves.** This module used to spawn Vite, and its own header said why
 * that was a limitation rather than a design: the daemon answered `/rpc`, `/session` and
 * `/artifact/…` and did not serve `panel/dist`, so the page had to come from somewhere and the
 * somewhere that existed was this repository's dev server. It closed with *when the daemon learns
 * to serve `panel/dist`, the honest shape of this command is a line pointing at the host's own
 * port*. R52 (#293) is that, and this file is the promise kept — edited in place with its
 * reasoning rewritten rather than deleted (`ai/RULES.md` §1), because the reason it was ever a
 * server is the reason it is now a line.
 *
 * **What that buys is one process, which is the operator-facing point.** `ROVER_HTTP_PORT=4712
 * rover server` is now the whole machine: the panel and its data from one origin, one thing to
 * start, one thing to stop, and — the follow-up this unblocks — one launchd agent, which two
 * foreground processes could never be.
 *
 * **Why a command at all, rather than nothing.** Two things an operator would otherwise have to
 * assemble from three documents: the URL, which depends on `ROVER_HTTP_PORT`, on
 * `ROVER_HTTP_ADDRESS` and on whether TLS material is configured — so it is composed by
 * `panelOriginFor`, the same function `rover server` prints its own line with, and cannot disagree
 * with what the daemon binds — and the fact that a browser needs a credential of its own, which is
 * the first thing anybody gets wrong.
 *
 * **It talks to nobody.** No host is asked whether it is up, and there is deliberately no probe:
 * this command runs in a shell that may have no host at all, the honest answer is *start one*, and
 * a probe would turn a two-line answer into a connection error. `--host` is refused for
 * `./server.ts`' reason — it does not talk to a host, it describes this machine's own (D17).
 *
 * **`npm run panel:dev` is untouched and is still the development server.** What changed is which
 * of the two is the ordinary way to look at the panel: the built bundle the host serves is, and
 * the dev server is for working on the panel itself (`panel/vite.config.ts`).
 */

import {
	HTTP_PORT_ENV_VAR,
	panelOriginFor,
	resolveHttpListener,
} from '../../daemon/network-config.js';
import { EXIT_OK } from '../_shared/exit.js';
import { expectPositionals, parseCommandArgs } from '../_shared/flags.js';
import * as out from '../_shared/output.js';

/** The port the README's recipe uses, named when nothing is configured so the example is runnable. */
const EXAMPLE_PORT = 4712;

export const USAGE = `rover panel — where the web panel is, and what has to be running

Usage: rover panel

The host serves the panel: with ROVER_HTTP_PORT set, one 'rover server' is the page and the data
on one origin, and there is no second process. This command prints that address.

  rover users add panel                 # the browser's own credential, printed once
  ROVER_HTTP_PORT=4712 rover server     # the host; Ctrl-C stops it
  rover panel                           # this — the URL to open

The panel is built, not bundled with a release: run 'npm run panel:build' in the Rover checkout
once, and the host serves it from then on. 'npm run panel:dev' is still the development server,
for working on the panel itself.`;

export async function run(argv: string[]): Promise<number> {
	const { values, positionals } = parseCommandArgs('panel', argv, {
		help: { type: 'boolean', short: 'h' },
	});
	if (values.help === true) {
		out.info(USAGE);
		return EXIT_OK;
	}
	expectPositionals('panel', positionals, []);

	// Throws on a half-configured TLS pair or a plain listener off loopback — the same two
	// configurations `rover server` refuses to start on, named in the same words. Reporting the URL
	// of a host that would refuse to bind is the one answer this command must not give.
	const http = resolveHttpListener();
	out.info(http === undefined ? nothingConfigured() : whereItIs(panelOriginFor(http)));
	return EXIT_OK;
}

/** The answer when this shell has no `ROVER_HTTP_PORT`: there is no address yet, and why. */
function nothingConfigured(): string {
	return (
		`${HTTP_PORT_ENV_VAR} is not set in this shell, so no host here is serving the panel — ` +
		`it is off unless configured, because a daemon that began answering a browser merely ` +
		`because somebody upgraded would be a change in exposure nobody chose.\n\n` +
		`  rover users add panel\n` +
		`  ${HTTP_PORT_ENV_VAR}=${EXAMPLE_PORT} rover server\n\n` +
		`Then open http://127.0.0.1:${EXAMPLE_PORT} and sign in with the credential that printed.`
	);
}

/** The answer when it is set: the address, and the two things that have to be true. */
function whereItIs(origin: string): string {
	return (
		`The web panel is at ${origin}\n\n` +
		`Two things have to be true for it to answer:\n` +
		`  - a host is running with ${HTTP_PORT_ENV_VAR} set — 'rover server' in a terminal of ` +
		`its own\n` +
		`  - the panel has been built — 'npm run panel:build' in the Rover checkout, once\n\n` +
		`The browser signs in with a credential of its own: 'rover users add panel' prints one.`
	);
}
