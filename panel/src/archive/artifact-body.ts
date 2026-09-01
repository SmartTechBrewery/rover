/**
 * What kind of body one archived artifact has, out of the media type the host answered — the
 * panel's **one** media-type vocabulary (#133, `docs/DESIGN.md` §9).
 *
 * **No extension table anywhere in the panel.** `src/daemon/archive-file.ts` owns that mapping and
 * there is deliberately not a second one in a browser bundle: the type is a fact about the file the
 * host served, decided from the name the host itself wrote, and the panel reads it off the
 * response. `tests/unit/panel/artifact-bodies.test.ts` is what holds the two ends together — it
 * asks this module about every type that host module can serve, so a host that learns `.webm`
 * cannot leave the panel quietly unable to draw it.
 *
 * **Pure, and nothing here imports React or the DOM.** That is what lets the `unit` project's gate
 * import it by relative path across the two trees: the panel's `@panel` alias resolves in
 * `vitest.config.ts` and deliberately not in `tsconfig.typecheck.json`, because one alias must
 * never mean two trees.
 */

/**
 * The three bodies the preview draws, and the honest fourth.
 *
 * - `image` — a screenshot or an extracted frame.
 * - `recording` — a video, played only when somebody presses play.
 * - `text` — a log the archive wrote, or the `device_info.json` beside it.
 * - `opaque` — the host served bytes and this panel has no way to show them. **Named rather than
 *   guessed at**: the route's own `application/octet-stream` fallback is *this host does not know
 *   what this is*, and a panel that rendered it as text would be inventing an answer. It is not a
 *   fault and it is not an error — the file is filed and `rover archive` reads it (D4).
 */
export type ArtifactBodyKind = 'image' | 'recording' | 'text' | 'opaque';

/**
 * The body for one `content-type`, as the host wrote the header.
 *
 * The header is normalised **here** rather than by whatever read it: a `content-type` legally
 * carries parameters and any case (`Text/Plain; charset=UTF-8`), and doing that in two places is
 * how one of them ends up doing it differently. `host-client.ts` passes the header through verbatim
 * for exactly that reason.
 *
 * `application/json` joins `text/*` because the archive's own `device_info.json` is a file a person
 * may want to read as it was written, and the route serves it with that type
 * (`src/daemon/archive-file.ts`). Nothing is parsed out of it and nothing is pretty-printed: the
 * file's real lines are what the preview numbers.
 */
export function bodyKindFor(contentType: string): ArtifactBodyKind {
	const mediaType = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
	if (mediaType.startsWith('image/')) {
		return 'image';
	}
	if (mediaType.startsWith('video/')) {
		return 'recording';
	}
	if (mediaType.startsWith('text/') || mediaType === 'application/json') {
		return 'text';
	}
	return 'opaque';
}

/**
 * A text artifact's own lines, for the gutter beside them.
 *
 * **The file's real lines, and nothing else.** One trailing empty line is dropped because the
 * archive ends every log file it writes with a newline (`renderLogs`, `src/daemon/archive.ts`), and
 * numbering the nothing after it would claim a line the device never logged. A blank line *inside*
 * the file is kept and numbered: it is a line the file has.
 *
 * Nothing is parsed, split on or matched. A log line is `08-30 17:05:03.123
 * I/ActivityManager(1234): Displayed …` and the level in it is the device's own word about its own
 * logs — colouring `W` or `E` would import the pass/fail vocabulary `docs/DESIGN.md` §2 has already
 * had to remove several times.
 */
export function linesOf(text: string): readonly string[] {
	const lines = text.split('\n');
	return lines.length > 1 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
}
