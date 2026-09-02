import type { ArchivedFile, HostAnswer } from '@panel/session/host-client.js';
import { z } from 'zod';
import { useArchivedRunFile } from './archived-file.js';

/**
 * The run's `test_description.json` — what the lease said it was about, in the holder's own
 * sentences (D22 as amended #148, `src/daemon/archive.ts`, `PROJECT.md` §10).
 *
 * The second file on this screen that is a *file's contents* rather than a directory listing, and
 * it is read exactly like the first: off #131's byte route, out of the run's `<serial>` directory,
 * once per run (`archived-file.ts`, `device-info.ts`). Rover writes it beside the first artifact
 * the lease produced and never rewrites it, which is what lets this outlive the lease — a
 * description that vanished with the lease would be missing exactly when someone is reading old
 * runs.
 *
 * **Deliberately re-declared rather than imported from `src/ipc/methods.ts`**, for the reason
 * `device-info.ts` and `device-list.ts` both give at length: the panel is a separate tree with its
 * own `tsconfig.json` and its own `@panel` alias, precisely so one alias never means two trees, and
 * the daemon's module drags `core/device.ts` and the verb schema neighbourhood into a browser
 * bundle behind it. The drift that buys is pinned rather than hoped for —
 * `tests/fixtures/panel/test-description.json` is parsed by the **host's** own schema in
 * `tests/unit/panel/test-description-fixture.test.ts` and by the mirror below in
 * `test-description.test.tsx`.
 *
 * **Not `.strict()`, and the field is optional**, on `device-info.ts`'s reasoning: a newer daemon
 * adding a key must not turn a readable file into an unreadable one, and Zod's default strips what
 * it does not know.
 */

/**
 * As much of `test_description.json` as this screen reads — which is all of it.
 *
 * The key is the wire's own `testDescription` (D26), because the file is written from the lease's
 * field rather than being a second spelling of it.
 */
export const TestDescriptionFileSchema = z.object({
	testDescription: z.string().nullish(),
});
export type TestDescriptionFile = z.infer<typeof TestDescriptionFileSchema>;

/** The archive's own name for this file (`PROJECT.md` §10). Never composed and never configurable. */
const TEST_DESCRIPTION_FILE = 'test_description.json';

/**
 * The three answers this field has about the file, and they are `device_info.json`'s own three
 * (`docs/DESIGN.md` §9).
 *
 * `missing` is *no description was written for this run* and `unreadable` is *something is filed
 * there and this host will not read it*. The pair **share no phrase**, because they are different
 * answers: a lease may simply not have described itself, which is an ordinary thing and the common
 * case, while a host that cannot read the file is saying nothing about the lease at all.
 */
export type ArchivedTestDescription =
	| { readonly status: 'reading' }
	| { readonly status: 'read'; readonly description: string }
	| { readonly status: 'missing' }
	| { readonly status: 'unreadable' };

const READING: ArchivedTestDescription = { status: 'reading' };

/**
 * One run's `test_description.json`, read once when the run is opened — {@link useArchivedRunFile},
 * which owns the address, the caching and the one-request-per-run rule.
 */
export function useArchivedTestDescription(
	level: readonly string[] | null,
): ArchivedTestDescription {
	return useArchivedRunFile(level, TEST_DESCRIPTION_FILE, folded, READING);
}

/**
 * One answer, mapped onto {@link ArchivedTestDescription} — or nothing at all, for a `refused`.
 *
 * **Everything unusable folds into `unreadable`**: a `400`, a `500`, and a body that is not JSON.
 * That is the fold `device-info.ts` and `archive-levels.ts` already make — what the field has to
 * decide is narrower than why. A **`refused`** sets nothing at all, because
 * `Session.readArtifactText` has already fired `onRefusal` and the router is coming down.
 *
 * **A file that parses and carries no description folds into `missing`, not `unreadable`**, and
 * that is the one decision here that is not `device_info.json`'s. This field's states are about the
 * *description* rather than about the file: the host read what is there and it says nothing about
 * this run, which is *none filed*. Rover only ever writes this file when a lease supplied a
 * description, so the case is not one it can produce — and calling it *not readable* would claim
 * the host failed at something it did.
 */
function folded(answer: HostAnswer<ArchivedFile>): ArchivedTestDescription | undefined {
	if (!answer.ok) {
		return answer.refusal === 'unanswered' ? ({ status: 'unreadable' } as const) : undefined;
	}
	return fromFile(answer.value);
}

function fromFile(file: ArchivedFile): ArchivedTestDescription {
	if (file.outcome === 'missing') {
		return { status: 'missing' } as const;
	}
	if (file.outcome === 'unreadable') {
		return { status: 'unreadable' } as const;
	}
	let body: unknown;
	try {
		body = JSON.parse(file.text);
	} catch {
		return { status: 'unreadable' } as const;
	}
	const parsed = TestDescriptionFileSchema.safeParse(body);
	const description = parsed.success ? parsed.data.testDescription : undefined;
	// Blank counts as none, for the reason the wire refuses an empty string in the first place: an
	// empty sentence is not a description, and a field drawn empty is worse than one absent.
	return description === undefined || description === null || description.trim() === ''
		? ({ status: 'missing' } as const)
		: ({ status: 'read', description } as const);
}
