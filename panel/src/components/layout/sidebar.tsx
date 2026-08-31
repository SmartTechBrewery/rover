import { Link, useRouterState } from '@tanstack/react-router';
import { Archive, CircleUser, CircuitBoard, Terminal } from 'lucide-react';

/**
 * The three destinations, in the order `docs/DESIGN.md` §3 settles them. `Archive`, not
 * `History` — it is a browsable tree rather than a chronological log — and `System` stands in
 * for settings. There is no `Analytics` item and there will not be one: Rover aggregates
 * nothing and scores nothing.
 */
const NAV_ITEMS = [
	{ label: 'Devices', to: '/devices', Icon: CircuitBoard },
	{ label: 'Archive', to: '/archive', Icon: Archive },
	{ label: 'System', to: '/system', Icon: Terminal },
] as const;

const ITEM_BASE = 'flex items-center gap-3 rounded-sm px-4 py-3 border-2 font-code-md text-code-md';
const ITEM_ACTIVE =
	'bg-tertiary-container text-on-tertiary-container border-tertiary nav-item-active-tactile';
const ITEM_INACTIVE =
	'text-on-surface-variant border-transparent hover:bg-surface-container-highest transition-colors';

/**
 * The panel's navigation chrome, and nothing else.
 *
 * It carries **no action** (`docs/DESIGN.md` §7). Operator actions belong to the thing they
 * act on — a device card — never here; the emitted design markup put a global `FORCE RELEASE`
 * button in a mobile top bar, and that bar is gone rather than reproduced.
 *
 * There is deliberately no host/daemon status block either: when the panel cannot reach Rover
 * there is nothing to show anywhere, so reachability is a state of the whole page rather than
 * a widget beside the navigation.
 */
export function Sidebar() {
	const pathname = useRouterState({ select: (state) => state.location.pathname });

	return (
		<nav
			aria-label="Main"
			className="relative flex w-full shrink-0 flex-col overflow-hidden border-outline-variant border-b-2 bg-surface-container md:w-64 md:border-r-2 md:border-b-0"
		>
			<div aria-hidden="true" className="scanline absolute inset-0" />
			<div className="relative flex flex-1 flex-col">
				<div className="border-outline-variant border-b-2 px-4 py-6">
					<span className="wordmark-chroma block font-display-lg text-display-lg text-secondary">
						ROVER_OS
					</span>
				</div>

				<ul className="flex-1 space-y-2 px-2 py-4">
					{NAV_ITEMS.map(({ label, to, Icon }) => {
						const isActive = pathname === to || pathname.startsWith(`${to}/`);
						return (
							<li key={to}>
								<Link
									to={to}
									aria-current={isActive ? 'page' : undefined}
									className={`${ITEM_BASE} ${isActive ? ITEM_ACTIVE : ITEM_INACTIVE}`}
								>
									<Icon aria-hidden="true" size={20} strokeWidth={2} />
									<span>{label}</span>
								</Link>
							</li>
						);
					})}
				</ul>

				{/*
				 * `Profile` is pinned at the foot below its own divider, separated from the main
				 * nav. `mt-auto` is what pins it, and it holds for both halves of §3's one-height
				 * rule without a second positioning model.
				 */}
				<div className="mt-auto border-outline-variant border-t-2 px-4 py-4">
					<Link
						to="/profile"
						aria-current={pathname === '/profile' ? 'page' : undefined}
						className="flex items-center gap-3 rounded-sm px-2 py-2 font-code-md text-on-surface-variant text-xs transition-colors hover:text-tertiary-fixed-dim"
					>
						<CircleUser aria-hidden="true" size={18} strokeWidth={2} />
						<span>Profile</span>
					</Link>
				</div>
			</div>
		</nav>
	);
}
