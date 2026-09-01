import { describe, expect, it } from 'vitest';
import { ListArchiveParamsSchema, ListArchiveResultSchema } from '@/ipc/methods.js';
import fixture from '../../fixtures/panel/list-archive.json' with { type: 'json' };

/**
 * The daemon's half of the Archive screen's drift gate.
 *
 * `panel/src/archive/archive-listing.ts` re-declares `list_archive`'s answer instead of importing
 * these schemas, for the structural reason `list-devices-fixture.test.ts` sets out: the panel is a
 * separate tree with its own `tsconfig.json` and its own alias, and `src/ipc/methods.ts` drags
 * `core/device.ts`, `core/capabilities.ts` and the verb schemas into a browser bundle behind it.
 * So one fixture is parsed twice, by two projects that cannot import each other — **here** by the
 * host's own schemas, and in `panel/src/archive/archive-listing.test.ts` by the panel's mirror.
 *
 * **This file is a level list, which is one deliberate extension of the shape `list-devices.json`
 * set** (`ai/TESTING.md`, "A wire answer is a fixture too"): `list_archive` answers *a level*, and
 * the screen draws four of them plus the two states with nothing in them. One answer per file
 * would have been six files pinning the same schema.
 *
 * **Every one of the seven levels was captured, and none was hand-edited.** Unlike `list_devices`,
 * this method needs no device — it reads the host's own disk — so the whole file is the daemon's
 * own bytes off the panel's HTTP surface (`ROVER_HTTP_PORT`) against a seeded
 * `ROVER_ARTIFACTS_PATH`. The two awkward cases came from the filesystem rather than from a text
 * editor: a directory with mode `400` is readable but not traversable, so its listing succeeds
 * while every `stat` under it fails (`sizeBytes: null`, `childCount: null`), and one with mode
 * `000` is `unreadable` on its own listing and `childCount: null` one level up.
 */

const levels = fixture.levels;

describe("the panel's list_archive fixture", () => {
	it('is a set of answers the daemon could give', () => {
		for (const level of levels) {
			expect(ListArchiveResultSchema.safeParse(level.result).success).toBe(true);
		}
	});

	// A level's `path` is the components a previous answer returned, so every one of them has to be
	// a request the daemon would accept — which is what makes this file a *walk* rather than seven
	// unrelated answers.
	it('names levels the daemon would accept a request for', () => {
		for (const level of levels) {
			expect(ListArchiveParamsSchema.safeParse({ path: level.path }).success).toBe(true);
		}
	});

	it('carries all three outcomes, because the screen renders all three differently', () => {
		const outcomes = new Set(levels.map((level) => level.result.outcome));

		expect(outcomes).toEqual(new Set(['listed', 'missing', 'unreadable']));
	});

	it('carries the nullable cases the Archive screen has to render as `unknown`', () => {
		const entries = levels.flatMap((level) => {
			const parsed = ListArchiveResultSchema.parse(level.result);
			return parsed.outcome === 'listed' ? parsed.entries : [];
		});

		expect(entries.some((entry) => entry.kind === 'directory' && entry.childCount === null)).toBe(
			true,
		);
		expect(entries.some((entry) => entry.kind === 'file' && entry.sizeBytes === null)).toBe(true);
		expect(entries.some((entry) => entry.kind === 'other')).toBe(true);
	});

	// `onlyChild` is the whole of the `SERIAL` field: one lease is one device, so the serial is a
	// fact about the run rather than a tree level the panel goes and asks for.
	it('carries a run directory whose one child is the serial', () => {
		const runs = levels.find((level) => level.path.length === 2);
		const entries = ListArchiveResultSchema.parse(runs?.result);

		expect(entries.outcome).toBe('listed');
		if (entries.outcome !== 'listed') {
			return;
		}
		for (const entry of entries.entries) {
			expect(entry.kind).toBe('directory');
			if (entry.kind === 'directory') {
				expect(entry.onlyChild).not.toBeNull();
			}
		}
	});

	// A legacy `unlabeled/` directory is a directory like any other on this wire, and the screen
	// gives it no special treatment either (D22, as amended #129).
	it('carries the legacy unlabeled directory as an ordinary entry', () => {
		const project = levels.find((level) => level.path.length === 1);
		const listing = ListArchiveResultSchema.parse(project?.result);

		expect(listing.outcome).toBe('listed');
		if (listing.outcome !== 'listed') {
			return;
		}
		expect(listing.entries.some((entry) => entry.name === 'unlabeled')).toBe(true);
	});
});
