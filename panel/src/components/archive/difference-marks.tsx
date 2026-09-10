import type { ImageMarks } from '@panel/archive/marked-differences.js';
import type { ReactNode } from 'react';

/**
 * **The boxes over the second artifact of a pair, where it differs from the first** (`docs/DESIGN.md`
 * §9).
 *
 * **The artifact underneath is untouched, and that is the whole of why this is an overlay rather
 * than a drawing.** Nothing is composited into the pixels: the `<img>` is the same element with the
 * same `src` on the same bytes the host filed, the marks are DOM on top of it, and turning them off
 * leaves the evidence exactly as it was with nothing to decode again. Baking them into a canvas
 * would have made the panel show an image no file in the archive contains — on the one screen whose
 * rule is *what you are looking at is the file*.
 *
 * **This is the deliberate exception to §9's clean region, and it is the only one.** That rule —
 * nothing laid over or around the artifact, a hairline border the most that is permitted — was
 * written against *decoration*: a scanline, a tint, a bezel, a gradient, all of which cost the
 * reader contrast over the exact thing they opened the screen to look at, and gave nothing back.
 * The marks are not decoration and they are not a verdict: they are the answer to a question the
 * reader asked by pressing a control, they are off until then, and they say *here* and nothing else.
 * Everything else on the list stays forbidden, here as everywhere.
 *
 * **One `<svg>` in the image's own pixel coordinates, and no measuring anywhere.** The `viewBox` is
 * the artifact's natural size, so a region — which `image-diff.ts` produces in exactly those
 * coordinates — is written into the markup unconverted, and the browser's own scaling puts it over
 * the pixels it is about. That is what makes this survive `object-contain`, a 240px pane, a
 * 700px one, a window resize and a zoom with no `ResizeObserver`, no `getBoundingClientRect` and no
 * layout effect — the class of code that puts an overlay a few pixels off the thing it marks.
 *
 * **`vector-effect="non-scaling-stroke"` is what keeps the boxes visible at a pane's width.** The
 * image is scaled by roughly a fifth in the narrowest pane, so a stroke stated in source pixels
 * would come out sub-pixel there and vanish; this states it in rendered pixels instead, so the box
 * is the same weight in a 240px pane as in a full window.
 *
 * **Two strokes per region, dark under bright.** A single stroke has to sit over arbitrary
 * screenshot colours — that is §5's own warning about this screen — and one colour cannot: the
 * palette's `secondary` disappears over a light app and a dark outline disappears over a dark one.
 * The pair is legible over both, and it is the same treatment at every region because **no region is
 * ranked**: there is no worse difference and no better one, so nothing here is red, nothing is
 * green, and nothing is numbered.
 */
export function DifferenceMarks({
	marks,
	children,
}: {
	readonly marks: ImageMarks;
	readonly children: ReactNode;
}) {
	return (
		/*
		 * Shrink-wrapped around the artifact so `inset-0` *is* the image's own box: the wrapper takes
		 * the image's size, and the image keeps the `max-w-full`/`max-h-[70vh]` pair that bounds it.
		 * A replaced element under both of those keeps its aspect ratio (CSS 2.1 §10.4), which is what
		 * makes the `viewBox` fit the box exactly rather than letterboxing inside it.
		 */
		<span className="relative inline-block max-w-full">
			{children}
			{/*
			 * `inset-px` with the size two pixels short of the box, and not `inset-0`: the hairline
			 * border is on the image, so the pixels sit one pixel inside its box on every side and
			 * that is where the coordinate space starts. The size is stated because an outer `<svg>`
			 * with no width defaults to 100% of its containing block, which would be the border box
			 * and would put every region two pixels out of true at full size.
			 *
			 * **The underscores are load-bearing**: `calc(100%-2px)` is not valid CSS, so Tailwind
			 * emits no utility for it at all and the class silently does nothing — caught by grepping
			 * the built stylesheet rather than by any test, since a missing utility fails no
			 * assertion and only shows up as an overlay two pixels too wide.
			 *
			 * `aria-hidden` because a box has nothing to say to a screen reader — the count and the
			 * state are text in the card's header strip, which is the channel that carries them.
			 */}
			<svg
				aria-hidden="true"
				className="pointer-events-none absolute inset-px size-[calc(100%_-_2px)]"
				viewBox={`0 0 ${marks.width} ${marks.height}`}
			>
				{marks.regions.map((region) => (
					<g key={`${region.x}-${region.y}-${region.width}-${region.height}`}>
						<rect
							className="fill-none stroke-surface-container-lowest"
							height={region.height}
							strokeWidth={4}
							vectorEffect="non-scaling-stroke"
							width={region.width}
							x={region.x}
							y={region.y}
						/>
						<rect
							className="fill-none stroke-secondary"
							height={region.height}
							strokeWidth={2}
							vectorEffect="non-scaling-stroke"
							width={region.width}
							x={region.x}
							y={region.y}
						/>
					</g>
				))}
			</svg>
		</span>
	);
}
