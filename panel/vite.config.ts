import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The panel is part of the root npm package rather than a nested one (see README, "The web
// panel"), so `root` has to name this directory explicitly: the config is invoked from the
// repository root by `npm run panel:dev`.
const panelRoot = import.meta.dirname;

/**
 * Where the **development server** sends `/rpc`, `/session` and `/artifact`.
 *
 * **The panel is same-origin in production**, because the daemon serves `panel/dist` from the very
 * listener that serves the data (R52) — so `panel/src/session/host-client.ts` uses relative URLs
 * only and has nowhere to put a host. This docstring used to explain itself as a consequence of a
 * gap: *no roadmap row owns serving `panel/dist` yet, so in development the two origins are
 * genuinely different.* The gap is closed and this paragraph is rewritten in place rather than
 * deleted (`ai/RULES.md` §1), because the proxy stays and its reason is now a smaller and more
 * permanent one: **this dev server is a second origin by nature.** It is the thing that rebuilds a
 * module as you save it, on a port of its own, and it is not co-hosted with any host — so it has
 * to reach one, and it reaches it here.
 *
 * **Dev-only, and that is now enforced rather than implied.** The `server` block is scoped to
 * `command === 'serve'` below, so nothing about a proxy is in the config a `vite build` reads. A
 * built bundle has no proxy, cannot have one, and must not: the production origin is the host
 * itself, and a bundle carrying a second idea of where the surface lives would be a second answer
 * to a question that has one.
 *
 * A proxy and not CORS: the host emits no `Access-Control-Allow-Origin` on purpose (`PROJECT.md`
 * D29), because an emitted one would make the surface readable from any page a browser happens to
 * have open. There is therefore nothing for a cross-origin dev server to use, and adding one for
 * development would be adding it in production too.
 *
 * `ROVER_HTTP_PORT` is the daemon's own switch for that listener, so the same variable points the
 * dev server at it — one number to keep in step instead of two. 4712 is what the README's recipe
 * uses.
 *
 * **Empty counts as unset, exactly as the daemon counts it** (`optional()` in
 * `src/daemon/network-config.ts`; README, "unset or *empty* and nothing binds"): an
 * exported-but-blank variable is what a shell leaves behind, and `??` alone falls back on
 * `undefined` only — it would build `http://127.0.0.1:`, a URL with no port, which is port 80. The
 * developer's afternoon then goes on why `/session` reached whatever is listening there, instead of
 * on a plain refused connection.
 */
const configuredPort = process.env.ROVER_HTTP_PORT;
const hostTarget = `http://127.0.0.1:${configuredPort === undefined || configuredPort === '' ? 4712 : configuredPort}`;

export default defineConfig(({ command }) => ({
	root: panelRoot,
	plugins: [react(), tailwindcss()],
	// 5173 is Swarm's dashboard, and the two are often up on one machine. Only for `vite serve`:
	// see the docstring above for why a build must carry none of this.
	...(command === 'serve'
		? {
				server: {
					port: 5174,
					proxy: {
						'/rpc': { target: hostTarget },
						'/session': { target: hostTarget },
						// The archive's byte route (R37). Singular and `/artifact`, not `/archive`: the
						// panel owns the client route `/archive`, and a proxied prefix that matched it
						// would send the screen that browses the archive to the daemon instead of
						// rendering it. The host reserves the same two prefixes for the same reason,
						// which is what keeps the dev server and the production origin agreeing about
						// which addresses are the page's (`src/daemon/http-listen.ts`, `routeFor`).
						'/artifact': { target: hostTarget },
					},
				},
			}
		: {}),
	build: { outDir: 'dist', emptyOutDir: true },
	resolve: { alias: { '@panel': path.resolve(panelRoot, './src') } },
}));
