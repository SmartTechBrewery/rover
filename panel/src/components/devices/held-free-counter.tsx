import { StatusLed } from './status-led.js';

/**
 * `● 2 held  ● 1 free` above the grid, in the page header's right-hand slot.
 *
 * It uses the very LEDs the cards use (`docs/DESIGN.md` §6) — the held one before the held count,
 * the free one in place of a separator. No `·`, and no glow.
 *
 * **It agrees with the cards structurally, not by discipline.** The screen derives both numbers
 * from the one array it renders, so there is no second source that could disagree; this component
 * is handed the counts and never counts anything itself.
 *
 * The design's markup puts a scanline inside this badge, blended. It is dropped: the texture is
 * confined to the navigation chrome, and `app-shell.test.tsx` asserts that nothing inside `<main>`
 * carries it (§5).
 */
export function HeldFreeCounter({ held, free }: { readonly held: number; readonly free: number }) {
	return (
		<div className="flex items-center gap-4 rounded-sm border-2 border-outline-variant bg-surface-container px-3 py-1.5">
			<span className="flex items-center gap-2 font-code-md text-code-md text-on-surface">
				<StatusLed held={true} size="counter" />
				{held} held
			</span>
			<span className="flex items-center gap-2 font-code-md text-code-md text-on-surface">
				<StatusLed held={false} size="counter" />
				{free} free
			</span>
		</div>
	);
}
