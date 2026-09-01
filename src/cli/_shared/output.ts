/**
 * Stream discipline for the `rover` CLI, plus the small formatters its four commands share.
 *
 * Two contracts live here, and both exist for the same reader — a script consuming stdout:
 *
 * - **`--json`: exactly one document on stdout, nothing else.** {@link printDocument} is its
 *   only writer, and every diagnostic — an error, a warning, the stale-view banner — goes
 *   to stderr through the functions below. A caller can pipe stdout straight into a parser
 *   without filtering a banner out of it first.
 * - **Human mode: the answer goes to the stream its outcome belongs on.** A success is
 *   stdout; a refusal or a failure is stderr, next to the diagnostic explaining it. So
 *   redirecting stdout is enough to keep "device acquired" and "device is busy" apart,
 *   without also reading the exit code.
 *
 * `console.*` rather than `process.stdout.write`, so a test can spy on them — the same
 * reason Swarm's own `src/cli/_shared/output.ts` is written this way.
 *
 * One rule spans both, and it is the reason {@link escapeControlCharacters} exists:
 * **`--json` echoes a caller's attribution string verbatim, human mode renders it escaped.**
 * Only human mode is line-structured, so only human mode can have a line forged in it; JSON
 * escaping already contains a newline in the other mode.
 */

import type { LeaseHolder } from '../../ipc/methods.js';

/**
 * How `rover` is actually typed today.
 *
 * `package.json` has no `bin` entry — a published entry point is outside the backlog
 * deliberately (`PROJECT.md` §9.4) — so a bare `rover release <id>` is `command not found` in
 * every checkout that exists. Anything meant to be **pasted** is rendered through this; the
 * usage texts keep saying `rover <command>` and the dispatcher's usage says once what it
 * stands for. If one is ever published, this constant becomes `'rover'` and nothing else
 * moves.
 */
export const INVOCATION = 'npm run rover --';

export function info(message: string): void {
	console.log(message);
}

export function warn(message: string): void {
	console.warn(message);
}

export function error(message: string): void {
	console.error(message);
}

/**
 * The single JSON document a `--json` invocation writes — the one writer, so "exactly one
 * document on stdout" is a property of this function rather than of every call site.
 *
 * {@link printJson} is what a command that asked a host uses; this is what a command with no
 * host to name uses. `rover users` is the only one of those today (D25 — it reads and writes
 * the host's own file and never opens a connection), and giving it its own `console.log`
 * would put a second writer next to the contract.
 */
export function printDocument(result: object): void {
	console.log(JSON.stringify(result, null, 2));
}

/**
 * The document a command that asked a host writes.
 *
 * `host` is the only key the CLI adds, and **every** command that talks to one adds it, so a
 * script never has to know which answers carry it. None of the four result schemas has a
 * `host` key, so there is nothing to collide with.
 */
export function printJson(host: string, result: object): void {
	printDocument({ host, ...result });
}

/** `\n`, `\r` and `\t` as a reader already knows them; everything else in C0 as `\xNN`. */
const NAMED_ESCAPES: Readonly<Record<string, string>> = {
	'\n': '\\n',
	'\r': '\\r',
	'\t': '\\t',
};

/** C0 and DEL — every character that could end a line or move a cursor. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/**
 * A string of somebody else's making, rendered so it cannot forge structure in a line of
 * human-readable output.
 *
 * The three attribution strings are stored exactly as the caller typed them, on purpose:
 * `AttributionStringSchema` (src/ipc/methods.ts) bounds only their length and deliberately
 * does not `.trim()`, "that would modify a caller's string". The host therefore hands back
 * whatever it was given, and the renderer is the only place left that can keep a row on one
 * line — without this, a newline in `--owner` puts a second, fabricated device row in
 * `rover list`, and column widths are then measured against text that never prints as one
 * line.
 *
 * Only control characters are escaped and a backslash is left alone, which makes this
 * idempotent: {@link renderTable} can re-escape a cell {@link formatHolder} already built.
 */
export function escapeControlCharacters(value: string): string {
	return value.replace(
		CONTROL_CHARACTERS,
		(char) => NAMED_ESCAPES[char] ?? `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`,
	);
}

/**
 * Fixed-width columns, sized to their own content. Two spaces between columns and no
 * trailing whitespace, so a row stays greppable and a diff of two runs shows only what
 * changed.
 *
 * Cells are escaped before they are measured, so one row is one line by construction and
 * the width arithmetic is over exactly what gets printed.
 */
export function renderTable(headings: readonly string[], rows: readonly string[][]): string {
	const safeHeadings = headings.map(escapeControlCharacters);
	const safeRows = rows.map((row) => row.map(escapeControlCharacters));
	const widths = safeHeadings.map((heading, column) =>
		Math.max(heading.length, ...safeRows.map((row) => (row[column] ?? '').length)),
	);
	const line = (cells: readonly string[]): string =>
		cells
			.map((cell, column) => cell.padEnd(widths[column] ?? 0))
			.join('  ')
			.trimEnd();
	return [line(safeHeadings), ...safeRows.map(line)].join('\n');
}

/**
 * A duration as a human reads it. Truncated rather than rounded up: "1m" on a lease with
 * forty seconds left would promise time the holder does not have.
 */
export function formatDuration(ms: number): string {
	const seconds = Math.floor(Math.max(0, ms) / 1000);
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
}

/**
 * `project <p>, test <t>` — the caller's own attribution strings, echoed and never
 * interpreted (D16, D22), but escaped: echoing one is not the same as letting it carry a line
 * break into output that is read a line at a time.
 *
 * Both halves are always there: a lease cannot be taken without either string (D22, as
 * amended #129), so there is no shorter form to render.
 */
export function formatAttribution(project: string, testName: string): string {
	return `project ${escapeControlCharacters(project)}, test ${escapeControlCharacters(testName)}`;
}

/**
 * One holder, the way a listing and a refusal both name one: who has it, what they said
 * they were doing, how much longer they have, and since when. Never the lease id — a holder
 * disclosed to somebody who is not the holder carries no credential (D20).
 *
 * `grantedAt` is printed **exactly as the host sent it**, and last, after the countdown.
 * This process does no date arithmetic on it: the host's clock is not this one's, so the
 * only honest relative number here is `expiresInMs`, which the host measured itself. The
 * two are independent — activity renews the lease (D8), moving the expiry and not the
 * grant — which is why both are shown.
 *
 * It is deliberately not passed through {@link escapeControlCharacters}. Every other string
 * here is caller-supplied and unvalidated; this one is `z.string().datetime()`, so its shape
 * is a parse rather than a convention, and escaping it would imply the schema is not trusted.
 */
export function formatHolder(holder: LeaseHolder): string {
	return (
		`${escapeControlCharacters(holder.owner)} ` +
		`(${formatAttribution(holder.project, holder.testName)}) — ` +
		`${formatDuration(holder.expiresInMs)} left, granted ${holder.grantedAt}`
	);
}
