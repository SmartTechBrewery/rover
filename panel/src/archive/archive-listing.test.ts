import { describe, expect, it } from 'vitest';
import fixture from '../../../tests/fixtures/panel/list-archive.json';
import { ListArchiveResultSchema } from './archive-listing.js';

/**
 * The panel's half of the drift gate `tests/unit/panel/list-archive-fixture.test.ts` opens.
 *
 * The same seven captured levels, parsed here by the mirror and there by the daemon's own schemas.
 * What this half proves is that every field the screen renders survives the parse; what the other
 * half proves is that the file is a set of answers the daemon could really give.
 */
describe("the panel's mirror of list_archive", () => {
	it('reads every level of a real capture', () => {
		for (const level of fixture.levels) {
			expect(ListArchiveResultSchema.safeParse(level.result).success).toBe(true);
		}
	});

	it('reads the three kinds, down to the fields the screen renders', () => {
		const entries = fixture.levels.flatMap((level) => {
			const parsed = ListArchiveResultSchema.parse(level.result);
			return parsed.outcome === 'listed' ? parsed.entries : [];
		});

		const directory = entries.find((entry) => entry.name === 'recordings');
		expect(directory).toEqual({
			kind: 'directory',
			name: 'recordings',
			childCount: 1,
			onlyChild: '001.mp4',
		});
		expect(entries.find((entry) => entry.name === 'device_info.json')).toEqual({
			kind: 'file',
			name: 'device_info.json',
			sizeBytes: 80,
		});
		expect(entries.find((entry) => entry.kind === 'other')).toEqual({
			kind: 'other',
			name: 'latest_recording',
		});
	});

	it('keeps `null` distinguishable from a number, which is the whole of `unknown`', () => {
		const opaque = fixture.levels.find((level) => level.path.at(-1) === 'opaque-test');
		const parsed = ListArchiveResultSchema.parse(opaque?.result);

		expect(parsed.outcome).toBe('listed');
		if (parsed.outcome !== 'listed') {
			return;
		}
		const [child, file] = parsed.entries;
		expect(child).toMatchObject({ kind: 'directory', childCount: null, onlyChild: null });
		expect(file).toMatchObject({ kind: 'file', sizeBytes: null });
	});

	it('reads all three outcomes and keeps empty apart from unreadable', () => {
		expect(ListArchiveResultSchema.parse({ outcome: 'listed', entries: [] })).toEqual({
			outcome: 'listed',
			entries: [],
		});
		expect(ListArchiveResultSchema.parse({ outcome: 'missing' }).outcome).toBe('missing');
		expect(ListArchiveResultSchema.parse({ outcome: 'unreadable' }).outcome).toBe('unreadable');
	});

	/*
	 * The one deliberate difference from the host's copy: nothing here is `.strict()`. A browser
	 * that blanked a working screen because a newer daemon added a column would be worse than one
	 * that ignored it, so an unknown field is stripped rather than refused.
	 */
	it('strips a field it does not know rather than refusing the answer', () => {
		const parsed = ListArchiveResultSchema.parse({
			outcome: 'listed',
			entries: [{ kind: 'file', name: 'device_info.json', sizeBytes: 80, modifiedAt: 'later' }],
			totalBytes: 4096,
		});

		expect(parsed).toEqual({
			outcome: 'listed',
			entries: [{ kind: 'file', name: 'device_info.json', sizeBytes: 80 }],
		});
	});

	// A name is the on-disk name and nothing validates it further here: the host already bounded it,
	// and a panel that refused one would make a level the host answered with unreachable.
	it('accepts a name a filesystem allows and a reader would not expect', () => {
		const parsed = ListArchiveResultSchema.parse({
			outcome: 'listed',
			entries: [{ kind: 'directory', name: 'a b%c#d', childCount: 0, onlyChild: null }],
		});

		expect(parsed.outcome === 'listed' && parsed.entries[0]?.name).toBe('a b%c#d');
	});
});
