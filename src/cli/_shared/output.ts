/**
 * Stream discipline for the `rover` CLI, plus the small formatters its four commands share.
 *
 * Two contracts live here, and both exist for the same reader — a script consuming stdout:
 *
 * - **`--json`: exactly one document on stdout, nothing else.** {@link printJson} is its
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
 */

import type { LeaseHolder } from '../../ipc/methods.js';

/**
 * How `rover` is actually typed today.
 *
 * `package.json` has no `bin` entry — the published entry point is `PROJECT.md` R20's to
 * settle — so a bare `rover release <id>` is `command not found` in every checkout that
 * exists. Anything meant to be **pasted** is rendered through this; the usage texts keep
 * saying `rover <command>` and the dispatcher's usage says once what it stands for. When
 * R20 lands, this constant becomes `'rover'` and nothing else moves.
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
 * The single JSON document a `--json` invocation writes.
 *
 * `host` is the only key the CLI adds, and **every** command adds it, so a script never has
 * to know which answers carry it. None of the four result schemas has a `host` key, so
 * there is nothing to collide with.
 */
export function printJson(host: string, result: object): void {
	console.log(JSON.stringify({ host, ...result }, null, 2));
}

/**
 * Fixed-width columns, sized to their own content. Two spaces between columns and no
 * trailing whitespace, so a row stays greppable and a diff of two runs shows only what
 * changed.
 */
export function renderTable(headings: readonly string[], rows: readonly string[][]): string {
	const widths = headings.map((heading, column) =>
		Math.max(heading.length, ...rows.map((row) => (row[column] ?? '').length)),
	);
	const line = (cells: readonly string[]): string =>
		cells
			.map((cell, column) => cell.padEnd(widths[column] ?? 0))
			.join('  ')
			.trimEnd();
	return [line(headings), ...rows.map(line)].join('\n');
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
 * `project <p>` or `project <p>, test <t>` — the caller's own attribution strings, echoed
 * and never interpreted (D16, D22).
 */
export function formatAttribution(project: string, testName: string | null): string {
	return testName === null ? `project ${project}` : `project ${project}, test ${testName}`;
}

/**
 * One holder, the way a listing and a refusal both name one: who has it, what they said
 * they were doing, and how much longer they have. Never the lease id — a holder disclosed
 * to somebody who is not the holder carries no credential (D20).
 */
export function formatHolder(holder: LeaseHolder): string {
	return (
		`${holder.owner} (${formatAttribution(holder.project, holder.testName)}) — ` +
		`${formatDuration(holder.expiresInMs)} left`
	);
}
