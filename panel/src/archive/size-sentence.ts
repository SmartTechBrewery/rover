import type { ArchiveSize } from './archive-size.js';
import { formatBytes } from './file-size.js';

/**
 * What the Archive header's size badge says — **one full sentence naming its own scope** (#261,
 * `docs/DESIGN.md` §9).
 *
 * `All tests take 7.7 MB on disk` at the root, `This project takes …` one level down, and so on to
 * `This file takes …`. A sentence rather than a labelled figure because the badge sits beside a
 * count badge that is already `N tests archived`, and a bare `7.7 MB` in that row would be a
 * measure of *something* — the level, the selection, the archive — with nothing on the screen
 * saying which. The scope is the whole point of the number, so it is in the words.
 *
 * **`UNKNOWN` is deliberately not used here**, which is this module's one departure from
 * `file-size.ts`. That constant is the word a *field* takes where the host has no fact — `SIZE`
 * reading `unknown` beside a label that already says what is unknown. This badge has no label, so
 * `unknown` in the value slot would be a sentence with a hole in it; *the host could not measure
 * what this test takes on disk* is a sentence, and it says which fact is missing and whose it was.
 *
 * **`formatBytes` is the only formatter and nothing here calls `toLocaleString`** (#223). The
 * decimal separator is a dot on every machine, because the figure is a fact about the host's disk
 * and not a quantity rendered for whoever happens to be reading — the fixed-format rule that issue
 * settled, kept by importing the one function that already obeys it.
 */

/**
 * The scopes the `All` view has, one per depth of it (`routes/archive.tsx`, `sizeScopeFor`).
 *
 * `archive` is the root and the only one whose subject is plural, which is why the verb is carried
 * in the table beside it rather than assumed.
 */
export type SizeScope = 'archive' | 'project' | 'test' | 'run' | 'directory' | 'file';

/**
 * The nine words the badge is built out of, and **the lower-case subject is carried rather than
 * folded** (#223's rule applied to a second formatter).
 *
 * A `toLowerCase()` at render would be one more locale-sensitive fold in a module whose whole point
 * is that the format does not follow the viewer — Turkish `I` is the standing counterexample — and
 * the whole table is nine words. So both cases are written out and neither is derived.
 */
const SUBJECTS: Record<
	SizeScope,
	{ readonly subject: string; readonly lower: string; readonly verb: string }
> = {
	archive: { subject: 'All tests', lower: 'all tests', verb: 'take' },
	project: { subject: 'This project', lower: 'this project', verb: 'takes' },
	test: { subject: 'This test', lower: 'this test', verb: 'takes' },
	run: { subject: 'This run', lower: 'this run', verb: 'takes' },
	directory: { subject: 'This directory', lower: 'this directory', verb: 'takes' },
	file: { subject: 'This file', lower: 'this file', verb: 'takes' },
};

/**
 * The badge's text for one scope and one answer, or `null` where there is no badge at all.
 *
 * | the answer | the sentence |
 * | --- | --- |
 * | `measured`, complete | `This test takes 7.7 MB on disk` |
 * | `measured`, truncated | `This test takes at least 7.7 MB on disk` |
 * | `unmeasurable` | `The host could not measure what this test takes on disk` |
 * | `loading`, `absent` | `null` — no badge |
 *
 * **A truncated answer never renders a plain figure.** `truncated` means at least one directory
 * that exists was not fully examined (`archive-listing.ts`), so `bytes` is a lower bound and *at
 * least* is the only honest way to say it — the same rule the tree's truncation line keeps beside a
 * bounded set of rows.
 *
 * **`absent` draws nothing rather than `0 B`**, which is the count badge's absent-rather-than-`0`
 * rule over the other kind of number: `0 B` is a true claim about an empty directory, and *there is
 * nothing at this address* is not that claim (D6).
 */
export function sizeSentence(scope: SizeScope, size: ArchiveSize): string | null {
	const words = SUBJECTS[scope];
	if (size.status === 'loading' || size.status === 'absent') {
		return null;
	}
	if (size.status === 'unmeasurable') {
		return `The host could not measure what ${words.lower} ${words.verb} on disk`;
	}
	const bound = size.truncated ? 'at least ' : '';
	return `${words.subject} ${words.verb} ${bound}${formatBytes(size.bytes)} on disk`;
}
