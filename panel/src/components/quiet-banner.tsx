import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * An uncertainty, not a fault — the grey block `docs/DESIGN.md` §7 settled for *host view not
 * current* and §9 reuses for *archive not readable*.
 *
 * Nothing failed, so there is no warning colour here and nothing near red. **One heading, one
 * clause**, and no error code: the panel can say *that* the host could not answer and never why,
 * so a code would be dressing a refusal up as a diagnosis. No retry control either — both users of
 * this block describe host state the panel is not the fixer of.
 *
 * Extracted from `routes/devices.tsx` in #132, with the outer `<section>`'s class list preserved
 * exactly: `devices.test.tsx` reads `section` and asserts `bg-surface-variant`. Only the icon is a
 * prop, because the two states point at different things — a view that is not current, and a
 * directory that cannot be seen into.
 */
export function QuietBanner({
	Icon,
	heading,
	children,
}: {
	readonly Icon: LucideIcon;
	readonly heading: string;
	readonly children: ReactNode;
}) {
	return (
		<section className="mt-8 flex items-start gap-4 border-2 border-outline-variant bg-surface-variant p-4">
			<Icon aria-hidden="true" className="shrink-0 text-outline" size={24} strokeWidth={2} />
			<div>
				<h2 className="font-headline-sm text-headline-sm text-on-surface">{heading}</h2>
				<p className="mt-2 max-w-3xl font-body-md text-body-md text-on-surface-variant">
					{children}
				</p>
			</div>
		</section>
	);
}
