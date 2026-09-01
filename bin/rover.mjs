#!/usr/bin/env node
/**
 * The `rover` command, as `npm link` puts it on a `PATH`.
 *
 * **This is the published entry point `PROJECT.md` §9.4 used to leave outside the backlog, and
 * that decision has been reversed there rather than worked around here.** Its objection was
 * `command not found` for a bare `rover` in a fresh clone — true, and the reason nothing is
 * linked automatically: this file does nothing until somebody runs `npm link` in the checkout,
 * and until they do, `npm run rover --` is still the way. What changed is that onboarding a
 * project is now a command you run *inside that project* (`rover init`), and `npm run rover --
 * init` from another repository's directory would run the npm script of whatever package.json
 * happens to be there.
 *
 * The CLI's own pasteable lines follow suit without a second decision to make: `INVOCATION`
 * (`src/cli/_shared/output.ts`) answers `rover` when the process came through this file and
 * `npm run rover --` when it did not, so the text always names the form the reader's own
 * invocation proves works.
 *
 * Everything else here is `./rover-mcp.mjs`'s, for its reasons: a bare `--import tsx/esm`
 * specifier is resolved against the **caller's** working directory rather than against the
 * script, so `node --import tsx/esm /abs/rover/src/cli/index.ts` runs only from inside this
 * checkout — which is precisely where a linked command never runs. A bare specifier inside this
 * module resolves by walking up from the module's own URL instead, landing in the checkout
 * beside the `node_modules` holding the loader. `.mjs` and plain JavaScript, because the file
 * that installs the TypeScript loader cannot itself need one.
 */

import { fileURLToPath } from 'node:url';

/** The checkout this launcher belongs to, named in the one failure an operator can act on. */
const checkout = new URL('..', import.meta.url);

/** The same directory as a path: a URL would percent-encode a space nobody can paste back. */
const checkoutPath = fileURLToPath(checkout);

/** Install the TypeScript loader for the dynamic import below — `./rover-mcp.mjs`'s note. */
async function registerTypeScriptLoader() {
	let api;
	try {
		api = await import('tsx/esm/api');
	} catch (error) {
		throw new Error(
			`the TypeScript loader is not installed in ${checkoutPath} — run 'npm install' ` +
				`there. This entry runs Rover from source, so the checkout needs its dependencies ` +
				`even though the project you are running 'rover' in does not (${
					error instanceof Error ? error.message : String(error)
				}).`,
		);
	}
	api.register();
}

try {
	await registerTypeScriptLoader();
	const { run } = await import(new URL('src/cli/index.ts', checkout).href);
	// The entry guard in that module cannot fire — `process.argv[1]` is this file — so the
	// dispatcher is called explicitly, and its exit code set rather than exited on, so a
	// document written to a pipe is flushed instead of truncated at whatever byte the exit
	// landed on.
	process.exitCode = await run(process.argv.slice(2));
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
