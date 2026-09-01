/**
 * `rover archive` — what is filed in a host's artifact archive, one directory level at a time.
 *
 * One `list_archive` call and a table. The arguments are **components a previous listing
 * returned**, never a path on the host: the host's own layout is not the caller's to know (D19),
 * and nothing here builds, joins or prints one.
 *
 * Exposed at all because D4 makes the CLI the interface everything is debugged through — an
 * archive only a browser can read is unreadable when the browser is the broken thing.
 *
 * **Nothing here turns a listing into a query.** No `--filter`, no `--sort`, no `--recursive`:
 * the host answers one level in one fixed order, which is what D24's index-free tree is shaped
 * for, and a flag that made this a query here would be a request for a parameter there.
 */

import {
	type ArchiveEntry,
	ArchivePathSegmentSchema,
	type ListArchiveResult,
	MAX_ARCHIVE_PATH_DEPTH,
} from '../../ipc/methods.js';
import { EXIT_FAILED, EXIT_OK } from '../_shared/exit.js';
import { GLOBAL_OPTIONS, parseCommandArgs, UsageError } from '../_shared/flags.js';
import { connectToHost, resolveHost } from '../_shared/host.js';
import * as out from '../_shared/output.js';

export const USAGE = `rover archive — what is filed in a host's artifact archive, one level at a time

Usage: rover archive [<component> ...] [--host <name>] [--json]

With no arguments, the top of the archive: one directory per project. Each further
argument is one more level down, named exactly as the previous listing named it —
components, never a path on the host, which is not yours to know.

One row per entry: its name, whether it is a directory or a file, and what one look at
it can honestly say — how many entries a directory holds, how many bytes a file is.
Nothing is filtered, searched, sorted or descended into: listing the directory is the
whole query, which is the point of the tree's shape.

An empty level, a level that is not there and a level this host cannot read are three
different answers and never one. The first exits 0; the other two exit 1.`;

const HEADINGS = ['NAME', 'KIND', 'CONTENTS'] as const;

/** What the breadcrumb `docs/DESIGN.md` §3 settles reads like in a line of text. */
const BREADCRUMB_SEPARATOR = ' > ';

/**
 * Where the caller is, in their own words.
 *
 * The components joined with the breadcrumb separator rather than with slashes: a slash would
 * read as a host path, which is exactly what these are not. Escaped, because an archived
 * directory name is whatever the filesystem holds and this line is read one line at a time.
 */
function describeLevel(path: readonly string[]): string {
	return path.length === 0
		? 'the top of the archive'
		: out.escapeControlCharacters(path.join(BREADCRUMB_SEPARATOR));
}

/** The `CONTENTS` cell — what one `readdir` or one `stat` of this entry actually said. */
export function renderContents(entry: ArchiveEntry): string {
	switch (entry.kind) {
		case 'directory':
			if (entry.childCount === null) {
				return 'not readable';
			}
			if (entry.childCount === 1 && entry.onlyChild !== null) {
				return `1 entry (${entry.onlyChild})`;
			}
			return `${entry.childCount} entries`;
		case 'file':
			return entry.sizeBytes === null ? 'size not readable' : `${entry.sizeBytes} bytes`;
		default:
			// A symlink, a socket, a device node: named, and nothing claimed about it.
			return '-';
	}
}

export function renderArchiveLevel(entries: readonly ArchiveEntry[]): string {
	return out.renderTable(
		HEADINGS,
		entries.map((entry) => [entry.name, entry.kind, renderContents(entry)]),
	);
}

/**
 * The components, validated **here** rather than at the host.
 *
 * `boundAttribution`'s argument applied to the same class of value: the host would otherwise
 * answer Zod's own words about a key the caller never typed, over a round trip that exits 1 —
 * the code reserved for "the host said no". Importing the schema rather than restating the rule
 * is what keeps the two from drifting.
 */
function componentsOf(positionals: readonly string[]): string[] {
	if (positionals.length > MAX_ARCHIVE_PATH_DEPTH) {
		throw new UsageError(
			`rover archive: ${positionals.length} components is deeper than the archive goes — ` +
				`a request may name at most ${MAX_ARCHIVE_PATH_DEPTH}.`,
		);
	}
	return positionals.map((component) => {
		const parsed = ArchivePathSegmentSchema.safeParse(component);
		if (!parsed.success) {
			throw new UsageError(
				`rover archive: '${out.escapeControlCharacters(component)}' is not an archive path ` +
					`component — each one is a single directory name, exactly as a previous listing ` +
					`named it, and never a path.`,
			);
		}
		return parsed.data;
	});
}

/** The sentence for each of the three answers, in human mode. */
function renderOutcome(host: string, path: readonly string[], result: ListArchiveResult): string {
	const where = describeLevel(path);
	switch (result.outcome) {
		case 'listed':
			return `Nothing is filed under ${where} on host '${host}'.`;
		case 'missing':
			return `Nothing is at ${where} in the archive on host '${host}'.`;
		default:
			return (
				`Host '${host}' cannot say what is at ${where} — it is there and could not be read. ` +
				`The host's own log names why.`
			);
	}
}

export async function run(argv: string[]): Promise<number> {
	const { values, positionals } = parseCommandArgs('archive', argv, GLOBAL_OPTIONS);
	if (values.help === true) {
		out.info(USAGE);
		return EXIT_OK;
	}
	// `expectPositionals` is fixed-arity by design, and this command's arity is the depth being
	// asked about — so the components are read straight off `positionals`, with the same refusal
	// of a blank argument in the same words.
	//
	// The empty string only, never `.trim()`: the sibling commands' blank check guards `--owner`,
	// a value a caller types, and this is a name the host produced. `ArchivePathSegmentSchema`
	// accepts a component that is one space, so trimming here would make a directory the host
	// itself answered with un-addressable on the next request — exactly what that schema refuses
	// to do about a backslash. Every other rule is the schema's, in `componentsOf`.
	if (positionals.some((value) => value.length === 0)) {
		throw new UsageError('rover archive: expected [<component> ...], got a blank argument');
	}
	const path = componentsOf(positionals);
	const host = resolveHost(values.host);

	const client = await connectToHost(host);
	try {
		const result = await client.request('list_archive', { path });

		if (values.json === true) {
			out.printJson(host, result);
		} else if (result.outcome === 'listed' && result.entries.length > 0) {
			out.info(renderArchiveLevel(result.entries));
		} else if (result.outcome === 'listed') {
			out.info(renderOutcome(host, path, result));
		} else {
			// `missing` and `unreadable` share exit 1 because this CLI's vocabulary has one "did
			// not succeed"; the sentence, and `outcome` under `--json`, are what tell them apart.
			out.error(renderOutcome(host, path, result));
		}
		return result.outcome === 'listed' ? EXIT_OK : EXIT_FAILED;
	} finally {
		await client.close();
	}
}
