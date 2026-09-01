import { QuietBanner } from '@panel/components/quiet-banner.js';
import { EyeOff } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * The Archive screen's right-hand card, and the two things it says when there is nothing in it.
 *
 * One shell for all four levels and for the artifact preview (`docs/DESIGN.md` §9): the header strip
 * says what is in the card, and the body is whatever that turned out to be. The levels are one
 * component with different rows rather than three screens, which is what keeps the header and the
 * tree beside them identical in every state — and the preview is the same frame again, with only
 * what sits inside it differing.
 */

/**
 * The card's shell.
 *
 * **`header` is a slot rather than a title** (#133). Three callers put three different things in
 * that strip — a level's name, `Run Details` or a back arrow alone, and a file's name beside `Open
 * in a new window` — and the strip's own padding, rule and surface are the thing that must not
 * differ between them. A `title: string` made the third of those impossible and would have grown a
 * second card component to hold it.
 *
 * `min-w-0` beside `flex-1` is the other half of the equal-halves rule §9 settles: two `flex-1`
 * columns only stay equal while neither is allowed to be wider than its content. It is inert in the
 * single-card layout and load-bearing in the preview's.
 */
export function ContentsCard({
	header,
	children,
}: {
	readonly header: ReactNode;
	readonly children: ReactNode;
}) {
	return (
		<section className="flex min-h-[400px] min-w-0 flex-1 flex-col overflow-hidden rounded-lg border-2 border-outline-variant bg-surface-container">
			<div className="border-outline-variant border-b-2 bg-surface-container-high px-4 py-3">
				{header}
			</div>
			<div className="flex-1 overflow-y-auto">{children}</div>
		</section>
	);
}

/**
 * What a name in that strip looks like — the design's own heading, in one place because three cards
 * draw it.
 *
 * Verbatim, and wrapping at its own separators: a run directory name is 40 characters, and
 * `break-words` rather than `break-all` for §9's reason — the latter splits `issue-112` across two
 * lines.
 */
export function CardHeading({ children }: { readonly children: string }) {
	return (
		<h2 className="break-words font-code-md font-bold text-[15px] text-on-surface">{children}</h2>
	);
}

/**
 * A directory deeper down with nothing in it — **said plainly, with no alarm** (the issue's own
 * words). It is not a panel and not a banner: one sentence in the space the rows would have used.
 *
 * Its copy shares no phrase with {@link ArchiveNotReadable}, and `archive.test.tsx` asserts that
 * neither ever appears in the other — the way `devices.test.tsx` already does for *nothing
 * attached* and *no view*.
 */
export function NothingFiledHere() {
	return (
		<p className="font-code-md text-code-md text-on-surface-variant">
			Nothing is filed under this directory. Rover writes one only when a verb produces bytes, so
			this is an ordinary answer rather than a fault.
		</p>
	);
}

/**
 * The host cannot say what is in this level — `docs/DESIGN.md` §7's grey treatment, reused.
 *
 * **One clause in the heading, and the second line is the whole point**: an unreadable directory
 * and an empty one are the pair that must never render alike, exactly as *no view* and *nothing
 * attached* are on the Devices screen (D6).
 *
 * There is **no retry control and no error code**. The panel can say *that* the host could not read
 * it and never why — the reason and the path stay on the host, which is what
 * `src/daemon/list-archive.ts` warns about there instead of putting it on the wire (D19).
 */
export function ArchiveNotReadable() {
	return (
		<QuietBanner Icon={EyeOff} heading="ARCHIVE NOT READABLE">
			Rover cannot see into this directory. Something is there and the host will not read it.
			<span className="mt-2 block">
				This is not the same as the archive being empty — runs may well be filed here.
			</span>
		</QuietBanner>
	);
}

/**
 * The same banner, inside a card rather than taking the whole content area.
 *
 * Same words, because it is the same fact — the root of the archive is a directory like any other,
 * and *runs may well be filed here* is exactly as true one level down. `QuietBanner` carries the
 * top margin the screen-level state wants; the side padding is what stops it sitting flush against
 * the card's own border.
 */
export function NotReadableInCard() {
	return (
		<div className="px-6 pb-6">
			<ArchiveNotReadable />
		</div>
	);
}

/** One quiet line, `aria-live` and no spinner — `devices.tsx`'s precedent, and §5 has no exception. */
export function ReadingLevel() {
	return (
		<p aria-live="polite" className="font-code-md text-code-md text-on-surface-variant">
			Reading this level of the archive.
		</p>
	);
}

/** A row's label — the design's `OWNER` / `GRANTED` / `SERIAL` block, which appears four times. */
export function Field({ label, children }: { readonly label: string; readonly children: string }) {
	return (
		<div className="flex flex-col">
			<span className="mb-1 font-label-caps text-[10px] text-outline uppercase">{label}</span>
			<span className="break-words font-code-md text-[13px] text-on-surface-variant">
				{children}
			</span>
		</div>
	);
}
