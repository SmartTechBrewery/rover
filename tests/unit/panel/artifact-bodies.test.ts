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
	 * The other half of the same rule. The route serves bytes it cannot name as
	 * `application/octet-stream` rather than refusing them (`archive-file.ts`), and the panel says so
	 * plainly rather than guessing a body — so this one is `opaque` on purpose, and a change that
	 * made it drawable would be the panel inventing an answer.
	 */
	it('leaves bytes the host could not name as opaque, knowingly', () => {
		expect(bodyKindFor('application/octet-stream')).toBe('opaque');
	});
});
