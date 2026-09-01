import type { ReactNode } from 'react';

/**
 * A destination that has nothing on it, said as normal, common and *finished* — the treatment
 * `docs/DESIGN.md` §7 settled for *nothing attached* and §9 reuses for *nothing in the archive*.
 *
 * No error colour, no warning icon, no spinner and nothing that suggests loading. A counter is
 * **absent** rather than reading `0`, which would describe a pool or a count.
 *
 * Extracted from `routes/devices.tsx` in #132 for its second user, with the emitted DOM preserved
 * exactly: `devices.test.tsx` reaches this panel as `section > div` and asserts
 * `bg-surface-container-lowest`, and the point of the extraction is that both screens say
 * *nothing here* in one shape rather than in two class lists that drift.
 */
export function QuietPanel({
	heading,
	children,
}: {
	readonly heading: string;
	readonly children: ReactNode;
}) {
	return (
		<section className="mt-8 flex justify-center">
			<div className="relative flex w-full max-w-2xl flex-col items-center border-2 border-outline-variant bg-surface-container-lowest p-12 text-center">
				{/*
				 * The design's corner accents. They are deliberately corners and not a dot-and-lines
				 * rule under the message: that reads as a progress track, which is the one impression
				 * this state must not give.
				 */}
				<span
					aria-hidden="true"
					className="absolute top-0 left-0 size-4 border-outline-variant border-t-2 border-l-2"
				/>
				<span
					aria-hidden="true"
					className="absolute top-0 right-0 size-4 border-outline-variant border-t-2 border-r-2"
				/>
				<span
					aria-hidden="true"
					className="absolute bottom-0 left-0 size-4 border-outline-variant border-b-2 border-l-2"
				/>
				<span
					aria-hidden="true"
					className="absolute right-0 bottom-0 size-4 border-outline-variant border-r-2 border-b-2"
				/>

				<h2 className="font-headline-sm text-headline-sm text-on-surface">{heading}</h2>
				<p className="mt-6 max-w-lg font-body-lg text-body-lg text-on-surface-variant">
					{children}
				</p>
			</div>
		</section>
	);
}
