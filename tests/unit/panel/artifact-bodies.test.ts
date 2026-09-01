import { describe, expect, it } from 'vitest';
import { CONTENT_TYPES } from '@/daemon/archive-file.js';
import { bodyKindFor } from '../../../panel/src/archive/artifact-body.js';

/**
 * Two ends of one vocabulary in two trees (#133): the host decides an artifact's content type from
 * its extension, and the panel decides which preview body to draw from that content type.
 *
 * Neither side can see the mismatch on its own. `src/daemon/archive-file.ts` learning `.webm` is a
 * one-line change that leaves every suite green while a recording the host serves happily renders
 * in the browser as *this panel has no way to show this file* — the one failure that looks like a
 * missing feature rather than a bug, because nothing is red anywhere.
 *
 * **A relative import, not `@panel`.** That alias is declared in `vitest.config.ts` and deliberately
 * not in `tsconfig.typecheck.json`, so one alias never means two trees; the module it reaches is
 * pure, imports nothing, and touches neither React nor the DOM for exactly this reason. This is a
 * closer relationship than the source scans in this directory have (`panel-source-scan.ts` reads
 * text), and it is affordable only because of that purity.
 *
 * **Two questions, not one** (#140 review). *Can the panel draw it* is the mismatch above; *may the
 * panel open it in a tab* is stricter, because `Open in a new window` navigates to an object URL and
 * that document is in the panel's own origin, where the host's `nosniff` does not reach. So a second
 * allowlist, {@link OPENABLE_AS_A_DOCUMENT}, is what a new `CONTENT_TYPES` entry has to clear.
 *
 * It is a floor, not a proof: what it catches is a type the host can serve that the panel cannot
 * draw and nobody chose to leave undrawable.
 */

/**
 * What the panel may answer for a type the host serves.
 *
 * `opaque` is **not** in it. Every type in `CONTENT_TYPES` is one this host wrote a name for, so a
 * body for it is a decision somebody made — the fallback
 * (`application/octet-stream`) is the honest answer for bytes nothing named, and that one is
 * asserted below rather than tolerated here.
 */
const DRAWN = ['image', 'recording', 'text'] as const;

/**
 * The media types the panel is willing to hand a **same-origin `blob:` document** — an allowlist,
 * and the narrower half of this gate (#140 review).
 *
 * `Open in a new window` is a top-level navigation to an object URL of bytes this tab fetched, so
 * the opened document is in the **panel's own origin**. `x-content-type-options: nosniff`
 * (`src/daemon/http-listen.ts`) is a header on the *host's* response and does not travel with the
 * blob, which is the assumption R37's safety argument was written under and which no longer holds on
 * this path. Every type below is inert when navigated to; `image/svg+xml` and `text/html` are not,
 * and both would pass the `DRAWN` check above as `image` and `text`.
 *
 * **So this list, and not that one, is what a new entry in `CONTENT_TYPES` has to clear.** Adding
 * `.svg` or `.html` on the host turns this suite red rather than quietly giving the panel a
 * scriptable document in its own origin.
 */
const OPENABLE_AS_A_DOCUMENT = ['image/png', 'video/mp4', 'text/plain', 'application/json'];

/** The type without its parameters, as `bodyKindFor` normalises it — `text/plain; charset=utf-8`. */
function mediaTypeOf(contentType: string): string {
	return contentType.split(';')[0]?.trim().toLowerCase() ?? '';
}

describe('every artifact the host can serve has a body the panel draws', () => {
	it('read the host’s own content types', () => {
		// The four in `PROJECT.md` §10's tree. A gate that silently read an empty table would pass.
		expect(Object.keys(CONTENT_TYPES).length).toBeGreaterThanOrEqual(4);
	});

	it('maps each of them onto one of the three drawn bodies', () => {
		const undrawable: string[] = [];

		for (const [extension, contentType] of Object.entries(CONTENT_TYPES)) {
			const kind = bodyKindFor(contentType);
			if (!DRAWN.includes(kind as (typeof DRAWN)[number])) {
				undrawable.push(
					`${extension} is served as '${contentType}', which the panel draws as '${kind}'`,
				);
			}
		}

		expect(undrawable).toEqual([]);
	});

	/*
	 * Not *can the panel draw it* but *may the panel open it*, which is a different and stricter
	 * question — see {@link OPENABLE_AS_A_DOCUMENT}. It is asserted here rather than in the panel
	 * because the change that would break it is on the host, in the table this file imports.
	 */
	it('serves nothing the panel would open as a scriptable document in its own origin', () => {
		const notOpenable: string[] = [];

		for (const [extension, contentType] of Object.entries(CONTENT_TYPES)) {
			const mediaType = mediaTypeOf(contentType);
			if (!OPENABLE_AS_A_DOCUMENT.includes(mediaType)) {
				notOpenable.push(
					`${extension} is served as '${mediaType}', which the panel would open in a tab as a document in its own origin`,
				);
			}
		}

		expect(notOpenable).toEqual([]);
	});

	/*
	 * The other half of the same rule. The route serves bytes it cannot name as
	 * `application/octet-stream` rather than refusing them (`archive-file.ts`), and the panel says so
	 * plainly rather than guessing a body — so this one is `opaque` on purpose, and a change that
	 * made it drawable would be the panel inventing an answer.
	 */
	it('leaves bytes the host could not name as opaque, knowingly', () => {
		expect(bodyKindFor('application/octet-stream')).toBe('opaque');
	});
});
