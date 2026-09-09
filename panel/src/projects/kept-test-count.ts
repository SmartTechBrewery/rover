import { listKeptTests } from '@panel/archive/kept-tests.js';
import { useSession } from '@panel/session/session-provider.js';
import { useEffect, useRef, useState } from 'react';

/**
 * How many of one project's tests the host keeps — **one `list_kept_tests`, counted in the
 * browser, and no second host read** (D33, D35, #234).
 *
 * The delete confirmation is the only caller (`delete-project-dialog.tsx`), and the number is
 * there because a delete takes a kept test with the rest of the subtree (D35's amendment): the
 * `Keep` flag exempts a test from the two retention bounds and from nothing else, so *how many
 * exemptions this removes* is a fact the operator is owed before pressing rather than after.
 *
 * **The count is derived rather than asked for**, which is the whole reason no method is added
 * here: `list_kept_tests` answers the host's entire set in one call and every entry carries its
 * `project` (`kept-tests.ts`), so filtering that set is arithmetic on an answer the panel already
 * has a mirror for — and a `count_kept_tests` would be a second row on `PANEL_METHODS` answering
 * a question the first one already answers.
 *
 * **It is read where it is drawn, and drawn only while a dialog is open.** The hook is mounted by
 * the confirmation and dies with it, so a Projects screen listing fourteen registrations makes no
 * read at all until somebody asks about one of them — the reason this is not on the card and not
 * on the screen. Reopening the dialog asks again, which is correct: the store is written by
 * `set_kept_tests` from another screen and by `rover keep` from a shell, and the answer this
 * dialog states has to be the one the host holds now.
 */

/**
 * What the dialog knows about the count, and it is deliberately three states rather than a number.
 *
 * **`unknown` must not render as `0`**, which is the same rule `archive-size.ts` keeps for the
 * bytes and `file-size.ts` states for a size the host could not `stat`: *none of its tests are
 * kept* is the fact that stops the sentence beside it being alarming, so claiming it about a store
 * the host could not read would be the panel inventing the reassurance. It folds `unreadable`, an
 * `error` envelope, an unparseable result and a request nothing answered — the fold every other
 * read in this panel makes, landing on the state whose words are true either way.
 *
 * A `refused` session sets nothing and stays `loading`: `Session.call` has fired `onRefusal`, the
 * router is coming down, and *the host could not say* would be the panel's last word being the
 * wrong one.
 */
export type KeptTestCount =
	| { readonly status: 'loading' }
	/** The host's set was read and counted. `0` is **none of this project's tests are kept**. */
	| { readonly status: 'counted'; readonly count: number }
	/** The host could not say what it keeps, so this panel cannot say how many go. */
	| { readonly status: 'unknown' };

const LOADING: KeptTestCount = { status: 'loading' };

/**
 * The count for one project, by the identifier the host answers `list_projects` with.
 *
 * **Matched on the entry's own `project`, verbatim and parsed by nothing** (D22): the store holds
 * the archive's own two components as the archive filed them, and a registered project's
 * identifier is that same string. A lease may name any project string and the archive may have
 * rewritten it — which is the host's problem on the delete itself (D42) and not this count's, so
 * nothing here re-derives a name.
 */
export function useKeptTestCount(project: string): KeptTestCount {
	const { call } = useSession();
	const [count, setCount] = useState<KeptTestCount>(LOADING);
	/*
	 * A ref rather than state, `archive-size.ts`'s guard for its reason: React 19's StrictMode runs
	 * a mount effect twice and a guard held in state would not have been written back before the
	 * second run, so one dialog would read the host's store twice — visible in the daemon's own
	 * log.
	 *
	 * **It carries which project it was asked for, rather than a boolean**, which is the shape
	 * `archive-size.ts` keys on a `Set` of scopes for: `project` is in the dependency list below, so
	 * a changed identifier on a mounted instance re-runs the effect, and a boolean guard would
	 * refuse the read and leave `count` holding the *previous* project's number for the dialog to
	 * draw as this one's. No caller reaches that today — the dialog is mounted only while `asking`
	 * is true and each card is keyed on its identifier — but a dependency list that advertises a
	 * re-read the guard then refuses is what the next caller copies out of here.
	 */
	const askedFor = useRef<string | null>(null);
	const live = useRef(true);

	useEffect(() => {
		live.current = true;
		if (askedFor.current !== project) {
			askedFor.current = project;
			// Back to *reading…* rather than the previous project's number, for the whole of the
			// window this read is out. `LOADING` is one constant, so the first mount's set is a no-op.
			setCount(LOADING);
			void (async () => {
				// No parameter at all — the method answers the whole set, and the filter is here.
				const answer = await listKeptTests(call);
				/*
				 * A superseded read lands on nothing: `live.current` is true again after the effect
				 * re-runs, so the guard has to be the identifier this answer was asked for — two
				 * reads' answers are not ordered by the requests that asked for them.
				 */
				if (!live.current || askedFor.current !== project || answer.outcome === 'access-ended') {
					return;
				}
				setCount(
					answer.outcome === 'listed'
						? {
								status: 'counted',
								count: answer.tests.filter((test) => test.project === project).length,
							}
						: { status: 'unknown' },
				);
			})();
		}
		return () => {
			live.current = false;
		};
	}, [call, project]);

	return count;
}
