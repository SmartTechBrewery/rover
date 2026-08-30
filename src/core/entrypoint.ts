/**
 * The self-run guard both entrypoints use — `src/cli/index.ts` and `src/mcp/index.ts`.
 *
 * It lives here rather than in either of them because it is a fact about how Node resolves an
 * ESM entry, not about either client, and because the MCP server importing the CLI to borrow it
 * would drag seven commands and `console.log` into a process whose stdout carries protocol
 * frames.
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * `process.argv[1]` as the URL Node would have given a module had it been the entry.
 *
 * Two normalisations, and skipping either one makes an entrypoint a silent no-op that exits
 * 0: `import.meta.url` is a URL, so it percent-encodes a space (`/My Projects/` arrives as
 * `/My%20Projects/`), and Node resolves the ESM entry through `realpath`, so a checkout
 * reached by a symlink is compared against its real location. `argv[1]` is neither — it is
 * the raw path as typed. `null` when the path cannot be resolved.
 */
export function entryUrl(argvPath: string): string | null {
	try {
		return pathToFileURL(realpathSync(argvPath)).href;
	} catch {
		return null;
	}
}
