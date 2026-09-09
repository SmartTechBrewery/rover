import { describe, expect, it } from 'vitest';
import {
	ListArchiveParamsSchema,
	MeasureArchiveParamsSchema,
	MeasureArchiveResultSchema,
} from '@/ipc/methods.js';
import fixture from '../../fixtures/panel/measure-archive.json' with { type: 'json' };

/**
 * The daemon's half of the archive measurement's drift gate (#259).
 *
 * The panel re-declares every wire shape it reads instead of importing these schemas, for the
 * structural reason `list-archive-fixture.test.ts` sets out: the panel is a separate tree with its
 * own `tsconfig.json` and its own alias, and `src/ipc/methods.js` drags `core/device.ts`,
 * `core/capabilities.ts` and the verb schemas into a browser bundle behind it. So one fixture is
 * parsed twice, by two projects that cannot import each other — **here** by the host's own
 * schemas, and by the badge's own mirror when the badge is built. This half lands first and on its
 * own, which is `list-archive-groups.json`'s precedent and deliberate: this half of the gate is the
 * one the host owes, and it lands with the method rather than with the screen.
 *
 * **It is a scope list**, `list-archive.json`'s level list in the shape this method's question
 * takes: `{ "scopes": [ { "path": …, "result": … } ] }`. One answer per file would have been ten
 * files pinning one schema, and the badge draws every one of these ten differently.
 *
 * **Every scope was captured and none was hand-edited.** Like `list_archive` and `search_archive`,
 * this method needs no device — it reads the host's own disk — so the whole file is a daemon's own
 * bytes off the panel's HTTP surface (`ROVER_HTTP_PORT`) against a seeded `ROVER_ARTIFACTS_PATH`.
 * The awkward answers came from the filesystem rather than from a text editor, which is that
 * file's own trick: a directory with mode `000` answers `unreadable` when it is addressed, and one
 * that is readable but not traversable (mode `400`) below the scope answers a short sum that says
 * it is short. **`checkout-app/sealed-test` appears twice on purpose** — once empty and readable,
 * once mode `000` — because `bytes: 0` and *the host cannot say* are the pair the badge must never
 * render alike, and one directory answering both is the sharpest way to pin it.
 *
 * **Every `path` is parsed by `ListArchiveParamsSchema` as well as by this method's own.** That is
 * what makes *the archive has one path vocabulary* assertable rather than merely claimed: a scope
 * the badge measures is an address the listing the panel navigates with would itself accept.
 */

const scopes = fixture.scopes;

describe("the panel's measure_archive fixture", () => {
	it('is a set of answers the daemon could give', () => {
		for (const scope of scopes) {
			expect(MeasureArchiveResultSchema.safeParse(scope.result).success).toBe(true);
		}
	});

	it('was asked for with addresses the daemon would accept', () => {
		for (const scope of scopes) {
			expect(MeasureArchiveParamsSchema.safeParse({ path: scope.path }).success).toBe(true);
		}
	});

	// The load-bearing one. A scope is an address, so the badge and the level the panel navigates
	// to are the same place rather than two things that agree today.
	it('names scopes the daemon would accept a listing request for', () => {
		for (const scope of scopes) {
			expect(ListArchiveParamsSchema.safeParse({ path: scope.path }).success).toBe(true);
		}
	});

	it('carries all three outcomes, because the badge renders all three differently', () => {
		const outcomes = new Set(scopes.map((scope) => scope.result.outcome));

		expect(outcomes).toEqual(new Set(['measured', 'missing', 'unreadable']));
	});

	// A partial total must never render like a whole one, so the flag has to be on the wire in both
	// of its states or the badge's "at least" is unpinned.
	it('carries both a truncated answer and a complete one', () => {
		const flags = scopes.flatMap((scope) => {
			const parsed = MeasureArchiveResultSchema.parse(scope.result);
			return parsed.outcome === 'measured' ? [parsed.truncated] : [];
		});

		expect(new Set(flags)).toEqual(new Set([true, false]));
	});

	/*
	 * **Zero bytes and *the host could not say* are two answers about one directory.** Captured
	 * from one path measured twice — empty and readable, then mode `000` — because a badge that
	 * drew the second as `0 B` would report an operator's unreadable archive as an empty one, and
	 * that is the single mistake this method's three outcomes exist to make impossible.
	 */
	it('carries an empty measurement apart from one that could not be taken', () => {
		const sealed = scopes.filter((scope) => scope.path.join('/') === 'checkout-app/sealed-test');

		expect(sealed.map((scope) => MeasureArchiveResultSchema.parse(scope.result))).toEqual([
			{ outcome: 'measured', bytes: 0, truncated: false },
			{ outcome: 'unreadable' },
		]);
	});

	// The badge sits on every context of the `All` view, so a fixture that only carried the root
	// would leave every scope below it unpinned — including the two the depth alone distinguishes.
	it('measures every level of the archive, the root and a file included', () => {
		const depths = new Set(scopes.map((scope) => scope.path.length));

		expect(depths).toEqual(new Set([0, 1, 2, 3, 5, 6]));
	});
});
