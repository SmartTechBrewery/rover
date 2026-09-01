import { QuietBanner } from '@panel/components/quiet-banner.js';
import { EyeOff } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * The Archive screen's right-hand card, and the two things it says when there is nothing in it.
 *
 * One shell for all four levels (`docs/DESIGN.md` §9): the header strip names what is selected, and
 * the body is whatever that level turned out to be. The three levels are one component with
 * different rows rather than three screens, which is what keeps the header and the tree beside them
 * identical in every state.
 */

export function ContentsCard({
	title,
	children,
}: {
	readonly title: string;
	readonly children: ReactNode;
}) {
	return (
		<section className="flex min-h-[400px] flex-1 flex-col overflow-hidden rounded-lg border-2 border-outline-variant bg-surface-container">
			<div className="border-outline-variant border-b-2 bg-surface-container-high px-4 py-3">
				{/* Verbatim, and wrapping at its own separators: a run directory name is 40 characters. */}
				<h2 className="break-words font-code-md font-bold text-[15px] text-on-surface">{title}</h2>
			</div>
			<div className="flex-1 overflow-y-auto">{children}</div>
		</section>
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
