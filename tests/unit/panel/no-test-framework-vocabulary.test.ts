import { describe, expect, it } from 'vitest';
import { lineOf, readShippedPanelSources } from '../../helpers/panel-source-scan.js';

/**
 * `ai/RULES.md` §1 and `docs/DESIGN.md` §2, as an executable gate: **Rover is not a test
 * framework**, and nothing in the panel may suggest one. No pass/fail badge, no green/red
 * status column, no success rate, no "Analytics".
 *
 * `docs/DESIGN_INITIAL_PROMPT.md` states this twice, and it is still the constraint most
 * likely to be reintroduced by accident: every component library and every generated design
 * reaches for pass/fail semantics unprompted, and it has already come back twice.
 *
 * `test name` is deliberately absent from the list below. That is the field's real name
 * (`PROJECT.md` D22) and it does not mean a test — what it must never be shortened to is a
 * bare `TEST`, which reads as a category. Comments are stripped before matching, because the
 * panel's comments have to stay free to *discuss* every word here; this file is the proof
 * that they need to.
 */

/**
 * Chip and column labels, matched case-sensitively in the shouting form a status badge is
 * written in. Case-insensitive matching would flag ordinary prose — "the complete list", "a
 * failed request" — and a gate that cries wolf gets silenced rather than fixed.
 */
const VERDICT_LABELS = /\b(PASS|FAIL|PASSED|FAILED|SUCCESS|COMPLETE)\b/g;

/** Names for a reporting product Rover does not have, and phrases that only mean one thing. */
const REPORTING_VOCABULARY =
	/\b(analytics|diagnostics)\b|pass\s*[/|]\s*fail|\bsuccess[ -]rate\b|\btest results?\b/gi;

describe('nothing in the panel suggests a test framework', () => {
	// The panel's own tests name these words in order to assert their absence.
	const sources = readShippedPanelSources();

	it('scanned the panel tree', () => {
		expect(sources.length).toBeGreaterThan(10);
	});

	it('carries no verdict label and no reporting vocabulary', () => {
		const offences: string[] = [];

		for (const file of sources) {
			for (const pattern of [VERDICT_LABELS, REPORTING_VOCABULARY]) {
				pattern.lastIndex = 0;
				for (const match of file.sourceWithoutComments.matchAll(pattern)) {
					const line = lineOf(file.sourceWithoutComments, match.index);
					offences.push(`${file.path}:${line}: '${match[0]}' — Rover has no verdicts`);
				}
			}
		}

		expect(offences).toEqual([]);
	});
});
