/**
 * Serving the web panel's **own files** — `panel/dist`, from the same listener that serves its
 * data (R52, #293, D29 as amended).
 *
 * **The point of this module is that one process is the whole machine.** Until it existed the
 * operator needed two foreground processes for one screen — `ROVER_HTTP_PORT=… rover server` for
 * the surface and `rover panel`, which was Vite, for the page — because the daemon answered
 * `/rpc`, `/session` and `/artifact/…` and nothing else. Two processes cannot be one launchd
 * agent, and every document that touched the gap said so and deferred. `ROVER_HTTP_PORT=4712
 * rover server` is now the only thing running, and `http://127.0.0.1:4712` is the panel and the
 * data from one origin — which is also the origin assumption `panel/src/session/host-client.ts`
 * was written under from the first commit, relative URLs and no host field.
 *
 * **It opens a file; it does not serve one**, exactly as `./archive-file.ts` does not: this module
 * turns a request *path* into one of three outcomes, and `./http-listen.ts` decides the statuses
 * and writes the bytes. And **containment is not re-implemented here** — the resolve-and-compare
 * is `./contained-file.ts`'s, the same one the artifact route has always used, pointed at a
 * different root. A second, differently-bounded copy is the thing that would eventually be wrong.
 *
 * **Three outcomes, and `not-built` is the one that matters.** A host whose `panel/dist` is
 * missing or empty answers **one plain sentence naming `npm run panel:build`** rather than a `404`
 * or a blank page: never degrading silently is the house rule (`ai/RULES.md` §2), and this is
 * exactly the case it is for — the operator typed the one command the README gives them, got a
 * page, and the only thing wrong is a build step nobody told them about. Guessing is not available
 * either: this host cannot run `vite` on their behalf, because a published copy installed with
 * `--omit=dev` has no `vite` to run.
 *
 * **The fallback rule, stated rather than inherited from a framework.** A path that names a file
 * under the root is that file. Anything else is `index.html`, because the panel's client routes
 * are addresses TanStack Router owns and the host has no list of them — `/archive`, `/groups`,
 * `/projects`, `/system`, `/profile`, and whatever is added next without this module hearing about
 * it. The **one** exception is {@link BUILD_ASSETS_PREFIX}: a miss under Vite's own output
 * directory is a `404` and never a document, because a `<script src>` answered with `index.html`
 * fails as a syntax error in a bundle that looks present, which is the worst diagnosis in this
 * whole change. The obvious cheaper rule — *a path with an extension is an asset* — is **wrong
 * here** and was tried: `/archive/$` is a real client route and it carries the artifact's own file
 * name, so `/archive/checkout/login/…/001_screenshot.png` is a page and not a file.
 *
 * **An address that resolved to something unservable never falls back either.** A symlink pointing
 * out of the root, a directory, a FIFO — `./contained-file.ts` calls all of those `unreadable`,
 * and answering `index.html` for one would turn a refusal into a `200`. So `unreadable` is a
 * `404` wherever it appears, which is also the whole of "no directory listing".
 */

import { fileURLToPath } from 'node:url';
import {
	type ContainedFileReader,
	createContainedFileReader,
	type OpenedContainedFile,
} from './contained-file.js';

/**
 * Where the built panel is, in the checkout or the install this daemon is running out of.
 *
 * Resolved from this module's own URL and **never from the working directory**: a daemon outlives
 * the directory somebody started it in, and `./connect.ts` resolves its own package root the same
 * way for the same reason. There is deliberately no environment variable for it — `panel/dist` is
 * a property of the installation, not a setting anybody chose, and a switch here would be one more
 * way for a host to serve a bundle that is not its own.
 */
export function resolvePanelBundleRoot(): string {
	return fileURLToPath(new URL('../../panel/dist/', import.meta.url));
}

/**
 * Vite's own output directory inside the bundle (`build.assetsDir`, left at its default), and the
 * one prefix under which a miss is a `404` rather than the SPA fallback. See the module header.
 */
const BUILD_ASSETS_PREFIX = '/assets/';

/** The document every client route resolves to, and the file whose absence means *not built*. */
const INDEX_FILE = 'index.html';

/**
 * The one sentence a host with no build answers, on every panel address.
 *
 * Exported so `tests/unit/daemon/panel-route.test.ts` asserts the bytes rather than a paraphrase,
 * and so the command it names cannot drift from `package.json` without one of them noticing.
 */
export const PANEL_NOT_BUILT_MESSAGE =
	"This Rover host has no web panel to serve: run 'npm run panel:build' in the Rover checkout, then reload.\n";

/**
 * What a built bundle holds, by extension.
 *
 * **Not `CONTENT_TYPES` from `./archive-file.ts`, and the two may never be merged.** That table is
 * gated by `tests/unit/panel/artifact-bodies.test.ts` against what the archive preview can draw and
 * what it may hand a same-origin `blob:` document — a gate `.html`, `.js` and `.svg` are meant to
 * fail. These are the same three types the panel's *own* origin is built out of, which is a
 * different question with a different answer, so it gets a different table.
 *
 * `text/javascript` rather than `application/javascript`: the WHATWG MIME sniffing standard names
 * it the legacy-but-correct type, and a module script is refused outright for anything a browser
 * does not consider a JavaScript type. Everything unknown falls back to `application/octet-stream`
 * and is served rather than refused, which is `./contained-file.ts`'s rule and not a decision here.
 */
const PANEL_CONTENT_TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.map': 'application/json',
	'.json': 'application/json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.avif': 'image/avif',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.txt': 'text/plain; charset=utf-8',
	'.webmanifest': 'application/manifest+json',
};

/** How a warning about this tree names it. See `./contained-file.ts`. */
const PANEL_NAMES = { subject: 'The web panel bundle', root: 'the panel bundle root' } as const;

/**
 * The longest a single path component may be, and the deepest an address may go.
 *
 * A bound rather than a rule about what is inside the bundle: containment already holds whatever
 * these say, and what they buy is that a peer cannot make this host `join()` a path of arbitrary
 * size before the filesystem refuses it. Generous enough that nothing Vite emits comes close.
 */
const MAX_SEGMENT_LENGTH = 255;
const MAX_DEPTH = 32;

/**
 * How many **distinct** warnings about this tree one daemon will ever print.
 *
 * **This bound is what makes the pre-auth route safe to have** (#295 review, F1). `./archive-file.ts`
 * warns once per request and that is right for it — every caller it has is past the gate, so a line
 * in the log is attributable to somebody this host let in. The panel bundle is answered *before*
 * the gate (`./http-listen.ts`'s header), so the same per-request warning is a stranger's write
 * handle on the operator's disk: `/assets` is a directory every real `vite build` produces, so
 * `GET /assets` in a loop is a permanently available, unauthenticated way to append ~200 bytes per
 * request to whatever the host's stdout is pointed at — and to bury the warnings this mechanism
 * exists to surface under noise.
 *
 * So the diagnosis is kept and the repetition is dropped: the first occurrence of each distinct
 * message is printed, every later copy is silent, and after this many distinct messages the host
 * stops warning about this tree altogether. Both halves matter — deduping alone would still let a
 * peer who can vary the address (a miss under a directory name they choose) grow the log without
 * bound. The operator still gets told about the symlink or the stray FIFO they left in `panel/dist`,
 * which is the only thing these warnings were ever for: the contents of that tree are the
 * installation's, and they do not change while a daemon runs.
 */
const MAX_DISTINCT_WARNINGS = 32;

export interface PanelBundleOptions {
	/** Defaults to {@link resolvePanelBundleRoot}. A test seam, not a configuration surface. */
	readonly root?: string;
	/**
	 * Where a file the host will not read is reported. Defaults to `console.warn`, and is bounded
	 * either way — see {@link MAX_DISTINCT_WARNINGS}.
	 */
	readonly warn?: (message: string) => void;
}

export type PanelBundleAnswer =
	/** Stream it. The handle is the caller's to close. */
	| { readonly outcome: 'file'; readonly file: OpenedContainedFile }
	/** There is a bundle, and this address is not in it — or resolves to something unservable. */
	| { readonly outcome: 'missing' }
	/** There is no bundle. The caller answers {@link PANEL_NOT_BUILT_MESSAGE}. */
	| { readonly outcome: 'not-built' };

export interface PanelBundle {
	/**
	 * What `GET <path>` should answer from the built panel, `path` being a request target's path
	 * with its query already discarded.
	 */
	resolve(path: string): Promise<PanelBundleAnswer>;
}

export function createPanelBundle(options: PanelBundleOptions = {}): PanelBundle {
	const reader: ContainedFileReader = createContainedFileReader({
		root: options.root ?? resolvePanelBundleRoot(),
		contentTypes: PANEL_CONTENT_TYPES,
		names: PANEL_NAMES,
		// The bound is applied here rather than in `./contained-file.ts` on purpose: it is a
		// property of *this* caller being pre-auth, not of containment. The archive reader's
		// per-request warning is unchanged, and must stay that way.
		warn: boundWarnings(options.warn ?? ((message: string) => console.warn(message))),
	});

	/** `index.html` if there is a bundle at all, `undefined` if there is not. */
	async function openIndex(): Promise<OpenedContainedFile | undefined> {
		const opened = await reader.open([INDEX_FILE]);
		if (opened.outcome !== 'opened') {
			return undefined;
		}
		// **Empty counts as absent.** An interrupted build leaves a zero-byte `index.html` behind,
		// and a blank tab is the one answer this module exists to never give.
		if (opened.file.sizeBytes === 0) {
			await opened.file.close().catch(() => {});
			return undefined;
		}
		return opened.file;
	}

	return {
		async resolve(path: string): Promise<PanelBundleAnswer> {
			const address = addressOf(path);
			const direct =
				address !== undefined && address.length > 0 ? await reader.open(address) : undefined;
			if (direct?.outcome === 'opened') {
				return { outcome: 'file', file: direct.file };
			}

			// Everything left needs to know whether there is a bundle at all, because *not built*
			// outranks *no such file*: an operator looking at a `404` for `/` has no way to guess
			// that the answer is a build step.
			const index = await openIndex();
			if (index === undefined) {
				return { outcome: 'not-built' };
			}

			const fallsBack =
				// A refused address — `..`, a NUL, a `%2F`, an empty component — is not a client
				// route, so it gets no document.
				address !== undefined &&
				// Something is there and this host will not serve it. See the module header.
				direct?.outcome !== 'unreadable' &&
				// Vite's own output: a miss here is a stale or half-copied bundle, never a page.
				!path.startsWith(BUILD_ASSETS_PREFIX);
			if (!fallsBack) {
				await index.close().catch(() => {});
				return { outcome: 'missing' };
			}
			return { outcome: 'file', file: index };
		},
	};
}

/**
 * The same warning function, told once per distinct message and at most
 * {@link MAX_DISTINCT_WARNINGS} times in all.
 *
 * Keyed on the whole message because the message already carries the address the caller named, so
 * one key is one problem in the tree; the cap is checked before the insert, so the set is what
 * bounds the memory as well as the log.
 */
function boundWarnings(warn: (message: string) => void): (message: string) => void {
	const said = new Set<string>();
	return (message: string) => {
		if (said.has(message) || said.size >= MAX_DISTINCT_WARNINGS) {
			return;
		}
		said.add(message);
		warn(message);
	};
}

/**
 * A request path as the components of an address inside the bundle, or `undefined` for one no
 * bundle could hold. `/` is `[]`.
 *
 * **Decoding happens before validation**, which is the whole point of doing it here: `%2F` and
 * `%00` are then refused rather than smuggled past as an already-encoded string, and a malformed
 * escape throws `URIError` out of `decodeURIComponent`, which is likewise an address nothing here
 * produced. This is deliberately *not* `ArchivePathSegmentSchema`: that schema is the archive's
 * address vocabulary, defined as what `list_archive` answers with, and borrowing it here would tie
 * the panel's URLs to a promise about a different tree. The containment the two share is
 * `./contained-file.ts`'s, which is the part that must not be written twice.
 */
function addressOf(path: string): string[] | undefined {
	const segments = (path.startsWith('/') ? path.slice(1) : path).split('/');
	// One trailing empty segment is a trailing slash — `/archive/` is the address `/archive` is,
	// and `/` is the root. Any *other* empty segment is a `//` nothing here addresses.
	if (segments.length > 1 && segments[segments.length - 1] === '') {
		segments.pop();
	}
	if (segments.length === 1 && segments[0] === '') {
		return [];
	}
	if (segments.length > MAX_DEPTH) {
		return undefined;
	}

	const decoded: string[] = [];
	for (const segment of segments) {
		let component: string;
		try {
			component = decodeURIComponent(segment);
		} catch {
			return undefined;
		}
		if (!isServableComponent(component)) {
			return undefined;
		}
		decoded.push(component);
	}
	return decoded;
}

/**
 * One directory name — never `.`, `..`, a separator, a NUL or nothing at all, and never longer
 * than {@link MAX_SEGMENT_LENGTH}, which is the per-component half of the bound {@link MAX_DEPTH}
 * is the other half of.
 */
function isServableComponent(component: string): boolean {
	return (
		component.length > 0 &&
		component.length <= MAX_SEGMENT_LENGTH &&
		component !== '.' &&
		component !== '..' &&
		!component.includes('/') &&
		!component.includes('\\') &&
		!component.includes('\0')
	);
}
