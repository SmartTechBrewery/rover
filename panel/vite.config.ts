import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The panel is part of the root npm package rather than a nested one (see README, "The web
// panel"), so `root` has to name this directory explicitly: the config is invoked from the
// repository root by `npm run panel:dev`.
const panelRoot = import.meta.dirname;

/**
 * Where the dev server sends `/rpc` and `/session`.
 *
 * **The panel is same-origin in production**, because the daemon will serve its files from the very
 * listener that serves the data — so `panel/src/session/host-client.ts` uses relative URLs only and
 * has nowhere to put a host. No roadmap row owns serving `panel/dist` yet, so in development the
 * two origins are genuinely different, and this proxy is what keeps that a property of the dev
 * server rather than of the application.
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

export default defineConfig({
	root: panelRoot,
	plugins: [react(), tailwindcss()],
	// 5173 is Swarm's dashboard, and the two are often up on one machine.
	server: {
		port: 5174,
		proxy: {
			'/rpc': { target: hostTarget },
			'/session': { target: hostTarget },
		},
	},
	build: { outDir: 'dist', emptyOutDir: true },
	resolve: { alias: { '@panel': path.resolve(panelRoot, './src') } },
});
