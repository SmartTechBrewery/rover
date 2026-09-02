import { describe, expect, it } from 'vitest';
import { GrantedLeaseSchema, TestDescriptionSchema } from '@/ipc/methods.js';
import fixture from '../../fixtures/panel/test-description.json' with { type: 'json' };

/**
 * The daemon's half of the run description's drift gate (#148).
 *
 * `panel/src/archive/test-description.ts` re-declares the shape of `test_description.json` instead
 * of importing anything from `src/ipc/methods.ts`, for the structural reason
 * `list-devices-fixture.test.ts` sets out at length: the panel is a separate tree with its own
 * `tsconfig.json` and its own alias, and the method table drags `core/device.ts`,
 * `core/capabilities.ts` and the verb schema neighbourhood into a browser bundle behind it. So one
 * fixture is parsed twice, by two projects that cannot import each other — **here** against the
 * wire field the file is written from, and in `panel/src/archive/test-description.test.tsx` by the
 * panel's mirror.
 *
 * **This is the second fixture that is not a wire answer** (`device-info.json` was the first —
 * `ai/TESTING.md`, "A wire answer is a fixture too"). It is a *file the daemon writes into the
 * archive*: `JSON.stringify({ testDescription })` beside the first artifact a lease produced
 * (`src/daemon/archive.ts`, D22 as amended #148). What governs it is therefore the lease's own
 * field rather than a method's result schema, which is why {@link GrantedLeaseSchema}'s projection
 * of that one key is what parses it below — the file carries the wire's spelling (D26) rather than
 * a second one, and `.strict()` is what makes an invented key fail here.
 *
 * **The entry is constructed, not captured, and that is stated here and in `ai/TESTING.md` beside
 * the rule it bends.** Writing this file needs a lease that acquired *with* a description and then
 * ran a verb that produced bytes on a real device, and no device was attached to the machine that
 * made this change. The bend is narrow: one sentence of the shape an agent would write, in the
 * one-key object the writer builds, and the parse below is what keeps it a file the daemon could
 * really have written.
 *
 * The behaviour of the writer itself is not this file's — `tests/unit/daemon/archive.test.ts`
 * drives the real module against a real temp directory, including the file's name and the fact
 * that a lease with no description writes nothing at all.
 */

/** The one key of the file, parsed by the schema the value came off the wire in. */
const FiledDescriptionSchema = GrantedLeaseSchema.pick({ testDescription: true });

const files = fixture.files;

describe("the panel's test_description.json fixture", () => {
	it('is a file the archive could really have written', () => {
		for (const file of files) {
			expect(FiledDescriptionSchema.safeParse(file).success).toBe(true);
		}
	});

	// The key is the wire's own, so the file is the lease's field rather than a second spelling of
	// it. Named rather than inferred: this is the half that fails if the writer is renamed.
	it('carries the description under the wire own key and nothing else', () => {
		for (const file of files) {
			expect(Object.keys(file)).toEqual(['testDescription']);
		}
	});

	/*
	 * A value the host would have accepted on the wire, which is the only kind it can ever write:
	 * the string is stored exactly as given (D22), so the file's contents are bounded by
	 * `TestDescriptionSchema` and by nothing else.
	 */
	it('carries prose the wire would have accepted', () => {
		for (const file of files) {
			const parsed = FiledDescriptionSchema.parse(file);

			expect(TestDescriptionSchema.safeParse(parsed.testDescription).success).toBe(true);
		}
	});

	// An empty string is not a description on the wire, so it is not one in the archive either.
	it('carries no file standing in for a lease that described nothing', () => {
		expect(JSON.stringify(fixture)).not.toContain('"testDescription":""');
		expect(JSON.stringify(fixture)).not.toContain('"testDescription": ""');
	});
});
