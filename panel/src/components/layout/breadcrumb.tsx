import { Link } from '@tanstack/react-router';
import { Fragment } from 'react';

export interface BreadcrumbSegment {
	readonly label: string;
	/** Absent on the last segment: where you are is not a link. */
	readonly to?: string;
}

/**
 * Depth in the current hierarchy, and nothing else (`docs/DESIGN.md` §3).
 *
 * At the root that is the screen's own name; deeper it is `Archive > checkout-app`, with `>`
 * arrows rather than slashes. The last segment carries the same green accent as the active
 * nav item, because it means the same thing — you are here — and it is not a link.
 *
 * **Nothing but path segments may go in here.** No status chips, no counts. The Archive
 * screen opens its path with a `SUCCESS` chip, which is wrong twice over: it is not a path
 * segment, and Rover has no verdicts to report.
 *
 * The panel has no `<h1>`: this is the page's identity. A heading one line below repeating
 * the same word earned nothing, and the breadcrumb already says it in the colour that means
 * "you are here".
 *
 * 12px comes from Tailwind's own `--text-xs` rather than from `text-label-caps`, which would
 * drag 700 weight and 0.1em tracking along with the size.
 */
export function Breadcrumb({ trail }: { trail: readonly BreadcrumbSegment[] }) {
	return (
		<nav aria-label="Breadcrumb" className="font-code-md text-xs">
			<ol className="flex flex-wrap items-center gap-2">
				{trail.map((segment, index) => {
					const isCurrent = index === trail.length - 1;
					return (
						<Fragment key={segment.label}>
							{index > 0 && (
								<li aria-hidden="true" className="text-outline">
									&gt;
								</li>
							)}
							<li>
								{isCurrent || !segment.to ? (
									<span aria-current="page" className="text-tertiary">
										{segment.label}
									</span>
								) : (
									<Link
										to={segment.to}
										className="text-on-surface-variant transition-colors hover:text-on-surface"
									>
										{segment.label}
									</Link>
								)}
							</li>
						</Fragment>
					);
				})}
			</ol>
		</nav>
	);
}
