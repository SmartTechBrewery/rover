#!/usr/bin/env node
/**
 * The MCP server's entry, as an agent's configuration file names it: one absolute path, and
 * nothing else on the command line.
 *
 * **This exists because a bare `--import` specifier is resolved against the client's working
 * directory, not against the script.** An MCP client picks its own cwd — which is why the
 * documented script path is absolute — so `node --import tsx/esm /abs/rover/src/mcp/index.ts`
 * starts only in the one directory nobody runs an agent from, and dies with
 * `Cannot find package 'tsx' imported from <the agent's own project>/` everywhere else. Node
 * resolves a `--import` argument like a cwd-relative import, and no absolute *script* path can
 * change that.
 *
 * A bare specifier inside **this** module is a different question with a different answer: ESM
 * resolves it by walking up from the importing module's own URL, and this module lives in the
 * checkout, beside the `node_modules` holding the loader. So the resolution happens where the
 * loader actually is, whatever directory the client started the process in, and the operator
 * pastes one path rather than two — no `node_modules` path in a config file, and nothing to
 * re-paste when `tsx` moves its own dist layout.
 *
 * `.mjs`, and plain JavaScript on purpose: the file that installs the TypeScript loader cannot
 * itself need one.
 *
 * **This is not the published `rover` entry point** `PROJECT.md` §9.4 leaves outside the
 * backlog. That section's objection is `command not found` for a bare `rover` in a fresh
 * clone, and it is untouched: there is no `bin` field in `package.json`, nothing is linked onto
 * a `PATH`, and every CLI line in the README is still `npm run rover --`. This is a path an MCP
 * config already states absolutely, and the CLI's `INVOCATION` constant does not move.
 *
 * The entry it launches is `src/mcp/index.ts`, whose own self-run guard does not fire here —
 * `process.argv[1]` is this file — so `main()` is called explicitly, and the failure handling
 * is that guard's, word for word: `process.exitCode` rather than `process.exit()`, so anything
 * already written to the transport is flushed instead of truncated.
 */

import { fileURLToPath } from 'node:url';

/** The checkout this launcher belongs to, named in the one failure an operator can act on. */
const checkout = new URL('..', import.meta.url);

/**
 * The same directory as a path, for the message below.
 *
 * `fileURLToPath` rather than `URL.pathname`, for the reason `src/core/entrypoint.ts` records
 * from the other side: a URL percent-encodes a space, so a checkout under `/My Projects/` would
 * be named back to its operator as `/My%20Projects/` — a path they cannot paste.
 */
const checkoutPath = fileURLToPath(checkout);

/**
 * Install the TypeScript loader for the dynamic import below.
 *
 * `tsx/esm/api`'s own `register()` rather than importing `tsx/esm` for its side effect: the
 * side effect is what `--import` relies on, and the API is the form that is documented to be
 * called. Dynamically, so a checkout with no `node_modules` is a sentence naming the fix
 * instead of a resolution error naming a package the operator never typed — this is the one
 * entry with no `npm` wrapper in front of it to have already failed.
 */
async function registerTypeScriptLoader() {
	let api;
	try {
		api = await import('tsx/esm/api');
	} catch (error) {
		throw new Error(
			`the TypeScript loader is not installed in ${checkoutPath} — run 'npm install' ` +
				`there. This entry runs Rover from source, so the checkout needs its dependencies ` +
				`even though the agent's own project does not (${
					error instanceof Error ? error.message : String(error)
				}).`,
		);
	}
	api.register();
}

try {
	await registerTypeScriptLoader();
	const { main } = await import(new URL('src/mcp/index.ts', checkout).href);
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
