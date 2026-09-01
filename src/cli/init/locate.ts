/**
 * Where the generated page already is — the module that keeps a second `rover init` from
 * scattering a second copy of it.
 *
 * The first run writes `ROVER.md` at the project's root because that is the only place it can
 * reasonably guess. A human then moves it: into `docs/`, into `ai/` beside the rules the project
 * already keeps there, sometimes under a different name. If the next run wrote the root copy
 * again, a project would end up with two pages saying almost the same thing and an agent reading
 * whichever it found first — which is the drift the page is generated to prevent, reintroduced
 * by the tool that generates it.
 *
 * So init **finds its own page before it writes one**, and it finds it by the marker it put
 * there ({@link DOCUMENT_MARKER}) rather than by the filename. Two failures follow from that
 * choice and both are deliberate: a page renamed to `docs/device-testing.md` is still found,
 * and somebody else's `ROVER.md` — a file this tool never wrote — is never overwritten.
 *
 * **Everything here happens before the first write.** An ambiguity is a refusal with nothing
 * done yet, for the reason `resolveArtifactDestination` checks `--out` before capturing
 * anything: a run that spends its work and then reports something knowable up front has spent
 * it for nothing. The report to the caller is the same either way, because init cannot know
 * which of two pages a human meant and picking one would be a guess with somebody's edits on
 * the other side of it.
 */

import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { UsageError } from '../_shared/flags.js';
import { DOCUMENT_FILE, isGeneratedDocument } from './documents.js';

/** Where the page goes, and how that was decided. */
export interface DocumentLocation {
	/** Absolute, for writing. */
	readonly path: string;
	/** Project-relative and in POSIX form, for the snippet that points an agent at it. */
	readonly relative: string;
	/** `given` by the caller, `found` where a previous run left it, or the `default` root. */
	readonly how: 'given' | 'found' | 'default';
}

/**
 * Directories the walk never descends into.
 *
 * Dependencies and build output, which hold thousands of markdown files and none of this
 * project's, plus every dot-directory: a page inside `.git` or `.gradle` is not a page anybody
 * moved there on purpose, and `.git` alone can hold more entries than the rest of a repository
 * put together.
 */
const SKIPPED = new Set(['node_modules', 'build', 'dist', 'out', 'target', 'vendor', 'coverage']);

/**
 * How deep the walk goes, and how many markdown files it will read.
 *
 * Bounds rather than preferences: this runs in somebody else's repository, whose shape is
 * unknown, and a command that onboards a project must not become the slowest thing they run
 * that day. A page moved deeper than this, or hiding behind more markdown than this, is found
 * with `--document` — which is why that flag exists as well as this search.
 */
const MAX_DEPTH = 6;
const MAX_MARKDOWN_FILES = 2000;

/**
 * The page's location for this run.
 *
 * `given` wins outright: somebody naming a path has answered the question this module exists to
 * ask. Otherwise the marker decides, and only a project with no page of ours anywhere gets the
 * root default.
 */
export async function locateDocument(
	directory: string,
	given: string | undefined,
): Promise<DocumentLocation> {
	if (given !== undefined) {
		return await documentGiven(directory, given);
	}

	const found = await findGeneratedDocuments(directory);
	if (found.length === 1) {
		const only = found[0] as string;
		return { path: only, relative: relativeTo(directory, only), how: 'found' };
	}
	if (found.length > 1) {
		throw new UsageError(
			`rover init: this project holds ${found.length} pages this command generated — ` +
				`${found.map((file) => relativeTo(directory, file)).join(', ')}. Nothing has been ` +
				`written. Delete the ones you do not want, or name the one to rewrite with ` +
				`--document <path>.`,
		);
	}

	const fallback = path.join(directory, DOCUMENT_FILE);
	await refuseToClobber(fallback, directory);
	return { path: fallback, relative: DOCUMENT_FILE, how: 'default' };
}

async function documentGiven(directory: string, given: string): Promise<DocumentLocation> {
	const file = path.resolve(directory, given);
	const relative = path.relative(directory, file);
	if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
		throw new UsageError(
			`rover init: --document ${given} is outside ${directory}. The page belongs to the ` +
				`project, because the snippet in its agent file points at it by a path relative to ` +
				`the project.`,
		);
	}
	await refuseToClobber(file, directory);
	return { path: file, relative: toPosix(relative), how: 'given' };
}

/**
 * Refuse a destination holding a markdown file this command did not write.
 *
 * The one case that costs somebody something they cannot get back. A page of ours is replaced
 * without ceremony — that is what generated means — but a `ROVER.md` somebody wrote by hand,
 * before Rover was ever pointed at this project, is theirs.
 */
async function refuseToClobber(file: string, directory: string): Promise<void> {
	let contents: string;
	try {
		contents = await readFile(file, 'utf8');
	} catch {
		return;
	}
	if (isGeneratedDocument(contents)) {
		return;
	}
	throw new UsageError(
		`rover init: ${relativeTo(directory, file)} is already there and was not written by this ` +
			`command — it carries none of its markers. Nothing has been written. Move it aside, or ` +
			`point the page somewhere else with --document <path>.`,
	);
}

/** Every markdown file under `directory` carrying the marker, in walk order. */
export async function findGeneratedDocuments(directory: string): Promise<string[]> {
	if (!(await isDirectory(directory))) {
		return [];
	}
	const search: Search = { found: [], inspected: 0 };
	await walk(directory, 0, search);
	return search.found;
}

/** The walk's own state: what it has found, and how much of its budget it has spent. */
interface Search {
	readonly found: string[];
	inspected: number;
}

async function walk(current: string, depth: number, search: Search): Promise<void> {
	if (depth > MAX_DEPTH || search.inspected >= MAX_MARKDOWN_FILES) {
		return;
	}
	for (const entry of await entriesOf(current)) {
		const child = path.join(current, entry.name);
		if (entry.isDirectory()) {
			if (worthDescending(entry.name)) {
				await walk(child, depth + 1, search);
			}
		} else if (entry.isFile() && entry.name.endsWith('.md')) {
			await inspect(child, search);
		}
	}
}

async function inspect(file: string, search: Search): Promise<void> {
	if (search.inspected >= MAX_MARKDOWN_FILES) {
		return;
	}
	search.inspected += 1;
	if (isGeneratedDocument(await readHead(file))) {
		search.found.push(file);
	}
}

/**
 * Sorted, so two runs over one project answer in the same order — which is what makes the
 * refusal naming several pages reproducible rather than dependent on the filesystem's mood.
 */
async function entriesOf(directory: string): Promise<Dirent[]> {
	try {
		const entries = await readdir(directory, { withFileTypes: true });
		return entries.sort((left, right) => left.name.localeCompare(right.name));
	} catch {
		// A directory this process cannot read is not a directory the page is in, and an
		// onboarding command has no business failing over one it was never pointed at.
		return [];
	}
}

function worthDescending(name: string): boolean {
	return !name.startsWith('.') && !SKIPPED.has(name);
}

/**
 * The start of a file, which is where the marker is.
 *
 * Bounded because this reads every markdown file in somebody's repository: a generated report,
 * a vendored specification or a changelog can be megabytes, and none of them becomes ours
 * further down.
 */
const MARKER_WINDOW_BYTES = 1024;

async function readHead(file: string): Promise<string> {
	try {
		return (await readFile(file, 'utf8')).slice(0, MARKER_WINDOW_BYTES);
	} catch {
		return '';
	}
}

async function isDirectory(directory: string): Promise<boolean> {
	try {
		return (await stat(directory)).isDirectory();
	} catch {
		return false;
	}
}

function relativeTo(directory: string, file: string): string {
	return toPosix(path.relative(directory, file));
}

/** Project-relative paths are written into markdown, where a backslash is not a separator. */
function toPosix(relative: string): string {
	return relative.split(path.sep).join('/');
}
