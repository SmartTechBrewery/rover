import type { ArchivedArtifact, HostAnswer } from '@panel/session/host-client.js';
import { useSession } from '@panel/session/session-provider.js';
import { useEffect, useRef, useState } from 'react';
import { type ArtifactBodyKind, bodyKindFor, linesOf } from './artifact-body.js';

/**
 * The one artifact the Archive screen has open, as bytes the browser can be given an address for
 * (#133, `docs/DESIGN.md` §9).
 *
 * **The bytes come through the session, not through the markup.** `GET /artifact/…` is behind the
 * same per-request gate as every method, and a subresource fetch — an `<img src>`, a `<video src>`
 * — is the browser's own request carrying no `Authorization` header, so it would get the host's
 * uniform `401` (D29, D30); a credential in the URL is what D20 forbids. So the panel fetches with
 * the session header and hands the browser the object URL. `host-client.ts` says the same thing from
 * the transport's side.
 *
 * **One artifact at a time, and it is deliberately not cached** — the difference from
 * `archive-levels.ts` and `device-info.ts`, which both cache for the life of the screen. A recording
 * is megabytes and its object URL is a live handle on them: a cache of those is a memory leak with a
 * name. So the URL's lifetime *is* the state that holds it, and it is revoked when the address
 * changes and on unmount.
 *
 * **No polling, no prefetch and no deadline**, for the reasons those two modules give: the archive
 * is finished data read once on navigation, and a budget belongs to a repeating caller.
 */

/**
 * What the preview draws, with the address it draws it from.
 *
 * `text` carries both, because the lines are what the gutter numbers and the URL is what **Open in
 * a new window** opens — one fetch answering both, rather than a second request for the same file.
 *
 * `opaque` carries no URL on purpose. There is nothing a browser would display, so a control
 * offering to open it in a tab would be offering a download, and there is no download control
 * anywhere in the panel (`docs/DESIGN.md` §10).
 */
export type ArtifactBody =
	| { readonly kind: 'image'; readonly url: string }
	| { readonly kind: 'recording'; readonly url: string }
	| { readonly kind: 'text'; readonly url: string; readonly lines: readonly string[] }
	| { readonly kind: 'opaque' };

/**
 * The four answers the screen has about the file, and `missing`/`unreadable` are `list_archive`'s
 * own two words one level down.
 *
 * *Nothing is filed at this address* and *something is filed there and this host will not read it*
 * must never render alike — the pair `device-info.ts` holds one file up and the archive's levels
 * hold one directory up (D6).
 */
export type ArchivedArtifactState =
	| { readonly status: 'reading' }
	| { readonly status: 'read'; readonly body: ArtifactBody }
	| { readonly status: 'missing' }
	| { readonly status: 'unreadable' };

const READING: ArchivedArtifactState = { status: 'reading' };
const UNREADABLE: ArchivedArtifactState = { status: 'unreadable' };

/**
 * One artifact, read once when its address becomes the address.
 *
 * `null` is *there is no artifact open* — a folder is beside the run's column instead — and nothing
 * is fetched, which is `useArchivedDeviceInfo`'s rule for the same argument: a request is not made
 * on a guess about what an address names.
 *
 * The `asked` guard is a ref rather than state for `archive-levels.ts`'s reason: React 19's
 * StrictMode runs an effect twice on mount, and two `GET`s of a recording would be visible in the
 * host's own log. The object URL is created **after** the `live` check, so an answer that outlived
 * the screen creates nothing there is nobody left to revoke.
 */
export function useArchivedArtifact(path: readonly string[] | null): ArchivedArtifactState {
	const { readArtifactBytes } = useSession();
	// Keyed on the components themselves rather than on the array's identity, which the caller
	// rebuilds every render — `archive-levels.ts`'s idiom, and `null` stringifies to a value no path
	// can produce.
	const wanted = JSON.stringify(path);
	/*
	 * The state **with the address it is about**, so a navigation cannot render the previous file for
	 * one turn: one frame of the wrong screenshot is exactly the kind of thing a reader would take
	 * for the file they opened, and the object URL of the file they left has already been revoked by
	 * then.
	 */
	const [held, setHeld] = useState<{
		readonly of: string;
		readonly state: ArchivedArtifactState;
	}>({ of: wanted, state: READING });
	const asked = useRef<string | null>(null);
	const live = useRef(true);
	/*
	 * The address the screen is on now, which is **not** the same question as whether the screen is
	 * still mounted — and both have to be asked before an answer creates an object URL. `live` alone
	 * would let a slow answer for the file somebody navigated away from create a handle nothing owns:
	 * the state that would have revoked it is not the state being rendered.
	 */
	const shown = useRef(wanted);

	useEffect(() => {
		live.current = true;
		shown.current = wanted;
		if (asked.current === wanted) {
			return () => {
				live.current = false;
			};
		}
		asked.current = wanted;
		// Whatever was held is about to be about a different address. Cleared here rather than left to
		// the comparison below, so an address returned to — open a file, press back, open it again —
		// re-reads rather than rendering the URL that was revoked on the way out.
		setHeld((previous) =>
			previous.of === wanted && previous.state.status === 'reading'
				? previous
				: { of: wanted, state: READING },
		);

		const components = JSON.parse(wanted) as string[] | null;
		if (components !== null) {
			const stillWanted = () => live.current && shown.current === wanted;
			void (async () => {
				const answer = await readArtifactBytes(components);
				if (!stillWanted()) {
					return;
				}
				const state = await folded(answer, stillWanted);
				if (state === undefined) {
					return;
				}
				setHeld({ of: wanted, state });
			})();
		}

		return () => {
			live.current = false;
		};
	}, [wanted, readArtifactBytes]);

	const state = held.of === wanted ? held.state : READING;
	const url = addressIn(state);

	/*
	 * **The URL's lifetime is this state's.** Keyed on the URL itself rather than on the address, so
	 * it is revoked when the address moves on, when a second answer replaces it, and on unmount — and
	 * a revoke can never outlive the string it names. The tab **Open in a new window** opened is
	 * reading through this same handle, so closing the preview stops a long recording still
	 * streaming into it; that cost is stated in `docs/DESIGN.md` §9 rather than worked around, since
	 * the alternative is a handle on megabytes that nothing owns.
	 */
	useEffect(() => {
		if (url === null) {
			return;
		}
		return () => {
			URL.revokeObjectURL(url);
		};
	}, [url]);

	return state;
}

/** The object URL a state holds, or `null` for the three states that hold none. */
function addressIn(state: ArchivedArtifactState): string | null {
	return state.status === 'read' && state.body.kind !== 'opaque' ? state.body.url : null;
}

/**
 * One answer, mapped onto {@link ArchivedArtifactState} — or nothing at all, for a `refused`.
 *
 * **Everything unusable folds into `unreadable`**: a `400`, a `500`, and a body the transport lost
 * on the way. That is the fold `archive-levels.ts` and `device-info.ts` already make and document —
 * what the screen has to decide is narrower than why. A **`refused`** sets nothing, because
 * `Session.readArtifactBytes` has already fired `onRefusal` and the router is coming down; *not
 * readable* would be the panel's last word being the wrong one.
 */
async function folded(
	answer: HostAnswer<ArchivedArtifact>,
	stillWanted: () => boolean,
): Promise<ArchivedArtifactState | undefined> {
	if (!answer.ok) {
		return answer.refusal === 'unanswered' ? UNREADABLE : undefined;
	}
	if (answer.value.outcome === 'missing') {
		return { status: 'missing' };
	}
	if (answer.value.outcome === 'unreadable') {
		return UNREADABLE;
	}

	const kind = bodyKindFor(answer.value.mediaType);
	// Read **before** the URL is created, because reading it is the half that can still fail: a
	// created URL abandoned in a `catch` is a handle nothing revokes.
	const lines = kind === 'text' ? await textOf(answer.value.bytes) : null;
	if (kind === 'text' && lines === null) {
		return UNREADABLE;
	}
	if (!stillWanted()) {
		// The screen went, or the address moved on, while the bytes were being decoded. Nothing is
		// created, so there is nothing to leak — the object URL is deliberately the last thing this
		// function does.
		return undefined;
	}
	return { status: 'read', body: bodyOf(kind, answer.value.bytes, lines) };
}

/** A text artifact's own lines, or `null` when the bytes would not decode. */
async function textOf(bytes: Blob): Promise<readonly string[] | null> {
	try {
		return linesOf(await bytes.text());
	} catch {
		return null;
	}
}

function bodyOf(
	kind: ArtifactBodyKind,
	bytes: Blob,
	lines: readonly string[] | null,
): ArtifactBody {
	if (kind === 'opaque') {
		return { kind };
	}
	const url = URL.createObjectURL(bytes);
	return kind === 'text' ? { kind, url, lines: lines ?? [] } : { kind, url };
}
