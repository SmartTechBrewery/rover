import { describe, expect, it } from 'vitest';
import { ForceReleaseDeviceResultSchema, ForceReleaseRefusalReasonSchema } from '@/ipc/methods.js';
import fixture from '../../fixtures/panel/force-release.json' with { type: 'json' };

/**
 * The daemon's half of the second drift gate, and `list-devices-fixture.test.ts`'s reasoning
 * applies verbatim.
 *
 * `panel/src/devices/force-release.ts` re-declares `force_release_device`'s params, its three
 * refusal reasons and its result union rather than importing them, for the same structural reason
 * the listing's mirror exists: the panel is a separate tree, and `src/ipc/methods.ts` drags
 * `core/device.ts`, `core/capabilities.ts` and the verb schemas into a browser bundle behind it.
 * A second copy of a wire shape is a thing that drifts.
 *
 * So one fixture is parsed twice, by two projects that cannot import each other: **here** by the
 * host's own `.strict()` schema, which is what makes each entry an answer the daemon could really
 * give, and in `panel/src/devices/force-release.test.ts` by the panel's mirror. Drift matters more
 * on this method than on the listing: the mirror deliberately narrows a reason it does not
 * recognise to `unanswered` (`force-release.ts`), so a reason renamed on the host would leave both
 * suites green while every refusal in the browser silently became *"Nothing came back from the
 * host"* — a wrong sentence rather than a failure.
 *
 * **Every entry is constructed rather than captured, and that is stated here and in `ai/TESTING.md`
 * beside the rule it bends** (§"A wire answer is a fixture too"). The listing's fixture could be
 * captured in three reads off one machine; these four need four different host states — a live
 * lease to end, a free attached device, a device that vanished between two enumerations, and a
 * device reachable only over a network transport (D18) — and the last two cannot be arranged on the
 * emulator host that captured the listing. What keeps them honest is this half: each `message` is
 * the daemon's own wording, copied from `src/daemon/lease-handlers.ts` and `src/core/errors.ts`,
 * and the schema below is `.strict()`, so a field this file invents fails here rather than teaching
 * the panel a shape the host never sends.
 */
describe("the panel's force_release_device fixture", () => {
	it.each(
		fixture.map((answer, index) => [index, answer] as const),
	)('entry %i is an answer the daemon could give', (_index, answer) => {
		const parsed = ForceReleaseDeviceResultSchema.safeParse(answer);

		expect(parsed.success).toBe(true);
	});

	// One released answer and one refusal per reason, driven off the host's own enum so a fourth
	// reason added there fails here until the fixture — and so the panel's mirror — covers it.
	it('carries every outcome the panel has to tell apart', () => {
		const parsed = fixture.map((answer) => ForceReleaseDeviceResultSchema.parse(answer));

		expect(parsed.filter((answer) => answer.outcome === 'released')).toHaveLength(1);
		expect(
			parsed.flatMap((answer) => (answer.outcome === 'refused' ? [answer.reason] : [])).sort(),
		).toEqual([...ForceReleaseRefusalReasonSchema.options].sort());
	});

	// The released answer is the public projection and never the credential (D20), which is the one
	// thing about this method that must not drift in either direction.
	it('names the holder without disclosing the lease id', () => {
		expect(JSON.stringify(fixture)).not.toContain('leaseId');
		expect(JSON.stringify(fixture)).not.toContain('"id"');
	});
});
