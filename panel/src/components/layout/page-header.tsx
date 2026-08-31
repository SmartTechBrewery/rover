import type { ReactNode } from 'react';
import { Breadcrumb, type BreadcrumbSegment } from './breadcrumb.js';

/**
 * The furniture every panel screen shares above its content (`docs/DESIGN.md` §3): the
 * breadcrumb, then one line describing the screen on the left, over a rule.
 *
 * `aside` is the right-hand slot the Devices screen puts its held/free counter in. It renders
 * nothing on its own, because that counter is live data and this shell has none — the states
 * of one screen must not differ in this row's shape, which is most of what §3 exists to fix.
 *
 * There is deliberately no title prop. The breadcrumb is the page's identity.
 */
export function PageHeader({
	trail,
	description,
	aside,
}: {
	readonly trail: readonly BreadcrumbSegment[];
	readonly description: string;
	readonly aside?: ReactNode;
}) {
	return (
		<header>
			<Breadcrumb trail={trail} />
			<div className="mt-4 flex flex-col justify-between gap-4 border-outline-variant border-b-2 pb-6 md:flex-row md:items-end">
				<p className="font-code-md text-code-md text-on-surface-variant">{description}</p>
				{aside}
			</div>
		</header>
	);
}
