/**
 * `rover panel` — serve the web panel in the foreground.
 *
 * **What this is not: a second way to reach the host.** The panel is a browser client of the same
 * surface every other client speaks, over the HTTP transport the daemon exposes when
 * `ROVER_HTTP_PORT` is set (D29). This command serves the **page**; the host serves the data, and
 * without one running the panel loads and can ask nobody anything. So the pair is two terminals:
 * `rover server` with that variable set, and this.
 *
 * **It is Vite, and that is a limitation rather than a design.** The daemon does not serve the
 * panel's own assets yet — `src/daemon/http-listen.ts` answers `/rpc`, `/session` and
 * `/artifact/…` and nothing else — so the page has to come from somewhere, and the somewhere that
 * exists is this repository's dev server. Two things follow, both stated rather than hidden: this
 * needs Rover's `devDependencies` installed, so it works from a checkout and not from a copy that
 * ran `npm install --omit=dev`; and it is a **development** server, with the reload and the
 * unminified bundle that implies. When the daemon learns to serve `panel/dist`, the honest shape
 * of this command is a line pointing at the host's own port, and its usage text says so today so
 * nobody builds a workflow on the dev server by accident.
 *
 * **The port it proxies to is `ROVER_HTTP_PORT`**, the daemon's own switch, read by
 * `panel/vite.config.ts` — one number for both halves rather than a second setting here that could
 * disagree with it.
 *
 * Spawned rather than imported, through `../_shared/foreground.ts`, for `./server.ts`' reason.
 */

import { fileURLToPath } from 'node:url';
import { EXIT_OK } from '../_shared/exit.js';
import { expectPositionals, parseCommandArgs } from '../_shared/flags.js';
import { runInForeground } from '../_shared/foreground.js';
import * as out from '../_shared/output.js';

/** Rover's own root, because the dev server and its config live here and not in a project. */
const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** The same invocation `npm run panel:dev` makes, without needing to be typed in this checkout. */
const VITE_ARGV = ['node_modules/vite/bin/vite.js', '--config', 'panel/vite.config.ts'] as const;

export const USAGE = `rover panel — serve the web panel in the foreground

Usage: rover panel

The panel is a browser client of the same surface everything else speaks, so it needs a host
serving that surface to a browser. In another terminal:

  export ROVER_HTTP_PORT=4712
  rover server

then this. The panel reads the same variable, so one number points both halves at each other.
A browser needs a credential of its own — \`rover users add panel\` prints one.

Today this is Rover's development server, because the host does not serve the panel's assets
yet: it needs this repository's devDependencies, and it reloads on edits. When the host serves
them, this command becomes a URL rather than a server.`;

export async function run(argv: string[]): Promise<number> {
	const { values, positionals } = parseCommandArgs('panel', argv, {
		help: { type: 'boolean', short: 'h' },
	});
	if (values.help === true) {
		out.info(USAGE);
		return EXIT_OK;
	}
	expectPositionals('panel', positionals, []);

	return runInForeground({ args: [...VITE_ARGV], cwd: PACKAGE_ROOT });
}
