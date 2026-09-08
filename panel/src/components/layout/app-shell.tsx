import { Outlet } from '@tanstack/react-router';
import { Sidebar } from './sidebar.js';

/**
 * One positioning model, and one height.
 *
 * The sidebar carries no `fixed`, no `sticky` and no `absolute`, and `<main>` carries no
 * `ml-*` compensating for one. That pair was the single worst bug of the design's first four
 * iterations — a `<nav>` that was both `fixed` and `relative` while `<main>` still offset for
 * it left a 256px dead band and starved the content box until a three-column grid collapsed
 * to one (`docs/DESIGN.md` §4).
 *
 * A flex row stretches its children to the row's height, and the row is
 * `max(100vh, content)`. That is §3's one height exactly: with short content the page ends at
 * the foot of the viewport and `Profile` sits on that line; with long content the sidebar
 * stretches to the full page height; neither column ever paints below where the other ends.
 * The accepted cost is that the nav scrolls away on a long page — Swarm's dashboard pins its
 * sidebar with `md:sticky md:h-screen` instead, and Rover's own rule wins here.
 *
 * `min-w-0` on `<main>` is the other half of §4's bug: without it the content box cannot
 * shrink below its contents' intrinsic width, and a grid inside it loses tracks.
 * `p-(--margin-desktop)` gives §4's equal margins in one declaration.
 *
 * **`<main>` is what measures a screen** — the header inside it and the content row below it alike
 * — so the two share a right edge by construction (§4, #240). The padding here is the only measure
 * either of them gets; a maximum on one and not on the other is what #240 was, and
 * `tests/unit/panel/content-ends-where-the-header-does.test.ts` is the gate over the screens. The
 * Devices grid's three-column ceiling is the one deliberate exception, argued in §4.
 */
export function AppShell() {
	return (
		<div className="flex min-h-screen flex-col bg-surface text-on-surface md:flex-row">
			<Sidebar />
			<main className="min-w-0 flex-1 p-(--margin-mobile) md:p-(--margin-desktop)">
				<Outlet />
			</main>
		</div>
	);
}
