import type { ArchivedFile, HostAnswer } from '@panel/session/host-client.js';
import { useSession } from '@panel/session/session-provider.js';
import { useEffect, useRef, useState } from 'react';
import { keyOf } from './archive-path.js';

/**
 * Reading **one named file out of a run**, once — the machinery `device-info.ts` established for
 * `device_info.json` (#136, #131's byte route), now shared with `test-description.ts` (#148).
 *
 * There are two of these files and there will not be a third by accident: both are written by the
 * archive itself rather than by a verb, both live in a run's `<serial>` directory, and both are
 * read the same way. What each of them *means* differs and stays in its own module — the shape it
 * parses, the states it folds an answer into, and the sentences the card draws. What is here is
 * only the part that must not differ: which address is asked for, when, and how many times.
 *
 * **One request per run, cached for the life of the screen** and never re-read on an interval, for
 * the reason `archive-levels.ts` gives: a run directory is written while a lease is live and
 * nothing is added once it ends, so there is nothing for a poll to notice. The `asked` guard is a
 * ref rather than state for that file's other reason — React 19's StrictMode runs an effect twice
 * on mount, and a guard written back on render would let one file be fetched twice.
 */

/**
 * One run's file, read once when the run is opened.
 *
 * **`level` is the run's `<serial>` level**, the components a listing answered, and this hook
 * appends `fileName` — so no caller composes an address and there is nothing here a host
 * filesystem path would fit in (D19). `null` is *there is no address yet*, which is the state of a
 * run whose parent level has not answered: nothing is asked and nothing comes back. A serial that
 * will never arrive is not this hook's to describe — the caller holding that answer says so
 * instead, which is why `null` is not a status here (`run-panel.tsx`).
 *
 * `fold` maps one answer onto the caller's own state, or onto `undefined` for an answer that must
 * set nothing at all. **It is in this effect's dependencies, so it has to be a module-level
 * function**: an inline closure would be a new identity every render, and this file would then be
 * fetched again on each one.
 */
export function useArchivedRunFile<State>(
	level: readonly string[] | null,
	fileName: string,
	fold: (answer: HostAnswer<ArchivedFile>) => State | undefined,
	reading: State,
): State {
	const { readArtifactText } = useSession();
	const [read, setRead] = useState<ReadonlyMap<string, State>>(() => new Map());
	const asked = useRef<Set<string>>(new Set());
	const live = useRef(true);

	// Keyed on the components themselves rather than on the array's identity, which the caller
	// rebuilds every render — `archive-levels.ts`'s idiom, and `null` stringifies to a value no
	// path can produce.
	const wanted = JSON.stringify(level);

	useEffect(() => {
		live.current = true;
		const components = JSON.parse(wanted) as string[] | null;
		if (components !== null) {
			const key = keyOf(components);
			if (!asked.current.has(key)) {
				asked.current.add(key);
				void (async () => {
					const answer = await readArtifactText([...components, fileName]);
					if (!live.current) {
						return;
					}
					const state = fold(answer);
					if (state === undefined) {
						return;
					}
					setRead((previous) => new Map(previous).set(key, state));
				})();
			}
		}
		return () => {
			live.current = false;
		};
	}, [wanted, fileName, fold, readArtifactText]);

	if (level === null) {
		return reading;
	}
	return read.get(keyOf(level)) ?? reading;
}
